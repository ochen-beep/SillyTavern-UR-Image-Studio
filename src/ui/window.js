// @ts-check
/**
 * Floating window: mount, drag (by header), resize (corner handle), mobile overlay.
 */
import { state, saveSettings, escapeHtml, error } from '../core.js';
import { listUrisErrors, clearUrisErrors, formatUrisError, markUrisErrorsSeen, countUnreadUrisErrors, hasUnreadHardUrisErrors, getUrisErrorsSeenAt, reportFailure, URIS_SCOPES } from '../error-pool.js';
import { listPendingBrowserRequests, discardPendingBrowserRequest, clearPendingBrowserRequests } from '../browser-image-recovery.js';
import { bindTabBarScroll } from './tab-bar-scroll.js';
import { listQueueLog, queueBadgeCount, clearQueueLog, hasLiveQueueLane } from './queue-log.js';
import { stopQueue, cancelQueuedItem, resubmitQueueRow } from '../pipeline-queue.js';

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

// Шаблон окна — константа уровня модуля ради тестового шва _testWindowMarkup:
// контракт шапки (tests/window-header.test.js) проверяет разметку без DOM.
// Заголовка и статусной строки в шапке больше нет: заголовок никто не читал,
// а статус был мусорным каналом уведомлений — у всех его пользователей есть
// собственная обратная связь. Место слева от действий свободно.
const WINDOW_TEMPLATE = `
        <div class="uris-header" id="urisHeader">
            <div class="uris-header-actions">
                ${badgeButtonHtml({ id: 'urisQueueBadge', label: 'QUEUE', title: 'Очередь генераций', controls: 'urisQueuePanel' })}
                ${badgeButtonHtml({ id: 'urisErrorBadge', label: 'INFO', title: 'События', controls: 'urisErrorPanel', withDot: true })}
                <button class="uris-icon-btn" id="urisClose" title="Свернуть" aria-label="Свернуть">✕</button>
            </div>
        </div>
        <div class="uris-error-panel" id="urisQueuePanel" role="dialog" aria-label="Очередь генераций" hidden></div>
        <div class="uris-error-panel" id="urisErrorPanel" role="dialog" aria-label="События" hidden></div>
        <div class="uris-tabs" id="urisTabs"></div>
        <div class="uris-body" id="urisBody"></div>
        <div class="uris-resizer" id="urisResizer"></div>`;

/** Шов для node-тестов: разметка окна без монтирования. */
export const _testWindowMarkup = { WINDOW_TEMPLATE };
/**
 * Шов для node-тестов жизненного цикла бейдж-панелей: привязка слушателей
 * QUEUE-бейджа и Escape-иерархии окна без полного монтирования (mountPanel
 * тянет getComputedStyle/matchMedia/restoreGeometry, которых в fake-dom нет).
 * removePanel общий — он же снимает эти слушатели.
 */
export const _testWindowLifecycle = { bindQueueBadge, bindErrorPool, bindWindowEscape, removePanel, collapseWindow };

export function mountPanel() {
    let el = document.getElementById(WIN_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = WIN_ID;
    el.className = 'uris-window';
    el.innerHTML = WINDOW_TEMPLATE;
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
        window.removeEventListener('uris:stage2-end', _errorPoolHandler);
        window.removeEventListener('uris:inline-end', _errorPoolHandler);
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
    if (_queueSyncHandler && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('uris:queue', _queueSyncHandler);
        _queueSyncHandler = null;
    }
    if (_queueOutsideHandler && typeof document !== 'undefined') {
        document.removeEventListener('click', _queueOutsideHandler);
        _queueOutsideHandler = null;
    }
    if (_queueKeyHandler && typeof document !== 'undefined') {
        document.removeEventListener('keydown', _queueKeyHandler);
        _queueKeyHandler = null;
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
let _queueSyncHandler = null;
let _queueOutsideHandler = null;
let _queueKeyHandler = null;
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
// Единственный выход из окна был «Свернуть» в шапке. Escape закрывает
// собственные оверлеи расширения по слоям: диалоги (кроп, выбор папки,
// менеджер папок) слушают keydown в capture-фазе и зовут stopPropagation;
// бейдж-панели (QUEUE/INFO) — bubble-фаза, а окно с открытой панелью
// уступает (см. _windowKeyHandler). SillyTavern на том же Escape закрывает
// свои панели (RossAscends-mods.js, document keydown, bubble-фаза) и сама
// отступает, когда открыт редактор сообщения или идёт стрим. Поэтому окно
// сворачивается только если фокус внутри него: Escape из поля ввода чата
// остаётся таверне.

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
        // Открытая бейдж-панель (QUEUE/INFO) поглощает Esc: её собственный
        // keydown-обработчик закрывает панель, окно не сворачивается. Раньше
        // одно нажатие закрывало панель И окно разом (capture-фаза окна и
        // bubble-фаза панели срабатывали оба), а QUEUE-панель вовсе не имела
        // своего Esc и оставалась висеть над свёрнутым окном.
        const queuePanel = winEl.querySelector('#urisQueuePanel');
        const errorPanel = winEl.querySelector('#urisErrorPanel');
        if ((queuePanel && !queuePanel.hidden) || (errorPanel && !errorPanel.hidden)) return;
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

/** Провенанс recovery-записи: когда, из какого поста и какой моделью. */
function pendingRowContext(item) {
    const parts = [];
    const created = Date.parse(item?.createdAt);
    if (Number.isFinite(created)) {
        // Запись может висеть днями — без даты «14:32» не имеет смысла.
        parts.push(new Date(created).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
    }
    // Number(null) === 0: без явной проверки null студийные записи (без поста)
    // получили бы фальшивое «пост #1».
    const rawMsgId = item?.sourceMsgId;
    const msgId = Number(rawMsgId);
    if (rawMsgId !== null && rawMsgId !== undefined && rawMsgId !== '' && Number.isFinite(msgId) && msgId >= 0) parts.push(`пост #${msgId + 1}`);
    if (item?.modelId) parts.push(String(item.modelId));
    return parts.join(' · ');
}

/**
 * Единая лента событий: ошибки/предупреждения сессии и чеки платных запросов
 * в одном списке, новые сверху. Для пользователя — одна сущность («событие»)
 * и одна кнопка очистки; различие живёт только в содержимом карточки.
 */
function mergeEvents(errors, pending) {
    const poolCards = (errors || []).map(entry => ({
        kind: 'pool',
        ts: entry.ts,
        text: formatUrisError(entry),
        level: entry.level === 'warn' ? 'warn' : 'error',
    }));
    const recoveryCards = (pending || []).map(item => ({
        kind: 'recovery',
        id: item.id,
        ts: Date.parse(item.createdAt) || 0,
        status: pendingStatusLabel(item),
        context: pendingRowContext(item),
        error: item.error || '',
    }));
    return [...poolCards, ...recoveryCards].sort((a, b) => b.ts - a.ts);
}

/** Непросмотренное recovery-событие: запись новее единого бейзлайна
 * «просмотрено» (error-pool персистит его). Записи с нечитаемой датой
 * считаются новыми всегда: дефектные данные всплывают, а не молча пропадают. */
function isUnseenRecovery(item, seenAt) {
    const t = Date.parse(item?.createdAt);
    if (!Number.isFinite(t)) return true;
    return t > seenAt;
}

/** Сколько recovery-событий ещё не просмотрено. */
function unseenRecoveryCount(pending, seenAt) {
    return (pending || []).filter(item => isUnseenRecovery(item, seenAt)).length;
}

/**
 * В INFO — только фактические результаты, никаких промежуточных статусов
 * (решение 2026-10-02). Страховочная запись живой генерации — не событие: её
 * показывает QUEUE. Вырезаем записи, чей запрос ещё в activeGenerations, —
 * из цифры, точки и панели разом. После перезагрузки реестр пуст, и
 * осиротевшие записи становятся честным событием «результат запроса
 * неизвестен» — главной страховой функцией.
 * @param {Array<{id:string, requestId?:string}>|null} pending
 * @param {Map<string, unknown>|null|undefined} activeGenerations
 */
function reviewableRecovery(pending, activeGenerations) {
    if (!Array.isArray(pending)) return [];
    const live = activeGenerations instanceof Map ? activeGenerations : null;
    if (!live || live.size === 0) return pending;
    return pending.filter(item => !live.has(item.requestId ?? item.id));
}

// Подпись содержимого панели: события (текст/время/счётчик/тон) + recovery.
// Панель перерисовывается на каждое событие пула, включая дедуп-бампы; без
// пропуска по подписи innerHTML сбрасывает скролл ровно в момент, когда
// пользователь читает список. false до первого рендера — пустая панель должна
// отстроиться; сбрасывается в bindErrorPool на каждый монтаж окна.
let _lastPanelSnapshot = null;

function panelSnapshot(errors, pending) {
    return JSON.stringify([
        errors.map(entry => [entry.scope, entry.message, entry.ts, entry.count, entry.level || 'error', entry.quiet === true]),
        pending.map(item => [item.id, item.status, item.error || '']),
    ]);
}

/**
 * Русская плюрализация: 1 событие / 2 события / 5 событий; 11/12/14 — «событий»,
 * 21/31/… — снова «событие».
 */
function pluralRu(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

/** title бейджа: сколько событий осталось неразобранными. */
function composeBadgeTitle(unread) {
    return unread > 0
        ? `${unread} ${pluralRu(unread, 'новое событие', 'новых события', 'новых событий')}`
        : 'События';
}

/**
 * Единое состояние обоих бейджей шапки: актуального ничего (всё просмотрено у
 * INFO, ничего не выполняется у QUEUE) — бейдж приглушён, но из DOM не
 * исчезает: шапка не прыгает, обе панели достижимы всегда.
 */
const BADGE_IDLE_CLASS = 'uris-error-badge--idle';
function badgeIsIdle(count) { return !(count > 0); }

/**
 * Единая разметка бейджа: QUEUE и INFO собраны одной функцией, поэтому второй
 * набор классов/атрибутов расползтись не может. hidden не пишется никогда —
 * пустое состояние это idle, а не удаление из DOM.
 */
function badgeButtonHtml({ id, label, title, controls, withDot = false }) {
    const stem = id.replace(/Badge$/, '');
    const dot = withDot ? `<span class="uris-badge-dot" id="${stem}Dot" hidden></span>` : '';
    return `<button type="button" class="uris-icon-btn uris-error-badge" id="${id}" title="${title}" aria-label="${title}" aria-expanded="false" aria-controls="${controls}">${label} <span class="uris-error-count" id="${stem}Count">0</span>${dot}</button>`;
}

/** Шов для node-тестов: чистые функции бейджа без DOM. */
export const _testErrorBadge = { pluralRu, composeBadgeTitle, pendingRowContext, pendingStatusLabel, mergeEvents, unseenRecoveryCount, badgeIsIdle, BADGE_IDLE_CLASS, badgeButtonHtml, reviewableRecovery };

function renderErrorPanel(winEl, errors, pending = []) {
    const panel = winEl?.querySelector?.('#urisErrorPanel');
    if (!panel) return;
    const snapshot = panelSnapshot(errors, pending);
    if (snapshot === _lastPanelSnapshot) return;
    _lastPanelSnapshot = snapshot;
    const scrollTop = panel.scrollTop;
    // Единая лента карточек, новые сверху. Событие есть событие: и ошибка
    // сессии, и чек платного запроса лежат в одном списке без подсекций —
    // различие только в содержимом карточки.
    const body = mergeEvents(errors, pending).map(ev => ev.kind === 'pool'
        ? `<div class="uris-error-row${ev.level === 'warn' ? ' uris-pool-warn' : ' uris-pool-fail'}">${escapeHtml(ev.text)}</div>`
        : `<div class="uris-error-row uris-pending-row"><span><strong>${escapeHtml(ev.status)}</strong>${ev.context ? ` · ${escapeHtml(ev.context)}` : ''}</span>${ev.error ? `<small>${escapeHtml(ev.error)}</small>` : ''}<button type="button" class="uris-btn uris-btn-ghost uris-pending-discard" data-pending-id="${escapeHtml(ev.id)}" title="Удалить событие" aria-label="Удалить событие">×</button></div>`
    ).join('');
    // Одна кнопка на всю ленту: стирает и события сессии, и чеки платных
    // запросов. Точечно чек убирается крестиком на его карточке.
    panel.innerHTML = `<div class="uris-error-panel-actions"><button type="button" class="uris-btn uris-btn-ghost" id="urisErrorClear">Очистить</button></div>
        <div class="uris-error-rows">${body || '<div class="uris-error-row uris-error-empty">Событий нет</div>'}</div>`;
    panel.scrollTop = scrollTop;
    panel.querySelector('#urisErrorClear')?.addEventListener('click', () => {
        clearUrisErrors(); // sync придёт событием uris:errors…
        clearPendingBrowserRequests().catch(e => { // …и uris:pending-changed
            error('clear pending:', e);
            reportFailure({ scope: URIS_SCOPES.recovery, message: e?.message || String(e) });
        });
    });
    panel.querySelectorAll('[data-pending-id]').forEach(button => button.addEventListener('click', async () => {
        button.disabled = true;
        try { await discardPendingBrowserRequest(button.dataset.pendingId); }
        catch (e) { error('discard pending:', e); reportFailure({ scope: URIS_SCOPES.recovery, message: e?.message || String(e) }); }
    }));
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
            // Действия строки: крестик у ожидающих задач очереди, «Повторить»
            // у её упавших (снапшот отправки хранится в строке).
            let action = '';
            if (row.lane === 'queue' && row.status === 'waiting') {
                action = `<button type="button" class="uris-queue-row-cancel" data-queue-cancel="${escapeHtml(row.id)}" title="Отменить эту задачу" aria-label="Отменить задачу ${escapeHtml(row.label)}">×</button>`;
            } else if (row.lane === 'queue' && row.status === 'done' && row.tone === 'fail' && row.retry) {
                action = '<button type="button" class="uris-queue-row-retry" data-queue-retry="' + escapeHtml(row.id) + '" title="Отправить задачу ещё раз с тем же снапшотом">Повторить</button>';
            }
            return `<div class="uris-error-row uris-queue-row${tone}"><span>${escapeHtml(row.label)} — ${QUEUE_STATUS_TEXT[row.status] || ''}</span>${detail}${action}</div>`;
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
    panel.querySelectorAll('[data-queue-cancel]').forEach(btn => btn.addEventListener('click', () => {
        cancelQueuedItem(btn.getAttribute('data-queue-cancel'));
    }));
    panel.querySelectorAll('[data-queue-retry]').forEach(btn => btn.addEventListener('click', () => {
        const row = listQueueLog().find(r => r.id === btn.getAttribute('data-queue-retry'));
        if (!row?.retry) return;
        resubmitQueueRow(row.retry).catch(e => {
            // Повторно упавшая задача — не unhandled rejection: та же запись
            // «Генерация», что у ручной отправки (QUEUE-строку красит
            // noteFinished в processQueue, пулу нужен свой durable-след).
            if (e?.name === 'AbortError') return;
            error('Queue retry:', e?.message || e);
            reportFailure({ scope: URIS_SCOPES.generation, message: e?.message || String(e), context: e?.urisContext || { post: row.retry.msgId } });
        });
    }));
}

/**
 * Бейдж QUEUE рядом с INFO. Цифра — живые генерации (ждут или выполняются);
 * сам бейдж всегда в шапке (badgeButtonHtml), при живых=0 приглушается
 * idle-классом — завершённые с «Повторить» остаются достижимыми ровно тогда,
 * когда нужны. Лента помнит и завершённые: успех зелёным,
 * неудача красным, отмена без заливки.
 *
 * Окно — чистый читатель журнала: строки ставят продюсеры (pipeline-queue —
 * lane 'queue', pipeline-stage2 — ручные/авто, bridge — внешние, inline/runner
 * — инлайн). Раньше окно реконструировало строки из событий — параллельное
 * состояние, вравшее при пропущенном слушателе.
 */
function bindQueueBadge(el) {
    const badge = el.querySelector('#urisQueueBadge');
    const panel = el.querySelector('#urisQueuePanel');
    if (!badge || !panel) return;
    const sync = () => {
        const count = queueBadgeCount();
        // Всегда в DOM (см. badgeButtonHtml): при живых=0 упавшие строки с
        // «Повторить» остаются достижимы ровно тогда, когда нужны. Цифру
        // бейдж показывает только при живом (ждут + выполняются), в покое
        // приглушается idle-классом — как INFO при непросмотренном.
        badge.classList.toggle(BADGE_IDLE_CLASS, badgeIsIdle(count));
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
    badge.addEventListener('click', event => {
        event.stopPropagation();
        panel.hidden = !panel.hidden;
        const infoPanel = el.querySelector('#urisErrorPanel');
        if (infoPanel && !panel.hidden) infoPanel.hidden = true;
        sync();
    });
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        // Обработчики хранятся в модульных переменных и снимаются в removePanel():
        // анонимные версии переживали цикл disable→enable и навсегда держали
        // слушатели на отсоединённом окне (симметрично bindErrorPool).
        if (_queueSyncHandler) window.removeEventListener('uris:queue', _queueSyncHandler);
        _queueSyncHandler = sync;
        window.addEventListener('uris:queue', _queueSyncHandler);
        if (_queueOutsideHandler) document.removeEventListener('click', _queueOutsideHandler);
        _queueOutsideHandler = event => {
            if (!panel.hidden && !panel.contains(event.target) && event.target !== badge) {
                panel.hidden = true;
                badge.setAttribute('aria-expanded', 'false');
            }
        };
        document.addEventListener('click', _queueOutsideHandler);
        if (_queueKeyHandler) document.removeEventListener('keydown', _queueKeyHandler);
        // Esc закрывает открытую QUEUE-панель (паритет с INFO): без этого Esc
        // сворачивал всё окно, оставляя панель висеть осиротевшей.
        _queueKeyHandler = event => {
            if (event.key === 'Escape' && !panel.hidden) {
                panel.hidden = true;
                badge.setAttribute('aria-expanded', 'false');
                badge.focus?.();
            }
        };
        document.addEventListener('keydown', _queueKeyHandler);
    }
    sync();
}

function bindErrorPool(el) {
    const badge = el.querySelector('#urisErrorBadge');
    const panel = el.querySelector('#urisErrorPanel');
    if (!badge || !panel) return;
    _lastPanelSnapshot = null;
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
        // Кто смотрит в открытый лист — всё в нём прочитал: до подсчёта
        // unread, чтобы цифра гасла сразу при открытии и не горела, пока
        // панель открыта, даже когда события приходят потоком.
        const wasOpen = !panel.hidden;
        if (wasOpen) markUrisErrorsSeen();
        const pending = await listPendingBrowserRequests();
        const errors = listUrisErrors();
        if (seq !== refreshSeq || (el.isConnected === false)) return;
        // Только фактические результаты: записи живых генераций — не события
        // (см. reviewableRecovery). Непрочитанность — единый персистентный
        // бейзлайн времени, общий с пулом сессии: никаких отдельных id-наборов.
        const reviewable = reviewableRecovery(pending, state.activeGenerations);
        const seenAt = getUrisErrorsSeenAt();
        const unread = countUnreadUrisErrors() + unseenRecoveryCount(reviewable, seenAt);
        const dot = el.querySelector('#urisErrorDot');
        badge.classList.toggle(BADGE_IDLE_CLASS, badgeIsIdle(unread));
        badge.title = composeBadgeTitle(unread);
        // Точка = среди нового есть серьёзное: жёсткая ошибка сессии или чек
        // платного запроса с неизвестным исходом.
        if (dot) dot.hidden = !(hasUnreadHardUrisErrors() || reviewable.some(item => item.status !== 'notStarted' && isUnseenRecovery(item, seenAt)));
        badge.setAttribute('aria-expanded', String(!panel.hidden));
        el.querySelector('#urisErrorCount').textContent = String(unread);
        if (!panel.hidden) renderErrorPanel(el, errors, reviewable);
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
        // Конец генерации может перевести страховочную запись в разборные
        // (запрос вышел из activeGenerations), а сам по себе в store ничего
        // не пишет: INFO обязан пересинхронизироваться и по нему, иначе
        // финальное «результат запроса неизвестен» зажжётся только со
        // следующим событием.
        window.addEventListener('uris:stage2-end', _errorPoolHandler);
        window.addEventListener('uris:inline-end', _errorPoolHandler);
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
    // Геометрия жеста читается ОДИН раз на pointerdown: размеры окна и inset
    // топ-бара не меняются в течение драга, а прежние чтения rect на каждый
    // pointermove давали forced layout на каждый тик (до тысяч в секунду
    // у высокочастотных мышей).
    const r0 = el.getBoundingClientRect();
    const dx = e.clientX - r0.left;
    const dy = e.clientY - r0.top;
    const dragWidth = r0.width;
    const dragHeight = r0.height;
    const dragTopInset = getStTopInsetPx();
    const dragViewport = { width: window.innerWidth, height: window.innerHeight };
    const move = (ev) => {
        if (pointerId !== undefined && ev.pointerId !== pointerId) return;
        const next = clampWindowGeometry(
            {
                left: ev.clientX - dx,
                top: ev.clientY - dy,
                width: dragWidth,
                height: dragHeight,
            },
            dragViewport,
            { topInset: dragTopInset },
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
