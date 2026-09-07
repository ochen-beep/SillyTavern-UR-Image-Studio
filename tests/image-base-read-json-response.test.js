// @ts-check
//
// readJsonResponse (src/providers/image-base.js) is the single body-reading
// chokepoint for every image provider — OpenAI/Gemini/OpenRouter/Chat
// Completions. When the ST /proxy/ forwards upstream bytes raw (drop of the
// upstream `Content-Encoding` header) or stale (header survived a node-fetch
// auto-decompress that the proxy then re-emits compressed), the
// `Response.json()` call throws and the user used to see a generic
// "Chat Completions returned malformed JSON" error. The compression-recovery
// path (gzip/deflate/zstd, magic + opportunistic) was added so a real
// 200-OK answerable body is parsed even when ST's middleware mangles the
// `Content-Encoding` header. This suite proves all three codecs recover.
//
// zstd is the format ST's proxy actually serves (fuzhan.magicv4.ltd,
// runbook 2026-07-11, console logs 2026-08-06). Both decode legs are tested:
// native DecompressionStream('zstd') via a stub (Node ships no zstd codec),
// and the vendored fzstd polyfill via real zstd bytes from
// node:zlib.zstdCompressSync.

import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, deflateSync, zstdCompressSync } from 'node:zlib';

import { readJsonResponse, ImageProviderError } from '../src/providers/image-base.js';
import { __resetZstdProbe } from '../src/core.js';

function makeResponse({ jsonThrows, body }) {
    return {
        status: 200,
        async json() {
            if (jsonThrows) throw new SyntaxError('Unexpected token in JSON');
            // Production code calls json() before any recovery; if json()
            // succeeds we never reach the clone. For tests where json() is
            // expected to fail we satisfy the contract by throwing.
            return JSON.parse(new TextDecoder().decode(body));
        },
        clone() { return this; },
        async arrayBuffer() { return body.buffer; },
        async text() { return new TextDecoder('utf-8', { fatal: false }).decode(body); },
    };
}

test('readJsonResponse returns parsed JSON for a clean (uncompressed) 2xx body', async () => {
    const payload = JSON.stringify({ data: [{ id: 'gpt-image-1' }] });
    const body = new TextEncoder().encode(payload);
    const resp = makeResponse({ jsonThrows: false, body });
    const out = await readJsonResponse(resp, 'OpenAI');
    assert.deepEqual(out, { data: [{ id: 'gpt-image-1' }] });
});

test('readJsonResponse surfaces HTTP errors with upstream detail', async () => {
    const resp = {
        status: 401,
        async json() { return { error: { message: 'Invalid token X' } }; },
    };
    await assert.rejects(
        readJsonResponse(resp, 'OpenAI'),
        err => err instanceof ImageProviderError
            && /HTTP 401/.test(err.message)
            && /Invalid token X/.test(err.message),
    );
});

test('readJsonResponse clones before a disturbed response body can reject clone()', async () => {
    const body = new TextEncoder().encode('{"data":[]}');
    let bodyUsed = false;
    let cloneCalls = 0;
    const response = {
        status: 200,
        clone() {
            cloneCalls += 1;
            if (bodyUsed) throw new TypeError("Failed to execute 'clone' on 'Response': Response body is already used");
            return {
                async arrayBuffer() { return body.slice().buffer; },
                async text() { return new TextDecoder().decode(body); },
            };
        },
        async json() {
            bodyUsed = true;
            throw new SyntaxError('Unexpected token in JSON');
        },
    };

    const out = await readJsonResponse(response, 'OpenAI');
    assert.deepEqual(out, { data: [] });
    assert.equal(cloneCalls, 1);
});

test('readJsonResponse recovers a gzip-compressed 2xx body via DecompressionStream', async () => {
    const payload = JSON.stringify({ data: [{ id: 'gpt-image-1' }] });
    const compressed = gzipSync(Buffer.from(payload));
    const body = new Uint8Array(compressed);
    const resp = makeResponse({ jsonThrows: true, body });
    const out = await readJsonResponse(resp, 'OpenAI');
    assert.deepEqual(out, { data: [{ id: 'gpt-image-1' }] });
});

test('readJsonResponse recovers a deflate-compressed 2xx body via DecompressionStream', async () => {
    const payload = JSON.stringify({ choices: [{ message: { images: [{ url: 'https://x.test/i.png' }] } }] });
    const compressed = deflateSync(Buffer.from(payload));
    const body = new Uint8Array(compressed);
    const resp = makeResponse({ jsonThrows: true, body });
    const out = await readJsonResponse(resp, 'Chat Completions');
    assert.equal(out.choices?.[0]?.message?.images?.[0]?.url, 'https://x.test/i.png');
});

test('readJsonResponse recovers a zstd body (magic 28 b5 2f fd) via native DecompressionStream("zstd")', async () => {
    const jsonText = JSON.stringify({ choices: [{ message: { images: [{ b64_json: 'aGk=' }] } }] });
    const decodedBytes = new TextEncoder().encode(jsonText);
    // The on-wire head bytes the ST /proxy/ actually serves (fuzhan probe,
    // runbook 2026-07-11): zstd frame magic followed by compressed payload.
    // Only the head matters for sniffing; the stub stands in for Chrome's
    // real DecompressionStream('zstd') and emits the decoded JSON the way
    // the native pipe would. Node ships no zstd codec, hence the stub.
    const onWire = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58, 0xd4, 0x0b]);
    const saved = globalThis.DecompressionStream;
    globalThis.DecompressionStream = makeCodecStub(decodedBytes, 'zstd');
    __resetZstdProbe();
    try {
        const resp = {
            status: 200,
            async json() { throw new SyntaxError('Unexpected token \u0028 in JSON at position 0'); },
            clone() { return this; },
            async arrayBuffer() { return onWire.buffer; },
            async text() { return new TextDecoder('utf-8', { fatal: false }).decode(onWire); },
        };
        const out = await readJsonResponse(resp, 'Chat Completions');
        assert.equal(out.choices[0].message.images[0].b64_json, 'aGk=');
    } finally {
        if (saved !== undefined) globalThis.DecompressionStream = saved;
        __resetZstdProbe();
    }
});

test('readJsonResponse recovers a real zstd body via the fzstd polyfill when no native codec exists', async () => {
    // Genuine zstd frame from node:zlib — the exact byte shape fuzhan's
    // proxy serves. Node's DecompressionStream rejects the 'zstd' codec,
    // so tryNativeZstd's probe fails and the vendored fzstd polyfill must
    // decode the real bytes end-to-end (no stubs on this path).
    const jsonText = JSON.stringify({ choices: [{ message: { images: [{ b64_json: 'd29ybGQ=' }] } }] });
    const body = new Uint8Array(zstdCompressSync(Buffer.from(jsonText)));
    __resetZstdProbe();
    try {
        const resp = {
            status: 200,
            async json() { throw new SyntaxError('Unexpected token \u0028 in JSON at position 0'); },
            clone() { return this; },
            async arrayBuffer() { return body.buffer; },
            async text() { return new TextDecoder('utf-8', { fatal: false }).decode(body); },
        };
        const out = await readJsonResponse(resp, 'Chat Completions');
        assert.equal(out.choices[0].message.images[0].b64_json, 'd29ybGQ=');
    } finally {
        __resetZstdProbe();
    }
});

test('readJsonResponse throws UPSTREAM_RESPONSE_INVALID when no codec can decode the body', async () => {
    // Body that is genuinely not JSON AND no compression matches (HTML login
    // page from the ST /proxy/ middleware). We deliberately leave
    // DecompressionStream in place; the magic sniffer finds no match and the
    // opportunistic path quickly fails each codec.
    const html = new TextEncoder().encode('<!doctype html><html><body>login</body></html>');
    const resp = {
        status: 200,
        async json() { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
        clone() { return this; },
        async arrayBuffer() { return html.buffer; },
        async text() { return new TextDecoder().decode(html); },
    };
    await assert.rejects(
        readJsonResponse(resp, 'OpenAI'),
        err => err instanceof ImageProviderError
            && err.code === 'UPSTREAM_RESPONSE_INVALID'
            && /malformed JSON/.test(err.message),
    );
});

test('readJsonResponse opportunistic-fallback rescues a body whose head matches no compression magic', async () => {
    const jsonText = JSON.stringify({ choices: [{ message: { images: [{ b64_json: 'b3Bw' }] } }] });
    const decodedBytes = new TextEncoder().encode(jsonText);
    // Meaningless head bytes — no gzip/zstd/deflate magic, so Phase 1 skips
    // entirely. Phase 2 must then try every codec and accept the first
    // successful decode (gzip here, standing in for deflate-raw-style
    // streams whose heads the sniffer cannot recognize).
    const onWire = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);
    const saved = globalThis.DecompressionStream;
    globalThis.DecompressionStream = makeCodecStub(decodedBytes, 'gzip');
    __resetZstdProbe();
    try {
        const resp = {
            status: 200,
            async json() { throw new SyntaxError('Unexpected token \u0000 in JSON at position 0'); },
            clone() { return this; },
            async arrayBuffer() { return onWire.buffer; },
            async text() { return new TextDecoder('utf-8', { fatal: false }).decode(onWire); },
        };
        const out = await readJsonResponse(resp, 'Chat Completions');
        assert.equal(out.choices[0].message.images[0].b64_json, 'b3Bw');
    } finally {
        if (saved !== undefined) globalThis.DecompressionStream = saved;
        __resetZstdProbe();
    }
});

// Minimal TransformStream-shaped DecompressionStream stand-in: accepts a
// single codec (rejecting others synchronously, like real browsers/Node do)
// and emits the pre-decoded bytes on its readable side.
function makeCodecStub(decodedBytes, codecAccepted) {
    return class DecompressionStreamStub {
        constructor(codec) {
            if (codec !== codecAccepted) throw new TypeError(`unsupported codec ${codec} (stub injects '${codecAccepted}' only)`);
            this.codec = codec;
            this.writable = new WritableStream({ write() { /* swallow pipe-in */ } });
            this.readable = new ReadableStream({
                start(controller) {
                    controller.enqueue(decodedBytes);
                    controller.close();
                },
            });
        }
    };
}