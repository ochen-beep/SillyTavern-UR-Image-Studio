// @ts-check
/**
 * State and pure helpers shared across the references-tab modules (hygiene
 * split 2026-10-25: main grid, sidebar, mobile stack, editor). Lives below
 * every view module in the import DAG so nothing cycles.
 *
 * Cross-module mutable state is ONE object on purpose: ESM live bindings are
 * read-only for importers, so scattered `let` exports would need setter
 * boilerplate; a shared object every module mutates is the short version.
 */
import { escapeHtml } from '../core.js';
import { filterRefsByFolder, filterRefsByFolderTree } from '../refs-library.js';

/** View state shared by main grid / sidebar / mobile / editor. */
export const refsView = {
    activeFolderFilter: 'all',
    editingRefId: null,
    editingFolderId: null,
    // Snapshot of the last rendered grid list/folders — the delegated tile
    // handlers outlive any single render and resolve tiles through it.
    gridRefs: [],
    gridFolders: [],
};

/** Mobile stack breakpoint, measured against the tab container width. */
export const REFS_MOBILE_BREAK = 480;
// Search re-renders the grid debounced: every keystroke used to wipe the
// grid's innerHTML (restarting loads for all visible tiles) — the main
// typing-lag source on pools of hundreds of refs.
export const REFS_SEARCH_DEBOUNCE_MS = 150;

/** Resolve the pool refs visible under the active folder filter. */
export function refsForActiveFilter(refs, folders) {
    if (refsView.activeFolderFilter === 'all' || refsView.activeFolderFilter === 'none') {
        return filterRefsByFolder(refs, refsView.activeFolderFilter);
    }
    return filterRefsByFolderTree(refs, folders, refsView.activeFolderFilter);
}

/** Filter refs by search substring over name and aliases. */
export function filterRefsBySearch(refs, query) {
    const q = (query || '').toLowerCase().trim();
    if (!q) return refs;
    return refs.filter(r => (r.name || '').toLowerCase().includes(q)
        || (r.aliases || []).some(a => a.toLowerCase().includes(q)));
}

/**
 * Pool tile markup shared by the desktop grid and the mobile grid. The mobile
 * variant caps folder dots at 3 (narrower tiles).
 */
export function poolTileHtml(ref, foldersById, { maxDots = 4, selected = false } = {}) {
    const dots = (ref.folders || []).map(fid => foldersById.get(fid)).filter(Boolean)
        .slice(0, maxDots).map(f => `<span class="uris-pool-tile-dot" style="background:${escapeHtml(f.color)}"></span>`).join('');
    const selectedClass = selected ? ' uris-pool-tile-selected' : '';
    // Native width/height from the record metadata (ingest saves them): the
    // browser reserves the box before load — no CLS, no scrollbar jumps.
    const dims = Number(ref?.width) > 0 && Number(ref?.height) > 0
        ? ` width="${Number(ref.width)}" height="${Number(ref.height)}"` : '';
    return `<button type="button" class="uris-pool-tile${selectedClass}" data-ref-id="${escapeHtml(ref.id)}" aria-label="${escapeHtml(ref.name)}" title="${escapeHtml(ref.name)}">
        <img src="${escapeHtml(ref.imagePath)}" alt="${escapeHtml(ref.name)}" loading="lazy" decoding="async"${dims}>
        ${dots ? `<div class="uris-pool-tile-dots">${dots}</div>` : ''}
        <div class="uris-pool-tile-name">${escapeHtml(ref.name)}</div>
    </button>`;
}
