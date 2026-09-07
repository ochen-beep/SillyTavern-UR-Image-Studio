# Hugging Face Inference Provider — Design

**Date:** 2026-07-12
**Status:** Design (awaiting review)
**Sibling:** `2026-07-09-pollinations-agnes-provider-design.md` (same provider-addition pattern)

---

## 1. Problem

UR Image Studio supports 4 working text-to-image providers (openai, gemini, pollinations, agnes) plus 2 stubs (comfyui, a1111). Users want to generate images through **Hugging Face Inference Providers** — the open-source model hub that exposes FLUX, Stable Diffusion, and similar diffusion models via a REST API.

Hugging Face is the largest catalog of open image-generation models, and its Inference Providers service gives every account a small monthly credit ($0.10 free / $2.00 PRO) to call them. Adding an `hf` provider lets URIS users reach that catalog without leaving the extension.

### 1.1 Why a new provider, not reuse of `openai`

HF exposes two API surfaces:

- **OpenAI-compatible `/v1/chat/completions`** at `router.huggingface.co/v1` — but **chat completions only**. HF docs explicitly state: «This OpenAI-compatible endpoint is currently available for chat completion tasks only. For other tasks like text-to-image, embeddings, or speech processing, use the Hugging Face inference clients.»
- **Task-specific REST** (`{inputs, parameters}` JSON body → raw image bytes) — the native text-to-image format, served by the `hf-inference` provider behind the router at `router.huggingface.co/hf-inference/models/<model>`.

The OpenAI URIS provider hits `/v1/images/generations` with an OpenAI-shaped body — HF doesn't serve that route. So `hf` must be its own provider speaking the HF task format.

### 1.2 Verified facts (research, July 2026)

| Claim | Source |
|---|---|
| Text-to-image returns **raw image bytes** (not JSON) on success | HF task spec `docs/inference-providers/en/tasks/text-to-image` Response table: «The generated image returned as raw bytes in the payload.» |
| Endpoint: `POST https://router.huggingface.co/hf-inference/models/<model>` | Forum thread 172081 (Nov 2025) gives a working curl; thread 170659 explains `/hf-inference/models/<id>` path shape and that bare `router.huggingface.co` returns 404 |
| Body: `{"inputs": "<prompt>", "parameters": {...}}` | Task spec Payload table |
| Auth: `Authorization: Bearer hf_...` (token with «Inference Providers» permission) | Task spec Headers table |
| Parameters: `width, height, num_inference_steps, guidance_scale, negative_prompt, scheduler, seed` | Task spec Payload table |
| 503 + `{"estimated_time": <sec>}` on cold start; `X-Wait-For-Model: true` header makes server hold connection until loaded | Forum timeout thread 147764; machinelearningplus tutorial |
| Free credits: $0.10/mo (free), $2.00/mo (PRO), passthrough pricing, ~$0.01/image for FLUX | `docs/inference-providers/en/pricing`; independent 2026 pricing articles |
| hf-inference is **CPU-only since July 2025** (slow for image gen; ~6 image models live) | `docs/inference-providers/en/providers/hf-inference`: «As of July 2025, hf-inference focuses mostly on CPU inference» |
| Model list via Hub API: `GET https://huggingface.co/api/models?pipeline_tag=text-to-image&inference_provider=true` — public, no auth | `docs/inference-providers/en/hub-api`; provider page links to `models?inference_provider=hf-inference` |
| FLUX.1-dev unstable above ~1.5M pixels (1440×960 safe) | Forum thread FLUX.1-dev/32 |

### 1.3 What this means for design

- **Response handling** is identical to `pollinations.js` (raw bytes → `readResponseBody` → `bytesToDataUrl`). Template confirmed.
- **Cold-start 503** is the dominant failure mode and must be handled inside the provider (the dispatcher's `callWithRetry` does not retry in `generation` mode — comment at `image-api.js:93`: «повтор платной генерации тратит деньги». But 503 is *not* a billed successful generation, so retrying it is safe and correct).
- **CPU-only hf-inference** is slow but functional; the provider should also accept a **dedicated Inference Endpoint URL** in the endpoint field (same `{inputs, parameters}` format, fast GPU) so a user who wants speed can paste their endpoint URL instead of the router. No extra code — endpoint is already a free-form field.
- **Model discovery** can't use `models.js:fetchModels` (it hits OpenAI `/v1/models` via ST's `chat-completions/status` route, which HF doesn't serve for text-to-image). A separate `fetchHfModels` hitting the public Hub API is needed.

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| API surface | hf-inference task REST (`{inputs, parameters}` → raw bytes) | The only HF surface that serves text-to-image over plain HTTP; OpenAI-compat endpoint is chat-only |
| Delivery path | `autoFetch` (direct → CORS-proxy fallback), same as all 4 existing providers | Documented ST mechanism (`enableCorsProxy`, `src/middleware/corsProxy.js`, route `GET /proxy/:url`); HF doesn't send permissive CORS headers, so proxy is required in practice |
| Auth | `Authorization: Bearer <apiKey>` from conn, same as agnes/openai | Architectural consistency with all existing providers; key stored in localforage + mirrored to ST secrets (`ST_SECRET_KEY_URIS`), identical path to agnes |
| Cold-start handling | `X-Wait-For-Model: true` header + up to 2 client retries on 503 with `estimated_time` pause | Header makes server hold the connection (cleaner than pure polling); retries are a safety net for when server-side wait exceeds gateway timeout. 503 is unbilled → safe to retry |
| Parameter controls | UI fields for `num_inference_steps`, `guidance_scale`, `negative_prompt` with sensible defaults | Parameters directly affect compute time → cost. Defaults mean «works without touching»; fields mean power users control quality/spend. Omits `seed`/`scheduler` (YAGNI — advanced, rarely used) |
| Model listing | `fetchHfModels` via public Hub API (`/api/models?pipeline_tag=text-to-image&inference_provider=true`) through `autoFetch` | HF has no OpenAI `/v1/models` for image tasks; Hub API is the documented discovery path. Public, no auth needed. Avoids forcing manual model ID entry |
| Reference images | `REF_CAPABILITIES.hf = {strategies:['none'], ...}` — refs silently dropped | HF text-to-image task takes no reference images (no img2img in this task); matches agnes/comfyui/a1111 precedent |
| Image size | Reuse `ASPECT_SIZE_MAP` from agnes (10 ratios). Documented caveat: 21:9 (1792×768=1.38M) safe; large ratios near 1.5M+ may be unstable on FLUX | Size map is shared across providers; per-model pixel limits are model-specific and not enforceable client-side without a model registry. Documented limitation is sufficient |
| Endpoint field default | Placeholder `https://router.huggingface.co/hf-inference` | Router works with free credits; user can replace with a dedicated Inference Endpoint URL for GPU speed (same API format) |

---

## 3. Architecture

```
UI (tab-api.js)
  │  apiType='hf', endpoint, apiKey, model, providerOptions{steps,guidance,negative}
  ▼
connections.js  ── (conn record, key in localforage + ST secrets) ── same as agnes
  │
pipeline.js ──▶ image-api.js
                   │  resolveApiType(endpoint,model) → 'hf'
                   │  switch(apiType) case 'hf': → hf.generateImage(profile, ...)
                   ▼
              providers/hf.js
                   │  POST {endpoint}/models/{model}
                   │  body: {inputs, parameters:{width,height,steps,guidance,negative}}
                   │  headers: Authorization Bearer, Content-Type json, Accept image/png,
                   │           X-Wait-For-Model: true
                   │  via autoFetch (direct→proxy fallback)
                   │  503 → retry (≤2) with min(estimated_time,30)s pause + status callback
                   ▼
              router.huggingface.co/hf-inference  (or user's Inference Endpoint)
                   │
                   ▼  raw image bytes
              readResponseBody(resp) → {bytes, mime}
                   │
                   ▼
              bytesToDataUrl(bytes, mime) → {kind:'dataUrl', value}
```

Model discovery (separate path, triggered by «Загрузить модели» button):
```
tab-api.js (fetch button, apiType==='hf')
  ▼
models.js: fetchHfModels(connId)
  │  autoFetch GET https://huggingface.co/api/models?pipeline_tag=text-to-image
  │                      &inference_provider=true&sort=downloads&direction=-1&limit=50
  │  (public, no auth; through CORS-proxy via autoFetch)
  ▼
  JSON [{id, downloads, ...}, ...]  →  string[] of model ids
  ▼
  saveConnection({id, availableModels, lastFetch})  →  UI select populated
```

---

## 4. Components

### 4.1 `src/providers/hf.js` (new, ~110 lines)

Closest template: `agnes.js` (POST + Bearer + JSON body) for request shape, `pollinations.js` (raw bytes → dataUrl) for response shape.

**Exports:** `generateImage(p, instruction, refs, onStatus, signal)`

**Constants:**
- `ASPECT_SIZE_MAP` — copy from `agnes.js` (10 ratios → `WxH` strings)
- `DEFAULT_SIZE = '1024x1024'`
- `MAX_503_RETRIES = 2` (header does the primary wait; retries are safety net)
- `DEFAULT_STEPS = 20`, `DEFAULT_GUIDANCE = 3.5` (sensible across FLUX/SDXL)

**Helpers:**
- `composePrompt(prompt, style)` — `[style, prompt].filter(Boolean).join(' ').trim()` (copy from agnes)
- `sizeToWidthHeight(size)` — parse `WxH` → `{width, height}` (copy from pollinations)
- `buildParameters(p, instruction)` — assembles `{width, height, num_inference_steps, guidance_scale, negative_prompt}` from `instruction.aspectRatio` + `p.providerOptions`, applying defaults for unset fields. Omits `negative_prompt` if empty (don't send empty string)
- `sleep(ms, signal)` — pause that respects abort (throw `AbortError` if signal fires during wait)

**`generateImage` flow:**
1. `base = normalizeEndpoint(p.endpoint)` — strip trailing slash; if empty, throw.
2. **Endpoint contract:** `endpoint` is the **base URL without any `/models/<id>` suffix**. The provider appends `/models/<model>`. Valid examples:
   - Router: `https://router.huggingface.co/hf-inference` → `.../models/black-forest-labs/FLUX.1-dev`
   - Legacy serverless: `https://api-inference.huggingface.co` → `.../models/<model>`
   - Dedicated Inference Endpoint: `https://<name>.us-east-1.aws.endpoints.huggingface.cloud` → `.../models/<model>` (dedicated endpoints accept the same path shape)
   - If `base` already ends with `/models` (user pasted a full legacy URL), strip the trailing `/models` to avoid doubling. Do **not** otherwise rewrite or validate the host — dedicated endpoints have arbitrary hostnames.
3. Compose `url = ${base}/models/${encodeURIComponent(p.model)}`
3. `body = { inputs: composePrompt(instruction.prompt, instruction.style), parameters: buildParameters(p, instruction) }`
4. `headers = { 'Authorization': 'Bearer ' + p.apiKey, 'Content-Type': 'application/json', 'Accept': 'image/png', 'X-Wait-For-Model': 'true' }`
5. If `refs?.length` → `warn('hf: референсы игнорируются — text-to-image не поддерживает image-to-image')` (copy agnes pattern)
6. **Retry loop** (attempts 0..MAX_503_RETRIES):
   - `onStatus?.(attempt===0 ? 'Картинка...' : 'Модель загружается (попытка ${attempt+1})...')`
   - `resp = await autoFetch(url, {method:'POST', headers, body: JSON.stringify(body), signal}, p.timeoutMs ?? 300000)`
   - If `resp.status === 503` and attempt < MAX:
     - read body as text, try `JSON.parse` → `estimated_time`
     - `wait = Math.min(Math.max(estimated_time||10, 3), 30)` seconds (clamp 3..30)
     - `onStatus?.('Модель прогревается, ждём ${wait}с...')`
     - `await sleep(wait*1000, signal)`
     - continue loop
   - If `resp.status === 503` and attempt === MAX → throw `Error('HF: модель не загрузилась после ${MAX+1} попыток. Попробуйте ещё раз или выберите другую модель.')`
   - break on any non-503 status
7. If `!resp.ok`:
   - read `text` via `readResponseBody` (HF errors are JSON, but proxy may compress)
   - throw `Error('HF API HTTP ${resp.status}: ${text.slice(0,300)}')`
8. `const { bytes, mime, text } = await readResponseBody(resp)`
9. If `mime` (image detected) → `return { kind:'dataUrl', value: await bytesToDataUrl(bytes, mime || 'image/png') }`
10. Else (got JSON/text, not an image) → throw `Error('HF: неожиданный ответ (не изображение): ${(text||'').slice(0,300)}')` — handles edge case where HF returns JSON error with 200 (rare but seen in forums for unsupported models)

**JSDoc** matches agnes signature: `@returns {Promise<{kind: string, value: string}>}`.

### 4.2 Dispatcher integration — `src/image-api.js`

- Line 19 area: add `import * as hf from './providers/hf.js';`
- Line 97 switch, after `case 'agnes':`:
  ```js
  case 'hf':
      return await hf.generateImage(profile, instruction, preparedRefs, onStatus, signal);
  ```

### 4.3 Type & resolution — `src/core.js`

- Line 30 `VALID_API_TYPES`: add `'hf'`:
  ```js
  export const VALID_API_TYPES = ['auto', 'openai', 'gemini', 'pollinations', 'agnes', 'hf'];
  ```
- Line 258 `resolveApiType`: add HF detection **before** the `return 'openai'` fallback (after agnes check):
  ```js
  if (/huggingface\.co|hf-inference/.test(ep)) return 'hf';
  ```
  Order matters: HF URL must not fall through to `'openai'`.

### 4.4 Capability registry — `src/providers/base.js`

- Line 32 `ImageProfile.provider` union: add `'hf'`:
  ```js
  @property {'openai-like' | 'gemini' | 'comfyui' | 'a1111' | 'pollinations' | 'agnes' | 'hf'} provider
  ```
- `REF_CAPABILITIES` (after `agnes` entry, ~line 99): add:
  ```js
  hf: {
      strategies: ['none'],
      supportsStrategy: () => false,
      maxRefs: { none: 0 },
  },
  ```

### 4.5 UI — `src/ui/tab-api.js`

- Line 319 `<select>`: add option before `</select>`:
  ```html
  <option value="hf" ${p.apiType === 'hf' ? 'selected' : ''}>Hugging Face</option>
  ```
- `providerOptionsFields(p)` (~line 333): add `hf` block after the `pollinations` block:
  ```js
  if (p.apiType === 'hf') {
      const steps = p.providerOptions?.num_inference_steps ?? 20;
      const guidance = p.providerOptions?.guidance_scale ?? 3.5;
      const negative = escapeHtml(p.providerOptions?.negative_prompt || '');
      return `
          <div class="uris-row"><label>Steps (num_inference_steps)</label>
              <input class="text_pole uris-hf-steps" type="number" min="1" max="100" value="${steps}"></div>
          <div class="uris-row"><label>Guidance scale</label>
              <input class="text_pole uris-hf-guidance" type="number" step="0.1" min="0" max="30" value="${guidance}"></div>
          <div class="uris-row"><label>Negative prompt</label>
              <input class="text_pole uris-hf-negative" value="${negative}" placeholder="(необязательно)"></div>`;
  }
  ```
- `collectConnCard` (~line 521): the existing structure is `if (o.apiType === 'pollinations') {...} else { o.providerOptions = {}; }`. Add `hf` as an `else if` **before** the final `else`, so pollinations and hf each keep their options and all other types get `{}`:
  ```js
  if (o.apiType === 'pollinations') { /* existing */ }
  else if (o.apiType === 'hf') { /* new hf block */ }
  else { o.providerOptions = {}; }
  ```
  ```js
  if (o.apiType === 'hf') {
      const steps = parseInt(card.querySelector('.uris-hf-steps')?.value, 10);
      const guidance = parseFloat(card.querySelector('.uris-hf-guidance')?.value);
      const negative = card.querySelector('.uris-hf-negative')?.value?.trim() || '';
      o.providerOptions = {
          ...(Number.isFinite(steps) ? { num_inference_steps: steps } : {}),
          ...(Number.isFinite(guidance) ? { guidance_scale: guidance } : {}),
          ...(negative ? { negative_prompt: negative } : {}),
      };
  }
  ```
- Fetch-models button handler (~line 447): branch on apiType:
  ```js
  const conn = await getConnection(id);
  const models = conn?.apiType === 'hf'
      ? await fetchHfModels(id)
      : await fetchModels(id, 'image');
  ```
  (Import `fetchHfModels` from `../models.js`.)

### 4.6 Model discovery — `src/models.js`

Add `fetchHfModels` alongside `fetchModels`:

```js
import { autoFetch } from './proxy.js';  // add to existing imports

/**
 * Загрузить text-to-image модели с публичного Hub API Hugging Face.
 * Не требует auth. Идёт через autoFetch (CORS-прокси ST при необходимости).
 * @param {string} connId
 * @returns {Promise<string[]>} — массив id моделей (топ-50 по downloads)
 */
export async function fetchHfModels(connId) {
    const url = 'https://huggingface.co/api/models?pipeline_tag=text-to-image'
              + '&inference_provider=true&sort=downloads&direction=-1&limit=50';
    let resp;
    try {
        resp = await autoFetch(url, { method: 'GET' }, 20000);
    } catch (e) {
        warn('fetchHfModels: сетевая ошибка', e.message);
        return [];
    }
    if (!resp.ok) { warn(`fetchHfModels: HTTP ${resp.status}`); return []; }
    const { bytes, text } = await readResponseBody(resp);
    let arr;
    try { arr = JSON.parse(text || ''); }
    catch { warn('fetchHfModels: не JSON'); return []; }
    const ids = Array.isArray(arr) ? arr.map(m => m.id).filter(Boolean) : [];
    log(`fetchHfModels: получено ${ids.length} моделей`);
    await saveConnection({ id: connId, availableModels: ids, lastFetch: Date.now() });
    return ids;
}
```

`models.js:14` currently imports `{ fetchWithTimeout, log, warn, getCtx }` from `core.js`. **Add `readResponseBody`** to that import line. `saveConnection` is already imported. `autoFetch` is imported from `proxy.js` (new import line — `models.js` doesn't currently import from `proxy.js`).

---

## 5. Error Handling

| Case | Detection | Behavior |
|---|---|---|
| 503 cold-start | `resp.status === 503` | Retry up to 2× with `min(estimated_time, 30)s` pause; status callback «Модель прогревается...». Exhaustion → clear error |
| 401/403 | `resp.status` | `Error('HF API HTTP 401: неверный API-ключ (нужен токен с правом Inference Providers)')` — body appended |
| 404 | `resp.status` | Usually wrong model id or model not on hf-inference. Error includes HF's JSON message |
| 429 | `resp.status` | Rate limit / credits exhausted. Error: «превышен лимит или исчерпаны кредиты» |
| CORS block | `autoFetch` catches `TypeError: Failed to fetch` → falls back to ST proxy | If proxy disabled → `proxiedFetch` throws the standard «CORS-прокси SillyTavern выключен...» error with config instructions |
| JSON instead of image (200) | `readResponseBody` returns `mime: null` | Throw with body excerpt — happens for unsupported models returning a JSON error with 200 |
| Abort during retry sleep | `signal.aborted` in `sleep` | Throws `AbortError`, propagates — user cancel works mid-wait |
| Network error | `autoFetch` `.catch` | `Error('HF API недоступен (возможно CORS): ${e.message}')` (copy agnes pattern) |

---

## 6. Testing

Unit tests in `tests/` (existing test runner — check `tests/` structure during implementation):

**`tests/hf.test.js`:**
1. **Success — raw bytes → dataUrl**: mock `autoFetch` returning a `Response` with PNG magic bytes → `readResponseBody` yields `{bytes, mime:'image/png'}` → result `{kind:'dataUrl', value:'data:image/png;base64,...'}`. Assert `kind` and that value starts with `data:image/`.
2. **503 then success**: mock returns 503 with `{"estimated_time":2}` on first call, 200+PNG on second. Assert one retry happened, `sleep` called with ~2000ms, final result is dataUrl.
3. **503 exhausts retries**: mock returns 503 on all 3 attempts. Assert throws with «не загрузилась» message. Assert `X-Wait-For-Model: true` header was sent on each attempt.
4. **401**: mock returns 401 + `{"error":"Unauthorized"}`. Assert throws with HTTP 401 in message.
5. **200 but JSON (unsupported model)**: mock returns 200 + `{"error":"..."}` (no image mime). Assert throws with «не изображение».
6. **Abort during sleep**: signal aborts during retry pause. Assert throws `AbortError`, no further fetch.
7. **Parameters built correctly**: pass `providerOptions:{num_inference_steps:30, guidance_scale:7.5, negative_prompt:'blurry'}` and `instruction.aspectRatio:'16:9'`. Assert body JSON has `parameters:{width:1792, height:1024, num_inference_steps:30, guidance_scale:7.5, negative_prompt:'blurry'}`.
8. **Defaults applied**: empty `providerOptions`. Assert body has `num_inference_steps:20, guidance_scale:3.5` and no `negative_prompt` key.
9. **Refs ignored with warning**: pass 1 ref. Assert `warn` called, no ref in request body.

**`tests/resolveApiType.test.js`** (extend existing if present):
- `resolveApiType('https://router.huggingface.co/hf-inference', '')` → `'hf'`
- `resolveApiType('https://api-inference.huggingface.co', '')` → `'hf'`
- Existing cases unaffected (pollinations, agnes, gemini, openai fallback).

**`tests/fetchHfModels.test.js`:**
- Mock Hub API returning `[{id:'black-forest-labs/FLUX.1-dev', downloads:1000}, {id:'stabilityai/sdxl-turbo'}]`. Assert returns `['black-forest-labs/FLUX.1-dev', 'stabilityai/sdxl-turbo']`.
- Network error → returns `[]` (no throw).

**Regression:** existing provider tests must pass unchanged (new switch case, new registry entries are additive).

---

## 7. Limitations (documented, not blocking)

1. **hf-inference is CPU-only since July 2025.** Image generation is slow (30–60s+) and only ~6 image models are reliably live. Free credits ($0.10) cover ~10 generations. This is a platform reality, not a provider bug. Mitigation: the endpoint field accepts a **dedicated Inference Endpoint URL** (paid GPU, same `{inputs, parameters}` format, fast) — users wanting speed paste their endpoint URL instead of the router. No code change needed.
2. **Third-party GPU providers** (fal, replicate, together, wavespeed) are **not reachable** via raw HTTP through the router — HF's router only normalizes chat-completions; for text-to-image it does not normalize per-provider formats. Forum thread 170659 confirms 404s. Reaching them would require the `@huggingface/inference` SDK (browser bundling, breaks the raw-fetch pattern of all providers) or per-provider implementations (fal, replicate each have their own API). Out of scope for the `hf` provider; users wanting those providers should configure them directly if/when separately supported.
3. **Large aspect ratios may be unstable.** FLUX.1-dev is reported unstable above ~1.5M pixels (e.g., 1792×1024 = 1.83M for 16:9). This is model-specific and not enforceable client-side without a per-model pixel registry. The full `ASPECT_SIZE_MAP` (shared with agnes) is offered; users hitting instability should reduce size or pick a different model.
4. **`X-Wait-For-Model` may hit gateway timeout.** If model load exceeds the server's hold limit, the connection drops and the client retry takes over. The 2-retry safety net handles this, but very large cold loads (>60–90s total) may still fail. Acceptable for a credit-constrained free tier.

---

## 8. Out of Scope

- img2img / image-to-image via HF (separate task, different endpoint shape — future provider or extension of `hf`).
- `seed` / `scheduler` UI controls (YAGNI — rarely used; advanced users can't use them without a UI anyway, and adding fields has a maintenance cost).
- Per-model pixel-limit enforcement.
- Reaching third-party GPU providers (fal/replicate/together) — see limitation #2.
- Server-side key handling (server plugin pattern) — consciously chose browser+proxy for architectural consistency with all 4 existing providers; documented in brainstorming.

---

## 9. Files Touched

| File | Change |
|---|---|
| `src/providers/hf.js` | **New** — provider module (~110 lines) |
| `src/image-api.js` | +1 import, +1 switch case |
| `src/core.js` | +1 entry in `VALID_API_TYPES`, +1 rule in `resolveApiType` |
| `src/providers/base.js` | +1 union member, +1 `REF_CAPABILITIES` entry |
| `src/ui/tab-api.js` | +1 `<option>`, +1 `providerOptionsFields` branch, +1 `collectConnCard` branch, +1 fetch-button branch |
| `src/models.js` | +1 `fetchHfModels` function, +1 import (`autoFetch`/`readResponseBody`) |
| `tests/hf.test.js` | **New** — 9 unit tests |
| `tests/resolveApiType.test.js` | Extend — 2 HF cases |
| `tests/fetchHfModels.test.js` | **New** — 2 tests |

No data migration. Existing connections are forward-compatible (new `apiType` value; old conns unaffected). No changes to `connections.js` (the `apiType` validation already reads `VALID_API_TYPES`, which we extend).
