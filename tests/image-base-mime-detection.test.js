// @ts-check
//
// imageResultFromValue (src/providers/image-base.js) normalises the image
// payload returned by every provider into a uniform { kind, value, mimeType }
// result. When the provider returns raw base64 (b64_json) without declaring a
// content_type, the function used to hardcode 'image/png' - mislabeling JPEG
// output from Imagen proxies, WebP from some OpenRouter models, etc. The fix
// sniffs the actual format from decoded magic bytes (PNG/JPEG/WebP/GIF) when
// no explicit MIME is supplied by the caller. Explicit MIME from the provider
// (Gemini inlineData.mimeType, OpenRouter media_type) still wins.

import test from 'node:test';
import assert from 'node:assert/strict';

import { imageResultFromValue, detectImageMimeFromBase64 } from '../src/providers/image-base.js';

// Real magic-byte prefixes for each format, base64-encoded. Extra bytes after
// the magic simulate a realistic (truncated) image payload.
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).toString('base64');
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');
const WEBP_B64 = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x1c, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]).toString('base64');
const GIF_B64 = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]).toString('base64');
// "result" - no image magic (verifies fallback to image/png).
const PLAIN_B64 = Buffer.from('result').toString('base64');

// ── detectImageMimeFromBase64 ──

test('detectImageMimeFromBase64 identifies PNG magic bytes', () => {
    assert.equal(detectImageMimeFromBase64(PNG_B64), 'image/png');
});

test('detectImageMimeFromBase64 identifies JPEG magic bytes', () => {
    assert.equal(detectImageMimeFromBase64(JPEG_B64), 'image/jpeg');
});

test('detectImageMimeFromBase64 identifies WebP magic bytes', () => {
    assert.equal(detectImageMimeFromBase64(WEBP_B64), 'image/webp');
});

test('detectImageMimeFromBase64 identifies GIF magic bytes', () => {
    assert.equal(detectImageMimeFromBase64(GIF_B64), 'image/gif');
});

test('detectImageMimeFromBase64 returns null for non-image data', () => {
    assert.equal(detectImageMimeFromBase64(PLAIN_B64), null);
});

test('detectImageMimeFromBase64 returns null for short or invalid input', () => {
    assert.equal(detectImageMimeFromBase64('abc'), null);
    assert.equal(detectImageMimeFromBase64(''), null);
    assert.equal(detectImageMimeFromBase64(null), null);
    assert.equal(detectImageMimeFromBase64(undefined), null);
});

// ── imageResultFromValue: sniffing when no explicit MIME ──

test('imageResultFromValue sniffs JPEG when no MIME is supplied', () => {
    const result = imageResultFromValue(JPEG_B64);
    assert.equal(result.kind, 'dataUrl');
    assert.equal(result.mimeType, 'image/jpeg');
    assert.equal(result.value, `data:image/jpeg;base64,${JPEG_B64}`);
    assert.deepEqual(result.warnings, []);
});

test('imageResultFromValue sniffs PNG when no MIME is supplied', () => {
    const result = imageResultFromValue(PNG_B64);
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.value, `data:image/png;base64,${PNG_B64}`);
});

test('imageResultFromValue sniffs WebP when no MIME is supplied', () => {
    const result = imageResultFromValue(WEBP_B64);
    assert.equal(result.mimeType, 'image/webp');
    assert.equal(result.value, `data:image/webp;base64,${WEBP_B64}`);
});

test('imageResultFromValue sniffs GIF when no MIME is supplied', () => {
    const result = imageResultFromValue(GIF_B64);
    assert.equal(result.mimeType, 'image/gif');
    assert.equal(result.value, `data:image/gif;base64,${GIF_B64}`);
});

test('imageResultFromValue falls back to image/png for unknown formats', () => {
    // "result" has no image magic - preserve backwards-compatible default.
    const result = imageResultFromValue(PLAIN_B64);
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.value, `data:image/png;base64,${PLAIN_B64}`);
});

// ── imageResultFromValue: explicit MIME precedence ──

test('imageResultFromValue: explicit MIME wins over sniffed format', () => {
    // JPEG bytes but caller declares image/webp -> explicit wins.
    const result = imageResultFromValue(JPEG_B64, 'image/webp');
    assert.equal(result.mimeType, 'image/webp');
    assert.equal(result.value, `data:image/webp;base64,${JPEG_B64}`);
});

test('imageResultFromValue: null MIME triggers sniffing', () => {
    const result = imageResultFromValue(JPEG_B64, null);
    assert.equal(result.mimeType, 'image/jpeg');
});

test('imageResultFromValue: non-image MIME string triggers sniffing', () => {
    // "text/plain" does not start with "image/" so it is not authoritative;
    // the sniffer detects JPEG from the bytes instead.
    const result = imageResultFromValue(JPEG_B64, 'text/plain');
    assert.equal(result.mimeType, 'image/jpeg');
});

// ── imageResultFromValue: unchanged branches ──

test('imageResultFromValue: data URL preserves its declared MIME', () => {
    const result = imageResultFromValue('data:image/webp;base64,d2VicA==');
    assert.equal(result.kind, 'dataUrl');
    assert.equal(result.mimeType, 'image/webp');
});

test('imageResultFromValue: HTTP URL yields null MIME', () => {
    const result = imageResultFromValue('https://cdn.example/image.jpeg');
    assert.equal(result.kind, 'url');
    assert.equal(result.mimeType, null);
});
