// @ts-check
/**
 * Pool picker overlay (multi/single) used by the Generate tab to pick
 * reference cards from the pool (hygiene split 2026-10-25). Exported through
 * tab-references.js for its historical consumers.
 */
import { escapeHtml } from '../core.js';
import { listRefs, listFolders, filterRefsByFolder, getFolderPrefs } from '../refs-library.js';
import { openFolderSheet } from './folder-picker.js';
import { lockBodyScroll, unlockBodyScroll } from './window.js';

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
                    <img src="${escapeHtml(r.thumbPath || r.imagePath)}" alt="${escapeHtml(r.name)}" loading="lazy">
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
