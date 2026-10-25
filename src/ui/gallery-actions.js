// @ts-check
/**
 * Shared action handlers for gallery cards, consumed by both the grid
 * (tab-gallery.js) and the lightbox (lightbox.js). Extracted from tab-gallery.js
 * to avoid duplication and keep a single source of truth.
 */
import { getCtx, showConfirmModal, showInputModal, log, saveSettings, abortGeneration, escapeHtml, uid } from '../core.js';
import { lockBodyScroll, unlockBodyScroll } from './window.js';
import { addToGallery, deleteGalleryCard } from '../storage.js';
import { updateCard } from '../gallery-index.js';
import { makeThumbnailForPath, uploadGeneratedImage, getCharacterImageFolder } from '../native-image-storage.js';
import { runStage2 } from '../pipeline.js';
import { createRef, createReferenceFromGalleryCard, listRefs, updateRef, persistPoolOrThrow, releaseRefImage } from '../refs-library.js';
import { imageToDataUrl, ingestReferenceImage, blobToDataUrl } from '../references.js';
import { openCropDialog } from './crop-dialog.js';
import { openFolderSheet } from './folder-picker.js';
import { createGalleryFolder, listGalleryFolders } from '../gallery-folders.js';
import { reportFailure, URIS_SCOPES } from '../error-pool.js';

import { canonicalizeNativeImagePath } from '../native-image-path.js';

/**
 * Текстовые поля сущности, доступные для копирования. Порядок = порядок в
 * меню копирования: у карточки галереи это промпт/негатив/стиль, у референса —
 * описание, aliases и имя. Пустые поля не попадают в список.
 */
export function textFieldsFor(item) {
    const fields = [];
    if (item?.prompt) fields.push({ label: 'Промпт', text: item.prompt });
    if (item?.negativePrompt) fields.push({ label: 'Негативный промпт', text: item.negativePrompt });
    if (item?.style) fields.push({ label: 'Стиль', text: item.style });
    if (item?.description) fields.push({ label: 'Описание', text: item.description });
    if (Array.isArray(item?.aliases) && item.aliases.length) fields.push({ label: 'Aliases', text: item.aliases.join(', ') });
    if (item?.name) fields.push({ label: 'Имя', text: item.name });
    return fields;
}

/**
 * Копирование текста сущности: одно поле — мгновенно, несколько — меню выбора.
 * Меню открывается и поверх просмотрщика (слой --uris-z-modal-top).
 */
export async function copyItemText(item, deps = {}) {
    const fields = textFieldsFor(item);
    if (!fields.length) {
        toastr?.info('Нет текста для копирования');
        return;
    }
    const write = deps.write || (navigator?.clipboard ? navigator.clipboard.writeText.bind(navigator.clipboard) : null);
    const writeWithFeedback = async (field) => {
        try {
            await write(field.text);
            toastr?.success(`Скопировано: ${field.label}`);
        } catch (err) {
            reportFailure({ scope: URIS_SCOPES.copy, message: String(err?.message || err), toast: true, toastText: 'Не удалось скопировать' });
        }
    };
    if (fields.length === 1) return writeWithFeedback(fields[0]);

    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'uris-picker-overlay uris-crop-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Копировать текст');
        overlay.innerHTML = `
            <div class="uris-picker-dialog uris-copy-menu">
                <h4>Копировать текст</h4>
                <div class="uris-copy-list">
                    ${fields.map((field, i) => `
                        <button type="button" class="uris-copy-field" data-i="${i}">
                            <span class="uris-copy-field-label">${escapeHtml(field.label)}</span>
                            <small class="uris-copy-field-snippet">${escapeHtml(field.text.length > 80 ? field.text.slice(0, 80) + '…' : field.text)}</small>
                        </button>`).join('')}
                </div>
                <div class="uris-picker-actions">
                    <button type="button" class="uris-btn uris-btn-ghost uris-copy-cancel">Отмена</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        lockBodyScroll();

        const close = () => {
            document.removeEventListener('keydown', onKey, true);
            overlay.parentNode?.removeChild(overlay);
            unlockBodyScroll();
        };
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
        document.addEventListener('keydown', onKey, true);

        overlay.querySelector('.uris-copy-cancel').addEventListener('click', () => close(null));
        overlay.querySelectorAll('.uris-copy-field').forEach(btn => {
            btn.addEventListener('click', async () => {
                const field = fields[Number(btn.dataset.i)];
                close();
                if (field) await writeWithFeedback(field);
                resolve(field ?? null);
            });
        });
    });
}

/**
 * Copy the image itself to the clipboard: a card context-menu item and a
 * lightbox button. The Clipboard API accepts image/png only — webp/jpeg are
 * re-encoded through a canvas. Returns true/false for the "close the viewer"
 * contract; failures go to a toast + the error pool.
 * @param {{imagePath?:string, stGalleryPath?:string, src?:string}} item
 * @param {{fetch?:Function, write?:Function, ClipboardItem?:Function, createImageBitmap?:Function, canvas?:Function}} [deps]
 */
export async function copyImageToClipboard(item, deps = {}) {
    const src = item?.imagePath || item?.stGalleryPath || item?.src;
    if (!src) { toastr?.info('У картинки нет файла'); return false; }
    try {
        const f = deps.fetch || globalThis.fetch?.bind(globalThis);
        if (!f) throw new Error('fetch недоступен');
        const url = /^(https?:|data:|blob:|\/)/.test(src) ? src : `/${src}`;
        const res = await f(url);
        if (!res.ok) throw new Error(`Не удалось получить файл (${res.status})`);
        let blob = await res.blob();
        if (blob.type && blob.type !== 'image/png') {
            blob = await toPngBlob(blob, deps);
        }
        const write = deps.write || (navigator?.clipboard?.write ? navigator.clipboard.write.bind(navigator.clipboard) : null);
        if (!write) throw new Error('Буфер обмена недоступен (Clipboard API)');
        const Ctor = deps.ClipboardItem || globalThis.ClipboardItem;
        if (!Ctor) throw new Error('ClipboardItem не поддерживается этим браузером');
        await write([new Ctor({ 'image/png': blob })]);
        toastr?.success('Картинка скопирована в буфер');
        return true;
    } catch (err) {
        reportFailure({ scope: URIS_SCOPES.copy, message: String(err?.message || err), toast: true, toastText: 'Не удалось скопировать картинку: ' + (err?.message || err) });
        return false;
    }
}

/** Декод blob → canvas → PNG (буфер обмена принимает только image/png). */
async function toPngBlob(blob, deps = {}) {
    const createBitmap = deps.createImageBitmap || globalThis.createImageBitmap?.bind(globalThis) || null;
    if (!createBitmap) throw new Error('Не удалось декодировать картинку (createImageBitmap недоступен)');
    const bitmap = await createBitmap(blob);
    const canvas = deps.canvas ? deps.canvas() : document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const out = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!out) throw new Error('Canvas.toBlob вернул пустой результат');
    return out;
}

/**
 * «Скачать картинку»: нативное сохранение файла браузером (<a download>).
 * Жест ПКМ/долгого тапа отдаёт кастомному меню, у которого своего «Скачать»
 * нет — этот пункт возвращает потерянную браузерную опцию. src карточки —
 * same-origin путь ST или data URL, атрибут download для обоих работает.
 */
export function downloadImage(item) {
    const src = item?.src;
    if (!src) { toastr?.info('У картинки нет файла'); return; }
    const dataMime = src.match(/^data:image\/([\w.+-]+)/);
    const ext = dataMime ? dataMime[1].replace('jpeg', 'jpg')
        : (src.split('?')[0].match(/\.(\w{2,5})$/)?.[1] || 'png');
    const a = document.createElement('a');
    a.href = src;
    a.download = `uris_${item.id || 'image'}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

/**
 * Избранное: карточка закрепляется наверху сетки (в обоих режимах — «Все» и
 * «Папки»). Возвращает новое состояние. Просмотрщик НЕ закрывается: действие
 * безопасное и обратимое — контракт «закрывать только при успехе деструктивных
 * действий» на него не распространяется, сетка под вьювером перерисовывается.
 */
export async function toggleFavorite(item, root) {
    if (!item?.id) return false;
    const wanted = !(item.favorite === true);
    try {
        const updated = await updateCard(item.id, { favorite: wanted });
        if (updated) item.favorite = updated.favorite === true;
    } catch (err) {
        reportFailure({ scope: URIS_SCOPES.gallery, message: 'Избранное: ' + (err?.message || err), toast: true, toastText: 'Не удалось изменить избранное' });
    }
    if (root) refreshRoot(root);
    return item.favorite === true;
}

/**
 * «Папки…»: мульти-лист папок галереи (openFolderSheet, создание по запросу
 * без совпадений). Переключение применяется сразу — autosave-семантика поля
 * «Папка» в редакторе референса. По закрытию листа сетка перерисовывается:
 * счётчики чипов и активный фильтр должны увидеть новые составы.
 */
export async function assignGalleryFolders(item, root) {
    if (!item?.id) return;
    let mutated = false;
    const folders = await listGalleryFolders();
    openFolderSheet({
        title: 'Папки картинки',
        folders,
        selectedIds: Array.isArray(item.folders) ? item.folders : [],
        onCreate: name => createGalleryFolder(name),
        onToggle: async (folder, isOn) => {
            const set = new Set(Array.isArray(item.folders) ? item.folders : []);
            if (isOn) set.add(folder.id); else set.delete(folder.id);
            const next = [...set];
            try {
                await updateCard(item.id, { folders: next });
                item.folders = next;
                mutated = true;
            } catch (err) {
                reportFailure({ scope: URIS_SCOPES.gallery, message: 'Папки: ' + (err?.message || err), toast: true, toastText: 'Не удалось обновить папки' });
            }
        },
        onDone: () => { if (mutated && root) refreshRoot(root); },
        onCancel: () => { if (mutated && root) refreshRoot(root); },
    });
}

export async function saveAsReference(item) {
    if (!item) return;
    try {
        const createNew = await showConfirmModal(
            'Сохранить картинку в пул референсов?\n\n' +
            '«OK» — создать новый референс.\n' +
            '«Отмена» — заменить изображение в существующем.'
        );
        if (createNew) {
            const name = await showInputModal('Имя референса:', 'Из галереи');
            if (!name) return;
            const wantCrop = await showConfirmModal(
                'Обрезать перед сохранением?\n\n' +
                '«OK» — открыть кроп (Свободно / 1:1 / 3:4).\n' +
                '«Отмена» — сохранить как есть.'
            );
            const uploaded = wantCrop ? await uploadCroppedEntry(item) : await uploadEntryAsRef(item);
            if (uploaded === null) return; // кроп отменён — референс не создаём
            const ref = uploaded.reusedNativePath
                ? await createReferenceFromGalleryCard(item, { name })
                : await createRef({ name, imagePath: uploaded.imagePath, ...uploaded.metadata });
            if (item.prompt && !ref.description) await updateRef(ref.id, { description: item.prompt });
            toastr?.success('Референс создан: ' + name);
        } else {
            const refs = await listRefs();
            if (!refs.length) { toastr?.info('Пул пуст. Создайте через «OK».'); return; }
            const chosen = await showRefPicker('Выберите референс для замены изображения:', refs);
            if (!chosen) return;
            const oldImage = refs.find(r => r.id === chosen)?.imagePath || null;
            const uploaded = await uploadEntryAsRef(item);
            await updateRef(chosen, { imagePath: uploaded.imagePath, ...uploaded.metadata });
            await persistPoolOrThrow('заменить');
            void releaseRefImage(oldImage);
            toastr?.success('Изображение обновлено');
        }
        saveSettings();
    } catch (err) {
        log('saveRef error:', err.message);
        reportFailure({ scope: URIS_SCOPES.gallery, message: `Не удалось сохранить: ${err?.message || err}`, toast: true, toastText: 'Не удалось сохранить: ' + err.message });
    }
}

// One in-flight regenerate per gallery card: the lightbox toolbar has no button
// DOM to disable (regenBtn === null), so a double click would queue a second
// paid generation behind the first in the per-post FIFO chain.
const _regenInFlight = new Set();

/**
 * Regenerate a gallery card from its stored prompt. Returns true only when a new
 * image was actually produced — the lightbox keeps the viewer open on cancel,
 * abort or failure (close-on-failure used to hide the error context under the toast).
 * `overrides.prompt` — правленый промпт вместо сохранённого («Отредактировать
 * промпт» из контекстного меню лайтбокса); хранимый на карточке промпт не меняет.
 */
export async function regenerate(item, root, regenBtn, overrides = {}) {
    // While a generation is in flight the regen button is repurposed as a stop
    // button: a second click cancels it instead of starting a competing one.
    if (regenBtn?.dataset.urisStopMode === '1') {
        const id = regenBtn.dataset.urisCurrentReq;
        if (id) abortGeneration(id);
        return false;
    }
    if (regenBtn?.disabled) return false;
    const flightKey = `regen:${item?.id || item?.sourceMsgId || ''}`;
    if (_regenInFlight.has(flightKey)) {
        toastr?.info('Перегенерация уже выполняется');
        return false;
    }
    _regenInFlight.add(flightKey);
    const origHtml = regenBtn ? regenBtn.innerHTML : '';
    const origTitle = regenBtn ? regenBtn.title : '';
    let ok = false;
    try {
        // Lock during setup (confirm modal + ref rebuild) to prevent a competing
        // generation; onStart switches it to an enabled "stop" button once the
        // provider request is actually in flight.
        const snapshot = Array.isArray(item.refs) ? item.refs : null;
        let useSameRefs = false;
        if (snapshot && snapshot.length) {
            const names = snapshot.map(r => r.name || r.id || 'ref').join(', ');
            useSameRefs = await showConfirmModal(
                `Регенерировать с теми же референсами (${snapshot.length}: ${names})?\n\n` +
                `«OK» - те же референсы (снапшот на момент первичной генерации).\n` +
                `«Отмена» - использовать текущий активный профиль (мог измениться).`
            );
        }
        if (regenBtn) regenBtn.disabled = true;
        const instr = { prompt: overrides.prompt || item.prompt, aspectRatio: item.aspectRatio, imageSize: item.imageSize, quality: item.quality };
        let opts = {};
        if (useSameRefs && snapshot) {
            const refs = await rebuildRefsFromSnapshot(snapshot);
            opts = { refs };
            const curSig = refs.map(r => r.id || '').sort().join(',');
            if (item.refsSig && item.refsSig !== curSig) {
                toastr?.info('Состав референсов отличается от первичной генерации (профиль/аватар изменился)');
            }
        }
        opts.onStart = id => {
            if (!regenBtn) return;
            regenBtn.dataset.urisStopMode = '1';
            regenBtn.dataset.urisCurrentReq = id;
            regenBtn.disabled = false;
            regenBtn.title = 'Остановить генерацию';
            regenBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Остановить';
        };
        await runStage2(item.sourceMsgId, instr, undefined, undefined, opts);
        toastr?.success('Перегенерировано');
        if (root) refreshRoot(root);
        ok = true;
    } catch (err) {
        if (err?.name === 'AbortError') toastr?.info('Генерация отменена');
        else {
            reportFailure({ scope: URIS_SCOPES.gallery, message: 'Перегенерация: ' + (err?.message || err), toast: true, toastText: 'Перегенерация: ' + err.message });
        }
    } finally {
        _regenInFlight.delete(flightKey);
        if (regenBtn) {
            delete regenBtn.dataset.urisStopMode;
            delete regenBtn.dataset.urisCurrentReq;
            regenBtn.disabled = false;
            regenBtn.title = origTitle;
            regenBtn.innerHTML = origHtml;
        }
    }
    return ok;
}

/**
 * «Отредактировать промпт» (контекстное меню лайтбокса): текущий промпт в
 * инпуте, подтверждение — перегенерация с правленым текстом. Отмена, пустой
 * или неизменённый ввод — без действий и без платной постановки (false).
 */
export async function editPromptAndRegenerate(item, root) {
    const current = String(item?.prompt || '');
    const edited = await showInputModal('Промпт для перегенерации:', current);
    if (edited == null) return false;
    const prompt = String(edited).trim();
    if (!prompt || prompt === current) return false;
    return regenerate(item, root, null, { prompt });
}

/** Delete a gallery card. Returns false on cancel/failure — the lightbox keeps the viewer open. */
export async function deleteImage(item, chatId, root) {
    // A slide can legitimately have no card: the inline viewer shows every ready
    // result of a message, and its card may already be gone from the gallery.
    // Without this guard the user confirmed a dialog and nothing happened at all.
    if (!item?.id) {
        toastr?.info('Карточка не найдена в галерее — возможно, уже удалена');
        return false;
    }
    const ctx = getCtx();
    const deleteFile = await confirmDeleteModal(ctx);
    if (deleteFile === null) return false; // cancelled
    const removed = await deleteGalleryCard(chatId, item.id, { deleteFile });
    if (root) refreshRoot(root);
    return removed !== false;
}

/** Exported for tests: the delete popup with the "erase file too" checkbox. */
export async function confirmDeleteModal(ctx) {
    // Returns: true (delete the file too), false (hide only), null (cancelled).
    if (!ctx?.callGenericPopup || !ctx?.POPUP_TYPE) {
        // Fallback: simple confirm = hide only.
        return await showConfirmModal('Удалить картинку из галереи расширения?') ? false : null;
    }
    // The ST popup removes the dialog DOM before its promise resolves
    // (hide → remove → resolver), so the checkbox cannot be read after the
    // await. Track its state with a capture-phase change listener while the
    // dialog is open.
    const deleteFileRef = { checked: false };
    const onChange = (e) => {
        const input = e.target?.closest?.('#urisDeleteFile') || (e.target?.id === 'urisDeleteFile' ? e.target : null);
        if (input) deleteFileRef.checked = input.checked === true;
    };
    document.addEventListener('change', onChange, { capture: true });
    let result;
    try {
        result = await ctx.callGenericPopup(
            'Удалить картинку из галереи расширения?' +
            '<label class="checkbox_label uris-label-block">' +
            '<input type="checkbox" id="urisDeleteFile">' +
            '<span>Также стереть файл и убрать из галереи чата (Show Gallery)</span>' +
            '</label>',
            ctx.POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Удалить', cancelButton: 'Отмена' },
        );
    } finally {
        document.removeEventListener('change', onChange, { capture: true });
    }
    if (result === ctx.POPUP_RESULT.AFFIRMATIVE) {
        return deleteFileRef.checked;
    }
    return null;
}

async function uploadEntryAsRef(it) {
    const nativePath = typeof it.imagePath === 'string' ? it.imagePath : it.stGalleryPath;
    const canonicalNativePath = canonicalizeNativeImagePath(nativePath);
    if (canonicalNativePath) {
        return { imagePath: canonicalNativePath, metadata: {}, reusedNativePath: true };
    }
    const src = it.src;
    if (!src) throw new Error('нет изображения');
    let dataUrl = src;
    if (!src.startsWith('data:')) {
        dataUrl = await imageToDataUrl(src);
    }
    if (!dataUrl) throw new Error('не удалось получить изображение');
    // Same contract as the References tab: optimize first, so a gallery capture
    // lands in the pool with its dimensions and byte sizes instead of a bare path.
    const uploaded = await ingestReferenceImage(dataUrl, `npc_capture_${Date.now()}`);
    return { ...uploaded, reusedNativePath: false };
}

/**
 * Crop-ветка «сохранить как референс»: обрезанные байты отличаются от
 * сохранённого файла, поэтому реюз native-пути (uploadEntryAsRef) невозможен —
 * материализуем data URL, режем и грузим новый файл.
 *
 * @returns {Promise<{imagePath:string, metadata:Object}|null>} null — кроп отменён
 */
async function uploadCroppedEntry(it) {
    const src = it.src;
    if (!src) throw new Error('нет изображения');
    const dataUrl = src.startsWith('data:') ? src : await imageToDataUrl(src);
    if (!dataUrl) throw new Error('не удалось получить изображение');
    const crop = await openCropDialog({ source: dataUrl });
    if (!crop) return null;
    return await ingestReferenceImage(crop.blob, `npc_capture_${Date.now()}`);
}

/**
 * Кроп картинки из галереи (действие просмотрщика): результат — НОВАЯ карточка
 * в галерее этого чата (историю не переписываем), с унаследованным промптом и
 * best-effort миниатюрой.
 *
 * @returns {Promise<boolean>} true — карточка создана (просмотрщик можно закрыть)
 */
export async function cropGalleryImage(item, chatId, root, deps = {}) {
    if (!item?.src) return false;
    const doCrop = deps.crop || openCropDialog;
    const doUpload = deps.upload || uploadGeneratedImage;
    const doAdd = deps.add || addToGallery;
    const doThumb = deps.thumb || makeThumbnailForPath;
    try {
        const crop = await doCrop({ source: item.src });
        if (!crop) return false;
        const toDataUrl = deps.dataUrl || blobToDataUrl;
        const dataUrl = await toDataUrl(crop.blob);
        const folder = getCharacterImageFolder();
        const imagePath = await doUpload(dataUrl, { filename: `uris_crop_${Date.now()}`, ch_name: folder });
        const card = await doAdd(chatId, {
            imagePath,
            prompt: item.prompt || '',
            style: item.style || '',
            aspectRatio: item.aspectRatio,
            imageSize: item.imageSize,
            quality: item.quality,
            provenance: { sourceMsgId: item.sourceMsgId ?? null, croppedFrom: item.id || null },
            status: 'ready',
        });
        // Миниатюра — best-effort: без неё сетка рендерит полный файл.
        doThumb(imagePath, { filename: `uris_crop_${card.id}` })
            .then(thumbPath => updateCard(card.id, { thumbPath }))
            .catch(() => {});
        toastr?.success('Обрезанная копия добавлена в галерею');
        if (root) refreshRoot(root);
        return true;
    } catch (err) {
        reportFailure({ scope: URIS_SCOPES.gallery, message: 'Кроп: ' + (err?.message || err), toast: true, toastText: 'Кроп не удался: ' + err.message });
        return false;
    }
}

/**
 * Кроп референса (действие просмотрщика в режиме «референс»): результат —
 * новый файл в хранилище, запись референса переключается на него.
 *
 * @returns {Promise<boolean>} true — референс обновлён (просмотрщик можно закрыть)
 */
export async function cropReference(item, deps = {}) {
    const refId = item?.__refId;
    if (!refId || !item?.src) return false;
    const doCrop = deps.crop || openCropDialog;
    const doIngest = deps.ingest || ingestReferenceImage;
    const doUpdate = deps.update || updateRef;
    const doPersist = deps.persist || persistPoolOrThrow;
    const doRelease = deps.release || releaseRefImage;
    // До кропа: item.src — старый путь референса (showSingleImage передаёт
    // ref.imagePath); data-URL освобождать не от чего.
    const oldImage = item.src && !item.src.startsWith('data:') ? item.src : null;
    try {
        const crop = await doCrop({ source: item.src });
        if (!crop) return false;
        // Уникальное имя: тот же URL после перезаписи браузер отдаёт из кэша,
        // и плитка показывает старую картинку («замена не применилась»).
        const optimized = await doIngest(crop.blob, `ref_${refId}_${Date.now()}`);
        try {
            await doUpdate(refId, { imagePath: optimized.imagePath, ...optimized.metadata });
            await doPersist('обрезать');
        } catch (mutationError) {
            throw new Error(`${mutationError.message}; orphaned upload: ${optimized.imagePath}`);
        }
        doRelease(oldImage);
        toastr?.success('Референс обрезан');
        // Обновить активную вкладку (Референсы/Генерация) под просмотрщиком.
        import('./tabs.js').then(m => m.refreshActive()).catch(() => {});
        return true;
    } catch (err) {
        reportFailure({ scope: URIS_SCOPES.refs, message: 'Кроп референса: ' + (err?.message || err), toast: true, toastText: 'Кроп не удался: ' + err.message });
        return false;
    }
}

async function showRefPicker(title, refs) {
    const ctx = getCtx();
    if (!ctx.callGenericPopup || !ctx.POPUP_TYPE || !ctx.POPUP_RESULT) return null;
    const MAX_CUSTOM = 9;
    if (refs.length > MAX_CUSTOM) {
        toastr?.warning(`Слишком много референсов (${refs.length}). Покажем первые ${MAX_CUSTOM}.`);
        refs = refs.slice(0, MAX_CUSTOM);
    }
    const customButtons = refs.map((r, i) => ({
        text: r.name || '?',
        result: ctx.POPUP_RESULT[`CUSTOM${i + 1}`],
    }));
    const res = await ctx.callGenericPopup(
        title, ctx.POPUP_TYPE.TEXT, '',
        // Selection happens via the custom (reference) buttons; both built-in
        // buttons only close. Two identical «Отмена» labels read as a bug —
        // the OK button is honestly labeled as a plain close.
        { okButton: 'Закрыть', cancelButton: 'Отмена', customButtons },
    );
    if (res == null || res === ctx.POPUP_RESULT.NEGATIVE || res === ctx.POPUP_RESULT.CANCELLED) return null;
    for (let i = 0; i < refs.length; i++) {
        if (res === ctx.POPUP_RESULT[`CUSTOM${i + 1}`]) return refs[i]?.id || null;
    }
    return null;
}

async function rebuildRefsFromSnapshot(snapshot) {
    const poolRefs = await listRefs();
    const out = [];
    for (const descriptor of snapshot) {
        try {
            const ref = descriptor.id ? poolRefs.find(item => item.id === descriptor.id) : null;
            if (!ref?.imagePath) continue;
            const dataUrl = await imageToDataUrl(ref.imagePath);
            if (dataUrl) {
                out.push({ image: dataUrl, id: ref.id, name: ref.name || '' });
            }
        } catch { /* ignore individual failures */ }
    }
    return out;
}

function refreshRoot(root) {
    // Re-render the gallery tab by re-importing and calling render.
    // The grid passes its own render closure; lightbox can pass null.
    import('./tab-gallery.js').then(({ render }) => render(root)).catch(() => {});
}
