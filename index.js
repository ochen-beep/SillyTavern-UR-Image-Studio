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
    debounce, applyUiScale, applyFontScale, showConfirmModal, abortAllGenerations,
} from './src/core.js';
import { initNotifyUnlock } from './src/notify.js';
import {
    loadChatConfig, applyChatConfigToState,
} from './src/chat-binding.js';
import { bindEvents, unbindEvents } from './src/events.js';
import { runStage1ForDraft, runFullPipelineForDraft, stopQueue } from './src/pipeline.js';
import {
    mountPanel, syncPanelVisibility, initViewportSync, removeViewportSync, removePanel, setStatus, isPanelVisible,
} from './src/ui/window.js';
import { ensureFloatingLauncher, removeFloatingLauncher } from './src/ui/floating-launcher.js';
import { registerTab, setActiveTab, renderTabs, getActiveTab, refreshActive, resolveInitialTab } from './src/ui/tabs.js';
import { render as renderApi } from './src/ui/tab-api.js';
import { render as renderReferences } from './src/ui/tab-references.js';
import { render as renderGenerate, bindAbortUI, unbindAbortUI } from './src/ui/tab-generate.js';
import { render as renderGallery } from './src/ui/tab-gallery.js';
import { render as renderTemplates } from './src/ui/tab-templates.js';
import { render as renderBridge } from './src/ui/tab-bridge.js';
import { render as renderSettings } from './src/ui/tab-settings.js';
import { render as renderMedia, applyInlineRuntime } from './src/ui/tab-media.js';
import { bindScanner, unbindScanner } from './src/inline/scanner.js';
import { shutdownRender } from './src/inline/render.js';
import { setCurrentMsgId, getLastPostIndex } from './src/post-navigator.js';
import { refreshPoolCache } from './src/refs-library.js';
import { runExport, runImportInteractive } from './src/data-port.js';
import { sweepStaleRunningDrafts } from './src/generation-drafts.js';
import { recordUrisError } from './src/error-pool.js';
import { exportDiagnosticDump, clearAllDiagnostics } from './src/diagnostic-dump.js';
import { loadDiagnosticEvents, flushDiagnosticEvents, recordDiagnosticEvent } from './src/diagnostic-events.js';
import { flushTemplateWrites, flushTemplateWritesOnUnload } from './src/template-file-store.js';
import { ensureGalleryStoreReady, flushGalleryWrites, flushGalleryWritesOnUnload } from './src/gallery-index.js';
import { ensureRefsStoreReady, flushRefsWrites, flushRefsWritesOnUnload } from './src/refs-library.js';
import { ensureParamPresetStoreReady, flushParamPresetWrites, flushParamPresetWritesOnUnload } from './src/param-presets.js';
import { ensureStudioStoreReady, flushStudioWrites, flushStudioWritesOnUnload } from './src/studio-scope.js';
import { exportNetDump } from './src/netdump.js';
import { activateBridge, deactivateBridge, markBridgeReady } from './src/bridge.js';

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
    catch (e) { error('init:', e); _initialized = false; }
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
    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) { error('SillyTavern unavailable'); return; }
    const ctx = getCtx(); if (!ctx) { warn('context unavailable'); return; }
    // Publish globalThis.URIS before any async work so consumers can grab the
    // global early and await URIS.ready for actual readiness.
    activateBridge();
    await loadSettings();
    applyUiScale();
    applyFontScale();
    initNotifyUnlock();
    await loadDiagnosticEvents();
    recordDiagnosticEvent({ event: 'session-start', details: { initialized: true } });

    if (state.settings.collapsed === undefined) state.settings.collapsed = true;

    // Populate the browser-local reference cache before UI consumers read it.
    await refreshPoolCache();

    // Resolve the file-backed stores before the first render: their contents
    // live on the server now, and the first read must see the migrated/persisted
    // data rather than an empty mirror. This is also what performs the one-time
    // migration out of extensionSettings (and drops the settings copy, which is
    // what keeps settings.json small).
    await Promise.all([
        ensureGalleryStoreReady(),
        ensureRefsStoreReady(),
        ensureParamPresetStoreReady(),
        ensureStudioStoreReady(),
    ]);

    // v4: 6 tabs (API / References / Generation / Gallery / Templates / Settings)
    registerTab({ id: 'api',         label: 'API',         render: renderApi });
    registerTab({ id: 'references',  label: 'Референсы',  render: renderReferences });
    registerTab({ id: 'generate',    label: 'Генерация',   render: renderGenerate });
    registerTab({ id: 'gallery',     label: 'Галерея',     render: renderGallery });
    registerTab({ id: 'templates',   label: 'Шаблоны',     render: renderTemplates });
    // Experimental bridge lab: hidden unless enabled on the Settings tab.
    registerTab({ id: 'bridge',      label: 'Мост',        render: renderBridge, visible: () => state.settings?.bridgeTab === true });
    // Inline media tab: hidden unless the inline master toggle is on (Settings / Media).
    registerTab({ id: 'media',       label: 'Медиа',       render: renderMedia, visible: () => state.settings?.inlineEnabled === true });
    registerTab({ id: 'settings',    label: 'Настройки',   render: renderSettings });

    // ST settings panel (minimal)
    createSettingsPanel();

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
        onAutomation: async ({ chatId, msgId, messageText, templateId, requestedAction }) => {
            if (!state.settings.enabled) return;
            const input = { chatId, msgId, messageText, templateId };
            try {
                if (requestedAction === 'build-prompt') {
                    const run = await runStage1ForDraft(input, s => setStatus(s));
                    if (run.applied) {
                        setStatus('Промпт готов — открой «Генерация»');
                        toastr?.info('Промпт построен');
                        if (isPanelVisible() && getActiveTab() === 'generate') refreshActive();
                    }
                } else if (requestedAction === 'full-pipeline') {
                    await runFullPipelineForDraft(input, s => setStatus(s));
                    setStatus('');
                    toastr?.success('Картинка сгенерирована');
                    if (isPanelVisible() && getActiveTab() === 'gallery') refreshActive();
                }
            } catch (e) {
                setStatus('');
                if (e?.name === 'AbortError') {
                    toastr?.info('Генерация отменена');
                } else {
                    error('Auto generation:', e.message);
                    recordUrisError({ scope: 'Автогенерация', message: e.message });
                    toastr?.error('Generation: ' + e.message);
                }
            }
        },
        // ST's global Stop button (stopGeneration) always emits GENERATION_STOPPED.
        // "Stop stops everything": cancel every in-flight extension generation and
        // the batch queue. Safe when idle — both calls are no-ops then.
        onStopAll: () => {
            abortAllGenerations();
            stopQueue();
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
            flushTemplateWritesOnUnload();
            flushGalleryWritesOnUnload();
            flushRefsWritesOnUnload();
            flushParamPresetWritesOnUnload();
            flushStudioWritesOnUnload();
            flushDiagnosticEvents();
            try { getCtx().saveMetadata?.(); } catch {}
        }
    };
    document.addEventListener('visibilitychange', _visibilityHandler);
    _pageHideHandler = () => {
        flushTemplateWritesOnUnload();
        flushGalleryWritesOnUnload();
        flushRefsWritesOnUnload();
        flushParamPresetWritesOnUnload();
        flushStudioWritesOnUnload();
    };
    window.addEventListener('pagehide', _pageHideHandler);

    // Inline engine runtime — via the shared Media-tab helper so the per-chat
    // cfg.enabled is synced with the master toggle at startup. The previous
    // direct bindScanner/initRender calls left every chat that never touched
    // the Media toggle with a dead scanner while the checkbox showed enabled.
    if (state.settings.inlineEnabled) {
        applyInlineRuntime();
    }

    log('Initialized v2 · catalog-v3 · nanogpt-image-catalog · no-model-toggle.');
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

// ── Settings panel ──

let _panelLoaded = false;
/**
 * Creates and injects the extension settings panel into the ST extensions settings container.
 * @returns {void}
 */
function createSettingsPanel() {
    if (_panelLoaded) return;
    // Different ST versions use either extensions_settings or extensions_settings2.
    const container = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    if (!container) { warn('createSettingsPanel: extension settings container not found'); return; }
    _panelLoaded = true;
    log('createSettingsPanel: rendering settings panel');
    const div = document.createElement('div');
    div.className = 'inline-drawer';
    div.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${DISPLAY_NAME}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input type="checkbox" id="uris_enabled" ${state.settings.enabled ? 'checked' : ''}><span>Включить</span></label>
            <div class="flex-row">
                <select id="uris_launcher_mode" class="uris-w-full" title="Какая кнопка открывает окно расширения">
                    <option value="bar" ${state.settings.launcherMode === 'bar' ? 'selected' : ''}>Кнопка: quick-reply бар</option>
                    <option value="floating" ${state.settings.launcherMode === 'floating' ? 'selected' : ''}>Кнопка: плавающая (FAB)</option>
                    <option value="both" ${state.settings.launcherMode === 'both' ? 'selected' : ''}>Кнопки: обе</option>
                </select>
            </div>
            <small class="uris_hint">Плавающая кнопка работает даже при выключенном расширении Quick Replies; её можно перетаскивать — позиция запоминается.</small>
            <small class="uris_hint">Debug-режим, масштаб интерфейса и остальные настройки — вкладка «Настройки» в окне расширения.</small>

            <hr>

            <div class="flex-row"><div id="uris_open_window" class="menu_button uris-w-full"><i class="fa-solid fa-window-restore"></i> Открыть окно</div></div>
            <div class="flex-row"><div id="uris_export_data" class="menu_button uris-w-full"><i class="fa-solid fa-file-export"></i> Экспорт данных (backup)</div></div>
            <div class="flex-row"><div id="uris_import_data" class="menu_button uris-w-full"><i class="fa-solid fa-file-import"></i> Импорт данных (backup)</div></div>
            <div class="flex-row"><div id="uris_export_diagnostic" class="menu_button uris-w-full"><i class="fa-solid fa-stethoscope"></i> Экспорт диагностики</div></div>
            <div class="flex-row"><div id="uris_export_network" class="menu_button uris-w-full"><i class="fa-solid fa-network-wired"></i> Экспорт сетевого дампа</div></div>
            <div class="flex-row"><div id="uris_clear_diagnostic" class="menu_button uris-w-full"><i class="fa-solid fa-eraser"></i> Очистить всю диагностику</div></div>
            <small class="uris_hint">Диагностика содержит технические события и ошибки текущей сессии. Сетевой дамп выгружается отдельно и может содержать ограниченные prompt/ответы модели; API-ключи и полные бинарные изображения не экспортируются. Очистка удаляет журналы и локальные recovery-записи.</small>
        </div>`;
    container.appendChild(div);
    bindSettingsPanel(div);
}

// ── Settings panel handlers ──

/**
 * Binds event listeners to the settings panel controls.
 * @param {HTMLElement} host - the settings panel element
 * @returns {void}
 */
function bindSettingsPanel(host) {
    host.querySelector('#uris_enabled').addEventListener('change', e => {
        state.settings.enabled = e.target.checked;
        saveSettings();
        if (state.settings.enabled && !_initialized) safeInit();
        else if (!state.settings.enabled && _initialized) cleanup();
        ensureLauncher(); syncPanelVisibility();
    });
    host.querySelector('#uris_launcher_mode').addEventListener('change', e => {
        state.settings.launcherMode = e.target.value;
        saveSettings();
        ensureLauncher();
        // Синхронизация селекта во вкладке «Настройки» окна (если открыта).
        window.dispatchEvent?.(new CustomEvent('uris:launcher-mode-changed'));
    });
    host.querySelector('#uris_open_window').addEventListener('click', () => {
        if (state.settings.collapsed) toggleLauncherPanel();
    });
    host.querySelector('#uris_export_data').addEventListener('click', runExport);
    host.querySelector('#uris_import_data').addEventListener('click', async () => {
        const result = await runImportInteractive();
        if (result) refreshActive();
    });
    host.querySelector('#uris_export_diagnostic').addEventListener('click', () => exportDiagnosticDump().catch(e => {
        error('exportDiagnosticDump:', e);
        recordUrisError({ scope: 'Диагностика', message: e?.message || String(e) });
    }));
    host.querySelector('#uris_export_network').addEventListener('click', () => exportNetDump().catch(e => {
        error('exportNetDump:', e);
        recordUrisError({ scope: 'Сетевой дамп', message: e?.message || String(e) });
    }));
    host.querySelector('#uris_clear_diagnostic').addEventListener('click', async () => {
        const confirmed = await showConfirmModal('Очистить всю диагностику?\n\nБудут удалены события, логи, ошибки, сетевой дамп и локальные recovery-записи. Recovery может описывать уже оплаченный запрос с неизвестным результатом; действие не отменяет запрос у провайдера.');
        if (!confirmed) return;
        try {
            const { netCount, pendingCount } = await clearAllDiagnostics();
            toastr?.success(`Диагностика очищена: события, логи, ошибки, сетевой дамп (${netCount}) и recovery (${pendingCount})`, DISPLAY_NAME);
        } catch (e) {
            error('clearDiagnostic:', e);
            recordUrisError({ scope: 'Диагностика', message: e?.message || String(e) });
            toastr?.error('Не удалось полностью очистить диагностику: ' + (e?.message || e), DISPLAY_NAME);
        }
    });
    // NOTE: intentionally NOT attaching our own toggle on .inline-drawer-toggle — the ST core
    // manages .hidden on .inline-drawer-content through its own delegated handler.
    // Previously a second toggle was attached here: clicking would toggle .hidden twice
    // → the class never changed → the user could not expand the settings panel
    // (seeing an "empty field" even though the DOM contained the checkbox and buttons).
}

// ── Cleanup ──

/**
 * Cleans up observers, listeners, controllers, and UI elements created by the extension.
 * @returns {void}
 */
function cleanup() {
    deactivateBridge();
    unbindAbortUI();
    abortAllGenerations();
    if (state.queueAbort) state.queueAbort.abort();
    // Land any in-flight card/template/pool writes before teardown; a disable
    // must not drop a queued mutation.
    void flushGalleryWrites();
    void flushTemplateWrites();
    void flushRefsWrites();
    void flushParamPresetWrites();
    void flushStudioWrites();
    unbindEvents();
    unbindScanner();
    shutdownRender();
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
