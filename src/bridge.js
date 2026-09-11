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
 *   - generate / abort / getStatus / listConnections / on / off / ready
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
 * @returns {{prompt:string, aspectRatio:string, imageSize:string, quality:string, references:Array<{id:string,name:string,dataUrl:string}>, connectionId:string|null, modelId:string|null}}
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
    const useSceneRefs = req.useSceneRefs === true;
    const expandMacros = req.expandMacros !== false;
    return { prompt, aspectRatio, imageSize, quality, references, connectionId, modelId, useSceneRefs, expandMacros };
}

// ── Runtime (browser) state ──

let _bridge = null;
let _readyResolve = null;
let _readyPromise = null;
let _ready = false;
let _chain = Promise.resolve();
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

function emitStage2(requestId, caller, kind) {
    // Same channel the pipeline uses, so the URIS window (Stop button, queue
    // status) reacts to external generations for free. msgId stays null:
    // headless requests are not bound to a chat post.
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try { window.dispatchEvent(new CustomEvent(`uris:stage2-${kind}`, { detail: { requestId, msgId: null, source: `external:${caller}` } })); } catch { /* ignore */ }
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

        /** @type {Record<string, unknown>} */
        const dispatchOpts = {};
        if (norm.modelId) {
            const resolved = await resolveConnection(connId);
            if (!resolved) throw bridgeError('NO_CONNECTION', `Connection ${connId} was not found`);
            const plan = resolveDispatchPlan({ ...resolved.conn, model: { id: norm.modelId, source: 'manual' } });
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
        let basePrompt = norm.expandMacros === false ? norm.prompt : resolveSTMacros(norm.prompt);
        const matchedByResolver = [];
        if (norm.useSceneRefs) {
            const candidates = await buildCandidates(state.currentChatId || 'current');
            const resolution = await resolvePromptReferenceContext({
                prompt: basePrompt,
                candidates,
                corrections: { includedIds: [], excludedIds: [], revision: 0 },
            });
            for (const r of resolution.stage2Refs || []) {
                if (r.bindingMode === 'description') {
                    descriptionEntries.push({ name: r.name, description: r.description, bindingMode: 'description' });
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
            aspectRatio: norm.aspectRatio,
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
        emitBridge('generation:ended', { requestId, caller, result: payload });
        return payload;
    } catch (e) {
        const cancelled = controller.signal.aborted || e?.name === 'AbortError';
        recordDiagnosticEvent({
            event: 'bridge-generate-end', requestId, outcome: cancelled ? 'cancelled' : 'error',
            durationMs: Date.now() - startedAt,
            details: { caller, code: e?.code || null, message: e?.message || String(e) },
        });
        if (cancelled && e?.code == null) throw bridgeError('ABORTED', 'Generation aborted');
        emitBridge('generation:error', { requestId, caller, error: { code: e?.code || null, message: e?.message || String(e) } });
        throw e;
    } finally {
        state.activeGenerations.delete(requestId);
        _externalRuns.delete(requestId);
        emitStage2(requestId, caller, 'end');
    }
}

/**
 * Headless paid generation, not bound to a chat message.
 * @param {unknown} request - { prompt, aspectRatio?, imageSize?, quality?, references?, connectionId?, modelId? }
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
    if (options.queue === false) return run();
    const pending = _chain.then(run, run);
    _chain = pending.catch(() => {});
    return pending;
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
 * | 'generation:ended' | 'generation:error' | 'ready' | 'destroyed', or '*'.
 * Returns an unsubscribe function.
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
        recordDiagnosticEvent({
            event: 'bridge-build-prompt-end', requestId, outcome: cancelled ? 'cancelled' : 'error',
            durationMs: Date.now() - startedAt,
            details: { caller, code: e?.code || null, message: e?.message || String(e) },
        });
        if (cancelled && e?.code == null) throw bridgeError('ABORTED', 'Request aborted');
        emitBridge('prompt:error', { requestId, caller, error: { code: e?.code || null, message: e?.message || String(e) } });
        throw e;
    } finally {
        state.activeGenerations.delete(requestId);
        _externalRuns.delete(requestId);
        emitStage2(requestId, caller, 'end');
    }
}

// ── Lifecycle ──

/**
 * Publish globalThis.URIS immediately (before async init work), so consumers
 * loaded after URIS see the global at once and everyone else can await
 * `URIS.ready`. Idempotent.
 */
export function activateBridge() {
    if (_bridge) return _bridge;
    _readyPromise = new Promise(resolve => { _readyResolve = resolve; });
    _ready = false;
    _bridge = Object.freeze({
        apiVersion: BRIDGE_API_VERSION,
        displayName: 'UR Image Studio',
        ready: _readyPromise,
        generate,
        buildPrompt,
        abort,
        listActive,
        listConnections,
        listTemplates: listBridgeTemplates,
        listRefs: listBridgeRefs,
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
    emitBridge('ready', {});
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
    _readyPromise = null;
    delete globalThis.URIS;
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try { window.dispatchEvent(new CustomEvent('uris:bridge-destroyed')); } catch { /* ignore */ }
    }
}

/** Test hook: current global surface (null when inactive). */
export function getBridge() {
    return _bridge;
}
