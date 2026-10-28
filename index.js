// @ts-check
/**
 * UR Image Studio v2 — entry point: lifecycle hooks + orchestration.
 * Architecture: index.js → src/* modules → src/providers/* → src/ui/* tabs.
 *
 * v4 changes:
 * - 5 tabs: API, References, Generation, Gallery, Templates
 * - Generation config stored in current chat metadata (schema v4)
 * - Provider layer (openai-like, gemini, comfyui stub)
 * - DOM anchors on chat messages (post-anchor.js)
 * - References: global pool + chat binding (refs-library.js)
 */
import {
    state, DISPLAY_NAME,
    loadSettings, saveSettings, flushSettings, getCtx, log, warn, error,
    debounce, applyUiScale, applyFontScale, abortAllGenerations,
} from './src/core.js';
import { initNotifyUnlock } from './src/notify.js';
import {
    loadChatConfig, applyChatConfigToState,
} from './src/chat-binding.js';
import { bindEvents, unbindEvents } from './src/events.js';
import {
    mountPanel, syncPanelVisibility, initViewportSync, removeViewportSync, removePanel, isPanelVisible,
} from './src/ui/window.js';
import { ensureFloatingLauncher, removeFloatingLauncher, bindStage2Pulse } from './src/ui/floating-launcher.js';
import { registerTab, setActiveTab, renderTabs, getActiveTab, refreshActive, resolveInitialTab } from './src/ui/tabs.js';
// Keep the startup module graph minimal: tabs, pipeline and the rare settings
// panel handlers load dynamically on first use (see lazyTabRender below).
import { bindAbortUI, unbindAbortUI } from './src/ui/generation-lifecycle-ui.js';
import { createSettingsPanel } from './src/ui/settings-panel.js';
import { setCurrentMsgId, getLastPostIndex } from './src/post-navigator.js';
import { refreshPoolCache, ensureRefsStoreReady } from './src/refs-library.js';
import { sweepStaleRunningDrafts } from './src/generation-drafts.js';
import { reportFailure, URIS_SCOPES } from './src/error-pool.js';
import { loadDiagnosticEvents, flushDiagnosticEvents, recordDiagnosticEvent } from './src/diagnostic-events.js';
import { flushAllFileStores, flushAllFileStoresOnUnload } from './src/file-store.js';
import { ensureGalleryStoreReady } from './src/gallery-index.js';
import { ensureParamPresetStoreReady } from './src/param-presets.js';
import { ensureStudioStoreReady } from './src/studio-scope.js';
import { activateBridge, deactivateBridge, markBridgeReady, markBridgeFailed } from './src/bridge.js';
import { acquireSingletonLock, releaseSingletonLock } from './src/cross-tab.js';

// ── Lifecycle hooks ──

let _initialized = false;

/** SillyTavern extension activation hook. */
export async function onActivate() { log('onActivate'); await safeInit(); }
/** SillyTavern extension update hook. */
export function onUpdate()   { log('onUpdate'); }
/** SillyTavern extension enable hook. */
export async function onEnable()   { log('onEnable'); await safeInit(); }
/** SillyTavern extension disable hook. */
export function onDisable()  { log('onDisable'); recordDiagnosticEvent({ event: 'disable' }); flushDiagnosticEvents(); cleanup(); }
/** SillyTavern extension install hook. */
export function onInstall()  { log('onInstall'); }

/** Initializes the extension once, guarding against repeated calls. */
async function safeInit() {
    if (_initialized) { log('already initialized, skipping'); return; }
    _initialized = true;
    try { await init(); }
    catch (e) {
        error('init:', e);
        _initialized = false;
        // The bridge global is already published (activateBridge runs first):
        // reject its ready promise so awaiting consumers don't hang forever.
        markBridgeFailed(e);
    }
}

let _launcherObserver = null;
let _visibilityHandler = null;
let _pageHideHandler = null;
let _onPostFollow = null;
let _onGenerationDefaultsChanged = null;
let _onLauncherModeChanged = null;
let _onChatChangedRefresh = null;

// ── Init ──

/** Bootstraps the extension, registers tabs, mounts UI and binds events. */
async function init() {
    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
        error('SillyTavern unavailable');
        markBridgeFailed(new Error('SillyTavern context is unavailable'));
        return;
    }
    const ctx = getCtx(); if (!ctx) { warn('context unavailable'); markBridgeFailed(new Error('SillyTavern context is unavailable')); return; }
    // Perf marks: read in DevTools via performance.getEntriesByType('measure').
    performance.mark('uris:init');
    // Publish globalThis.URIS before any async work so consumers can grab the
    // global early and await URIS.ready for actual readiness.
    activateBridge();
    await loadSettings();
    applyUiScale();
    applyFontScale();
    initNotifyUnlock();
    // Кросс-табличный watchdog: сторы пишут файлы целиком без межвкладочной
    // координации — вторая вкладка получает баннер о риске перетирания.
    // Поддержки Web Locks нет — тихо продолжаем (старое поведение).
    const lockState = await acquireSingletonLock();
    if (lockState === 'busy') {
        recordDiagnosticEvent({ event: 'cross-tab-lock-busy', level: 'warn', stage: 'storage' });
        reportFailure({
            scope: URIS_SCOPES.storage,
            message: 'Расширение уже открыто в другой вкладке браузера. Изменения настроек, шаблонов и референсов могут перетирать друг друга — оставьте одну вкладку.',
        });
        toastr?.warning('UR Image Studio уже открыт в другой вкладке — возможна потеря правок. Подробности в ленте событий.', DISPLAY_NAME);
    }
    await loadDiagnosticEvents();
    recordDiagnosticEvent({ event: 'session-start', details: { initialized: true } });

    // Resolve the file-backed stores before the first render: their contents
    // live on the server now, and the first read must see the migrated/persisted
    // data rather than an empty mirror. This is also what performs the one-time
    // migration out of extensionSettings (and drops the settings copy, which is
    // what keeps settings.json small). refreshPoolCache joins the same batch —
    // it only reads the refs store, so running it first serialized the whole
    // startup behind an extra verify+GET round-trip.
    await Promise.all([
        refreshPoolCache(),
        ensureGalleryStoreReady(),
        ensureRefsStoreReady(),
        ensureParamPresetStoreReady(),
        ensureStudioStoreReady(),
    ]);

    // v4: 6 tabs (API / References / Generation / Gallery / Templates / Settings)
    // Lazy render: a tab module loads on first open, not at tavern startup
    // (the first open pays a single dynamic import).
    const lazyTabRender = (path) => (root) => import(path).then(m => m.render(root));
    registerTab({ id: 'api',         label: 'API',         render: lazyTabRender('./src/ui/tab-api.js') });
    registerTab({ id: 'references',  label: 'Референсы',  render: lazyTabRender('./src/ui/tab-references.js') });
    registerTab({ id: 'generate',    label: 'Генерация',   render: lazyTabRender('./src/ui/tab-generate.js') });
    registerTab({ id: 'gallery',     label: 'Галерея',     render: lazyTabRender('./src/ui/tab-gallery.js') });
    registerTab({ id: 'templates',   label: 'Шаблоны',     render: lazyTabRender('./src/ui/tab-templates.js') });
    // Experimental bridge lab: hidden unless enabled on the Settings tab.
    registerTab({ id: 'bridge',      label: 'Мост',        render: lazyTabRender('./src/ui/tab-bridge.js'), visible: () => state.settings?.bridgeTab === true });
    // Inline media tab: hidden unless the inline master toggle is on (Settings / Media).
    // Experimental surface — marked with a warning sign in the tab bar.
    registerTab({ id: 'media',       label: 'Медиа ⚠',     render: lazyTabRender('./src/ui/tab-media.js'), visible: () => state.settings?.inlineEnabled === true });
    registerTab({ id: 'settings',    label: 'Настройки',   render: lazyTabRender('./src/ui/tab-settings.js') });

    // ST settings panel (minimal). The panel markup/handlers live in
    // src/ui/settings-panel.js; index-local lifecycle is passed as hooks.
    createSettingsPanel({
        onEnabledChange: (enabled) => {
            if (enabled && !_initialized) safeInit();
            else if (!enabled && _initialized) cleanup();
            ensureLauncher(); syncPanelVisibility();
        },
        onLauncherModeChange: () => {
            ensureLauncher();
            // Sync the in-window Settings tab select if it is open.
            window.dispatchEvent?.(new CustomEvent('uris:launcher-mode-changed'));
        },
        onOpenWindow: () => { if (state.settings.collapsed) toggleLauncherPanel(); },
    });

    // Load and apply the generation config. With a chat open it is the chat's
    // schema-v5 binding; on the welcome screen loadChatConfig routes to the
    // studio store, so the panel works there too. Awaited: otherwise the UI is
    // active before the config sets runtime fields, and persist calls from
    // tabs silently no-op.
    // Must run BEFORE the first active tab render: the 'generate' render
    // reads state.currentMsgId and ctx.chat[msgId] — otherwise async-render
    // rejects in generationDraftKey (msgId=null) and the tab stays empty
    // until the user switches tabs and back.
    state.currentChatId = ctx.chatId;
    // Never fake a chat here: currentChatId must stay null on the welcome
    // screen so message-scoped paths (auto-generation, scanner) stay inert.
    const bootConfig = await loadChatConfig();
    applyChatConfigToState(bootConfig);
    // Guarantee a valid currentMsgId before the first render. After the chat config
    // loads, the chat is fully loaded, so getLastPostIndex returns a meaningful value.
    setCurrentMsgId(getLastPostIndex());

    // Reset drafts left "running" by an interrupted session (reload / unload
    // mid-generation): a "running" status can never resolve on its own, so fold
    // it back to "idle" before the first render shows a stuck spinner.
    await sweepStaleRunningDrafts();

    // Window (idempotent)
    mountPanel();
    renderTabs();
    setActiveTab(state.settings.collapsed ? 'generate' : resolveInitialTab('generate'), {
        persist: false,
        render: !state.settings.collapsed,
    });
    syncPanelVisibility();
    initViewportSync();

    // Run Stage 1 for build-prompt, or both stages for full-pipeline.
    bindEvents({
        // Фоновая автоматизация: уведомления — только в ленту INFO и звуком;
        // тосты здесь — мусорный дубль (политика 2026-10-02: фон не тостит).
        onAutomation: async ({ chatId, msgId, messageText, templateId, requestedAction }) => {
            if (!state.settings.enabled) return;
            const input = { chatId, msgId, messageText, templateId };
            try {
                const pipeline = await import('./src/pipeline.js');
                if (requestedAction === 'build-prompt') {
                    const run = await pipeline.runStage1ForDraft(input, undefined, undefined, { isAuto: true });
                    if (run.applied) {
                        if (isPanelVisible() && getActiveTab() === 'generate') refreshActive();
                    }
                } else if (requestedAction === 'full-pipeline') {
                    await pipeline.runFullPipelineForDraft(input);
                    if (isPanelVisible() && getActiveTab() === 'gallery') refreshActive();
                }
            } catch (e) {
                if (e?.name === 'AbortError') {
                    // отмена — не ошибка
                } else {
                    error('Auto generation:', e.message);
                    reportFailure({ scope: URIS_SCOPES.auto, message: e.message, context: e?.urisContext || { post: input.msgId } });
                }
            }
        },
        // ST's global Stop button (stopGeneration) always emits GENERATION_STOPPED.
        // "Stop stops everything": cancel every in-flight extension generation and
        // the batch queue. Safe when idle — both calls are no-ops then.
        onStopAll: () => {
            abortAllGenerations();
            void import('./src/pipeline.js').then(m => m.stopQueue());
        },
    });

    // Live-update the Generation tab on follow-last-post snap. Fires
    // on GENERATION_ENDED/MESSAGE_SENT/MESSAGE_SWIPED when the flag is enabled —
    // events.js already moved currentMsgId and dispatched this event.
    _onPostFollow = () => {
        if (!isPanelVisible() || getActiveTab() !== 'generate') return;
        refreshActive();
    };
    window.addEventListener('uris:post-follow', _onPostFollow);
    _onGenerationDefaultsChanged = () => {
        if (isPanelVisible() && getActiveTab() === 'generate') refreshActive();
    };
    window.addEventListener('uris:chat-generation-defaults-changed', _onGenerationDefaultsChanged);
    // Launcher mode switched from the Settings tab (or the ST panel select):
    // re-run ensureLauncher and keep both selects in sync.
    _onLauncherModeChanged = () => {
        ensureLauncher();
        for (const id of ['uris_launcher_mode', 'uris_launcher_mode_tab']) {
            const sel = document.getElementById(id);
            if (sel && sel.value !== state.settings.launcherMode) sel.value = state.settings.launcherMode;
        }
    };
    window.addEventListener('uris:launcher-mode-changed', _onLauncherModeChanged);
    // Chat opened / closed (back to the welcome screen): the Generate and
    // Gallery tabs switch between the chat and the studio scope, so the active
    // one must re-render after the config load completes (events.js dispatches
    // this after applyChatConfigToState).
    _onChatChangedRefresh = () => {
        if (!isPanelVisible()) return;
        const tab = getActiveTab();
        if (tab === 'generate' || tab === 'gallery') refreshActive();
    };
    window.addEventListener('uris:chat-changed', _onChatChangedRefresh);

    // Singleton listeners keep the "Остановить" button and queue status in sync
    // with Stage 2 lifecycle events (manual, auto and queue alike).
    bindAbortUI();

    // Launcher
    ensureLauncher();
    attachLauncherObserver();


    // Flush on page unload (removed in cleanup). flushSettings() only re-arms
    // ST's internal debounce (instant saveSettings is not exposed to extensions),
    // but the file stores perform a real keepalive flush here.
    _visibilityHandler = () => {
        if (document.visibilityState === 'hidden') {
            flushSettings();
            // Реестр file-store накрывает все сторы, включая refs-meta сателлит,
            // который ручные пер-модульные обёртки не флашевали (ponytail K3).
            flushAllFileStoresOnUnload();
            flushDiagnosticEvents();
            try { getCtx().saveMetadata?.(); } catch {}
        }
    };
    document.addEventListener('visibilitychange', _visibilityHandler);
    _pageHideHandler = () => {
        flushAllFileStoresOnUnload();
    };
    window.addEventListener('pagehide', _pageHideHandler);

    // Inline engine runtime — via the shared Media-tab helper so the per-chat
    // cfg.enabled is synced with the master toggle at startup. The previous
    // direct bindScanner/initRender calls left every chat that never touched
    // the Media toggle with a dead scanner while the checkbox showed enabled.
    if (state.settings.inlineEnabled) {
        (await import('./src/ui/tab-media.js')).applyInlineRuntime();
    }

    log('Initialized v2 · catalog-v3 · nanogpt-image-catalog · no-model-toggle.');
    performance.measure('uris:init', 'uris:init');
    // External bridge opens for business only after a fully successful init.
    markBridgeReady();
}

// ── Launcher ──

/**
 * Finds the Quick Reply bar element in the DOM.
 * @returns {HTMLElement | null}
 */
function getQuickReplyBar() {
    return document.querySelector('#send_form #qr--bar') || document.getElementById('qr--bar') || document.querySelector('#send_form .qr--bar');
}
/**
 * Returns the element that should host the launcher icon.
 * @returns {HTMLElement | null}
 */
function getLauncherHost() {
    const bar = getQuickReplyBar(); if (!bar) return null;
    return bar.querySelector('.qr--buttons') || bar;
}
/** Creates or recreates the launcher icon(s) per settings.launcherMode. */
function ensureLauncher() {
    const existing = document.getElementById('uris_launcher');
    if (!state.settings.enabled) { existing?.remove(); removeFloatingLauncher(); return null; }
    // Пульс генерации в любом режиме лаунчера: пульсирует и бар-кнопка
    // (#uris_launcher.uris_generating), не только FAB. Биндинг безусловный —
    // раньше слушатели вешались только в FAB-ветке, и в дефолтном
    // launcherMode 'bar' пульс не работал вовсе (idempotent по guard'у).
    bindStage2Pulse();
    // FAB mounts independently of the QR bar, so the panel stays reachable
    // even with the Quick Replies extension disabled (как у DS Comments).
    const mode = state.settings.launcherMode || 'bar';
    if (mode === 'floating' || mode === 'both') ensureFloatingLauncher({ onToggle: toggleLauncherPanel });
    else removeFloatingLauncher();
    if (mode === 'floating') { existing?.remove(); return null; }
    const host = getLauncherHost();
    if (!host) return null;
    let btn = existing;
    if (!btn) {
        btn = document.createElement('div');
        btn.id = 'uris_launcher';
        btn.className = 'qr--button menu_button interactable uris_launcher';
        btn.tabIndex = 0; btn.setAttribute('role', 'button');
        btn.setAttribute('aria-label', DISPLAY_NAME);
        btn.innerHTML = '<span aria-hidden="true">🎨</span>';
        btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleLauncherPanel(); });
    }
    if (btn.parentElement !== host) host.appendChild(btn);
    btn.classList.toggle('uris_launcher_active', isPanelVisible());
    return btn;
}
/** Toggles the floating panel visibility and applies chat binding when opening. */
async function toggleLauncherPanel() {
    if (!state.settings.enabled) return;
    state.settings.collapsed = !state.settings.collapsed;
    saveSettings();
    mountPanel(); renderTabs(); syncPanelVisibility();
    if (!state.settings.collapsed) {
        // Await chat config load before showing the tab — otherwise persist from UI
        // arrives before runtime fields are set.
        setActiveTab(resolveInitialTab('generate'), { persist: false });
        const cfg = await loadChatConfig();
        applyChatConfigToState(cfg);
    }
    ensureLauncher();
}
/**
 * Attaches a MutationObserver to the send form to keep the launcher icon present.
 * @returns {void}
 */
function attachLauncherObserver() {
    if (_launcherObserver) return;
    const sendForm = document.getElementById('send_form');
    if (!sendForm) return;
    _launcherObserver = new MutationObserver(debounce(() => { if (state.settings.enabled) ensureLauncher(); }, 100));
    _launcherObserver.observe(sendForm, { childList: true, subtree: true });
}

// ── Cleanup ──

/**
 * Cleans up observers, listeners, controllers, and UI elements created by the extension.
 * @returns {void}
 */
function cleanup() {
    deactivateBridge();
    releaseSingletonLock();
    unbindAbortUI();
    abortAllGenerations();
    if (state.queueAbort) state.queueAbort.abort();
    // Land any in-flight card/template/pool writes before teardown; a disable
    // must not drop a queued mutation.
    void flushAllFileStores();
    unbindEvents();
    void import('./src/inline/scanner.js').then(m => m.unbindScanner());
    void import('./src/inline/render.js').then(m => m.shutdownRender());
    removeViewportSync();
    if (_launcherObserver) { _launcherObserver.disconnect(); _launcherObserver = null; }
    if (_visibilityHandler) { document.removeEventListener('visibilitychange', _visibilityHandler); _visibilityHandler = null; }
    if (_pageHideHandler) { window.removeEventListener('pagehide', _pageHideHandler); _pageHideHandler = null; }
    if (_onPostFollow) { window.removeEventListener('uris:post-follow', _onPostFollow); _onPostFollow = null; }
    if (_onGenerationDefaultsChanged) { window.removeEventListener('uris:chat-generation-defaults-changed', _onGenerationDefaultsChanged); _onGenerationDefaultsChanged = null; }
    if (_onLauncherModeChanged) { window.removeEventListener('uris:launcher-mode-changed', _onLauncherModeChanged); _onLauncherModeChanged = null; }
    if (_onChatChangedRefresh) { window.removeEventListener('uris:chat-changed', _onChatChangedRefresh); _onChatChangedRefresh = null; }
    removePanel();
    document.getElementById('uris_launcher')?.remove();
    removeFloatingLauncher();
    _initialized = false;
    log('Cleanup.');
}
