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
 *   - getStatus/listConnections/listRefs/listTemplates
 *   - onEvent()    — generation lifecycle events
 *
 * Every request is attributed with your `caller` tag (diagnostics, gallery
 * provenance, requestId prefix). Errors are structured: `err.code`.
 *
 * Compatibility: bridge apiVersion 1 (URIS ≥ 0.8.6 with the bridge enabled).
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
                if (bridge()) return; // ready may still be pending on the surface itself
                const uris = bridge();
                if (uris) attach(uris);
                else reject(new UrisUnavailableError(`URIS bridge not found within ${timeoutMs}ms (not installed or disabled)`));
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
     */
    async function generateFromScene(
        { text, templateId, aspectRatio = '1:1', connectionId, extraReferences = [], ...genRest } = {},
        opts = {},
    ) {
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

    /** Abort any URIS generation by requestId (yours or others'). */
    function abort(requestId) {
        return bridge()?.abort(requestId) ?? false;
    }

    /**
     * Subscribe to bridge events without holding a ready() promise:
     * 'generation:queued' | 'generation:started' | 'generation:ended' |
     * 'generation:error' | 'prompt:started' | 'prompt:ended' | 'prompt:error'
     * | 'ready' | 'destroyed' | '*'. Returns an unsubscribe function.
     */
    function onEvent(type, cb) {
        const handler = (ev) => {
            const detail = ev?.detail || {};
            if (detail.type === type || type === '*') cb(detail);
        };
        window.addEventListener(BRIDGE_READY_EVENT, handler);
        return () => window.removeEventListener(BRIDGE_READY_EVENT, handler);
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
 * @property {(requestId: string) => boolean} abort
 * @property {(type: string, cb: (detail: object) => void) => () => void} onEvent
 */
