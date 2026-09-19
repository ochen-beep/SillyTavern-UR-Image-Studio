# Zstd Response Decompression — Design

**Date:** 2026-07-12
**Status:** Design (awaiting review)
**Related runbook:** `docs/superpowers/runbooks/2026-07-11-gemini-zstd-proxy-response.md`

---

## 1. Problem

The `другие.magicv4.ltd` Gemini proxy returns **zstd-compressed** response bodies. The SillyTavern CORS proxy (`/proxy/<url>`) forwards the body but **hides the `Content-Encoding` response header**, so the browser:

- does not auto-decompress (Chrome 123+ would, if it saw `Content-Encoding: zstd`),
- hands the raw `28 b5 2f fd …` bytes to the extension,
- `JSON.parse` fails → `Gemini Image: неожиданный ответ (не JSON, …)`.

The runbook already established (and this design confirms) that this is a **transport-layer** problem, not a parsing bug. No JSON parser — brace-counting, JSON-repair, or regex — can recover data from bytes it cannot decompress.

### Why the obvious "native" fixes do not work

| Fix attempt | Why it fails here |
|---|---|
| `Accept-Encoding: identity` | Proxy ignores it (verified in runbook). |
| `DecompressionStream('zstd')` | **Non-standard.** caniuse marks it non-standard; Firefox only behind `dom.compression_streams.zstd.enabled`; WHATWG compression [issue #54](https://github.com/whatwg/compression/issues/54) still open. Cannot be relied on. |
| Native browser auto-decompress | Only triggers if the proxy forwards `Content-Encoding`. It strips it. |

### Blast radius is wider than the runbook implies

The runbook documents the Gemini failure because that is where it was observed. But the **same proxy** is used by every provider via `autoFetch` (`src/proxy.js:171`). A zstd body breaks **any** provider, not just Gemini:

| File | Body consumption today | Zstd-safe? |
|---|---|---|
| `providers/gemini.js` (image) | `arrayBuffer` → `detectImageMime` → `tryGunzip` → `JSON.parse` (`:251-296`) | gzip only — zstd fails at `JSON.parse` |
| `providers/gemini.js` (text) | `resp.text()` → `JSON.parse` (`:173-179`) | fails |
| `providers/openai.js` (generations) | CT-gated `blob`/`json` (`:345-362`) | fails |
| `providers/openai.js` (edits) | CT-gated `blob`/`json` (`:211-228`) | fails |
| `providers/openai.js` (multimodal) | `resp.text()` → `JSON.parse` (`:272-274`) | fails |
| `providers/openai.js` (text) | `resp.text()` → `JSON.parse` (`:141-143`) | fails |
| `providers/agnes.js` | CT-gated `blob`/`json` (`:91-108`) | fails |
| `providers/pollinations.js` | `resp.blob()` → `readAsDataURL` (`:122-124`) | silently produces corrupt dataUrl |
| `image-download.js` | `resp.blob()` → `readAsDataURL` (`:32-39`) | silently corrupt |

Fixing only `gemini.js` would leave identical latent bugs in five other files.

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Library | **`fzstd`** (101arrowz) v0.1.1 | Pure JS (no WASM), 8.5 KB single ESM file, 0 transitive imports, sync `decompress(Uint8Array)→Uint8Array`. Only decompression is needed — URIS never encodes. Verified: round-trips a real Gemini JSON frame; throws on corrupt input instead of hanging. |
| Delivery | **Vendored file** at `src/vendor/fzstd.esm.js` | Project has no `package.json`, no bundler, no `node_modules`, no bare-specifier resolution. All existing deps are absent; the only way to ship a dependency is to commit the file. Matches the "flat ESM" model already used for every module. WASM libs (`@bokuweb/zstd-wasm`, `zstd-codec`) are rejected: they require a bundler or a separately-fetched `.wasm` with correct MIME under `/scripts/extensions/third-party/…` — fragile and a real "костыль" here. |
| Detection | **Magic bytes**, never headers | The proxy hides `Content-Encoding` and often `Content-Type`. Magic bytes are the only reliable signal already proven in `detectImageMime` (`gemini.js:34-60`). zstd magic = `28 b5 2f fd`; gzip magic = `1f 8b`. |
| Layer | **Shared response-body reader** in `src/core.js` | The bug is transport-level and identical across 6 provider files + `image-download.js`. Putting the fix in each provider duplicates the cascade 7×. A single `readResponseBody(resp)` utility — one read, one detect/decode cascade — is DRY and becomes the single place to extend for future encodings. |
| API shape | `readResponseBody(resp) → { bytes, text, mime }` | Providers need different end-products: image providers want raw `bytes` + `mime`; JSON providers want `text` to `JSON.parse`. Returning both avoids a second read (the body is already consumed). `bytes`/`text`/`mime` are computed lazily only as far as the cascade reached. |
| Cascade order | image-mime → zstd → gzip → raw-text | Image bytes must short-circuit before text decode (a PNG is not valid UTF-8). zstd before gzip because their magics don't collide (`28 b5 2f fd` vs `1f 8b`). Both before "assume raw" so compressed-but-undetected fails loudly rather than silently corrupting. |
| Native zstd | Feature-detect, prefer native, fall back to polyfill | `new DecompressionStream('zstd')` constructor-throws in non-supporting browsers; wrap in try/catch. When WHATWG ships `'zstd'` ([#54](https://github.com/whatwg/compression/issues/54)), the polyfill path becomes dead code automatically — no future edit needed. |
| Scope of provider changes | All consumers migrate to `readResponseBody` | Mechanical: replace `resp.arrayBuffer()` / `resp.blob()` / `resp.text()` + ad-hoc CT/mime checks with one call. Each provider's error message and extraction logic stays. This **reduces** duplication (openai/agnes have copy-pasted CT-gated branches). |

### Non-goals

- **Compression of requests.** URIS sends JSON request bodies; no provider requires request-side zstd. Out of scope.
- **Streaming decompression.** Providers buffer the whole body via `arrayBuffer()` / `blob()` before parsing today. `fzstd.decompress` handles single frames (the proxy's output). If a future proxy streams multi-frame bodies, switch that one call site to `fzstd.Decompress` streaming — not needed now (YAGNI).
- **MIME-detecting every binary format.** `detectImageMime` already covers PNG/JPEG/GIF/WebP/BMP/AVIF/HEIC/JXL. We move it unchanged; we do not extend it.
- **Changing the proxy.** The ST CORS proxy is upstream code; its `Content-Encoding` stripping is out of our control. This design works *around* it, not *on* it.

---

## 3. The `readResponseBody` utility

New function in `src/core.js`, exported. Single entry point for consuming a provider response body safely.

### Signature

```js
/**
 * Безопасно прочитать тело ответа провайдера с учётом скрытого прокси сжатия
 * и отсутствующего Content-Type.
 *
 * Один arrayBuffer()-вызов → детект по magic bytes → при необходимости
 * декомпрессия (zstd polyfill / нативный / gzip) → результат.
 *
 * @param {Response} resp — fetch Response (тело ещё не прочитано)
 * @returns {Promise<{ bytes: Uint8Array, text: string|null, mime: string|null }>}
 *   - bytes: сырые декодированные байты (всегда; для текста — UTF-8 байты)
 *   - text:  UTF-8 строка, если тело не бинарное изображение (иначе null)
 *   - mime:  image MIME по magic bytes, если распознано (иначе null)
 */
export async function readResponseBody(resp) { … }
```

### Cascade

```
buffer = await resp.arrayBuffer()
bytes  = new Uint8Array(buffer)

1. mime = detectImageMime(bytes)
   if mime: return { bytes, text: null, mime }      // PNG/JPEG/… — не декодируем как текст

2. if isZstd(bytes):
     try decoded = decompressNative(bytes) ?? fzstdDecompress(bytes)
     catch → fall through to step 4 (будет ошибка парсинга с hex)
     bytes = decoded; continue to 3/4

3. if isGzip(bytes):
     try bytes = await gunzip(bytes)
     catch → fall through

4. text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
   return { bytes, text, mime: null }
```

Key invariants:

- **Body read exactly once.** After step 1, `resp.arrayBuffer()` is never called again. `bytes` is the working buffer.
- **Image short-circuits.** A valid image body (PNG etc.) is returned with `text: null`; the caller (image provider) builds the dataUrl from `bytes`/`mime`. This is the existing `gemini.js:262-271` path, generalised.
- **`fatal: false` decoder.** Compressed-but-undetected garbage becomes replacement chars, not a thrown exception — the caller's `JSON.parse` then fails with a clear message and the existing hex-diagnostic path applies.
- **Decompression failure is non-fatal.** If `fzstd.decompress` throws (corrupt frame), we fall through with the original bytes; the caller surfaces the error via `JSON.parse`. We never throw out of `readResponseBody` itself for a "couldn't decode" condition — only for `arrayBuffer()` I/O failure, which is a true error.

### Feature detection for native zstd

```js
let _nativeZstd = undefined; // 'yes' | 'no' | undefined (untested)
function nativeZstdStream(bytes) {
  if (_nativeZstd === undefined) {
    try { new DecompressionStream('zstd'); _nativeZstd = 'yes'; }
    catch { _nativeZstd = 'no'; }
  }
  if (_nativeZstd === 'no') return null;
  // pipe bytes through DecompressionStream('zstd'); return Uint8Array or null on throw
}
```

Cached after first call. When the standard ships, `_nativeZstd` flips to `'yes'` on supporting browsers and `fzstd` is never reached.

---

## 4. Migration of providers

Each provider replaces its response-consumption block with a `readResponseBody(resp)` call. The shape is uniform:

**Before** (openai.js generations, `:343-362`):
```js
const ct = (resp.headers.get('content-type') || '').toLowerCase();
if (ct.startsWith('image/')) {
    const blob = await resp.blob();
    const dataUrl = await /* FileReader */;
    return { kind: 'dataUrl', value: dataUrl };
}
const j = await resp.json().catch(() => null);
if (j === null) { /* error */ }
return extractImageResult(j);
```

**After:**
```js
const { bytes, text, mime } = await readResponseBody(resp);
if (mime) {
    const dataUrl = await bytesToDataUrl(bytes, mime);
    return { kind: 'dataUrl', value: dataUrl };
}
const j = safeJsonParse(text);
if (!j) throw new Error(`Image API: не удалось разобрать ответ: ${(text||'').slice(0,300)}`);
return extractImageResult(j);
```

### Migration table (exact edit sites)

| File:lines | Current reads | After |
|---|---|---|
| `gemini.js:251-296` (image) | `arrayBuffer` + inlined `detectImageMime`/`tryGunzip`/`JSON.parse` | `readResponseBody` → branch on `mime`/`text` |
| `gemini.js:173-179` (text) | `resp.text()` + `JSON.parse` | `readResponseBody` → `text` |
| `openai.js:141-143` (text) | `resp.text()` + `JSON.parse` | `readResponseBody` → `text` |
| `openai.js:211-228` (edits) | CT-gated `blob`/`json` | `readResponseBody` → `mime`/`text` |
| `openai.js:272-274` (multimodal) | `resp.text()` + `JSON.parse` | `readResponseBody` → `text` |
| `openai.js:343-362` (generations) | CT-gated `blob`/`json` | `readResponseBody` → `mime`/`text` |
| `agnes.js:89-108` | CT-gated `blob`/`json` | `readResponseBody` → `mime`/`text` |
| `pollinations.js:122-124` | `resp.blob()` + `readAsDataURL` | `readResponseBody` → `bytesToDataUrl(bytes, mime ?? 'image/png')` |
| `image-download.js:29-39` | `resp.blob()` + `readAsDataURL` | `readResponseBody` → `bytesToDataUrl(bytes, mime ?? sniff)` |

### Shared helpers (move from gemini.js to core.js)

To avoid the providers reaching into `gemini.js`, two helpers move to `core.js` alongside `readResponseBody`:

- `detectImageMime(bytes)` — moved verbatim from `gemini.js:34-60`.
- `bytesToDataUrl(bytes, mime)` — the repeated `FileReader` block (currently inlined in gemini/openai/agnes/pollinations/image-download, 5 copies) becomes one function.

`tryGunzip` stays internal to `readResponseBody` (not exported — it's an impl detail of the cascade).

---

## 5. Vendoring `fzstd`

- **Source:** `https://cdn.jsdelivr.net/npm/fzstd@0.1.1/+esm` (esm-flavored single file; verified 0 internal imports).
- **Target:** `src/vendor/fzstd.esm.js` (new `src/vendor/` directory).
- **License:** MIT (fzstd). Recorded in a header comment: source URL, version, license, "do not hand-edit".
- **Size:** 8 573 bytes (verified). Minified, no source map.
- **Import:** `import { decompress as fzstdDecompress } from './vendor/fzstd.esm.js';` from `src/core.js`.

No `package.json`, no dependency declaration, no build step introduced. The file is part of the repo like any other source file.

### Verification done before this spec

Round-trip test (Node 24, native `zlib.zstdCompressSync` to produce the frame, `fzstd.decompress` to recover):

```
compressed magic: 28 b5 2f fd (matches the runbook's observed bytes)
round-trip exact match: true
tiny round-trip: true
corrupt: threw code 0 "invalid zstd data"  (no hang)
```

---

## 6. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `fzstd` fails on a multi-frame streamed body | Low (proxy returns one buffered frame) | One-shot `decompress` is used because providers buffer via `arrayBuffer`. If observed, switch that call to streaming `Decompress` class — single call site, isolated. |
| Corrupt zstd frame hangs | Very low (verified: throws) | `decompress` is wrapped in try/catch; failure falls through to text decode → caller's `JSON.parse` surfaces a normal error with hex. |
| `DecompressionStream('zstd')` ships and breaks the feature-detect | None | Constructor-throw detection is the standard pattern; `_nativeZstd` cache means one check per session. Native path and polyfill produce identical bytes. |
| Migration introduces a regression in a working provider | Medium (mechanical edits across 6 files) | Each provider migrated in its own task with its own regression test; existing provider tests must stay green. TDD ordering: tests first, then migrate. |
| `arrayBuffer()` once contract violated | Medium (easy mistake: calling `resp.json()` after `readResponseBody`) | `readResponseBody` is the *only* body-reading call; the returned object carries `bytes`/`text` — callers never touch `resp.*()` again. Code review check. |
| Vendored file drifts / gets hand-edited | Low | Header comment marks it vendored; `.git` history shows provenance. |
| License incompatibility | None | MIT; URIS has no conflicting license. |

---

## 7. Test strategy

- **Unit (Node `node:test`):** `readResponseBody` against a mocked `Response` whose `arrayBuffer()` returns:
  1. plain UTF-8 JSON (text path),
  2. PNG magic bytes (image short-circuit, `text: null`),
  3. gzip frame wrapping JSON (`1f 8b …`, native `DecompressionStream` is absent in Node — must use the polyfill gunzip path; see test-mock note below),
  4. zstd frame wrapping JSON (`28 b5 2f fd …`, generated with Node `zlib.zstdCompressSync` if available, else a committed fixture),
  5. corrupt zstd magic (`28 b5 2f fd 99 99`) → falls through, `text` is replacement chars, no throw.
- **Regression:** existing `tests/providers.test.js` cases must pass unchanged after each provider migration.
- **Mock fixture:** `tests/_helpers.js` already exposes `arrayBuffer` on the mock (`:39-42`); zstd tests supply an explicit `arrayBuffer: async () => uint8.buffer`.

### Note on `DecompressionStream` in Node tests

Node does not implement `DecompressionStream` until v18.2+ (global from v20+). The gzip branch uses it. Tests for the gzip path must either (a) rely on Node ≥20's global `DecompressionStream`, or (b) be skipped on the gzip case and rely on the zstd polyfill test for the "decompression works" guarantee. We use (a): require Node ≥20 (already implied by the project's use of modern ESM + `structuredClone`).

---

## 8. Out of scope / future

- **Auto-disable zstd at the proxy:** not possible without upstream ST changes.
- **Reporting the bug upstream to ST:** tracked as an open question in the runbook; this extension defends regardless.
- **Brotli (`br`) hidden-encoding support:** `DecompressionStream('br')` is standard and would just be another cascade step. Not observed in the wild against URIS yet; add only if a proxy is seen using hidden brotli (YAGNI today).
