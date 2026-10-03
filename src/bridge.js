// @ts-check
/**
 * URIS External Bridge (experimental) — universal facade for OTHER extensions.
 *
 * Publishes `globalThis.URIS` so sibling SillyTavern extensions can use URIS
 * generation without importing URIS internals (import paths and module layout
 * are not public API). The bridge is a thin facade over the existing pipeline:
 * headless requests go straight to generateImageRequest, so pending-request
 * recovery records, diagnostics, native-gallery materialization and the
 * global Stop button (state.activeGenerations) all behave exactly like a
 * manual generation. Nothing here duplicates provider/transport logic.
 *
 * Test-build scope (theory check):
 *   - generate / buildPrompt / generateFromScene / abort / getStatus / on / off / ready
 *   - read surface: listConnections / listRefs / listTemplates / listTriggers /
 *     getCapabilities / listGallery / getCard / listPending (all sanitized);
 *     the one write-back is removeCard, scoped to the caller's own cards
 *   - structured errors: err.code, err.category, err.retryable and the same in
 *     event payloads (classifyBridgeError is exposed for local classification)
 *   - serial queue for external calls (default) to prevent N parallel paid POSTs
 *   - caller attribution: requestId prefix, diagnostic events, gallery provenance
 *   - permission UI (allowlist per caller) is NOT implemented yet — any enabled
 *     extension may generate; every call is logged with its caller tag.
 */

import {
    state,
    abortGeneration,
    CANCELLATION_REASONS,
    VALID_ASPECT_RATIOS,
    VALID_IMAGE_SIZES,
} from './core.js';
import { resolveChatConfigSnapshot, buildCandidates } from './pipeline-config.js';
import { resolveConnection, listImageConnections } from './connections.js';
import { resolveDispatchPlan } from './dispatch-plan.js';
import { generateImageRequest } from './image-api.js';
import { recordDiagnosticEvent } from './diagnostic-events.js';
import { listTemplates, getTemplate, classifyTemplate } from './prompt-templates.js';
import { executeStage1, resolveSTMacros } from './template-runtime.js';
import { buildSceneContextSnapshot, resolvePromptReferenceContext } from './scene-context.js';
import { imageToDataUrl } from './references.js';
import { composeReferencePrompt } from './reference-binding.js';
import { generatePromptText } from './text-api.js';
import { listRefs } from './refs-library.js';
import { enqueueAutoLane } from './autolane.js';
import { parseInline } from './inline/grammar.js';
import { buildAliasIndex, resolveProfile, sanitizeTriggerList, buildInlinePrompt, DEFAULT_TRIGGERS } from './inline/triggers.js';
import { listCards, removeCard as removeGalleryCard } from './gallery-index.js';
import { listPendingBrowserRequests } from './browser-image-recovery.js';
import { classifyOutcome } from './capability-observer.js';
import { supportedImageSizesFor } from './image-model-capabilities.js';
import { noteQueued, noteRunning, noteFinished, laneFromSource } from './ui/queue-log.js';

/** Public contract version. Increment on breaking changes to the surface below. */
export const BRIDGE_API_VERSION = 1;

const CALLER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_PROMPT_CHARS = 100_000;
const MAX_REFERENCES = 8;
const VALID_QUALITIES = ['auto', 'high', 'medium', 'low'];

/**
 * Structured bridge error. Consumers branch on `err.code`, never on message text.
 * @param {string} code
 * @param {string} message
 * @returns {UrisBridgeError}
 */
export function bridgeError(code, message) {
    return new UrisBridgeError(code, message);
}

export class UrisBridgeError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = 'UrisBridgeError';
        this.code = code;
    }
}

/**
 * Validate the caller tag (attribution, not security: one page = mutually
 * trusted code). Ends up in requestId, diagnostics and gallery provenance.
 * @param {unknown} caller
 * @returns {string}
 */
export function validateBridgeCaller(caller) {
    const value = typeof caller === 'string' ? caller.trim() : '';
    if (!CALLER_RE.test(value)) {
        throw bridgeError('INVALID_CALLER', 'opts.caller is required: 1-64 chars, letters/digits/underscore/hyphen, starting with a letter or digit');
    }
    return value;
}

/**
 * Validate and normalize a bridge generate() request. Pure — unit-tested in node.
 * @param {unknown} request
 * @returns {{prompt:string, aspectRatio:string, imageSize:string, quality:string, references:Array<{id:string,name:string,dataUrl:string}>, connectionId:string|null, modelId:string|null, trigger:string|null}}
 */
export function normalizeBridgeRequest(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw bridgeError('INVALID_PARAMS', 'generate(request): request object is required');
    }
    const req = /** @type {Record<string, unknown>} */ (request);
    const prompt = typeof req.prompt === 'string' ? req.prompt.trim() : '';
    if (!prompt) throw bridgeError('INVALID_PARAMS', 'prompt is required');
    if (prompt.length > MAX_PROMPT_CHARS) throw bridgeError('INVALID_PARAMS', `prompt exceeds ${MAX_PROMPT_CHARS} chars`);

    const aspectRatio = req.aspectRatio == null ? '1:1' : String(req.aspectRatio);
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) {
        throw bridgeError('INVALID_PARAMS', `aspectRatio must be one of: ${VALID_ASPECT_RATIOS.join(', ')}`);
    }
    const imageSize = req.imageSize == null ? '1K' : String(req.imageSize);
    if (!VALID_IMAGE_SIZES.includes(imageSize)) {
        throw bridgeError('INVALID_PARAMS', `imageSize must be one of: ${VALID_IMAGE_SIZES.join(', ')}`);
    }
    const quality = req.quality == null ? 'auto' : String(req.quality);
    if (!VALID_QUALITIES.includes(quality)) {
        throw bridgeError('INVALID_PARAMS', `quality must be one of: ${VALID_QUALITIES.join(', ')}`);
    }

    const rawRefs = req.references == null ? [] : req.references;
    if (!Array.isArray(rawRefs)) throw bridgeError('INVALID_PARAMS', 'references must be an array');
    if (rawRefs.length > MAX_REFERENCES) throw bridgeError('INVALID_PARAMS', `references accepts at most ${MAX_REFERENCES} items`);
    const references = rawRefs.map((ref, index) => {
        const item = ref && typeof ref === 'object' && !Array.isArray(ref) ? /** @type {Record<string, unknown>} */ (ref) : null;
        // Pool reference: resolved to a dataUrl by the bridge at dispatch time.
        const refId = typeof item?.refId === 'string' ? item.refId.trim() : '';
        if (refId) {
            return { refId, id: '', name: '', dataUrl: '' };
        }
        const dataUrl = typeof item?.dataUrl === 'string' ? item.dataUrl.trim() : '';
        if (!/^(data:image\/[a-z0-9.+-]+;base64,|https?:\/\/)/i.test(dataUrl)) {
            throw bridgeError('INVALID_PARAMS', `references[${index}] must carry refId (URIS pool) or a data:image/* base64 / http(s) dataUrl`);
        }
        const id = typeof item?.id === 'string' ? item.id.slice(0, 256) : '';
        const name = typeof item?.name === 'string' ? item.name.slice(0, 256) : '';
        return { refId: '', id, name, dataUrl };
    });

    const connectionId = typeof req.connectionId === 'string' && req.connectionId.trim() ? req.connectionId.trim() : null;
    const modelId = typeof req.modelId === 'string' && req.modelId.trim() ? req.modelId.trim() : null;
    const trigger = typeof req.trigger === 'string' && req.trigger.trim() ? req.trigger.trim() : null;
    const useSceneRefs = req.useSceneRefs === true;
    const expandMacros = req.expandMacros !== false;
    return { prompt, aspectRatio, imageSize, quality, references, connectionId, modelId, trigger, useSceneRefs, expandMacros };
}

// ── Caller attribution on artifacts ──

/**
 * Extract the external caller tag from a bridge-generated requestId
 * (`ext_<caller>_<uuid>`; the uuid part never contains underscores, so the
 * caller is everything between `ext_` and the last underscore). Returns null
 * for manual (non-bridge) request ids. Gallery cards carry the requestId in
 * `provenance.requestId`, so this is also the card attribution key.
 * @param {unknown} requestId
 * @returns {string|null}
 */
export function bridgeCallerFromRequestId(requestId) {
    if (typeof requestId !== 'string' || !requestId.startsWith('ext_')) return null;
    const m = /^ext_([A-Za-z0-9][A-Za-z0-9_-]{0,63})_[^_]+$/.exec(requestId);
    return m ? m[1] : null;
}

// ── Structured error classification (additive contract since apiVersion 1) ──

/**
 * Categories a consumer can branch on. codes keep pinpointing the exact
 * failure; category groups codes into handling policies:
 *   - cancelled        the request was aborted (not an error worth showing)
 *   - unavailable      URIS itself is off/initializing — retry later
 *   - config           the user must fix something in URIS (connection, key,
 *                      template, ref pool); retrying unchanged is pointless
 *   - invalid-request  the consumer's request shape is wrong (its own bug)
 *   - auth/quota       provider key state; retry only after the user acts
 *   - rate-limit/timeout/network-unknown
 *                      transient — retryable
 *   - provider-error   upstream 5xx or an upstream response URIS could not
 *                      parse — retryable
 *   - content-policy   refused by policy; reword, do not retry verbatim
 *   - unsupported-feature  the model/contract cannot do what was asked
 *   - internal         generation may have been BILLED but materialization
 *                      failed — check listPending(), never retry blindly
 *   - unknown          no structured signal at all
 */
const BRIDGE_ERROR_META = Object.freeze({
    ABORTED: { category: 'cancelled', retryable: false },
    NOT_READY: { category: 'unavailable', retryable: true },
    EXT_DISABLED: { category: 'unavailable', retryable: true },
    INVALID_CALLER: { category: 'invalid-request', retryable: false },
    INVALID_PARAMS: { category: 'invalid-request', retryable: false },
    CARD_NOT_OWNED: { category: 'invalid-request', retryable: false },
    NO_CONNECTION: { category: 'config', retryable: false },
    NO_ROUTE: { category: 'config', retryable: false },
    TRIGGER_NOT_FOUND: { category: 'config', retryable: false },
    REF_NOT_FOUND: { category: 'config', retryable: false },
    REF_UNAVAILABLE: { category: 'config', retryable: false },
    NOT_FOUND: { category: 'config', retryable: false },
    TEMPLATE_INVALID: { category: 'config', retryable: false },
    MODEL_NOT_IMAGE: { category: 'config', retryable: false },
    ROUTE_SELECTION_REQUIRED: { category: 'config', retryable: false },
    MISSING_API_KEY: { category: 'config', retryable: false },
    POLLINATIONS_TOKEN_REQUIRED: { category: 'config', retryable: false },
    POLLINATIONS_TOKEN_INVALID: { category: 'config', retryable: false },
    NAISTERA_TOKEN_REQUIRED: { category: 'config', retryable: false },
    NAISTERA_TOKEN_INVALID: { category: 'config', retryable: false },
});

// capability-observer outcome → bridge-facing (category, retryable). The
// diagnostic taxonomy stays inside URIS; consumers get a stable, smaller set.
const OUTCOME_ERROR_META = Object.freeze({
    'auth': { category: 'auth', retryable: false },
    'quota': { category: 'quota', retryable: false },
    'rate-limit': { category: 'rate-limit', retryable: true },
    'provider-error': { category: 'provider-error', retryable: true },
    'timeout': { category: 'timeout', retryable: true },
    'invalid-request': { category: 'invalid-request', retryable: false },
    'content-policy': { category: 'content-policy', retryable: false },
    'unsupported-feature': { category: 'unsupported-feature', retryable: false },
    // 200 OK without an image / malformed JSON: the model answered, URIS could
    // not use the answer. Reads as provider-error to consumers.
    'missing-image': { category: 'provider-error', retryable: true },
    'malformed': { category: 'provider-error', retryable: true },
    // Provider POST succeeded (billed) but local materialization failed.
    'materialize': { category: 'internal', retryable: false },
    'network-unknown': { category: 'network-unknown', retryable: true },
});

/**
 * Classify any error the bridge can throw or emit. Pure — never throws.
 * @param {unknown} err
 * @returns {{code:string|null, category:string, retryable:boolean}}
 */
export function classifyBridgeError(err) {
    const code = typeof err?.code === 'string' ? err.code : null;
    if (err?.name === 'AbortError' || code === 'ABORTED') return { code: 'ABORTED', category: 'cancelled', retryable: false };
    const own = code ? BRIDGE_ERROR_META[code] : null;
    if (own) return { code, ...own };
    const outcomeMeta = OUTCOME_ERROR_META[classifyOutcome(err)];
    if (outcomeMeta) return { code, ...outcomeMeta };
    return { code, category: 'unknown', retryable: false };
}

/**
 * Stamp category/retryable onto an error object about to cross the bridge
 * boundary. Never replaces an existing stamp (a deeper layer knows better).
 * @param {unknown} err
 */
function stampBridgeError(err) {
    if (!err || typeof err !== 'object') return;
    const info = classifyBridgeError(err);
    if (err.category == null) err.category = info.category;
    if (err.retryable == null) err.retryable = info.retryable;
}

/**
 * Event-payload form of an error: code + human message + classification.
 * @param {unknown} err
 * @returns {{code:string|null, message:string, category:string, retryable:boolean}}
 */
function bridgeErrorPayload(err) {
    const info = classifyBridgeError(err);
    return {
        code: info.code,
        message: err?.message || String(err),
        category: info.category,
        retryable: info.retryable,
    };
}

// ── Sanitized read models (gallery cards, pending recovery) ──

const MAX_GALLERY_LIMIT = 200;
const GALLERY_PROMPT_CLIP = 4096;
const PENDING_PROMPT_CLIP = 2000;

/**
 * Sanitized gallery card for external consumers. No prompt bodies over 4 KB,
 * no provenance internals, no style/snapshot blobs; attribution is reduced to
 * `caller` + `requestId`. Returns null for unusable input.
 * @param {unknown} card
 * @returns {object|null}
 */
export function sanitizeBridgeCard(card) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
    const requestId = typeof card.provenance?.requestId === 'string' ? card.provenance.requestId : null;
    return {
        id: String(card.id || ''),
        imagePath: typeof card.imagePath === 'string' ? card.imagePath : null,
        thumbPath: typeof card.thumbPath === 'string' ? card.thumbPath : null,
        prompt: typeof card.prompt === 'string' ? card.prompt.slice(0, GALLERY_PROMPT_CLIP) : '',
        connectionId: typeof card.connectionId === 'string' && card.connectionId ? card.connectionId : null,
        modelId: typeof card.modelId === 'string' && card.modelId ? card.modelId : null,
        aspectRatio: typeof card.aspectRatio === 'string' && card.aspectRatio ? card.aspectRatio : null,
        imageSize: typeof card.imageSize === 'string' && card.imageSize ? card.imageSize : null,
        quality: typeof card.quality === 'string' && card.quality ? card.quality : null,
        width: Number.isFinite(card.width) ? card.width : null,
        height: Number.isFinite(card.height) ? card.height : null,
        status: card.status === 'missing' ? 'missing' : 'ready',
        hidden: card.hidden === true,
        referenceIds: Array.isArray(card.referenceIds) ? card.referenceIds.filter(id => typeof id === 'string') : [],
        createdAt: Number.isFinite(card.createdAt) ? card.createdAt : null,
        requestId,
        caller: bridgeCallerFromRequestId(requestId),
    };
}

/**
 * Sanitized pending-recovery record (a paid provider request whose result
 * URIS could not confirm). References are reduced to a count — descriptions
 * and payloads never cross the bridge.
 * @param {unknown} item
 * @returns {object|null}
 */
export function sanitizeBridgePendingRecord(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const requestId = typeof item.requestId === 'string' ? item.requestId : (typeof item.id === 'string' ? item.id : null);
    if (!requestId) return null;
    const prompt = typeof item.prompt === 'string' ? item.prompt : (typeof item.effectivePrompt === 'string' ? item.effectivePrompt : '');
    return {
        requestId,
        caller: bridgeCallerFromRequestId(requestId),
        status: typeof item.status === 'string' ? item.status : 'notStarted',
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : null,
        error: typeof item.error === 'string' ? item.error : null,
        connectionId: typeof item.connId === 'string' ? item.connId : null,
        modelId: typeof item.modelId === 'string' ? item.modelId : null,
        aspectRatio: typeof item.aspectRatio === 'string' ? item.aspectRatio : null,
        imageSize: typeof item.imageSize === 'string' ? item.imageSize : null,
        quality: typeof item.quality === 'string' ? item.quality : null,
        prompt: prompt.slice(0, PENDING_PROMPT_CLIP),
        referenceCount: Array.isArray(item.referenceIds) ? item.referenceIds.length : 0,
    };
}

/**
 * Validate a listGallery query. Pure.
 * @param {unknown} query
 * @returns {{caller:string|null, limit:number, offset:number, includeHidden:boolean}}
 */
export function normalizeGalleryQuery(query) {
    const q = query && typeof query === 'object' && !Array.isArray(query) ? /** @type {Record<string, unknown>} */ (query) : {};
    const caller = typeof q.caller === 'string' && q.caller.trim() ? q.caller.trim() : null;
    if (caller && !CALLER_RE.test(caller)) {
        throw bridgeError('INVALID_PARAMS', `caller filter "${caller}" is not a valid caller tag`);
    }
    const limit = Number.isFinite(q.limit) ? Math.min(Math.max(1, Math.trunc(q.limit)), MAX_GALLERY_LIMIT) : 50;
    const offset = Number.isFinite(q.offset) ? Math.max(0, Math.trunc(q.offset)) : 0;
    return { caller, limit, offset, includeHidden: q.includeHidden === true };
}

// ── Runtime (browser) state ──

let _bridge = null;
let _readyResolve = null;
let _readyReject = null;
let _readyPromise = null;
let _ready = false;
/** @type {Map<string, {caller:string, startedAt:number, controller:AbortController, queued:boolean}>} */
const _externalRuns = new Map();
const _listeners = new Set();

function isBridgeActive() {
    return _bridge != null;
}

function isGenerationAllowed() {
    return isBridgeActive() && state.settings?.enabled === true && state.settings.bridgeEnabled !== false;
}

function newRequestId(caller) {
    const uuid = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    return `ext_${caller}_${uuid}`;
}

function emitBridge(type, detail) {
    const listeners = [..._listeners];
    for (const entry of listeners) {
        if (entry.type !== type && entry.type !== '*') continue;
        try { entry.cb({ type, ...detail }); } catch { /* listener errors must not break generation */ }
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try { window.dispatchEvent(new CustomEvent('uris:bridge', { detail: { type, ...detail } })); } catch { /* ignore */ }
    }
}

function emitStage2(requestId, caller, kind, outcome = 'success', errorText = '') {
    // Same channel the pipeline uses, so the URIS window (Stop button, queue
    // status) reacts to external generations for free. msgId stays null:
    // headless requests are not bound to a chat post.
    // Журнал очереди пишет продюсер (один писатель; окно — только читатель).
    // Раньше end-эмит не нёс исхода вовсе, и провалы моста в ленте QUEUE
    // помечались «готово».
    if (kind === 'start') {
        noteQueued({ id: requestId, label: 'Генерация', lane: laneFromSource(`external:${caller}`) });
        noteRunning(requestId);
    } else {
        noteFinished(requestId, outcome, errorText);
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try { window.dispatchEvent(new CustomEvent(`uris:stage2-${kind}`, { detail: { requestId, msgId: null, source: `external:${caller}`, outcome, error: errorText } })); } catch { /* ignore */ }
    }
}

/**
 * Core headless generation. Runs only inside the serial chain.
 * @param {string} caller
 * @param {string} requestId
 * @param {ReturnType<typeof normalizeBridgeRequest>} norm
 * @param {AbortController} controller
 * @param {(status:string) => void} onStatus
 */
async function generateOnce(caller, requestId, norm, controller, onStatus) {
    const startedAt = Date.now();
    // Исход для end-эмита: catch знает его раньше finally.
    let endOutcome = 'success';
    let endError = '';
    _externalRuns.set(requestId, { caller, startedAt, controller, queued: false });
    state.activeGenerations.set(requestId, controller);
    emitStage2(requestId, caller, 'start');
    emitBridge('generation:started', { requestId, caller });
    recordDiagnosticEvent({
        event: 'bridge-generate-start',
        requestId,
        details: {
            caller,
            connectionId: norm.connectionId,
            modelId: norm.modelId,
            trigger: norm.trigger,
            referenceCount: norm.references.length,
            useSceneRefs: norm.useSceneRefs,
            expandMacros: norm.expandMacros,
            aspectRatio: norm.aspectRatio,
            imageSize: norm.imageSize,
            quality: norm.quality,
        },
    });
    try {
        let connId = norm.connectionId;
        if (!connId) {
            // Default: whatever the current RP chat has configured (same source
            // the Generate tab uses). No chat binding → explicit error.
            let snapshot = null;
            try { snapshot = await resolveChatConfigSnapshot(); } catch { snapshot = null; }
            connId = snapshot?.imageProfileId || null;
        }
        if (!connId) {
            throw bridgeError('NO_CONNECTION', 'No image connection available. Pass connectionId or select a connection in the current chat (URIS.getStatus().connection).');
        }

        // Trigger-профиль (опционально): приносит aspect/shell/refsPolicy из реестра.
        // Проверяется ДО соединения: структурная ошибка запроса не должна
        // требовать рабочее соединение, чтобы проявиться.
        let aspect = norm.aspectRatio;
        let basePromptSource = norm.prompt;
        let refsPolicyOverride = null;           // 'off' форсит отказ от авторефов
        if (norm.trigger) {
            const registry = sanitizeTriggerList(state.settings?.inlineTriggers || DEFAULT_TRIGGERS);
            const wanted = norm.trigger.toLowerCase().replaceAll('ё', 'е');
            const profile = registry.find(t => t.id === wanted);
            if (!profile) throw bridgeError('TRIGGER_NOT_FOUND',
                `Unknown trigger "${norm.trigger}". Known: ${registry.map(t => t.id).join(', ')}`);
            aspect = profile.aspect || aspect;
            basePromptSource = buildInlinePrompt(profile, norm.prompt);
            if (profile.refsPolicy === 'off') refsPolicyOverride = 'off';
        }

        /** @type {Record<string, unknown>} */
        const dispatchOpts = {};
        // Resolve the connection in the bridge even when only connectionId is
        // given: generateImageRequest would fail with a bare uncoded Error, and
        // the contract is that consumers branch on NO_CONNECTION.
        const resolvedConn = await resolveConnection(connId);
        if (!resolvedConn) throw bridgeError('NO_CONNECTION', `Connection ${connId} was not found`);
        if (norm.modelId) {
            const plan = resolveDispatchPlan({ ...resolvedConn.conn, model: { id: norm.modelId, source: 'manual' } });
            if (!plan?.route?.generationContract) {
                throw bridgeError('NO_ROUTE', `Model "${norm.modelId}" has no dispatchable route on connection ${connId}`);
            }
            dispatchOpts.route = plan.route;
        }

        // Reference pipeline: pool refs by id, then the Stage 2 scene resolver
        // (auto-match reference names/aliases in the prompt), then description
        // entries composed into the effective prompt — the same chain the
        // manual Generate tab runs.
        const references = [];
        const descriptionEntries = [];
        for (const ref of norm.references) {
            if (ref.refId) {
                const poolRef = (await listRefs()).find(r => r.id === ref.refId);
                if (!poolRef) throw bridgeError('REF_NOT_FOUND', `Reference "${ref.refId}" was not found in the URIS pool`);
                const dataUrl = await imageToDataUrl(poolRef.imagePath);
                if (!dataUrl) throw bridgeError('REF_UNAVAILABLE', `Reference "${poolRef.name}" image could not be loaded`);
                references.push({ id: poolRef.id, name: poolRef.name, dataUrl });
            } else {
                references.push({ id: ref.id, name: ref.name, dataUrl: ref.dataUrl });
            }
        }
        let basePrompt = norm.expandMacros === false ? basePromptSource : resolveSTMacros(basePromptSource);
        const matchedByResolver = [];
        // профиль строже: refsPolicy 'off' отключает авторефы, даже если useSceneRefs=true
        if (norm.useSceneRefs && refsPolicyOverride !== 'off') {
            const candidates = await buildCandidates(state.currentChatId || 'current');
            const resolution = await resolvePromptReferenceContext({
                prompt: basePrompt,
                candidates,
                corrections: { includedIds: [], excludedIds: [], revision: 0 },
            });
            for (const r of resolution.stage2Refs || []) {
                if (r.bindingMode === 'description') {
                    descriptionEntries.push({ id: r.id, name: r.name, description: r.description, bindingMode: 'description' });
                    continue;
                }
                if (references.some(x => x.id === r.id)) continue;
                const dataUrl = await imageToDataUrl(r.imagePath);
                if (dataUrl) references.push({ id: r.id, name: r.name, dataUrl });
            }
            matchedByResolver.push(...(resolution.matchedReferences || []).map(ref => ({
                id: ref.id, name: ref.name, effective: ref.effective !== false,
            })));
        }
        let referenceBindings = [];
        if (descriptionEntries.length) {
            const composed = composeReferencePrompt(basePrompt, descriptionEntries);
            basePrompt = composed.effectivePrompt;
            referenceBindings = composed.bindings;
        }

        const result = await generateImageRequest(connId, {
            requestId,
            prompt: basePrompt,
            aspectRatio: aspect,
            imageSize: norm.imageSize,
            quality: norm.quality,
            references,
            referenceBindings,
            chatId: state.currentChatId ?? null,
            sourceMsgId: null,
        }, onStatus, controller.signal, dispatchOpts);

        const entry = result?.galleryEntry || {};
        const payload = {
            requestId,
            cardId: entry.id ?? null,
            imagePath: entry.imagePath ?? null,
            width: entry.width ?? null,
            height: entry.height ?? null,
            warnings: Array.isArray(result?.warnings) ? result.warnings : [],
        };
        recordDiagnosticEvent({
            event: 'bridge-generate-end', requestId, outcome: 'ready',
            durationMs: Date.now() - startedAt,
            details: { caller, cardId: payload.cardId, imagePath: payload.imagePath },
        });
        // gallery:added lands before generation:ended: reactive consumers can
        // refresh their own galleries on the first event and still correlate
        // the await-resolution with the second.
        const cardSummary = sanitizeBridgeCard(result?.galleryEntry);
        if (cardSummary) emitBridge('gallery:added', { requestId, caller, card: cardSummary });
        emitBridge('generation:ended', { requestId, caller, result: payload });
        return payload;
    } catch (e) {
        const cancelled = controller.signal.aborted || e?.name === 'AbortError';
        endOutcome = cancelled ? 'cancelled' : 'error';
        endError = cancelled ? '' : String(e?.message || e);
        recordDiagnosticEvent({
            event: 'bridge-generate-end', requestId, outcome: cancelled ? 'cancelled' : 'error',
            durationMs: Date.now() - startedAt,
            details: { caller, code: e?.code || null, message: e?.message || String(e) },
        });
        // DOMException AbortError carries a legacy numeric .code (20), so the
        // wrap condition must ask for a *string* code — otherwise the raw
        // DOMException leaks to consumers instead of the coded ABORTED.
        const thrown = cancelled && typeof e?.code !== 'string' ? bridgeError('ABORTED', 'Generation aborted') : e;
        stampBridgeError(thrown);
        emitBridge('generation:error', { requestId, caller, error: bridgeErrorPayload(thrown) });
        throw thrown;
    } finally {
        state.activeGenerations.delete(requestId);
        _externalRuns.delete(requestId);
        emitStage2(requestId, caller, 'end', endOutcome, endError);
    }
}

/**
 * Headless paid generation, not bound to a chat message.
 * @param {unknown} request - { prompt, aspectRatio?, imageSize?, quality?, references?, connectionId?, modelId?, trigger? }
 * @param {unknown} opts - { caller, signal?, onStatus?, queue? }
 * @returns {Promise<{requestId:string, cardId:string|null, imagePath:string|null, width:number|null, height:number|null, warnings:Array}>}
 */
async function generate(request, opts = {}) {
    const caller = validateBridgeCaller(opts && typeof opts === 'object' ? /** @type {Record<string, unknown>} */ (opts).caller : undefined);
    const norm = normalizeBridgeRequest(request);
    if (!isGenerationAllowed()) {
        throw bridgeError(isBridgeActive() ? 'EXT_DISABLED' : 'NOT_READY', 'URIS bridge is not accepting generations (extension disabled or not initialized)');
    }

    const options = /** @type {Record<string, unknown>} */ (opts);
    const requestId = newRequestId(caller);
    const controller = new AbortController();
    if (options.signal) {
        const external = /** @type {AbortSignal} */ (options.signal);
        if (external.aborted) throw bridgeError('ABORTED', 'Generation aborted before start');
        external.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const onStatus = typeof options.onStatus === 'function' ? /** @type {(status:string) => void} */ (options.onStatus) : () => {};
    _externalRuns.set(requestId, { caller, startedAt: Date.now(), controller, queued: true });
    emitBridge('generation:queued', { requestId, caller });

    const run = () => {
        if (controller.signal.aborted) {
            _externalRuns.delete(requestId);
            return Promise.reject(bridgeError('ABORTED', 'Generation aborted while queued'));
        }
        if (!isGenerationAllowed()) {
            _externalRuns.delete(requestId);
            return Promise.reject(bridgeError('EXT_DISABLED', 'URIS was disabled while the request was queued'));
        }
        return generateOnce(caller, requestId, norm, controller, onStatus);
    };

    // Serial by default: one external paid POST at a time (protects against a
    // consumer loop firing unbounded paid requests). queue:false = run now.
    // The queue is the shared autolane (bridge + inline automation): one
    // automatic paid POST at a time across both.
    if (options.queue === false) return run();
    return enqueueAutoLane(run);
}

/**
 * Abort an external (or any) generation by requestId. Queued requests are
 * aborted through the bridge registry (they are not in activeGenerations yet);
 * started ones through the shared map, so manual generations abort too.
 * @param {string} requestId
 * @returns {boolean}
 */
function abort(requestId) {
    const meta = _externalRuns.get(String(requestId));
    if (meta) {
        try { meta.controller.abort(); } catch { /* already aborted */ }
        return true;
    }
    return abortGeneration(requestId, CANCELLATION_REASONS.MANUAL);
}

/** Snapshot of in-flight/queued external requests. */
function listActive() {
    return [..._externalRuns.entries()].map(([requestId, meta]) => ({
        requestId,
        caller: meta.caller,
        queued: meta.queued,
        startedAt: meta.startedAt,
    }));
}

/**
 * Sanitized connection list: ids/labels/model availability only — never
 * endpoints or keys.
 */
async function listConnections() {
    const connections = await listImageConnections();
    return connections.map(conn => ({
        id: conn.id,
        label: conn.label || conn.name || conn.id,
        modelId: conn.model?.id ?? null,
        ready: Boolean(resolveDispatchPlan(conn)?.route),
    }));
}

/** Overall bridge state, including the active chat's default connection. */
async function getStatus() {
    let connection = null;
    try {
        const snapshot = await resolveChatConfigSnapshot();
        if (snapshot.imageProfileId) {
            const resolved = await resolveConnection(snapshot.imageProfileId);
            if (resolved) {
                connection = {
                    id: resolved.conn.id,
                    label: resolved.conn.label || resolved.conn.name || resolved.conn.id,
                    modelId: resolved.conn.model?.id ?? null,
                    ready: Boolean((snapshot.imageRoute || resolveDispatchPlan(resolved.conn)?.route)),
                };
            }
        }
    } catch { /* no chat binding — connection stays null */ }
    return {
        enabled: state.settings?.enabled === true,
        ready: _ready,
        accepting: isGenerationAllowed(),
        connection,
        active: listActive(),
    };
}

/**
 * Subscribe to bridge events. Types: 'generation:queued' | 'generation:started'
 * | 'generation:ended' | 'generation:error' | 'prompt:started' | 'prompt:ended'
 * | 'prompt:error' | 'gallery:added' | 'gallery:removed' | 'ready'
 * | 'destroyed', or '*'. Error payloads carry { code, message, category,
 * retryable }. Returns an unsubscribe function.
 * @param {string} type
 * @param {(detail:any) => void} cb
 * @returns {() => void}
 */
function on(type, cb) {
    const entry = { type: String(type), cb };
    _listeners.add(entry);
    return () => _listeners.delete(entry);
}

/** Remove a previously registered listener. */
function off(type, cb) {
    for (const entry of _listeners) {
        if (entry.type === String(type) && entry.cb === cb) _listeners.delete(entry);
    }
}

// ── Pipeline surface: templates, refs, headless Stage 1 ──

/** Sanitized template list for consumers ({id, name, type}) — no prompt bodies. */
async function listBridgeTemplates() {
    const templates = await listTemplates();
    return templates.map(t => ({
        id: t.id,
        name: t.name || t.id,
        type: String(classifyTemplate(t) || 'custom'),
    }));
}

/** Sanitized reference pool list ({id, name, folders, bindingMode}) — no payloads. */
async function listBridgeRefs() {
    const refs = await listRefs();
    return refs.map(ref => ({
        id: ref.id,
        name: ref.name,
        folders: Array.isArray(ref.folders) ? ref.folders : [],
        bindingMode: ref.bindingMode === 'description' ? 'description' : 'image',
    }));
}

/**
 * Headless Stage 1: run a URIS prompt template over ARBITRARY text (no chat
 * message, no drafts). Optionally builds the scene snapshot against the
 * current RP chat's bound reference pool, so the resolver can match entities
 * the same way the manual pipeline does. `{{char}}`/`{{user}}` and other ST
 * macros in `text` are expanded against the current chat (opt-out:
 * `expandMacros: false`).
 *
 * This is a PAID text-LLM call (the same one Stage 1 makes).
 *
 * @param {unknown} request - { text, templateId?, useScene? = true, expandMacros? = true }
 * @param {unknown} opts - { caller, signal?, onStatus? }
 * @returns {Promise<{requestId:string, prompt:string, templateId:string|null, templateType:string, matchedReferences:Array, ambiguities:Array}>}
 */
async function buildPrompt(request, opts = {}) {
    const caller = validateBridgeCaller(opts && typeof opts === 'object' ? /** @type {Record<string, unknown>} */ (opts).caller : undefined);
    if (!isGenerationAllowed()) {
        throw bridgeError(isBridgeActive() ? 'EXT_DISABLED' : 'NOT_READY', 'URIS bridge is not accepting requests (extension disabled or not initialized)');
    }
    const req = request && typeof request === 'object' && !Array.isArray(request) ? /** @type {Record<string, unknown>} */ (request) : {};
    const text = typeof req.text === 'string' ? req.text.trim() : '';
    if (!text) throw bridgeError('INVALID_PARAMS', 'buildPrompt(request): text is required');
    if (text.length > MAX_PROMPT_CHARS) throw bridgeError('INVALID_PARAMS', `text exceeds ${MAX_PROMPT_CHARS} chars`);
    const useScene = req.useScene !== false;
    const expandMacros = req.expandMacros !== false;
    const templateId = typeof req.templateId === 'string' && req.templateId.trim() ? req.templateId.trim() : null;

    const options = /** @type {Record<string, unknown>} */ (opts);
    const requestId = newRequestId(caller);
    const controller = new AbortController();
    if (options.signal) {
        const external = /** @type {AbortSignal} */ (options.signal);
        if (external.aborted) throw bridgeError('ABORTED', 'Request aborted before start');
        external.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const onStatus = typeof options.onStatus === 'function' ? /** @type {(status:string) => void} */ (options.onStatus) : () => {};

    _externalRuns.set(requestId, { caller, startedAt: Date.now(), controller, queued: false });
    state.activeGenerations.set(requestId, controller);
    // Исход для end-эмита (как в generateOnce): catch знает его раньше finally.
    let endOutcome = 'success';
    let endError = '';
    emitStage2(requestId, caller, 'start');
    emitBridge('prompt:started', { requestId, caller });
    recordDiagnosticEvent({
        event: 'bridge-build-prompt-start', requestId,
        details: { caller, templateId, useScene, expandMacros, textChars: text.length },
    });
    const startedAt = Date.now();
    try {
        const messageText = expandMacros === false ? text : resolveSTMacros(text);
        let template = null;
        if (templateId) {
            template = await getTemplate(templateId);
            if (!template) throw bridgeError('NOT_FOUND', `Template "${templateId}" was not found`);
            // Fail BEFORE the paid text-LLM call: an empty-body instruction
            // template would otherwise surface as an un-coded runtime error
            // from the template runtime.
            if (String(template.instruction || '').trim() === '') {
                throw bridgeError('TEMPLATE_INVALID', `Template "${template.name}" has an empty instruction body`);
            }
        }
        const candidates = useScene ? await buildCandidates(state.currentChatId || 'current') : [];
        const snapshot = await buildSceneContextSnapshot({
            chatId: state.currentChatId || '',
            msgId: null,
            messageText,
            contextRevision: 0,
            candidates,
            corrections: { includedIds: [], excludedIds: [], revision: 0 },
        });
        const result = await executeStage1({
            template,
            messageText,
            snapshot,
            generateText: (system, user, sig, status) => generatePromptText(system, user, status, sig, requestId),
            signal: controller.signal,
            onStatus,
        });
        if (controller.signal.aborted) throw bridgeError('ABORTED', 'Request aborted');
        const payload = {
            requestId,
            prompt: result.prompt,
            templateId: result.templateId,
            templateType: String(result.templateType || 'base'),
            matchedReferences: (snapshot.matchedReferences || []).map(ref => ({
                id: ref.id, name: ref.name, effective: ref.effective !== false,
                matchedPhrases: Array.isArray(ref.matchedPhrases) ? ref.matchedPhrases.slice(0, 8) : [],
            })),
            ambiguities: snapshot.ambiguities || [],
        };
        recordDiagnosticEvent({
            event: 'bridge-build-prompt-end', requestId, outcome: 'ready',
            durationMs: Date.now() - startedAt,
            details: { caller, promptChars: payload.prompt.length, matched: payload.matchedReferences.length },
        });
        emitBridge('prompt:ended', { requestId, caller, result: payload });
        return payload;
    } catch (e) {
        const cancelled = controller.signal.aborted || e?.name === 'AbortError';
        endOutcome = cancelled ? 'cancelled' : 'error';
        endError = cancelled ? '' : String(e?.message || e);
        recordDiagnosticEvent({
            event: 'bridge-build-prompt-end', requestId, outcome: cancelled ? 'cancelled' : 'error',
            durationMs: Date.now() - startedAt,
            details: { caller, code: e?.code || null, message: e?.message || String(e) },
        });
        // Same numeric-code caveat as generateOnce: DOMException carries code 20.
        const thrown = cancelled && typeof e?.code !== 'string' ? bridgeError('ABORTED', 'Request aborted') : e;
        stampBridgeError(thrown);
        emitBridge('prompt:error', { requestId, caller, error: bridgeErrorPayload(thrown) });
        throw thrown;
    } finally {
        state.activeGenerations.delete(requestId);
        _externalRuns.delete(requestId);
        emitStage2(requestId, caller, 'end', endOutcome, endError);
    }
}

// ── Gallery, recovery and capability reads (all additive to apiVersion 1) ──

/**
 * Read the URIS gallery (native ST gallery cards). Defaults to the newest 50
 * non-hidden cards; `caller` narrows to one external caller via
 * provenance.requestId. Read-only and unreconciled (no server scan), so it is
 * safe to poll: a card whose file was deleted out-of-band still shows up with
 * status 'missing' from the last reconcile.
 * @param {unknown} query - { caller?, limit?, offset?, includeHidden? }
 * @returns {Promise<{total:number, cards:Array}>}
 */
async function listGallery(query = {}) {
    if (!isGenerationAllowed()) {
        throw bridgeError(isBridgeActive() ? 'EXT_DISABLED' : 'NOT_READY', 'URIS bridge is not accepting requests (extension disabled or not initialized)');
    }
    const { caller, limit, offset, includeHidden } = normalizeGalleryQuery(query);
    const all = await listCards({ reconcile: false });
    const filtered = [];
    for (const card of all) {
        const summary = sanitizeBridgeCard(card);
        if (!summary) continue;
        if (!includeHidden && summary.hidden) continue;
        if (caller && summary.caller !== caller) continue;
        filtered.push(summary);
    }
    return { total: filtered.length, cards: filtered.slice(offset, offset + limit) };
}

/**
 * One gallery card by id (same sanitized shape as listGallery entries).
 * @param {unknown} cardId
 */
async function getCard(cardId) {
    if (!isGenerationAllowed()) {
        throw bridgeError(isBridgeActive() ? 'EXT_DISABLED' : 'NOT_READY', 'URIS bridge is not accepting requests (extension disabled or not initialized)');
    }
    const id = typeof cardId === 'string' && cardId.trim() ? cardId.trim() : null;
    if (!id) throw bridgeError('INVALID_PARAMS', 'getCard(cardId): cardId is required');
    const all = await listCards({ reconcile: false });
    const card = all.find(item => item?.id === id);
    if (!card) throw bridgeError('NOT_FOUND', `Gallery card "${id}" was not found`);
    return sanitizeBridgeCard(card);
}

/**
 * Remove a gallery card. The ONLY write the bridge exposes, and it is scoped:
 * the card must be attributed to opts.caller (provenance.requestId prefix).
 * Manual generations and other extensions' cards are refused with
 * CARD_NOT_OWNED. The underlying image FILE is kept (same semantics as the
 * URIS gallery's own delete-card path).
 * @param {unknown} cardId
 * @param {unknown} opts - { caller }
 * @returns {Promise<boolean>} true when a card was removed
 */
async function removeCard(cardId, opts = {}) {
    const caller = validateBridgeCaller(opts && typeof opts === 'object' ? /** @type {Record<string, unknown>} */ (opts).caller : undefined);
    if (!isGenerationAllowed()) {
        throw bridgeError(isBridgeActive() ? 'EXT_DISABLED' : 'NOT_READY', 'URIS bridge is not accepting requests (extension disabled or not initialized)');
    }
    const id = typeof cardId === 'string' && cardId.trim() ? cardId.trim() : null;
    if (!id) throw bridgeError('INVALID_PARAMS', 'removeCard(cardId): cardId is required');
    const all = await listCards({ reconcile: false });
    const card = all.find(item => item?.id === id);
    if (!card) throw bridgeError('NOT_FOUND', `Gallery card "${id}" was not found`);
    const owner = bridgeCallerFromRequestId(card?.provenance?.requestId);
    if (owner !== caller) {
        throw bridgeError('CARD_NOT_OWNED', `Card "${id}" belongs to ${owner ? `"${owner}"` : 'a manual generation'}, not to "${caller}"`);
    }
    const removed = await removeGalleryCard(id);
    if (removed) emitBridge('gallery:removed', { caller, cardId: id });
    return removed;
}

/**
 * Pending recovery records: paid provider requests whose outcome URIS could
 * not confirm (tab closed mid-flight, network died after the POST…). Never
 * resubmitted automatically — this is a review list, and the caller filter
 * narrows it to one consumer's records.
 * @param {unknown} query - { caller? }
 * @returns {Promise<Array>}
 */
async function listPending(query = {}) {
    if (!isGenerationAllowed()) {
        throw bridgeError(isBridgeActive() ? 'EXT_DISABLED' : 'NOT_READY', 'URIS bridge is not accepting requests (extension disabled or not initialized)');
    }
    const q = query && typeof query === 'object' && !Array.isArray(query) ? /** @type {Record<string, unknown>} */ (query) : {};
    const caller = typeof q.caller === 'string' && q.caller.trim() ? q.caller.trim() : null;
    if (caller && !CALLER_RE.test(caller)) {
        throw bridgeError('INVALID_PARAMS', `caller filter "${caller}" is not a valid caller tag`);
    }
    const records = await listPendingBrowserRequests();
    const out = [];
    for (const item of records) {
        const summary = sanitizeBridgePendingRecord(item);
        if (!summary) continue;
        if (caller && summary.caller !== caller) continue;
        out.push(summary);
    }
    return out;
}

/**
 * Capabilities of one image connection (default: the current chat's). Read
 * modelId/contract/refs policy/known sizes BEFORE composing a request, so a
 * capability mistake is a local error instead of a paid one.
 * Reflects URIS's current knowledge: 'unknown' means "never verified", it is
 * not a refusal — dispatch may still succeed.
 * @param {unknown} connectionId
 */
async function getCapabilities(connectionId = null) {
    if (!isGenerationAllowed()) {
        throw bridgeError(isBridgeActive() ? 'EXT_DISABLED' : 'NOT_READY', 'URIS bridge is not accepting requests (extension disabled or not initialized)');
    }
    let connId = typeof connectionId === 'string' && connectionId.trim() ? connectionId.trim() : null;
    if (!connId) {
        let snapshot = null;
        try { snapshot = await resolveChatConfigSnapshot(); } catch { snapshot = null; }
        connId = snapshot?.imageProfileId || null;
    }
    if (!connId) throw bridgeError('NO_CONNECTION', 'No image connection available. Pass connectionId or select a connection in the current chat.');
    const resolved = await resolveConnection(connId);
    if (!resolved) throw bridgeError('NO_CONNECTION', `Connection ${connId} was not found`);
    const plan = resolveDispatchPlan(resolved.conn);
    const route = plan?.route || null;
    const caps = route?.capabilities || {};
    const modelId = resolved.conn.model?.id ?? null;
    return {
        connectionId: resolved.conn.id,
        label: resolved.conn.label || resolved.conn.name || resolved.conn.id,
        modelId,
        ready: Boolean(route),
        contract: route?.generationContract ?? null,
        imageGeneration: typeof caps.generate === 'string' ? caps.generate : 'unknown',
        references: typeof caps.references === 'string' ? caps.references : 'unknown',
        maxReferences: Number.isSafeInteger(caps.maxReferences) ? caps.maxReferences : null,
        sizes: Array.isArray(caps.imageSizes) ? [...caps.imageSizes] : supportedImageSizesFor(modelId),
        qualities: Array.isArray(caps.qualityValues) ? [...caps.qualityValues] : [...VALID_QUALITIES],
    };
}

/**
 * The inline-trigger registry as generate({trigger}) resolves it:
 * { id, name, aliases, aspect, refsPolicy } per profile. Prompt fragments
 * (prefix/suffix) are prompt bodies and stay private, same policy as
 * listTemplates().
 */
async function listTriggerProfiles() {
    if (!isGenerationAllowed()) {
        throw bridgeError(isBridgeActive() ? 'EXT_DISABLED' : 'NOT_READY', 'URIS bridge is not accepting requests (extension disabled or not initialized)');
    }
    const registry = sanitizeTriggerList(state.settings?.inlineTriggers || DEFAULT_TRIGGERS);
    return registry.map(t => ({ id: t.id, name: t.name, aliases: [...t.aliases], aspect: t.aspect, refsPolicy: t.refsPolicy }));
}

/**
 * Scene text → URIS prompt template (Stage 1) → image (Stage 2) in one call.
 * `request.text` is the scene; `request.templateId` picks a prompt template;
 * every other generate() field passes through (`aspectRatio`, `quality`,
 * `references`, `connectionId`, `modelId`, `useSceneRefs` defaulting to true…).
 * Both halves share the caller and the opts.signal; both events fire
 * (prompt:* then generation:*).
 * @param {unknown} request - { text, templateId?, ...generateFields }
 * @param {unknown} opts - { caller, signal?, onStatus?, queue? }
 * @returns {Promise<{built:object, result:object}>}
 */
async function generateFromScene(request = {}, opts = {}) {
    // Fail fast on an invalid caller before ANY paid stage starts.
    validateBridgeCaller(opts && typeof opts === 'object' ? /** @type {Record<string, unknown>} */ (opts).caller : undefined);
    const req = request && typeof request === 'object' && !Array.isArray(request) ? /** @type {Record<string, unknown>} */ (request) : {};
    const built = await buildPrompt({
        text: req.text,
        templateId: req.templateId,
        useScene: req.useScene,
        expandMacros: req.expandMacros,
    }, opts);
    const result = await generate({
        prompt: built.prompt,
        aspectRatio: req.aspectRatio,
        imageSize: req.imageSize,
        quality: req.quality,
        references: Array.isArray(req.references) ? req.references : [],
        connectionId: req.connectionId,
        modelId: req.modelId,
        trigger: req.trigger,
        useSceneRefs: req.useSceneRefs !== false,
        expandMacros: req.expandMacros,
    }, opts);
    return { built, result };
}

// ── Lifecycle ──

/**
 * Publish globalThis.URIS immediately (before async init work), so consumers
 * loaded after URIS see the global at once and everyone else can await
 * `URIS.ready`. Idempotent.
 */
export function activateBridge() {
    if (_bridge) return _bridge;
    _readyPromise = new Promise((resolve, reject) => { _readyResolve = resolve; _readyReject = reject; });
    _ready = false;
    _bridge = Object.freeze({
        apiVersion: BRIDGE_API_VERSION,
        displayName: 'UR Image Studio',
        ready: _readyPromise,
        generate,
        buildPrompt,
        generateFromScene,
        parseInline: (text) => {
            const registry = sanitizeTriggerList(state.settings?.inlineTriggers || DEFAULT_TRIGGERS);
            const idx = buildAliasIndex(registry);
            return parseInline(text).map(m => ({ ...m, profile: resolveProfile(idx, m.type) }));
        },
        abort,
        listActive,
        listConnections,
        listTemplates: listBridgeTemplates,
        listRefs: listBridgeRefs,
        listTriggers: listTriggerProfiles,
        getCapabilities,
        listGallery,
        getCard,
        removeCard,
        listPending,
        classifyError: classifyBridgeError,
        getStatus,
        on,
        off,
    });
    globalThis.URIS = _bridge;
    return _bridge;
}

/** Resolve `URIS.ready` once init() finished successfully. */
export function markBridgeReady() {
    _ready = true;
    _readyResolve?.();
    _readyResolve = null;
    _readyReject = null;
    emitBridge('ready', {});
}

/**
 * Reject `URIS.ready` when init() failed or bailed out early, so consumers
 * awaiting it get a rejection instead of hanging forever. A later
 * re-enable re-activates the bridge with a fresh pending promise.
 * @param {unknown} err
 */
export function markBridgeFailed(err) {
    if (_ready) return;
    const failure = err instanceof Error ? err : bridgeError('NOT_READY', `URIS failed to initialize: ${String(err?.message || err)}`);
    try {
        _readyReject?.(failure);
        // No-op handler so a rejection with no awaiting consumer does not
        // surface as an unhandledRejection; awaiting consumers still get it.
        _readyPromise?.catch(() => {});
    } catch { /* already settled */ }
    _readyResolve = null;
    _readyReject = null;
}

/**
 * Tear the bridge down (extension disable / cleanup): reject queued external
 * runs, unregister the global, notify consumers. Idempotent.
 */
export function deactivateBridge() {
    if (!_bridge) return;
    for (const meta of _externalRuns.values()) {
        try { meta.controller.abort(); } catch { /* already aborted */ }
    }
    _externalRuns.clear();
    _listeners.clear();
    _bridge = null;
    _ready = false;
    const pendingReady = _readyPromise;
    _readyPromise = null;
    // A pending ready promise must not outlive the bridge: awaiting consumers
    // would hang forever on a global that no longer exists. The no-op catch
    // keeps the rejection from surfacing as an unhandledRejection when no
    // consumer is awaiting it at that moment.
    try {
        _readyReject?.(bridgeError('NOT_READY', 'URIS was disabled before initialization finished'));
        pendingReady?.catch(() => {});
    } catch { /* already settled */ }
    _readyResolve = null;
    _readyReject = null;
    delete globalThis.URIS;
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try { window.dispatchEvent(new CustomEvent('uris:bridge-destroyed')); } catch { /* ignore */ }
    }
}

/** Test hook: current global surface (null when inactive). */
export function getBridge() {
    return _bridge;
}
