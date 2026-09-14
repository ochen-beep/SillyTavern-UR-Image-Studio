// @ts-check
/**
 * UR Image Studio — network dumper: records image-API and Stage1 text-LLM
 * requests/responses in IndexedDB (via ST localforage) for later export as a
 * separate network-evidence file and debugging of "no response / no image" bugs.
 *
 * Purpose: on generation failure (Gemini responds 200 OK without inlineData,
 * ERR_CONNECTION_CLOSED, etc.) the full response structure is preserved
 * (candidates, finishReason, safetyRatings, model text) — the very signal
 * that is currently lost. The proxy is stable; the bug is almost always on
 * the upstream API side, and without the response body the cause is invisible.
 *
 * Privacy:
 *   - Authorization / x-goog-api-key are always stripped (replaced with '<redacted>').
 *   - base64 references (inlineData.data / inline_data.data) are collapsed to
 *     { mimeType, _bytes } to avoid dragging megabytes of images into the dump.
 *   - Image in response (detected by magic bytes) is not written as a blob — only
 *     metadata { mime, _bytes, _skipped: true } (it ends up in the gallery anyway).
 *   - The profile path Stage1 (ConnectionManagerRequestService) goes through the ST
 *     server — apiKey is unavailable here (server-side), only profile id/model
 *     and message window are written.
 *
 * Not recorded (kept out on purpose — the unified dump was growing megabytes of
 * duplicates and public data):
 *   - Model-catalog requests (/v1/models, /image/models, /api/models,
 *     /images/models): public bodies, the largest JSON in the journal, re-fetched
 *     on every catalog refresh — and they evicted useful generation evidence
 *     from the MAX_NET_ENTRIES rotation.
 *   - Structured dispatch metadata (route/conn/model/operation/delivery/...):
 *     the diagnostic journal (diagnostic-events.js) already stores it per
 *     requestId; entries here carry only that requestId for correlation.
 *   - Derived response facts (envelope/jsonMeta): recomputable from resp.body,
 *     which sits in the same entry.
 *   - Request bodies are capped in total (head+tail preview beyond 32 KB): the
 *     message history duplicates across entries, but the system prompt (head
 *     of `messages`) and the current prompt (last message, tail) survive.
 *
 * Architecture: non-blocking writes. fetchWithTimeout/proxy are wrapped so that
 * dumper errors NEVER break generation — all recorder functions are called
 * fire-and-forget (caller chains .catch(()=>{})).
 *
 * Storage: SillyTavern.libs.localforage under key LF_NETDUMP (JSON array).
 * Rotation when exceeding MAX_NET_ENTRIES (old entries are discarded).
 */

import { DISPLAY_NAME, extractTextFromResponse, readResponseBody } from './core.js';
import { recordDiagnosticEvent } from './diagnostic-events.js';

export const LF_NETDUMP = 'uris_netdump';
// 2–3 entries per generation (paid POST, occasional image download, Stage1);
// 500 holds a working day of evidence. Eviction prefers successes: entries with
// an error are the whole point of the dump and outlive the routine 200s.
export const MAX_NET_ENTRIES = 500;
const DUMP_VERSION = 1;
const MAX_JSON_BYTES = 65536;   // 64 KB — limit on full response JSON
const MAX_TEXT_BYTES = 8192;     // 8 KB — on non-JSON/text response
const MAX_STR_IN_MESSAGES = 2000;
// Total cap on a compacted request body. Responses already had MAX_JSON_BYTES;
// requests had no total limit, so a text-LLM message window (tens of KB that
// duplicate across consecutive entries) was stored in full every time.
const MAX_REQ_JSON_BYTES = 32768;
const REQ_HEAD_BYTES = 24576;
const REQ_TAIL_BYTES = 8192;

// Hosts/patterns NOT written to the dump (internal ST routes, probe).
const SKIP_HOSTS = new Set(['example.com']);
const SKIP_PATH_FRAGMENTS = ['/api/secrets'];

// ─── localforage access ───

async function _lf() {
    try { return SillyTavern?.libs?.localforage; } catch { return null; }
}

async function _readEntries() {
    const lf = await _lf();
    if (!lf) return [];
    try {
        const v = await lf.getItem(LF_NETDUMP);
        return Array.isArray(v) ? v : [];
    } catch { return []; }
}

async function _writeEntries(arr) {
    const lf = await _lf();
    if (!lf) return false;
    try { await lf.setItem(LF_NETDUMP, arr); return true; } catch { return false; }
}

// Every recorder is fire-and-forget from fetchWithTimeout. Track the recorder
// before its first async body read; otherwise an export started immediately
// after fetch completion can observe an empty write chain and miss the entry.
let _writeChain = Promise.resolve();
const _activeRecorders = new Set();
let _clearEpoch = 0;

function enqueueWrite(task) {
    const operation = _writeChain.then(task);
    _writeChain = operation.catch(() => {});
    return operation;
}

function trackRecorder(task) {
    const operation = Promise.resolve().then(task);
    _activeRecorders.add(operation);
    operation.then(
        () => _activeRecorders.delete(operation),
        () => _activeRecorders.delete(operation),
    );
    return operation;
}

async function waitForRecorders() {
    while (_activeRecorders.size) {
        await Promise.all([..._activeRecorders].map(operation => operation.catch(() => {})));
    }
    await _writeChain;
}

// ─── Public API ───

/** Record a ready entry (rotation prefers evicting successes over errors). */
export function recordNetEntry(entry) {
    return enqueueWrite(async () => {
        const entries = await _readEntries();
        entries.push(entry);
        while (entries.length > MAX_NET_ENTRIES) {
            // An entry with an error is the evidence this dump exists for —
            // evict the oldest successful one first; FIFO only when the tail
            // is all errors.
            const evict = entries.findIndex(item => item?.error == null);
            entries.splice(evict === -1 ? 0 : evict, 1);
        }
        await _writeEntries(entries);
    });
}

/** Current entry count (for badge/button tooltip). */
export async function getNetDumpsCount() {
    await _writeChain;
    return (await _readEntries()).length;
}

/** Clear all network evidence, including recorder work already in flight. */
export async function clearNetDumps() {
    const epoch = ++_clearEpoch;
    await waitForRecorders();
    return enqueueWrite(async () => {
        // A recorder that started before the clear may have completed while we
        // waited. Remove the current snapshot now; later recorders are allowed
        // to create fresh evidence after the user's explicit clear.
        if (epoch !== _clearEpoch) return false;
        return _writeEntries([]);
    });
}

// ─── Filtering ───

const AUTH_HEADERS = new Set(['authorization', 'x-goog-api-key', 'api-key', 'x-api-key', 'proxy-authorization']);

// String fields we do NOT collapse — their content is needed for analysis
// (model prompts/text-LLM responses). Other long strings (thoughtSignature,
// signature, embedding, any blobs) are collapsed to { _kind, _bytes }.
const KEEP_LONG_STRING_KEYS = new Set([
    'text', 'content', 'prompt', 'message', 'reply', 'answer',
    'role', 'finishReason', 'finish_reason', 'model', 'modelVersion',
    'mimeType', 'mime_type', 'reasoning', 'summary', 'thought',
    // system_instruction/system text needed for prompt analysis.
    'system_instruction', 'system',
]);
// String length threshold above which non-keep keys are collapsed. Text
// (keep-set) fields are preserved up to MAX_TEXT_BYTES — so one prompt
// doesn't inflate the dump, but model content remains visible.
const LONG_STRING_THRESHOLD = 1024;

/**
 * Recursively collapse base64 blobs (inlineData.data / inline_data.data) and
 * long string fields (thoughtSignature/signature/embedding/any blob)
 * to { mimeType, _bytes } / { _kind:'long-string-dropped', _bytes, _key }.
 * Preserves text parts and keep-set fields (prompt needed for analysis).
 * Returns a NEW object (does not mutate the original) — safe for dump.
 */
export function compactBase64Blobs(node, depth = 0) {
    if (depth > 16 || node == null) return node;
    if (Array.isArray(node)) return node.map((x) => compactBase64Blobs(x, depth + 1));
    if (typeof node !== 'object') {
        // Long string outside an object (never on the main path: objects go
        // through the branch below with a keep-check; a string becomes an
        // argument only on recursion from a non-keep key value — collapsing
        // is acceptable there, but for safety we just return as-is; the
        // decisive keep-test is performed at the parent level).
        return node;
    }
    // Inline photo — camelCase and snake_case.
    if (typeof node.data === 'string' && typeof node.mimeType === 'string' && node.data.length > 128) {
        return { mimeType: node.mimeType, _bytes: node.data.length, _kind: 'inlineData-dropped' };
    }
    if (typeof node.data === 'string' && typeof node.mime_type === 'string' && node.data.length > 128) {
        return { mime_type: node.mime_type, _bytes: node.data.length, _kind: 'inline_data-dropped' };
    }
    const out = {};
    for (const k of Object.keys(node)) {
        const v = node[k];
        // Long string of a non-keep key (thoughtSignature/signature/embedding/...)
        // is collapsed. Keep keys (text/prompt/...) are preserved in full —
        // this is the content the dump is meant to capture.
        if (typeof v === 'string' && v.length > LONG_STRING_THRESHOLD && !KEEP_LONG_STRING_KEYS.has(k)) {
            out[k] = { _kind: 'long-string-dropped', _bytes: v.length, _key: k };
        } else if (typeof v === 'string' && v.length > MAX_TEXT_BYTES) {
            // Keep key but string is abnormally long (>8 KB) — limit it,
            // otherwise one prompt could occupy tens of KB in the dump.
            out[k] = v.slice(0, MAX_TEXT_BYTES) + '\n[truncated]';
        } else {
            out[k] = compactBase64Blobs(v, depth + 1);
        }
    }
    return out;
}

/** Filter headers: strip auth. */
export function filterHeaders(headers) {
    if (!headers) return headers;
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        out[k] = AUTH_HEADERS.has(String(k).toLowerCase()) ? '<redacted>' : v;
    }
    return out;
}

/**
 * Correlation key for the diagnostic journal: the entry keeps only requestId —
 * dispatch metadata (route/conn/model/operation/...) lives in the journal's
 * dispatch-* events under the same requestId, so duplicating it here would
 * double every entry's size without adding a fact.
 */
function correlationId(options) {
    const id = options?.__urisDiagnostic?.requestId;
    return typeof id === 'string' && id ? id : null;
}

const RESPONSE_HEADERS = [
    'content-type', 'content-encoding', 'content-length', 'retry-after',
    'server', 'via', 'cf-ray', 'traceparent', 'x-request-id', 'request-id',
    'openai-request-id', 'x-goog-request-id', 'access-control-allow-origin',
    'access-control-allow-credentials', 'access-control-expose-headers',
];

function responseHeaders(response) {
    const out = {};
    for (const name of RESPONSE_HEADERS) {
        try {
            const value = response?.headers?.get?.(name);
            if (value && value.length <= 512) out[name] = value;
        } catch { /* diagnostic only */ }
    }
    return Object.keys(out).length ? out : null;
}

function responseCorrelationId(response) {
    const names = ['x-request-id', 'request-id', 'openai-request-id', 'x-goog-request-id', 'cf-ray', 'traceparent'];
    for (const name of names) {
        try {
            const value = response?.headers?.get?.(name);
            if (value && value.length <= 256) return value;
        } catch { /* diagnostic only */ }
    }
    return null;
}

/**
 * Cap a compacted request body at MAX_REQ_JSON_BYTES. Head+tail split, not the
 * start-only slice the response preview uses: a text-LLM request puts the
 * system prompt at the head of `messages` and the current prompt in the LAST
 * message, so a start-only preview would cut off exactly the prompt the entry
 * exists to capture. Small bodies pass through unchanged (bare object).
 */
function capRequestBody(compacted, originalBytes) {
    let str;
    try { str = JSON.stringify(compacted); } catch { return compacted; }
    if (str.length <= MAX_REQ_JSON_BYTES) return compacted;
    const head = str.slice(0, REQ_HEAD_BYTES);
    const tail = str.slice(-REQ_TAIL_BYTES);
    return {
        _kind: 'json',
        _truncated: true,
        preview: `${head}\n…[${str.length - head.length - tail.length} chars truncated]…\n${tail}`,
        _bytes: originalBytes ?? str.length,
        _previewBytes: head.length + tail.length,
    };
}

export function filterRequestBody(body) {
    if (body == null) return null;
    if (typeof body === 'string') {
        // Attempt to parse JSON and collapse base64 blobs.
        try {
            const obj = JSON.parse(body);
            if (obj && typeof obj === 'object') return capRequestBody(compactBase64Blobs(obj), body.length);
        } catch { /* not JSON — return truncated string */ }
        return body.length > MAX_TEXT_BYTES ? body.slice(0, MAX_TEXT_BYTES) + '\n[truncated]' : body;
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const out = { _form: [] };
        try {
            for (const [k, v] of body.entries()) {
                if (v instanceof Blob) out._form.push({ field: k, _blobType: v.type, _blobSize: v.size });
                else out._form.push({ field: k, value: String(v) });
            }
        } catch { /* non-critical */ }
        return out;
    }
    if (typeof body === 'object') return capRequestBody(compactBase64Blobs(body), null);
    return String(body);
}

/**
 * Filter response body previously read as { bytes, text, mime }.
 * Images — skip (metadata only). JSON — full object (with truncation). Text — short.
 */
export function filterResponseBody({ bytes, text, mime }) {
    if (mime) {
        // Image — don't write blob, only metadata (it's already in the gallery).
        return { _kind: 'image', mime, _bytes: bytes.length, _skipped: true };
    }
    if (text != null) {
        // JSON path: candidates/finishReason/safetyRatings — this is the goal.
        try {
            const obj = JSON.parse(text);
            if (obj && typeof obj === 'object') {
                const compacted = compactBase64Blobs(obj);
                let str = JSON.stringify(compacted);
                if (str.length <= MAX_JSON_BYTES) return { _kind: 'json', json: compacted, _bytes: text.length };
                // Compactor collapsed blobs (inlineData/thoughtSignature/...), but
                // the remaining JSON is still > MAX_JSON_BYTES (e.g., a very long
                // model text response). Actually truncate the string, not just flag it.
                // Truncate at string/object boundary to preserve preview validity.
                const preview = str.slice(0, MAX_JSON_BYTES);
                return { _kind: 'json', _truncated: true, preview, _bytes: text.length, _previewBytes: preview.length };
            }
        } catch { /* not JSON */ }
        // Text response (safety message, plain text).
        return text.length > MAX_TEXT_BYTES
            ? { _kind: 'text', text: text.slice(0, MAX_TEXT_BYTES) + '\n[truncated]', _bytes: text.length }
            : { _kind: 'text', text, _bytes: text.length };
    }
    return { _kind: 'empty', _bytes: bytes?.length ?? 0 };
}

// ─── Entry classification by URL ───

/**
 * Determine request type ('image' | 'text-llm' | 'download' | 'models' | 'other')
 * and skip flag (internal ST routes / probe / model catalogs). Heuristic by URL/path.
 *
 * Catalog ('models') requests are classified but skipped: public bodies, the
 * largest JSON in the journal, and they evicted generation evidence from the
 * rotation. Catalog failures still surface through the error pool and the log.
 */
export function scrubUrl(rawUrl) {
    try {
        const url = new URL(String(rawUrl), 'http://stub.local');
        for (const key of ['key', 'token', 'access_token', 'api_key', 'apikey']) {
            if (url.searchParams.has(key)) url.searchParams.set(key, '<redacted>');
        }
        const value = url.toString();
        return String(rawUrl).startsWith('http') ? value : value.replace(/^https?:\/\/stub\.local/, '');
    } catch { return String(rawUrl || ''); }
}

export function classifyUrl(rawUrl) {
    // Proxy path /proxy/<encoded> → decode.
    let url = rawUrl;
    if (typeof url === 'string' && url.startsWith('/proxy/')) {
        url = decodeURIComponent(url.slice('/proxy/'.length));
    }
    let host = '';
    try { host = new URL(url, 'http://stub.local').hostname; } catch { host = ''; }
    // host empty → relative (ST-internal).
    if (!host || host === 'stub.local') return { skip: true, kind: 'internal', url: scrubUrl(url), host: '' };
    if (SKIP_HOSTS.has(host)) return { skip: true, kind: 'probe', url: scrubUrl(url), host };
    for (const frag of SKIP_PATH_FRAGMENTS) {
        if (typeof url === 'string' && url.includes(frag)) return { skip: true, kind: 'internal', url: scrubUrl(url), host };
    }

    const pathAndQuery = String(url);
    // download by extension — image as URL (.png/.webp/.jpg).
    if (/\.(png|webp|jpe?g|gif|bmp|avif|heic)(\?|$)/i.test(pathAndQuery)) return { skip: false, kind: 'download', url: scrubUrl(url), host };
    // model list. Pollinations uses the unversioned /image/models path,
    // Naistera the unversioned /api/models, OpenRouter /v1/images/models.
    if ((/\/v1(?:beta)?\/models(\b|\/|\?|$)/i.test(pathAndQuery)
        || /\/image\/models(\b|\/|\?|$)/i.test(pathAndQuery)
        || /\/api\/models(\b|\/|\?|$)/i.test(pathAndQuery)
        || /\/images\/models(\b|\/|\?|$)/i.test(pathAndQuery))
        && !/:generateContent|:generateImage/i.test(pathAndQuery)) {
        return { skip: true, kind: 'models', url: scrubUrl(url), host };
    }
    if (/\/images\/(generations|edits)/i.test(pathAndQuery)) return { skip: false, kind: 'image', url: scrubUrl(url), host };
    // Naistera generation: the paid POST and its read-only job polling GETs.
    if (/\/api\/generate(\/jobs\/[^/?#]+)?(\b|\/|\?|$)/i.test(pathAndQuery)) return { skip: false, kind: 'image', url: scrubUrl(url), host };
    if (/pollinations\.ai/i.test(host)) return { skip: false, kind: 'image', url: scrubUrl(url), host };
    if (/agnes(-ai)?\.|moe-atelier|fuzhan|magicv4|comfyui|a1111|sdwebui/i.test(host)) return { skip: false, kind: 'image', url: scrubUrl(url), host };
    if (/:generateContent/i.test(pathAndQuery)) {
        // Gemini text-LLM and image-LLM share the URL: distinguish by model name.
        // If the path contains "-image" → image-generation; otherwise text-LLM.
        const imageModel = /-image\b|imagen|\bimage\b|flash-image|pro-image/i.test(pathAndQuery);
        return { skip: false, kind: imageModel ? 'image-gemini' : 'text-llm', url: scrubUrl(url), host };
    }
    if (/\/v1\/chat\/completions/i.test(pathAndQuery)) return { skip: false, kind: 'text-llm', url: scrubUrl(url), host };
    if (/\/v1beta\/models\//i.test(pathAndQuery)) {
        // Default Gemini path — text-LLM (flash/pro without -image).
        return { skip: false, kind: 'text-llm', url: scrubUrl(url), host };
    }
    return { skip: false, kind: 'other', url: scrubUrl(url), host };
}

function _newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function _shortStr(s, n = MAX_STR_IN_MESSAGES) {
    return typeof s === 'string' ? (s.length > n ? s.slice(0, n) + '…' : s) : String(s ?? '');
}

// ─── Recorders (used from core.js / text-connection.js) ───

/**
 * Record a successful fetch-response (clone for re-reading the body).
 * The options object is saved collapsed. Does NOT throw.
 */
export async function recordFromFetch(url, options, resp, durationMs) {
    return trackRecorder(async () => {
        const cls = classifyUrl(url);
        if (cls.skip) return;
        let respBody = null;
        try {
            const clone = resp.clone();
            const { bytes, text, mime } = await readResponseBody(clone);
            respBody = filterResponseBody({ bytes, text, mime });
        } catch (e) {
            respBody = { _kind: 'read-error', error: String(e?.message || e) };
        }
        const entry = {
            id: _newId(),
            ts: new Date().toISOString(),
            kind: cls.kind,
            host: cls.host,
            requestId: correlationId(options),
            method: options?.method || 'GET',
            url: cls.url,
            durationMs: Math.round(durationMs),
            req: {
                headers: filterHeaders(options?.headers),
                body: filterRequestBody(options?.body),
            },
            resp: {
                status: resp.status,
                ok: resp.ok,
                contentType: (() => { try { return resp.headers.get('content-type') || ''; } catch { return ''; } })(),
                headers: responseHeaders(resp),
                upstreamRequestId: responseCorrelationId(resp),
                body: respBody,
            },
            error: null,
        };
        await recordNetEntry(entry);
    });
}

/** Record a fetch network error (CORS, timeout, ERR_CONNECTION_CLOSED). */
export async function recordFromFetchError(url, options, err, durationMs) {
    return trackRecorder(async () => {
        const cls = classifyUrl(url);
        if (cls.skip) return;
        const entry = {
            id: _newId(),
            ts: new Date().toISOString(),
            kind: cls.kind,
            host: cls.host,
            requestId: correlationId(options),
            method: options?.method || 'GET',
            url: cls.url,
            durationMs: Math.round(durationMs),
            req: {
                headers: filterHeaders(options?.headers),
                body: filterRequestBody(options?.body),
            },
            resp: null,
            error: String(err?.name === 'AbortError' ? 'Aborted' : (err?.message || err)),
            errorInfo: {
                name: err?.name || 'Error',
                code: err?.code || null,
                httpStatus: Number.isFinite(err?.httpStatus) ? err.httpStatus : null,
            },
        };
        await recordNetEntry(entry);
    });
}

/**
 * Record a successful profile-path Stage1 response
 * (ConnectionManagerRequestService.sendRequest — ST server route).
 */
export async function recordFromProfile(profile, messages, response, durationMs, diagnostic = null) {
    const entry = {
        id: _newId(),
        ts: new Date().toISOString(),
        kind: 'text-llm-profile',
        host: 'connection-manager (ST server)',
        method: 'POST',
        url: `st://cm/${profile?.id || profile?.name || '?'}`,
        durationMs: Math.round(durationMs),
        requestId: correlationId({ __urisDiagnostic: diagnostic }),
        req: {
            profile: { id: profile?.id, name: profile?.name },
            model: profile?.model || profile?.presetName || null,
            messages: (Array.isArray(messages) ? messages : []).map((m) => ({
                role: m?.role,
                content: _shortStr(typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')),
            })),
        },
        resp: {
            // Save top-level service fields + extracted text.
            ok: true,
            extracted: _shortStr(extractTextFromResponse(response), MAX_STR_IN_MESSAGES),
            keys: response && typeof response === 'object' ? Object.keys(response).slice(0, 20) : null,
            body: _snapshotShallow(response),
        },
        error: null,
    };
    await recordNetEntry(entry);
}

/** Record a profile-path Stage1 error. */
export async function recordFromProfileError(profile, messages, err, durationMs, diagnostic = null) {
    const entry = {
        id: _newId(),
        ts: new Date().toISOString(),
        kind: 'text-llm-profile',
        host: 'connection-manager (ST server)',
        method: 'POST',
        url: `st://cm/${profile?.id || profile?.name || '?'}`,
        durationMs: Math.round(durationMs),
        requestId: correlationId({ __urisDiagnostic: diagnostic }),
        req: {
            profile: { id: profile?.id, name: profile?.name },
            model: profile?.model || profile?.presetName || null,
            messages: (Array.isArray(messages) ? messages : []).map((m) => ({
                role: m?.role,
                content: _shortStr(typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')),
            })),
        },
        resp: null,
        error: String(err?.message || err),
        errorInfo: { name: err?.name || 'Error', code: err?.code || null },
    };
    await recordNetEntry(entry);
}

/** Shallow snapshot of top-level response object fields (for dev analysis); no large blobs. */
function _snapshotShallow(obj, depth = 0) {
    if (depth > 3 || obj == null) return obj;
    if (Array.isArray(obj)) return obj.slice(0, 5).map((x) => _snapshotShallow(x, depth + 1));
    if (typeof obj === 'object') {
        const out = {};
        for (const k of Object.keys(obj).slice(0, 15)) {
            const v = obj[k];
            if (typeof v === 'string') {
                out[k] = v.length > MAX_STR_IN_MESSAGES ? _shortStr(v) : v;
            } else if (v != null && typeof v === 'object') {
                out[k] = _snapshotShallow(v, depth + 1);
            } else {
                out[k] = v;
            }
        }
        return out;
    }
    return obj;
}

// ─── Export ───

/**
 * Build the network-evidence payload: metadata + entries array.
 * Auth stripped, base64 collapsed. This is exported independently from the
 * metadata diagnostic file. Wait for fire-and-forget recorder writes first so
 * an export started immediately after a response cannot miss its entry.
 */
export async function buildNetDumpPayload() {
    await waitForRecorders();
    const entries = await _readEntries();
    return {
        meta: {
            exportedAt: new Date().toISOString(),
            count: entries.length,
            version: DUMP_VERSION,
            app: DISPLAY_NAME,
            note: 'Network evidence only. May include bounded prompt/model text previews. Known auth headers are redacted; binary image blobs are collapsed or skipped; model-catalog requests are not recorded; dispatch metadata lives in the diagnostic export keyed by requestId.',
        },
        entries,
    };
}

/** Download the network evidence as a separate file. */
export async function exportNetDump() {
    const exportedAt = new Date().toISOString();
    const payload = await buildNetDumpPayload();
    const json = JSON.stringify(payload);
    // The export act itself belongs to the incident timeline: the journal says
    // when (and with how many entries) the evidence left the browser.
    recordDiagnosticEvent({
        event: 'netdump-export', stage: 'diagnostics', outcome: 'ok',
        details: { count: payload.meta.count, bytes: json.length },
    });
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `uris-network-dump-${exportedAt.replace(/[:.]/g, '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toastr?.success(`Сетевой дамп выгружен: ${payload.meta.count} записей · ${Math.round(json.length / 1024)} КБ`, DISPLAY_NAME);
    return payload;
}