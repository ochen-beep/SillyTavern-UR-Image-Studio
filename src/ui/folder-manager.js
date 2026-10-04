// @ts-check
/**
 * Folder manager: single surface for maintaining a LARGE folder list (50+),
 * where the per-row pencil in the sidebar does not scale.
 *
 * One dialog (.uris-picker-overlay chrome → bottom-sheet on mobile) with:
 *  - search;
 *  - per-row: recolor (click cycles the palette), rename (autosave on change),
 *    reference count, merge into another folder (transfers refs + deletes
 *    the source), delete;
 *  - bulk: checkboxes + «merge into…» / delete.
 *
 * Destructive ops go through showConfirmModal; merge reuses refs-library
 * mergeFolders (refs keep their records, only folders[] ids are rewritten).
 */
import { escapeHtml, showConfirmModal } from '../core.js';
import {
    listFolders, listRefs, updateFolder, deleteFolder, mergeFolders,
    FOLDER_COLOR_PALETTE, filterRefsByFolder,
} from '../refs-library.js';
import { filterFolders } from './folder-picker.js';
import { lockBodyScroll, unlockBodyScroll } from './window.js';

/**
 * Open the manager dialog.
 * @param {{ onChanged?: () => void }} [opts] onChanged — called after every
 *   mutation so the underlying tab re-renders its sidebar counts.
 * @returns {{ close: () => void }}
 */
export function showFolderManager({ onChanged } = {}) {
    let folders = [];
    let refs = [];
    const selected = new Set();
    let query = '';

    const overlay = document.createElement('div');
    overlay.className = 'uris-picker-overlay uris-folder-mgr';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Управление папками');
    overlay.innerHTML = `
        <div class="uris-picker-dialog uris-folder-mgr-dialog">
            <h4>Управление папками</h4>
            <div class="uris-fm-search">
                <input type="text" class="text_pole uris-fm-query" placeholder="Поиск папок…"
                    aria-label="Поиск папок" autocomplete="off">
            </div>
            <div class="uris-fm-bulkbar" hidden>
                <span class="uris-fm-bulk-count" aria-live="polite">0</span>
                <select class="text_pole uris-fm-bulk-target" aria-label="Слить выбранные в папку"></select>
                <button type="button" class="uris-btn uris-btn-ghost uris-fm-bulk-del">Удалить</button>
            </div>
            <div class="uris-fm-list"></div>
            <div class="uris-picker-actions">
                <button type="button" class="uris-btn uris-btn-primary uris-fm-done">Готово</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    lockBodyScroll();

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
            settle();
        }
    };
    document.addEventListener('keydown', onKey, true);
    closed.then(() => cleanup());
    overlay.querySelector('.uris-fm-done')?.addEventListener('click', () => settle());

    const listEl = overlay.querySelector('.uris-fm-list');
    const bulkbar = overlay.querySelector('.uris-fm-bulkbar');
    const bulkCount = overlay.querySelector('.uris-fm-bulk-count');
    const bulkTarget = overlay.querySelector('.uris-fm-bulk-target');
    const bulkDel = overlay.querySelector('.uris-fm-bulk-del');
    const queryEl = overlay.querySelector('.uris-fm-query');

    const countOf = (id) => filterRefsByFolder(refs, id).length;
    const visibleFolders = () => filterFolders(folders, query);
    const nextColor = (color) => {
        const index = FOLDER_COLOR_PALETTE.indexOf(color);
        return FOLDER_COLOR_PALETTE[(index + 1) % FOLDER_COLOR_PALETTE.length];
    };

    async function mutate(fn) {
        await fn();
        [folders, refs] = await Promise.all([listFolders(), listRefs()]);
        renderRows();
        onChanged?.();
    }

    function renderBulkbar() {
        if (!bulkbar) return;
        bulkbar.hidden = selected.size === 0;
        if (bulkCount) bulkCount.textContent = `Выбрано: ${selected.size}`;
        if (bulkTarget) {
            const current = bulkTarget.value;
            const options = folders
                .filter(folder => !selected.has(folder.id))
                .map(folder => `<option value="${escapeHtml(folder.id)}">${escapeHtml(folder.name)}</option>`)
                .join('');
            bulkTarget.innerHTML = `<option value="" disabled selected>Слить в…</option>${options}`;
            bulkTarget.value = current && !selected.has(current) ? current : '';
        }
        if (bulkDel) bulkDel.disabled = selected.size === 0;
    }

    function renderRows() {
        const rows = visibleFolders();
        const byId = new Map(folders.map(folder => [folder.id, folder]));
        const parentLabel = (folder) => {
            if (!folder.parentId) return '';
            const parent = byId.get(folder.parentId);
            return parent ? `· ${parent.name}` : '';
        };
        if (!rows.length) {
            listEl.innerHTML = `<div class="uris-fs-empty">${query ? 'Ничего не найдено' : 'Папок пока нет'}</div>`;
        } else {
            listEl.innerHTML = rows.map(folder => `
                <div class="uris-fm-row" data-id="${escapeHtml(folder.id)}">
                    <input type="checkbox" class="uris-fm-check" data-id="${escapeHtml(folder.id)}"
                        ${selected.has(folder.id) ? 'checked' : ''} aria-label="Выбрать папку ${escapeHtml(folder.name)}">
                    <button type="button" class="uris-fm-swatch" data-id="${escapeHtml(folder.id)}"
                        style="background:${escapeHtml(folder.color)}" title="Сменить цвет"
                        aria-label="Сменить цвет папки ${escapeHtml(folder.name)}"></button>
                    <input type="text" class="text_pole uris-fm-name" data-id="${escapeHtml(folder.id)}"
                        value="${escapeHtml(folder.name)}" aria-label="Имя папки">
                    <span class="uris-fm-parent" title="Группа">${escapeHtml(parentLabel(folder))}</span>
                    <span class="uris-fm-count" title="Референсов в папке (без подпапок)">${countOf(folder.id)}</span>
                    <select class="text_pole uris-fm-merge" data-id="${escapeHtml(folder.id)}"
                        aria-label="Перенести содержимое в другую папку">
                        <option value="" disabled selected>→ в…</option>
                        ${folders.filter(other => other.id !== folder.id)
                            .map(other => `<option value="${escapeHtml(other.id)}">${escapeHtml(other.name)}</option>`)
                            .join('')}
                    </select>
                    <button type="button" class="uris-fm-del" data-id="${escapeHtml(folder.id)}"
                        title="Удалить папку" aria-label="Удалить папку ${escapeHtml(folder.name)}">×</button>
                </div>`).join('');
        }
        renderBulkbar();

        listEl.querySelectorAll('.uris-fm-check').forEach(input => {
            input.addEventListener('change', () => {
                if (input.checked) selected.add(input.dataset.id); else selected.delete(input.dataset.id);
                renderBulkbar();
            });
        });
        listEl.querySelectorAll('.uris-fm-swatch').forEach(btn => {
            btn.addEventListener('click', () => {
                const folder = folders.find(item => item.id === btn.dataset.id);
                if (folder) return mutate(() => updateFolder(folder.id, { color: nextColor(folder.color) }));
            });
        });
        listEl.querySelectorAll('.uris-fm-name').forEach(input => {
            input.addEventListener('change', () => mutate(() => updateFolder(input.dataset.id, { name: input.value })));
        });
        listEl.querySelectorAll('.uris-fm-merge').forEach(selectEl => {
            selectEl.addEventListener('change', async () => {
                const sourceId = selectEl.dataset.id;
                const targetId = selectEl.value;
                selectEl.value = '';
                if (!targetId) return;
                const source = folders.find(item => item.id === sourceId);
                const target = folders.find(item => item.id === targetId);
                if (!source || !target) return;
                const moved = countOf(sourceId);
                if (!await showConfirmModal(
                    `Перенести референсы из «${source.name}» в «${target.name}» и удалить «${source.name}»?` +
                    (moved ? `\n\nРеференсов к переносу: ${moved}.` : '\n\nПапка пуста — просто удалится.')
                )) return;
                await mutate(() => mergeFolders(sourceId, targetId));
            });
        });
        listEl.querySelectorAll('.uris-fm-del').forEach(btn => {
            btn.addEventListener('click', async () => {
                const folder = folders.find(item => item.id === btn.dataset.id);
                if (!folder) return;
                const hasKids = folders.some(item => item.parentId === folder.id);
                if (!await showConfirmModal(
                    `Удалить папку «${folder.name}»?` +
                    (hasKids ? '\n\nПодпапки поднимутся на верхний уровень.' : '') +
                    (countOf(folder.id) ? '\n\nРеференсы останутся, но выпадут из этой папки.' : '')
                )) return;
                selected.delete(folder.id);
                await mutate(() => deleteFolder(folder.id));
            });
        });
    }

    const bindBulk = () => {
        bulkTarget?.addEventListener('change', async () => {
            const targetId = bulkTarget.value;
            if (!targetId || !selected.size) return;
            const target = folders.find(item => item.id === targetId);
            if (!target) return;
            const sources = [...selected].filter(id => id !== targetId);
            if (!sources.length) { bulkTarget.value = ''; return; }
            const names = sources.map(id => folders.find(item => item.id === id)?.name || '?');
            if (!await showConfirmModal(
                `Перенести референсы из выбранных папок (${sources.length}) в «${target.name}» и удалить эти папки?\n\n${names.join(', ')}`
            )) { bulkTarget.value = ''; return; }
            await mutate(() => Promise.all(sources.map(sourceId => mergeFolders(sourceId, targetId))));
            selected.clear();
            renderBulkbar();
        });
        bulkDel?.addEventListener('click', async () => {
            if (!selected.size) return;
            const names = [...selected].map(id => folders.find(item => item.id === id)?.name || '?');
            const anyKids = folders.some(item => selected.has(item.id) && folders.some(other => other.parentId === item.id));
            if (!await showConfirmModal(
                `Удалить папки (${selected.size}): ${names.join(', ')}?` +
                (anyKids ? '\n\nПодпапки удалённых групп поднимутся на верхний уровень.' : '') +
                '\n\nРеференсы останутся, но выпадут из этих папок.'
            )) return;
            const ids = [...selected];
            selected.clear();
            await mutate(() => Promise.all(ids.map(id => deleteFolder(id))));
        });
    };

    queryEl?.addEventListener('input', (e) => {
        query = e.target.value || '';
        renderRows();
    });

    void (async () => {
        [folders, refs] = await Promise.all([listFolders(), listRefs()]);
        renderRows();
        bindBulk();
    })();

    return { close: () => settle() };
}
