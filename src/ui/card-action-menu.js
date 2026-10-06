// @ts-check
/**
 * Card action menu + the long-press/contextmenu gesture (mobile UX pass,
 * docs/2026-10-03-mobile-ux-pass-design.md §1).
 *
 * One event covers every pointer: `contextmenu` fires on right-click (desktop)
 * AND on a long tap in Android Chrome; iOS Safari gets a 500ms pointer timer.
 * The menu itself reuses the .uris-picker-overlay chrome (the same surface the
 * copy menu and folder sheet use — it stacks above the lightbox): bottom sheet
 * below 768px, popover at the pointer above.
 *
 * Pure-ish by design: no imports beyond window.js scroll lock, fake-dom safe
 * (tests assign document.body and dispatch plain event objects).
 */
import { escapeHtml } from '../core.js';
import { lockBodyScroll, unlockBodyScroll } from './window.js';

/** Long-press hold time (iOS; Android/ПКМ arrive as contextmenu natively). */
export const LONG_PRESS_MS = 500;
/** Movement beyond this (px) cancels the pending long-press — it's a scroll. */
export const MOVE_THRESHOLD_PX = 8;
/** A menu-opened long tap must not also reach the card's own click handler. */
const CLICK_SUPPRESS_MS = 800;

let activeOverlay = null;

/**
 * Open the card action menu. A second call closes the first — exactly one
 * menu can be on screen.
 * @param {Object} opts
 * @param {string} [opts.title] small header inside the sheet
 * @param {{ id: string, icon: string, label: string, danger?: boolean, disabled?: boolean,
 *           onSelect?: () => void }[]} [opts.items]
 * @param {number|null} [opts.x] pointer position (desktop popover anchor)
 * @param {number|null} [opts.y]
 * @returns {{ close: () => void, overlay: HTMLElement }}
 */
export function openCardActionMenu({ title = '', items = [], x = null, y = null } = {}) {
    if (activeOverlay) closeActiveMenu();

    const overlay = document.createElement('div');
    overlay.className = 'uris-picker-overlay uris-crop-overlay uris-action-menu-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title || 'Действия');
    overlay.innerHTML = `
        <div class="uris-action-menu">
            <div class="uris-action-menu-grip"></div>
            ${title ? `<div class="uris-action-menu-title">${escapeHtml(title)}</div>` : ''}
            <div class="uris-action-menu-list">
                ${items.map(item => `
                    <button type="button" class="uris-action-menu-item${item.danger ? ' uris-action-menu-item-danger' : ''}"
                        data-id="${escapeHtml(item.id)}" ${item.disabled ? 'disabled' : ''}>
                        <i class="fa-solid ${escapeHtml(item.icon)}"></i>
                        <span>${escapeHtml(item.label)}</span>
                    </button>`).join('')}
            </div>
        </div>`;

    // Desktop: popover at the pointer (inline position; the mobile sheet is
    // placed by CSS and must not receive inline left/top).
    const desktop = typeof matchMedia === 'function' && matchMedia('(min-width: 768px)').matches;
    const dialog = overlay.querySelector('.uris-action-menu');
    if (desktop && x != null && y != null) {
        document.body.appendChild(overlay);
        // Clamp after layout so the popover never leaves the viewport.
        const vw = (typeof window !== 'undefined' && window.innerWidth) || 1024;
        const vh = (typeof window !== 'undefined' && window.innerHeight) || 768;
        const w = dialog.offsetWidth || 220, h = dialog.offsetHeight || 0;
        const left = Math.max(8, Math.min(x, vw - w - 8));
        const top = Math.max(8, Math.min(y, vh - h - 8));
        dialog.setAttribute('style', `left:${left}px;top:${top}px;`);
    } else {
        document.body.appendChild(overlay);
    }
    lockBodyScroll();

    const close = () => {
        document.removeEventListener('keydown', onKey, true);
        overlay.parentNode?.removeChild(overlay);
        unlockBodyScroll();
        if (activeOverlay === overlay) activeOverlay = null;
    };
    const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    document.addEventListener('keydown', onKey, true);
    activeOverlay = { overlay, close };
    function closeActiveMenu() { activeOverlay?.close(); }

    // Backdrop (the overlay itself) closes; clicks inside the dialog bubble
    // only after the target check, so item clicks are not double-handled.
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });
    overlay.querySelectorAll('.uris-action-menu-item').forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Реальный клик по пункту всплывает из <span>/<i> с target = ребёнок
            // кнопки — он обязан срабатывать (guard `e.target !== btn` глотал
            // именно его). Отсекается только каскадный клик фейк-дома: тот
            // диспатчит оверлей вниз к детям, и до кнопки доходит target-чужак.
            if (e.target && e.target !== btn && !btn.contains(e.target)) return;
            const item = items.find(entry => entry.id === btn.dataset.id);
            close();
            if (item) item.onSelect?.();
        });
    });
    return { overlay, close };
}

/**
 * Bind the unified card gesture to `el`: contextmenu (ПКМ + Android long tap)
 * and an iOS long-press timer. `onOpen({ x, y, isLongPress })` decides what to
 * open. A click following an opened long-press is swallowed once — the tap
 * that opened the menu must not also trigger the card's own action (view).
 * @param {HTMLElement} el
 * @param {(ctx: { x: number, y: number, isLongPress: boolean }) => void} onOpen
 */
export function bindCardContextMenu(el, onOpen) {
    let timer = null;
    let startX = 0, startY = 0;

    const stamp = () => { el.dataset.urisMenuAt = String(Date.now()); };
    const cancelTimer = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };

    // Swallow the synthetic click that follows an opened long-press (capture
    // phase, so the card's own bubble-phase handlers never see it).
    el.addEventListener('click', (e) => {
        const at = Number(el.dataset.urisMenuAt || 0);
        if (at && Date.now() - at < CLICK_SUPPRESS_MS) {
            e.preventDefault?.();
            e.stopPropagation?.();
        }
    }, true);

    el.addEventListener('contextmenu', (e) => {
        e.preventDefault?.();
        stamp();
        cancelTimer();
        // target: для делегированного биндинга на контейнере — резолв карточки
        // из цели события (обратно совместимо: старые колбэки поле игнорируют).
        onOpen({ x: e.clientX ?? 0, y: e.clientY ?? 0, isLongPress: false, target: e.target });
    });

    el.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;   // ПКМ уже покрыт contextmenu
        startX = e.clientX ?? 0;
        startY = e.clientY ?? 0;
        cancelTimer();
        timer = setTimeout(() => {
            timer = null;
            stamp();
            onOpen({ x: startX, y: startY, isLongPress: true, target: e.target });
        }, LONG_PRESS_MS);
    });
    el.addEventListener('pointermove', (e) => {
        if (timer === null) return;
        const dx = (e.clientX ?? 0) - startX, dy = (e.clientY ?? 0) - startY;
        if (dx * dx + dy * dy > MOVE_THRESHOLD_PX * MOVE_THRESHOLD_PX) cancelTimer();
    });
    el.addEventListener('pointerup', cancelTimer);
    el.addEventListener('pointercancel', cancelTimer);
}
