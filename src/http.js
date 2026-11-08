// @ts-check
/**
 * HTTP transport layer: deadline-guarded fetch (paid requests must never hang
 * past their budget — including body reads) and proxy-safe response body
 * reading (hidden Content-Encoding, missing Content-Type, zstd/gzip).
 *
 * Cycle note (same as core.js carried before the extraction): netdump imports
 * DISPLAY_NAME from core.js, and this module imports netdump — core → http →
 * netdump → core. Safe because DISPLAY_NAME is referenced only at runtime
 * (inside netdump functions), never at module load time.
 */
import { recordFromFetch, recordFromFetchError } from './netdump.js';
import { tunnelBypassHeaders } from './tunnel-bypass.js';
import { unrefTimer } from './timers.js';

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
    // code:'FETCH_TIMEOUT' — типизированный маркер: раньше матчеры искали
    // слово «Таймаут» в сообщении и не узнавали этот английский sentinel,
    // из-за чего таймаут платного image-запроса выпадал из журнала доставки
    // (dispatch-error) и попадал в «неизвестную сетевую ошибку».
    const timeoutError = () => {
        const error = new Error(`Timeout (${Math.round(timeoutMs / 1000)}s)`);
        error.code = 'FETCH_TIMEOUT';
        return error;
    };
    timer = unrefTimer(setTimeout(() => {
        timedOut = true;
        ctrl.abort();
        rejectDeadline(timeoutError());
    }, Math.max(0, deadlineAt - Date.now())));
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
    // Tunnel consent-page bypass (loca.lt 511 / ngrok ERR_NGROK_6024): inject
    // the documented opt-out header for tunnel hosts only — a custom header
    // turns the fetch into a preflighted one, which must stay a tunnel-only
    // concern. User-supplied headers win (see tunnel-bypass.js).
    const bypass = tunnelBypassHeaders(url);
    const headers = Object.keys(bypass).length
        ? { ...bypass, ...requestOptions.headers }
        : requestOptions.headers;
    try {
        const resp = await fetch(url, { ...requestOptions, headers, signal: ctrl.signal });
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
/**
 * Hard deadline for requests that bypass fetchWithTimeout (the Stage 1 profile
 * path runs through the ST server, which has no deadline of its own). The run
 * receives its own AbortSignal that fires at expiry, and the deadline surfaces
 * the SAME error shape fetchWithTimeout produces — a plain Error('Timeout (Ns)')
 * — so callers classify timeout vs user-abort uniformly (an AbortError means
 * the external signal fired; a Timeout error means the deadline did).
 * @template T
 * @param {number} timeoutMs
 * @param {AbortSignal|null} signal external cancellation, wins over the deadline
 * @param {(signal: AbortSignal) => Promise<T>} run
 * @returns {Promise<T>}
 */
export function withDeadline(timeoutMs, signal, run) {
    const controller = new AbortController();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    let timedOut = false;
    const timeoutError = () => {
        const limit = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
        const error = new Error(`Timeout (${limit})`);
        error.code = 'FETCH_TIMEOUT';
        return error;
    };
    let rejectDeadline;
    const deadlinePromise = new Promise((_, reject) => { rejectDeadline = reject; });
    // Не ронять процесс необработанным rejection, когда run успел раньше.
    deadlinePromise.catch(() => {});
    const timer = unrefTimer(setTimeout(() => {
        timedOut = true;
        controller.abort();
        rejectDeadline(timeoutError());
    }, Math.max(0, Number(timeoutMs) || 0)));
    const work = Promise.resolve().then(() => run(controller.signal)).catch((e) => {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (timedOut && e?.name === 'AbortError') throw timeoutError();
        throw e;
    });
    // Дедлайн может обогнать отказ самого run-а — держим его rejection обработанным.
    work.catch(() => {});
    return Promise.race([work, deadlinePromise]).finally(() => clearTimeout(timer));
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
    // Полифилл грузится только здесь: браузер без DecompressionStream('zstd')
    // и только на ответе, который действительно сжат. На старте расширения
    // эти байты не парсятся.
    try {
        const { decompress } = await import('./vendor/fzstd.esm.js');
        return decompress(bytes);
    } catch { return null; }
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
