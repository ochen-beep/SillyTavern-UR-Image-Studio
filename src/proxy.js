// @ts-check
/**
 * SillyTavern CORS proxy: single point for all image-fetch through the ST server.
 *
 * The browser blocks direct fetch() to external image endpoints (cdn.moe-atelier.site,
 * fuzhan.magicv4.ltd, agnes-ai.space, ...). The text path bypasses this through the
 * ST server route, but there is no built-in equivalent for image providers — the
 * generic CORS proxy `POST /proxy/:url` (src/middleware/corsProxy.js in ST core) is used.
 *
 * Proxy behavior:
 *   - forwards JSON bodies (POST/PUT/PATCH) and GET/DELETE methods;
 *   - streams binary responses (PNG/blob) back as-is;
 *   - does not require CSRF token (CSRF check is disabled for /proxy/*);
 *   - does NOT support multipart/form-data (does JSON.stringify(req.body)),
 *     so /v1/images/edits with FormData will not work through the proxy.
 *
 * Requires enableCorsProxy: true in SillyTavern config.yaml (disabled by default).
 * When the flag is off, the ST server responds 404 with body "CORS proxy is disabled...".
 * We detect this and give a friendly error instead of a silent "Failed to fetch".
 */
import { fetchWithTimeout, log, warn } from './core.js';

// Probe result cache (session-scoped, in module memory).
// A POSITIVE result is cached for the session. A definitive negative
// (server answered 404 "CORS proxy is disabled") is cached only briefly:
// the user can enable the proxy and restart ST at any moment, and the
// extension must recover without a page reload. Transient failures
// (timeout / network error) are never cached at all.
const NEGATIVE_TTL_MS = 15000;
let _cache = null; // { value: boolean, at: number } | null

/**
 * Reset probe cache (for tests only — state management between cases).
 */
export function _resetCache() { _cache = null; }

/**
 * URL through which the ST server proxies a request to an external address.
 * @param {string} url — original external URL
 * @returns {string} — "/proxy/<encoded-url>"
 */
export function proxyUrl(url) {
    return `/proxy/${encodeURIComponent(url)}`;
}

/** The built-in proxy accepts JSON-compatible requests, never multipart bodies. */
export function canProxyJsonRequest(options = {}) {
    const body = options.body;
    const tag = body != null ? Object.prototype.toString.call(body) : '';
    if (tag === '[object FormData]') {
        const error = new TypeError('The SillyTavern proxy only accepts JSON requests and cannot proxy multipart bodies.');
        error.code = 'MULTIPART_PROXY_UNSUPPORTED';
        throw error;
    }
    if (body != null && (tag === '[object ReadableStream]' || typeof body.getReader === 'function')) {
        const error = new TypeError('The SillyTavern proxy cannot replay one-shot request bodies. Use a JSON string or another replayable body.');
        error.code = 'NON_REPLAYABLE_BODY';
        throw error;
    }
    return true;
}

/**
 * Returns cached probe result. Does not make a network request.
 * null = not yet checked (or the last failure was transient and uncached).
 * @returns {boolean | null}
 */
export function isCorsProxyAvailable() {
    return _cache?.value ?? null;
}

/**
 * Check CORS proxy availability.
 *
 * Does GET to /proxy/<example.com>. Indicators:
 *   - 404 + body contains "CORS proxy is disabled" → proxy is off
 *     (cached for NEGATIVE_TTL_MS — the user may enable it and restart ST;
 *     the extension recovers without a page reload).
 *   - any other response (even upstream error) → proxy works (cached for
 *     the session).
 *   - timeout/network error → proxy currently unreachable: reported as
 *     false but NOT cached — a transient blip must not poison the session.
 *
 * @param {boolean} [force=false] — reset cache and re-check
 * @returns {Promise<boolean>}
 */
export async function probeCorsProxy(force = false, signal) {
    if (!force && _cache !== null) {
        const fresh = _cache.value || (Date.now() - _cache.at) < NEGATIVE_TTL_MS;
        if (fresh) return _cache.value;
    }

    const probeUrl = proxyUrl('https://example.com');
    try {
        const resp = await fetchWithTimeout(probeUrl, { method: 'GET', signal }, 8000);
        if (resp.status === 404) {
            const t = await resp.text().catch(() => '');
            if (/CORS proxy is disabled/i.test(t)) {
                _cache = { value: false, at: Date.now() };
                warn('cors-proxy: выключен в config.yaml (enableCorsProxy). После включения перезапустите ST — проверка повторится автоматически.');
                return false;
            }
        }
        // Any other status — the proxy responded, so it works.
        // (example.com may return 200/301/anything — doesn't matter, the proxy is alive.)
        _cache = { value: true, at: Date.now() };
        log('cors-proxy: доступен');
        return true;
    } catch (e) {
        if (signal?.aborted || e?.name === 'AbortError') throw e;
        // Transient (timeout / network): report unavailable but keep the cache
        // empty so the next attempt re-probes instead of repeating this verdict.
        warn('cors-proxy: недоступен (временная ошибка, не кэшируется)', e.message);
        return false;
    }
}

/**
 * Execute fetch through the SillyTavern CORS proxy.
 *
 * If the proxy is available, replaces the URL with proxyUrl(url) and calls fetchWithTimeout.
 * If unavailable, throws a clear error with instructions to enable enableCorsProxy.
 *
 * @param {string} url — original external URL
 * @param {RequestInit & { signal?: AbortSignal }} [options]
 * @param {number} [timeoutMs=120000]
 * @returns {Promise<Response>}
 */
export async function proxiedFetch(url, options = {}, timeoutMs = 120000) {
    canProxyJsonRequest(options);
    const available = await probeCorsProxy(false, options.signal);
    if (!available) {
        throw new Error(
            'CORS-прокси SillyTavern недоступен: выключен в config.yaml ' +
            '(enableCorsProxy: true + перезапуск ST) или не отвечает. ' +
            'Включённый прокси подхватится автоматически в течение ~15 секунд — ' +
            'повторите запрос после перезапуска ST.',
        );
    }
    // ST's /proxy/<url> forwards upstream bytes to the browser without
    // auto-decompressing them, and hides the upstream Content-Encoding header,
    // so raw gzip/zstd frames reach JS. We used to pin Accept-Encoding here
    // to keep "brotli" off the wire, but that header is a forbidden fetch
    // header: the browser silently drops it, so it never reached the proxy
    // (evidence: compressed bodies still arrived, fuzhan probe 2026-08-06).
    // Decoding now happens at read time instead — catalog.js
    // (tryGunzipIfMagic) and providers/image-base.js (readJsonResponse)
    // handle gzip/deflate/zstd, zstd falling back to the vendored fzstd
    // polyfill where DecompressionStream('zstd') is unavailable.
    return fetchWithTimeout(proxyUrl(url), options, timeoutMs);
}

// ── autoFetch: hybrid direct→proxy with per-host cache ──

// Delivery strategy cache by host: hostname → 'direct' | 'proxy'.
// 'direct' = server returns CORS headers, direct fetch works (fast, no ST config needed).
// 'proxy'  = server is strict, needs ST proxy.
// Populated automatically on first request to the host; for known hosts,
// subsequent requests go the correct path immediately — without retries.
const _hostStrategy = new Map();

/** Extract hostname from URL (for strategy caching). */
function hostnameOf(url) {
    try { return new URL(url).hostname; }
    catch { return url; } // fallback for non-URL strings
}

/** Whether the error is a CORS/network failure (as opposed to an upstream HTTP response). */
export function isCorsOrNetworkError(e) {
    if (!(e instanceof TypeError)) return false;
    const m = e.message || '';
    if (/Таймаут/.test(m)) return false;
    return /Failed to fetch|Load failed|NetworkError/i.test(m);
}

/**
 * Clear strategy cache for a host (or all). Tests / UI button only.
 * @param {string} [host] — if given, clears only that host; otherwise the whole cache.
 */
export function clearHostStrategy(host) {
    if (host) _hostStrategy.delete(host);
    else _hostStrategy.clear();
}

/** Expose cache for UI (read-only snapshot). */
export function getHostStrategies() {
    return Object.fromEntries(_hostStrategy);
}

/**
 * Automatic fetch: tries direct request, falls back to proxy on CORS block.
 *
 * Strategy is cached by hostname:
 *   - if 'direct' is known for the host — go direct (fast);
 *   - if 'proxy' — go through ST proxy immediately;
 *   - if unknown — try direct first; on CORS/network failure retry through proxy
 *     and remember 'proxy', on success remember 'direct'.
 *
 * IMPORTANT: upstream HTTP errors (400/401/429/500) are NOT grounds for fallback —
 * the server responded, so the delivery path works; the error is valid and propagated as-is.
 *
 * If the proxy is needed but disabled, throws a clear error with instructions.
 *
 * @param {string} url — original external URL
 * @param {RequestInit & { signal?: AbortSignal }} [options]
 * @param {number} [timeoutMs=120000]
 * @returns {Promise<Response>}
 */
export async function autoFetch(url, options = {}, timeoutMs = 120000) {
    const host = hostnameOf(url);
    const strategy = _hostStrategy.get(host);

    if (strategy === 'direct') {
        try { return await fetchWithTimeout(url, options, timeoutMs); }
        catch (e) {
            if (e?.name === 'AbortError' || /Таймаут/.test(e?.message || '') || !isCorsOrNetworkError(e)) throw e;
            _hostStrategy.delete(host);
            const resp = await proxiedFetch(url, options, timeoutMs);
            _hostStrategy.set(host, 'proxy');
            return resp;
        }
    }
    if (strategy === 'proxy') {
        try { return await proxiedFetch(url, options, timeoutMs); }
        catch (e) {
            if (e?.name === 'AbortError' || /Таймаут/.test(e?.message || '')) throw e;
            if (!isCorsOrNetworkError(e) && !/CORS-прокси SillyTavern недоступен/.test(e?.message || '')) throw e;
            _hostStrategy.delete(host);
            const resp = await fetchWithTimeout(url, options, timeoutMs);
            _hostStrategy.set(host, 'direct');
            return resp;
        }
    }
    // User cancellation (AbortError) must NOT switch the strategy.
    try {
        const resp = await fetchWithTimeout(url, options, timeoutMs);
        _hostStrategy.set(host, 'direct');
        return resp;
    } catch (e) {
        // User cancellation / timeout — propagate without changing strategy.
        // (fetchWithTimeout already distinguishes them: AbortError from external signal
        // is thrown as DOMException('Aborted'), timeout as Error('Timeout').)
        if (e?.name === 'AbortError' || /Таймаут/.test(e?.message || '')) throw e;
        // CORS/network failure → retry through proxy.
        if (isCorsOrNetworkError(e)) {
            log('autoFetch: direct fetch failed (likely CORS), retrying through proxy', host, e.message);
            try {
                const resp = await proxiedFetch(url, options, timeoutMs);
                _hostStrategy.set(host, 'proxy');
                return resp;
            } catch (proxyErr) {
                // Proxy unavailable (disabled) — clear error once.
                if (/CORS-прокси SillyTavern недоступен/.test(proxyErr?.message || '')) throw proxyErr;
                // Proxy responded with upstream error — path works, error is valid,
                // but don't cache the strategy (may be a temporary proxy issue).
                throw proxyErr;
            }
        }
        // Other error — propagate as-is, don't change strategy.
        throw e;
    }
}
