// @ts-check
/**
 * Reference editor: the shared editor body (preview + fields + actions) and
 * its binding, used as-is by the desktop overlay panel and the mobile card
 * screen (hygiene split 2026-10-25). Screen-specific refreshes arrive as
 * opts callbacks; onDeleted lets the mobile stack reset its nav state.
 */
import { escapeHtml, showConfirmModal } from '../core.js';
import {
    updateRef, deleteRef, createFolder, cloneRef, persistPoolOrThrow, releaseRefImage,
} from '../refs-library.js';
import { reportFailure, URIS_SCOPES } from '../error-pool.js';
import { refreshActive } from './tabs.js';
import { showSingleImage } from './lightbox.js';
import { editTextModal } from './text-editor.js';
import { createFolderField } from './folder-picker.js';
import { openCropDialog } from './crop-dialog.js';
import { ingestReferenceImage } from '../references.js';
import { refsView } from './refs-view-shared.js';

/**
 * Editor body markup shared by the desktop overlay and the mobile card screen.
 * Only the delete-button label differs between the two layouts.
 */
export function refEditorBodyHtml(ref, { deleteLabel = 'Удалить карточку' } = {}) {
    const aliasesStr = (ref.aliases || []).join(', ');
    return `
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
        <div class="uris-field-head"><label class="uris-ed-label">Описание</label>
            <button class="uris-expand-btn" type="button" data-act="expand-desc" title="Развернуть редактор" aria-label="Развернуть редактор"><i class="fa-solid fa-maximize"></i></button></div>
        <textarea class="text_pole uris-ed-desc" rows="3" placeholder="Текст для Stage1">${escapeHtml(ref.description || '')}</textarea>
        <label class="uris-ed-check"><input type="checkbox" class="uris-ed-binding-mode" ${ref.bindingMode === 'description' ? 'checked' : ''}><span>Только описание</span></label>
        <small class="uris-hint">Без картинки в генерацию попадёт только это описание.</small>
        <label class="uris-ed-label">Папки</label>
        <div class="uris-fp-host"></div>
        <div class="uris-ed-footer">
            <button class="uris-btn uris-btn-ghost uris-ed-clone"><i class="fa-solid fa-clone"></i> Клонировать</button>
            <button class="uris-btn uris-btn-ghost uris-ed-del"><i class="fa-solid fa-trash"></i> ${escapeHtml(deleteLabel)}</button>
        </div>`;
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
    // explicit "Save" button — saves are silent, like templates/connections.
    const saveBasic = async () => {
        await updateRef(ref.id, {
            name: nameInput.value,
            aliases: aliasesInput.value,
            description: descInput.value,
            bindingMode: bindingModeInput?.checked ? 'description' : 'image',
        });
    };
    nameInput.addEventListener('change', saveBasic);
    aliasesInput.addEventListener('change', saveBasic);
    descInput.addEventListener('change', saveBasic);

    // Expanded editor (ST-style maximized_textarea popup), same unified pattern
    // as the template instruction and image prompt fields. Direct saveBasic()
    // instead of a synthetic change event, like the templates card: bubbled
    // change events don't propagate in the fake-dom tests.
    host.querySelector('[data-act="expand-desc"]')?.addEventListener('click', async () => {
        const next = await editTextModal({ value: descInput.value, title: 'Описание', placeholder: 'Текст для Stage1' });
        if (next === null || next === descInput.value) return;
        descInput.value = next;
        await saveBasic();
    });

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
        const oldImage = ref.imagePath;
        try {
            const crop = await openCropDialog({ source: ref.imagePath });
            if (!crop) return;
            // Уникальное имя: перезапись того же URL давала кэшированному
            // тайлу_show_ старую картинку, а переименование ломает только
            // ссылки на файл — владеет им одна запись пула.
            const optimized = await ingestReferenceImage(crop.blob, `ref_${ref.id}_${Date.now()}`);
            try {
                await updateRef(ref.id, { imagePath: optimized.imagePath, ...optimized.metadata });
                await persistPoolOrThrow('обрезать');
            } catch (mutationError) {
                throw new Error(`${mutationError.message}; orphaned upload: ${optimized.imagePath}`);
            }
            releaseRefImage(oldImage);
            const img = host.querySelector('.uris-editor-preview');
            if (img) img.src = optimized.imagePath;
        } catch (err) {
            reportFailure({ scope: URIS_SCOPES.refs, message: 'Не удалось обрезать: ' + (err?.message || err), toast: true, toastText: 'Не удалось обрезать: ' + err.message });
        }
    });
    host.querySelector('.uris-ed-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const oldImage = ref.imagePath;
        try {
            // Кроп опционален: «Без обрезки» грузит файл как есть, «Отмена»
            // вообще ничего не меняет.
            const crop = await openCropDialog({ source: file, allowSkip: true });
            if (!crop) return;
            const optimized = await ingestReferenceImage(crop.blob || file, `ref_${ref.id}_${Date.now()}`);
            try {
                await updateRef(ref.id, { imagePath: optimized.imagePath, ...optimized.metadata });
                await persistPoolOrThrow('заменить');
            } catch (mutationError) {
                throw new Error(`${mutationError.message}; orphaned upload: ${optimized.imagePath}`);
            }
            releaseRefImage(oldImage);
            const img = host.querySelector('.uris-editor-preview');
            if (img) img.src = optimized.imagePath;
        } catch (err) {
            reportFailure({ scope: URIS_SCOPES.refs, message: 'Не удалось заменить: ' + (err?.message || err), toast: true, toastText: 'Не удалось заменить: ' + err.message });
        }
        e.target.value = '';
    });

    // Клон: новая запись пула поверх ТЕКУЩЕГО файла картинки — releaseRefImage
    // удержит файл, пока клон на него смотрит, так что правки расходятся
    // независимо. Редактор сразу переключается на клона: в сетке с 50+ карточками
    // он мог бы уехать за экран, а переименовать его нужно сейчас.
    host.querySelector('.uris-ed-clone')?.addEventListener('click', async () => {
        try {
            const clone = await cloneRef(ref);
            toastr?.success('Клонирован: ' + clone.name);
            refsView.editingRefId = clone.id;
            await opts.onCloned?.();
        } catch (err) {
            reportFailure({ scope: URIS_SCOPES.refs, message: 'Клонирование: ' + (err?.message || err), toast: true, toastText: 'Не удалось клонировать: ' + err.message });
        }
    });

    host.querySelector('.uris-ed-del')?.addEventListener('click', async () => {
        if (await showConfirmModal('Удалить референс из пула?')) {
            await deleteRef(ref.id);
            refsView.editingRefId = null;
            opts.onDeleted?.();
            refreshActive();
        }
    });
}
