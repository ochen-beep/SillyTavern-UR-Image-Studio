// @ts-check
/**
 * Gallery tab: grid of shared native image metadata with actions for
 * viewing, regenerating, copying the prompt, saving as a reference, and deleting.
 */
import { getCtx, escapeHtml, showConfirmModal } from '../core.js';
import { getGallery, clearGallery } from '../storage.js';
import { showLightbox } from './lightbox.js';

// Test-only viewer seam: fake-dom tests cannot load PhotoSwipe, so the click
// regression test swaps the viewer for a capture stub (same pattern as
// setRefStoreForTests in refs-library.js).
let _viewer = { showLightbox };
export function setViewerForTests(viewer) { _viewer = viewer; }
export function resetViewerForTests() { _viewer = { showLightbox }; }

// Gallery grid renders in chunks: the first batch mounts immediately, the rest
// append when the sentinel scrolls into view (no virtualization needed at this
// list size, but a 500-image chat must not drop 500 <img> at once).
const CHUNK_SIZE = 60;

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
            <div class="uris-gallery-grid" id="urisGalleryGrid"></div>
        </div>`;
    const grid = root.querySelector('#urisGalleryGrid');
    if (!items.length) {
        grid.innerHTML = emptyState();
    } else {
        await appendChunk(grid, root, items, 0, chatId);
        await mountChunkLoader(root, grid, items, chatId);
    }
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
    // and let the lightbox animate from this thumbnail. Grid loads the small
    // variant when one exists — the lightbox always opens the full image.
    const src = it.thumbPath || it.src;
    const dims = Number(it.width) > 0 && Number(it.height) > 0
        ? ` width="${Number(it.width)}" height="${Number(it.height)}"`
        : '';
    return `<div class="uris-card" data-id="${it.id}" data-idx="${i}">
        <button type="button" class="uris-card-img" data-act="view" title="Просмотр" aria-label="Просмотр"><img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async"${dims}>${badge}</button>
        <div class="uris-card-actions">
            <button class="uris-card-btn" data-act="regen" title="Перегенерировать" aria-label="Перегенерировать"><i class="fa-solid fa-rotate-right"></i></button>
            <button class="uris-card-btn" data-act="copy" title="Копировать текст" aria-label="Копировать текст"><i class="fa-solid fa-copy"></i></button>
            ${gotoBtn}
            <button class="uris-card-btn" data-act="saveRef" title="Сохранить как референс" aria-label="Сохранить как референс"><i class="fa-solid fa-bookmark"></i></button>
            <button class="uris-card-btn" data-act="del" title="Удалить" aria-label="Удалить"><i class="fa-solid fa-trash"></i></button>
        </div>
    </div>`;
}

/** Append one chunk of cards and bind only the newly added ones. */
async function appendChunk(grid, root, items, from, chatId) {
    const to = Math.min(items.length, from + CHUNK_SIZE);
    // Wrapper-div + appendChild instead of insertAdjacentHTML: same result in
    // browsers (appendChild moves the node), and parseable by the fake-dom
    // test harness. Iterate a snapshot — appendChild mutates wrapper.children.
    const wrapper = document.createElement('div');
    wrapper.innerHTML = items.slice(from, to).map((it, i) => card(it, from + i)).join('');
    for (const node of [...wrapper.children]) grid.appendChild(node);
    await bindCards(grid, root, items, chatId, from, to);
}

/**
 * Keep appending chunks while the sentinel is visible (fast scrolling, short
 * viewports). Without IntersectionObserver everything renders immediately.
 */
async function mountChunkLoader(root, grid, items, chatId) {
    if (grid.querySelectorAll('.uris-card').length >= items.length) return;
    const sentinel = document.createElement('div');
    sentinel.className = 'uris-gallery-sentinel';
    grid.parentElement?.insertBefore(sentinel, grid.nextSibling);
    const appendNext = async () => {
        const from = grid.querySelectorAll('.uris-card').length;
        if (from >= items.length) {
            observer?.disconnect();
            sentinel.remove();
            return;
        }
        await appendChunk(grid, root, items, from, chatId);
        if (grid.querySelectorAll('.uris-card').length >= items.length) {
            observer?.disconnect();
            sentinel.remove();
        }
    };
    // In-flight guard: appendChunk awaits bindCards, and a second
    // IntersectionObserver callback during that await re-read the same card
    // count and appended the same slice twice (duplicate cards on fast scroll).
    let appending = false;
    const guardedAppend = async () => {
        if (appending) return;
        appending = true;
        try { await appendNext(); }
        finally { appending = false; }
    };
    const observer = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void guardedAppend(); })
        : null;
    if (!observer) {
        while (grid.querySelectorAll('.uris-card').length < items.length) await appendNext();
        sentinel.remove();
        return;
    }
    observer.observe(sentinel);
}

function emptyState() {
    return '<div class="uris-gallery-empty">Нет генераций. Перейдите во вкладку «Генерация».</div>';
}

// root — корень ВКЛАДКИ (#urisBody), он нужен обработчикам для refreshRoot и
// просмотра; scopeEl — контейнер сетки, в котором ищутся карточки. Это разные
// элементы: смешение их давало «root is not defined» на клике по картинке
// (обработчики молча падали с ReferenceError — просмотр не открывался).
async function bindCards(scopeEl, root, items, chatId, from = 0, to = items.length) {
    const { copyItemText, saveAsReference, regenerate, deleteImage } = await import('./gallery-actions.js');
    scopeEl.querySelectorAll('.uris-card').forEach(cardEl => {
        const idx = parseInt(cardEl.dataset.idx, 10);
        if (idx < from || idx >= to) return;       // outside this chunk
        if (cardEl.dataset.bound === '1') return;  // already bound (idempotent)
        cardEl.dataset.bound = '1';
        const id = cardEl.dataset.id;
        const it = () => items.find(x => x.id === id);
        cardEl.querySelector('[data-act="view"]')?.addEventListener('click', (e) => {
            e.stopPropagation(); _viewer.showLightbox(items, idx, { chatId, root });
        });
        cardEl.querySelector('[data-act="copy"]')?.addEventListener('click', async (e) => {
            e.stopPropagation(); await copyItemText(it());
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
