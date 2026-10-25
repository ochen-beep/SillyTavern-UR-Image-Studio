// @ts-check
/**
 * Drag-to-reorder for card lists (templates, connections) — Pointer Events,
 * один код для мыши, тача и пера (паттерн makeChipDraggable из
 * tab-generate-refs.js). Ghost-клон следует за курсором через transform;
 * по drop колбэк onReorder(fromIndex, toIndex) применяет порядок к данным —
 * во время перетаскивания DOM списка не перерисовывается.
 *
 * Мышь: drag начинается после сдвига больше порога. Тач/перо: длинное
 * нажатие (longPressMs) — иначе жест остаётся скроллом; после старта на
 * карточке выставляется touch-action:none, чтобы страница не листалась.
 */
const MOVE_THRESHOLD = 6;      // px, старт drag для мыши
const LONG_PRESS_MS = 220;     // ms, старт drag для тача/пера
const EDGE_SCROLL_ZONE = 48;   // px, авто-скролл у края контейнера
const DEFAULT_EXCLUDED = 'button, a, input, textarea, select, [data-no-drag]';

/** Список селекторов проверяется по одному: fake-dom не понимает запятые. */
function isExcludedTarget(target, excluded) {
    for (const sel of excluded.split(',').map(s => s.trim()).filter(Boolean)) {
        try { if (target.closest?.(sel)) return true; } catch { /* мусорный селектор */ }
    }
    return false;
}

/**
 * @param {HTMLElement} container список карточек
 * @param {{selector:string, onReorder:(from:number, to:number)=>void, longPressMs?:number, excluded?:string}} opts
 *   selector — карточки внутри container; excluded — селектор интерактивных
 *   элементов, с которых drag не начинается (кнопки, инпуты).
 */
export function makeCardReorderable(container, { selector, onReorder, longPressMs = LONG_PRESS_MS, excluded = DEFAULT_EXCLUDED }) {
    if (!container || typeof onReorder !== 'function' || !selector) return;
    container.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (isExcludedTarget(e.target, excluded)) return;
        const card = e.target.closest?.(selector);
        if (!card || !container.contains(card)) return;

        const startX = e.clientX;
        const startY = e.clientY;
        const isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
        let ghost = null;
        let dragging = false;
        let longPressTimer = null;
        let raf = 0;
        let lastClientY = startY;

        const cards = () => Array.from(container.querySelectorAll(selector)).filter(el => el.offsetParent !== null || el === card);
        const grabRect = card.getBoundingClientRect();
        const grabDx = startX - grabRect.left;
        const grabDy = startY - grabRect.top;

        const start = () => {
            if (dragging) return;
            dragging = true;
            ghost = card.cloneNode(true);
            ghost.classList.add('uris-drag-ghost');
            ghost.style.width = grabRect.width + 'px';
            ghost.style.minHeight = grabRect.height + 'px';
            document.body.appendChild(ghost);
            card.classList.add('uris-drag-source');
            card.style.touchAction = 'none';
            document.body.classList.add('uris-dragging-active');
            moveGhost(e.clientX, e.clientY);
            // Авто-скролл у краёв контейнера; в тестовом окружении rAF нет.
            if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(edgeScroll);
        };

        const moveGhost = (x, y) => {
            if (ghost) ghost.style.transform = `translate(${x - grabDx}px, ${y - grabDy}px)`;
        };

        const stopTimers = () => {
            if (longPressTimer !== null) { clearTimeout(longPressTimer); longPressTimer = null; }
            if (raf) { cancelAnimationFrame(raf); raf = 0; }
        };

        const cleanup = () => {
            stopTimers();
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', finish);
            document.removeEventListener('pointercancel', finish);
            window.removeEventListener('keydown', onEscape, true);
            ghost?.remove();
            ghost = null;
            card.classList.remove('uris-drag-source');
            card.style.touchAction = '';
            document.body.classList.remove('uris-dragging-active');
        };

        const onEscape = (ev) => { if (ev.key === 'Escape') cleanup(); };

        /** Индекс вставки: сколько живых карточек имеют центр выше курсора. */
        const insertionIndex = () => {
            const list = cards().filter(el => el !== card);
            let idx = 0;
            for (const el of list) {
                const r = el.getBoundingClientRect();
                if (r.top + r.height / 2 < lastClientY) idx++;
            }
            return idx;
        };

        const edgeScroll = () => {
            if (!dragging) return;
            const rect = container.getBoundingClientRect();
            if (lastClientY < rect.top + EDGE_SCROLL_ZONE) window.scrollBy?.(0, -8);
            else if (lastClientY > rect.bottom - EDGE_SCROLL_ZONE) window.scrollBy?.(0, 8);
            raf = requestAnimationFrame(edgeScroll);
        };

        const move = (ev) => {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            if (!dragging) {
                if (isTouch) return; // ждём long-press; не мешаем скроллу
                if (dx * dx + dy * dy < MOVE_THRESHOLD * MOVE_THRESHOLD) return;
                start();
            }
            ev.preventDefault?.();
            lastClientY = ev.clientY;
            moveGhost(ev.clientX, ev.clientY);
        };

        const finish = (ev) => {
            const wasDragging = dragging;
            cleanup();
            if (!wasDragging) return;
            ev?.preventDefault?.();
            const from = cards().indexOf(card);
            if (from === -1) return;
            const to = Math.min(insertionIndex(), cards().length - 1);
            if (to !== from) onReorder(from, to);
        };

        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', finish);
        document.addEventListener('pointercancel', finish);
        window.addEventListener('keydown', onEscape, true);

        if (isTouch) {
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                start();
            }, longPressMs);
        }
    });
}
