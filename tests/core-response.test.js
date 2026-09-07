// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readResponseBody, detectImageMime, bytesToDataUrl } from '../src/core.js';
import { makeZstdFrame, makeGzipFrame, installStGlobals } from './_helpers.js';

installStGlobals();

// Tiny fake Response whose only consumed method is arrayBuffer().
function fakeResponse(bytes) {
    return {
        headers: { get: () => '' },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
}

test('readResponseBody: plain UTF-8 JSON → text path, mime null', async () => {
    const payload = JSON.stringify({ ok: true });
    const bytes = new TextEncoder().encode(payload);
    const r = await readResponseBody(fakeResponse(bytes));
    assert.equal(r.mime, null);
    assert.equal(r.text, payload);
    assert.deepEqual(Array.from(r.bytes), Array.from(bytes));
});

test('readResponseBody: PNG magic bytes → image short-circuit, text null', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]);
    const r = await readResponseBody(fakeResponse(bytes));
    assert.equal(r.mime, 'image/png');
    assert.equal(r.text, null);
});

test('readResponseBody: zstd-compressed JSON → decompressed text', async () => {
    const payload = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
    const zstd = makeZstdFrame(payload);
    const r = await readResponseBody(fakeResponse(zstd));
    assert.equal(r.mime, null);
    assert.equal(r.text, payload);
});

test('readResponseBody: gzip-compressed JSON → decompressed text', async () => {
    const payload = JSON.stringify({ choices: [{ message: { content: 'x' } }] });
    const gz = makeGzipFrame(payload);
    const r = await readResponseBody(fakeResponse(gz));
    assert.equal(r.mime, null);
    assert.equal(r.text, payload);
});

test('readResponseBody: corrupt zstd magic → falls through, no throw', async () => {
    // 28 b5 2f fd then garbage — fzstd throws inside; cascade must not propagate.
    const bytes = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x99, 0x99, 0x99, 0x99]);
    const r = await readResponseBody(fakeResponse(bytes));
    assert.equal(r.mime, null);
    // text exists (replacement chars), no throw is the assertion.
    assert.equal(typeof r.text, 'string');
});

test('readResponseBody: zstd wrapping PNG → decompressed image recognized', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 9, 9]);
    const zstd = makeZstdFrame(png);
    const r = await readResponseBody(fakeResponse(zstd));
    assert.equal(r.mime, 'image/png');
    assert.equal(r.text, null);
});

test('detectImageMime: PNG / JPEG / unknown', () => {
    assert.equal(detectImageMime(new Uint8Array([0x89,0x50,0x4E,0x47])), 'image/png');
    assert.equal(detectImageMime(new Uint8Array([0xFF,0xD8,0xFF,0xE0])), 'image/jpeg');
    assert.equal(detectImageMime(new Uint8Array([0x00,0x00,0x00,0x00])), null);
    assert.equal(detectImageMime(null), null);
});
