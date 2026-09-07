// @ts-check
/**
 * Batch upload dialog for references.
 *
 * Multiple file select → review dialog (editable arbitrary names, per-item
 * status, «пронумеровать по базовему имени», «добавить ещё») → sequential
 * ingest through the existing pipeline (ingestReferenceImage → createRef).
 *
 * Why a dialog instead of the old per-file showInputModal flow: mobile
 * pickers (Android) and desktop alike benefit from one review pass; repeated
 * «Добавить ещё» accumulates selections — mitigation for Android pickers that
 * cap or truncate a single multi-select. Names are arbitrary and editable
 * per item; upload runs one file at a time so a failure isolates to its row.
 *
 * Uses the mobile-safe .uris-picker-overlay/.uris-picker-dialog chrome
 * (explicit top/left + width/height — see popup-mobile-repro.html context).
 */
import { escapeHtml } from '../core.js';
import { ingestReferenceImage } from '../references.js';
import { createRef } from '../refs-library.js';
import { lockBodyScroll, unlockBodyScroll } from './window.js';
import { recordUrisError } from '../error-pool.js';

// ── Pure helpers (tested directly) ────────────────────────────────────────────

/**
 * Default item name from a File: filename without extension, fallback when
 * the name is empty or extension-only.
 * @param {File} file
 * @param {number} index zero-based position in the batch
 * @returns {string}
 */
export function defaultNameFor(file, index) {
    const base = String(file?.name || '').replace(/\.[^.]+$/, '').trim();
    return base || `Референс ${index + 1}`;
}

/**
 * Map selected files to pending batch items.
 * @param {File[]|FileList|Iterable<File>} files
 * @returns {Array<{id:string,file:File,name:string,status:'pending',error:null,thumbUrl:string}>}
 */
export function buildBatchItems(files) {
    const stamp = Date.now();
    return [...files].map((file, i) => ({
        id: `b${i}_${stamp}`,
        file,
        name: defaultNameFor(file, i),
        status: 'pending',
        error: null,
        thumbUrl: '',
    }));
}

/**
 * Rename all still-pending items to `<base> 1..N`. Uploaded/failed rows keep
 * their names (they are already stored).
 * @param {Array<{name:string,status:string}>} items
 * @param {string} base
 * @returns {Array} the same array, mutated
 */
export function applyNumbering(items, base) {
    const clean = String(base || '').trim();
    if (!clean) return items;
    let n = 0;
    for (const item of items) {
        if (item.status !== 'pending') continue;
        n += 1;
        item.name = `${clean} ${n}`;
    }
    return items;
}

/**
 * Ensure names are non-empty and unique within the batch (case-insensitive):
 * duplicates get " (2)", " (3)" suffixes. Applied on submit.
 * @param {Array<{name:string}>} items
 * @returns {Array} the same array, mutated
 */
export function uniqueNames(items) {
    const seen = new Set();
    for (const item of items) {
        let name = String(item.name || '').trim() || 'Референс';
        if (seen.has(name.toLowerCase())) {
            let i = 2;
            while (seen.has(`${name} (${i})`.toLowerCase())) i += 1;
            name = `${name} (${i})`;
        }
        seen.add(name.toLowerCase());
        item.name = name;
    }
    return items;
}

// ── Dialog ────────────────────────────────────────────────────────────────────

const STATUS_ICON = { pending: '·', running: '⏳', ok: '✓', error: '✗' };

/**
 * Open the batch upload dialog.
 *
 * @param {Object} opts
 * @param {File[]|FileList} opts.files initially selected files
 * @param {string[]} [opts.folderIds] folders to attach to every created ref
 * @param {() => void} [opts.onFinish] called after the dialog closes
 * @param {Object} [opts.deps] test seam: { ingest, createRef, recordUrisError }
 * @returns {void}
 */
export function openBatchUploadDialog({ files, folderIds = [], onFinish, deps = {} } = {}) {
    const ingest = deps.ingest || ((file, id) => ingestReferenceImage(file, id));
    const doCreateRef = deps.createRef || createRef;
    const noteError = deps.recordUrisError || recordUrisError;

    const stale = document.querySelector('.uris-batch-overlay');
    if (stale?.parentNode) stale.parentNode.removeChild(stale);
    const items = uniqueNames(buildBatchItems(files || []));
    let running = false;

    const overlay = document.createElement('div');
    overlay.classList.add('uris-picker-overlay');
    overlay.classList.add('uris-batch-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
        <div class="uris-picker-dialog uris-batch-dialog">
            <h4>Загрузка референсов <span id="urisBatchCount">${items.length}</span></h4>
            <div class="uris-batch-renamer">
                <input class="text_pole" id="urisBatchBase" placeholder="Базовое имя для нумерации">
                <button type="button" id="urisBatchNumber" class="uris-btn uris-btn-ghost" title="Переименовать невыгруженные в «имя 1», «имя 2»…">Пронумеровать</button>
            </div>
            <div class="uris-batch-list" id="urisBatchList"></div>
            <div class="uris-picker-actions">
                <button type="button" id="urisBatchMore" class="uris-btn uris-btn-ghost">Добавить ещё</button>
                <button type="button" id="urisBatchCancel" class="uris-btn uris-btn-ghost">Отмена</button>
                <button type="button" id="urisBatchOk" class="uris-btn uris-btn-primary">Загрузить</button>
                <input type="file" id="urisBatchFile" accept="image/*" multiple hidden>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    lockBodyScroll();

    const list = overlay.querySelector('#urisBatchList');
    const countEl = overlay.querySelector('#urisBatchCount');
    const okBtn = overlay.querySelector('#urisBatchOk');
    const moreBtn = overlay.querySelector('#urisBatchMore');
    const cancelBtn = overlay.querySelector('#urisBatchCancel');
    const numberBtn = overlay.querySelector('#urisBatchNumber');
    const baseInput = overlay.querySelector('#urisBatchBase');
    const fileInput = overlay.querySelector('#urisBatchFile');

    const thumbFor = (item) => {
        if (item.thumbUrl) return item.thumbUrl;
        if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
            try { item.thumbUrl = URL.createObjectURL(item.file); } catch { /* превью необязательно */ }
        }
        return item.thumbUrl || '';
    };
    const releaseThumbs = () => {
        if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
        for (const item of items) {
            if (item.thumbUrl) { try { URL.revokeObjectURL(item.thumbUrl); } catch { /* already gone */ } }
        }
    };

    const pending = () => items.filter(item => item.status === 'pending');

    function renderList() {
        list.innerHTML = items.map((item, i) => `
            <div class="uris-batch-item uris-batch-${item.status}" data-id="${escapeHtml(item.id)}" title="${escapeHtml(item.error || item.file?.name || '')}">
                <img class="uris-batch-thumb" src="${escapeHtml(thumbFor(item))}" alt="" loading="lazy">
                <input class="text_pole uris-batch-name" value="${escapeHtml(item.name)}" ${item.status !== 'pending' ? 'disabled' : ''} aria-label="Имя референса">
                <span class="uris-batch-status" aria-hidden="true">${STATUS_ICON[item.status] || '·'}</span>
                ${item.status === 'pending' ? '<button type="button" class="uris-batch-del" title="Убрать из загрузки" aria-label="Убрать из загрузки">×</button>' : ''}
            </div>`).join('');
        countEl.textContent = String(items.length);
        okBtn.textContent = running ? 'Загрузка…' : `Загрузить (${pending().length})`;
        okBtn.disabled = running || !pending().length;
        moreBtn.disabled = running;
        cancelBtn.disabled = running;
        numberBtn.disabled = running;
        bindRows();
    }

    function bindRows() {
        list.querySelectorAll('.uris-batch-item').forEach(row => {
            const item = items.find(it => it.id === row.dataset.id);
            if (!item) return;
            const nameInput = row.querySelector('.uris-batch-name');
            if (nameInput && item.status === 'pending') {
                nameInput.addEventListener('input', () => { item.name = nameInput.value; });
            }
            row.querySelector('.uris-batch-del')?.addEventListener('click', () => {
                if (running) return;
                if (item.thumbUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
                    try { URL.revokeObjectURL(item.thumbUrl); } catch { /* already gone */ }
                }
                items.splice(items.indexOf(item), 1);
                renderList();
            });
        });
    }

    function close() {
        releaseThumbs();
        overlay.parentNode?.removeChild(overlay);
        unlockBodyScroll();
        onFinish?.();
    }

    async function upload() {
        running = true;
        uniqueNames(pending());
        renderList();
        let created = 0;
        let failed = 0;
        const stamp = Date.now();
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.status !== 'pending') continue;
            item.status = 'running';
            renderList();
            try {
                const uploaded = await ingest(item.file, `ref_${stamp}_${i}`);
                try {
                    await doCreateRef({ name: item.name, imagePath: uploaded.imagePath, ...uploaded.metadata, folders: folderIds });
                    item.status = 'ok';
                    item.error = null;
                    created += 1;
                } catch (mutationError) {
                    // картинка уже в хранилище, но карточка не создана — это видно в строке
                    item.status = 'error';
                    item.error = `Метаданные не сохранены. Загруженный файл: ${uploaded.imagePath}; ${mutationError?.message || mutationError}`;
                    failed += 1;
                    noteError({ scope: 'Референсы', message: `Массовая загрузка «${item.name}»: ${item.error}` });
                }
            } catch (err) {
                item.status = 'error';
                item.error = err?.message || String(err);
                failed += 1;
                noteError({ scope: 'Референсы', message: `Массовая загрузка «${item.name}»: ${item.error}` });
            }
            renderList();
        }
        running = false;
        renderList();
        if (typeof toastr !== 'undefined' && toastr) {
            if (failed === 0) toastr.success?.(`Загружено референсов: ${created}`);
            else if (created === 0) toastr.error?.(`Не загружено ни одного референса (${failed})`);
            else toastr.warning?.(`Загружено ${created}, с ошибками ${failed} — детали в строках и в ERR-панели`);
        }
        okBtn.textContent = 'Готово';
        okBtn.disabled = false;
        // После прогона кнопка становится «Готово» и закрывает диалог.
        okBtn.addEventListener('click', close, { once: true });
    }

    okBtn.addEventListener('click', () => {
        if (running || !pending().length) return undefined;
        return upload();
    });
    cancelBtn.addEventListener('click', () => { if (!running) close(); });
    numberBtn.addEventListener('click', () => {
        if (running) return;
        applyNumbering(items, baseInput.value);
        renderList();
    });
    moreBtn.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', e => {
        const chosen = [...(e.target.files || [])];
        e.target.value = '';
        if (!chosen.length) return;
        // uniqueNames мутирует только дубликаты, встреченные ПОЗЖЕ в списке:
        // уже загруженные строки идут раньше и сохраняют имена, суффиксы
        // получают только новые элементы.
        items.push(...buildBatchItems(chosen));
        uniqueNames(items);
        renderList();
    });

    renderList();
}
