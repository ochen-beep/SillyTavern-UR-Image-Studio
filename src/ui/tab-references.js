// @ts-check
/**
 * References tab: global pool of records with folders.
 * v4-redesign (Figma): folder sidebar left + 3:4 card grid +
 * overlay editor panel on the right. Multi-folder via folders[].
 */
import { state, getCtx, escapeHtml, debounce, showConfirmModal, showInputModal } from '../core.js';
import {
    listRefs, getRef, updateRef, deleteRef,
    listFolders, createFolder, updateFolder, deleteFolder, FOLDER_COLOR_PALETTE,
    filterRefsByFolder, refreshPoolCache, getRefSync,
    getFolderPrefs, saveFolderPrefs, persistPoolOrThrow, releaseRefImage, cloneRef,
    FOLDER_PREFS_MAX_PINNED,
    folderChildrenMap, folderChildFolders, folderHasChildren, filterRefsByFolderTree,
} from '../refs-library.js';

import { ingestReferenceImage } from '../references.js';
import { refsView, REFS_MOBILE_BREAK, REFS_SEARCH_DEBOUNCE_MS, refsForActiveFilter, filterRefsBySearch, poolTileHtml, bindPoolGridDelegation, selectPoolTile } from './refs-view-shared.js';
import { refEditorBodyHtml, bindEditorBody } from './ref-editor.js';
import { renderSidebar, openFolderMenu } from './refs-sidebar.js';
import { renderMobileAll, mobileFolderCollageHtml, __resetMobileNavForTests } from './refs-mobile.js';
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
let _cw = 600;
let _ro = null;

export function render(root) {
    root.classList.add('uris-body-flush');
    // _mobileScreen is NOT reset here: render() doubles as refreshActive(), and
    // an unconditional reset kicked mobile users from card/grid back to the
    // folder list on every background refresh (image replace, autosave). The
    // screen survives refreshes; the folder list is one tap away. Search
    // queries are still cleared — a stale filter after data reload misleads.
    refsView.mobileSearchQuery = '';
    refsView.folderSearchQuery = '';
    // A full tab re-entry must not inherit a stale editor session: close any
    // open reference/folder editor overlay so the grid renders clean.
    refsView.editingRefId = null;
    refsView.editingFolderId = null;
    root.innerHTML = `
        <div class="uris-references">
            <div class="uris-refs-sidebar" id="urisRefsSidebar"></div>
            <div class="uris-refs-sidebar-resizer" id="urisRefsSidebarResizer" title="Потянуть, чтобы изменить ширину"></div>
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
    if (_cw > 0 && _cw >= REFS_MOBILE_BREAK) _setupSidebarResizer(root);
    if (_cw <= 0) return;
    if (_cw < REFS_MOBILE_BREAK) return renderMobileAll(root);
    return _renderAll(root);
}

const SIDEBAR_W_MIN = 130;
const SIDEBAR_W_MAX = 400;

function _applySidebarWidth(root, width) {
    const sidebar = root.querySelector('#urisRefsSidebar');
    if (!sidebar) return;
    sidebar.style.flexBasis = width + 'px';
    sidebar.style.width = width + 'px';
}

/**
 * Drag handle on the folder sidebar edge: the stored folderPrefs.sidebarWidth
 * drives the flex-basis; the pointer drag updates it live and persists once
 * on release (device-local pref, like collapsed/sort).
 */
function _setupSidebarResizer(root) {
    const handle = root.querySelector('#urisRefsSidebarResizer');
    if (!handle) return;
    _applySidebarWidth(root, getFolderPrefs().sidebarWidth);
    handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        // A dedicated 6px strip: cancelling the pointerdown never hurts
        // scrolling and keeps a touch drag on the strip, not the page.
        e.preventDefault();
        const startX = e.clientX;
        const startW = root.querySelector('#urisRefsSidebar')?.getBoundingClientRect().width
            || getFolderPrefs().sidebarWidth;
        let last = startW;
        const move = (ev) => {
            last = Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, Math.round(startW + ev.clientX - startX)));
            if (last !== startW) ev.preventDefault?.();
            _applySidebarWidth(root, last);
        };
        const finish = () => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', finish);
            document.removeEventListener('pointercancel', finish);
            document.body.classList.remove('uris-dragging-active');
            if (last !== startW) saveFolderPrefs({ sidebarWidth: last });
        };
        document.body.classList.add('uris-dragging-active');
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', finish);
        document.addEventListener('pointercancel', finish);
    });
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
            renderMobileAll(root);
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
    renderSidebar(root, folders, refs, { rerender: (r) => _renderAll(r) });
    _renderToolbar(root, folders);
    _renderGrid(root, folders, refs);
    _renderOverlay(root, folders);
}

// ── Toolbar ──
// Крошки пути + «⋯» действий активной папки + поиск + «＋ Референс».
// «⋯» — тот же набор, что в меню строки (ПКМ/долгий тап); на виртуальных
// фильтрах (Все/Без папки) гаснет, но не прячется — место стабильно.
function _activeFolderChain(folders) {
    const chain = [{ id: 'all', label: 'Все карточки' }];
    if (refsView.activeFolderFilter === 'none') {
        chain.push({ id: 'none', label: 'Без папки' });
        return chain;
    }
    const active = folders.find(f => f.id === refsView.activeFolderFilter);
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
    const activeFolder = folders.find(f => f.id === refsView.activeFolderFilter);
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
        const folderIds = refsView.activeFolderFilter !== 'all' && refsView.activeFolderFilter !== 'none'
            ? [refsView.activeFolderFilter] : [];
        openBatchUploadDialog({ files, folderIds, onFinish: () => refreshActive() });
    });
    const runSearch = debounce((q) => { void _renderGrid(root, folders, null, q); }, REFS_SEARCH_DEBOUNCE_MS);
    host.querySelector('#urisRefsSearch')?.addEventListener('input', (e) => runSearch(e.target.value));
    host.querySelectorAll('.uris-crumb').forEach(btn => {
        btn.addEventListener('click', async () => {
            refsView.activeFolderFilter = btn.dataset.folder;
            await _renderAll(root);
        });
    });
    host.querySelector('#urisRefsFolderMenu')?.addEventListener('click', (e) => {
        if (!activeFolder) return;
        const rect = typeof e.currentTarget?.getBoundingClientRect === 'function'
            ? e.currentTarget.getBoundingClientRect() : null;
        void openFolderMenu({
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
async function _renderGrid(root, folders, refsOverride, searchQuery = '') {
    const host = root.querySelector('#urisRefsGrid');
    if (!host) return;
    const refs = refsOverride ?? await listRefs();
    const filtered = refsForActiveFilter(refs, folders);
    const searched = filterRefsBySearch(filtered, searchQuery);
    refsView.gridRefs = searched;
    refsView.gridFolders = folders;
    bindPoolGridDelegation(host, {
        onOpen: (refId) => {
            refsView.editingRefId = refId;
            selectPoolTile(host, refId);
            void _renderOverlay(root, refsView.gridFolders);
        },
        menuItems: (ref) => [
            { id: 'open', icon: 'fa-eye', label: 'Открыть',
                onSelect: () => {
                    refsView.editingRefId = ref.id;
                    selectPoolTile(host, ref.id);
                    void _renderOverlay(root, refsView.gridFolders);
                } },
            { id: 'crop', icon: 'fa-crop-simple', label: 'Обрезать',
                onSelect: () => { void _cropRefAction(ref.id, root); } },
            { id: 'clone', icon: 'fa-clone', label: 'Клонировать',
                onSelect: () => { void _cloneRefAction(ref.id, root); } },
            { id: 'folders', icon: 'fa-folder', label: 'Папки…',
                onSelect: () => { void _assignRefFolders(ref.id, root); } },
            { id: 'del', icon: 'fa-trash', label: 'Удалить…', danger: true,
                onSelect: () => { void _deleteRefAction(ref.id, root); } },
        ],
    });
    if (!searched.length) {
        host.innerHTML = `<div class="uris-refs-empty">${searchQuery ? 'Не найдено' : 'Пусто. Добавьте референс кнопкой «+».'}</div>`;
        return;
    }
    const foldersById = new Map(folders.map(f => [f.id, f]));
    performance.mark('uris:refs-grid');
    host.innerHTML = searched.map(r =>
        poolTileHtml(r, foldersById, { selected: refsView.editingRefId === r.id })
    ).join('');
    performance.measure('uris:refs-grid', 'uris:refs-grid');
}

// ── Shared ref actions (grid context menu + mobile) ──
// The overlay editor binds its own variants with in-place preview updates;
// these standalone versions operate on the pool record and refresh the grid.

/** Crop the ref's current image into a new pool file (grid-level flow). */
async function _cropRefAction(refId, root) {
    const ref = await getRef(refId);
    if (!ref?.imagePath) return;
    const oldImage = ref.imagePath;
    try {
        const crop = await openCropDialog({ source: ref.imagePath });
        if (!crop) return;
        const optimized = await ingestReferenceImage(crop.blob, `ref_${ref.id}_${Date.now()}`);
        try {
            await updateRef(ref.id, { imagePath: optimized.imagePath, ...optimized.metadata });
            await persistPoolOrThrow('обрезать');
        } catch (mutationError) {
            throw new Error(`${mutationError.message}; orphaned upload: ${optimized.imagePath}`);
        }
        releaseRefImage(oldImage);
        refreshActive();
    } catch (err) {
        reportFailure({ scope: URIS_SCOPES.refs, message: 'Не удалось обрезать: ' + (err?.message || err), toast: true, toastText: 'Не удалось обрезать: ' + err.message });
    }
}

async function _cloneRefAction(refId, root) {
    try {
        const ref = await getRef(refId);
        if (!ref) return;
        const clone = await cloneRef(ref);
        toastr?.success('Клонирован: ' + clone.name);
        refsView.editingRefId = clone.id;
        refreshActive();
        void root;
    } catch (err) {
        reportFailure({ scope: URIS_SCOPES.refs, message: 'Клонирование: ' + (err?.message || err), toast: true, toastText: 'Не удалось клонировать: ' + err.message });
    }
}

async function _assignRefFolders(refId, root) {
    const ref = await getRef(refId);
    if (!ref) return;
    const folders = await listFolders();
    const selected = new Set(ref.folders || []);
    openFolderSheet({
        title: 'Папки референса',
        folders,
        selectedIds: ref.folders || [],
        onToggle: async (folder, isOn) => {
            if (isOn) selected.add(folder.id); else selected.delete(folder.id);
            await updateRef(ref.id, { folders: [...selected] });
        },
        onDone: () => refreshActive(),
        onCancel: () => refreshActive(),
    });
    void root;
}

async function _deleteRefAction(refId, root) {
    if (!await showConfirmModal('Удалить референс из пула?')) return;
    await deleteRef(refId);
    if (refsView.editingRefId === refId) refsView.editingRefId = null;
    _mobileScreen = 'grid';
    refreshActive();
    void root;
}

// ── Overlay panel ──
// Epoch guard: tile clicks fire _renderOverlay unawaited; two rapid clicks race
// two getRef() calls and the slower one used to win, showing reference A while
// refsView.editingRefId was already B (subsequent autosaves targeted the shown record).
let _overlayEpoch = 0;
async function _renderOverlay(root, folders) {
    const epoch = ++_overlayEpoch;
    const requestedId = refsView.editingRefId;
    const host = root.querySelector('#urisRefsOverlay');
    if (!host) return;
    if (!refsView.editingRefId) { host.innerHTML = ''; host.classList.remove('uris-refs-overlay-open'); host.removeAttribute('role'); host.removeAttribute('aria-modal'); host.removeAttribute('aria-label'); return; }
    const ref = await getRef(refsView.editingRefId);
    if (epoch !== _overlayEpoch || refsView.editingRefId !== requestedId) return;
    if (!ref) { refsView.editingRefId = null; host.innerHTML = ''; host.removeAttribute('role'); host.removeAttribute('aria-modal'); host.removeAttribute('aria-label'); return; }
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
    // (шит поля мог создать новую), оверлей под новым refsView.editingRefId, сайдбар с
    // свежими счётчиками и сетка с новой карточкой.
    const refreshAround = async () => {
        const freshFolders = await listFolders();
        await _renderOverlay(root, freshFolders);
        renderSidebar(root, freshFolders, await listRefs(), { rerender: (r) => _renderAll(r) });
        _renderGrid(root, freshFolders);
    };
    bindEditorBody(root, host.querySelector('.uris-refs-overlay-body'), ref, folders, {
        onFolderChange: refreshAround,
        onCloned: refreshAround,
    });
    host.querySelector('.uris-refs-overlay-close')?.addEventListener('click', async () => {
        refsView.editingRefId = null;
        await _renderAll(root);
    });
}

// Public API re-exports (tests and tab-generate-refs import from here).
export { showPoolPicker } from './refs-pool-picker.js';
export { mobileFolderCollageHtml, __resetMobileNavForTests } from './refs-mobile.js';
