// @ts-check
/**
 * UR Image Studio — UI: Floating launcher button (FAB).
 * Перенос из DS Comments (src/ui/floating-launcher.js) с адаптацией:
 *   - иконка-эмодзи вместо icons.js, тексты по-русски (в URIS нет i18n);
 *   - слой --uris-z-fab НАД окном (как в DSC): FAB остаётся кликабельным
 *     тогглом поверх открытого окна и мобильного fullscreen-оверлея; модалки
 *     (3500), лайтбокс (5000) и хром ST его перекрывают;
 *   - пульс генерации — по uris:stage2-start/end и uris:inline-start/end
 *     (счётчик: гаснет только после ПОСЛЕДНЕЙ генерации; end в finally —
 *     пульс не зависает при ошибке/отмене). Биндинг живёт в index.js
 *     ensureLauncher() — безусловно, для любого launcherMode.
 *
 * Кнопка тянется (Pointer Events + capture, порог 6px отличает клик от драга),
 * позиция живёт в localStorage и валидируется при восстановлении; топ-бар ST
 * рисуется поверх FAB (3005 против --uris-z-fab) — drag/restore клэмпят
 * позицию ниже него, иначе кнопку можно «закатать» под бар и потерять.
 *
 * Выбор между FAB и кнопкой в QR-баре — настройка settings.launcherMode
 * ('bar' | 'floating' | 'both'), решает index.js ensureLauncher().
 */

import { DISPLAY_NAME } from '../core.js';
import { isPanelVisible, isMobileViewport, getStTopInsetPx } from './window.js';

const FAB_ID = 'uris_fab';
const POSITION_KEY = 'uris_fab_position';
const FAB_SIZE = 36;
// Pointer travel (px) that separates a click from a drag.
const DRAG_THRESHOLD_PX = 6;
// Default anchor offsets from the bottom-right corner; mobile clears #send_form.
const DEFAULT_RIGHT = 20;
const DEFAULT_BOTTOM = 80;
const DEFAULT_RIGHT_MOBILE = 16;
const DEFAULT_BOTTOM_MOBILE = 120;

// Toggle handler wired by index.js (toggleLauncherPanel). Stored at module level
// so re-mounts keep the same behaviour without re-passing it.
let _onToggle = null;
let _resizeBound = false;
let _stage2Bound = false;

function getFab() {
    return document.getElementById(FAB_ID);
}

function getViewport() {
    return { width: window.innerWidth, height: window.innerHeight };
}

// ── Position math (pure — unit-tested) ──

function defaultPosition(viewport, size, isMobile) {
    const right = isMobile ? DEFAULT_RIGHT_MOBILE : DEFAULT_RIGHT;
    const bottom = isMobile ? DEFAULT_BOTTOM_MOBILE : DEFAULT_BOTTOM;
    return {
        left: Math.max(0, viewport.width - size - right),
        top: Math.max(0, viewport.height - size - bottom),
    };
}

function clampPosition(pos, viewport, size) {
    return {
        left: Math.max(0, Math.min(pos.left, viewport.width - size)),
        top: Math.max(0, Math.min(pos.top, viewport.height - size)),
    };
}

// ST's top bar paints above the FAB (3005 vs --uris-z-fab — see style.css):
// measure how much of it covers the viewport top so positions can be clamped
// below it. Same measurement as the window drag clamp in window.js.
// Инсет приоритетен над «низом на экране» — паритет с clampWindowGeometry
// (window.js): в вырожденном случае (бар выше vh - size) кнопка уходит за
// нижний край, но НЕ под бар, который рисуется поверх и сделал бы её мёртвой.
function clampFabPosition(pos, viewport, size, topInset) {
    const clamped = clampPosition(pos, viewport, size);
    if (topInset > 0) {
        const inset = Math.min(topInset, Math.max(0, viewport.height - 1));
        clamped.top = Math.max(inset, Math.min(clamped.top, viewport.height - size));
    }
    return clamped;
}

function clampToViewportWithChrome(pos) {
    return clampFabPosition(pos, getViewport(), FAB_SIZE, getStTopInsetPx());
}

/**
 * Pick the mount position: the saved one when it is still fully inside the
 * viewport, the corner default otherwise.
 * @param {{left: number, top: number}|null} saved parsed localStorage payload
 */
function computeRestoredPosition(saved, viewport, size, isMobile) {
    if (saved
        && Number.isFinite(saved.left) && Number.isFinite(saved.top)
        && saved.left >= 0 && saved.top >= 0
        && saved.left + size <= viewport.width
        && saved.top + size <= viewport.height) {
        return { left: saved.left, top: saved.top };
    }
    return defaultPosition(viewport, size, isMobile);
}

// ── Position persistence ──

function restorePosition(icon) {
    let saved = null;
    try {
        const raw = localStorage.getItem(POSITION_KEY);
        if (raw) saved = JSON.parse(raw);
    } catch {
        try { localStorage.removeItem(POSITION_KEY); } catch { /* quota/private mode */ }
    }
    const pos = clampToViewportWithChrome(computeRestoredPosition(saved, getViewport(), FAB_SIZE, isMobileViewport()));
    icon.style.left = `${pos.left}px`;
    icon.style.top = `${pos.top}px`;
    icon.style.right = 'auto';
    icon.style.bottom = 'auto';
}

function persistPosition(icon) {
    try {
        localStorage.setItem(POSITION_KEY, JSON.stringify({
            left: parseFloat(icon.style.left),
            top: parseFloat(icon.style.top),
        }));
    } catch { /* quota/private mode — position just won't survive a restart */ }
}

// ── Drag (Pointer Events + capture) ──

function makeDraggable(icon) {
    let dragging = false;
    let offsetX = 0, offsetY = 0;
    let startX = 0, startY = 0;
    // Геометрия жеста: inset топ-бара и вьюпорт не меняются в течение драга.
    // Читаем один раз на pointerdown — иначе каждый pointermove делал
    // querySelector('#top-bar') + getBoundingClientRect (forced layout),
    // а мышей на 1000 Гц это тысячи reflow в секунду.
    let dragViewport = null;
    let dragTopInset = 0;

    icon.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        dragging = false;
        const r = icon.getBoundingClientRect();
        offsetX = e.clientX - r.left;
        offsetY = e.clientY - r.top;
        startX = r.left;
        startY = r.top;
        dragViewport = getViewport();
        dragTopInset = getStTopInsetPx();
        icon.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    icon.addEventListener('pointermove', (e) => {
        if (!icon.hasPointerCapture(e.pointerId)) return;
        const rawX = e.clientX - offsetX;
        const rawY = e.clientY - offsetY;
        if (!dragging && Math.hypot(rawX - startX, rawY - startY) > DRAG_THRESHOLD_PX) {
            dragging = true;
        }
        const pos = clampFabPosition({ left: rawX, top: rawY }, dragViewport, FAB_SIZE, dragTopInset);
        icon.style.left = `${pos.left}px`;
        icon.style.top = `${pos.top}px`;
    });

    icon.addEventListener('pointerup', (e) => {
        if (icon.hasPointerCapture(e.pointerId)) icon.releasePointerCapture(e.pointerId);
        const wasDragging = dragging;
        dragging = false;
        if (wasDragging) persistPosition(icon);
        else if (_onToggle) _onToggle();
    });

    icon.addEventListener('pointercancel', (e) => {
        if (icon.hasPointerCapture(e.pointerId)) icon.releasePointerCapture(e.pointerId);
        dragging = false;
    });

    icon.style.touchAction = 'none';
}

// Keep the FAB inside the viewport when the window shrinks under it.
function onWindowResize() {
    const icon = getFab();
    if (!icon) return;
    const left = parseFloat(icon.style.left);
    const top = parseFloat(icon.style.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;
    const pos = clampToViewportWithChrome({ left, top });
    icon.style.left = `${pos.left}px`;
    icon.style.top = `${pos.top}px`;
}

// ── Generation pulse (Stage 2 + inline lifecycle events) ──

/** Пульс на обоих лаунчерах (как у DSC: bar + FAB). */
function setGenerating(on) {
    for (const el of [document.getElementById('uris_launcher'), getFab()]) {
        if (el) el.classList.toggle('uris_generating', on);
    }
}

/**
 * Счётчик активных генераций: пульс живёт, пока не завершилась ПОСЛЕДНЯЯ.
 * Stage 2 сериализован per-post, auto-поток цепочку обходит — ручная
 * генерация может идти параллельно очереди, и булево от первого end гасило
 * пульс под живую генерацию (patterns как Set in-flight в
 * generation-lifecycle-ui.js). start/end парные у обоих эмиттеров
 * (end — в finally), счётчик не течёт и не уходит в минус.
 * @param {(on: boolean) => void} setPulse
 */
export function makePulseStateMachine(setPulse) {
    let runs = 0;
    return {
        // Срабатывание только на переходах 0→1 и 1→0: очередь шлёт stage2-start
        // на каждую задачу — без guard'а это bursts идемпотентных, но лишних
        // DOM-тогглов.
        start: () => { runs += 1; if (runs === 1) setPulse(true); },
        end: () => {
            if (runs === 0) return;
            runs -= 1;
            if (runs === 0) setPulse(false);
        },
    };
}

let _pulse = null;

/**
 * Один шов на все пути генерации: uris:stage2-start/end (ручные, авто,
 * очередь, мост) и uris:inline-start/end (inline-задачи чата). Биндится
 * БЕЗУСЛОВНО из index.js ensureLauncher(): пульсирует и бар-кнопка
 * (#uris_launcher.uris_generating), а не только FAB — раньше слушатели
 * вешались лишь при монтировании FAB, и в дефолтном launcherMode 'bar'
 * пульс не работал вовсе.
 */
export function bindStage2Pulse() {
    if (_stage2Bound) return;
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    _stage2Bound = true;
    _pulse = makePulseStateMachine(setGenerating);
    const onStart = () => _pulse?.start();
    const onEnd = () => _pulse?.end();
    window.addEventListener('uris:stage2-start', onStart);
    window.addEventListener('uris:stage2-end', onEnd);
    window.addEventListener('uris:inline-start', onStart);
    window.addEventListener('uris:inline-end', onEnd);
}

// ── Public API ──

/**
 * Mount (or re-sync) the floating launcher. Whether to mount at all is decided
 * by index.js ensureLauncher() from settings.launcherMode.
 * @param {{onToggle?: Function}} [opts]
 */
export function ensureFloatingLauncher({ onToggle } = {}) {
    if (onToggle) _onToggle = onToggle;
    let icon = getFab();
    if (!icon) {
        icon = document.createElement('div');
        icon.id = FAB_ID;
        icon.className = 'uris_fab';
        icon.tabIndex = 0;
        icon.setAttribute('role', 'button');
        icon.setAttribute('aria-label', DISPLAY_NAME);
        icon.title = `${DISPLAY_NAME} — клик: открыть/закрыть, тянуть: переместить`;
        icon.innerHTML = '<span aria-hidden="true">🎨</span>';

        icon.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (_onToggle) _onToggle();
            }
        });

        document.body.appendChild(icon);
        restorePosition(icon);
        makeDraggable(icon);
        if (!_resizeBound) {
            _resizeBound = true;
            window.addEventListener('resize', onWindowResize);
        }
    }
    syncFloatingLauncher();
    return icon;
}

/**
 * Refresh the active (panel-open) highlight. Called from ensureLauncher()
 * whenever launcher state changes.
 */
export function syncFloatingLauncher() {
    const icon = getFab();
    if (icon) icon.classList.toggle('uris_fab_active', isPanelVisible());
}

export function removeFloatingLauncher() {
    const icon = getFab();
    if (icon) icon.remove();
    if (_resizeBound) {
        _resizeBound = false;
        window.removeEventListener('resize', onWindowResize);
    }
}

// Test seam: pure position math (как setViewerForTests у tab-gallery).
export const _testFloatingLauncher = {
    defaultPosition, clampPosition, clampFabPosition, computeRestoredPosition,
    FAB_SIZE, DRAG_THRESHOLD_PX,
};
