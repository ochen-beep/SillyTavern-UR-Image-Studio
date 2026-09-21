// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, deflateSync, zstdCompressSync } from 'node:zlib';

import { __resetZstdProbe } from '../src/core.js';

const catalog = await import('../src/catalog.js');

// catalogRequest(url, apiKey, fetcher, proxiedFetcher, headers, timeoutMs, signal, mode)
// is the live catalog machinery — connect-probe.js layers auth-strategy and
// body-shape detection on top of it. These tests exercise it directly.
const MODELS_URL = 'https://api.example.test/v1/models';
const PROXY_NOT_EXPECTED = async () => { throw new TypeError('proxy must not be called'); };

function catalogFetch(overrides = {}) {
    const {
        url = MODELS_URL, apiKey = '', mode = 'auto', timeoutMs = 120000,
        signal, fetch, proxiedFetch = PROXY_NOT_EXPECTED,
    } = overrides;
    return catalog.catalogRequest(url, apiKey, fetch, proxiedFetch, {}, timeoutMs, signal, mode);
}

test('catalog request aborts a stalled injected fetch at timeout', async () => {
    await assert.rejects(
        catalogFetch({
            timeoutMs: 10,
            fetch: (_url, options) => new Promise((_resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            }),
        }),
        { message: 'Таймаут (0с)' },
    );
});

test('catalog request propagates an external abort from an injected fetch', async () => {
    const controller = new AbortController();
    const pending = catalogFetch({
        signal: controller.signal,
        fetch: (_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }),
    });

    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
});

test('catalog request retries a direct network failure through the proxy with identical GET authentication', async () => {
    const direct = [];
    const proxied = [];
    const payload = await catalogFetch({
        apiKey: 'browser-key',
        fetch: async (url, options) => {
            direct.push([String(url), options]);
            throw new TypeError('Failed to fetch');
        },
        proxiedFetch: async (url, options, timeoutMs) => {
            proxied.push([String(url), options, timeoutMs]);
            return { ok: true, async json() { return { data: [{ id: 'gpt-image-1' }] }; } };
        },
    });

    assert.equal(direct.length, 1);
    assert.equal(proxied.length, 1);
    assert.equal(proxied[0][0], MODELS_URL);
    assert.equal(proxied[0][1].method, 'GET');
    assert.equal(proxied[0][1].headers.Authorization, 'Bearer browser-key');
    assert.equal(proxied[0][2], 120000);
    assert.deepEqual(payload.data.map(model => model.id), ['gpt-image-1']);
});

test('catalog request does not proxy HTTP errors, timeouts, or caller aborts', async () => {
    let proxyCalls = 0;
    const proxiedFetch = async () => { proxyCalls++; };
    await assert.rejects(
        catalogFetch({ proxiedFetch, fetch: async () => ({ ok: false, status: 401 }) }),
        /HTTP 401/,
    );
    await assert.rejects(
        catalogFetch({
            proxiedFetch, timeoutMs: 10,
            fetch: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })),
        }),
        /Таймаут/,
    );
    const controller = new AbortController();
    const pending = catalogFetch({
        proxiedFetch, signal: controller.signal,
        fetch: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })),
    });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(proxyCalls, 0);
});

// ── mode: explicit opt-in/out paths ──

test('mode "direct" never falls back to the proxy on a CORS block, throwing a CATALOG_CORS_BLOCK error', async () => {
    const proxyCalls = [];
    const proxiedFetch = async (...args) => { proxyCalls.push(args); return { ok: true, async json() { return { data: [] }; } }; };
    await assert.rejects(
        catalogFetch({
            apiKey: 'k', mode: 'direct', proxiedFetch,
            fetch: async () => { throw new TypeError('Failed to fetch'); },
        }),
        err => err.code === 'CATALOG_CORS_BLOCK' && /CORS/.test(err.message),
    );
    assert.equal(proxyCalls.length, 0, 'direct mode must not call the proxy');
});

test('mode "proxy" skips the direct fetch entirely and reads through /proxy/ immediately', async () => {
    const directCalls = [];
    const proxyCalls = [];
    await catalogFetch({
        apiKey: 'k', mode: 'proxy',
        fetch: async (...args) => { directCalls.push(args); throw new TypeError('should not be reached'); },
        proxiedFetch: async (...args) => {
            proxyCalls.push(args);
            return { ok: true, async json() { return { data: [{ id: 'gpt-image-1' }] }; } };
        },
    });
    assert.equal(directCalls.length, 0, 'proxy mode must bypass the direct fetch');
    assert.equal(proxyCalls.length, 1);
    assert.equal(String(proxyCalls[0][0]), MODELS_URL);
    assert.equal(proxyCalls[0][1].headers.Authorization, 'Bearer k');
});

// ── non-JSON 2xx body: ST /proxy/ login/404 HTML fallback ──
//
// When enableCorsProxy is misconfigured (or the ST session cookie has expired),
// the /proxy/<url> route can answer 200 OK with an HTML body (its own /login
// redirect or a 404 static fallback). The browser's Response.json() then throws
// an opaque `SyntaxError: Unexpected token < in JSON at position 0`, shown to
// users as "неожиданный токен / невалидный json" with no hint that the problem
// is upstream routing rather than the API key. We wrap it as a
// CATALOG_PARSE_FAILURE with a diagnostic body snippet.

test('request wraps a non-JSON 2xx body as CATALOG_PARSE_FAILURE with the body first line', async () => {
    const htmlBody = '<!doctype html><html><body>Please log in.</body></html>';
    await assert.rejects(
        catalogFetch({
            apiKey: 'k',
            fetch: async () => ({
                ok: true, status: 200,
                headers: { get: () => 'text/html; charset=utf-8' },
                clone() { return this; },
                async json() { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
                async text() { return htmlBody; },
            }),
        }),
        err => err.code === 'CATALOG_PARSE_FAILURE'
            && /HTML page/.test(err.message)
            && /First line:/.test(err.message)
            && err.cause instanceof SyntaxError,
    );
});

test('request wraps an empty 2xx non-JSON body as CATALOG_PARSE_FAILURE', async () => {
    await assert.rejects(
        catalogFetch({
            apiKey: 'k',
            fetch: async () => ({
                ok: true, status: 204,
                headers: { get: () => null },
                clone() { return this; },
                async json() { throw new SyntaxError('Unexpected end of JSON input'); },
                async text() { return ''; },
            }),
        }),
        err => err.code === 'CATALOG_PARSE_FAILURE' && /Body was empty/.test(err.message),
    );
});

// ── gzip-magic 2xx body: ST /proxy/ forwards raw gzip bytes ──
//
// When the ST /proxy/<url> middleware copies upstream `Content-Encoding: gzip`
// and the browser fetch layer sees the same header, double decompression
// gives raw-looking bytes whose JSON parse fails outright; when the proxy
// DROPS the Content-Encoding header but still forwards gzip bytes, the
// browser doesn't decompress at all and we get magic-prefixed binary. Either
// way the real upstream body is JSON underneath — we detect the gzip magic
// (0x1f 0x8b) in a fresh clone and try the Web DecompressionStream before
// giving up.

test('request decompresses a gzip-magic 2xx body via DecompressionStream before parsing JSON', async () => {
    // Real gzip of a valid OpenAI-shaped models list.
    const jsonText = JSON.stringify({ data: [{ id: 'gpt-image-1' }, { id: 'text-only' }] });
    const gz = gzipSync(Buffer.from(jsonText));
    // Convert the Buffer into a Uint8Array body for the mock fetch.
    const bodyBytes = new Uint8Array(gz);
    let arrayBufferCalls = 0;
    const payload = await catalogFetch({
        apiKey: 'k',
        fetch: async () => ({
            ok: true, status: 200,
            headers: { get: () => 'application/json; charset=utf-8' },
            clone() { return this; },
            // Simulate the real-world failure: Response.json() fails because
            // the bytes are still gzip-compressed (proxy header mismatch),
            // and Response.arrayBuffer() returns the raw gzipped bytes.
            async json() { throw new SyntaxError('Unexpected token \u001f\u008b in JSON'); },
            async arrayBuffer() { arrayBufferCalls++; return bodyBytes.buffer; },
            async text() { return new TextDecoder('utf-8', { fatal: false }).decode(bodyBytes); },
        }),
    });
    // The gzip body MUST have been transparently decompressed and parsed.
    assert.equal(arrayBufferCalls, 1, 'arrayBuffer should be read once for gzip detection');
    assert.deepEqual(payload.data.map(m => m.id), ['gpt-image-1', 'text-only']);
});

test('request falls back to PARSE_FAILURE when DecompressionStream is unavailable for a gzip body', async () => {
    // Save and remove DecompressionStream, simulating an older browser
    // without the Compression Streams API.
    const saved = globalThis.DecompressionStream;
    delete globalThis.DecompressionStream;
    try {
        const gz = gzipSync(Buffer.from(JSON.stringify({ data: [{ id: 'gpt-image-1' }] })));
        const bodyBytes = new Uint8Array(gz);
        await assert.rejects(
            catalogFetch({
                apiKey: 'k',
                fetch: async () => ({
                    ok: true, status: 200,
                    headers: { get: () => 'application/json; charset=utf-8' },
                    clone() { return this; },
                    async json() { throw new SyntaxError('Unexpected token \u001f\u008b in JSON'); },
                    async arrayBuffer() { return bodyBytes.buffer; },
                    async text() { return new TextDecoder('utf-8', { fatal: false }).decode(bodyBytes); },
                }),
            }),
            err => err.code === 'CATALOG_PARSE_FAILURE'
                && err.cause instanceof SyntaxError,
        );
    } finally {
        if (saved !== undefined) globalThis.DecompressionStream = saved;
    }
});

// `deflate` (RFC 1950, zlib), supported natively by Node's DecompressionStream
// — covers the third codec we sniff for in catalog recovery.

test('request decompresses a deflate-magic 2xx body via DecompressionStream before parsing JSON', async () => {
    const jsonText = JSON.stringify({ data: [{ id: 'gpt-image-1' }, { id: 'text-only' }] });
    const deflated = deflateSync(Buffer.from(jsonText));
    const bodyBytes = new Uint8Array(deflated);
    const payload = await catalogFetch({
        apiKey: 'k',
        fetch: async () => ({
            ok: true, status: 200,
            headers: { get: () => 'application/json; charset=utf-8' },
            clone() { return this; },
            async json() { throw new SyntaxError('Unexpected token x in JSON at position 0'); },
            async arrayBuffer() { return bodyBytes.buffer; },
            async text() { return new TextDecoder('utf-8', { fatal: false }).decode(bodyBytes); },
        }),
    });
    assert.deepEqual(payload.data.map(m => m.id), ['gpt-image-1', 'text-only']);
});

// zstd: fuzhan.magicv4.ltd serves catalog responses as zstd frames (magic
// 28 b5 2f fd, RFC 8878) with the Content-Encoding header hidden by ST's
// /proxy/, so raw zstd bytes reach the extension (runbook 2026-07-11,
// console logs 2026-08-06). Both decode legs must recover them:
// (a) native DecompressionStream('zstd') — stubbed, since Node's
//     DecompressionStream ships no zstd codec;
// (b) the vendored fzstd polyfill — exercised end-to-end with real zstd
//     bytes from node:zlib.zstdCompressSync, no stubs.

function makeZstdStub(decodedBytes) {
    return class DecompressionStreamStub {
        constructor(codec) {
            // Rejecting other codecs synchronously mirrors what real runtimes
            // do for unsupported codecs and lets the recovery loop skip
            // gzip/deflate cleanly.
            if (codec !== 'zstd') throw new TypeError(`unsupported codec ${codec} (stub injects 'zstd' only)`);
            this.codec = codec;
            this.writable = new WritableStream({ write() { /* swallowing pipe-in is fine */ } });
            this.readable = new ReadableStream({
                start(controller) {
                    controller.enqueue(decodedBytes);
                    controller.close();
                },
            });
        }
    };
}

test('request decompresses a zstd-magic catalog body via native DecompressionStream("zstd")', async () => {
    const jsonText = JSON.stringify({ data: [{ id: 'gpt-image-1' }, { id: 'text-only' }] });
    const decodedBytes = new TextEncoder().encode(jsonText);
    // Raw head bytes the upstream actually serves: zstd frame magic followed
    // by compressed payload. Only the head matters for sniffing; the stub
    // stands in for Chrome's real DS('zstd') pipe and emits the decoded JSON.
    const onWire = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58, 0xd4, 0x0b]);
    const saved = globalThis.DecompressionStream;
    globalThis.DecompressionStream = makeZstdStub(decodedBytes);
    __resetZstdProbe();
    try {
        const payload = await catalogFetch({
            apiKey: 'k',
            fetch: async () => ({
                ok: true, status: 200,
                headers: { get: () => 'application/json; charset=utf-8' },
                clone() { return this; },
                async json() { throw new SyntaxError('Unexpected token \u0028 in JSON'); },
                async arrayBuffer() { return onWire.buffer; },
                async text() { return new TextDecoder('utf-8', { fatal: false }).decode(onWire); },
            }),
        });
        assert.deepEqual(payload.data.map(m => m.id), ['gpt-image-1', 'text-only']);
    } finally {
        if (saved !== undefined) globalThis.DecompressionStream = saved;
        __resetZstdProbe();
    }
});

test('request decompresses a real zstd catalog body via the fzstd polyfill', async () => {
    // Genuine zstd frame from node:zlib — the exact byte shape fuzhan's
    // proxy serves. Node's DecompressionStream rejects the 'zstd' codec, so
    // the native probe fails and the vendored fzstd polyfill must decode the
    // real bytes end-to-end.
    const jsonText = JSON.stringify({ data: [{ id: 'gpt-image-1' }] });
    const onWire = new Uint8Array(zstdCompressSync(Buffer.from(jsonText)));
    __resetZstdProbe();
    try {
        const payload = await catalogFetch({
            apiKey: 'k',
            fetch: async () => ({
                ok: true, status: 200,
                headers: { get: () => 'application/json; charset=utf-8' },
                clone() { return this; },
                async json() { throw new SyntaxError('Unexpected token \u0028 in JSON'); },
                async arrayBuffer() { return onWire.buffer; },
                async text() { return new TextDecoder('utf-8', { fatal: false }).decode(onWire); },
            }),
        });
        assert.deepEqual(payload.data.map(m => m.id), ['gpt-image-1']);
    } finally {
        __resetZstdProbe();
    }
});
