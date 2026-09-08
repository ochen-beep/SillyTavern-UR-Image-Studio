// @ts-check
/**
 * Folder picker: shared surfaces for working with MANY folders (50+).
 *
 * Two composable pieces, both on the mobile-safe .uris-picker-overlay chrome
 * (bottom-sheet on mobile — see the .uris-picker-overlay comment in style.css):
 *
 *  - openFolderSheet(): searchable folder list in a dialog. mode 'multi'
 *    toggles selection with immediate apply (editor autosave semantics) and
 *    create-on-type («Создать „запрос"» when nothing matches); mode 'pick-one'
 *    closes on the first pick (filter selection).
 *
 *  - createFolderField(): the compact field for the reference editor —
 *    selected folders as removable chips + «+ Папка» button opening the sheet.
 *    Replaces the old wall of .uris-multifolder toggles, which did not scale
 *    past a dozen folders.
 *
 * Pure helpers are exported for Node tests; DOM parts run under the fake DOM.
 */
import { escapeHtml } from '../core.js';
import { lockBodyScroll, unlockBodyScroll } from './window.js';

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function normalizeFolderQuery(query) {
    return String(query || '').trim().toLowerCase();
}

/** Case-insensitive substring filter over folder names, order-preserving. */
export function filterFolders(folders, query) {
    const q = normalizeFolderQuery(query);
    if (!q) return (Array.isArray(folders) ? folders : []).slice();
    return folders.filter(folder => String(folder?.name || '').toLowerCase().includes(q));
}

/**
 * Sheet rows for a query: selected folders first (both groups keep the
 * incoming order), plus whether the «Создать „запрос"» row should show.
 * The create row appears only for a non-empty query without an exact
 * (case-insensitive) name match.
 */
export function folderSheetRows(folders, query, selectedIds = []) {
    const list = Array.isArray(folders) ? folders : [];
    const selected = new Set((Array.isArray(selectedIds) ? selectedIds : []).map(String));
    const matches = filterFolders(list, query);
    const chosen = matches.filter(folder => selected.has(folder.id));
    const rest = matches.filter(folder => !selected.has(folder.id));
    const q = normalizeFolderQuery(query);
    const exactMatch = q ? matches.some(folder => String(folder?.name || '').trim().toLowerCase() === q) : true;
    return { chosen, rest, canCreate: Boolean(q) && !exactMatch };
}

/**
 * Sidebar order: pinned folders first (in prefs order), then the rest in the
 * requested sort mode ('manual' keeps creation order; 'name' — locale-aware;
 * 'count' — descending by reference count). Pure: returns a new array.
 */
export function orderSidebarFolders(folders, { pinnedIds = [], sort = 'manual', countById = new Map() } = {}) {
    const list = (Array.isArray(folders) ? folders : []).slice();
    if (sort === 'name') {
        list.sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' }));
    } else if (sort === 'count') {
        list.sort((a, b) => (countById.get(b?.id) || 0) - (countById.get(a?.id) || 0));
    }
    const pinned = (Array.isArray(pinnedIds) ? pinnedIds : [])
        .map(id => list.find(folder => folder?.id === id))
        .filter(Boolean);
    const rest = list.filter(folder => !pinned.includes(folder));
    return [...pinned, ...rest];
}

/** Cycle to the next sort mode; used by the sidebar sort button. */
export function nextFolderSortMode(sort) {
    const modes = ['manual', 'name', 'count'];
    const index = Math.max(modes.indexOf(sort), 0);
    return modes[(index + 1) % modes.length];
}

// ── Sheet (searchable folder dialog) ─────────────────────────────────────────

/**
 * Open the folder sheet.
 *
 * @param {Object} opts
 * @param {Array<{id:string,name:string,color:string}>} opts.folders
 * @param {string} [opts.title]
 * @param {'multi'|'pick-one'} [opts.mode] multi: toggling calls onToggle and
 *   keeps the sheet open until «Готово»/Esc; pick-one: first click resolves.
 * @param {string[]} [opts.selectedIds] pre-checked folders (multi mode)
 * @param {(folder: Object, isSelected: boolean) => void} [opts.onToggle]
 * @param {(folder: Object) => void} [opts.onPick] pick-one mode
 * @param {(name: string) => Promise<Object>} [opts.onCreate] create-on-type
 *   (multi mode); must persist the folder and return its record.
 * @returns {{ close: () => void, overlay: HTMLElement }}
 */
export function openFolderSheet({ folders = [], title = 'Папки', mode = 'multi', selectedIds = [], onToggle, onPick, onCreate } = {}) {
    const items = (Array.isArray(folders) ? folders : []).slice();
    const selected = new Set((selectedIds || []).map(String));
    let query = '';

    const overlay = document.createElement('div');
    overlay.className = 'uris-picker-overlay uris-folder-sheet';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    overlay.innerHTML = `
        <div class="uris-picker-dialog uris-folder-sheet-dialog">
            <h4>${escapeHtml(title)}</h4>
            <div class="uris-folder-sheet-search">
                <input type="text" class="text_pole uris-folder-sheet-query" placeholder="Поиск папок…"
                    aria-label="Поиск папок" autocomplete="off">
            </div>
            <div class="uris-folder-sheet-list"></div>
            <div class="uris-picker-actions">
                ${mode === 'multi'
                    ? '<button type="button" class="uris-btn uris-btn-primary uris-folder-sheet-done">Готово</button>'
                    : '<button type="button" class="uris-btn uris-btn-ghost uris-folder-sheet-cancel">Отмена</button>'}
            </div>
        </div>`;
    document.body.appendChild(overlay);
    lockBodyScroll();

    const listEl = overlay.querySelector('.uris-folder-sheet-list');
    const queryEl = overlay.querySelector('.uris-folder-sheet-query');

    let settle;
    const closed = new Promise(resolve => { settle = resolve; });

    const cleanup = () => {
        document.removeEventListener('keydown', onKey, true);
        overlay.parentNode?.removeChild(overlay);
        unlockBodyScroll();
    };
    const onKey = (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            settle(null);
        }
    };
    document.addEventListener('keydown', onKey, true);

    function renderRows() {
        const { chosen, rest, canCreate } = folderSheetRows(items, query, [...selected]);
        const row = (folder, isOn) => `
            <button type="button" class="uris-fs-row ${isOn ? 'uris-fs-row-on' : ''}" data-folder-id="${escapeHtml(folder.id)}">
                <span class="uris-folder-dot" style="background:${escapeHtml(folder.color || '#808080')}"></span>
                <span class="uris-fs-name">${escapeHtml(folder.name)}</span>
                ${isOn ? '<span class="uris-fs-check">✓</span>' : ''}
            </button>`;
        const rows = [
            ...chosen.map(folder => row(folder, true)),
            ...rest.map(folder => row(folder, false)),
        ];
        if (mode === 'multi' && onCreate && canCreate) {
            rows.push(`<button type="button" class="uris-fs-row uris-fs-create" data-create="1">
                <span class="uris-fs-name">Создать «${escapeHtml(query.trim())}»</span>
            </button>`);
        }
        listEl.innerHTML = rows.length
            ? rows.join('')
            : '<div class="uris-fs-empty">Ничего не найдено</div>';

        // Class-only селекторы + ручной фильтр: querySelector-хелпер тестового
        // fake-dom понимает только простые селекторы.
        listEl.querySelectorAll('.uris-fs-row').forEach(rowEl => {
            if (!rowEl.dataset.folderId) return; // строка создания
            rowEl.addEventListener('click', async () => {
                const folder = items.find(item => item.id === rowEl.dataset.folderId);
                if (!folder) return;
                if (mode === 'pick-one') {
                    onPick?.(folder);
                    settle(folder);
                    return;
                }
                const isOn = !selected.has(folder.id);
                if (isOn) selected.add(folder.id); else selected.delete(folder.id);
                renderRows();
                onToggle?.(folder, isOn);
            });
        });
        listEl.querySelector('.uris-fs-create')?.addEventListener('click', async () => {
            const name = query.trim();
            if (!name || !onCreate) return;
            try {
                const folder = await onCreate(name);
                if (!folder?.id) return;
                items.push(folder);
                selected.add(folder.id);
                renderRows();
                onToggle?.(folder, true);
            } catch { /* create failure leaves the sheet open for a retry */ }
        });
    }

    queryEl?.addEventListener('input', (e) => {
        query = e.target.value || '';
        renderRows();
    });
    overlay.querySelector('.uris-folder-sheet-done')?.addEventListener('click', () => settle(null));
    overlay.querySelector('.uris-folder-sheet-cancel')?.addEventListener('click', () => settle(null));
    closed.then(() => cleanup());

    renderRows();
    return { overlay, close: () => settle(null), result: closed };
}

// ── Field (chips + «+ Папка» for the editor) ─────────────────────────────────

/**
 * Compact multi-select folder field: chips of selected folders (× removes),
 * «+ Папка» opens the sheet. Selection changes call `onChange(fullIdArray)`
 * immediately — the editor persists per change, like its other fields.
 *
 * @param {Object} opts
 * @param {Array<{id:string,name:string,color:string}>} opts.folders
 * @param {string[]} [opts.selected] selected folder ids
 * @param {(ids: string[]) => void|Promise<void>} opts.onChange
 * @param {(name: string) => Promise<Object>} [opts.onCreate]
 * @returns {{ el: HTMLElement, setFolders: (list: Object[]) => void, sync: (ids: string[]) => void }}
 */
export function createFolderField({ folders = [], selected = [], onChange, onCreate } = {}) {
    const state = {
        folders: (Array.isArray(folders) ? folders : []).slice(),
        selected: new Set((selected || []).map(String)),
    };
    const el = document.createElement('div');
    el.className = 'uris-fp';

    // commit отдаёт id в порядке списка папок (не Set-порядка): updateRef
    // получает предсказуемый массив, порядок иконок-точек стабилен.
    const commit = () => {
        void onChange?.(state.folders.map(folder => folder.id).filter(id => state.selected.has(id)));
    };

    function renderChips() {
        const chips = state.selected.size
            ? [...state.selected].map(id => {
                const folder = state.folders.find(item => item.id === id);
                if (!folder) return '';
                return `<span class="uris-fp-chip" data-folder-id="${escapeHtml(folder.id)}">
                    <span class="uris-folder-dot" style="background:${escapeHtml(folder.color || '#808080')}"></span>
                    <span class="uris-fp-chip-name">${escapeHtml(folder.name)}</span>
                    <button type="button" class="uris-fp-chip-x" data-folder-id="${escapeHtml(folder.id)}"
                        title="Убрать" aria-label="Убрать папку ${escapeHtml(folder.name)}">×</button>
                </span>`;
            }).join('')
            : '';
        el.innerHTML = `<div class="uris-fp-chips">${chips}
            <button type="button" class="uris-fp-add" title="Добавить папки" aria-label="Добавить папки">
                <i class="fa-solid fa-plus"></i> Папка
            </button>
        </div>`;
        el.querySelectorAll('.uris-fp-chip-x').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                state.selected.delete(btn.dataset.folderId);
                renderChips();
                commit();
            });
        });
        el.querySelector('.uris-fp-add')?.addEventListener('click', () => {
            openFolderSheet({
                title: 'Папки референса',
                folders: state.folders,
                selectedIds: [...state.selected],
                onCreate: onCreate ? async (name) => {
                    const folder = await onCreate(name);
                    if (folder?.id) state.folders = [...state.folders, folder];
                    return folder;
                } : undefined,
                onToggle: (folder, isOn) => {
                    if (isOn) state.selected.add(folder.id); else state.selected.delete(folder.id);
                    renderChips();
                    commit();
                },
            });
        });
    }

    renderChips();
    return {
        el,
        setFolders(list) { state.folders = (Array.isArray(list) ? list : []).slice(); renderChips(); },
        sync(ids) {
            state.selected = new Set((Array.isArray(ids) ? ids : []).map(String));
            renderChips();
        },
    };
}
