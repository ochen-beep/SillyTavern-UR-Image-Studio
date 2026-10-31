// @ts-check
/**
 * References tab mobile stack: folder list → group → grid → card screens
 * (hygiene split 2026-10-25). Owns the mobile nav state; reuses the shared
 * pool-grid delegation, the reference editor and the folder action menu.
 */
import { escapeHtml, debounce, showConfirmModal, showInputModal } from '../core.js';
import {
    listRefs, getRef, deleteRef, cloneRef, createFolder, listFolders,
    getFolderPrefs, filterRefsByFolder, filterRefsByFolderTree, folderChildFolders, folderChildrenMap,
} from '../refs-library.js';
import { refreshActive } from './tabs.js';
import { openFolderSheet, orderSidebarFolders } from './folder-picker.js';
import { openCardActionMenu, bindCardContextMenu } from './card-action-menu.js';
import { openBatchUploadDialog } from './ref-batch-upload.js';
import { refEditorBodyHtml, bindEditorBody } from './ref-editor.js';
import { openFolderMenu } from './refs-sidebar.js';
import {
    refsView, refsForActiveFilter, filterRefsBySearch, poolTileHtml,
    REFS_SEARCH_DEBOUNCE_MS, bindPoolGridDelegation,
} from './refs-view-shared.js';

// ── Mobile stack ──
let _mobileScreen = 'folders';  // 'folders' | 'group' | 'grid' | 'card'
let _mobileGroupId = null;      // открытая группа на экране 'group'

/** Test-only: reset mobile navigation state. It is module-level and, by design
 * (refresh must not kick the user back to folders), survives render(). */
export function __resetMobileNavForTests() {
    _mobileScreen = 'folders';
    _mobileGroupId = null;
    refsView.mobileSearchQuery = '';
    refsView.folderSearchQuery = '';
}

export async function renderMobileAll(root) {
    root.innerHTML = `
        <div class="uris-references uris-refs-mobile-stack">
            <div class="uris-mobile-screen" id="urisMobileScreen"></div>
        </div>`;
    // Неизвестное/остаточное состояние (null после десктопного ресайза, «карточка
    // без refId» посреди правки) иначе молча оставляет вкладку пустой —
    // откатываемся: неизвестное — в список папок, битую карточку — в сетку.
    if (_mobileScreen !== 'folders' && _mobileScreen !== 'grid' && _mobileScreen !== 'card' && _mobileScreen !== 'group') _mobileScreen = 'folders';
    if (_mobileScreen === 'card' && !refsView.editingRefId) _mobileScreen = 'grid';
    if (_mobileScreen === 'group' && !_mobileGroupId) _mobileScreen = 'folders';
    if (_mobileScreen === 'folders') return _renderMobileFolders(root);
    if (_mobileScreen === 'group') return _renderMobileGroup(root);
    if (_mobileScreen === 'grid')   return _renderMobileGrid(root);
    return _renderMobileCard(root);
}

/**
 * Коллаж 2×2 из первых четырёх референсов — превью папки в мобильном списке:
 * узнавание без чтения имени (40+ папок). Экспорт для тестов.
 * @param {{ imagePath?: string, thumbPath?: string }[] | null} refs
 */
export function mobileFolderCollageHtml(refs) {
    const list = (Array.isArray(refs) ? refs : []).slice(0, 4).map(r =>
        `<span class="uris-mobile-folder-thumb" style="background-image:url('${escapeHtml(r?.thumbPath || r?.imagePath || '')}')"></span>`);
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
            <input class="uris-mobile-folder-search" type="search" value="${escapeHtml(refsView.folderSearchQuery)}"
                placeholder="Поиск папок..." autocomplete="off" aria-label="Поиск папок">
        </div>
        <div class="uris-mobile-list" id="urisMobileFolderList"></div>`;

    // Список папок перерисовывается отдельно от инпута поиска — каретка на месте.
    const renderList = () => {
        const listHost = host.querySelector('#urisMobileFolderList');
        if (!listHost) return;
        const query = refsView.folderSearchQuery.trim().toLowerCase();
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
                    refsView.activeFolderFilter = folderId;
                    _mobileScreen = 'grid';
                }
                renderMobileAll(root);
            });
            // Долгий тап — действия папки (то же меню, что на десктопе; нижний лист).
            bindCardContextMenu(btn, ({ x, y }) => {
                const folder = folders.find(f => f.id === btn.dataset.folder);
                if (folder) openFolderMenu({ root, folder, folders, x, y, mobile: true });
            });
        });
    };
    renderList();

    host.querySelector('.uris-mobile-folder-search')?.addEventListener('input', (e) => {
        refsView.folderSearchQuery = e.target.value || '';
        renderList();
    });
    host.querySelector('.uris-mobile-manage')?.addEventListener('click', () => {
        showFolderManager({ onChanged: () => { void renderMobileAll(root); } });
    });
    host.querySelector('.uris-mobile-add-folder')?.addEventListener('click', async () => {
        const name = await showInputModal('Имя папки:', 'Новая папка');
        if (!name) return;
        await createFolder(name);
        renderMobileAll(root);
    });
    _bindMobileAddRef(host, root);
}

/**
 * Экран «внутри группы»: первая строка — вся группа рекурсивно, далее подпапки.
 * Тап по строке → сетка; назад → список папок.
 */
async function _renderMobileGroup(root) {
    const host = root.querySelector('#urisMobileScreen');
    if (!host || !_mobileGroupId) { _mobileScreen = 'folders'; return renderMobileAll(root); }
    const [folders, refs] = await Promise.all([listFolders(), listRefs()]);
    const group = folders.find(f => f.id === _mobileGroupId);
    if (!group) { _mobileGroupId = null; _mobileScreen = 'folders'; return renderMobileAll(root); }
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
            refsView.activeFolderFilter = btn.dataset.folder;
            _mobileScreen = 'grid';
            renderMobileAll(root);
        });
        bindCardContextMenu(btn, ({ x, y }) => {
            const folder = folders.find(f => f.id === btn.dataset.folder);
            if (folder && folder.id !== group.id) openFolderMenu({ root, folder, folders, x, y, mobile: true });
        });
    });
    host.querySelector('.uris-mobile-back')?.addEventListener('click', () => {
        _mobileGroupId = null;
        _mobileScreen = 'folders';
        renderMobileAll(root);
    });
}

async function _renderMobileGrid(root) {
    const host = root.querySelector('#urisMobileScreen');
    if (!host) return;
    const [folders, refs] = await Promise.all([listFolders(), listRefs()]);
    const foldersById = new Map(folders.map(f => [f.id, f]));
    const filtered = refsForActiveFilter(refs, folders);
    const searched = filterRefsBySearch(filtered, refsView.mobileSearchQuery);
    const activeFolder = folders.find(f => f.id === refsView.activeFolderFilter);
    const title = refsView.activeFolderFilter === 'all' ? 'Все карточки'
        : refsView.activeFolderFilter === 'none' ? 'Без папки'
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
            <input class="uris-mobile-search" type="search" value="${escapeHtml(refsView.mobileSearchQuery)}" placeholder="Поиск..." autocomplete="off" aria-label="Поиск референсов">
        </div>
        <div class="uris-pool-grid uris-mobile-grid" id="urisMobileGrid"></div>`;

    // Previously every keystroke in the search field recreated the entire
    // _renderMobileGrid (toolbar + <input> + grid), which caused the caret
    // to jump to the end after each character. Now _renderTiles only updates
    // the card grid and the counter, preserving focus and caret position.
    const _renderTiles = () => {
        const q = refsView.mobileSearchQuery.trim().toLowerCase();
        const list = filterRefsBySearch(filtered, q);
        const count = host.querySelector('#urisMobileCount');
        if (count) count.textContent = String(list.length);
        const grid = host.querySelector('#urisMobileGrid');
        if (!grid) return;
        refsView.gridRefs = list;
        bindPoolGridDelegation(grid, {
            onOpen: (refId) => {
                refsView.editingRefId = refId;
                _mobileScreen = 'card';
                void renderMobileAll(root);
            },
            menuItems: (ref) => [
                { id: 'edit', icon: 'fa-pencil', label: 'Правка', onSelect: () => {
                    refsView.editingRefId = ref.id;
                    _mobileScreen = 'card';
                    renderMobileAll(root);
                } },
                { id: 'clone', icon: 'fa-clone', label: 'Клонировать', onSelect: async () => {
                    await cloneRef(ref);
                    renderMobileAll(root);
                } },
                { id: 'del', icon: 'fa-trash', label: 'Удалить…', danger: true, onSelect: async () => {
                    if (!(await showConfirmModal(`Удалить референс «${ref.name || 'Без названия'}»?`))) return;
                    await deleteRef(ref.id);
                    renderMobileAll(root);
                } },
            ],
        });
        if (!list.length) {
            grid.innerHTML = `<div class="uris-refs-empty">${q ? 'Не найдено' : 'Нет карточек'}</div>`;
            return;
        }
        performance.mark('uris:refs-grid');
        grid.innerHTML = list.map(r => poolTileHtml(r, foldersById, { maxDots: 3 })).join('');
        performance.measure('uris:refs-grid', 'uris:refs-grid');
    };
    _renderTiles();

    const runMobileSearch = debounce(_renderTiles, REFS_SEARCH_DEBOUNCE_MS);
    host.querySelector('.uris-mobile-search')?.addEventListener('input', (e) => {
        refsView.mobileSearchQuery = e.target.value;
        runMobileSearch();
    });
    host.querySelector('.uris-mobile-back')?.addEventListener('click', () => {
        _mobileScreen = 'folders';
        renderMobileAll(root);
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
                refsView.activeFolderFilter = folder.id;
                refsView.mobileSearchQuery = '';
                renderMobileAll(root);
            },
        });
    })();
}

async function _renderMobileCard(root) {
    const host = root.querySelector('#urisMobileScreen');
    if (!host || !refsView.editingRefId) return;
    const ref = await getRef(refsView.editingRefId);
    if (!ref) { refsView.editingRefId = null; _mobileScreen = 'grid'; return renderMobileAll(root); }
    const folders = await listFolders();
    host.innerHTML = `
        <div class="uris-mobile-toolbar">
            <button class="uris-mobile-back" title="Назад" aria-label="Назад">‹</button>
            <span class="uris-mobile-toolbar-title">${escapeHtml(ref.name || 'Без названия')}</span>
        </div>
        <div class="uris-mobile-card-scroll" id="urisMobileCardBody"></div>`;
    const body = host.querySelector('#urisMobileCardBody');
    body.innerHTML = refEditorBodyHtml(ref, { deleteLabel: 'Удалить' });
    bindEditorBody(root, body, ref, folders, {
        onFolderChange: () => _renderMobileCard(root),
        onCloned: () => _renderMobileCard(root),
    });
    host.querySelector('.uris-mobile-back')?.addEventListener('click', () => {
        _mobileScreen = 'grid';
        renderMobileAll(root);
    });
}

function _bindMobileAddRef(host, root) {
    const fileInput = host.querySelector('.uris-ref-file');
    host.querySelector('.uris-mobile-add-ref')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', e => {
        const files = [...(e.target.files || [])];
        e.target.value = '';
        if (!files.length) return;
        const folderIds = refsView.activeFolderFilter !== 'all' && refsView.activeFolderFilter !== 'none'
            ? [refsView.activeFolderFilter] : [];
        openBatchUploadDialog({ files, folderIds, onFinish: () => renderMobileAll(root) });
    });
}
