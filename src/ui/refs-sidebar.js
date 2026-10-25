// @ts-check
/**
 * References tab folder sidebar (desktop): folder tree, search, inline
 * folder editors, folder action menus (hygiene split 2026-10-25). The mobile
 * stack reuses openFolderMenu with mobile:true.
 */
import { escapeHtml, showConfirmModal, showInputModal } from '../core.js';
import {
    listRefs, createFolder, updateFolder, deleteFolder,
    getFolderPrefs, saveFolderPrefs, FOLDER_PREFS_MAX_PINNED, FOLDER_COLOR_PALETTE,
    filterRefsByFolder, folderChildrenMap, folderChildFolders, folderHasChildren, filterRefsByFolderTree,
} from '../refs-library.js';
import { openFolderSheet, orderSidebarFolders, filterFolders } from './folder-picker.js';
import { showFolderManager } from './folder-manager.js';
import { openCardActionMenu, bindCardContextMenu } from './card-action-menu.js';
import { refsView } from './refs-view-shared.js';
import { refreshActive } from './tabs.js';

// ── Sidebar ──
// Дерево папок (2 уровня) + поиск. Поиск уплощает дерево: совпадения плоским
// списком с подписью «в группе …». Инпут поиска живёт ВНЕ перерисовываемого
// списка: _renderFolderList обновляет только строки, иначе каретка прыгает
// (см. комментарий про caret в _renderMobileGrid).
// Строки без кнопок (v4.1): действия папки — ПКМ/долгий тап по строке или
// тулбарный «⋯» активной папки; закрепление — статус-звёздочка + «Избранное».
// Desktop-only re-render hook, captured from the last renderSidebar call:
// folder actions must refresh the whole tab (counts, grid, toolbar), which
// only main can do — importing main back would be a cycle.
let _rerenderAll = null;

export function renderSidebar(root, folders, refs, { rerender } = {}) {
    _rerenderAll = rerender ?? null;
    const host = root.querySelector('#urisRefsSidebar');
    if (!host) return;
    host.innerHTML = `
        <div class="uris-folder-search">
            <input type="text" class="uris-folder-search-input" placeholder="Поиск папок…"
                value="${escapeHtml(refsView.folderSearchQuery)}" aria-label="Поиск папок" autocomplete="off">
        </div>
        <div class="uris-folder-list" id="urisFolderList"></div>`;
    _renderFolderList(root, folders, refs);
    host.querySelector('.uris-folder-search-input')?.addEventListener('input', (e) => {
        refsView.folderSearchQuery = e.target.value || '';
        _renderFolderList(root, folders, refs);
    });
}

/** Референсы активного фильтра: группа отдаёт всё поддерево, подпапка — себя. */

function _renderFolderList(root, folders, refs) {
    const host = root.querySelector('#urisFolderList');
    if (!host) return;
    const prefs = getFolderPrefs();
    const query = refsView.folderSearchQuery.trim().toLowerCase();
    const inSearch = Boolean(query);
    const countAll = refs.length;
    const countNone = filterRefsByFolder(refs, 'none').length;
    const countById = new Map(folders.map(f => [f.id, filterRefsByFolder(refs, f.id).length]));
    const kidsMap = folderChildrenMap(folders);
    const collapsedSet = new Set(prefs.collapsed);
    const pinnedSet = new Set(prefs.pinned);
    const countAllRefs = (folder) => (folderHasChildren(folders, folder.id)
        ? filterRefsByFolderTree(refs, folders, folder.id).length
        : (countById.get(folder.id) || 0));
    const parentOf = (folder) => (folder.parentId ? folders.find(f => f.id === folder.parentId) : null);

    const pseudoItem = (folderId, label, count) => `
        <div class="uris-folder-row">
            <button type="button" class="uris-folder-item ${refsView.activeFolderFilter === folderId ? 'uris-folder-item-on' : ''}"
                    data-folder="${escapeHtml(folderId)}">
                <span class="uris-folder-dot uris-folder-dot-mute"></span>
                <span class="uris-folder-name">${escapeHtml(label)}</span>
                <span class="uris-folder-count">${count}</span>
            </button>
        </div>`;

    // Строка папки: маркер + имя (+ статус-★ + подпись группы в поиске) + счётчик.
    // Кнопок действий в строке нет — меню по ПКМ/долгому тапу и из тулбара.
    const rowHtml = (folder, { indent = false } = {}) => {
        const isGroup = folderHasChildren(folders, folder.id);
        const on = refsView.activeFolderFilter === folder.id;
        const collapsed = collapsedSet.has(folder.id);
        const parent = parentOf(folder);
        const sub = inSearch && parent ? `<span class="uris-folder-sub">в группе «${escapeHtml(parent.name)}»</span>` : '';
        return `
        <div class="uris-folder-row${indent ? ' uris-folder-row-child' : ''}">
            <button type="button" class="uris-folder-item ${on ? 'uris-folder-item-on' : ''}"
                    data-folder="${escapeHtml(folder.id)}">
                <span class="uris-folder-dot" style="background:${escapeHtml(folder.color)}"></span>
                <span class="uris-folder-name${isGroup ? ' uris-folder-name-group' : ''}">${escapeHtml(folder.name)}${sub}</span>
                ${pinnedSet.has(folder.id) ? '<span class="uris-folder-star" title="В избранном"><i class="fa-solid fa-star"></i></span>' : ''}
                <span class="uris-folder-count${isGroup ? ' uris-folder-count-total' : ''}">${inSearch ? (countById.get(folder.id) || 0) : countAllRefs(folder)}</span>
            </button>
            ${isGroup && !inSearch ? `
            <button type="button" class="uris-folder-chev${collapsed ? ' uris-folder-chev-closed' : ''}"
                    data-folder-id="${escapeHtml(folder.id)}"
                    title="${collapsed ? 'Развернуть' : 'Свернуть'}" aria-label="${collapsed ? 'Развернуть' : 'Свернуть'} папку ${escapeHtml(folder.name)}">
                <i class="fa-solid fa-chevron-down"></i>
            </button>` : ''}
        </div>`;
    };

    const editorHtml = (folder) => {
        if (refsView.editingFolderId !== folder.id) return '';
        const swatches = FOLDER_COLOR_PALETTE.map(color => `
            <button class="uris-folder-editor-swatch ${folder.color === color ? 'uris-folder-editor-swatch-on' : ''}"
                    type="button" data-color="${escapeHtml(color)}" title="Цвет папки" aria-label="Цвет папки"
                    style="background:${escapeHtml(color)}"></button>`).join('');
        return `
            <div class="uris-folder-editor" data-folder-id="${escapeHtml(folder.id)}">
                <input class="text_pole uris-folder-editor-name" value="${escapeHtml(folder.name)}" aria-label="Имя папки">
                <div class="uris-folder-editor-palette">${swatches}</div>
                <div class="uris-folder-editor-actions">
                    <button class="uris-folder-editor-apply" type="button" title="Сохранить" aria-label="Сохранить"><i class="fa-solid fa-check"></i></button>
                    <button class="uris-folder-editor-cancel" type="button" title="Отменить" aria-label="Отменить"><i class="fa-solid fa-xmark"></i></button>
                    <button class="uris-folder-editor-delete" type="button" title="Удалить папку" aria-label="Удалить папку"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>`;
    };

    const SORT_UI = [
        { sort: 'manual', label: 'Своя' },
        { sort: 'name', label: 'По имени' },
        { sort: 'count', label: 'По количеству' },
    ];
    const headerHtml = `
        <div class="uris-folder-header">
            <span class="uris-folder-header-label">Папки</span>
            <span class="uris-folder-tools">
                <button class="uris-folder-tool" id="urisFolderViewBtn" type="button" title="Вид списка" aria-label="Вид списка"><i class="fa-solid fa-ellipsis"></i></button>
                <button class="uris-folder-header-add" id="urisRefsAddFolderBtn" type="button" title="${escapeHtml(_folderCreateTitle(folders))}" aria-label="Создать папку"><i class="fa-solid fa-plus"></i></button>
            </span>
        </div>`;

    // Верхний уровень в порядке сайдбара; дети — в том же режиме сортировки.
    const topLevel = orderSidebarFolders(
        folders.filter(f => !f.parentId),
        { pinnedIds: prefs.pinned, sort: prefs.sort, countById },
    );
    const orderKids = (parentFolder) => orderSidebarFolders(
        kidsMap.get(parentFolder.id) || [],
        { pinnedIds: prefs.pinned, sort: prefs.sort, countById },
    );

    let bodyRows = '';
    const pseudoHtml = `${pseudoItem('all', 'Все карточки', countAll)}${pseudoItem('none', 'Без папки', countNone)}`;
    if (inSearch) {
        // Поиск уплощает дерево: любые совпадения плоским списком, у детей —
        // подпись «в группе …». «Скрывать пустые» в поиске не действует.
        // «Все карточки»/«Без папки» остаются — быстрый выход из поиска.
        const matches = filterFolders(folders, query);
        bodyRows = `${pseudoHtml}
            ${matches.length ? matches.map(f => rowHtml(f)).join('') : '<div class="uris-folder-empty">Папки не найдены</div>'}`;
    } else {
        // Закреплённые листья показываются только в «Избранном» (дедупликация,
        // как и раньше); закреплённые ГРУППЫ остаются в дереве — иначе их дети
        // становятся недостижимы кроме как через рекурсивный фильтр.
        const isPinnedLeaf = (f) => pinnedSet.has(f.id) && !folderHasChildren(folders, f.id);
        const visibleTop = topLevel
            .filter(f => !isPinnedLeaf(f))
            .filter(f => !prefs.hideEmpty || countAllRefs(f) > 0);
        const groupHtml = (folder) => {
            const kids = orderKids(folder)
                .filter(kid => !prefs.hideEmpty || (countById.get(kid.id) || 0) > 0);
            const collapsed = collapsedSet.has(folder.id);
            return rowHtml(folder)
                + editorHtml(folder)
                + (kids.length && !collapsed
                    ? `<div class="uris-folder-kids">${kids.map(kid => rowHtml(kid, { indent: true }) + editorHtml(kid)).join('')}</div>`
                    : '');
        };
        const pinnedVisible = prefs.pinned
            .map(id => folders.find(f => f.id === id))
            .filter(f => f && (!prefs.hideEmpty || (countById.get(f.id) || 0) > 0));
        bodyRows = `${pseudoHtml}
            ${pinnedVisible.length ? `<div class="uris-folder-section-label">Избранное</div>${pinnedVisible.map(f => rowHtml(f)).join('')}` : ''}
            ${headerHtml}
            ${visibleTop.map(groupHtml).join('')}`;
    }
    host.innerHTML = bodyRows;

    host.querySelectorAll('.uris-folder-item').forEach(btn => {
        btn.addEventListener('click', async () => {
            refsView.activeFolderFilter = btn.dataset.folder;
            await _rerenderAll?.(root);
        });
        bindCardContextMenu(btn, ({ x, y }) => {
            const folder = folders.find(f => f.id === btn.dataset.folder);
            if (folder) openFolderMenu({ root, folder, folders, refs, x, y });
        });
    });
    host.querySelectorAll('.uris-folder-chev').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.folderId;
            const current = getFolderPrefs();
            const collapsed = current.collapsed.includes(id)
                ? current.collapsed.filter(collapsedId => collapsedId !== id)
                : [...current.collapsed, id];
            saveFolderPrefs({ collapsed });
            _renderFolderList(root, folders, refs);
        });
    });
    // ── Шапка: ⋯ (вид списка) + ＋ (контекстно-умное создание) ──
    host.querySelector('#urisFolderViewBtn')?.addEventListener('click', (e) => {
        const rect = typeof e.currentTarget?.getBoundingClientRect === 'function'
            ? e.currentTarget.getBoundingClientRect() : null;
        const current = getFolderPrefs();
        const check = (mode) => (current.sort === mode ? '✓ ' : '') + SORT_UI.find(item => item.sort === mode).label;
        openCardActionMenu({
            title: 'Вид списка',
            x: rect ? Math.round(rect.left) : null,
            y: rect ? Math.round(rect.bottom + 4) : null,
            items: [
                ...SORT_UI.map(item => ({
                    id: `sort-${item.sort}`,
                    icon: 'fa-solid fa-bars',
                    label: check(item.sort),
                    onSelect: async () => { saveFolderPrefs({ sort: item.sort }); _renderFolderList(root, folders, refs); },
                })),
                {
                    id: 'hide-empty',
                    icon: current.hideEmpty ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye',
                    label: (current.hideEmpty ? '✓ ' : '') + 'Скрывать пустые',
                    onSelect: async () => { saveFolderPrefs({ hideEmpty: !current.hideEmpty }); _renderFolderList(root, folders, refs); },
                },
                {
                    id: 'manage',
                    icon: 'fa-solid fa-folder-tree',
                    label: 'Управление папками…',
                    onSelect: () => showFolderManager({ onChanged: () => { void _rerenderAll?.(root); } }),
                },
            ],
        });
    });
    host.querySelector('#urisRefsAddFolderBtn')?.addEventListener('click', async () => {
        const dest = _folderCreateDestination(folders);
        const name = await showInputModal(
            dest.label ? `Имя папки (в «${dest.label}»):` : 'Имя папки:', 'Новая папка');
        if (!name) return;
        await createFolder(name, { parentId: dest.parentId });
        refreshActive();
    });
    // Инлайн-редактор папки (имя + палитра) — открывается из меню «Правка…».
    const editor = host.querySelector('.uris-folder-editor');
    if (editor) {
        const folder = folders.find(f => f.id === refsView.editingFolderId);
        let selectedColor = folder?.color;
        editor.querySelectorAll('.uris-folder-editor-swatch').forEach(btn => {
            btn.addEventListener('click', () => {
                selectedColor = btn.dataset.color;
                editor.querySelectorAll('.uris-folder-editor-swatch').forEach(swatch =>
                    swatch.classList.toggle('uris-folder-editor-swatch-on', swatch.dataset.color === selectedColor));
            });
        });
        editor.querySelector('.uris-folder-editor-apply')?.addEventListener('click', async () => {
            await updateFolder(folder.id, {
                name: editor.querySelector('.uris-folder-editor-name').value,
                color: selectedColor,
            });
            refsView.editingFolderId = null;
            await _rerenderAll?.(root);
        });
        editor.querySelector('.uris-folder-editor-cancel')?.addEventListener('click', async () => {
            refsView.editingFolderId = null;
            await _rerenderAll?.(root);
        });
        editor.querySelector('.uris-folder-editor-delete')?.addEventListener('click', async () => {
            if (!await showConfirmModal('Удалить папку?')) return;
            await _deleteFolderAndRerender(root, folder, folders);
        });
    }
}

/** Куда попадёт новая папка по «＋» шапки: активная группа → внутрь, активная
 *  подпапка → соседняя в её группе, иначе верхний уровень. */
function _folderCreateDestination(folders) {
    const active = folders.find(f => f.id === refsView.activeFolderFilter);
    if (!active) return { parentId: null, label: '' };
    if (active.parentId) {
        const parent = folders.find(f => f.id === active.parentId);
        return { parentId: active.parentId, label: parent?.name || '' };
    }
    if (folderHasChildren(folders, active.id)) return { parentId: active.id, label: active.name };
    return { parentId: null, label: '' };
}

function _folderCreateTitle(folders) {
    const dest = _folderCreateDestination(folders);
    return dest.label ? `Создать папку в «${dest.label}»` : 'Создать папку (верхний уровень)';
}

/** Удаление с обновлением активного фильтра и полным ре-рендером. */
async function _deleteFolderAndRerender(root, folder) {
    await deleteFolder(folder.id);
    refsView.editingFolderId = null;
    if (refsView.activeFolderFilter === folder.id) refsView.activeFolderFilter = 'none';
    await _rerenderAll?.(root);
}

/**
 * Меню действий папки. Один и тот же набор открывается ПКМ по строке,
 * долгим тапом (мобила) и кнопкой «⋯» в тулбаре активной папки.
 */
export async function openFolderMenu({ root, folder, folders, x = null, y = null, mobile = false }) {
    const prefs = getFolderPrefs();
    const pinned = prefs.pinned.includes(folder.id);
    const hasKids = folderHasChildren(folders, folder.id);
    const parent = folder.parentId ? folders.find(f => f.id === folder.parentId) : null;
    const items = [
        pinned
            ? { id: 'unpin', icon: 'fa-solid fa-star', label: 'Убрать из избранного', onSelect: async () => {
                saveFolderPrefs({ pinned: prefs.pinned.filter(id => id !== folder.id) });
                await _rerenderAll?.(root);
            } }
            : { id: 'pin', icon: 'fa-solid fa-star', label: 'В избранное', onSelect: async () => {
                saveFolderPrefs({ pinned: [...prefs.pinned, folder.id].slice(0, FOLDER_PREFS_MAX_PINNED) });
                await _rerenderAll?.(root);
            } },
        { id: 'edit', icon: 'fa-solid fa-pencil', label: 'Правка…',
          // На мобиле инлайн-редактора папок нет (правка — через «Управление папками»),
          // мёртвый пункт меню не показываем.
          hidden: mobile,
          onSelect: async () => {
            refsView.editingFolderId = folder.id;
            await _rerenderAll?.(root);
        } },
    ];
    if (!folder.parentId) {
        items.push({ id: 'subfolder', icon: 'fa-solid fa-folder-plus', label: 'Новая подпапка', onSelect: async () => {
            const name = await showInputModal(`Имя подпапки (в «${folder.name}»):`, 'Новая папка');
            if (!name) return;
            await createFolder(name, { parentId: folder.id });
            refreshActive();
        } });
    }
    items.push(
        { id: 'move', icon: 'fa-solid fa-right-left', label: 'Переместить в…', onSelect: () => _openMoveSheet(root, folder, folders) },
        { id: 'delete', icon: 'fa-solid fa-trash', danger: true, label: hasKids ? 'Удалить группу…' : 'Удалить…', onSelect: async () => {
            const msg = hasKids
                ? `Удалить группу «${folder.name}»? Подпапки поднимутся на верхний уровень, референсы не изменятся.`
                : 'Удалить папку?';
            if (!await showConfirmModal(msg)) return;
            await _deleteFolderAndRerender(root, folder);
        } },
    );
    openCardActionMenu({
        title: folder.name + (hasKids ? ` · ${filterRefsByFolderTree(await listRefs(), folders, folder.id).length}` : '')
            + (parent ? ` · в «${parent.name}»` : ''),
        x, y,
        items: items.filter(item => !item.hidden),
    });
}

/**
 * «Переместить в…»: цели — группы верхнего уровня и «верхний уровень».
 * Недопустимые цели (группа с подпапками не может вложиться; папка уже на
 * верхнем уровне) видны приглушённо-disabled, чтобы структура читалась.
 */
function _openMoveSheet(root, folder, folders) {
    const hasKids = folderHasChildren(folders, folder.id);
    const entries = [
        { id: '__root__', name: 'Без группы (верхний уровень)', color: '', disabled: !folder.parentId },
        ...folders
            .filter(f => !f.parentId && f.id !== folder.id)
            .map(f => ({ ...f, disabled: hasKids })),
    ];
    openFolderSheet({
        title: `Переместить «${folder.name}»…`,
        mode: 'pick-one',
        folders: entries,
        onPick: async (target) => {
            try {
                await updateFolder(folder.id, { parentId: target.id === '__root__' ? null : target.id });
                refreshActive();
            } catch (err) {
                toastr?.error(err?.message || String(err));
            }
        },
    });
}
