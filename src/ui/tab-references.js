// @ts-check
/**
 * References tab: global pool of records with folders.
 * v4-redesign (Figma): folder sidebar left + 3:4 card grid +
 * overlay editor panel on the right. Multi-folder via folders[].
 */
import { state, getCtx, escapeHtml, showConfirmModal, showInputModal } from '../core.js';
import {
    listRefs, getRef, updateRef, deleteRef,
    listFolders, createFolder, updateFolder, deleteFolder, FOLDER_COLOR_PALETTE,
    filterRefsByFolder, refreshPoolCache, getRefSync,
    getFolderPrefs, saveFolderPrefs, persistPoolOrThrow, releaseRefImage, cloneRef,
    FOLDER_PREFS_MAX_PINNED,
    folderChildrenMap, folderChildFolders, folderHasChildren, filterRefsByFolderTree,
} from '../refs-library.js';

import { ingestReferenceImage } from '../references.js';
import { openBatchUploadDialog } from './ref-batch-upload.js';
import { openCropDialog } from './crop-dialog.js';
import { showSingleImage } from './lightbox.js';
import { refreshActive, getActiveTab } from './tabs.js';
import { lockBodyScroll, unlockBodyScroll } from './window.js';
import { reportFailure, URIS_SCOPES } from '../error-pool.js';
import {
    createFolderField, openFolderSheet, orderSidebarFolders, filterFolders,
} from './folder-picker.js';
import { showFolderManager } from './folder-manager.js';
import { openCardActionMenu, bindCardContextMenu } from './card-action-menu.js';
import { editTextModal } from './text-editor.js';

// Layout state
let _activeFolderFilter = 'all';
let _editingFolderId = null;
let _editingRefId = null;
let _cw = 600;
let _ro = null;
let _mobileSearchQuery = '';
let _folderSearchQuery = '';

// Mobile stack breakpoint — measured against the TAB CONTAINER (root.clientWidth),
// not window.innerWidth (unlike CSS media @media (max-width: 768px)). The axes are
// intentionally different: SillyTavern has side panels, so clientWidth < innerWidth,
// therefore a 480px container threshold roughly corresponds to 768px media query
// in the typical case. This is a deliberate trade-off, not a bug: testing showed
// that simply aligning to 768 breaks valid 600px desktop tests (project contract).
//
// Interaction with the UI-scale zoom (--uris-scale, style.css): zoom shrinks the
// container's LAYOUT px (clientWidth reads visual/zoom), so scale >100% reaches
// this breakpoint earlier and <100% later — identically on desktop and in the
// mobile fullscreen mode. Deliberate single semantics: dense scale → compact
// layout.
const REFS_MOBILE_BREAK = 480;

export function render(root) {
    root.classList.add('uris-body-flush');
    // _mobileScreen is NOT reset here: render() doubles as refreshActive(), and
    // an unconditional reset kicked mobile users from card/grid back to the
    // folder list on every background refresh (image replace, autosave). The
    // screen survives refreshes; the folder list is one tap away. Search
    // queries are still cleared — a stale filter after data reload misleads.
    _mobileSearchQuery = '';
    _folderSearchQuery = '';
    // A full tab re-entry must not inherit a stale editor session: close any
    // open reference/folder editor overlay so the grid renders clean.
    _editingRefId = null;
    _editingFolderId = null;
    root.innerHTML = `
        <div class="uris-references">
            <div class="uris-refs-sidebar" id="urisRefsSidebar"></div>
            <div class="uris-refs-main">
                <div class="uris-refs-toolbar" id="urisRefsToolbar"></div>
                <div class="uris-refs-grid-wrap">
                    <div class="uris-pool-grid" id="urisRefsGrid"></div>
                </div>
            </div>
            <div class="uris-refs-overlay-host" id="urisRefsOverlay"></div>
        </div>`;
    _cw = root.clientWidth;
    root.classList.toggle('uris-refs-mobile', _cw > 0 && _cw < REFS_MOBILE_BREAK);
    _setupResize(root);
    if (_cw <= 0) return;
    if (_cw < REFS_MOBILE_BREAK) return _renderMobileAll(root);
    return _renderAll(root);
}

function _setupResize(root) {
    if (_ro) _ro.disconnect();
    if (typeof ResizeObserver === 'undefined') return;
    _ro = new ResizeObserver(entries => {
        // Ignore resize if the References tab is not active:
        // the observer survives tab switching (it watches #urisBody),
        // and without this check it would overwrite the other tab's content.
        if (getActiveTab() !== 'references') return;
        const w = entries[0]?.contentRect.width ?? root.clientWidth;
        if (w <= 0) return;
        if (Math.abs(w - _cw) < 8) return;
        const wasMobile = _cw < REFS_MOBILE_BREAK;
        _cw = w;
        const isMobile = _cw < REFS_MOBILE_BREAK;
        root.classList.toggle('uris-refs-mobile', isMobile);
        if (wasMobile !== isMobile) {
            _mobileScreen = isMobile ? 'folders' : null;
            _mobileGroupId = null;
            render(root);
        } else if (isMobile) {
            _renderMobileAll(root);
        } else {
            _renderAll(root);
        }
    });
    _ro.observe(root);
}

let _renderEpoch = 0;

async function _renderAll(root) {
    const epoch = ++_renderEpoch;
    const isCurrent = () => _renderEpoch === epoch && root.__urisTabId === 'references';
    const [folders, refs] = await Promise.all([listFolders(), listRefs()]);
    if (!isCurrent()) return;
    _renderSidebar(root, folders, refs);
    _renderToolbar(root, folders);
    _renderGrid(root, folders, refs);
    _renderOverlay(root, folders);
}

// ── Sidebar ──
// Дерево папок (2 уровня) + поиск. Поиск уплощает дерево: совпадения плоским
// списком с подписью «в группе …». Инпут поиска живёт ВНЕ перерисовываемого
// списка: _renderFolderList обновляет только строки, иначе каретка прыгает
// (см. комментарий про caret в _renderMobileGrid).
// Строки без кнопок (v4.1): действия папки — ПКМ/долгий тап по строке или
// тулбарный «⋯» активной папки; закрепление — статус-звёздочка + «Избранное».
function _renderSidebar(root, folders, refs) {
    const host = root.querySelector('#urisRefsSidebar');
    if (!host) return;
    host.innerHTML = `
        <div class="uris-folder-search">
            <input type="text" class="uris-folder-search-input" placeholder="Поиск папок…"
                value="${escapeHtml(_folderSearchQuery)}" aria-label="Поиск папок" autocomplete="off">
        </div>
        <div class="uris-folder-list" id="urisFolderList"></div>`;
    _renderFolderList(root, folders, refs);
    host.querySelector('.uris-folder-search-input')?.addEventListener('input', (e) => {
        _folderSearchQuery = e.target.value || '';
        _renderFolderList(root, folders, refs);
    });
}

/** Референсы активного фильтра: группа отдаёт всё поддерево, подпапка — себя. */
function refsForActiveFilter(refs, folders) {
    if (_activeFolderFilter === 'all' || _activeFolderFilter === 'none') {
        return filterRefsByFolder(refs, _activeFolderFilter);
    }
    return filterRefsByFolderTree(refs, folders, _activeFolderFilter);
}

function _renderFolderList(root, folders, refs) {
    const host = root.querySelector('#urisFolderList');
    if (!host) return;
    const prefs = getFolderPrefs();
    const query = _folderSearchQuery.trim().toLowerCase();
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
            <button type="button" class="uris-folder-item ${_activeFolderFilter === folderId ? 'uris-folder-item-on' : ''}"
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
        const on = _activeFolderFilter === folder.id;
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
        if (_editingFolderId !== folder.id) return '';
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
            _activeFolderFilter = btn.dataset.folder;
            await _renderAll(root);
        });
        bindCardContextMenu(btn, ({ x, y }) => {
            const folder = folders.find(f => f.id === btn.dataset.folder);
            if (folder) _openFolderMenu({ root, folder, folders, refs, x, y });
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
                    onSelect: () => showFolderManager({ onChanged: () => { void _renderAll(root); } }),
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
        const folder = folders.find(f => f.id === _editingFolderId);
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
            _editingFolderId = null;
            await _renderAll(root);
        });
        editor.querySelector('.uris-folder-editor-cancel')?.addEventListener('click', async () => {
            _editingFolderId = null;
            await _renderAll(root);
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
    const active = folders.find(f => f.id === _activeFolderFilter);
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
    _editingFolderId = null;
    if (_activeFolderFilter === folder.id) _activeFolderFilter = 'none';
    await _renderAll(root);
}

/**
 * Меню действий папки. Один и тот же набор открывается ПКМ по строке,
 * долгим тапом (мобила) и кнопкой «⋯» в тулбаре активной папки.
 */
async function _openFolderMenu({ root, folder, folders, x = null, y = null, mobile = false }) {
    const prefs = getFolderPrefs();
    const pinned = prefs.pinned.includes(folder.id);
    const hasKids = folderHasChildren(folders, folder.id);
    const parent = folder.parentId ? folders.find(f => f.id === folder.parentId) : null;
    const items = [
        pinned
            ? { id: 'unpin', icon: 'fa-solid fa-star', label: 'Убрать из избранного', onSelect: async () => {
                saveFolderPrefs({ pinned: prefs.pinned.filter(id => id !== folder.id) });
                await _renderAll(root);
            } }
            : { id: 'pin', icon: 'fa-solid fa-star', label: 'В избранное', onSelect: async () => {
                saveFolderPrefs({ pinned: [...prefs.pinned, folder.id].slice(0, FOLDER_PREFS_MAX_PINNED) });
                await _renderAll(root);
            } },
        { id: 'edit', icon: 'fa-solid fa-pencil', label: 'Правка…',
          // На мобиле инлайн-редактора папок нет (правка — через «Управление папками»),
          // мёртвый пункт меню не показываем.
          hidden: mobile,
          onSelect: async () => {
            _editingFolderId = folder.id;
            await _renderAll(root);
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

// ── Toolbar ──
// Крошки пути + «⋯» действий активной папки + поиск + «＋ Референс».
// «⋯» — тот же набор, что в меню строки (ПКМ/долгий тап); на виртуальных
// фильтрах (Все/Без папки) гаснет, но не прячется — место стабильно.
function _activeFolderChain(folders) {
    const chain = [{ id: 'all', label: 'Все карточки' }];
    if (_activeFolderFilter === 'none') {
        chain.push({ id: 'none', label: 'Без папки' });
        return chain;
    }
    const active = folders.find(f => f.id === _activeFolderFilter);
    if (!active) return chain;
    if (active.parentId) {
        const parent = folders.find(f => f.id === active.parentId);
        if (parent) chain.push({ id: parent.id, label: parent.name });
    }
    chain.push({ id: active.id, label: active.name });
    return chain;
}

function _renderToolbar(root, folders) {
    const host = root.querySelector('#urisRefsToolbar');
    if (!host) return;
    // Show where the new reference will land: a real folder name when one is
    // active, otherwise it is created without a folder.
    const activeFolder = folders.find(f => f.id === _activeFolderFilter);
    const addBtnInner = activeFolder
        ? `<i class="fa-solid fa-plus"></i> В <span class="uris-refs-add-dest" title="${escapeHtml(activeFolder.name)}">«${escapeHtml(activeFolder.name)}»</span>`
        : `<i class="fa-solid fa-plus"></i> Референс`;
    const addBtnTitle = activeFolder
        ? `Добавить референс в «${activeFolder.name}»`
        : 'Добавить референс (без папки)';
    const hasCtx = Boolean(activeFolder);
    const crumbs = _activeFolderChain(folders);
    host.innerHTML = `
        <nav class="uris-refs-crumbs" aria-label="Папка">
            ${crumbs.map((crumb, index) => `${index ? '<span class="uris-crumb-sep">›</span>' : ''}
                <button type="button" class="uris-crumb${index === crumbs.length - 1 ? ' uris-crumb-cur' : ''}" data-folder="${escapeHtml(crumb.id)}">${escapeHtml(crumb.label)}</button>`).join('')}
        </nav>
        <button type="button" class="uris-refs-folder-menu${hasCtx ? '' : ' uris-refs-folder-menu-off'}" id="urisRefsFolderMenu"
            title="${hasCtx ? `Действия с «${escapeHtml(activeFolder.name)}»` : 'Действия с папкой'}" aria-label="Действия с папкой" ${hasCtx ? '' : 'disabled'}>
            <i class="fa-solid fa-ellipsis"></i>
        </button>
        <div class="uris-refs-search">
            <input type="text" id="urisRefsSearch" placeholder="Поиск..." autocomplete="off">
        </div>
        <button class="uris-refs-add" id="urisRefsAddBtn" title="${escapeHtml(addBtnTitle)}">
            ${addBtnInner}
        </button>
        <input type="file" class="uris-ref-file" accept="image/*" multiple hidden>`;
    const fileInput = host.querySelector('.uris-ref-file');
    host.querySelector('#urisRefsAddBtn')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', e => {
        const files = [...(e.target.files || [])];
        e.target.value = '';
        if (!files.length) return;
        const folderIds = _activeFolderFilter !== 'all' && _activeFolderFilter !== 'none'
            ? [_activeFolderFilter] : [];
        openBatchUploadDialog({ files, folderIds, onFinish: () => refreshActive() });
    });
    host.querySelector('#urisRefsSearch')?.addEventListener('input', (e) => {
        _renderGrid(root, folders, null, e.target.value);
    });
    host.querySelectorAll('.uris-crumb').forEach(btn => {
        btn.addEventListener('click', async () => {
            _activeFolderFilter = btn.dataset.folder;
            await _renderAll(root);
        });
    });
    host.querySelector('#urisRefsFolderMenu')?.addEventListener('click', (e) => {
        if (!activeFolder) return;
        const rect = typeof e.currentTarget?.getBoundingClientRect === 'function'
            ? e.currentTarget.getBoundingClientRect() : null;
        void _openFolderMenu({
            root,
            folder: activeFolder,
            folders,
            x: rect ? Math.round(rect.left) : null,
            y: rect ? Math.round(rect.bottom + 4) : null,
        });
    });
}

// ── Grid ──
/**
 * Filter refs by search substring over name and aliases. Shared by the desktop
 * grid and both mobile tile renderers (three former inline copies).
 */
function filterRefsBySearch(refs, query) {
    const q = (query || '').toLowerCase().trim();
    if (!q) return refs;
    return refs.filter(r => (r.name || '').toLowerCase().includes(q)
        || (r.aliases || []).some(a => a.toLowerCase().includes(q)));
}

/**
 * Pool tile markup shared by the desktop grid and the mobile grid. The mobile
 * variant caps folder dots at 3 (narrower tiles).
 */
function poolTileHtml(ref, foldersById, { maxDots = 4, selected = false } = {}) {
    const dots = (ref.folders || []).map(fid => foldersById.get(fid)).filter(Boolean)
        .slice(0, maxDots).map(f => `<span class="uris-pool-tile-dot" style="background:${escapeHtml(f.color)}"></span>`).join('');
    const selectedClass = selected ? ' uris-pool-tile-selected' : '';
    return `<button type="button" class="uris-pool-tile${selectedClass}" data-ref-id="${escapeHtml(ref.id)}" aria-label="${escapeHtml(ref.name)}" title="${escapeHtml(ref.name)}">
        <img src="${escapeHtml(ref.imagePath)}" alt="${escapeHtml(ref.name)}" loading="lazy">
        ${dots ? `<div class="uris-pool-tile-dots">${dots}</div>` : ''}
        <div class="uris-pool-tile-name">${escapeHtml(ref.name)}</div>
    </button>`;
}

/**
 * Editor body markup shared by the desktop overlay and the mobile card screen.
 * Only the delete-button label differs between the two layouts.
 */
function refEditorBodyHtml(ref, { deleteLabel = 'Удалить карточку' } = {}) {
    const aliasesStr = (ref.aliases || []).join(', ');
    return `
        <div class="uris-editor-preview-wrap">
            <button type="button" class="uris-editor-preview-btn" title="Открыть на весь экран" aria-label="Открыть на весь экран">
                <img src="${escapeHtml(ref.imagePath)}" class="uris-editor-preview" alt="">
            </button>
            <div class="uris-editor-preview-actions">
                <button class="uris-btn uris-btn-subtle uris-ed-crop"><i class="fa-solid fa-crop-simple"></i> Обрезать</button>
                <button class="uris-btn uris-btn-subtle uris-ed-replace"><i class="fa-solid fa-image"></i> Заменить картинку</button>
            </div>
        </div>
        <input type="file" class="uris-ed-file" accept="image/*" hidden>

        <label class="uris-ed-label">Имя</label>
        <input class="text_pole uris-ed-name" value="${escapeHtml(ref.name || '')}">
        <label class="uris-ed-label">Aliases</label>
        <input class="text_pole uris-ed-aliases" value="${escapeHtml(aliasesStr)}" placeholder="через запятую">
        <div class="uris-field-head"><label class="uris-ed-label">Описание</label>
            <button class="uris-expand-btn" type="button" data-act="expand-desc" title="Развернуть редактор" aria-label="Развернуть редактор"><i class="fa-solid fa-maximize"></i></button></div>
        <textarea class="text_pole uris-ed-desc" rows="3" placeholder="Текст для Stage1">${escapeHtml(ref.description || '')}</textarea>
        <label class="uris-ed-check"><input type="checkbox" class="uris-ed-binding-mode" ${ref.bindingMode === 'description' ? 'checked' : ''}><span>Только описание</span></label>
        <small class="uris-hint">Без картинки в генерацию попадёт только это описание.</small>
        <label class="uris-ed-label">Папки</label>
        <div class="uris-fp-host"></div>
        <div class="uris-ed-footer">
            <button class="uris-btn uris-btn-ghost uris-ed-clone"><i class="fa-solid fa-clone"></i> Клонировать</button>
            <button class="uris-btn uris-btn-ghost uris-ed-del"><i class="fa-solid fa-trash"></i> ${escapeHtml(deleteLabel)}</button>
        </div>`;
}

async function _renderGrid(root, folders, refsOverride, searchQuery = '') {
    const host = root.querySelector('#urisRefsGrid');
    if (!host) return;
    const refs = refsOverride ?? await listRefs();
    const filtered = refsForActiveFilter(refs, folders);
    const searched = filterRefsBySearch(filtered, searchQuery);
    if (!searched.length) {
        host.innerHTML = `<div class="uris-refs-empty">${searchQuery ? 'Не найдено' : 'Пусто. Добавьте референс кнопкой «+».'}</div>`;
        return;
    }
    const foldersById = new Map(folders.map(f => [f.id, f]));
    host.innerHTML = searched.map(r =>
        poolTileHtml(r, foldersById, { selected: _editingRefId === r.id })
    ).join('');
    host.querySelectorAll('.uris-pool-tile').forEach(tile => {
        tile.addEventListener('click', () => {
            _editingRefId = tile.dataset.refId;
            _renderOverlay(root, folders);
            _renderGrid(root, folders);
        });
    });
}

// ── Overlay panel ──
// Epoch guard: tile clicks fire _renderOverlay unawaited; two rapid clicks race
// two getRef() calls and the slower one used to win, showing reference A while
// _editingRefId was already B (subsequent autosaves targeted the shown record).
let _overlayEpoch = 0;
async function _renderOverlay(root, folders) {
    const epoch = ++_overlayEpoch;
    const requestedId = _editingRefId;
    const host = root.querySelector('#urisRefsOverlay');
    if (!host) return;
    if (!_editingRefId) { host.innerHTML = ''; host.classList.remove('uris-refs-overlay-open'); host.removeAttribute('role'); host.removeAttribute('aria-modal'); host.removeAttribute('aria-label'); return; }
    const ref = await getRef(_editingRefId);
    if (epoch !== _overlayEpoch || _editingRefId !== requestedId) return;
    if (!ref) { _editingRefId = null; host.innerHTML = ''; host.removeAttribute('role'); host.removeAttribute('aria-modal'); host.removeAttribute('aria-label'); return; }
    host.classList.add('uris-refs-overlay-open');
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', `Редактор референса: ${ref.name || 'Без названия'}`);
    const aliasesStr = (ref.aliases || []).join(', ');
    host.innerHTML = `
        <div class="uris-refs-overlay-panel">
            <div class="uris-refs-overlay-head">
                <span class="uris-refs-overlay-title">${escapeHtml(ref.name || 'Без названия')}</span>
                <button class="uris-refs-overlay-close" title="Закрыть" aria-label="Закрыть">✕</button>
            </div>
                <div class="uris-refs-overlay-body">${refEditorBodyHtml(ref)}</div>
        </div>`;
    _bindOverlay(root, host, ref, folders);
}

function _bindOverlay(root, host, ref, folders) {
    // Одна перерисовка окружения для смены папок и клона: свежий список папок
    // (шит поля мог создать новую), оверлей под новым _editingRefId, сайдбар с
    // свежими счётчиками и сетка с новой карточкой.
    const refreshAround = async () => {
        const freshFolders = await listFolders();
        await _renderOverlay(root, freshFolders);
        _renderSidebar(root, freshFolders, await listRefs());
        _renderGrid(root, freshFolders);
    };
    _bindEditorBody(root, host.querySelector('.uris-refs-overlay-body'), ref, folders, {
        onFolderChange: refreshAround,
        onCloned: refreshAround,
    });
    host.querySelector('.uris-refs-overlay-close')?.addEventListener('click', async () => {
        _editingRefId = null;
        await _renderAll(root);
    });
}

// ── Mobile stack ──
let _mobileScreen = 'folders';  // 'folders' | 'group' | 'grid' | 'card'
let _mobileGroupId = null;      // открытая группа на экране 'group'

/** Test-only: reset mobile navigation state. It is module-level and, by design
 * (refresh must not kick the user back to folders), survives render(). */
export function __resetMobileNavForTests() {
    _mobileScreen = 'folders';
    _mobileGroupId = null;
    _mobileSearchQuery = '';
    _folderSearchQuery = '';
}

async function _renderMobileAll(root) {
    root.innerHTML = `
        <div class="uris-references uris-refs-mobile-stack">
            <div class="uris-mobile-screen" id="urisMobileScreen"></div>
        </div>`;
    // Неизвестное/остаточное состояние (null после десктопного ресайза, «карточка
    // без refId» посреди правки) иначе молча оставляет вкладку пустой —
    // откатываемся: неизвестное — в список папок, битую карточку — в сетку.
    if (_mobileScreen !== 'folders' && _mobileScreen !== 'grid' && _mobileScreen !== 'card' && _mobileScreen !== 'group') _mobileScreen = 'folders';
    if (_mobileScreen === 'card' && !_editingRefId) _mobileScreen = 'grid';
    if (_mobileScreen === 'group' && !_mobileGroupId) _mobileScreen = 'folders';
    if (_mobileScreen === 'folders') return _renderMobileFolders(root);
    if (_mobileScreen === 'group') return _renderMobileGroup(root);
    if (_mobileScreen === 'grid')   return _renderMobileGrid(root);
    return _renderMobileCard(root);
}

/**
 * Коллаж 2×2 из первых четырёх референсов — превью папки в мобильном списке:
 * узнавание без чтения имени (40+ папок). Экспорт для тестов.
 * @param {{ imagePath?: string }[] | null} refs
 */
export function mobileFolderCollageHtml(refs) {
    const list = (Array.isArray(refs) ? refs : []).slice(0, 4).map(r =>
        `<span class="uris-mobile-folder-thumb" style="background-image:url('${escapeHtml(r?.imagePath || '')}')"></span>`);
    while (list.length < 4) list.push('<span class="uris-mobile-folder-thumb uris-mobile-folder-thumb-empty"></span>');
    return `<span class="uris-mobile-folder-collage">${list.join('')}</span>`;
}

async function _renderMobileFolders(root) {
    const host = root.querySelector('#urisMobileScreen');
    if (!host) return;
    const [folders, refs] = await Promise.all([listFolders(), listRefs()]);
    const prefs = getFolderPrefs();
    const countById = new Map(folders.map(f => [f.id, filterRefsByFolder(refs, f.id).length]));
    const kidsMap = folderChildrenMap(folders);
    const previewCollage = rs => mobileFolderCollageHtml(rs);
    host.innerHTML = `
        <div class="uris-mobile-toolbar">
            <button class="uris-mobile-add-folder">+ Создать папку</button>
            <button class="uris-mobile-add-ref"><i class="fa-solid fa-plus"></i> Референс</button>
            <button class="uris-mobile-manage" title="Управление папками" aria-label="Управление папками"><i class="fa-solid fa-folder-tree"></i></button>
            <input type="file" class="uris-ref-file" accept="image/*" multiple hidden>
        </div>
        <div class="uris-mobile-search-wrap">
            <input class="uris-mobile-folder-search" type="search" value="${escapeHtml(_folderSearchQuery)}"
                placeholder="Поиск папок..." autocomplete="off" aria-label="Поиск папок">
        </div>
        <div class="uris-mobile-list" id="urisMobileFolderList"></div>`;

    // Список папок перерисовывается отдельно от инпута поиска — каретка на месте.
    const renderList = () => {
        const listHost = host.querySelector('#urisMobileFolderList');
        if (!listHost) return;
        const query = _folderSearchQuery.trim().toLowerCase();
        // Верхний уровень в порядке сайдбара; группы (с подпапками) открывают
        // подэкран, обычные папки — сетку как раньше.
        let ordered = orderSidebarFolders(
            folders.filter(f => !f.parentId),
            { pinnedIds: prefs.pinned, sort: prefs.sort, countById });
        if (query) ordered = filterFolders(ordered, query);
        const noFolder = filterRefsByFolder(refs, 'none');
        const rowHtml = (f) => {
            const isGroup = (kidsMap.get(f.id) || []).length > 0;
            const subtreeRefs = isGroup ? filterRefsByFolderTree(refs, folders, f.id) : filterRefsByFolder(refs, f.id);
            const count = isGroup ? subtreeRefs.length : (countById.get(f.id) || 0);
            return `<button class="uris-mobile-folder-item" data-folder="${escapeHtml(f.id)}" data-group="${isGroup ? '1' : ''}">
                ${isGroup ? '<span class="uris-mobile-folder-icon">▸</span>' : ''}
                <span class="uris-folder-dot" style="background:${escapeHtml(f.color)}"></span>
                <span class="uris-mobile-folder-name${isGroup ? ' uris-folder-name-group' : ''}">${escapeHtml(f.name)}</span>
                <span class="uris-mobile-folder-count">${count}</span>
                <span class="uris-mobile-folder-previews">${previewCollage(subtreeRefs)}</span>
                <span class="uris-mobile-folder-arrow">›</span>
            </button>`;
        };
        listHost.innerHTML = `
            <button class="uris-mobile-folder-item" data-folder="all">
                <span class="uris-mobile-folder-icon">◈</span>
                <span class="uris-mobile-folder-name">Все карточки</span>
                <span class="uris-mobile-folder-count">${refs.length}</span>
                <span class="uris-mobile-folder-previews">${previewCollage(refs)}</span>
                <span class="uris-mobile-folder-arrow">›</span>
            </button>
            <button class="uris-mobile-folder-item" data-folder="none">
                <span class="uris-folder-dot uris-folder-dot-mute"></span>
                <span class="uris-mobile-folder-name">Без папки</span>
                <span class="uris-mobile-folder-count">${noFolder.length}</span>
                <span class="uris-mobile-folder-previews">${previewCollage(noFolder)}</span>
                <span class="uris-mobile-folder-arrow">›</span>
            </button>
            ${ordered.map(rowHtml).join('')}
            ${query && !ordered.length ? '<div class="uris-refs-empty">Папки не найдены</div>' : ''}`;
        listHost.querySelectorAll('.uris-mobile-folder-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const folderId = btn.dataset.folder;
                if (btn.dataset.group) {
                    _mobileGroupId = folderId;
                    _mobileScreen = 'group';
                } else {
                    _activeFolderFilter = folderId;
                    _mobileScreen = 'grid';
                }
                _renderMobileAll(root);
            });
            // Долгий тап — действия папки (то же меню, что на десктопе; нижний лист).
            bindCardContextMenu(btn, ({ x, y }) => {
                const folder = folders.find(f => f.id === btn.dataset.folder);
                if (folder) _openFolderMenu({ root, folder, folders, x, y, mobile: true });
            });
        });
    };
    renderList();

    host.querySelector('.uris-mobile-folder-search')?.addEventListener('input', (e) => {
        _folderSearchQuery = e.target.value || '';
        renderList();
    });
    host.querySelector('.uris-mobile-manage')?.addEventListener('click', () => {
        showFolderManager({ onChanged: () => { void _renderMobileAll(root); } });
    });
    host.querySelector('.uris-mobile-add-folder')?.addEventListener('click', async () => {
        const name = await showInputModal('Имя папки:', 'Новая папка');
        if (!name) return;
        await createFolder(name);
        _renderMobileAll(root);
    });
    _bindMobileAddRef(host, root);
}

/**
 * Экран «внутри группы»: первая строка — вся группа рекурсивно, далее подпапки.
 * Тап по строке → сетка; назад → список папок.
 */
async function _renderMobileGroup(root) {
    const host = root.querySelector('#urisMobileScreen');
    if (!host || !_mobileGroupId) { _mobileScreen = 'folders'; return _renderMobileAll(root); }
    const [folders, refs] = await Promise.all([listFolders(), listRefs()]);
    const group = folders.find(f => f.id === _mobileGroupId);
    if (!group) { _mobileGroupId = null; _mobileScreen = 'folders'; return _renderMobileAll(root); }
    const prefs = getFolderPrefs();
    const countById = new Map(folders.map(f => [f.id, filterRefsByFolder(refs, f.id).length]));
    const kids = orderSidebarFolders(folderChildFolders(folders, group.id), { pinnedIds: prefs.pinned, sort: prefs.sort, countById });
    const treeRefs = filterRefsByFolderTree(refs, folders, group.id);
    host.innerHTML = `
        <div class="uris-mobile-toolbar">
            <button class="uris-mobile-back" title="Назад" aria-label="Назад">‹</button>
            <span class="uris-folder-dot" style="background:${escapeHtml(group.color)}"></span>
            <span class="uris-mobile-toolbar-title">${escapeHtml(group.name)}</span>
            <span class="uris-mobile-folder-count">${treeRefs.length}</span>
        </div>
        <div class="uris-mobile-list" id="urisMobileGroupList"></div>`;
    const listHost = host.querySelector('#urisMobileGroupList');
    listHost.innerHTML = `
        <button class="uris-mobile-folder-item" data-folder="${escapeHtml(group.id)}">
            <span class="uris-mobile-folder-icon">◈</span>
            <span class="uris-mobile-folder-name">Все из группы</span>
            <span class="uris-mobile-folder-count">${treeRefs.length}</span>
            <span class="uris-mobile-folder-previews">${mobileFolderCollageHtml(treeRefs)}</span>
            <span class="uris-mobile-folder-arrow">›</span>
        </button>
        ${kids.map(f => {
            const inFolder = filterRefsByFolder(refs, f.id);
            return `<button class="uris-mobile-folder-item" data-folder="${escapeHtml(f.id)}">
                <span class="uris-folder-dot" style="background:${escapeHtml(f.color)}"></span>
                <span class="uris-mobile-folder-name">${escapeHtml(f.name)}</span>
                <span class="uris-mobile-folder-count">${inFolder.length}</span>
                <span class="uris-mobile-folder-previews">${mobileFolderCollageHtml(inFolder)}</span>
                <span class="uris-mobile-folder-arrow">›</span>
            </button>`;
        }).join('')}`;
    listHost.querySelectorAll('.uris-mobile-folder-item').forEach(btn => {
        btn.addEventListener('click', () => {
            _activeFolderFilter = btn.dataset.folder;
            _mobileScreen = 'grid';
            _renderMobileAll(root);
        });
        bindCardContextMenu(btn, ({ x, y }) => {
            const folder = folders.find(f => f.id === btn.dataset.folder);
            if (folder && folder.id !== group.id) _openFolderMenu({ root, folder, folders, x, y, mobile: true });
        });
    });
    host.querySelector('.uris-mobile-back')?.addEventListener('click', () => {
        _mobileGroupId = null;
        _mobileScreen = 'folders';
        _renderMobileAll(root);
    });
}

async function _renderMobileGrid(root) {
    const host = root.querySelector('#urisMobileScreen');
    if (!host) return;
    const [folders, refs] = await Promise.all([listFolders(), listRefs()]);
    const foldersById = new Map(folders.map(f => [f.id, f]));
    const filtered = refsForActiveFilter(refs, folders);
    const searched = filterRefsBySearch(filtered, _mobileSearchQuery);
    const activeFolder = folders.find(f => f.id === _activeFolderFilter);
    const title = _activeFolderFilter === 'all' ? 'Все карточки'
        : _activeFolderFilter === 'none' ? 'Без папки'
        : (activeFolder?.name || 'Папка');
    host.innerHTML = `
        <div class="uris-mobile-toolbar">
            <button class="uris-mobile-back" title="Назад" aria-label="Назад">‹</button>
            <button type="button" class="uris-mobile-folder-switch" title="Сменить папку" aria-label="Сменить папку">
                ${activeFolder ? `<span class="uris-folder-dot" style="background:${escapeHtml(activeFolder.color)}"></span>` : ''}
                <span class="uris-mobile-toolbar-title">${escapeHtml(title)}</span>
                <i class="fa-solid fa-chevron-down"></i>
            </button>
            <span class="uris-mobile-folder-count" id="urisMobileCount">${searched.length}</span>
            <button class="uris-mobile-add-ref"><i class="fa-solid fa-plus"></i> Референс</button>
            <input type="file" class="uris-ref-file" accept="image/*" multiple hidden>
        </div>
        <div class="uris-mobile-search-wrap">
            <input class="uris-mobile-search" type="search" value="${escapeHtml(_mobileSearchQuery)}" placeholder="Поиск..." autocomplete="off" aria-label="Поиск референсов">
        </div>
        <div class="uris-pool-grid uris-mobile-grid" id="urisMobileGrid"></div>`;

    // Previously every keystroke in the search field recreated the entire
    // _renderMobileGrid (toolbar + <input> + grid), which caused the caret
    // to jump to the end after each character. Now _renderTiles only updates
    // the card grid and the counter, preserving focus and caret position.
    const _renderTiles = () => {
        const q = _mobileSearchQuery.trim().toLowerCase();
        const list = filterRefsBySearch(filtered, q);
        const count = host.querySelector('#urisMobileCount');
        if (count) count.textContent = String(list.length);
        const grid = host.querySelector('#urisMobileGrid');
        if (!grid) return;
        if (!list.length) {
            grid.innerHTML = `<div class="uris-refs-empty">${q ? 'Не найдено' : 'Нет карточек'}</div>`;
            return;
        }
        grid.innerHTML = list.map(r => poolTileHtml(r, foldersById, { maxDots: 3 })).join('');
        grid.querySelectorAll('.uris-pool-tile').forEach(tile => {
            tile.addEventListener('click', () => {
                _editingRefId = tile.dataset.refId;
                _mobileScreen = 'card';
                _renderMobileAll(root);
            });
            // Долгий тап / ПКМ: быстрые действия без открытия редактора.
            bindCardContextMenu(tile, ({ x, y }) => {
                const ref = list.find(r => r.id === tile.dataset.refId);
                if (!ref) return;
                openCardActionMenu({
                    title: ref.name || 'Референс',
                    x, y,
                    items: [
                        { id: 'edit', icon: 'fa-pencil', label: 'Правка', onSelect: () => {
                            _editingRefId = ref.id;
                            _mobileScreen = 'card';
                            _renderMobileAll(root);
                        } },
                        { id: 'clone', icon: 'fa-clone', label: 'Клонировать', onSelect: async () => {
                            await cloneRef(ref);
                            _renderTiles();
                        } },
                        { id: 'del', icon: 'fa-trash', label: 'Удалить…', danger: true, onSelect: async () => {
                            if (!(await showConfirmModal(`Удалить референс «${ref.name || 'Без названия'}»?`))) return;
                            await deleteRef(ref.id);
                            _renderTiles();
                        } },
                    ],
                });
            });
        });
    };
    _renderTiles();

    host.querySelector('.uris-mobile-search')?.addEventListener('input', (e) => {
        _mobileSearchQuery = e.target.value;
        _renderTiles();
    });
    host.querySelector('.uris-mobile-back')?.addEventListener('click', () => {
        _mobileScreen = 'folders';
        _renderMobileAll(root);
    });
    // Смена папки без «Назад»: нижний лист со списком (поиск, пины сверху),
    // сетка остаётся видна — паттерн фото-приложений для десятков коллекций.
    host.querySelector('.uris-mobile-folder-switch')?.addEventListener('click', () => openFolderSwitcher(root));
    _bindMobileAddRef(host, root);
}

/**
 * Нижний лист переключения папки из мобильной сетки: «Все»/«Без папки» +
 * реальные папки в порядке сайдбара (пины сверху, счётчики в имени).
 * pick-one — лист закрывается первым же выбором.
 */
function openFolderSwitcher(root) {
    void (async () => {
        const [folders, refs] = await Promise.all([listFolders(), listRefs()]);
        const prefs = getFolderPrefs();
        const countById = new Map(folders.map(f => [f.id, filterRefsByFolder(refs, f.id).length]));
        const ordered = orderSidebarFolders(folders, { pinnedIds: prefs.pinned, sort: prefs.sort, countById });
        const entries = [
            { id: 'all', name: `Все референсы · ${refs.length}`, color: '' },
            { id: 'none', name: `Без папки · ${filterRefsByFolder(refs, 'none').length}`, color: '' },
            ...ordered.map(f => ({ ...f, name: `${f.name} · ${countById.get(f.id) || 0}` })),
        ];
        openFolderSheet({
            title: 'Папка',
            folders: entries,
            mode: 'pick-one',
            onPick: (folder) => {
                _activeFolderFilter = folder.id;
                _mobileSearchQuery = '';
                _renderMobileAll(root);
            },
        });
    })();
}

async function _renderMobileCard(root) {
    const host = root.querySelector('#urisMobileScreen');
    if (!host || !_editingRefId) return;
    const ref = await getRef(_editingRefId);
    if (!ref) { _editingRefId = null; _mobileScreen = 'grid'; return _renderMobileAll(root); }
    const folders = await listFolders();
    host.innerHTML = `
        <div class="uris-mobile-toolbar">
            <button class="uris-mobile-back" title="Назад" aria-label="Назад">‹</button>
            <span class="uris-mobile-toolbar-title">${escapeHtml(ref.name || 'Без названия')}</span>
        </div>
        <div class="uris-mobile-card-scroll" id="urisMobileCardBody"></div>`;
    const body = host.querySelector('#urisMobileCardBody');
    body.innerHTML = refEditorBodyHtml(ref, { deleteLabel: 'Удалить' });
    _bindEditorBody(root, body, ref, folders, {
        onFolderChange: () => _renderMobileCard(root),
        onCloned: () => _renderMobileCard(root),
    });
    host.querySelector('.uris-mobile-back')?.addEventListener('click', () => {
        _mobileScreen = 'grid';
        _renderMobileAll(root);
    });
}

/** Shared editor body binding for both overlay panel and mobile card screen. */
function _bindEditorBody(root, host, ref, folders, opts = {}) {
    const nameInput = host.querySelector('.uris-ed-name');
    const aliasesInput = host.querySelector('.uris-ed-aliases');
    const descInput = host.querySelector('.uris-ed-desc');
    const bindingModeInput = host.querySelector('.uris-ed-binding-mode');
    // Превью — тоже «картинка по клику»: полный экран с зумом (PhotoSwipe),
    // без привязки к сетке — анимация fade. Текстовые поля референса едут
    // вместе с ним в меню копирования; actions:'ref' включает референсные
    // действия просмотрщика (копировать/обрезать) вместо галерейных.
    host.querySelector('.uris-editor-preview-btn')?.addEventListener('click', () => {
        showSingleImage({
            src: ref.imagePath,
            width: ref.width,
            height: ref.height,
            actions: 'ref',
            refId: ref.id,
            name: ref.name,
            aliases: ref.aliases,
            description: ref.description,
        });
    });
    // Text fields (name/aliases/desc) persist on change (blur/commit); folders
    // and image replace persist immediately in their own handlers. There is no
    // explicit "Save" button — saves are silent, like templates/connections.
    const saveBasic = async () => {
        await updateRef(ref.id, {
            name: nameInput.value,
            aliases: aliasesInput.value,
            description: descInput.value,
            bindingMode: bindingModeInput?.checked ? 'description' : 'image',
        });
    };
    nameInput.addEventListener('change', saveBasic);
    aliasesInput.addEventListener('change', saveBasic);
    descInput.addEventListener('change', saveBasic);

    // Expanded editor (ST-style maximized_textarea popup), same unified pattern
    // as the template instruction and image prompt fields. Direct saveBasic()
    // instead of a synthetic change event, like the templates card: bubbled
    // change events don't propagate in the fake-dom tests.
    host.querySelector('[data-act="expand-desc"]')?.addEventListener('click', async () => {
        const next = await editTextModal({ value: descInput.value, title: 'Описание', placeholder: 'Текст для Stage1' });
        if (next === null || next === descInput.value) return;
        descInput.value = next;
        await saveBasic();
    });

    // Папки: чипы выбранных + «+ Папка» с листом-поиском (folder-picker.js).
    // Каждая смена применяется сразу, как остальные поля карточки; шит живёт
    // на document.body и переживает ре-рендер редактора под ним.
    const fpHost = host.querySelector('.uris-fp-host');
    if (fpHost) {
        const field = createFolderField({
            folders,
            selected: ref.folders || [],
            onCreate: (name) => createFolder(name),
            onChange: async (ids) => {
                await updateRef(ref.id, { folders: ids });
                opts.onFolderChange?.();
            },
        });
        fpHost.appendChild(field.el);
    }

    host.querySelector('.uris-ed-replace')?.addEventListener('click', () =>
        host.querySelector('.uris-ed-file')?.click());

    // Кроп ТЕКУЩЕЙ картинки референса: результат — новый файл в хранилище
    // (обрезанные байты ≠ сохранённые), карточка и превью обновляются.
    host.querySelector('.uris-ed-crop')?.addEventListener('click', async () => {
        if (!ref.imagePath) return;
        const oldImage = ref.imagePath;
        try {
            const crop = await openCropDialog({ source: ref.imagePath });
            if (!crop) return;
            // Уникальное имя: перезапись того же URL давала кэшированному
            // тайлу_show_ старую картинку, а переименование ломает только
            // ссылки на файл — владеет им одна запись пула.
            const optimized = await ingestReferenceImage(crop.blob, `ref_${ref.id}_${Date.now()}`);
            try {
                await updateRef(ref.id, { imagePath: optimized.imagePath, ...optimized.metadata });
                await persistPoolOrThrow('обрезать');
            } catch (mutationError) {
                throw new Error(`${mutationError.message}; orphaned upload: ${optimized.imagePath}`);
            }
            releaseRefImage(oldImage);
            const img = host.querySelector('.uris-editor-preview');
            if (img) img.src = optimized.imagePath;
        } catch (err) {
            reportFailure({ scope: URIS_SCOPES.refs, message: 'Не удалось обрезать: ' + (err?.message || err), toast: true, toastText: 'Не удалось обрезать: ' + err.message });
        }
    });
    host.querySelector('.uris-ed-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const oldImage = ref.imagePath;
        try {
            // Кроп опционален: «Без обрезки» грузит файл как есть, «Отмена»
            // вообще ничего не меняет.
            const crop = await openCropDialog({ source: file, allowSkip: true });
            if (!crop) return;
            const optimized = await ingestReferenceImage(crop.blob || file, `ref_${ref.id}_${Date.now()}`);
            try {
                await updateRef(ref.id, { imagePath: optimized.imagePath, ...optimized.metadata });
                await persistPoolOrThrow('заменить');
            } catch (mutationError) {
                throw new Error(`${mutationError.message}; orphaned upload: ${optimized.imagePath}`);
            }
            releaseRefImage(oldImage);
            const img = host.querySelector('.uris-editor-preview');
            if (img) img.src = optimized.imagePath;
        } catch (err) {
            reportFailure({ scope: URIS_SCOPES.refs, message: 'Не удалось заменить: ' + (err?.message || err), toast: true, toastText: 'Не удалось заменить: ' + err.message });
        }
        e.target.value = '';
    });

    // Клон: новая запись пула поверх ТЕКУЩЕГО файла картинки — releaseRefImage
    // удержит файл, пока клон на него смотрит, так что правки расходятся
    // независимо. Редактор сразу переключается на клона: в сетке с 50+ карточками
    // он мог бы уехать за экран, а переименовать его нужно сейчас.
    host.querySelector('.uris-ed-clone')?.addEventListener('click', async () => {
        try {
            const clone = await cloneRef(ref);
            toastr?.success('Клонирован: ' + clone.name);
            _editingRefId = clone.id;
            await opts.onCloned?.();
        } catch (err) {
            reportFailure({ scope: URIS_SCOPES.refs, message: 'Клонирование: ' + (err?.message || err), toast: true, toastText: 'Не удалось клонировать: ' + err.message });
        }
    });

    host.querySelector('.uris-ed-del')?.addEventListener('click', async () => {
        if (await showConfirmModal('Удалить референс из пула?')) {
            await deleteRef(ref.id);
            _editingRefId = null;
            _mobileScreen = 'grid';
            refreshActive();
        }
    });
}

function _bindMobileAddRef(host, root) {
    const fileInput = host.querySelector('.uris-ref-file');
    host.querySelector('.uris-mobile-add-ref')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', e => {
        const files = [...(e.target.files || [])];
        e.target.value = '';
        if (!files.length) return;
        const folderIds = _activeFolderFilter !== 'all' && _activeFolderFilter !== 'none'
            ? [_activeFolderFilter] : [];
        openBatchUploadDialog({ files, folderIds, onFinish: () => _renderMobileAll(root) });
    });
}

// ── Pool picker overlay (multi/single) ──

/**
 * Чипы фильтра пикера: Все/Без папки + избранное (до 5) + «Все папки ▾».
 * При 50+ папок лента всех чипов превращалась в бесконечный скролл — полный
 * список теперь живёт в шите с поиском (openFolderSheet pick-one). Активная
 * папка вне избранного показывается чипом, чтобы было видно текущий фильтр.
 */
function pickerChipsHtml(folders, activeFilter) {
    const chip = (folder, label) =>
        // folder в атрибуте экранируется наравне с label: id приходит из импорта
        // и хотя sanitizeId режет алфавит на входе, тут страховка на два фронта.
        `<span class="uris-folder-chip ${activeFilter === folder ? 'uris-folder-chip-on' : ''}" data-folder="${escapeHtml(folder)}">${escapeHtml(label)}</span>`;
    const prefs = getFolderPrefs();
    const byId = new Map(folders.map(f => [f.id, f]));
    const favorites = prefs.pinned.filter(id => byId.has(id)).slice(0, 5);
    let html = chip('all', 'Все') + chip('none', 'Без папки');
    if (activeFilter !== 'all' && activeFilter !== 'none' && byId.has(activeFilter) && !favorites.includes(activeFilter)) {
        html += chip(activeFilter, byId.get(activeFilter).name);
    }
    for (const id of favorites) html += chip(id, byId.get(id).name);
    html += `<span class="uris-folder-chip uris-picker-more" data-picker-more="1" title="Выбрать папку">Все папки <i class="fa-solid fa-caret-down"></i></span>`;
    return html;
}

export async function showPoolPicker({ title = 'Выберите референсы', multi = true, excludeIds = [] } = {}) {
    const allRefs = (await listRefs()).filter(r => r.imagePath && !excludeIds.includes(r.id));
    const folders = await listFolders();
    if (!allRefs.length) {
        toastr?.info('Пул пуст. Добавьте референсы в библиотеку.');
        return multi ? [] : null;
    }
    let pickerFilter = 'all';
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'uris-picker-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Выбор референсов');
        const selected = new Set();
            const filteredRefs = () => filterRefsByFolder(allRefs, pickerFilter);
        const renderGrid = () => {
            const grid = overlay.querySelector('.uris-picker-grid');
            if (!grid) return;
            grid.innerHTML = filteredRefs().map(r => {
                return `<button type="button" class="uris-pool-tile uris-pick-tile ${selected.has(r.id) ? 'uris-pick-selected' : ''}" data-ref-id="${escapeHtml(r.id)}" aria-label="${escapeHtml(r.name)}" aria-pressed="${selected.has(r.id)}" title="${escapeHtml(r.name)}">
                    <img src="${escapeHtml(r.imagePath)}" alt="${escapeHtml(r.name)}" loading="lazy">
                    <div class="uris-pool-tile-name">${escapeHtml(r.name)}</div>
                </button>`;
            }).join('');
        };
        overlay.innerHTML = `
            <div class="uris-picker-dialog">
                <h4>${escapeHtml(title)}</h4>
                <div class="uris-refs-filterbar">
                    <div class="uris-refs-chips uris-scroll-x" id="urisPickerFolders"></div>
                </div>
                <div class="uris-pool-grid uris-picker-grid"></div>
                <div class="uris-picker-actions">
                    <button class="uris-btn uris-btn-ghost uris-pick-cancel">Отмена</button>
                    ${multi ? '<button class="uris-btn uris-btn-primary uris-pick-ok">Готово</button>' : ''}
                </div>
            </div>`;
        document.body.appendChild(overlay);
        lockBodyScroll();

        const renderFolders = () => {
            const fc = overlay.querySelector('#urisPickerFolders');
            if (!fc) return;
            fc.innerHTML = pickerChipsHtml(folders, pickerFilter);
            fc.querySelectorAll('.uris-folder-chip').forEach(chip => {
                if (!chip.dataset.folder) return; // чип «Все папки» биндится ниже
                chip.addEventListener('click', () => {
                    pickerFilter = chip.dataset.folder;
                    renderFolders();
                    renderGrid();
                });
            });
            fc.querySelector('.uris-picker-more')?.addEventListener('click', () => {
                openFolderSheet({
                    title: 'Фильтр по папке',
                    mode: 'pick-one',
                    folders,
                    onPick: (folder) => {
                        pickerFilter = folder.id;
                        renderFolders();
                        renderGrid();
                    },
                });
            });
        };

        renderFolders();
        renderGrid();

        overlay.addEventListener('click', (e) => {
            const tile = e.target.closest('.uris-pick-tile');
            if (!tile) return;
            const id = tile.dataset.refId;
            if (multi) {
                if (selected.has(id)) { selected.delete(id); tile.classList.remove('uris-pick-selected'); }
                else { selected.add(id); tile.classList.add('uris-pick-selected'); }
            } else {
                overlay.remove(); unlockBodyScroll();
                resolve(id);
            }
        });
        overlay.querySelector('.uris-pick-cancel')?.addEventListener('click', () => { overlay.remove(); unlockBodyScroll(); resolve(multi ? [] : null); });
        overlay.querySelector('.uris-pick-ok')?.addEventListener('click', () => { overlay.remove(); unlockBodyScroll(); resolve([...selected]); });
    });
}
