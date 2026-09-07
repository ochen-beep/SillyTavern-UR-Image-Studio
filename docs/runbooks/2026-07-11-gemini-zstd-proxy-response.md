# Gemini image generation fails with "Unexpected token" via fuzhan.magicv4.ltd proxy

Date: 2026-07-11
Branch: URIS
Reporter / debugger: dev

## Symptoms

- Image generation through `gemini-3.1-flash-image-preview` and `gemini-3-pro-image-preview` on endpoint `https://fuzhan.magicv4.ltd` fails with:
  - `Gemini Image: неожиданный ответ (не JSON, ...)`
  - Raw binary bytes in the error preview.
- The proxy dashboard shows the request as successful with a large output payload.
- Other endpoints / providers (OpenAI-compatible, Agnes, Pollinations) work intermittently.

## Environment

- Extension: UR Image Studio
- Endpoint: `https://fuzhan.magicv4.ltd`
- Models: `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview`
- API type: `gemini`
- Transport: SillyTavern CORS proxy (`enableCorsProxy: true`)
- Client: Chrome, origin `http://127.0.0.1:8000`

## Relevant code paths

- Request builder: `src/providers/gemini.js::generateImage`
- Request URL: `${endpoint}/v1beta/models/${model}:generateContent`
- Auth headers: `src/providers/gemini.js::authHeaders`
- Response handling: `src/providers/gemini.js::generateImage` (post-fetch)

## Evidence

### Browser console (URIS logs)

```
[URIS] gemini.generateImage: ответ от прокси {
  url: 'https://fuzhan.magicv4.ltd/v1beta/models/gemini-3.1-flash-image-preview:generateContent',
  status: 200,
  statusText: 'OK',
  contentType: '',
  contentLength: '?'
}

[URIS] gemini.generateImage: тело ответа {
  length: 1840675,
  contentType: '(none)',
  detectedMime: '(not image)',
  hex: '28 b5 2f fd 00 58 4c aa'
}

[URIS] image-api попытка 1: Gemini Image: неожиданный ответ
  (не JSON, status=200, ct=none, len=1840675, hex=28 b5 2f fd 00 58 4c aa 00 0a bc 31 54 1e e0 46)
```

### Hex interpretation

`28 b5 2f fd` is the Zstandard (zstd) frame magic number.
The proxy returns a zstd-compressed response body, but the `Content-Encoding` response header is hidden by the SillyTavern CORS proxy, so the browser does not decompress it.

### Other observed responses from the same endpoint

- `HTTP 429` with a proper JSON error body.
- `Gemini: нет изображения в ответe` (JSON parsed, but no `inlineData` part).
- Successful generations producing a saved `dataUrl` (PNG/JPEG) in the gallery.

This confirms the extension handles valid Gemini responses correctly when the proxy behaves.

## Investigation timeline

1. Verified request path format: `/v1beta/models/{model}:generateContent` is correct.
2. Confirmed only the `user` reference was being sent because the profile was in `smart` mode and `charName` was not mentioned in the prompt. Fixed `charName` source in `src/pipeline.js` to use `ctx.name2` as primary source.
3. Added diagnostic logging for response status, headers, body length and first bytes.
4. Found the body was binary, not JSON.
5. Initially suspected missing `Content-Type` image header and added binary handling via `arrayBuffer` + magic-byte detection.
6. Hex dump revealed `28 b5 2f fd` (zstd).
7. Added `Accept-Encoding: identity` to request headers; proxy ignores it and still returns zstd.

## Root cause

The upstream proxy `fuzhan.magicv4.ltd` returns zstd-compressed response bodies.
The SillyTavern CORS proxy forwards the body but does not expose `Content-Encoding`, so the browser receives opaque compressed bytes.
URIS attempts to parse them as JSON, which fails with `SyntaxError: Unexpected token` (caught and re-thrown as the observed error).

This is a proxy / transport issue, not an extension parsing bug for valid Gemini payloads.

## Fixes applied

### `src/pipeline.js`

Use `ctx.name2` as the canonical character name source for smart reference matching:

```js
const charName = ctx.name2 || ctx.characters?.[ctx.characterId]?.name || '';
```

### `src/providers/gemini.js`

- Read response body as `arrayBuffer` once, then branch on detected format.
- Detect image formats by magic bytes: PNG, JPEG, GIF, WebP, BMP, AVIF, HEIC, JPEG XL.
- Added gzip decompression fallback via `DecompressionStream` in case `Content-Encoding` is hidden for gzip.
- Added `Accept: application/json` and `Accept-Encoding: identity` headers.
- Preserved original JSON parsing path for normal Gemini `inlineData` responses.

### `src/providers/agnes.js`, `src/providers/openai.js`

- Fixed response body consumption order: check binary / `Content-Type: image/*` before calling `.json()`, preventing `body stream already read` errors on proxy image responses.

### Tests

- `tests/_helpers.js`: mock `fetch` response now exposes `headers`, `arrayBuffer`.
- `tests/providers.test.js`: added regression tests for raw binary image responses and binary PNG without `Content-Type`.

## Result (as of 2026-07-11 — pre-resolution)

- Valid Gemini responses (JSON with `inlineData`) continue to work.
- Raw image responses without `Content-Type` are now detected by magic bytes and converted to `dataUrl`.
- zstd responses **still fail** because browsers have no standard native zstd decompressor and the proxy ignores `Accept-Encoding: identity`.

> A follow-up fix (2026-07-12) addresses the zstd case across all providers — see "Resolution" below.

## Resolution (2026-07-12)

Fixed by adding proxy-safe response-body reading across all providers.

**Spec:** `docs/superpowers/specs/2026-07-12-zstd-response-decompression-design.md`
**Plan:** `docs/superpowers/plans/2026-07-12-zstd-response-decompression.md`

### What changed

- Vendored `fzstd@0.1.1` (MIT, pure JS, ~8.5 KB, no WASM) at `src/vendor/fzstd.esm.js`.
- New `readResponseBody(resp)` in `src/core.js`: one `arrayBuffer()` → magic-byte cascade (image → native-zstd → fzstd-zstd → gzip → text). Returns `{bytes, text, mime}`.
- All providers migrated: `gemini.js`, `openai.js`, `agnes.js`, `pollinations.js`, plus `image-download.js`.
- `detectImageMime` and `bytesToDataUrl` moved to `src/core.js` (were inlined/duplicated in 5 places).
- Regression tests added: `tests/core-response.test.js` plus zstd cases for every migrated provider.

### Why this and not a native API

- `DecompressionStream('zstd')` is non-standard (caniuse; WHATWG compression #54 open) — cannot be relied on. Feature-detected and used when present; fzstd polyfills the rest.
- Browser auto-decompress requires the proxy to forward `Content-Encoding`; the ST CORS proxy strips it.
- `Accept-Encoding: identity` is ignored by the proxy (confirmed earlier in this runbook).

### Result

- The `fuzhan.magicv4.ltd` zstd responses now decompress and produce a valid `dataUrl`.
- The same defense covers any other provider going through the same proxy.
- When WHATWG ships `DecompressionStream('zstd')`, the fzstd path becomes dead code automatically — no future edit required.

### Open questions / follow-up

- Is there a proxy setting or alternate endpoint that disables zstd upstream? (Defensive fix now in place regardless.)
- Should the bug be reported upstream to SillyTavern (proxy stripping `Content-Encoding`)?

## Related files

- `src/providers/gemini.js`
- `src/providers/agnes.js`
- `src/providers/openai.js`
- `src/pipeline.js`
- `tests/_helpers.js`
- `tests/providers.test.js`

## Related specs / plans

- `docs/superpowers/specs/2026-07-10-reference-images-integration-design.md`
- `docs/superpowers/plans/2026-07-10-reference-images-integration.md`
