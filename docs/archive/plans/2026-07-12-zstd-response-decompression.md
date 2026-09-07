# Zstd Response Decompression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every provider robust against zstd/gzip-compressed response bodies that the SillyTavern CORS proxy forwards without `Content-Encoding`, by adding one shared `readResponseBody` cascade in `src/core.js` backed by a vendored `fzstd` polyfill.

**Architecture:** Single response-body reader (`readResponseBody`) in `src/core.js` does: one `arrayBuffer()` → magic-byte detect (image / zstd / gzip) → decompress if needed → return `{bytes, text, mime}`. All 6 provider files + `image-download.js` migrate from their ad-hoc `resp.blob()/json()/text()` blocks to this one call. `fzstd` is vendored as a single 8.5 KB ESM file at `src/vendor/fzstd.esm.js` (no bundler, no WASM, matches the project's flat-ESM model).

**Tech Stack:** Plain ESM JavaScript, `node:test` + `node:assert/strict` for tests, `fzstd@0.1.1` (MIT, pure JS), browser `DecompressionStream('gzip')` (standard) + feature-detected `DecompressionStream('zstd')` (non-standard, falls back to fzstd).

**Spec:** `docs/superpowers/specs/2026-07-12-zstd-response-decompression-design.md`

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/vendor/fzstd.esm.js` | Create | Vendored fzstd 0.1.1 single-file ESM build. Do not hand-edit. |
| `src/core.js` | Modify | Add `detectImageMime`, `bytesToDataUrl`, `readResponseBody`, and internal `tryGunzip`/`tryUnzstd`/native-zstd detect. |
| `src/providers/gemini.js` | Modify | Migrate image + text response reads to `readResponseBody`; delete local `detectImageMime`/`tryGunzip`/bytes-to-dataUrl. |
| `src/providers/openai.js` | Modify | Migrate 4 response-read sites (text, edits, multimodal, generations) to `readResponseBody`. |
| `src/providers/agnes.js` | Modify | Migrate response read to `readResponseBody`. |
| `src/providers/pollinations.js` | Modify | Migrate `resp.blob()` read to `readResponseBody`. |
| `src/image-download.js` | Modify | Migrate `resp.blob()` read to `readResponseBody`. |
| `tests/_helpers.js` | Modify | Add `makeZstdFrame(jsonString)` helper (compresses via Node `zlib` when available) and a `mockResponse` factory. |
| `tests/providers.test.js` | Modify | Add regression tests: zstd JSON, zstd image, corrupt zstd, per-provider. |

---

## Task 1: Vendor `fzstd`

**Files:**
- Create: `src/vendor/fzstd.esm.js`

- [ ] **Step 1: Fetch the ESM build into the vendor path**

Run from the repo root:

```bash
curl -sL --max-time 30 "https://cdn.jsdelivr.net/npm/fzstd@0.1.1/+esm" -o src/vendor/fzstd.esm.js --create-dirs
```

Expected: file created, ~8 573 bytes.

- [ ] **Step 2: Prepend a provenance header**

Open `src/vendor/fzstd.esm.js` and add this comment block **as the very first lines**, before the existing `Bundled by jsDelivr …` comment:

```js
// @ts-check
//
// VENDORED — do not hand-edit.
// Source:    https://cdn.jsdelivr.net/npm/fzstd@0.1.1/+esm
// Package:   fzstd@0.1.1  (https://github.com/101arrowz/fzstd)
// License:   MIT
// Exports:   { decompress, Decompress, ZstdErrorCode }
// Used by:   src/core.js (zstd response-body decompression)
// spec:      docs/superpowers/specs/2026-07-12-zstd-response-decompression-design.md §5
```

- [ ] **Step 3: Verify the file is self-contained**

Run:

```bash
grep -c "^import\| from ['\"]" src/vendor/fzstd.esm.js
```

Expected output: `0` (no internal imports). Also confirm the export line:

```bash
grep -o "export{[^}]*}" src/vendor/fzstd.esm.js
```

Expected: `export{Mr as Decompress,pr as ZstdErrorCode,xr as decompress};`

- [ ] **Step 4: Verify it round-trips a real zstd frame**

Run:

```bash
node --input-type=module -e "
import { decompress } from './src/vendor/fzstd.esm.js';
import zlib from 'node:zlib';
const payload = JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] } }] });
const compressed = zlib.zstdCompressSync(Buffer.from(payload));
const head = Array.from(compressed.slice(0,4)).map(b=>b.toString(16).padStart(2,'0')).join(' ');
console.log('magic:', head);
const out = decompress(new Uint8Array(compressed));
console.log('round-trip:', new TextDecoder().decode(out) === payload);
"
```

Expected:
```
magic: 28 b5 2f fd
round-trip: true
```

- [ ] **Step 5: Commit**

```bash
git add src/vendor/fzstd.esm.js
git commit -m "vendor: add fzstd@0.1.1 ESM for zstd response decompression"
```

---

## Task 2: Add test helpers for compressed fixtures

**Files:**
- Modify: `tests/_helpers.js`

- [ ] **Step 1: Read the current `_helpers.js` end**

Run:

```bash
tail -30 tests/_helpers.js
```

Confirm the file ends after `installStGlobals` and `MockFileReader`. Note the last line number.

- [ ] **Step 2: Append the `makeZstdFrame` and `makeGzipFrame` helpers**

Add to the end of `tests/_helpers.js`:

```js
// ── Compressed-fixture helpers (for readResponseBody / provider tests) ──

/**
 * Сжать строку в zstd-фрейм. Требует Node ≥ 22 (zlib.zstdCompressSync).
 * @param {string} text
 * @returns {Uint8Array}
 */
export function makeZstdFrame(text) {
    const zlib = require('node:zlib');
    const buf = zlib.zstdCompressSync(Buffer.from(text, 'utf-8'));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Сжать строку в gzip-фрейм через Node zlib.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function makeGzipFrame(text) {
    const zlib = require('node:zlib');
    const buf = zlib.gzipSync(Buffer.from(text, 'utf-8'));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
```

> Note: `tests/_helpers.js` uses `import` at the top. We use lazy `require('node:zlib')` inside the function so the existing ESM file keeps working without adding a top-level import that runs even in tests that don't need it.

- [ ] **Step 3: Smoke-test the helpers in isolation**

Run:

```bash
node --input-type=module -e "
import { makeZstdFrame, makeGzipFrame } from './tests/_helpers.js';
const z = makeZstdFrame('hello zstd');
console.log('zstd magic:', Array.from(z.slice(0,4)).map(b=>b.toString(16).padStart(2,'0')).join(' '));
const g = makeGzipFrame('hello gzip');
console.log('gzip magic:', Array.from(g.slice(0,2)).map(b=>b.toString(16).padStart(2,'0')).join(' '));
"
```

Expected:
```
zstd magic: 28 b5 2f fd
gzip magic: 1f 8b
```

- [ ] **Step 4: Commit**

```bash
git add tests/_helpers.js
git commit -m "test: add makeZstdFrame/makeGzipFrame fixture helpers"
```

---

## Task 3: Implement `readResponseBody` + helpers (TDD)

**Files:**
- Create: `tests/core-response.test.js`
- Modify: `src/core.js` (add functions near the existing utils, after `extractTextFromResponse` ~line 339)

- [ ] **Step 1: Write the failing tests**

Create `tests/core-response.test.js`:

```js
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
    const zstd = makeZstdFrame(String.fromCharCode(...png));
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test tests/core-response.test.js
```

Expected: import error — `readResponseBody`, `detectImageMime`, `bytesToDataUrl` are not exported from `../src/core.js`. All tests fail at module load.

- [ ] **Step 3: Add the implementation to `src/core.js`**

In `src/core.js`, add a top-level import near the existing imports at the very top (after the `// @ts-check` / module header, before the `export const MODULE_NAME` line). Since `core.js` currently has no imports, add:

```js
import { decompress as fzstdDecompress } from './vendor/fzstd.esm.js';
```

Then append the following block at the end of `src/core.js` (after `showInputModal`):

```js

// ── Response body reading (proxy-safe: hidden Content-Encoding, missing Content-Type) ──
// spec: docs/superpowers/specs/2026-07-12-zstd-response-decompression-design.md §3, §4

/**
 * ASCII-слайс байтов — нужен для AVIF/HEIC/JXL magic-byte проверок.
 */
function bytesToAscii(bytes, start, len) {
    return Array.from(bytes.slice(start, start + len)).map(b => String.fromCharCode(b)).join('');
}

/**
 * Определить MIME-тип изображения по магическим байтам.
 * Нужно, когда прокси ST скрыл content-type или вернул пустой.
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
 * Байты → dataUrl через FileReader. Используется всеми image-провайдерами.
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
 * Безопасно прочитать тело ответа провайдера с учётом скрытого прокси-сжатия
 * и отсутствующего Content-Type.
 *
 * Один arrayBuffer()-вызов → детект по magic bytes → декомпрессия при необходимости.
 * НЕ бросает ошибку «не смог декомпрессировать» — проваливается к text-декоду,
 * чтобы вызвавший JSON.parse дал осмысленное сообщение.
 *
 * @param {Response} resp — fetch Response (тело ещё не прочитано)
 * @returns {Promise<{ bytes: Uint8Array, text: string|null, mime: string|null }>}
 */
export async function readResponseBody(resp) {
    const buffer = await resp.arrayBuffer().catch(() => null);
    if (!buffer) throw new Error('Не удалось прочитать тело ответа');
    let bytes = new Uint8Array(buffer);

    // 1. Картинка — не декодируем как текст.
    const mime = detectImageMime(bytes);
    if (mime) return { bytes, text: null, mime };

    // 2. zstd: native (если поддерживается) → polyfill.
    if (isZstd(bytes)) {
        const native = await tryNativeZstd(bytes);
        if (native) bytes = native;
        else {
            try { bytes = fzstdDecompress(bytes); }
            catch { /* corrupt — оставляем оригинальные байты, JSON.parse выдаст ошибку */ }
        }
        // После декомпрессии там может оказаться картинка.
        const mime2 = detectImageMime(bytes);
        if (mime2) return { bytes, text: null, mime: mime2 };
    }

    // 3. gzip (Content-Encoding скрыт прокси).
    if (isGzip(bytes)) {
        const out = await tryGunzip(bytes);
        if (out) {
            bytes = out;
            const mime3 = detectImageMime(bytes);
            if (mime3) return { bytes, text: null, mime: mime3 };
        }
    }

    // 4. Текст.
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return { bytes, text, mime: null };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
node --test tests/core-response.test.js
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Verify no regression in existing core importers**

Run:

```bash
node --test tests/retry-policy.test.js tests/references-profiles.test.js
```

Expected: PASS (confirms adding the import + functions to `core.js` did not break existing consumers).

- [ ] **Step 6: Commit**

```bash
git add src/core.js tests/core-response.test.js
git commit -m "feat(core): add readResponseBody with zstd/gzip/image cascade"
```

---

## Task 4: Migrate `gemini.js` to `readResponseBody`

**Files:**
- Modify: `src/providers/gemini.js` (image path `:251-296`, text path `:173-179`; delete local `detectImageMime`/`bytesToAscii`/`tryGunzip` at `:26-89`)
- Modify: `tests/providers.test.js` (add zstd regression for gemini)

- [ ] **Step 1: Write the failing regression test**

In `tests/providers.test.js`, add (after the existing gemini tests, before the next provider section):

```js
test('gemini.generateImage: zstd-compressed inlineData JSON → dataUrl', async () => {
    const payload = JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] } }],
    });
    const zstd = makeZstdFrame(payload);
    const restore = mockFetch(() => ({
        ok: true,
        status: 200,
        headers: { get: () => '' },
        arrayBuffer: async () => zstd.buffer.slice(zstd.byteOffset, zstd.byteOffset + zstd.byteLength),
    }));
    try {
        const r = await gemini.generateImage(
            { provider: 'gemini', endpoint: 'https://fuzhan.magicv4.ltd', apiKey: 'k', model: 'gemini-3.1-flash-image-preview' },
            { prompt: 'cat', style: '', aspectRatio: '1:1', imageSize: '1K' },
            [], () => {},
        );
        assert.equal(r.kind, 'dataUrl');
        assert.match(r.value, /^data:image\/png;base64,/);
    } finally { restore(); }
});
```

Also add `makeZstdFrame` to the import at the top of the file:

```js
import { mockFetch, installStGlobals, makeZstdFrame } from './_helpers.js';
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test --test-name-pattern="zstd-compressed inlineData" tests/providers.test.js
```

Expected: FAIL — current `gemini.js` has no zstd handling; the zstd bytes hit `JSON.parse` and the test gets the runbook's "неожиданный ответ (не JSON …)" error.

- [ ] **Step 3: Update imports in `gemini.js`**

Change the import block at `src/providers/gemini.js:10-13` to add `readResponseBody` and remove now-unused helpers:

```js
import { fetchWithTimeout, normalizeEndpoint, VALID_ASPECT_RATIOS, VALID_IMAGE_SIZES, error, warn, log, readResponseBody } from '../core.js';
```

(`dataUrlToBase64`, `dataUrlMimeType` from `../references.js` and `buildReferenceInstruction` from `./base.js` stay.)

- [ ] **Step 4: Delete the now-duplicated helpers**

Delete `bytesToAscii` (`gemini.js:26-28`), `detectImageMime` (`:34-60`), and `tryGunzip` (`:67-89`) from `gemini.js` — they now live in `core.js`. Keep the comment headers removed with them.

- [ ] **Step 5: Replace the image response block**

Replace `gemini.js:251-296` (from `const buffer = await resp.arrayBuffer()` through the `throw new Error('Gemini: нет изображения в ответе')`) with:

```js
    // Тело читается один раз через общий cascade: детект картинки / zstd / gzip / текст.
    const { bytes, text, mime } = await readResponseBody(resp);
    log('gemini.generateImage: тело ответа', {
        length: bytes.length,
        contentType: respCt || '(none)',
        detectedMime: mime || '(not image)',
        hex: Array.from(bytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' '),
    });

    if (mime) {
        const dataUrl = await bytesToDataUrl(bytes, mime);
        return { kind: 'dataUrl', value: dataUrl };
    }

    let j = null;
    try { j = JSON.parse(text || ''); } catch { /* не JSON */ }
    if (!j) {
        throw new Error(
            `Gemini Image: неожиданный ответ (не JSON, status=${respStatus}, ct=${respCt || 'none'}, ` +
            `len=${bytes.length}, hex=${Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')})`,
        );
    }
    const cands = j.candidates || [];
    if (!cands.length) throw new Error('Gemini: нет кандидатов');

    for (const part of (cands[0].content?.parts || [])) {
        if (part.inlineData) return { kind: 'dataUrl', value: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` };
        if (part.inline_data) return { kind: 'dataUrl', value: `data:${part.inline_data.mime_type};base64,${part.inline_data.data}` };
    }
    throw new Error('Gemini: нет изображения в ответе');
```

Add `bytesToDataUrl` to the `../core.js` import on the line you changed in Step 3 (it should read `…, readResponseBody, bytesToDataUrl } from '../core.js';`).

- [ ] **Step 6: Replace the text response block**

Replace `gemini.js:173-184` (`const text = await resp.text()…` through the `throw new Error('Gemini: не удалось извлечь текст из ответа')`) with:

```js
    const { text } = await readResponseBody(resp);
    let j = null;
    try { j = JSON.parse(text || ''); } catch { /* не JSON */ }
    if (!j) {
        if (text) throw new Error(`Gemini Text: неожиданный ответ (не JSON): ${text.slice(0, 300)}`);
        throw new Error('Gemini Text: пустой или не-JSON ответ');
    }
    const parts = j?.candidates?.[0]?.content?.parts || [];
    const texts = parts.filter(p => typeof p?.text === 'string' && !p.thought).map(p => p.text);
    if (texts.length) return texts.join('');
    throw new Error('Gemini: не удалось извлечь текст из ответа');
```

- [ ] **Step 7: Run the new test — verify pass**

Run:

```bash
node --test --test-name-pattern="zstd-compressed inlineData" tests/providers.test.js
```

Expected: PASS.

- [ ] **Step 8: Run the full gemini provider tests — no regression**

Run:

```bash
node --test --test-name-pattern="gemini" tests/providers.test.js
```

Expected: all gemini tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/providers/gemini.js tests/providers.test.js
git commit -m "feat(gemini): migrate response reads to readResponseBody (zstd-safe)"
```

---

## Task 5: Migrate `openai.js` to `readResponseBody`

**Files:**
- Modify: `src/providers/openai.js` (4 sites: text `:141-146`, edits `:211-228`, multimodal `:272-276`, generations `:343-362`)
- Modify: `tests/providers.test.js` (add zstd regression)

- [ ] **Step 1: Write the failing regression test**

Add to `tests/providers.test.js`:

```js
test('openai.generateImage (generations): zstd-compressed JSON → dataUrl', async () => {
    const payload = JSON.stringify({ data: [{ b64_json: 'YWJjZA==' }] });
    const zstd = makeZstdFrame(payload);
    const restore = mockFetch(() => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        arrayBuffer: async () => zstd.buffer.slice(zstd.byteOffset, zstd.byteOffset + zstd.byteLength),
    }));
    try {
        const r = await openai.generateImage(
            { provider: 'openai-like', endpoint: 'https://api.test', apiKey: 'k', model: 'dall-e-3' },
            { prompt: 'cat', style: '', aspectRatio: '1:1', quality: 'standard' },
            [], () => {},
        );
        assert.equal(r.kind, 'dataUrl');
        assert.match(r.value, /^data:image\/png;base64,/);
    } finally { restore(); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test --test-name-pattern="zstd-compressed JSON" tests/providers.test.js
```

Expected: FAIL — `generations` calls `resp.json()` directly, gets `null`, throws "не удалось разобрать ответ".

- [ ] **Step 3: Update imports**

At `src/providers/openai.js:10`, change:

```js
import { fetchWithTimeout, normalizeEndpoint, normalizeEndpointUrl, extractTextFromResponse, error, log } from '../core.js';
```
to:
```js
import { fetchWithTimeout, normalizeEndpoint, normalizeEndpointUrl, extractTextFromResponse, readResponseBody, bytesToDataUrl, error, log } from '../core.js';
```

- [ ] **Step 4: Migrate the `generations` site (`:343-362`)**

Replace `:343-362` (from `const ct = (resp.headers.get('content-type')…` through `return extractImageResult(j);`) with:

```js
    const { bytes, text, mime } = await readResponseBody(resp);
    if (mime) {
        const dataUrl = await bytesToDataUrl(bytes, mime);
        return { kind: 'dataUrl', value: dataUrl };
    }
    let j = null;
    try { j = JSON.parse(text || ''); } catch { /* не JSON */ }
    if (!j) throw new Error(`Image API: не удалось разобрать ответ: ${(text || '').slice(0, 300)}`);
    return extractImageResult(j);
```

- [ ] **Step 5: Migrate the `edits` site (`:211-228`)**

Replace `:211-228` with the **same** block as Step 4 (identical shape — both branches were already identical except the error label):

```js
    const { bytes, text, mime } = await readResponseBody(resp);
    if (mime) {
        const dataUrl = await bytesToDataUrl(bytes, mime);
        return { kind: 'dataUrl', value: dataUrl };
    }
    let j = null;
    try { j = JSON.parse(text || ''); } catch { /* не JSON */ }
    if (!j) throw new Error(`Image API: не удалось разобрать ответ: ${(text || '').slice(0, 300)}`);
    return extractImageResult(j);
```

- [ ] **Step 6: Migrate the `multimodal` site (`:272-276`)**

Replace `:272-276`:

```js
    const { text: respText } = await readResponseBody(resp);
    let data = null;
    try { data = JSON.parse(respText || ''); } catch { /* не JSON */ }
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new Error(`Multimodal API: пустой или нестандартный ответ: ${(respText || '').slice(0, 300)}`);
```

- [ ] **Step 7: Migrate the `text` site (`:141-146`)**

Replace `:141-146`:

```js
    const { text } = await readResponseBody(resp);
    let data = null;
    try { data = JSON.parse(text); } catch { /* не JSON */ }
    const extracted = extractTextFromResponse(data);
    if (extracted !== null) return extracted;
    throw new Error(`Text API: пустой или нестандартный ответ: ${(text || '').slice(0, 300)}`);
```

- [ ] **Step 8: Run the new test — verify pass**

Run:

```bash
node --test --test-name-pattern="zstd-compressed JSON" tests/providers.test.js
```

Expected: PASS.

- [ ] **Step 9: Run all openai provider tests — no regression**

Run:

```bash
node --test --test-name-pattern="openai|generations|edits|multimodal" tests/providers.test.js
```

Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add src/providers/openai.js tests/providers.test.js
git commit -m "feat(openai): migrate all response reads to readResponseBody"
```

---

## Task 6: Migrate `agnes.js` to `readResponseBody`

**Files:**
- Modify: `src/providers/agnes.js` (`:89-108`)
- Modify: `tests/providers.test.js` (add zstd regression)

- [ ] **Step 1: Write the failing test**

Add to `tests/providers.test.js`:

```js
test('agnes.generateImage: zstd-compressed JSON → dataUrl', async () => {
    const payload = JSON.stringify({ data: [{ b64_json: 'YWJjZA==' }] });
    const zstd = makeZstdFrame(payload);
    const restore = mockFetch(() => ({
        ok: true,
        status: 200,
        headers: { get: () => '' },
        arrayBuffer: async () => zstd.buffer.slice(zstd.byteOffset, zstd.byteOffset + zstd.byteLength),
    }));
    try {
        const r = await agnes.generateImage(
            { provider: 'agnes', endpoint: 'https://agnes-ai.com', apiKey: 'k', model: 'agnes-xl' },
            { prompt: 'cat', style: '', aspectRatio: '1:1' },
            [], () => {},
        );
        assert.equal(r.kind, 'dataUrl');
        assert.match(r.value, /^data:image\/png;base64,/);
    } finally { restore(); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test --test-name-pattern="zstd-compressed JSON" tests/providers.test.js
```

Expected: FAIL.

- [ ] **Step 3: Update imports**

At `src/providers/agnes.js:9`, change:

```js
import { fetchWithTimeout, normalizeEndpoint, warn, error } from '../core.js';
```
to:
```js
import { fetchWithTimeout, normalizeEndpoint, readResponseBody, bytesToDataUrl, warn, error } from '../core.js';
```

- [ ] **Step 4: Replace the response block (`:89-108`)**

Replace `:89-108` (from `const ct = (resp.headers.get('content-type')…` through `return extractImageResult(j);`) with:

```js
    const { bytes, text, mime } = await readResponseBody(resp);
    if (mime) {
        const dataUrl = await bytesToDataUrl(bytes, mime);
        return { kind: 'dataUrl', value: dataUrl };
    }
    let j = null;
    try { j = JSON.parse(text || ''); } catch { /* не JSON */ }
    if (!j) throw new Error(`Agnes API: неожиданный ответ (не JSON): ${(text || '').slice(0, 300)}`);
    return extractImageResult(j);
```

- [ ] **Step 5: Run the test — verify pass**

Run:

```bash
node --test --test-name-pattern="zstd-compressed JSON" tests/providers.test.js
```

Expected: PASS.

- [ ] **Step 6: Run all agnes tests — no regression**

Run:

```bash
node --test --test-name-pattern="agnes" tests/providers.test.js
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/providers/agnes.js tests/providers.test.js
git commit -m "feat(agnes): migrate response read to readResponseBody"
```

---

## Task 7: Migrate `pollinations.js` to `readResponseBody`

**Files:**
- Modify: `src/providers/pollinations.js` (`:122-124`)
- Modify: `tests/providers.test.js` (add zstd regression)

- [ ] **Step 1: Write the failing test**

Add to `tests/providers.test.js`:

```js
test('pollinations.generateImage: zstd-compressed PNG → dataUrl', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2]);
    const zstd = makeZstdFrame(String.fromCharCode(...png));
    const restore = mockFetch(() => ({
        ok: true,
        status: 200,
        headers: { get: () => '' },
        arrayBuffer: async () => zstd.buffer.slice(zstd.byteOffset, zstd.byteOffset + zstd.byteLength),
    }));
    try {
        const r = await pollinations.generateImage(
            { provider: 'pollinations', endpoint: 'https://image.pollinations.ai', model: 'flux' },
            { prompt: 'cat', style: '', aspectRatio: '1:1' },
            [], () => {},
        );
        assert.equal(r.kind, 'dataUrl');
        assert.match(r.value, /^data:image\/png;base64,/);
    } finally { restore(); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test --test-name-pattern="zstd-compressed PNG" tests/providers.test.js
```

Expected: FAIL — current code does `resp.blob()` → corrupt dataUrl.

- [ ] **Step 3: Update imports**

At `src/providers/pollinations.js:9`, change:

```js
import { fetchWithTimeout, normalizeEndpoint, log, warn, error } from '../core.js';
```
to:
```js
import { fetchWithTimeout, normalizeEndpoint, readResponseBody, bytesToDataUrl, log, warn, error } from '../core.js';
```

- [ ] **Step 4: Replace the response block (`:122-124`)**

Replace `:122-124`:

```js
    const { bytes, mime } = await readResponseBody(resp);
    const dataUrl = await bytesToDataUrl(bytes, mime || 'image/png');
    return { kind: 'dataUrl', value: dataUrl };
```

- [ ] **Step 5: Run the test — verify pass**

Run:

```bash
node --test --test-name-pattern="zstd-compressed PNG" tests/providers.test.js
```

Expected: PASS.

- [ ] **Step 6: Run all pollinations tests — no regression**

Run:

```bash
node --test --test-name-pattern="pollinations" tests/providers.test.js
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/providers/pollinations.js tests/providers.test.js
git commit -m "feat(pollinations): migrate response read to readResponseBody"
```

---

## Task 8: Migrate `image-download.js` to `readResponseBody`

**Files:**
- Modify: `src/image-download.js` (`:29-39`)
- Modify: `tests/image-download.test.js` (add zstd regression)

- [ ] **Step 1: Inspect the existing test file**

Run:

```bash
head -40 tests/image-download.test.js
```

Note the import line and `downloadConfig` override pattern (the existing tests shorten `downloadConfig.retryDelayMs` to avoid real waits — mirror that).

- [ ] **Step 2: Write the failing test**

Add `makeZstdFrame` to the `tests/_helpers.js` import at the top of `tests/image-download.test.js` (append it to whatever the existing `import { … } from './_helpers.js'` line already pulls). Add this test:

```js
test('urlToDataUrl: zstd-compressed PNG → dataUrl', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2]);
    const zstd = makeZstdFrame(String.fromCharCode(...png));
    const restore = mockFetch(() => ({
        ok: true,
        status: 200,
        headers: { get: () => '' },
        arrayBuffer: async () => zstd.buffer.slice(zstd.byteOffset, zstd.byteOffset + zstd.byteLength),
    }));
    try {
        const r = await urlToDataUrl('https://cdn.test/img.png');
        assert.match(r, /^data:image\/png;base64,/);
    } finally { restore(); }
});
```

Add `makeZstdFrame` to the `_helpers.js` import at the top of the file.

- [ ] **Step 3: Run the test to verify it fails**

Run:

```bash
node --test --test-name-pattern="zstd-compressed PNG" tests/image-download.test.js
```

Expected: FAIL.

- [ ] **Step 4: Update imports**

At `src/image-download.js:11`, change:

```js
import { autoFetch } from './proxy.js';
```
to:
```js
import { autoFetch } from './proxy.js';
import { readResponseBody, bytesToDataUrl } from './core.js';
```

- [ ] **Step 5: Replace `fetchToDataUrl` body (`:29-39`)**

Replace the body of `fetchToDataUrl` (lines `:29-39`):

```js
async function fetchToDataUrl(url, signal) {
    const resp = await autoFetch(url, {}, downloadConfig.timeoutMs);
    if (!resp.ok) throw new Error(`Загрузка URL не удалась (HTTP ${resp.status})`);
    const { bytes, mime } = await readResponseBody(resp);
    return bytesToDataUrl(bytes, mime || 'image/png');
}
```

- [ ] **Step 6: Run the test — verify pass**

Run:

```bash
node --test --test-name-pattern="zstd-compressed PNG" tests/image-download.test.js
```

Expected: PASS.

- [ ] **Step 7: Run all image-download tests — no regression**

Run:

```bash
node --test tests/image-download.test.js
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/image-download.js tests/image-download.test.js
git commit -m "feat(image-download): migrate fetchToDataUrl to readResponseBody"
```

---

## Task 9: Full regression sweep + runbook update

**Files:**
- Modify: `docs/superpowers/runbooks/2026-07-11-gemini-zstd-proxy-response.md`

- [ ] **Step 1: Run the entire test suite**

Run:

```bash
node --test tests/
```

Expected: all tests PASS, zero failures. If any test fails, do not proceed — fix the regression first.

- [ ] **Step 2: Sanity-check the vendored file size and exports one more time**

Run:

```bash
wc -c src/vendor/fzstd.esm.js
grep -o "export{[^}]*}" src/vendor/fzstd.esm.js
```

Expected: ~8 573 bytes; export line includes `xr as decompress`.

- [ ] **Step 3: Update the runbook**

Open `docs/superpowers/runbooks/2026-07-11-gemini-zstd-proxy-response.md`. Replace the **"Open questions / follow-up"** section (lines `:119-124`) with a resolved "Resolution" section:

```markdown
## Resolution (2026-07-12)

Fixed by adding proxy-safe response-body reading across all providers.

**Spec:** `docs/superpowers/specs/2026-07-12-zstd-response-decompression-design.md`
**Plan:** `docs/superpowers/plans/2026-07-12-zstd-response-decompression.md`

### What changed

- Vendored `fzstd@0.1.1` (MIT, pure JS, 8.5 KB, no WASM) at `src/vendor/fzstd.esm.js`.
- New `readResponseBody(resp)` in `src/core.js`: one `arrayBuffer()` → magic-byte cascade (image → native-zstd → fzstd-zstd → gzip → text). Returns `{bytes, text, mime}`.
- All providers migrated: `gemini.js`, `openai.js`, `agnes.js`, `pollinations.js`, plus `image-download.js`.
- `detectImageMime` and `bytesToDataUrl` moved to `src/core.js` (were inlined/duplicated in 5 places).

### Why this and not a native API

- `DecompressionStream('zstd')` is non-standard (caniuse; WHATWG compression #54 open) — cannot be relied on. Feature-detected and used when present; fzstd polyfills the rest.
- Browser auto-decompress requires the proxy to forward `Content-Encoding`; the ST CORS proxy strips it.
- `Accept-Encoding: identity` is ignored by the proxy (confirmed earlier in this runbook).

### Result

- The `fuzhan.magicv4.ltd` zstd responses now decompress and produce a valid `dataUrl`.
- The same defense covers any other provider going through the same proxy.
- When WHATWG ships `DecompressionStream('zstd')`, the fzstd path becomes dead code automatically — no future edit required.
```

- [ ] **Step 4: Commit the runbook**

```bash
git add docs/superpowers/runbooks/2026-07-11-gemini-zstd-proxy-response.md
git commit -m "docs(runbook): resolve zstd proxy issue with readResponseBody fix"
```

---

## Self-Review (run before declaring done)

1. **Spec coverage** — every section of the spec maps to a task: §3/§4 → Task 3; §5 → Task 1; §4 migration table → Tasks 4-8; §7 test strategy → Tasks 3-8; §6 risks are encoded as the cascade's try/catch fall-through. ✓
2. **Placeholder scan** — no TBD / TODO / "similar to N". ✓
3. **Type consistency** — `readResponseBody` returns `{bytes, text, mime}` in spec, Task 3 tests, and all provider edits. `bytesToDataUrl(bytes, mime)` signature is consistent across Tasks 3-8. ✓
4. **No `resp.json()` / `resp.blob()` left after migration** — grep-check before final commit:

   ```bash
   grep -n "resp\.\(json\|blob\|text\|arrayBuffer\)()" src/providers/*.js src/image-download.js
   ```

   Expected: **no matches** in the migrated functions (only `readResponseBody(resp)` calls remain on the response). The `!resp.ok` error paths use `resp.text()` for error messages in some providers — those are fine (early `!ok` branch, before `readResponseBody`).
