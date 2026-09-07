// @ts-check
/**
 * Floating window: mount, drag (by header), resize (corner handle), mobile overlay.
 */
import { state, saveSettings, escapeHtml, error, showConfirmModal } from '../core.js';
import { exportDiagnosticDump } from '../diagnostic-dump.js';
import { listUrisErrors, clearUrisErrors, formatUrisError, recordUrisError } from '../error-pool.js';
import { listPendingBrowserRequests, discardPendingBrowserRequest, clearPendingBrowserRequests } from '../browser-image-recovery.js';

const WIN_ID = 'urisWindow';
export function isMobileViewport() { return window.innerWidth <= 768; }

// ── Body scroll lock ──────────────────────────────────────────────────────────
//
// re-entrant overlay scroll-lock. iOS Safari scrolls the background document
// under a `position:fixed` modal (react-modal #829, r/webdev consensus). We
// freeze <body> while any overlay is open. Depth counter supports nested
// overlays (lightbox inside picker, etc.): only the last close releases.
let _overlayDepth = 0;
let _savedBodyOverflow = null;

export function lockBodyScroll() {
    if (_overlayDepth === 0 && typeof document !== 'undefined' && document.body && document.body.style) {
        _savedBodyOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
    }
    _overlayDepth += 1;
}

export function unlockBodyScroll() {
    if (_overlayDepth === 0) return;
    _overlayDepth -= 1;
    if (_overlayDepth === 0 && typeof document !== 'undefined' && document.body && document.body.style) {
        document.body.style.overflow = _savedBodyOverflow || '';
        _savedBodyOverflow = null;
    }
}

export function mountPanel() {
    let el = document.getElementById(WIN_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = WIN_ID;
    el.className = 'uris-window';
    el.innerHTML = `
        <div class="uris-header" id="urisHeader">
            <span class="uris-title">🎨 UR Image Studio</span>
            <div class="uris-header-actions">
                <span class="uris-status" id="urisStatus"></span>
                <button class="uris-icon-btn uris-error-badge" id="urisErrorBadge" hidden title="Ошибки и незавершённые запросы" aria-label="Ошибки и незавершённые запросы" aria-expanded="false" aria-controls="urisErrorPanel">ERR <span class="uris-error-count" id="urisErrorCount">0</span></button>
                <button class="uris-icon-btn" id="urisExportDumps" title="Выгрузить диагностику (только метаданные)" aria-label="Выгрузить диагностику (только метаданные)">📥</button>
                <button class="uris-icon-btn" id="urisClose" title="Свернуть" aria-label="Свернуть">✕</button>
            </div>
        </div>
        <div class="uris-error-panel" id="urisErrorPanel" role="dialog" aria-label="Ошибки и незавершённые запросы" hidden></div>
        <div class="uris-tabs" id="urisTabs"></div>
        <div class="uris-body" id="urisBody"></div>
        <div class="uris-resizer" id="urisResizer"></div>`;
    document.body.appendChild(el);
    bindWindowEvents(el);
    bindErrorPool(el);
    applyMobileClass(el);   // inside: on mobile clears inline styles + measureStChrome
    if (!isMobileViewport()) restoreGeometry(el);
    return el;
}

export function removePanel() {
    _dragCleanup?.();
    _resizeCleanup?.();
    _dragCleanup = null;
    _resizeCleanup = null;
    if (_errorPoolHandler && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('uris:errors', _errorPoolHandler);
        _errorPoolHandler = null;
    }
    if (_pendingHandler && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('uris:pending-changed', _pendingHandler);
        _pendingHandler = null;
    }
    if (_errorOutsideHandler && typeof document !== 'undefined') {
        document.removeEventListener('click', _errorOutsideHandler);
        _errorOutsideHandler = null;
    }
    if (_errorKeyHandler && typeof document !== 'undefined') {
        document.removeEventListener('keydown', _errorKeyHandler);
        _errorKeyHandler = null;
    }
    document.getElementById(WIN_ID)?.remove();
}

export function isPanelVisible() {
    const el = document.getElementById(WIN_ID);
    return !!el && !el.classList.contains('uris-hidden');
}

export function syncPanelVisibility() {
    const el = document.getElementById(WIN_ID);
    if (!el) return;
    el.classList.toggle('uris-hidden', state.settings.collapsed);
    // Re-apply mobile class on open: mountPanel() does an early-return if #urisWindow
    // already exists, so without this the class is not updated on re-open and may be stale
    // (orientation changed / desktop↔mobile switch while the window was hidden).
    if (!state.settings.collapsed) applyMobileClass(el);
    const launcher = document.getElementById('uris_launcher');
    if (launcher) launcher.classList.toggle('uris_launcher_active', !state.settings.collapsed);
}

// ── Mobile mode: full-screen panel ──
// Toggles .uris-mobile class AND clears inline styles that drag/resize
// may have written in desktop mode. Without clearing, inline wins over CSS
// (mobile rules without !important lose to inline width/height/left/top), and
// the window stays 460×560 in the corner instead of full-screen. Analogous to DS Comments
// applyMobileMode(). On mobile→desktop transition, restores geometry.
function applyMobileClass(el) {
    const wasMobile = el.classList.contains('uris-mobile');
    const mobile = isMobileViewport();
    el.classList.toggle('uris-mobile', mobile);
    if (mobile) {
        el.style.transform = '';
        el.style.left = ''; el.style.top = '';
        el.style.right = ''; el.style.bottom = '';
        el.style.width = ''; el.style.height = '';
        measureStChrome();
    } else if (wasMobile) {
        restoreGeometry(el);
    }
}

// ── SillyTavern chrome measurement (mobile insets) ──
// ST has fixed bars #top-bar (top) and #send_form (bottom) that
// overlap our window (z-index). Record their heights as CSS custom properties on
// <html>, mobile CSS uses them via calc() for offsets. Outside ST
// the variables are not set → CSS fallback 0px → window occupies the full viewport.
const ST_TOPBAR_SEL = '#top-bar';
const ST_SENDFORM_SEL = '#send_form';
function measureStChrome() {
    const root = document.documentElement;
    if (!root) return;
    let topH = 0;
    const topBar = document.querySelector(ST_TOPBAR_SEL);
    if (topBar) {
        const r = topBar.getBoundingClientRect();
        topH = r.bottom > 0 ? Math.min(r.bottom, window.innerHeight) : 0;
        if (!Number.isFinite(topH) || topH <= 0) topH = 40;
    }
    let bottomH = 0;
    const sendForm = document.querySelector(ST_SENDFORM_SEL);
    if (sendForm) {
        const r = sendForm.getBoundingClientRect();
        bottomH = Math.max(0, Math.min(r.height, window.innerHeight));
        if (!Number.isFinite(bottomH) || bottomH <= 0) bottomH = 120;
    }
    root.style.setProperty('--uris-st-top', `${Math.round(topH)}px`);
    root.style.setProperty('--uris-st-bottom', `${Math.round(bottomH)}px`);
}

let _viewportTimer = null;
let _viewportHandler = null;
let _errorPoolHandler = null;
let _pendingHandler = null;
let _errorOutsideHandler = null;
let _errorKeyHandler = null;
let _dragCleanup = null;
let _resizeCleanup = null;
export function initViewportSync() {
    if (_viewportHandler) window.removeEventListener('resize', _viewportHandler);
    if (_viewportTimer) { clearTimeout(_viewportTimer); _viewportTimer = null; }
    _viewportHandler = () => {
        // Debounce 200ms — resize on mobile (URL-bar show/hide) fires frequently.
        clearTimeout(_viewportTimer);
        _viewportTimer = setTimeout(() => {
            const el = document.getElementById(WIN_ID);
            if (el && !el.classList.contains('uris-hidden')) applyMobileClass(el);
        }, 200);
    };
    window.addEventListener('resize', _viewportHandler);
}
export function removeViewportSync() {
    if (_viewportHandler) { window.removeEventListener('resize', _viewportHandler); _viewportHandler = null; }
    if (_viewportTimer) { clearTimeout(_viewportTimer); _viewportTimer = null; }
}

function restoreGeometry(el) {
    const g = state.settings.windowGeometry;
    if (!g || isMobileViewport()) return;
    // Clamp to viewport: otherwise the window restores outside the screen
    // (geometry saved on a second monitor / viewport changed).
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(Math.max(320, g.width), vw);
    const h = Math.min(Math.max(360, g.height), vh);
    const left = Math.max(0, Math.min(g.left, vw - 100));
    const top = Math.max(0, Math.min(g.top, vh - 100));
    el.style.left = left + 'px'; el.style.top = top + 'px';
    el.style.width = w + 'px'; el.style.height = h + 'px';
    el.style.right = 'auto'; el.style.bottom = 'auto';
}

function saveGeometry(el) {
    if (isMobileViewport()) return;
    const r = el.getBoundingClientRect();
    state.settings.windowGeometry = { left: r.left, top: r.top, width: r.width, height: r.height };
    saveSettings();
}

function bindWindowEvents(el) {
    el.querySelector('#urisClose').addEventListener('click', () => {
        state.settings.collapsed = true; saveSettings(); syncPanelVisibility();
    });
    el.querySelector('#urisExportDumps').addEventListener('click', () => {
        exportDiagnosticDump().catch(e => {
            error('exportDiagnosticDump:', e);
            recordUrisError({ scope: 'Диагностика', message: e?.message || String(e) });
            toastr?.error('Ошибка выгрузки диагностики: ' + (e?.message || e), 'UR Image Studio');
        });
    });
    const header = el.querySelector('#urisHeader');
    header.addEventListener('mousedown', (e) => startDrag(e, el));
    header.addEventListener('touchstart', (e) => startDrag(e, el), { passive: true });
    const resizer = el.querySelector('#urisResizer');
    resizer.addEventListener('mousedown', (e) => startResize(e, el));
}

// ── Error pool badge + panel ──

/**
 * Render the error panel body from the current pool.
 * @param {HTMLElement} winEl the #urisWindow element
 */
function pendingStatusLabel(item) {
    const labels = {
        notStarted: 'не отправлен',
        rejectedBeforeDispatch: 'отклонён до отправки',
        dispatchingUnknown: 'результат запроса неизвестен',
        resultReceived: 'ответ получен, сохранение не завершено',
    };
    return labels[item?.status] || item?.status || 'неизвестный статус';
}

function renderPendingRows(items) {
    return items.length
        ? items.slice().reverse().map(item => `<div class="uris-error-row"><span><strong>${escapeHtml(pendingStatusLabel(item))}</strong><small>${escapeHtml(item.error || item.requestId || item.id || '')}</small></span><button type="button" class="uris-btn uris-btn-ghost uris-pending-discard" data-pending-id="${escapeHtml(item.id)}" title="Удалить запись без повторной отправки" aria-label="Удалить запись без повторной отправки">×</button></div>`).join('')
        : '<div class="uris-error-row uris-error-empty">Нет записей</div>';
}

function renderErrorPanel(winEl, errors, pending = []) {
    const panel = winEl?.querySelector?.('#urisErrorPanel');
    if (!panel) return;
    const errorRows = errors.length
        ? errors.slice().reverse().map(entry => `<div class="uris-error-row">${escapeHtml(formatUrisError(entry))}</div>`).join('')
        : '<div class="uris-error-row uris-error-empty">Ошибок текущей сессии нет</div>';
    const preDispatch = pending.filter(item => item.status === 'notStarted');
    const uncertain = pending.filter(item => item.status !== 'notStarted');
    panel.innerHTML = `<section class="uris-error-section"><h3>Ошибки текущей сессии</h3><div class="uris-error-rows">${errorRows}</div></section>
        <section class="uris-error-section"><h3>Результат/сохранение не завершено</h3><div class="uris-error-rows">${renderPendingRows(uncertain)}</div></section>
        <section class="uris-error-section"><h3>Неотправленные операции</h3><div class="uris-error-rows">${renderPendingRows(preDispatch)}</div></section>
        <div class="uris-error-panel-actions"><button type="button" class="uris-btn uris-btn-ghost" id="urisErrorClear">Очистить ошибки</button><button type="button" class="uris-btn uris-btn-ghost" id="urisPendingClear">Удалить recovery</button></div>`;
    panel.querySelectorAll('[data-pending-id]').forEach(button => button.addEventListener('click', async () => {
        button.disabled = true;
        try { await discardPendingBrowserRequest(button.dataset.pendingId); }
        catch (e) { error('discard pending:', e); recordUrisError({ scope: 'Recovery', message: e?.message || String(e) }); }
    }));
    panel.querySelector('#urisPendingClear')?.addEventListener('click', async () => {
        try {
            const confirmed = await showConfirmModal('Удалить все незавершённые recovery-записи?\n\nЭто не повторяет запросы и удаляет только локальные записи о неопределённом результате.');
            if (!confirmed) return;
            await clearPendingBrowserRequests();
        } catch (e) {
            error('clear pending:', e);
            recordUrisError({ scope: 'Recovery', message: e?.message || String(e) });
        }
    });
}

export async function refreshErrorPanel(winEl) {
    const pending = await listPendingBrowserRequests();
    renderErrorPanel(winEl, listUrisErrors(), pending);
}

function bindErrorPool(el) {
    const badge = el.querySelector('#urisErrorBadge');
    const panel = el.querySelector('#urisErrorPanel');
    if (!badge || !panel) return;
    let refreshSeq = 0;
    const positionPanel = () => {
        if (panel.hidden || isMobileViewport()) return;
        const rect = badge.getBoundingClientRect();
        panel.style.top = `${Math.max(8, rect.bottom + 6)}px`;
        panel.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    };
    const sync = async () => {
        const seq = ++refreshSeq;
        positionPanel();
        const pending = await listPendingBrowserRequests();
        const errors = listUrisErrors();
        if (seq !== refreshSeq || (el.isConnected === false)) return;
        const count = errors.length + pending.length;
        badge.hidden = count === 0;
        badge.title = pending.length
            ? `Ошибки и ${pending.length} незавершённый запрос`
            : 'Ошибки';
        badge.setAttribute('aria-expanded', String(!panel.hidden));
        el.querySelector('#urisErrorCount').textContent = String(count);
        if (!panel.hidden) {
            renderErrorPanel(el, errors, pending);
            panel.querySelector('#urisErrorClear')?.addEventListener('click', () => {
                clearUrisErrors();
                sync();
            });
        }
    }; 
    badge.addEventListener('click', async event => {
        event.stopPropagation();
        panel.hidden = !panel.hidden;
        await sync();
    });
    _errorOutsideHandler = event => {
        if (!panel.hidden && !panel.contains(event.target) && event.target !== badge) {
            panel.hidden = true;
            badge.setAttribute('aria-expanded', 'false');
        }
    };
    _errorKeyHandler = event => {
        if (event.key === 'Escape' && !panel.hidden) {
            panel.hidden = true;
            badge.setAttribute('aria-expanded', 'false');
            badge.focus?.();
        }
    };
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        if (_errorPoolHandler) window.removeEventListener('uris:errors', _errorPoolHandler);
        if (_pendingHandler) window.removeEventListener('uris:pending-changed', _pendingHandler);
        _errorPoolHandler = sync;
        _pendingHandler = sync;
        window.addEventListener('uris:errors', _errorPoolHandler);
        window.addEventListener('uris:pending-changed', _pendingHandler);
        document.addEventListener('click', _errorOutsideHandler);
        document.addEventListener('keydown', _errorKeyHandler);
    }
    sync();
}

function startDrag(e, el) {
    if (isMobileViewport()) return;
    if (e.target.closest('.uris-icon-btn')) return;
    const p = point(e);
    const r = el.getBoundingClientRect();
    const dx = p.x - r.left, dy = p.y - r.top;
    const move = (ev) => {
        const np = point(ev);
        el.style.left = Math.max(0, np.x - dx) + 'px';
        el.style.top = Math.max(0, np.y - dy) + 'px';
        el.style.right = 'auto'; el.style.bottom = 'auto';
    };
    const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.removeEventListener('touchmove', move);
        document.removeEventListener('touchend', up);
        if (_dragCleanup === up) _dragCleanup = null;
        saveGeometry(el);
    };
    _dragCleanup = up;
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', move, { passive: true });
    document.addEventListener('touchend', up);
}

function startResize(e, el) {
    e.stopPropagation(); e.preventDefault();
    const p = point(e);
    const r = el.getBoundingClientRect();
    const sw = r.width, sh = r.height;
    const move = (ev) => {
        const np = point(ev);
        const maxWidth = Math.max(320, window.innerWidth - Math.max(0, r.left));
        const maxHeight = Math.max(360, window.innerHeight - Math.max(0, r.top));
        el.style.width = Math.min(maxWidth, Math.max(320, sw + (np.x - p.x))) + 'px';
        el.style.height = Math.min(maxHeight, Math.max(360, sh + (np.y - p.y))) + 'px';
    };
    const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (_resizeCleanup === up) _resizeCleanup = null;
        saveGeometry(el);
    };
    _resizeCleanup = up;
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
}

function point(e) {
    if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
}

export function setStatus(text) {
    const el = document.getElementById('urisStatus');
    if (el) el.textContent = text || '';
}
