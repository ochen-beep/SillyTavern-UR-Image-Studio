// @ts-check
/**
 * UR Image Studio — core: state, defaults, persistence, utils.
 */

// Inline trigger registry: pure module (no core import) — no cycle. Used by
// loadSettings to normalize settings.inlineTriggers (see defaultSettings).
import { sanitizeTriggerList, DEFAULT_TRIGGERS } from './inline/triggers.js';
// Logging lives in logger.js (leaf module); core re-exports it for the ~80
// consumers and wires the debug gate to settings.debugMode below. No cycle:
// logger imports only error-pool.
import { bindDebugGate, clearDebugLog, clearDiagnosticLogs, dumpDebugLog, dumpLog, dumpProblemLog, error, log, trace, warn } from './logger.js';
// Timer helpers live in timers.js (leaf); core re-exports for the existing
// consumers. http.js (extracted below) imports the helper without a cycle.
import { unrefTimer } from './timers.js';

export const MODULE_NAME = 'ur_image_studio';
export const DISPLAY_NAME = 'UR Image Studio';

/** Пометка экспериментальной функции: может измениться или быть удалённой. */
export const UNSTABLE_BADGE = '<span class="uris-badge-unstable" title="Экспериментальная функция: поведение может измениться">unstable</span>';

// localforage keys.
// ЛЕГАСИ: LF_IMAGE_PARAMS / LF_TEXT_PARAMS / LF_GALLERY_PREFIX / LF_HISTORY_PREFIX
// больше никем не читаются и не пишутся — коллекции переехали в серверные файлы
// (file-store). Имена остаются как документация старых namespace и для тестов
// миграции data-port (проверяют, что эти ключи не попадают в бэкап).
export const LF_IMAGE_PARAMS = 'uris_image_params';        // legacy: image param preset array
export const LF_TEXT_PARAMS = 'uris_text_params';          // legacy: text param preset array
export const LF_TEMPLATES = 'uris_prompt_templates';       // legacy: template array (now: server file)
export const LF_GALLERY_PREFIX = 'uris_gallery_';          // legacy: + chatId (now: server file)
export const LF_HISTORY_PREFIX = 'uris_prompt_history_';   // legacy: + chatId
// LF_API_KEY moved to api-key-store.js (re-exported there — see the section below).
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
    runningQueueRequestId: null, // активная очередь-задача; читает diagnostic-dump
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

    // Live Stage 2 runs per post: Map<'chatId:msgId', count>. A manual submit
    // consults this before paying for a second generation of the same post —
    // an auto/bridge run in flight is invisible to the queue's dedup.
    activeStage2ByPost: new Map(),

    // Active profiles are managed by the per-chat schema-v5 config.
    activeImageProfileId: null,
    // Chat-scoped automation config (schema-v5 projection, see chat-binding.js).
    // Runtime-only: deliberately NOT part of state.settings — writing them there
    // leaked the last visited chat's mode into the globally persisted
    // settings.json, and it came back as the next session's startup default.
    chatAutomationMode: 'manual',  // 'manual' | 'build-prompt' | 'full-pipeline'

    // Snapshot of references actually sent by the last generation (for inline preview on the Generate tab).
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
    launcherMode: 'bar',       // 'bar' | 'floating' | 'both' — кнопка(и) запуска
    activeTab: 'generate',     // last selected floating window tab
    bridgeEnabled: false,      // external bridge (globalThis.URIS) — opt-in: permission UI не реализован,
                               // пока юзер явно не включит тумблер, чужие расширения генерировать не могут
                               // (старые сейвы без поля остаются включёнными — семантика !== false).
    bridgeTab: false,          // show the experimental "Мост" lab tab in the floating window
    bridgeAutoRefs: true,      // bridge lab prompt→refs auto-resolver on by default, global for all chats;
                               // off stays off once the user disables it (strict boolean, !== false)
    experimentalTemplateFromDescription: false,
    followLastPost: true,      // Generation tab navigator follows the last post
    maxRetries: 0,
    retryDelay: 1000,
    // Опыт доставки/диалекта — delivery-evidence.js; авто-повтор — pipeline-queue.js.
    autoRetryAmbiguous: false, // одна автоматическая переотправка очеред-задачи при IMAGE_DELIVERY_AMBIGUOUS
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
    // Stage 1 context: persona / {{char}} card / lorebook / chat history.
    // Everything is off by default — the prompt is built from the scene only
    // until the user enables blocks explicitly (see stage1-context.js).
    stage1IncludePersona: false,
    stage1IncludeCharacter: false,
    stage1IncludeLore: false,
    stage1HistoryDepth: 0,
    // UI accordion state: sectionId -> true (open) | false (collapsed).
    // Default for a missing key = open. See src/ui/accordion-state.js.
    accordionState: {},

    // ── Inline generation in chat (markers / keywords / 📷 button) ──
    inlineEnabled: false,      // инлайн-генерация в чате (маркеры/ключевые слова/кнопка)
    inlineListenUser: false,   // дефолт реагировать на ключевые слова в сообщениях юзера
    inlineChips: false,        // компакт-режим: готовые/ожидающие картинки — чипами, клик раскрывает
    inlineTriggers: null,      // профили; null → sanitizeTriggerList(DEFAULT_TRIGGERS) в потребителях
    // Лаунчер «Нарисовать по истории»: true — картинка всегда в конец поста;
    // false (дефолт) — автоопределение абзаца по цитате из промпта Stage 1.
    launcherShellAtEnd: false,

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
        // Pinned refs ride every generation of this chat without a prompt
        // mention (see withPinnedRefs in refs-library.js).
        pinnedIds: [],
    }),
});

/**
 * @typedef {Object} TextProfile
 * @property {'openai-like' | 'gemini'} provider
 * @property {string} endpoint - Base URL of the provider API.
 * @property {string} apiKey - API key used for authentication.
 * @property {string} model - Model identifier.
 * @property {number} [temperature] - Optional sampling temperature.
 */

// ── ST context ──
export function getCtx() { return SillyTavern.getContext(); }

// ── Logging (module: logger.js) ──
// Re-exported so core stays the single import point for the ~80 consumers;
// the ring buffers and secret redaction live in logger.js now.
export { bindDebugGate, clearDebugLog, clearDiagnosticLogs, dumpDebugLog, dumpLog, dumpProblemLog, error, log, trace, warn };
// The logger is a leaf module and must not know about settings: core wires
// the debug gate (trace/dumpDebugLog) once at load; re-evaluated per call,
// so toggling Debug mode applies live.
bindDebugGate(() => state.settings?.debugMode === true);

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
    // Launcher mode enum (кнопка в QR-баре / плавающая / обе).
    if (!['bar', 'floating', 'both'].includes(s.launcherMode)) s.launcherMode = 'bar';
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
    // Stage 1 context (persona/card/lore/history): strict booleans; depth is
    // 0/5/10/20, anything else → 0 (off).
    s.stage1IncludePersona = s.stage1IncludePersona === true;
    s.stage1IncludeCharacter = s.stage1IncludeCharacter === true;
    s.stage1IncludeLore = s.stage1IncludeLore === true;
    s.stage1HistoryDepth = [5, 10, 20].includes(s.stage1HistoryDepth) ? s.stage1HistoryDepth : 0;
    // Инлайн: флаги — строгие booleans; триггер-профили всегда нормализованы.
    // null/мусор (дефолт) разворачивается в sanitizeTriggerList(DEFAULT_TRIGGERS),
    // а не в [img] — иначе нормализация стёрла бы дефолтные selfie/scene.
    s.inlineEnabled = s.inlineEnabled === true;
    s.inlineListenUser = s.inlineListenUser === true;
    s.inlineChips = s.inlineChips === true;
    s.inlineTriggers = sanitizeTriggerList(Array.isArray(s.inlineTriggers) ? s.inlineTriggers : DEFAULT_TRIGGERS);
    s.uiScale = normalizeUiScale(s.uiScale);
    s.fontScale = normalizeFontScale(s.fontScale);
    // Notification flags are strict booleans (never truthy strings); stage2
    // defaults to enabled (`!== false`) so updaters get the feature by default.
    s.notifyStage1 = s.notifyStage1 === true;
    s.notifyStage2 = s.notifyStage2 !== false;
    s.notifyOnlyUnfocused = s.notifyOnlyUnfocused !== false;
    // Bridge lab auto-resolver defaults to enabled (saves without the key get
    // it on) and keeps the user's explicit off.
    s.bridgeAutoRefs = s.bridgeAutoRefs !== false;
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
 * attribute. Values containing `"` would otherwise break out of `attr="${escapeHtml(x)}"`
 * (attribute injection), so quotes are escaped too — the result is safe in every
 * context this codebase uses (text nodes, `data-*`, `title`, `alt`, `src`, `value`,
 * `style`-inline). Keep using this single helper; there is no separate attribute
 * escaper. Pure string implementation: no `document` dependency, the same function
 * is importable from Node-tested modules (ui/server-connection-form.js).
 * @param {string|number|null|undefined} t
 * @returns {string}
 */
export function escapeHtml(t) {
    return String(t == null ? '' : t)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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

export function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

/**
 * Единственный разрешённый алфавит идентификаторов карточек/референсов/папок.
 * Граница безопасности: id приходят из импортируемых бэкапов (чужой файл) и
 * интерполируются в HTML-атрибуты (data-id/data-folder) — всё, что ломает
 * атрибут (кавычки, скобки, пробелы, =, &), при приёме заменяется uid().
 * Буквы/цифры любого алфавита (\p{L}\p{N}) разрешены: uid() выдаёт base36,
 * bridge-атрибуция добавляет подчёркивания, а в данных и тестах живут
 * рукописные кириллические id — их вырезать незачем. Рендеры дополнительно
 * экранируют атрибуты (escapeHtml) — границ здесь две, а не одна.
 */
export const SAFE_ID_RE = /^[\p{L}\p{N}_-]{1,128}$/u;

/** Возвращает value, только если это строка-валидный id, иначе null. */
export function sanitizeId(value) {
    return (typeof value === 'string' && SAFE_ID_RE.test(value)) ? value : null;
}

/**
 * Не держать процесс Node живым ради таймера (тесты: без --test-force-exit).
 * В браузере setTimeout возвращает число — guard ничего не делает.
 * Реализация живёт в timers.js (leaf); здесь — реэкспорт для существующих
 * потребителей (file-store, sharded-file-store, http-транспорт).
 */
export { unrefTimer } from './timers.js';

/**
 * FNV-1a 32-bit hash — каноническое ядро для новых 32-битных идентификаторов
 * (прежде всего inline descHash). Возвращает число; hex-обёртка ниже строится
 * на нём. Исторический 16-разрядный messageHash черновиков намеренно остаётся
 * отдельным: смена его формата/значений инвалидировала бы сохранённые черновики
 * и заставила бы заново строить промпты Stage 1.
 * @param {string|number|null|undefined} value
 * @returns {number} uint32
 */
export function fnv1a32(value) {
    let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
    const bytes = new TextEncoder().encode(String(value == null ? '' : value));
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
}

/**
 * FNV-1a 32-bit, hex — inline descHash. ЗОЛОТОЕ ЗНАЧЕНИЕ: fnv1aHex('img|d')
 * === '6998fd64' зафиксировано тестом — смена алгоритма тихо осиротит все
 * сохранённые descHash и инлайн перегенерирует всё за деньги.
 * @param {string|number|null|undefined} value
 * @returns {string}
 */
export function fnv1aHex(value) {
    return fnv1a32(value).toString(16);
}

/**
 * Call fn with retry on network errors.
 *
 * @param {(attempt: number) => Promise<any>} fn
 * @param {string} label — for logging
 * @param {'network' | 'generation'} [mode='network']
 *   - 'network'     — retry transient failures. Do NOT retry timeout:
 *                     retrying is usually useless (LLM either responds in time or hangs).
 *   - 'generation'  — same but applies to paid image generation. Semantically
 *                     identical to 'network' (timeout excluded from retryable in both modes),
 *                     but kept as an explicit marker: "this is generation, retry = money".
 *
 * Timeout is NOT retried in any mode: retrying a paid generation on timeout
 * guaranteed spends money twice (provider finishes and charges), returning no
 * result. The old regex included "Timeout" → with maxRetries>0 it burned money N times.
 *
 * Retryability is decided by STRUCTURE, never by the message text. The previous
 * regex scanned the whole message for /429|502|503|504|network|…/i, so a gateway
 * that mentioned "429" anywhere in its prose — or echoed a request id containing
 * those digits — resent a paid request. What counts now:
 *   - `error.httpStatus` in {429, 502, 503, 504} (providers stamp the real one);
 *   - a typed `error.code` of a transient transport failure (NETWORK, and the
 *     bare fetch failures TypeError names).
 * The message text stays in the log and nowhere else.
 *
 * Errors carrying `noRetry === true` are never retried regardless of status:
 * this is how typed delivery outcomes (DELIVERY_AMBIGUOUS from proxy.autoFetch)
 * opt out — the request may have reached the provider, and a resend could bill
 * it twice.
 */
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(['NETWORK', 'FAILED_TO_FETCH', 'CORS']);

function isRetryableError(e) {
    const status = Number.isSafeInteger(e?.httpStatus) ? e.httpStatus : null;
    if (status !== null) return RETRYABLE_HTTP_STATUSES.has(status);
    const code = String(e?.code || '').toUpperCase();
    return RETRYABLE_ERROR_CODES.has(code);
}

export async function callWithRetry(fn, label, mode = 'network', signal = null) {
    const s = state.settings;
    const throwIfAborted = () => {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    };
    const wait = (ms) => new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        const timer = unrefTimer(setTimeout(done, ms));
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
            if (e?.noRetry === true || !isRetryableError(e) || attempt === s.maxRetries) break;
            await wait(s.retryDelay * Math.pow(2, attempt));
        }
    }
    throw lastErr;
}

// ── Custom-endpoint API key (module: api-key-store.js) ──
// localforage-backed key store + its key literal live there; core re-exports
// for existing consumers (text-api, data-port, tests). Leaf module — no cycle.
export { getApiKey, setApiKey, LF_API_KEY } from './api-key-store.js';

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
// ── HTTP transport (module: http.js) ──
// Deadline-guarded fetch + proxy-safe response body reading/decompression.
// Re-exported so core stays the single import point for existing consumers.
export { __resetZstdProbe, bytesToDataUrl, decodeZstdBytes, detectImageMime, fetchWithTimeout, readResponseBody, withDeadline } from './http.js';

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

// Strip HTML markup from prompt: remove the angle brackets themselves —
// single characters cannot re-form a multi-char tag (CodeQL-safe), and inner
// text survives ('<i>hi</i>' -> 'ihi/i'). URL-scheme stripping is dropped on
// purpose: a prompt is prose for an LLM, never used as an href.
export function sanitizePrompt(t) {
    if (!t) return '';
    return String(t).replace(/[<>]/g, '').trim();
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
