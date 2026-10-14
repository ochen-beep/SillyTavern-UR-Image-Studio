// @ts-check
/**
 * UR Image Studio — network dumper: records transport-level METADATA of
 * image-API and Stage1 text-LLM requests/responses in IndexedDB (via ST
 * localforage) for later export as a separate network-evidence file.
 *
 * Metadata only (dump format v2): scrubbed URLs, method, status, timing,
 * response content-type/length, header NAMES, body kind/size. Request and
 * response BODIES are never written — no prompts, no model text, no upstream
 * error payloads. Upstream failure reasons still reach the user through the
 * error pool and the diagnostic journal (both metadata-sanitized); this dump
 * answers "did the request leave, where, and what came back on the wire",
 * not "what exactly did the model say".
 *
 * Privacy:
 *   - Only header NAMES are stored (values dropped entirely — auth, CSRF
 *     tokens and everything else can not leak through a name).
 *   - URL query credentials (key/token/api_key/…) are replaced with '<redacted>'.
 *   - Body content is never stored: only the byte size and the kind
 *     (json/text/form + form field names and blob types/sizes).
 *   - Not recorded at all: model-catalog requests (/v1/models, /image/models,
 *     /api/models, /images/models), ST-internal routes (/api/secrets, …), the
 *     proxy availability probe (example.com).
 *   - Entries written by dump format v1 (which stored capped bodies) are
 *     purged from storage on first read after the upgrade — an export under
 *     the v2 "metadata only" banner can not carry pre-upgrade bodies.
 *
 * Architecture: non-blocking writes. fetchWithTimeout/proxy are wrapped so that
 * dumper errors NEVER break generation — all recorder functions are called
 * fire-and-forget (caller chains .catch(()=>{})).
 *
 * Storage: SillyTavern.libs.localforage under key LF_NETDUMP (JSON array).
 * Rotation when exceeding MAX_NET_ENTRIES (old entries are discarded).
 */

import { DISPLAY_NAME } from './core.js';
import { recordDiagnosticEvent } from './diagnostic-events.js';

export const LF_NETDUMP = 'uris_netdump';
// ~15 generations of evidence (2–3 entries per generation: paid POST, occasional
// image download, Stage1). Eviction prefers successes: entries with an error are
// the whole point of the dump and outlive the routine 200s.
export const MAX_NET_ENTRIES = 50;
const DUMP_VERSION = 2;

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
        // v1 entries carried capped request/response bodies; drop them so a
        // metadata-only export can never carry pre-upgrade prompt text.
        return (Array.isArray(v) ? v : []).filter((e) => e && e.v === DUMP_VERSION);
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

/**
 * Header metadata: NAMES only, in their original order. Values are dropped
 * entirely — a name can not leak a credential, and the name list still shows
 * what was sent (auth present? content-type?).
 * @returns {string[]|null|undefined}
 */
export function filterHeaders(headers) {
    if (!headers) return headers;
    return Object.keys(headers);
}

/**
 * Request-body metadata: kind and size, never content. FormData contributes
 * field NAMES and blob types/sizes (names are structure, not payload).
 */
export function filterRequestBody(body) {
    if (body == null) return null;
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const fields = [];
        try {
            for (const [k, v] of body.entries()) {
                fields.push(typeof v === 'string'
                    ? { field: k, kind: 'text' }
                    : { field: k, kind: 'blob', type: v.type || null, size: v.size });
            }
        } catch { /* non-critical */ }
        return { _kind: 'form', fields };
    }
    if (typeof body === 'string') {
        let kind = 'text';
        try { const obj = JSON.parse(body); if (obj && typeof obj === 'object') kind = 'json'; } catch { /* not JSON */ }
        return { _kind: kind, _bytes: body.length };
    }
    if (typeof body === 'object') {
        let bytes = null;
        try { bytes = JSON.stringify(body).length; } catch { /* unserializable */ }
        return { _kind: 'json', _bytes: bytes };
    }
    return { _kind: 'other', _bytes: String(body).length };
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
 * Response-body METADATA: kind from the content-type header and the declared
 * size — the body itself is never read for the dump.
 */
function responseMeta(response) {
    let contentType = '';
    try { contentType = response?.headers?.get?.('content-type') || ''; } catch { /* diagnostic only */ }
    let contentLength = null;
    try {
        const raw = response?.headers?.get?.('content-length');
        const n = raw != null && raw !== '' ? Number(raw) : NaN;
        if (Number.isFinite(n)) contentLength = n;
    } catch { /* diagnostic only */ }
    const kind = /json/i.test(contentType) ? 'json'
        : /image\//i.test(contentType) ? 'image'
            : /^text\//i.test(contentType) ? 'text'
                : (contentType ? 'other' : 'unknown');
    return {
        _kind: kind,
        ...(contentType ? { contentType } : {}),
        ...(contentLength != null ? { _bytes: contentLength } : {}),
    };
}

// ─── Entry classification by URL ───

/**
 * Determine request type ('image' | 'text-llm' | 'download' | 'models' | 'other')
 * and skip flag (internal ST routes / probe / model catalogs). Heuristic by URL/path.
 *
 * Catalog ('models') requests are classified but skipped: public data, the
 * largest traffic in the journal, re-fetched on every catalog refresh — and
 * they evicted useful generation evidence from the rotation. Catalog failures
 * still surface through the error pool and the log.
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
    // Naistera the unversioned /api/models, OpenRouter /v1/images/models,
    // Cloudflare Workers AI /ai/models/search.
    if ((/\/v1(?:beta)?\/models(\b|\/|\?|$)/i.test(pathAndQuery)
        || /\/image\/models(\b|\/|\?|$)/i.test(pathAndQuery)
        || /\/api\/models(\b|\/|\?|$)/i.test(pathAndQuery)
        || /\/images\/models(\b|\/|\?|$)/i.test(pathAndQuery)
        || /\/ai\/models\/search(\b|\?|$)/i.test(pathAndQuery))
        && !/:generateContent|:generateImage/i.test(pathAndQuery)) {
        return { skip: true, kind: 'models', url: scrubUrl(url), host };
    }
    if (/\/images\/(generations|edits)/i.test(pathAndQuery)) return { skip: false, kind: 'image', url: scrubUrl(url), host };
    // Cloudflare Workers AI: платный POST /ai/run/<model>.
    if (/\/ai\/run\//i.test(pathAndQuery)) return { skip: false, kind: 'image', url: scrubUrl(url), host };
    // Naistera generation: the paid POST and its read-only job polling GETs.
    if (/\/api\/generate(\/jobs\/[^/?#]+)?(\b|\/|\?|$)/i.test(pathAndQuery)) return { skip: false, kind: 'image', url: scrubUrl(url), host };
    if (/pollinations\.ai/i.test(host)) return { skip: false, kind: 'image', url: scrubUrl(url), host };
    if (/agnes(-ai)?\.|moe-atelier|fuzhan|magicv4|comfyui|a1111|sdwebui/i.test(host)) return { skip: false, kind: 'image', url: scrubUrl(url), host };
    if (/:generateContent/i.test(pathAndQuery)) {
        // Gemini text-LLM and image-LLM share the URL: distinguish by model name.
        // If the path contains "-image" → image-generation; otherwise text-LLM.
        const imageModel = /-image\b|imagen|\bimage\b|flash-image|pro-image|nano[-_. ]?banana/i.test(pathAndQuery);
        return { skip: false, kind: imageModel ? 'image-gemini' : 'text-llm', url: scrubUrl(url), host };
    }
    // Interactions API (Nano Banana 2.1+): модель уходит в теле, в URL только
    // путь. Из этого расширения путь сегодня дёргает только image-адаптер.
    if (/\/v1beta\/interactions/i.test(pathAndQuery)) return { skip: false, kind: 'image-gemini', url: scrubUrl(url), host };
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

// ─── Recorders (used from core.js / text-connection.js) ───

/**
 * Record a successful fetch-response as METADATA. The body is never read or
 * cloned. Does NOT throw.
 */
export async function recordFromFetch(url, options, resp, durationMs) {
    return trackRecorder(async () => {
        const cls = classifyUrl(url);
        if (cls.skip) return;
        const entry = {
            v: DUMP_VERSION,
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
                body: responseMeta(resp),
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
            v: DUMP_VERSION,
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
 * Record a profile-path Stage1 attempt (ConnectionManagerRequestService — ST
 * server route) as METADATA: profile/model identity, message ROLES (not
 * contents), response top-level keys. No prompts, no extracted text.
 */
export async function recordFromProfile(profile, messages, response, durationMs, diagnostic = null) {
    const list = Array.isArray(messages) ? messages : [];
    const entry = {
        v: DUMP_VERSION,
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
            messages: { count: list.length, roles: list.map((m) => m?.role ?? null) },
        },
        resp: {
            ok: true,
            keys: response && typeof response === 'object' ? Object.keys(response).slice(0, 20) : null,
        },
        error: null,
    };
    await recordNetEntry(entry);
}

/** Record a profile-path Stage1 error. */
export async function recordFromProfileError(profile, messages, err, durationMs, diagnostic = null) {
    const list = Array.isArray(messages) ? messages : [];
    const entry = {
        v: DUMP_VERSION,
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
            messages: { count: list.length, roles: list.map((m) => m?.role ?? null) },
        },
        resp: null,
        error: String(err?.message || err),
        errorInfo: { name: err?.name || 'Error', code: err?.code || null },
    };
    await recordNetEntry(entry);
}

// ─── Export ───

/**
 * Build the network-evidence payload: metadata + entries array (v2).
 * No bodies: prompts and model text are never written. Wait for fire-and-forget
 * recorder writes first so an export started immediately after a response
 * cannot miss its entry.
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
            note: 'Metadata only: scrubbed URLs, methods, statuses, timings, response content types, header NAMES, body kinds/sizes. No request or response bodies — prompts and model text are never written. Auth headers and query tokens are redacted; model-catalog and ST-internal requests are not recorded; dispatch details live in the diagnostic export keyed by requestId.',
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
