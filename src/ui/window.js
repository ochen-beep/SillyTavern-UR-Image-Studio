// @ts-check
/**
 * Floating window: mount, drag (by header), resize (corner handle), mobile overlay.
 */
import { state, saveSettings, escapeHtml, error, showConfirmModal } from '../core.js';
import { exportDiagnosticDump } from '../diagnostic-dump.js';
import { listUrisErrors, clearUrisErrors, formatUrisError, recordUrisError } from '../error-pool.js';
import { listPendingBrowserRequests, discardPendingBrowserRequest, clearPendingBrowserRequests } from '../browser-image-recovery.js';
import { bindTabBarScroll } from './tab-bar-scroll.js';
import { listQueueLog, queueBadgeCount, clearQueueLog, noteQueued, noteRunning, noteFinished, hasLiveQueueLane, laneFromSource } from './queue-log.js';
import { stopQueue } from '../pipeline-queue.js';

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
                <button class="uris-icon-btn uris-error-badge" id="urisQueueBadge" hidden title="Очередь генераций" aria-label="Очередь генераций" aria-expanded="false" aria-controls="urisQueuePanel">QUEUE <span class="uris-error-count" id="urisQueueCount">0</span></button>
                <button class="uris-icon-btn uris-error-badge" id="urisErrorBadge" hidden title="События и незавершённые запросы" aria-label="События и незавершённые запросы" aria-expanded="false" aria-controls="urisErrorPanel">INFO <span class="uris-error-count" id="urisErrorCount">0</span></button>
                <button class="uris-icon-btn" id="urisExportDumps" title="Выгрузить диагностику (только метаданные)" aria-label="Выгрузить диагностику (только метаданные)">📥</button>
                <button class="uris-icon-btn" id="urisClose" title="Свернуть" aria-label="Свернуть">✕</button>
            </div>
        </div>
        <div class="uris-error-panel" id="urisQueuePanel" role="dialog" aria-label="Очередь генераций" hidden></div>
        <div class="uris-error-panel" id="urisErrorPanel" role="dialog" aria-label="Ошибки и незавершённые запросы" hidden></div>
        <div class="uris-tabs" id="urisTabs"></div>
        <div class="uris-body" id="urisBody"></div>
        <div class="uris-resizer" id="urisResizer"></div>`;
    document.body.appendChild(el);
    bindWindowEvents(el);
    bindErrorPool(el);
    bindQueueBadge(el);
    applyMobileClass(el);   // inside: on mobile clears inline styles + measureStChrome
    if (!isMobileViewport()) restoreGeometry(el);
    return el;
}

export function removePanel() {
    _dragCleanup?.();
    _resizeCleanup?.();
    _tabBarScrollCleanup?.();
    _dragCleanup = null;
    _resizeCleanup = null;
    _tabBarScrollCleanup = null;
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
    if (_windowKeyHandler && typeof document !== 'undefined') {
        document.removeEventListener('keydown', _windowKeyHandler, true);
        _windowKeyHandler = null;
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
    // FAB синхронизируется по id напрямую (как launcher выше) — без импорта
    // floating-launcher.js, чтобы не создавать цикл (FAB импортирует window.js).
    const fab = document.getElementById('uris_fab');
    if (fab) fab.classList.toggle('uris_fab_active', !state.settings.collapsed);
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

// Сколько пикселей вьюпорта сверху перекрыто топ-баром ST. Бар рисуется НАД
// окном (3005 против --uris-z-window, см. :root в style.css), поэтому окно,
// запаркованное в верхнюю полосу, уезжает под него и становится некликабельным —
// drag/restore клэмпят top ниже этой границы (та же причина, что у FAB в DS Comments).
function getStTopInsetPx() {
    const topBar = document.querySelector(ST_TOPBAR_SEL);
    if (!topBar) return 0;
    const r = topBar.getBoundingClientRect();
    const bottom = r.bottom > 0 ? Math.min(r.bottom, window.innerHeight) : 0;
    return Number.isFinite(bottom) && bottom > 0 ? bottom : 0;
}
export { getStTopInsetPx };
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
let _scrollClampFrame = null;
let _scrollClampHandler = null;
let _errorPoolHandler = null;
let _pendingHandler = null;
let _errorOutsideHandler = null;
let _errorKeyHandler = null;
let _dragCleanup = null;
let _resizeCleanup = null;
let _tabBarScrollCleanup = null;
let _windowKeyHandler = null;
function clampOpenWindow() {
    const el = document.getElementById(WIN_ID);
    if (el && !el.classList.contains('uris-hidden')) clampWindowToViewport(el);
}

export function initViewportSync() {
    if (_viewportHandler) window.removeEventListener('resize', _viewportHandler);
    if (_scrollClampHandler) window.removeEventListener('scroll', _scrollClampHandler);
    if (_viewportTimer) { clearTimeout(_viewportTimer); _viewportTimer = null; }
    if (_scrollClampFrame) { cancelAnimationFrame(_scrollClampFrame); _scrollClampFrame = null; }
    _viewportHandler = () => {
        // Debounce 200ms — resize on mobile (URL-bar show/hide) fires frequently.
        clearTimeout(_viewportTimer);
        _viewportTimer = setTimeout(() => {
            const el = document.getElementById(WIN_ID);
            if (el && !el.classList.contains('uris-hidden')) {
                applyMobileClass(el);
                // Desktop geometry is inline px, so a shrunken viewport (or the
                // mobile→desktop restore inside applyMobileClass) can leave the
                // header off-screen. Re-clamp after the class settles.
                clampWindowToViewport(el);
            }
        }, 200);
    };
    // ST's `-webkit-transform` on <html> makes it the containing block for
    // position:fixed, so the window rides document scroll. Clamp on the scroll
    // itself (rAF-throttled — scroll fires per frame) to keep the header reachable.
    _scrollClampHandler = () => {
        if (_scrollClampFrame) return;
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : fn => setTimeout(fn, 16);
        _scrollClampFrame = raf(() => { _scrollClampFrame = null; clampOpenWindow(); });
    };
    window.addEventListener('resize', _viewportHandler);
    window.addEventListener('scroll', _scrollClampHandler, { passive: true });
}
export function removeViewportSync() {
    if (_viewportHandler) { window.removeEventListener('resize', _viewportHandler); _viewportHandler = null; }
    if (_scrollClampHandler) { window.removeEventListener('scroll', _scrollClampHandler); _scrollClampHandler = null; }
    if (_viewportTimer) { clearTimeout(_viewportTimer); _viewportTimer = null; }
    if (_scrollClampFrame) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(_scrollClampFrame);
        _scrollClampFrame = null;
    }
}

// Минимум окна, видимый на экране: шапка с кнопками должна оставаться
// достижимой, даже если геометрия сохранена на втором мониторе или окно уехало
// со скроллом страницы (см. clampWindowToViewport).
const MIN_WIDTH = 320;
const MIN_HEIGHT = 360;
const MIN_VISIBLE_PX = 100;

/**
 * Pure clamp of a floating window rect into the viewport.
 *
 * SillyTavern sets `-webkit-transform: translateZ(0)` on <html>
 * (public/style.css), which makes <html> the containing block for
 * `position: fixed`. A window opened while the chat is scrolled therefore
 * rides the page and its header can leave the viewport entirely. The clamp
 * keeps at least MIN_VISIBLE_PX of the window reachable from every edge and
 * pushes the header below the ST top bar, which paints above the window.
 *
 * @param {{left:number, top:number, width:number, height:number}} rect
 * @param {{width:number, height:number}} viewport
 * @param {{topInset?:number}} [opts]
 * @returns {{left:number, top:number, width:number, height:number}}
 */
export function clampWindowGeometry(rect, viewport, { topInset = 0 } = {}) {
    const vw = Math.max(0, Number(viewport?.width) || 0);
    const vh = Math.max(0, Number(viewport?.height) || 0);
    const inset = Math.max(0, Math.min(Number(topInset) || 0, Math.max(0, vh - 1)));
    const width = Math.min(Math.max(MIN_WIDTH, Number(rect?.width) || MIN_WIDTH), vw || MIN_WIDTH);
    const height = Math.min(Math.max(MIN_HEIGHT, Number(rect?.height) || MIN_HEIGHT), vh || MIN_HEIGHT);
    const minLeft = Math.min(0, vw - width);
    const maxLeft = Math.max(minLeft, vw - MIN_VISIBLE_PX);
    const minTop = inset;
    const maxTop = Math.max(minTop, vh - MIN_VISIBLE_PX);
    const left = Math.min(maxLeft, Math.max(minLeft, Number(rect?.left) || 0));
    const top = Math.min(maxTop, Math.max(minTop, Number(rect?.top) || 0));
    return { left, top, width, height };
}

function clampWindowToViewport(el) {
    if (!el || isMobileViewport()) return;
    const r = el.getBoundingClientRect();
    const next = clampWindowGeometry(
        { left: r.left, top: r.top, width: r.width, height: r.height },
        { width: window.innerWidth, height: window.innerHeight },
        { topInset: getStTopInsetPx() },
    );
    if (next.left === r.left && next.top === r.top && next.width === r.width && next.height === r.height) return;
    el.style.left = next.left + 'px';
    el.style.top = next.top + 'px';
    el.style.width = next.width + 'px';
    el.style.height = next.height + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
}

function restoreGeometry(el) {
    const g = state.settings.windowGeometry;
    if (!g || isMobileViewport()) return;
    const next = clampWindowGeometry(
        { left: g.left, top: g.top, width: g.width, height: g.height },
        { width: window.innerWidth, height: window.innerHeight },
        { topInset: getStTopInsetPx() },
    );
    el.style.left = next.left + 'px'; el.style.top = next.top + 'px';
    el.style.width = next.width + 'px'; el.style.height = next.height + 'px';
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
    // Pointer Events (как у плавающего лаунчера): один жест покрывает мышь, перо
    // и палец. Раньше шапка слушала touchstart с passive:true — страница
    // скроллилась под пальцем, а ресайзер не слушал тач вовсе.
    header.addEventListener('pointerdown', (e) => startDrag(e, el));
    const resizer = el.querySelector('#urisResizer');
    resizer.addEventListener('pointerdown', (e) => startResize(e, el));
    bindWindowEscape(el);
    // Колесо мыши + drag-to-scroll на таб-баре: при узком окне вкладки
    // переполняют бар, и без этого хвостовые вкладки недостижимы на десктопе.
    _tabBarScrollCleanup?.();
    _tabBarScrollCleanup = bindTabBarScroll(el.querySelector('#urisTabs'), el.ownerDocument);
}

// ── Escape сворачивает окно ──
//
// Единственный выход из окна был «Свернуть» в шапке. Escape уже закрывает
// собственные оверлеи расширения (панель ошибок, кроп, выбор папки, лайтбокс) —
// они слушают keydown в capture-фазе и зовут stopPropagation, поэтому сюда
// событие от них не доходит. SillyTavern на том же Escape закрывает свои панели
// (RossAscends-mods.js, document keydown, bubble-фаза) и сама отступает, когда
// открыт редактор сообщения или идёт стрим. Поэтому окно сворачивается только
// если фокус внутри него: Escape из поля ввода чата остаётся таверне.

function collapseWindow() {
    if (state.settings.collapsed) return;
    state.settings.collapsed = true;
    saveSettings();
    syncPanelVisibility();
}

function bindWindowEscape(winEl) {
    if (_windowKeyHandler && typeof document !== 'undefined') {
        document.removeEventListener('keydown', _windowKeyHandler, true);
    }
    _windowKeyHandler = (event) => {
        if (event.key !== 'Escape') return;
        if (!isPanelVisible()) return;
        const target = event.target;
        if (!target || typeof winEl.contains !== 'function' || !winEl.contains(target)) return;
        event.preventDefault();
        collapseWindow();
    };
    if (typeof document !== 'undefined') document.addEventListener('keydown', _windowKeyHandler, true);
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
    // Действия вынесены наверх: панели с записями могут быть длинными, кнопки
    // не должны требовать прокрутки.
    panel.innerHTML = `<div class="uris-error-panel-actions"><button type="button" class="uris-btn uris-btn-ghost" id="urisErrorClear">Очистить события</button><button type="button" class="uris-btn uris-btn-ghost" id="urisPendingClear">Удалить recovery</button></div>
        <section class="uris-error-section"><h3>Ошибки текущей сессии</h3><div class="uris-error-rows">${errorRows}</div></section>
        <section class="uris-error-section"><h3>Результат/сохранение не завершено</h3><div class="uris-error-rows">${renderPendingRows(uncertain)}</div></section>
        <section class="uris-error-section"><h3>Неотправленные операции</h3><div class="uris-error-rows">${renderPendingRows(preDispatch)}</div></section>`;
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

const QUEUE_STATUS_TEXT = { waiting: 'ждёт', running: 'выполняется', done: 'готово' };

function renderQueuePanel(winEl) {
    const panel = winEl?.querySelector?.('#urisQueuePanel');
    if (!panel) return;
    const rows = listQueueLog();
    const body = rows.length
        ? rows.slice().reverse().map(row => {
            const tone = row.tone === 'ok' ? ' uris-queue-ok' : row.tone === 'fail' ? ' uris-queue-fail' : '';
            const detail = row.detail ? `<small>${escapeHtml(row.detail)}</small>` : '';
            return `<div class="uris-error-row uris-queue-row${tone}"><span>${escapeHtml(row.label)} — ${QUEUE_STATUS_TEXT[row.status] || ''}</span>${detail}</div>`;
        }).join('')
        : '<div class="uris-error-row uris-error-empty">Очередь пуста</div>';
    // «Остановить очередь» живёт здесь (единственное место очереди в UI после
    // слияния со статус-строкой вкладки): гасит пачечную очередь — текущая
    // задача отменяется, ожидающие отклоняются. Ручные/авто-генерации не трогает.
    const stopBtn = hasLiveQueueLane()
        ? '<button type="button" class="uris-btn uris-btn-ghost" id="urisQueueStopLane" title="Отменить текущую задачу и ожидающие задачи пачечной очереди">Остановить очередь</button>'
        : '';
    panel.innerHTML = `<div class="uris-error-panel-actions">${stopBtn}<button type="button" class="uris-btn uris-btn-ghost" id="urisQueueClear">Очистить завершённые</button></div>
        <section class="uris-error-section"><h3>Генерации</h3><div class="uris-error-rows">${body}</div></section>`;
    panel.querySelector('#urisQueueStopLane')?.addEventListener('click', () => stopQueue());
    panel.querySelector('#urisQueueClear')?.addEventListener('click', () => clearQueueLog());
}

/**
 * Бейдж QUEUE рядом с INFO. Цифра — живые генерации (ждут или выполняются),
 * прячется, когда живых нет. Лента помнит и завершённые: успех зелёным,
 * неудача красным, отмена без заливки.
 *
 * Пакетная очередь пишет в журнал сама (строки с лейном 'queue', включая
 * переход waiting → running через onStart элемента). Остальные пути
 * синтезируются здесь по событиям старта и финиша: ручные/авто stage2,
 * инлайн-задачи (uris:inline-*), мостовые вызовы (source external:*).
 */
function bindQueueBadge(el) {
    const badge = el.querySelector('#urisQueueBadge');
    const panel = el.querySelector('#urisQueuePanel');
    if (!badge || !panel) return;
    const sync = () => {
        const count = queueBadgeCount();
        badge.hidden = count === 0;
        badge.setAttribute('aria-expanded', String(!panel.hidden));
        el.querySelector('#urisQueueCount').textContent = String(count);
        if (!panel.hidden) {
            // Как у панели INFO: лист открывается под своим бейджем, а не в
            // углу вьюпорта. На мобиле позицию задаёт CSS.
            if (!isMobileViewport()) {
                const rect = badge.getBoundingClientRect();
                panel.style.top = `${Math.max(8, rect.bottom + 6)}px`;
                panel.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
            }
            renderQueuePanel(el);
        }
    };
    const postLabel = (msgId, fallback = 'Генерация') => {
        const post = Number(msgId);
        return Number.isFinite(post) && post >= 0 ? `Пост #${post + 1}` : fallback;
    };
    const onStart = (ev) => {
        const detail = ev.detail || {};
        // Очередь уже завела свою строку (lane 'queue') в enqueueGeneration.
        if (!detail.requestId || detail.source === 'queue') return;
        noteQueued({ id: detail.requestId, label: postLabel(detail.msgId), lane: laneFromSource(detail.source) });
        noteRunning(detail.requestId);
    };
    const onEnd = (ev) => {
        const detail = ev.detail || {};
        if (!detail.requestId) return;
        const outcome = detail.outcome === 'error' ? 'error' : detail.outcome === 'cancelled' ? 'cancelled' : 'success';
        noteFinished(detail.requestId, outcome, detail.error || '');
    };
    const onInlineQueued = (ev) => {
        const detail = ev.detail || {};
        if (!detail.requestId) return;
        noteQueued({ id: detail.requestId, label: postLabel(detail.msgId, 'Инлайн'), lane: 'auto' });
    };
    const onInlineStart = (ev) => {
        const detail = ev.detail || {};
        if (!detail.requestId) return;
        // noteQueued идемпотентен по id: прямой processJob без queued-события
        // всё равно попадёт в ленту, а задвоения не будет.
        noteQueued({ id: detail.requestId, label: postLabel(detail.msgId, 'Инлайн'), lane: 'auto' });
        noteRunning(detail.requestId);
    };
    const onInlineEnd = (ev) => {
        const detail = ev.detail || {};
        if (!detail.requestId) return;
        const outcome = detail.outcome === 'error' ? 'error' : detail.outcome === 'cancelled' ? 'cancelled' : 'success';
        noteFinished(detail.requestId, outcome, detail.error || '');
    };
    badge.addEventListener('click', event => {
        event.stopPropagation();
        panel.hidden = !panel.hidden;
        const infoPanel = el.querySelector('#urisErrorPanel');
        if (infoPanel && !panel.hidden) infoPanel.hidden = true;
        sync();
    });
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('uris:queue', sync);
        window.addEventListener('uris:stage2-start', onStart);
        window.addEventListener('uris:stage2-end', onEnd);
        window.addEventListener('uris:inline-queued', onInlineQueued);
        window.addEventListener('uris:inline-start', onInlineStart);
        window.addEventListener('uris:inline-end', onInlineEnd);
        document.addEventListener('click', event => {
            if (!panel.hidden && !panel.contains(event.target) && event.target !== badge) {
                panel.hidden = true;
                badge.setAttribute('aria-expanded', 'false');
            }
        });
    }
    sync();
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
        // Quiet entries (provider warnings etc.) live only in the dropdown —
        // they must not keep the badge permanently lit.
        const badgeErrors = errors.filter(entry => entry.quiet !== true);
        const count = badgeErrors.length + pending.length;
        badge.hidden = count === 0;
        badge.title = pending.length
            ? `События и ${pending.length} незавершённый запрос`
            : 'События';
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
        const queuePanel = el.querySelector('#urisQueuePanel');
        if (queuePanel && !panel.hidden) queuePanel.hidden = true;
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
    // Secondary button / pen-barrel: not a drag. Touch and pen are pointerType
    // 'touch' / 'pen' and arrive here too — one handler covers all of them.
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest('.uris-icon-btn')) return;
    const pointerId = e.pointerId;
    const dx = e.clientX - el.getBoundingClientRect().left;
    const dy = e.clientY - el.getBoundingClientRect().top;
    const move = (ev) => {
        if (pointerId !== undefined && ev.pointerId !== pointerId) return;
        const next = clampWindowGeometry(
            {
                left: ev.clientX - dx,
                top: ev.clientY - dy,
                width: el.getBoundingClientRect().width,
                height: el.getBoundingClientRect().height,
            },
            { width: window.innerWidth, height: window.innerHeight },
            { topInset: getStTopInsetPx() },
        );
        el.style.left = next.left + 'px';
        el.style.top = next.top + 'px';
        el.style.right = 'auto'; el.style.bottom = 'auto';
    };
    const up = (ev) => {
        if (pointerId !== undefined && ev?.pointerId !== undefined && ev.pointerId !== pointerId) return;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId);
        if (_dragCleanup === up) _dragCleanup = null;
        saveGeometry(el);
    };
    _dragCleanup?.();
    _dragCleanup = up;
    el.setPointerCapture?.(pointerId);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
}

function startResize(e, el) {
    if (e.button !== undefined && e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    const pointerId = e.pointerId;
    const startX = e.clientX, startY = e.clientY;
    const r = el.getBoundingClientRect();
    const sw = r.width, sh = r.height;
    const move = (ev) => {
        if (pointerId !== undefined && ev.pointerId !== pointerId) return;
        const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - Math.max(0, r.left));
        const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - Math.max(0, r.top));
        el.style.width = Math.min(maxWidth, Math.max(MIN_WIDTH, sw + (ev.clientX - startX))) + 'px';
        el.style.height = Math.min(maxHeight, Math.max(MIN_HEIGHT, sh + (ev.clientY - startY))) + 'px';
    };
    const up = (ev) => {
        if (pointerId !== undefined && ev?.pointerId !== undefined && ev.pointerId !== pointerId) return;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId);
        if (_resizeCleanup === up) _resizeCleanup = null;
        saveGeometry(el);
    };
    _resizeCleanup?.();
    _resizeCleanup = up;
    el.setPointerCapture?.(pointerId);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
}

// Test seam: pure geometry math (same pattern as _testFloatingLauncher).
export const _testWindowGeometry = { clampWindowGeometry, MIN_VISIBLE_PX, MIN_WIDTH, MIN_HEIGHT };

export function setStatus(text) {
    const el = document.getElementById('urisStatus');
    if (el) el.textContent = text || '';
}
