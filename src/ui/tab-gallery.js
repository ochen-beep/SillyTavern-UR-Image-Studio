// @ts-check
/**
 * Gallery tab: grid of shared native image metadata with actions for
 * viewing, regenerating, copying the prompt, saving as a reference, and deleting.
 */
import { getCtx, escapeHtml, showConfirmModal } from '../core.js';
import { getGallery, clearGallery } from '../storage.js';
import { showLightbox } from './lightbox.js';

export async function render(root) {
    const chatId = getCtx().chatId;
    const items = await getGallery(chatId);
    if (root.__urisTabId && root.__urisTabId !== 'gallery') return;
    root.innerHTML = `
        <div class="uris-gallery">
            <div class="uris-gallery-toolbar">
                <span id="urisGalleryCount">${items.length}</span>
                <button class="uris-btn uris-btn-danger uris-gallery-clear" id="urisGalleryClear"><i class="fa-solid fa-trash"></i> Очистить</button>
            </div>
            <div class="uris-gallery-grid" id="urisGalleryGrid">
                ${items.length ? items.map((it, i) => card(it, i)).join('') : emptyState()}
            </div>
        </div>`;
    await bindCards(root, items, chatId);
    if (root.__urisTabId && root.__urisTabId !== 'gallery') return;
    root.querySelector('#urisGalleryClear').addEventListener('click', async () => {
        if (await showConfirmModal('Очистить галерею этого чата?')) {
            await clearGallery(chatId);
            if (root.__urisTabId && root.__urisTabId !== 'gallery') return;
            render(root);
        }
    });
}

function card(it, i) {
    const badge = it.saved ? '<span class="uris-saved-badge" title="Сохранено в ST">💾</span>' : '';
    const gotoBtn = it.sourceMsgId != null
        ? `<button class="uris-card-btn" data-act="goto" title="Перейти к посту-источнику" aria-label="Перейти к посту-источнику"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>`
        : '';
    // The image itself is the view trigger (the former expand button is gone);
    // a real <button> keeps Tab/Enter working. Dimensions prevent layout shift
    // and let the lightbox animate from this thumbnail.
    const dims = Number(it.width) > 0 && Number(it.height) > 0
        ? ` width="${Number(it.width)}" height="${Number(it.height)}"`
        : '';
    return `<div class="uris-card" data-id="${it.id}" data-idx="${i}">
        <button type="button" class="uris-card-img" data-act="view" title="Просмотр" aria-label="Просмотр"><img src="${escapeHtml(it.src)}" alt="" loading="lazy" decoding="async"${dims}>${badge}</button>
        <div class="uris-card-actions">
            <button class="uris-card-btn" data-act="regen" title="Перегенерировать" aria-label="Перегенерировать"><i class="fa-solid fa-rotate-right"></i></button>
            <button class="uris-card-btn" data-act="copy" title="Копировать промпт" aria-label="Копировать промпт"><i class="fa-solid fa-copy"></i></button>
            ${gotoBtn}
            <button class="uris-card-btn" data-act="saveRef" title="Сохранить как референс" aria-label="Сохранить как референс"><i class="fa-solid fa-bookmark"></i></button>
            <button class="uris-card-btn" data-act="del" title="Удалить" aria-label="Удалить"><i class="fa-solid fa-trash"></i></button>
        </div>
    </div>`;
}

function emptyState() {
    return '<div class="uris-gallery-empty">Нет генераций. Перейдите во вкладку «Генерация».</div>';
}

async function bindCards(root, items, chatId) {
    const { copyPrompt, saveAsReference, regenerate, deleteImage } = await import('./gallery-actions.js');
    root.querySelectorAll('.uris-card').forEach(cardEl => {
        const id = cardEl.dataset.id;
        const idx = parseInt(cardEl.dataset.idx, 10);
        const it = () => items.find(x => x.id === id);
        cardEl.querySelector('[data-act="view"]')?.addEventListener('click', (e) => {
            e.stopPropagation(); showLightbox(items, idx, { chatId, root });
        });
        cardEl.querySelector('[data-act="copy"]')?.addEventListener('click', async (e) => {
            e.stopPropagation(); await copyPrompt(it());
        });
        cardEl.querySelector('[data-act="regen"]')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            const regenBtn = cardEl.querySelector('[data-act="regen"]');
            await regenerate(it(), root, regenBtn);
        });
        // Navigate to source post: scroll the chat to .mes[mesid="N"].
        cardEl.querySelector('[data-act="goto"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const msgId = it()?.sourceMsgId;
            if (msgId == null) { toastr?.info('Пост-источник не указан'); return; }
            const mes = document.querySelector(`.mes[mesid="${msgId}"]`);
            if (!mes) { toastr?.info('Пост не найден в чате (возможно удалён)'); return; }
            mes.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        cardEl.querySelector('[data-act="del"]')?.addEventListener('click', async (e) => {
            e.stopPropagation(); await deleteImage(it(), chatId, root);
        });
        cardEl.querySelector('[data-act="saveRef"]')?.addEventListener('click', async (e) => {
            e.stopPropagation(); await saveAsReference(it());
        });
    });
}
