// @ts-check
/**
 * UR Image Studio — core: state, defaults, persistence, utils.
 */

import { decompress as fzstdDecompress } from './vendor/fzstd.esm.js';
// Circular import netdump → core is safe: netdump functions are called
// only at runtime (inside fetchWithTimeout), not at module load time.
import { recordFromFetch, recordFromFetchError } from './netdump.js';

export const MODULE_NAME = 'ur_image_studio';
export const DISPLAY_NAME = 'UR Image Studio';

// localforage keys
export const LF_IMAGE_PARAMS = 'uris_image_params';        // image param preset array
export const LF_TEXT_PARAMS = 'uris_text_params';          // text param preset array
export const LF_TEMPLATES = 'uris_prompt_templates';       // prompt template array
export const LF_GALLERY_PREFIX = 'uris_gallery_';          // + chatId
export const LF_HISTORY_PREFIX = 'uris_prompt_history_';   // + chatId
export const LF_API_KEY = 'uris_custom_apikey';            // API key for the "Custom" source (localforage, NOT in settings JSON)
export const IMAGE_CONNECTION_SETTINGS_KEY = 'imageConnections';
export const IMAGE_CONNECTION_KEY_PREFIX = 'uris_api_key:';
export const defaultImageConnectionSettings = Object.freeze({
    schemaVersion: 1,
    connections: [],
    catalogs: {},
    galleryIndex: [],
    templates: [],
    presets: [],
    refs: [],
    folders: [],
    selectedRouteId: null,
});
export function getImageConnectionSettings(settings = {}) {
    const value = settings?.[IMAGE_CONNECTION_SETTINGS_KEY];
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const {
        apiKey: _apiKey,
        api_key: _api_key,
        token: _token,
        password: _password,
        secret: _secret,
        secretId: _secretId,
        ...safeInput
    } = input;
    return {
        ...defaultImageConnectionSettings,
        ...safeInput,
        schemaVersion: 1,
        connections: Array.isArray(input.connections) ? input.connections : [],
        catalogs: input.catalogs && typeof input.catalogs === 'object' && !Array.isArray(input.catalogs) ? input.catalogs : {},
        galleryIndex: Array.isArray(input.galleryIndex) ? input.galleryIndex : [],
        templates: Array.isArray(input.templates) ? input.templates : [],
        presets: Array.isArray(input.presets) ? input.presets : [],
        refs: Array.isArray(input.refs) ? input.refs : [],
        folders: Array.isArray(input.folders) ? input.folders : [],
        selectedRouteId: typeof input.selectedRouteId === 'string' && input.selectedRouteId ? input.selectedRouteId : null,
    };
}
export function getImageConnectionKeyNamespace(connectionId) {
    const id = String(connectionId || '').trim();
    return `${IMAGE_CONNECTION_KEY_PREFIX}${id}`;
}
export const LF_REFS_POOL = 'uris_refs_pool';        // reference array
export const LF_REFS_FOLDERS = 'uris_refs_folders';  // flat folder array
export const LF_GENERATION_DRAFT_PREFIX = 'uris_generation_draft:'; // + chatId + msgId → message-scoped generation draft
export const META_KEY = 'uris_binding';

export const VALID_ASPECT_RATIOS = ['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9'];
export const VALID_IMAGE_SIZES = ['1K','2K','4K'];

/**
 * @typedef {'base'|'instruction'} TemplateType
 * @typedef {'manual'|'build-prompt'|'full-pipeline'} AutomationMode
 *
 * @typedef {{id:string,name:string,aliases:string[],description:string,imagePath:string,bindingMode:'image'|'description'}} SceneEntity
 * @typedef {{includedIds:string[],excludedIds:string[],revision:number}} ReferenceCorrections
 *
 * @typedef {{
 *   chatId:string,
 *   msgId:number,
 *   messageHash:string,
 *   contextRevision:number,
 *   entities:SceneEntity[],
 *   stage1Descriptions:Array<{id:string,name:string,description:string}>,
 *   stage2Refs:Array<{id:string,name:string,imagePath:string,description:string,bindingMode:'image'|'description',matchedLabel:string}>,
 *   ambiguities:Array<{mention:string,candidateIds:string[]}>,
 * }} SceneContextSnapshot
 *
 * @typedef {{
 *   prompt:string,
 *   templateId:string|null,
 *   templateType:TemplateType,
 *   structuredDraft:object|null,
 *   sourceMsgId:number,
 *   contextRevision:number,
 *   raw:string|null
 * }} Stage1Result
 *
 * `templateId` here is the template that produced the Stage 1 result. When the
 * result is applied to a draft, it is only authoritative if the draft's
 * `templateSelection` is 'override'; default drafts keep `templateId: null` and
 * continue to follow `state.activeTemplateId`.
 *
 * @typedef {{
 *   id:string,name:string,
 *   dataUrl?:string,url?:string,
 *   label?:string,description?:string,bindingMode?:'image'|'description'
 * }} Stage2Reference
 *
 * @typedef {{
 *   sourceMsgId:number,
 *   messageHash:string,
 *   prompt:string,
 *   aspectRatio:string,
 *   imageSize:string,
 *   quality:string,
 *   refs:Stage2Reference[],
 *   templateId:string|null,
 *   contextRevision:number,
 *   submittedAt:string
 * }} Stage2Snapshot
 *
 * Immutable chat-scoped generation configuration snapshot used by the pipeline
 * and queue so an in-flight request cannot observe a later chat's config.
 * @typedef {{
 *   imageProfileId:string|null,
 *   templateId:string|null,
 *   generationDefaults?:object,
 *   imageRoute?:object|null,
 *   imageConnection?:object|null
 * }} ChatConfigSnapshot
 */

// Central session state
export const state = {
    settings: null,
    currentChatId: null,
    currentMsgId: null,        // selected/last AI post in the navigator
    activeTemplateId: null,    // active prompt template, used as default for generation.
    generationDefaults: {},    // chat-scoped model/format/quality preferences.
    queue: [],                 // batch generation queue: [{msgId, resolve, reject}]
    queueRunning: false,
    queueAbort: null,          // separate AbortController for the entire queue
    runningQueueRequestId: null, // requestId of the currently-running queue item (for «Пропустить»)
    abortController: null,     // DEPRECATED: replaced by activeGenerations Map; kept for migration safety
    activeGenerations: new Map(), // Map<requestId, AbortController> - per-request cancellation
    // Per-msgId FIFO chain for manual Stage 2 (Promise-chain). Each manual
    // click (tab-generate #urisGenImg, gallery [data-act="regen"]) enters
    // a per-post queue and executes strictly one after another,
    // producing a separate image per click (=> 100 clicks = 100 images,
    // even with identical inputs). Upstream requests are not deduplicated
    // (sequential chain). Auto-flow (auto-after Stage 2)
    // bypasses the chain via opts.isAuto and runs in parallel — both results
    // are saved. Map.update/remove is managed in pipeline.runStage2.
    stage2Chains: new Map(),

    // Active profiles are managed by the per-chat schema-v5 config.
    activeImageProfileId: null,
    lastInstruction: null,     // last built Stage 1 instruction
    styleOverride: '',         // runtime style override from UI (overrides pinned/random/llm-pick)
    // pendingSourceMsgId / pendingSourceMesHash are set in runStage1
    // for race-safe post checking before anchor injection (pipeline.js).

    // Snapshot of references actually sent by the last generation (for inline preview on the Generate tab).
    lastSentRefs: null,
};

/**
 * Abort a single in-flight generation by its requestId.
 * The AbortController stays in the Map until the pipeline's finally block
 * removes it (the pipeline owns the lifecycle); this function only fires
 * the abort signal.
 * @param {string} requestId
 * @returns {boolean} true if a controller was found and aborted
 */
export const CANCELLATION_REASONS = Object.freeze({
    MANUAL: 'manual',
    QUEUE_STOP: 'queue-stop',
    TIMEOUT: 'timeout',
    PROVIDER_ERROR: 'provider-error',
    PROXY_ERROR: 'proxy-error',
    LIFECYCLE: 'lifecycle',
});

export function abortGeneration(requestId, reason = CANCELLATION_REASONS.MANUAL) {
    const controller = state.activeGenerations.get(requestId);
    if (controller) {
        try { controller.reason = reason; } catch { /* native controllers may be non-extensible */ }
        controller.abort(reason);
        return true;
    }
    return false;
}

/**
 * Abort ALL in-flight generations. Used by cleanup() (extension unload) - the
 * batch queue stop (stopQueue) is scoped to its own controller and does not
 * call this. Does not clear the Map - each pipeline's finally block removes
 * its own entry.
 */
export function abortAllGenerations() {
    for (const controller of state.activeGenerations.values()) {
        try { controller.abort(); } catch { /* already aborted */ }
    }
}

// Default extension settings (extensionSettings[MODULE_NAME])
export const defaultSettings = Object.freeze({
    enabled: true,
    collapsed: true,           // window hidden until first open
    activeTab: 'generate',     // last selected floating window tab
    automationMode: 'manual',   // 'manual' | 'build-prompt' | 'full-pipeline'
    experimentalTemplateFromDescription: false,
    generationFlow: 'ai-only', // 'ai-only' | 'user-only' | 'all' | 'manual'
    followLastPost: true,      // Generation tab navigator follows the last post
    historyRich: true,         // store objects instead of strings in history
    maxRetries: 0,
    retryDelay: 1000,
    generationTimeout: 300000,   // 5 min: GPT-image regularly takes 80–280s
    historyLimit: 20,
    galleryLimit: 0,           // 0 = no limit
    windowGeometry: null,      // {left,top,width,height}
    uiScale: 1,                // content zoom multiplier for the floating window (Settings tab)
    fontScale: 1,              // text-only multiplier on top of uiScale (Settings tab)

    // ── Stage completion notifications (see NOTIFY_DEFAULTS) ──
    notifyStage1: false,
    notifyStage2: true,
    notifyStage1Sound: 'soft',
    notifyStage2Sound: 'chime',
    notifyVolume: 80,          // 0..100
    notifyOnlyUnfocused: true,
    advancedMode: false,       // show advanced controls in UI
    debugMode: false,           // capture verbose trace diagnostics without console spam
    useParametersForAllChats: false,
    globalGenerationDefaults: Object.freeze({
        modelId: null,
        aspectRatio: null,
        imageSize: null,
        quality: null,
    }),
    // UI accordion state: sectionId -> true (open) | false (collapsed).
    // Default for a missing key = open. See src/ui/accordion-state.js.
    accordionState: {},

    // ── Text-LLM source (for building the image prompt) ──
    // 'profile' = Connection Manager ST (routed by ST server — no CORS/405).
    // 'custom'  = direct browser fetch to OpenAI-compatible endpoint (needs CORS headers).
    apiSource: 'profile',
    profileId: '',             // Connection Profile id for 'profile' source
    customEndpoint: '',        // URL for 'custom' source
    customModel: '',           // model id (opt.) for 'custom' source
});

// Schema-v4 chat-scoped config envelope default.
// Canonical source: both chat-binding.js and refs-library.js derive defaults here.
export const DEFAULT_CHAT_CONFIG_ENVELOPE = Object.freeze({
    schemaVersion: 5,
    config: Object.freeze({
        imageProfileId: null,
        templateId: null,
        generationDefaults: Object.freeze({
            modelId: null,
            aspectRatio: null,
            imageSize: null,
            quality: null,
        }),
        automationMode: 'manual',
        generationFlow: 'ai-only',
    }),
    refs: Object.freeze({
        referenceIds: [],
        folderIds: [],
    }),
});

// ── ST context ──
export function getCtx() { return SillyTavern.getContext(); }

// ── Logging ──
const logBuffer = [];
const debugBuffer = [];
const MAX_LOG = 300;
const MAX_DEBUG_LOG = 300;
const MAX_LOG_ARG_CHARS = 2000;
const SECRET_KEY_RE = /(?:api[-_]?key|authorization|token|password|secret|credential)/i;

function serializeLogArg(value) {
    if (value instanceof Error) {
        const stack = typeof value.stack === 'string' ? value.stack.slice(0, MAX_LOG_ARG_CHARS) : '';
        return `${value.name || 'Error'}: ${value.message || ''}${stack ? `\n${stack}` : ''}`;
    }
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value.length > MAX_LOG_ARG_CHARS
        ? `${value.slice(0, MAX_LOG_ARG_CHARS)} …(truncated)`
        : value;
    if (typeof value !== 'object') return String(value);
    try {
        const seen = new WeakSet();
        const json = JSON.stringify(value, (key, item) => {
            if (SECRET_KEY_RE.test(key)) return '<redacted>';
            if (item && typeof item === 'object') {
                if (seen.has(item)) return '[Circular]';
                seen.add(item);
            }
            return item;
        });
        return json.length > MAX_LOG_ARG_CHARS
            ? `${json.slice(0, MAX_LOG_ARG_CHARS)} …(truncated)`
            : json;
    } catch {
        try { return String(value); } catch { return '[Unserializable]'; }
    }
}

function serializeLogArgs(args) {
    return args.map(value => serializeLogArg(value)).join(' ');
}

function push(buffer, level, args, limit) {
    const ts = new Date().toISOString();
    buffer.push(`[${ts}] [${level}] ${serializeLogArgs(args)}`);
    if (buffer.length > limit) buffer.shift();
}

export function log(...a)   { push(logBuffer, 'INFO', a, MAX_LOG); console.log('[URIS]', ...a); }
export function warn(...a)  { push(logBuffer, 'WARN', a, MAX_LOG); console.warn('[URIS]', ...a); }
export function error(...a) { push(logBuffer, 'ERROR', a, MAX_LOG); console.error('[URIS]', ...a); }

/** Verbose success-path diagnostics. Never writes to console; gated by debugMode. */
export function trace(...a) {
    if (state.settings?.debugMode !== true) return;
    push(debugBuffer, 'DEBUG', a, MAX_DEBUG_LOG);
}

export function dumpLog() {
    return logBuffer.length ? logBuffer.join('\n') : '(лог URIS пуст)';
}

/**
 * WARN/ERROR slice of the log for the diagnostic dump. INFO lines duplicate
 * the structured eventLog (stage transitions, capability observations), so
 * shipping the full log meant paying for every success-path line twice.
 */
export function dumpProblemLog() {
    const problems = logBuffer.filter(line => line.includes(' [WARN] ') || line.includes(' [ERROR] '));
    return problems.length ? problems.join('\n') : '';
}

export function dumpDebugLog() {
    if (state.settings?.debugMode !== true) return '(дебаг-лог пуст: Debug-режим выключен)';
    return debugBuffer.length ? debugBuffer.join('\n') : '(дебаг-лог пуст)';
}

/** Clear both console-mirror and verbose diagnostic buffers. */
export function clearDiagnosticLogs() {
    logBuffer.length = 0;
    debugBuffer.length = 0;
}

/** Backward-compatible alias used by the settings UI and older callers. */
export function clearDebugLog() { clearDiagnosticLogs(); }

// ── Notifications (stage completion sounds) ──
// Catalog shared by loadSettings validation and the Settings tab select.
// Envelope synthesis lives in src/notify.js, keyed by these ids.
export const NOTIFY_SOUNDS = Object.freeze({
    none:    { label: 'Без звука' },
    soft:    { label: 'Мягкий сигнал' },
    chime:   { label: 'Куранты' },
    bell:    { label: 'Колокол' },
    digital: { label: 'Цифровой бип' },
    pop:     { label: 'Поп' },
});
export const NOTIFY_DEFAULTS = Object.freeze({
    stage1Enabled: false,        // opt-in: manual prompt building is watched live
    stage2Enabled: true,         // image gen takes 80–280s — the "walked away" case
    stage1Sound: 'soft',
    stage2Sound: 'chime',
    volume: 80,                  // 0..100
    onlyUnfocused: true,         // mirrors ST core play_sound_unfocused default
});

// ── Settings persistence ──

// UI scale bounds for the Settings tab slider. Multiplier applied as CSS zoom
// on the window's tabs+body content (see style.css) — the window box itself
// stays unscaled so drag/resize geometry is unaffected.
export const UI_SCALE_MIN = 0.75;
export const UI_SCALE_MAX = 1.5;
export const UI_SCALE_STEP = 0.05;
export const UI_SCALE_DEFAULT = 1;

// Font scale bounds: an additional text-only multiplier on top of the UI
// zoom (total text size = product of the two). Kept narrower than the zoom:
// the base sizes are already compact, so <85% text becomes unreadable while
// >140% starts breaking fixed-size icon chips.
export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.4;
export const FONT_SCALE_STEP = 0.05;
export const FONT_SCALE_DEFAULT = 1;

/** Snap n to the slider step grid (collapsing float noise) and clamp. */
function snapScale(value, step, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    // Final /100 round collapses step-multiplication float noise
    // (25 * 0.05 → 1.2500000000000002) back onto the slider's decimal grid.
    const snapped = Math.round(Math.round(n / step) * step * 100) / 100;
    return Math.min(max, Math.max(min, snapped));
}

/** Clamp a persisted uiScale to [MIN, MAX] and snap it to the slider step. */
export function normalizeUiScale(value) {
    return snapScale(value, UI_SCALE_STEP, UI_SCALE_MIN, UI_SCALE_MAX, UI_SCALE_DEFAULT);
}

/** Clamp a persisted fontScale to [MIN, MAX] and snap it to the slider step. */
export function normalizeFontScale(value) {
    return snapScale(value, FONT_SCALE_STEP, FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_DEFAULT);
}

/** Clamp notification volume to 0..100 (integer). */
export function normalizeNotifyVolume(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return NOTIFY_DEFAULTS.volume;
    return Math.min(100, Math.max(0, Math.round(n)));
}

/** Publish the current uiScale as the --uris-scale CSS custom property. */
export function applyUiScale() {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (!root || !root.style || typeof root.style.setProperty !== 'function') return;
    root.style.setProperty('--uris-scale', String(state.settings?.uiScale ?? UI_SCALE_DEFAULT));
}

/** Publish the current fontScale as the --uris-font-scale CSS custom property. */
export function applyFontScale() {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (!root || !root.style || typeof root.style.setProperty !== 'function') return;
    root.style.setProperty('--uris-font-scale', String(state.settings?.fontScale ?? FONT_SCALE_DEFAULT));
}

export function loadSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings[MODULE_NAME]) ctx.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    const s = ctx.extensionSettings[MODULE_NAME];
    for (const k of Object.keys(defaultSettings)) if (!Object.hasOwn(s, k)) s[k] = defaultSettings[k];
    // Normalize apiSource enum.
    if (!['profile', 'custom'].includes(s.apiSource)) s.apiSource = defaultSettings.apiSource;
    // Debug must be opt-in; never treat persisted strings or numbers as enabled.
    s.debugMode = s.debugMode === true;
    s.useParametersForAllChats = s.useParametersForAllChats === true;
    const globalDefaults = s.globalGenerationDefaults;
    s.globalGenerationDefaults = {
        modelId: typeof globalDefaults?.modelId === 'string' && globalDefaults.modelId.trim() ? globalDefaults.modelId.trim() : null,
        aspectRatio: VALID_ASPECT_RATIOS.includes(globalDefaults?.aspectRatio) ? globalDefaults.aspectRatio : null,
        imageSize: VALID_IMAGE_SIZES.includes(globalDefaults?.imageSize) ? globalDefaults.imageSize : null,
        quality: typeof globalDefaults?.quality === 'string' && globalDefaults.quality.trim() ? globalDefaults.quality.trim() : null,
    };
    // accordionState must be a plain object.
    if (typeof s.accordionState !== 'object' || s.accordionState === null || Array.isArray(s.accordionState)) {
        s.accordionState = {};
    }
    s.uiScale = normalizeUiScale(s.uiScale);
    s.fontScale = normalizeFontScale(s.fontScale);
    // Notification flags are strict booleans (never truthy strings); stage2
    // defaults to enabled (`!== false`) so updaters get the feature by default.
    s.notifyStage1 = s.notifyStage1 === true;
    s.notifyStage2 = s.notifyStage2 !== false;
    s.notifyOnlyUnfocused = s.notifyOnlyUnfocused !== false;
    if (!Object.hasOwn(NOTIFY_SOUNDS, s.notifyStage1Sound)) s.notifyStage1Sound = NOTIFY_DEFAULTS.stage1Sound;
    if (!Object.hasOwn(NOTIFY_SOUNDS, s.notifyStage2Sound)) s.notifyStage2Sound = NOTIFY_DEFAULTS.stage2Sound;
    const notifyVolume = normalizeNotifyVolume(s.notifyVolume);
    s.notifyVolume = notifyVolume;
    state.settings = s;
}
export function saveSettings() { getCtx().saveSettingsDebounced(); }
export function flushSettings() {
    try {
        const ctx = getCtx();
        if (typeof ctx.saveSettings === 'function') ctx.saveSettings();
        else ctx.saveSettingsDebounced?.();
    } catch { /* debounced fallback */ }
}

// ── Utils ──
export function deepClone(obj) {
    try {
        return structuredClone(obj);
    } catch {
        return JSON.parse(JSON.stringify(obj));
    }
}

/** Return a deep clone of the canonical schema-v5 chat config envelope. */
export function getDefaultChatConfigEnvelope() {
    return deepClone(DEFAULT_CHAT_CONFIG_ENVELOPE);
}

/**
 * Escape a string for safe interpolation into HTML text OR a double/single-quoted
 * attribute. `textContent`->`innerHTML` serializes `&`, `<`, `>` (and nbsp) but
 * NOT quotes, so a value containing `"` would break out of `attr="${escapeHtml(x)}"`
 * (attribute injection). The two trailing replaces close that hole, making the
 * result safe in every context this codebase uses (text nodes, `data-*`, `title`,
 * `alt`, `src`, `value`, `style`-inline). Keep using this single helper; there is
 * no separate attribute escaper.
 * @param {string|number|null|undefined} t
 * @returns {string}
 */
export function escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t == null ? '' : String(t);
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export function decodeEntities(s) {
    // First numeric entities (&#NN; / &#xHH;), then named,
    // &amp; last so we don't double-decode (&amp;quot; ≠ ").
    return String(s == null ? '' : s)
        .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } })
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
}
export function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/**
 * Debounced save for CRUD cards: saver({id, ...collect()}).
 * @param {Function} saver — async (patch) => void
 * @param {string} id
 * @param {Function} collect — () => object
 * @param {number} [ms=400]
 */
export function debounceSave(saver, id, collect, ms = 400) {
    let t;
    return () => {
        clearTimeout(t);
        t = setTimeout(async () => { await saver({ id, ...collect() }); }, ms);
    };
}
export function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

/**
 * Call fn with retry on network errors.
 *
 * @param {(attempt: number) => Promise<any>} fn
 * @param {string} label — for logging
 * @param {'network' | 'generation'} [mode='network']
 *   - 'network'     — retry 429/502/503/504/network/CORS. Do NOT retry timeout:
 *                     retrying is usually useless (LLM either responds in time or hangs).
 *   - 'generation'  — same but applies to paid image generation. Semantically
 *                     identical to 'network' (timeout excluded from retryable in both modes),
 *                     but kept as an explicit marker: "this is generation, retry = money".
 *
 * Timeout is NOT retried in any mode: retrying a paid generation on timeout
 * guaranteed spends money twice (provider finishes and charges), returning no
 * result. The old regex included "Timeout" → with maxRetries>0 it burned money N times.
 */
export async function callWithRetry(fn, label, mode = 'network', signal = null) {
    const s = state.settings;
    // Retryable: transient network failures. Timeout excluded intentionally (see jsdoc).
    const retryable = /429|502|503|504|network|Failed to fetch|CORS|unavailable/i;
    const throwIfAborted = () => {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    };
    const wait = (ms) => new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        const timer = setTimeout(done, ms);
        const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(new DOMException('Aborted', 'AbortError')); };
        function done() { signal?.removeEventListener('abort', onAbort); resolve(); }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
    let lastErr;
    for (let attempt = 0; attempt <= s.maxRetries; attempt++) {
        throwIfAborted();
        try { return await fn(attempt, signal); }
        catch (e) {
            lastErr = e;
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            log(`${label} attempt ${attempt + 1}: ${e.message}`);
            if (!retryable.test(e.message) || attempt === s.maxRetries) break;
            await wait(s.retryDelay * Math.pow(2, attempt));
        }
    }
    throw lastErr;
}

// ── Custom-endpoint API key (localforage-backed; NOT in settings JSON — spec §10 like DS Comments) ──
const apiKeyState = { revision: 0, chain: Promise.resolve(), value: null };
export async function getApiKey() {
    const revision = apiKeyState.revision;
    try {
        const value = (await SillyTavern.libs.localforage.getItem(LF_API_KEY)) || '';
        if (revision === apiKeyState.revision) apiKeyState.value = value;
        return value;
    } catch { return ''; }
}
export function setApiKey(value) {
    const v = (value || '').trim();
    const revision = ++apiKeyState.revision;
    apiKeyState.value = v;
    apiKeyState.chain = apiKeyState.chain.then(async () => {
        if (revision !== apiKeyState.revision) return;
        try {
            if (v) await SillyTavern.libs.localforage.setItem(LF_API_KEY, v);
            else await SillyTavern.libs.localforage.removeItem(LF_API_KEY);
        } catch { /* non-critical */ }
    });
    return apiKeyState.chain;
}

/**
 * Normalize endpoint base URL: strip trailing slash and /v1 suffix
 * (suffix is added by callers — /v1/chat/completions, /v1/images/generations, /v1/models).
 *   "https://api.x.com/v1/" → "https://api.x.com"
 *   "https://api.x.com/v1"  → "https://api.x.com"
 *   "https://api.x.com"     → "https://api.x.com"
 */
export function normalizeEndpoint(raw) {
    return String(raw || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

/**
 * Normalize URL to the full /v1/chat/completions path.
 *   "https://api.x.com"                   → ".../v1/chat/completions"
 *   "https://api.x.com/v1"                → ".../v1/chat/completions"
 *   "https://api.x.com/v1/chat/completions" → as is
 *   "http://127.0.0.1:1234"              → "...:1234/v1/chat/completions"
 */
export function normalizeEndpointUrl(raw) {
    let url = String(raw || '').trim().replace(/\/+$/, '');
    if (!url) return '';
    if (/\/chat\/completions$/i.test(url)) return url;
    if (/\/v1$/i.test(url)) return url + '/chat/completions';
    return url + '/v1/chat/completions';
}

/**
 * Resolve a custom Text-LLM API family from endpoint and model.
 * @returns {'gemini'|'openai'}
 */
export function resolveApiType(endpoint, model) {
    const ep = String(endpoint || '').toLowerCase();
    const m = String(model || '').toLowerCase();
    if (/generativelanguage\.googleapis\.com/.test(ep) || /\/v1beta\b/.test(ep) || /^(gemini|imagen)/.test(m)) {
        return 'gemini';
    }
    return 'openai';
}
export async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
    const ctrl = new AbortController();
    const deadlineAt = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    let timedOut = false;
    let settled = false;
    let timer;
    let rejectDeadline;
    const deadlinePromise = new Promise((_, reject) => { rejectDeadline = reject; });
    // Prevent an early timeout from becoming an unhandled rejection when a
    // response never exposes a body method.
    deadlinePromise.catch(() => {});
    const clearDeadline = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
    };
    const timeoutError = () => new Error(`Timeout (${Math.round(timeoutMs / 1000)}s)`);
    timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
        rejectDeadline(timeoutError());
    }, Math.max(0, deadlineAt - Date.now()));
    // Diagnostic metadata is consumed by netdump only and must never reach
    // native fetch as an unknown RequestInit field.
    const { __urisDiagnostic, ...requestOptions } = options || {};
    // Support external AbortSignal (v2: user cancellation stops fetch)
    const externalSignal = requestOptions.signal;
    if (externalSignal) {
        if (externalSignal.aborted) ctrl.abort();
        else externalSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    // Keep the deadline alive through the first body-consuming operation. Fetch
    // resolving headers is not completion: providers may still hang in json(),
    // blob(), text(), or arrayBuffer() after a paid request was accepted.
    const armBodyDeadline = (response) => {
        for (const method of ['json', 'blob', 'text', 'arrayBuffer']) {
            const original = response?.[method];
            if (typeof original !== 'function') continue;
            response[method] = (...args) => {
                const bodyRead = Promise.resolve().then(() => original.apply(response, args));
                return Promise.race([bodyRead, deadlinePromise])
                    .catch(error => {
                        if (timedOut && !externalSignal?.aborted) throw timeoutError();
                        throw error;
                    })
                    .finally(clearDeadline);
            };
        }
        return response;
    };
    // Network dumper: monitor all URIS browser fetches. Non-blocking —
    // recorder errors NEVER crash generation (fire-and-forget .catch).
    const _t0 = performance.now();
    try {
        const resp = await fetch(url, { ...requestOptions, signal: ctrl.signal });
        recordFromFetch(url, { ...requestOptions, __urisDiagnostic }, resp, performance.now() - _t0).catch(() => {});
        return armBodyDeadline(resp);
    } catch (e) {
        clearDeadline();
        recordFromFetchError(url, { ...requestOptions, __urisDiagnostic }, e, performance.now() - _t0).catch(() => {});
        if (e.name === 'AbortError') {
            if (externalSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
            if (timedOut) throw timeoutError();
        }
        throw e;
    }
}
// Lenient JSON parsing for text-LLM responses (model may wrap JSON in ```json blocks or text)
export function parseInstructionJson(raw) {
    const dec = decodeEntities(raw || '');
    const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
    let r = tryParse(dec);
    if (r) return r;
    // find first { ... } block
    const start = dec.indexOf('{');
    const end = dec.lastIndexOf('}');
    if (start !== -1 && end > start) {
        r = tryParse(dec.slice(start, end + 1));
        if (r) return r;
    }
    r = tryParse(dec.replace(/'/g, '"'));
    return r;
}
/**
 * Extract text from any LLM API response (OAI / Claude / Gemini / content-block arrays).
 * Single entry point — used by text-connection.js, providers/openai.js, providers/gemini.js.
 */
export function extractTextFromResponse(resp) {
    if (!resp) return null;
    if (typeof resp === 'string') return resp;
    if (Array.isArray(resp)) {
        const texts = resp.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text);
        if (texts.length > 0) return texts.join('\n');
    }
    if (resp.content !== undefined && resp.content !== null) {
        if (typeof resp.content === 'string') return resp.content;
        if (Array.isArray(resp.content)) {
            const texts = resp.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text);
            if (texts.length > 0) return texts.join('\n');
        }
    }
    if (resp.choices?.[0]?.message?.content) {
        const c = resp.choices[0].message.content;
        if (typeof c === 'string') return c;
    }
    if (Array.isArray(resp.candidates)) {
        const parts = resp.candidates[0]?.content?.parts;
        if (Array.isArray(parts)) {
            const texts = parts.filter(p => typeof p?.text === 'string' && !p.thought).map(p => p.text);
            if (texts.length > 0) return texts.join('');
        }
    }
    if (typeof resp.text    === 'string') return resp.text;
    if (typeof resp.message === 'string') return resp.message;
    if (typeof resp.message?.content === 'string') return resp.message.content;
    return null;
}

// Strip HTML markup from prompt
export function sanitizePrompt(t) {
    if (!t) return '';
    return t.replace(/<[^>]*>/g, '').replace(/javascript:/gi, '').trim();
}

// ── Modal wrappers over ST (like DS Comments) ──
export async function showConfirmModal(text) {
    const ctx = getCtx();
    if (ctx.callGenericPopup) {
        const r = await ctx.callGenericPopup(text, ctx.POPUP_TYPE.CONFIRM);
        return r === 1 || r === true;
    }
    return confirm(text);
}
export async function showInputModal(text, def = '') {
    const ctx = getCtx();
    if (ctx.callGenericPopup) {
        return await ctx.callGenericPopup(text, ctx.POPUP_TYPE.INPUT, def, { okButton: 'ОК' });
    }
    return prompt(text, def);
}

// ── Response body reading (proxy-safe: hidden Content-Encoding, missing Content-Type) ──
// spec: docs/archive/specs/2026-07-12-zstd-response-decompression-design.md §3, §4

/**
 * ASCII slice of bytes — needed for AVIF/HEIC/JXL magic-byte checks.
 */
function bytesToAscii(bytes, start, len) {
    return Array.from(bytes.slice(start, start + len)).map(b => String.fromCharCode(b)).join('');
}

/**
 * Detect image MIME type from magic bytes.
 * Needed when the ST proxy hides content-type or returns an empty one.
 * @param {Uint8Array|null} bytes
 * @returns {string|null}
 */
export function detectImageMime(bytes) {
    if (!bytes || bytes.length < 4) return null;
    const b = bytes;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b.length >= 12 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
    if (b.length >= 12 && bytesToAscii(b, 4, 4) === 'ftyp') {
        const brand = bytesToAscii(b, 8, 4);
        if (brand === 'avif' || brand === 'avis') return 'image/avif';
        if (brand === 'heic' || brand === 'heix') return 'image/heic';
    }
    if (b.length >= 8 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x00 && b[3] === 0x0C &&
        b[4] === 0x4A && b[5] === 0x58 && b[6] === 0x4C && b[7] === 0x20) return 'image/jxl';
    if (b[0] === 0xFF && b[1] === 0x0A) return 'image/jxl';
    return null;
}

/**
 * Bytes → dataUrl via FileReader. Used by all image providers.
 * @param {Uint8Array} bytes
 * @param {string} mime
 * @returns {Promise<string>}
 */
export async function bytesToDataUrl(bytes, mime) {
    const blob = new Blob([bytes], { type: mime });
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = rej;
        r.readAsDataURL(blob);
    });
}

function isZstd(b)  { return b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd; }
function isGzip(b)  { return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b; }

/** Feature-detect native DecompressionStream('zstd'). Cached after first probe. */
let _nativeZstd = undefined; // 'yes' | 'no' | undefined
async function tryNativeZstd(bytes) {
    if (_nativeZstd === undefined) {
        try { new DecompressionStream('zstd'); _nativeZstd = 'yes'; }
        catch { _nativeZstd = 'no'; }
    }
    if (_nativeZstd === 'no') return null;
    try {
        const stream = new Response(bytes).body?.pipeThrough(new DecompressionStream('zstd'));
        if (!stream) return null;
        const reader = stream.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value); total += value.length;
        }
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        return out;
    } catch { return null; }
}

/**
 * Decode a zstd frame (RFC 8878): native DecompressionStream('zstd') when the
 * browser supports it, otherwise the vendored fzstd polyfill. Returns null if
 * neither decoder accepts the bytes (corrupt/truncated frame) — callers keep
 * the original bytes and let their own parse fail with a meaningful error.
 *
 * Shared by every recovery path (readResponseBody below,
 * providers/image-base.js, catalog.js): ST's /proxy/ forwards upstream bytes
 * with the Content-Encoding header hidden, so raw zstd frames reach JS
 * (runbook 2026-07-11, fuzhan.magicv4.ltd).
 */
export async function decodeZstdBytes(bytes) {
    // Every zstd frame starts with the magic — fzstd happily returns an
    // empty result for empty input otherwise, which would masquerade as a
    // successful decode of e.g. an empty error body.
    if (!isZstd(bytes)) return null;
    const native = await tryNativeZstd(bytes);
    if (native) return native;
    try { return fzstdDecompress(bytes); }
    catch { return null; }
}

/** Test-only: clear the cached native-zstd feature probe. */
export function __resetZstdProbe() { _nativeZstd = undefined; }

async function tryGunzip(bytes) {
    try {
        const stream = new Response(bytes).body?.pipeThrough(new DecompressionStream('gzip'));
        if (!stream) return null;
        const reader = stream.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value); total += value.length;
        }
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        return out;
    } catch { return null; }
}

/**
 * Safely read a provider response body accounting for hidden proxy compression
 * and missing Content-Type.
 *
 * Single arrayBuffer() call → detect by magic bytes → decompress if needed.
 * Does NOT throw "could not decompress" — falls through to text decode,
 * so the caller's JSON.parse gives a meaningful error.
 *
 * @param {Response} resp — fetch Response (body not yet read)
 * @returns {Promise<{ bytes: Uint8Array, text: string|null, mime: string|null }>}
 */
export async function readResponseBody(resp) {
    const buffer = await resp.arrayBuffer().catch((e) => { throw new Error('Failed to read response body', { cause: e }); });
    let bytes = new Uint8Array(buffer);

    // 1. Image — do not decode as text.
    const mime = detectImageMime(bytes);
    if (mime) return { bytes, text: null, mime };

    // 2. zstd: native (if supported) → polyfill. Corrupt frames keep the
    // original bytes so JSON.parse below throws a meaningful error.
    if (isZstd(bytes)) {
        const decoded = await decodeZstdBytes(bytes);
        if (decoded) bytes = decoded;
        // After decompression there may be an image.
        const mime2 = detectImageMime(bytes);
        if (mime2) return { bytes, text: null, mime: mime2 };
    }

    // 3. gzip (Content-Encoding hidden by proxy).
    if (isGzip(bytes)) {
        const out = await tryGunzip(bytes);
        if (out) {
            bytes = out;
            const mime3 = detectImageMime(bytes);
            if (mime3) return { bytes, text: null, mime: mime3 };
        }
    }

    // 4. Text.
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return { bytes, text, mime: null };
}
