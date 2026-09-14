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
    getFolderPrefs, saveFolderPrefs,
} from '../refs-library.js';

import { ingestReferenceImage } from '../references.js';
import { openBatchUploadDialog } from './ref-batch-upload.js';
import { openCropDialog } from './crop-dialog.js';
import { showSingleImage } from './lightbox.js';
import { refreshActive, getActiveTab } from './tabs.js';
import { lockBodyScroll, unlockBodyScroll } from './window.js';
import { recordUrisError } from '../error-pool.js';
import {
    createFolderField, openFolderSheet, orderSidebarFolders, nextFolderSortMode, filterFolders,
} from './folder-picker.js';
import { showFolderManager } from './folder-manager.js';

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
// layout. Visual-px math, if ever needed, goes through visualWidth()
// (src/ui/zoom.js), not by dividing by the state value.
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
// Поиск + секции (Избранное/Папки) + сортировка/скрытие пустых переживают
// списки в 50+ папок. Инпут поиска живёт ВНЕ перерисовываемого списка:
// _renderFolderList обновляет только строки, иначе каретка прыгает (см.
// комментарий про caret в _renderMobileGrid).
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

function _renderFolderList(root, folders, refs) {
    const host = root.querySelector('#urisFolderList');
    if (!host) return;
    const prefs = getFolderPrefs();
    const query = _folderSearchQuery.trim().toLowerCase();
    const countAll = refs.length;
    const countNone = filterRefsByFolder(refs, 'none').length;
    const itemHtml = (folderId, label, count, dotColor) => `
        <button class="uris-folder-item ${_activeFolderFilter === folderId ? 'uris-folder-item-on' : ''}"
                data-folder="${escapeHtml(folderId)}">
            ${dotColor ? `<span class="uris-folder-dot" style="background:${dotColor}"></span>` : `<span class="uris-folder-dot uris-folder-dot-mute"></span>`}
            <span class="uris-folder-name">${escapeHtml(label)}</span>
            <span class="uris-folder-count">${count}</span>
        </button>`;
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
    const countById = new Map(folders.map(f => [f.id, filterRefsByFolder(refs, f.id).length]));
    const pinnedSet = new Set(prefs.pinned);
    let visible = orderSidebarFolders(folders, { pinnedIds: prefs.pinned, sort: prefs.sort, countById });
    // «Скрывать пустые» не действует в поиске: ищут, чтобы найти любую папку.
    if (prefs.hideEmpty && !query) visible = visible.filter(f => (countById.get(f.id) || 0) > 0);
    if (query) visible = filterFolders(visible, query);

    const rowsHtml = (list) => list.map(f => `
        <div class="uris-folder-row">
            ${itemHtml(f.id, f.name, countById.get(f.id) || 0, f.color)}
            <button class="uris-folder-pin ${pinnedSet.has(f.id) ? 'uris-folder-pin-on' : ''}" type="button"
                    data-folder-id="${escapeHtml(f.id)}"
                    title="${pinnedSet.has(f.id) ? 'Убрать из избранного' : 'В избранное'}" aria-label="В избранное"><i class="fa-solid fa-star"></i></button>
            <button class="uris-folder-edit" type="button" data-folder-id="${escapeHtml(f.id)}" title="Изменить папку" aria-label="Изменить папку"><i class="fa-solid fa-pencil"></i></button>
        </div>
        ${editorHtml(f)}`).join('');

    const SORT_UI = {
        manual: { icon: 'fa-bars', title: 'Сортировка: своя → по имени' },
        name: { icon: 'fa-arrow-down-a-z', title: 'Сортировка: по имени → по количеству' },
        count: { icon: 'fa-arrow-down-short-wide', title: 'Сортировка: по количеству → своя' },
    };
    const sortUi = SORT_UI[prefs.sort] || SORT_UI.manual;
    const headerHtml = `
        <div class="uris-folder-header">
            <span class="uris-folder-header-label">Папки</span>
            <span class="uris-folder-tools">
                <button class="uris-folder-tool" id="urisFolderSortBtn" type="button" title="${escapeHtml(sortUi.title)}" aria-label="Сортировка папок"><i class="fa-solid ${sortUi.icon}"></i></button>
                <button class="uris-folder-tool" id="urisFolderHideEmptyBtn" type="button" title="${prefs.hideEmpty ? 'Показывать пустые папки' : 'Скрывать пустые папки'}" aria-label="Скрывать пустые папки"><i class="fa-solid ${prefs.hideEmpty ? 'fa-eye-slash' : 'fa-eye'}"></i></button>
                <button class="uris-folder-tool" id="urisFolderManageBtn" type="button" title="Управление папками" aria-label="Управление папками"><i class="fa-solid fa-folder-tree"></i></button>
                <button class="uris-folder-header-add" id="urisRefsAddFolderBtn" type="button" title="Создать папку" aria-label="Создать папку"><i class="fa-solid fa-plus"></i></button>
            </span>
        </div>`;

    const inSearch = Boolean(query);
    const pinnedVisible = visible.filter(f => pinnedSet.has(f.id));
    const restVisible = visible.filter(f => !pinnedSet.has(f.id));
    host.innerHTML = `
        ${itemHtml('all', 'Все карточки', countAll, null)}
        ${itemHtml('none', 'Без папки', countNone, null)}
        ${!inSearch && pinnedVisible.length ? `<div class="uris-folder-section-label">Избранное</div>${rowsHtml(pinnedVisible)}` : ''}
        ${!inSearch ? headerHtml : ''}
        ${inSearch ? rowsHtml(visible) : rowsHtml(restVisible)}
        ${inSearch && !visible.length ? '<div class="uris-folder-empty">Папки не найдены</div>' : ''}`;

    host.querySelectorAll('.uris-folder-item').forEach(btn => {
        btn.addEventListener('click', async () => {
            _activeFolderFilter = btn.dataset.folder;
            await _renderAll(root);
        });
    });
    host.querySelectorAll('.uris-folder-pin').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.folderId;
            const current = getFolderPrefs();
            const pinned = current.pinned.includes(id)
                ? current.pinned.filter(pinnedId => pinnedId !== id)
                : [...current.pinned, id];
            saveFolderPrefs({ pinned });
            _renderFolderList(root, folders, refs);
        });
    });
    host.querySelector('#urisFolderSortBtn')?.addEventListener('click', () => {
        saveFolderPrefs({ sort: nextFolderSortMode(prefs.sort) });
        _renderFolderList(root, folders, refs);
    });
    host.querySelector('#urisFolderHideEmptyBtn')?.addEventListener('click', () => {
        saveFolderPrefs({ hideEmpty: !prefs.hideEmpty });
        _renderFolderList(root, folders, refs);
    });
    host.querySelector('#urisFolderManageBtn')?.addEventListener('click', () => {
        showFolderManager({ onChanged: () => { void _renderAll(root); } });
    });
    host.querySelectorAll('.uris-folder-edit').forEach(btn => {
        btn.addEventListener('click', async () => {
            _editingFolderId = btn.dataset.folderId;
            await _renderAll(root);
        });
    });
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
            await deleteFolder(folder.id);
            _editingFolderId = null;
            if (_activeFolderFilter === folder.id) _activeFolderFilter = 'none';
            await _renderAll(root);
        });
    }
    host.querySelector('#urisRefsAddFolderBtn')?.addEventListener('click', async () => {
        const name = await showInputModal('Имя папки:', 'Новая папка');
        if (!name) return;
        await createFolder(name);
        refreshActive();
    });
}

// ── Toolbar ──
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
    host.innerHTML = `
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
}

// ── Grid ──
async function _renderGrid(root, folders, refsOverride, searchQuery = '') {
    const host = root.querySelector('#urisRefsGrid');
    if (!host) return;
    const refs = refsOverride ?? await listRefs();
    const filtered = filterRefsByFolder(refs, _activeFolderFilter);
    const q = (searchQuery || '').toLowerCase().trim();
    const searched = q
        ? filtered.filter(r => (r.name || '').toLowerCase().includes(q)
            || (r.aliases || []).some(a => a.toLowerCase().includes(q)))
        : filtered;
    if (!searched.length) {
        host.innerHTML = `<div class="uris-refs-empty">${q ? 'Не найдено' : 'Пусто. Добавьте референс кнопкой «+».'}</div>`;
        return;
    }
    const foldersById = new Map(folders.map(f => [f.id, f]));
    host.innerHTML = searched.map(r => {
        const cardFolders = (r.folders || []).map(fid => foldersById.get(fid)).filter(Boolean);
        const dots = cardFolders.slice(0, 4).map(f =>
            `<span class="uris-pool-tile-dot" style="background:${escapeHtml(f.color)}"></span>`
        ).join('');
        return `
        <button type="button" class="uris-pool-tile ${_editingRefId === r.id ? 'uris-pool-tile-selected' : ''}"
             data-ref-id="${escapeHtml(r.id)}" aria-label="${escapeHtml(r.name)}" title="${escapeHtml(r.name)}">
            <img src="${escapeHtml(r.imagePath)}" alt="${escapeHtml(r.name)}" loading="lazy">
            ${dots ? `<div class="uris-pool-tile-dots">${dots}</div>` : ''}
            <div class="uris-pool-tile-name">${escapeHtml(r.name)}</div>
        </button>`;
    }).join('');
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
                <div class="uris-refs-overlay-body">
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
                <small class="uris-hint">Сопоставление с промптом идёт по алиасам — перечислите имена и прозвища через запятую. Имя — только подпись. Поддерживаются {{char}}/{{user}}.</small>
                <label class="uris-ed-label">Описание</label>
                <textarea class="text_pole uris-ed-desc" rows="3" placeholder="Текст для Stage1">${escapeHtml(ref.description || '')}</textarea>
                <label class="uris-ed-check"><input type="checkbox" class="uris-ed-binding-mode" ${ref.bindingMode === 'description' ? 'checked' : ''}> Только описание</label>
                <small class="uris-hint">Без картинки в генерацию попадёт только это описание.</small>
                <label class="uris-ed-label">Папки</label>
                <div class="uris-fp-host"></div>
                <div class="uris-ed-autosave" aria-live="polite">Автосохранение</div>
                <button class="uris-btn uris-btn-ghost uris-ed-del"><i class="fa-solid fa-trash"></i> Удалить карточку</button>
            </div>
        </div>`;
    _bindOverlay(root, host, ref, folders);
}

function _bindOverlay(root, host, ref, folders) {
    _bindEditorBody(root, host.querySelector('.uris-refs-overlay-body'), ref, folders, {
        onFolderChange: async () => {
            // Свежий список папок: шит поля мог создать новую папку.
            const freshFolders = await listFolders();
            await _renderOverlay(root, freshFolders);
            _renderSidebar(root, freshFolders, await listRefs());
            _renderGrid(root, freshFolders);
        },
    });
    host.querySelector('.uris-refs-overlay-close')?.addEventListener('click', async () => {
        _editingRefId = null;
        await _renderAll(root);
    });
}

// ── Mobile stack ──
let _mobileScreen = 'folders';  // 'folders' | 'grid' | 'card'

/** Test-only: reset mobile navigation state. It is module-level and, by design
 * (refresh must not kick the user back to folders), survives render(). */
export function __resetMobileNavForTests() {
    _mobileScreen = 'folders';
    _mobileSearchQuery = '';
    _folderSearchQuery = '';
}

async function _renderMobileAll(root) {
    root.innerHTML = `
        <div class="uris-references uris-refs-mobile-stack">
            <div class="uris-mobile-screen" id="urisMobileScreen"></div>
        </div>`;
    if (_mobileScreen === 'folders') return _renderMobileFolders(root);
    if (_mobileScreen === 'grid')   return _renderMobileGrid(root);
    if (_mobileScreen === 'card')   return _renderMobileCard(root);
}

async function _renderMobileFolders(root) {
    const host = root.querySelector('#urisMobileScreen');
    if (!host) return;
    const [folders, refs] = await Promise.all([listFolders(), listRefs()]);
    const prefs = getFolderPrefs();
    const countById = new Map(folders.map(f => [f.id, filterRefsByFolder(refs, f.id).length]));
    const previewDots = (rs) => rs.slice(0, 3).map(r =>
        `<span class="uris-mobile-folder-thumb" style="background-image:url('${escapeHtml(r.imagePath)}')"></span>`
    ).join('');
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
        let ordered = orderSidebarFolders(folders, { pinnedIds: prefs.pinned, sort: prefs.sort, countById });
        if (query) ordered = filterFolders(ordered, query);
        const noFolder = filterRefsByFolder(refs, 'none');
        listHost.innerHTML = `
            <button class="uris-mobile-folder-item" data-folder="all">
                <span class="uris-mobile-folder-icon">◈</span>
                <span class="uris-mobile-folder-name">Все карточки</span>
                <span class="uris-mobile-folder-count">${refs.length}</span>
                <span class="uris-mobile-folder-previews">${previewDots(refs)}</span>
                <span class="uris-mobile-folder-arrow">›</span>
            </button>
            <button class="uris-mobile-folder-item" data-folder="none">
                <span class="uris-folder-dot uris-folder-dot-mute"></span>
                <span class="uris-mobile-folder-name">Без папки</span>
                <span class="uris-mobile-folder-count">${noFolder.length}</span>
                <span class="uris-mobile-folder-previews">${previewDots(noFolder)}</span>
                <span class="uris-mobile-folder-arrow">›</span>
            </button>
            ${ordered.map(f => {
                const inFolder = filterRefsByFolder(refs, f.id);
                return `<button class="uris-mobile-folder-item" data-folder="${escapeHtml(f.id)}">
                    <span class="uris-folder-dot" style="background:${escapeHtml(f.color)}"></span>
                    <span class="uris-mobile-folder-name">${escapeHtml(f.name)}</span>
                    <span class="uris-mobile-folder-count">${inFolder.length}</span>
                    <span class="uris-mobile-folder-previews">${previewDots(inFolder)}</span>
                    <span class="uris-mobile-folder-arrow">›</span>
                </button>`;
            }).join('')}
            ${query && !ordered.length ? '<div class="uris-refs-empty">Папки не найдены</div>' : ''}`;
        listHost.querySelectorAll('.uris-mobile-folder-item').forEach(btn => {
            btn.addEventListener('click', () => {
                _activeFolderFilter = btn.dataset.folder;
                _mobileScreen = 'grid';
                _renderMobileAll(root);
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

async function _renderMobileGrid(root) {
    const host = root.querySelector('#urisMobileScreen');
    if (!host) return;
    const [folders, refs] = await Promise.all([listFolders(), listRefs()]);
    const foldersById = new Map(folders.map(f => [f.id, f]));
    const filtered = filterRefsByFolder(refs, _activeFolderFilter);
    const searchQuery = _mobileSearchQuery.trim().toLowerCase();
    const searched = searchQuery
        ? filtered.filter(r => (r.name || '').toLowerCase().includes(searchQuery)
            || (r.aliases || []).some(alias => alias.toLowerCase().includes(searchQuery)))
        : filtered;
    const activeFolder = folders.find(f => f.id === _activeFolderFilter);
    const title = _activeFolderFilter === 'all' ? 'Все карточки'
        : _activeFolderFilter === 'none' ? 'Без папки'
        : (activeFolder?.name || 'Папка');
    host.innerHTML = `
        <div class="uris-mobile-toolbar">
            <button class="uris-mobile-back" title="Назад" aria-label="Назад">‹</button>
            ${activeFolder ? `<span class="uris-folder-dot" style="background:${escapeHtml(activeFolder.color)}"></span>` : ''}
            <span class="uris-mobile-toolbar-title">${escapeHtml(title)}</span>
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
        const list = q
            ? filtered.filter(r => (r.name || '').toLowerCase().includes(q)
                || (r.aliases || []).some(a => a.toLowerCase().includes(q)))
            : filtered;
        const count = host.querySelector('#urisMobileCount');
        if (count) count.textContent = String(list.length);
        const grid = host.querySelector('#urisMobileGrid');
        if (!grid) return;
        if (!list.length) {
            grid.innerHTML = `<div class="uris-refs-empty">${q ? 'Не найдено' : 'Нет карточек'}</div>`;
            return;
        }
        grid.innerHTML = list.map(r => {
            const dots = (r.folders || []).map(fid => foldersById.get(fid)).filter(Boolean)
                .slice(0, 3).map(f => `<span class="uris-pool-tile-dot" style="background:${escapeHtml(f.color)}"></span>`).join('');
            return `<button type="button" class="uris-pool-tile" data-ref-id="${escapeHtml(r.id)}" aria-label="${escapeHtml(r.name)}" title="${escapeHtml(r.name)}">
                <img src="${escapeHtml(r.imagePath)}" alt="${escapeHtml(r.name)}" loading="lazy">
                ${dots ? `<div class="uris-pool-tile-dots">${dots}</div>` : ''}
                <div class="uris-pool-tile-name">${escapeHtml(r.name)}</div>
            </button>`;
        }).join('');
        grid.querySelectorAll('.uris-pool-tile').forEach(tile => {
            tile.addEventListener('click', () => {
                _editingRefId = tile.dataset.refId;
                _mobileScreen = 'card';
                _renderMobileAll(root);
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
    _bindMobileAddRef(host, root);
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
    const aliasesStr = (ref.aliases || []).join(', ');
    body.innerHTML = `
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
        <small class="uris-hint">Сопоставление с промптом идёт по алиасам — перечислите имена и прозвища через запятую. Имя — только подпись. Поддерживаются {{char}}/{{user}}.</small>
        <label class="uris-ed-label">Описание</label>
        <textarea class="text_pole uris-ed-desc" rows="3">${escapeHtml(ref.description || '')}</textarea>
        <label class="uris-ed-check"><input type="checkbox" class="uris-ed-binding-mode" ${ref.bindingMode === 'description' ? 'checked' : ''}> Только описание</label>
        <small class="uris-hint">Без картинки в генерацию попадёт только это описание.</small>
        <label class="uris-ed-label">Папки</label>
        <div class="uris-fp-host"></div>
        <div class="uris-ed-autosave" aria-live="polite">Автосохранение</div>
        <button class="uris-btn uris-btn-ghost uris-ed-del"><i class="fa-solid fa-trash"></i> Удалить</button>`;
    _bindEditorBody(root, body, ref, folders, { onFolderChange: () => _renderMobileCard(root) });
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
    // explicit "Save" button - flashSaved confirms each autosave instead.
    let saveFlashTimer;
    const flashSaved = () => {
        const ind = host.querySelector('.uris-ed-autosave');
        if (!ind) return;
        ind.textContent = '✓ Сохранено';
        ind.classList.add('uris-ed-autosave-on');
        clearTimeout(saveFlashTimer);
        saveFlashTimer = setTimeout(() => {
            if (ind.isConnected) { ind.classList.remove('uris-ed-autosave-on'); ind.textContent = 'Автосохранение'; }
        }, 1400);
    };
    const saveBasic = async () => {
        await updateRef(ref.id, {
            name: nameInput.value,
            aliases: aliasesInput.value,
            description: descInput.value,
            bindingMode: bindingModeInput?.checked ? 'description' : 'image',
        });
        flashSaved();
    };
    nameInput.addEventListener('change', saveBasic);
    aliasesInput.addEventListener('change', saveBasic);
    descInput.addEventListener('change', saveBasic);

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
        try {
            const crop = await openCropDialog({ source: ref.imagePath });
            if (!crop) return;
            const optimized = await ingestReferenceImage(crop.blob, `ref_${ref.id}`);
            try {
                await updateRef(ref.id, { imagePath: optimized.imagePath, ...optimized.metadata });
            } catch (mutationError) {
                throw new Error(`${mutationError.message}; orphaned upload: ${optimized.imagePath}`);
            }
            const img = host.querySelector('.uris-editor-preview');
            if (img) img.src = optimized.imagePath + '?t=' + Date.now();
            flashSaved();
        } catch (err) {
            recordUrisError({ scope: 'Референсы', message: 'Не удалось обрезать: ' + (err?.message || err) });
            toastr?.error?.('Не удалось обрезать: ' + err.message);
        }
    });
    host.querySelector('.uris-ed-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            // Кроп опционален: «Без обрезки» грузит файл как есть, «Отмена»
            // вообще ничего не меняет.
            const crop = await openCropDialog({ source: file, allowSkip: true });
            if (!crop) return;
            const optimized = await ingestReferenceImage(crop.blob || file, `ref_${ref.id}`);
            try {
                await updateRef(ref.id, { imagePath: optimized.imagePath, ...optimized.metadata });
            } catch (mutationError) {
                throw new Error(`${mutationError.message}; orphaned upload: ${optimized.imagePath}`);
            }
            const img = host.querySelector('.uris-editor-preview');
            if (img) img.src = optimized.imagePath + '?t=' + Date.now();
        } catch (err) {
            recordUrisError({ scope: 'Референсы', message: 'Не удалось заменить: ' + (err?.message || err) });
            toastr?.error?.('Не удалось заменить: ' + err.message);
        }
        e.target.value = '';
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
        `<span class="uris-folder-chip ${activeFilter === folder ? 'uris-folder-chip-on' : ''}" data-folder="${folder}">${escapeHtml(label)}</span>`;
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
