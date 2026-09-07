// @ts-check
/**
 * Lightbox: fullscreen image viewer + swipe/keyboard for navigation/closing.
 *
 * Single keydown listener on document, stored in _onKey and removed in close()
 * ALWAYS (previously only removed on Escape → leak when navigating/closing with cross).
 */
import { copyPrompt, saveAsReference, regenerate, deleteImage } from './gallery-actions.js';
import { escapeHtml, getCtx } from '../core.js';
import { lockBodyScroll, unlockBodyScroll } from './window.js';

let _items = [];   // [{src, prompt, style}]
let _index = 0;
let _onKey = null;  // reference for removeEventListener
let _chatId = null;
let _root = null;   // optional gallery root for post-action re-render
let _previousFocus = null;  // element to return focus to when the dialog closes

export function showLightbox(items, index = 0, { chatId = null, root = null } = {}) {
    if (!items?.length) return;
    _items = items; _index = Math.max(0, Math.min(items.length - 1, index));
    _chatId = chatId ?? getCtx().chatId ?? null;
    _root = root;
    _previousFocus = document.activeElement;
    lockBodyScroll();
    render();
}

function render() {
    document.querySelector('.uris-lightbox')?.remove();
    const item = _items[_index];
    const lb = document.createElement('div');
    lb.className = 'uris-lightbox';
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-modal', 'true');
    lb.setAttribute('aria-label', 'Просмотр изображения');
    // ✕ and counter are direct children of the backdrop (inset:0), not content: always in the corner
    // of the screen regardless of where/size the content is (fix for mobile bug).
    lb.innerHTML = `
        <div class="uris-lb-counter">${_index + 1} / ${_items.length}</div>
        <button class="uris-lb-close" type="button" title="Закрыть (Esc)" aria-label="Закрыть">✕</button>
        <div class="uris-lb-content">
            <img alt="" class="uris-lb-img">
            <div class="uris-lb-info">
                ${item.style ? `<div class="uris-lb-style">🎨 ${escapeHtml(item.style)}</div>` : ''}
                <div class="uris-lb-prompt">${escapeHtml(item.prompt || '')}</div>
            </div>
            <div class="uris-lb-actions">
                <button class="uris-lb-act" data-act="copy" title="Копировать промпт" aria-label="Копировать промпт"><i class="fa-solid fa-copy"></i></button>
                <button class="uris-lb-act" data-act="saveRef" title="Сохранить как референс" aria-label="Сохранить как референс"><i class="fa-solid fa-bookmark"></i></button>
                <button class="uris-lb-act" data-act="regen" title="Перегенерировать" aria-label="Перегенерировать"><i class="fa-solid fa-rotate-right"></i></button>
                <button class="uris-lb-act uris-lb-act-danger" data-act="del" title="Удалить" aria-label="Удалить"><i class="fa-solid fa-trash"></i></button>
            </div>
            ${_items.length > 1 ? `<button class="uris-lb-nav prev" type="button" aria-label="Предыдущее">‹</button><button class="uris-lb-nav next" type="button" aria-label="Следующее">›</button>` : ''}
        </div>`;
    lb.querySelector('.uris-lb-img').src = item.src;
    document.body.appendChild(lb);
    // Move focus into the dialog so keyboard users land inside it, not on the
    // trigger behind the backdrop.
    lb.tabIndex = -1;
    try { lb.focus(); } catch { /* focus unavailable */ }
    // Click on the darkened background (not on content/controls) — closes. Gives
    // mobile users a reliable exit, even if ✕ is hard to reach.
    lb.addEventListener('click', (e) => { if (e.target === lb) close(); });
    lb.querySelector('.uris-lb-close').addEventListener('click', close);
    lb.querySelector('.uris-lb-nav.prev')?.addEventListener('click', prev);
    lb.querySelector('.uris-lb-nav.next')?.addEventListener('click', next);
    lb.querySelector('[data-act="copy"]')?.addEventListener('click', () => copyPrompt(item));
    lb.querySelector('[data-act="saveRef"]')?.addEventListener('click', () => saveAsReference(item));
    lb.querySelector('[data-act="regen"]')?.addEventListener('click', async () => {
        await regenerate(item, _root, null);
        // After regeneration the items list is stale; close so the grid re-render shows the new image.
        close();
    });
    lb.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
        await deleteImage(item, _chatId, _root);
        // The card may be hidden/removed; close the lightbox.
        close();
    });

    // Single keydown listener on document: Escape/←/→. Removed in close() and on re-render.
    if (_onKey) document.removeEventListener('keydown', _onKey);
    _onKey = (e) => {
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowLeft') prev();
        else if (e.key === 'ArrowRight') next();
    };
    document.addEventListener('keydown', _onKey);

    // swipe: down — close, left/right — navigate
    let sx = 0, sy = 0;
    lb.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    lb.addEventListener('touchend', (e) => {
        const dx = e.changedTouches[0].clientX - sx;
        const dy = e.changedTouches[0].clientY - sy;
        if (Math.abs(dy) > Math.abs(dx) && dy > 80) close();
        else if (Math.abs(dx) > 60) {
            if (dx < 0) next();
            else prev();
        }
    }, { passive: true });
}

function prev() { if (_items.length > 1) { _index = (_index - 1 + _items.length) % _items.length; render(); } }
function next() { if (_items.length > 1) { _index = (_index + 1) % _items.length; render(); } }

function close() {
    if (_onKey) { document.removeEventListener('keydown', _onKey); _onKey = null; }
    document.querySelector('.uris-lightbox')?.remove();
    unlockBodyScroll();
    const prev = _previousFocus;
    _previousFocus = null;
    if (prev && typeof prev.focus === 'function') {
        try { prev.focus(); } catch { /* focus unavailable */ }
    }
}
