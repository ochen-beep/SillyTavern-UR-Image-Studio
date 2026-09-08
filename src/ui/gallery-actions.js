// @ts-check
/**
 * Shared action handlers for gallery cards, consumed by both the grid
 * (tab-gallery.js) and the lightbox (lightbox.js). Extracted from tab-gallery.js
 * to avoid duplication and keep a single source of truth.
 */
import { getCtx, showConfirmModal, showInputModal, log, saveSettings, abortGeneration, escapeHtml, uid } from '../core.js';
import { setStatus } from './window.js';
import { lockBodyScroll, unlockBodyScroll } from './window.js';
import { addToGallery, deleteGalleryCard } from '../storage.js';
import { updateCard } from '../gallery-index.js';
import { makeThumbnailForPath, uploadGeneratedImage, getCharacterImageFolder } from '../native-image-storage.js';
import { runStage2 } from '../pipeline.js';
import { createRef, createReferenceFromGalleryCard, listRefs, updateRef } from '../refs-library.js';
import { imageToDataUrl, ingestReferenceImage, blobToDataUrl } from '../references.js';
import { openCropDialog } from './crop-dialog.js';
import { recordUrisError } from '../error-pool.js';

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
 * Меню открывается и поверх просмотрщика (z-index 100100).
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
            recordUrisError({ scope: 'Копирование', message: String(err?.message || err) });
            toastr?.error('Не удалось скопировать');
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
            const uploaded = await uploadEntryAsRef(item);
            await updateRef(chosen, { imagePath: uploaded.imagePath, ...uploaded.metadata });
            toastr?.success('Изображение обновлено');
        }
        refreshActive();
    } catch (err) {
        log('saveRef error:', err.message);
        recordUrisError({ scope: 'Галерея', message: `Не удалось сохранить: ${err?.message || err}` });
        toastr?.error('Не удалось сохранить: ' + err.message);
    }
}

export async function regenerate(item, root, regenBtn) {
    // While a generation is in flight the regen button is repurposed as a stop
    // button: a second click cancels it instead of starting a competing one.
    if (regenBtn?.dataset.urisStopMode === '1') {
        const id = regenBtn.dataset.urisCurrentReq;
        if (id) abortGeneration(id);
        return;
    }
    if (regenBtn?.disabled) return;
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
    const origHtml = regenBtn ? regenBtn.innerHTML : '';
    const origTitle = regenBtn ? regenBtn.title : '';
    try {
        // Lock during setup (confirm modal + ref rebuild) to prevent a competing
        // generation; onStart switches it to an enabled "stop" button once the
        // provider request is actually in flight.
        if (regenBtn) regenBtn.disabled = true;
        setStatus('Перегенерация...');
        const instr = { style: item.style, prompt: item.prompt, aspectRatio: item.aspectRatio, imageSize: item.imageSize, quality: item.quality };
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
        await runStage2(item.sourceMsgId, instr, s => setStatus(s), undefined, opts);
        toastr?.success('Перегенерировано');
        if (root) refreshRoot(root);
    } catch (err) {
        if (err?.name === 'AbortError') toastr?.info('Генерация отменена');
        else {
            recordUrisError({ scope: 'Галерея', message: 'Перегенерация: ' + (err?.message || err) });
            toastr?.error('Перегенерация: ' + err.message);
        }
    } finally {
        setStatus('');
        if (regenBtn) {
            delete regenBtn.dataset.urisStopMode;
            delete regenBtn.dataset.urisCurrentReq;
            regenBtn.disabled = false;
            regenBtn.title = origTitle;
            regenBtn.innerHTML = origHtml;
        }
    }
}

export async function deleteImage(item, chatId, root) {
    const ctx = getCtx();
    const deleteFile = await confirmDeleteModal(ctx);
    if (deleteFile === null) return; // cancelled
    await deleteGalleryCard(chatId, item.id, { deleteFile });
    if (root) refreshRoot(root);
}

async function confirmDeleteModal(ctx) {
    // Returns: true (delete file too), false (hide only), null (cancelled).
    if (!ctx?.callGenericPopup || !ctx?.POPUP_TYPE) {
        // Fallback: simple confirm = hide only.
        return await showConfirmModal('Удалить картинку из галереи расширения?') ? false : null;
    }
    const result = await ctx.callGenericPopup(
        'Удалить картинку из галереи расширения?' +
        '<label class="checkbox_label" style="margin-top:10px;display:block;">' +
        '<input type="checkbox" id="urisDeleteFile">' +
        '<span>Также стереть файл и убрать из галереи чата (Show Gallery)</span>' +
        '</label>',
        ctx.POPUP_TYPE.CONFIRM,
        '',
        { okButton: 'Удалить', cancelButton: 'Отмена' },
    );
    if (result === ctx.POPUP_RESULT.AFFIRMATIVE) {
        const cb = document.querySelector('#urisDeleteFile');
        return cb?.checked ? true : false;
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
        recordUrisError({ scope: 'Галерея', message: 'Кроп: ' + (err?.message || err) });
        toastr?.error('Кроп не удался: ' + err.message);
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
    try {
        const crop = await doCrop({ source: item.src });
        if (!crop) return false;
        const optimized = await doIngest(crop.blob, `ref_${refId}`);
        try {
            await doUpdate(refId, { imagePath: optimized.imagePath, ...optimized.metadata });
        } catch (mutationError) {
            throw new Error(`${mutationError.message}; orphaned upload: ${optimized.imagePath}`);
        }
        toastr?.success('Референс обрезан');
        // Обновить активную вкладку (Референсы/Генерация) под просмотрщиком.
        import('./tabs.js').then(m => m.refreshActive()).catch(() => {});
        return true;
    } catch (err) {
        recordUrisError({ scope: 'Референсы', message: 'Кроп референса: ' + (err?.message || err) });
        toastr?.error('Кроп не удался: ' + err.message);
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
        { okButton: 'Отмена', cancelButton: 'Отмена', customButtons },
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

function refreshActive() {
    // Re-dispatch a refresh of whichever view is active. saveSettings triggers
    // ST's settings redraw; the gallery tab re-renders on its own render() call.
    saveSettings();
}

function refreshRoot(root) {
    // Re-render the gallery tab by re-importing and calling render.
    // The grid passes its own render closure; lightbox can pass null.
    import('./tab-gallery.js').then(({ render }) => render(root)).catch(() => {});
}
