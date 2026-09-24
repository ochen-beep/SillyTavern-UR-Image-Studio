/**
 * URIS Bridge Client v1 — drop-in module for SillyTavern extensions.
 * ═══════════════════════════════════════════════════════════════════════════
 * Copy this file into YOUR extension and import it. Zero dependencies: it
 * talks only to the published `globalThis.URIS` surface of UR Image Studio
 * (the "Мост"/bridge) and never imports URIS internals.
 *
 * What you get:
 *   - ready()      — resolves once URIS is installed AND initialized
 *                    (handles your extension loading before URIS)
 *   - generate()   — paid image generation (recovery, gallery, Stop button —
 *                    all handled by URIS)
 *   - buildPrompt()- URIS prompt templates (Stage 1) over arbitrary text,
 *                    with {{char}}/{{user}} macros and scene resolver
 *   - generateFromScene() — buildPrompt → generate in one call
 *   - getStatus/listConnections/listRefs/listTemplates/listTriggers
 *   - getCapabilities(connectionId?)  — contract/refs/sizes BEFORE paying
 *   - listGallery/getCard/removeCard  — caller-scoped gallery access
 *   - listPending()                   — unconfirmed PAID requests (recovery)
 *   - classifyError(err)              — code → {category, retryable}
 *   - onEvent()    — generation lifecycle events
 *
 * Every request is attributed with your `caller` tag (diagnostics, gallery
 * provenance, requestId prefix). Errors are structured: `err.code` plus
 * `err.category`/`err.retryable` (bridge ≥ 0.9.6).
 *
 * Compatibility: bridge apiVersion 1 (URIS ≥ 0.8.6 with the bridge enabled).
 * Methods added in URIS 0.9.6 (gallery, pending, capabilities, triggers)
 * are feature-detected: on an older URIS they reject with URIS_UNAVAILABLE.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const BRIDGE_READY_EVENT = 'uris:bridge';          // CustomEvent, detail.type === 'ready' | ...
const BRIDGE_DESTROYED_EVENT = 'uris:bridge-destroyed';
const CALLER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Create a client bound to your extension.
 * @param {{caller: string, waitTimeoutMs?: number}} options
 *   caller — your extension id, shown in URIS diagnostics/gallery, e.g. 'offstage'.
 *   waitTimeoutMs — default timeout for ready() when URIS is not installed.
 * @returns {UrisClient}
 */
export function createUrisClient({ caller, waitTimeoutMs = 15000 } = {}) {
    if (!CALLER_RE.test(String(caller || ''))) {
        throw new Error('createUrisClient: caller is required (1-64 chars: letters, digits, _, -)');
    }

    let _readyPromise = null;

    /** The live bridge surface, or null when URIS is not installed/disabled. */
    function bridge() {
        return globalThis.URIS || null;
    }

    function isAvailable() {
        return !!bridge();
    }

    /**
     * Resolves with the bridge surface once it exists AND finished initializing.
     * Safe to call multiple times; also safe if your extension loads BEFORE
     * URIS (it waits for the global to appear).
     * @param {{timeoutMs?: number}} [opts]
     */
    function ready({ timeoutMs = waitTimeoutMs } = {}) {
        if (_readyPromise) return _readyPromise;
        _readyPromise = new Promise((resolve, reject) => {
            const attach = (uris) => {
                uris.ready.then(
                    () => resolve(uris),
                    (e) => reject(new Error(`URIS bridge failed to initialize: ${e?.message || e}`)),
                );
            };
            const existing = bridge();
            if (existing) { attach(existing); return; }
            // URIS not loaded yet (extension load order): wait for the global.
            const onBridgeEvent = () => {
                const uris = bridge();
                if (uris) {
                    cleanup();
                    attach(uris);
                }
            };
            const onDestroyed = () => {
                cleanup();
                reject(new UrisUnavailableError('URIS was disabled before it became ready'));
            };
            const timer = setTimeout(() => {
                cleanup();
                // Timeout is a hard budget even when the global is already up:
                // a caller relying on ready() must never be blocked forever.
                // The cache is cleared on rejection, so a later ready() re-attaches.
                if (bridge()) {
                    reject(new UrisUnavailableError(`URIS bridge exists but did not become ready within ${timeoutMs}ms`));
                } else {
                    reject(new UrisUnavailableError(`URIS bridge not found within ${timeoutMs}ms (not installed or disabled)`));
                }
            }, timeoutMs);
            function cleanup() {
                clearTimeout(timer);
                window.removeEventListener(BRIDGE_READY_EVENT, onBridgeEvent);
                window.removeEventListener(BRIDGE_DESTROYED_EVENT, onDestroyed);
            }
            window.addEventListener(BRIDGE_READY_EVENT, onBridgeEvent);
            window.addEventListener(BRIDGE_DESTROYED_EVENT, onDestroyed);
        });
        // Do not cache rejections: URIS can be re-enabled later.
        _readyPromise.catch(() => { _readyPromise = null; });
        return _readyPromise;
    }

    /** Structured error mirror: branch on err.code the same way URIS does. */
    class UrisUnavailableError extends Error {
        constructor(message) { super(message); this.name = 'UrisUnavailableError'; this.code = 'URIS_UNAVAILABLE'; }
    }

    // ── Pipeline calls (wait for readiness, stamp the caller) ──

    /**
     * Paid image generation. Request: { prompt, aspectRatio?, imageSize?,
     * quality?, references?: [{refId}|{dataUrl,name?}], connectionId?, modelId?,
     * useSceneRefs?, expandMacros? }. Opts: { signal?, onStatus?, queue? }.
     * @returns {Promise<{requestId,cardId,imagePath,width,height,warnings}>}
     */
    async function generate(request, opts = {}) {
        const uris = await ready();
        return uris.generate(request, { caller, ...opts });
    }

    /**
     * URIS prompt template (Stage 1) over arbitrary text. Request:
     * { text, templateId?, useScene? = true, expandMacros? = true }.
     * Paid text-LLM call.
     * @returns {Promise<{requestId,prompt,templateId,templateType,matchedReferences,ambiguities}>}
     */
    async function buildPrompt(request, opts = {}) {
        const uris = await ready();
        return uris.buildPrompt(request, { caller, ...opts });
    }

    /**
     * Convenience: scene text → template prompt → image with scene-resolved
     * references. Returns both stages so you can show/caching the prompt.
     * Uses the bridge-native generateFromScene when available (URIS ≥ 0.9.6)
     * and falls back to the two-step composition on older installs.
     */
    async function generateFromScene(
        { text, templateId, aspectRatio = '1:1', connectionId, extraReferences = [], ...genRest } = {},
        opts = {},
    ) {
        const uris = await ready();
        if (text != null && typeof uris.generateFromScene === 'function') {
            return uris.generateFromScene(
                { text, templateId, aspectRatio, connectionId, references: extraReferences, ...genRest },
                { caller, ...opts },
            );
        }
        const built = await buildPrompt({ text, templateId, useScene: true }, opts);
        const result = await generate(
            { prompt: built.prompt, aspectRatio, connectionId, references: extraReferences, useSceneRefs: true, ...genRest },
            opts,
        );
        return { built, result };
    }

    async function getStatus() { return (await ready()).getStatus(); }
    async function listConnections() { return (await ready()).listConnections(); }
    async function listRefs() { return (await ready()).listRefs(); }
    async function listTemplates() { return (await ready()).listTemplates(); }

    /** Feature-detected bridge call: URIS < 0.9.6 lacks these. */
    async function call096(method, ...args) {
        const uris = await ready();
        if (typeof uris[method] !== 'function') {
            throw new UrisUnavailableError(`URIS.${method} requires URIS ≥ 0.9.6 (bridge apiVersion 1, additive)`);
        }
        return uris[method](...args);
    }

    /**
     * URIS ≥ 0.9.6. Trigger profiles for generate({trigger}):
     * [{id, name, aliases, aspect, refsPolicy}] — prompt bodies stay private.
     */
    async function listTriggers() { return call096('listTriggers'); }

    /**
     * URIS ≥ 0.9.6. What URIS knows about a connection (default: chat's one)
     * BEFORE a paid call: { connectionId, label, modelId, ready, contract,
     * imageGeneration, references, maxReferences, sizes, qualities }.
     * 'unknown' values mean "never verified", not a refusal.
     */
    async function getCapabilities(connectionId) { return call096('getCapabilities', connectionId); }

    /**
     * URIS ≥ 0.9.6. Read the URIS gallery, optionally narrowed to YOUR cards:
     * listGallery({ caller: clientCaller, limit?, offset?, includeHidden? })
     * → { total, cards: [{id, imagePath, thumbPath, prompt, width, height,
     * status, createdAt, requestId, caller, …}] }. Cards are read-only
     * summaries; show images via `<img src="/"+card.imagePath>`.
     */
    async function listGallery(query = {}) { return call096('listGallery', { caller, ...query }); }

    /** URIS ≥ 0.9.6. One gallery card by id (same sanitized shape). */
    async function getCard(cardId) { return call096('getCard', cardId); }

    /**
     * URIS ≥ 0.9.6. Delete YOUR gallery card (attributed to your caller via
     * provenance.requestId). Foreign/manual cards → CARD_NOT_OWNED. The image
     * FILE stays in the ST gallery — only the URIS card is removed.
     */
    async function removeCard(cardId) { return call096('removeCard', cardId, { caller }); }

    /**
     * URIS ≥ 0.9.6. Recovery review: PAID requests whose result URIS could not
     * confirm (closed tab, network cut after the POST). Never auto-resubmitted.
     * → [{requestId, caller, status, createdAt, error, prompt, …}], yours only.
     */
    async function listPending(query = {}) { return call096('listPending', { caller, ...query }); }

    /**
     * URIS ≥ 0.9.6. Local copy of the bridge classifier: err → { code,
     * category, retryable }. Safe on any error, including plain Error.
     */
    function classifyError(err) {
        const b = bridge();
        if (b && typeof b.classifyError === 'function') return b.classifyError(err);
        const code = typeof err?.code === 'string' ? err.code : null;
        if (err?.name === 'AbortError' || code === 'ABORTED') return { code: 'ABORTED', category: 'cancelled', retryable: false };
        if (code === 'URIS_UNAVAILABLE' || code === 'NOT_READY' || code === 'EXT_DISABLED') return { code, category: 'unavailable', retryable: true };
        if (code === 'INVALID_PARAMS' || code === 'INVALID_CALLER' || code === 'CARD_NOT_OWNED') return { code, category: 'invalid-request', retryable: false };
        if (code) return { code, category: 'config', retryable: false };
        return { code: null, category: 'unknown', retryable: false };
    }

    /** Abort any URIS generation by requestId (yours or others'). */
    function abort(requestId) {
        return bridge()?.abort(requestId) ?? false;
    }

    /**
     * Subscribe to bridge events without holding a ready() promise:
     * 'generation:queued' | 'generation:started' | 'generation:ended' |
     * 'generation:error' | 'prompt:started' | 'prompt:ended' | 'prompt:error'
     * | 'gallery:added' | 'gallery:removed' (URIS ≥ 0.9.6)
     * | 'ready' | 'destroyed' | '*'. Returns an unsubscribe function.
     * Error details carry { code, message, category, retryable } on ≥ 0.9.6.
     */
    function onEvent(type, cb) {
        const handler = (ev) => {
            const detail = ev?.detail || {};
            if (detail.type === type || type === '*') cb(detail);
        };
        // 'destroyed' travels on its own window event without a detail payload,
        // so synthesize the detail here — the plain bridge-events handler above
        // would never see it.
        const onDestroyed = () => {
            if (type === 'destroyed' || type === '*') cb({ type: 'destroyed' });
        };
        window.addEventListener(BRIDGE_READY_EVENT, handler);
        window.addEventListener(BRIDGE_DESTROYED_EVENT, onDestroyed);
        return () => {
            window.removeEventListener(BRIDGE_READY_EVENT, handler);
            window.removeEventListener(BRIDGE_DESTROYED_EVENT, onDestroyed);
        };
    }

    return {
        caller,
        isAvailable,
        ready,
        generate,
        buildPrompt,
        generateFromScene,
        getStatus,
        listConnections,
        listRefs,
        listTemplates,
        listTriggers,
        getCapabilities,
        listGallery,
        getCard,
        removeCard,
        listPending,
        classifyError,
        abort,
        onEvent,
    };
}

/**
 * @typedef {object} UrisClient
 * @property {string} caller
 * @property {() => boolean} isAvailable
 * @property {(opts?: {timeoutMs?: number}) => Promise<object>} ready
 * @property {(request: object, opts?: object) => Promise<object>} generate
 * @property {(request: object, opts?: object) => Promise<object>} buildPrompt
 * @property {(request?: object, opts?: object) => Promise<{built: object, result: object}>} generateFromScene
 * @property {() => Promise<object>} getStatus
 * @property {() => Promise<Array>} listConnections
 * @property {() => Promise<Array>} listRefs
 * @property {() => Promise<Array>} listTemplates
 * @property {() => Promise<Array>} listTriggers      — URIS ≥ 0.9.6
 * @property {(connectionId?: string) => Promise<object>} getCapabilities — URIS ≥ 0.9.6
 * @property {(query?: object) => Promise<{total: number, cards: Array}>} listGallery — URIS ≥ 0.9.6
 * @property {(cardId: string) => Promise<object>} getCard — URIS ≥ 0.9.6
 * @property {(cardId: string) => Promise<boolean>} removeCard — URIS ≥ 0.9.6, own cards only
 * @property {(query?: object) => Promise<Array>} listPending — URIS ≥ 0.9.6
 * @property {(err: unknown) => {code: string|null, category: string, retryable: boolean}} classifyError
 * @property {(requestId: string) => boolean} abort
 * @property {(type: string, cb: (detail: object) => void) => () => void} onEvent
 */
