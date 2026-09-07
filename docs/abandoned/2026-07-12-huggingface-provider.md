# Hugging Face Inference Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `hf` image provider to UR Image Studio that generates images via Hugging Face's text-to-image Inference API.

**Architecture:** New ES-module provider `src/providers/hf.js` speaks HF's task REST format (`{inputs, parameters}` → raw image bytes) through the existing `autoFetch`/CORS-proxy path, consistent with `agnes`/`pollinations`. Cold-start 503 handled via `X-Wait-For-Model` header + client retries. Model discovery via public Hub API. UI fields for steps/guidance/negative_prompt.

**Tech Stack:** Vanilla JS ES-modules, `node:test` + `node:assert/strict`, SillyTavern extension APIs.

**Spec:** `docs/superpowers/specs/2026-07-12-huggingface-provider-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/providers/hf.js` | **Create** | HF provider: `generateImage`, constants, helpers (`composePrompt`, `sizeToWidthHeight`, `buildParameters`, `sleep`) |
| `tests/providers.test.js` | **Modify** | Add HF unit tests (append to existing file that tests pollinations/agnes/gemini/openai) |
| `src/core.js` | **Modify** | Add `'hf'` to `VALID_API_TYPES`; add HF rule to `resolveApiType` |
| `src/providers/base.js` | **Modify** | Add `'hf'` to `ImageProfile.provider` union; add `REF_CAPABILITIES.hf` entry |
| `src/image-api.js` | **Modify** | Add `import * as hf`; add `case 'hf':` to switch |
| `src/models.js` | **Modify** | Add `fetchHfModels` function; add imports for `autoFetch`, `readResponseBody` |
| `src/ui/tab-api.js` | **Modify** | Add `<option value="hf">`; add `providerOptionsFields` hf branch; add `collectConnCard` hf branch; add fetch-button apiType branching |
| `tests/models-hf.test.js` | **Create** | Unit tests for `fetchHfModels` |

---

## Task 1: Provider — Happy Path (success, URL, body, headers, parameters)

**Files:**
- Create: `src/providers/hf.js`
- Modify: `tests/providers.test.js` (append HF section)

- [ ] **Step 1: Write failing tests**

Append to `tests/providers.test.js`, after the existing imports (line 14 area, after `import * as openai`):

```js
import * as hf from '../src/providers/hf.js';
```

Then append the following tests at the end of the file:

```js
// ── Hugging Face ──

// PNG magic bytes for mock image responses.
const HF_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x0A]);

test('hf.generateImage builds POST to /models/{model} with inputs and parameters', async () => {
    const calls = [];
    const restore = mockFetch((url, options) => { calls.push({ url, options }); return { ok: true, arrayBuffer: async () => HF_PNG_BYTES.buffer.slice(0, HF_PNG_BYTES.byteLength) }; });
    try {
        const p = {
            endpoint: 'https://router.huggingface.co/hf-inference',
            apiKey: 'hf_test_token',
            model: 'black-forest-labs/FLUX.1-dev',
            providerOptions: { num_inference_steps: 30, guidance_scale: 7.5, negative_prompt: 'blurry' },
        };
        const instruction = { prompt: 'a cat', style: 'cinematic', aspectRatio: '16:9' };
        await hf.generateImage(p, instruction, [], () => {});
        const gen = calls.find(c => c.url.includes('huggingface.co'));
        assert.ok(gen, 'должен быть запрос к HF');
        assert.equal(gen.url, 'https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-dev');
        assert.equal(gen.options.method, 'POST');
        const body = JSON.parse(gen.options.body);
        assert.equal(body.inputs, 'cinematic a cat');
        assert.equal(body.parameters.width, 1792);
        assert.equal(body.parameters.height, 1024);
        assert.equal(body.parameters.num_inference_steps, 30);
        assert.equal(body.parameters.guidance_scale, 7.5);
        assert.equal(body.parameters.negative_prompt, 'blurry');
    } finally { restore(); }
});

test('hf.generateImage sends Bearer auth, Content-Type, Accept, X-Wait-For-Model headers', async () => {
    const calls = [];
    const restore = mockFetch((url, options) => { calls.push({ url, options }); return { ok: true, arrayBuffer: async () => HF_PNG_BYTES.buffer.slice(0, HF_PNG_BYTES.byteLength) }; });
    try {
        const p = { endpoint: 'https://router.huggingface.co/hf-inference', apiKey: 'hf_tok', model: 'FLUX.1-schnell', providerOptions: {} };
        await hf.generateImage(p, { prompt: 'x' }, [], () => {});
        const gen = calls.find(c => c.url.includes('huggingface.co'));
        assert.equal(gen.options.headers.Authorization, 'Bearer hf_tok');
        assert.equal(gen.options.headers['Content-Type'], 'application/json');
        assert.equal(gen.options.headers.Accept, 'image/png');
        assert.equal(gen.options.headers['X-Wait-For-Model'], 'true');
    } finally { restore(); }
});

test('hf.generateImage applies defaults when providerOptions is empty', async () => {
    const calls = [];
    const restore = mockFetch((url, options) => { calls.push({ url, options }); return { ok: true, arrayBuffer: async () => HF_PNG_BYTES.buffer.slice(0, HF_PNG_BYTES.byteLength) }; });
    try {
        const p = { endpoint: 'https://router.huggingface.co/hf-inference', apiKey: 'hf_tok', model: 'stabilityai/sdxl-turbo', providerOptions: {} };
        const instruction = { prompt: 'a dog', aspectRatio: '1:1' };
        await hf.generateImage(p, instruction, [], () => {});
        const gen = calls.find(c => c.url.includes('huggingface.co'));
        const body = JSON.parse(gen.options.body);
        assert.equal(body.parameters.num_inference_steps, 20);
        assert.equal(body.parameters.guidance_scale, 3.5);
        assert.equal(body.parameters.width, 1024);
        assert.equal(body.parameters.height, 1024);
        assert.equal(body.parameters.negative_prompt, undefined, 'empty negative_prompt should be omitted');
    } finally { restore(); }
});

test('hf.generateImage returns {kind:dataUrl} from raw image bytes', async () => {
    const restore = mockFetch(() => ({ ok: true, arrayBuffer: async () => HF_PNG_BYTES.buffer.slice(0, HF_PNG_BYTES.byteLength) }));
    try {
        const p = { endpoint: 'https://router.huggingface.co/hf-inference', apiKey: 'hf_tok', model: 'FLUX.1-dev', providerOptions: {} };
        const result = await hf.generateImage(p, { prompt: 'x' }, [], () => {});
        assert.equal(result.kind, 'dataUrl');
        assert.ok(result.value.startsWith('data:image/'), 'value should be a data URL');
    } finally { restore(); }
});

test('hf.generateImage strips trailing /models from endpoint if present', async () => {
    const calls = [];
    const restore = mockFetch((url, options) => { calls.push({ url, options }); return { ok: true, arrayBuffer: async () => HF_PNG_BYTES.buffer.slice(0, HF_PNG_BYTES.byteLength) }; });
    try {
        const p = { endpoint: 'https://api-inference.huggingface.co/models', apiKey: 'hf_tok', model: 'FLUX.1-dev', providerOptions: {} };
        await hf.generateImage(p, { prompt: 'x' }, [], () => {});
        const gen = calls.find(c => c.url.includes('huggingface.co'));
        assert.ok(!gen.url.includes('/models/models/'), 'must not double /models/');
        assert.ok(gen.url.endsWith('/models/FLUX.1-dev'));
    } finally { restore(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/providers.test.js`
Expected: FAIL — `Cannot find module '../src/providers/hf.js'`

- [ ] **Step 3: Write the provider implementation**

Create `src/providers/hf.js`:

```js
// @ts-check
/**
 * Hugging Face Inference provider (text-to-image).
 * Говорит на task-REST формате HF: POST {endpoint}/models/{model}
 * с телом {inputs, parameters} → сырые байты картинки.
 *
 * Auth: Bearer hf_... (токен с правом «Inference Providers»).
 * Cold-start: X-Wait-For-Model: true + клиентский ретрай по 503.
 *
 * spec: 2026-07-12-huggingface-provider-design.md
 */
import { normalizeEndpoint, readResponseBody, bytesToDataUrl, log, warn, error } from '../core.js';
import { autoFetch } from '../proxy.js';

// ── Image size mapping (shared with agnes/pollinations) ──
const ASPECT_SIZE_MAP = {
    '1:1':  '1024x1024',
    '2:3':  '1024x1536',
    '3:2':  '1536x1024',
    '3:4':  '768x1024',
    '4:3':  '1024x768',
    '4:5':  '832x1040',
    '5:4':  '1040x832',
    '9:16': '1024x1792',
    '16:9': '1792x1024',
    '21:9': '1792x768',
};
const DEFAULT_SIZE = '1024x1024';

const DEFAULT_STEPS = 20;
const DEFAULT_GUIDANCE = 3.5;
const MAX_503_RETRIES = 2;

function composePrompt(prompt, style) {
    return [style, prompt].filter(Boolean).join(' ').trim();
}

function sizeToWidthHeight(size) {
    const m = /^(\d+)x(\d+)$/.exec(size || DEFAULT_SIZE);
    if (!m) return { width: 1024, height: 1024 };
    return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

/**
 * Собрать parameters для HF из instruction.aspectRatio + p.providerOptions.
 * Применяет дефолты для незаданных полей. negative_prompt опускается если пуст.
 */
function buildParameters(p, instruction) {
    const ar = instruction.aspectRatio || '1:1';
    const size = ASPECT_SIZE_MAP[ar] || DEFAULT_SIZE;
    const { width, height } = sizeToWidthHeight(size);

    const opts = p.providerOptions || {};
    const params = { width, height };

    const steps = opts.num_inference_steps;
    if (Number.isFinite(steps)) params.num_inference_steps = steps;
    else params.num_inference_steps = DEFAULT_STEPS;

    const guidance = opts.guidance_scale;
    if (Number.isFinite(guidance)) params.guidance_scale = guidance;
    else params.guidance_scale = DEFAULT_GUIDANCE;

    const negative = (opts.negative_prompt || '').trim();
    if (negative) params.negative_prompt = negative;

    return params;
}

/**
 * Пауза с поддержкой отмены. AbortError выбрасывается немедленно.
 */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
}

/**
 * @param {import('./base.js').ImageProfile} p
 * @param {object} instruction — { prompt, style, aspectRatio }
 * @param {Array<{image:string,role:string}>} refs
 * @param {(s:string)=>void} [onStatus]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{kind: string, value: string}>} — {kind:'dataUrl', value}
 */
export async function generateImage(p, instruction, refs, onStatus, signal) {
    let base = normalizeEndpoint(p.endpoint);
    if (!base) throw new Error('HF: URL endpoint не задан');
    // Если пользователь вставил полный URL с /models — срезаем, чтобы не удвоить.
    if (base.endsWith('/models')) base = base.slice(0, -'/models'.length);

    const model = p.model;
    if (!model) throw new Error('HF: модель не выбрана');
    const url = `${base}/models/${encodeURIComponent(model)}`;

    const prompt = composePrompt(instruction.prompt || '', instruction.style || '');
    const parameters = buildParameters(p, instruction);
    const body = JSON.stringify({ inputs: prompt, parameters });

    const headers = {
        'Authorization': `Bearer ${p.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'image/png',
        'X-Wait-For-Model': 'true',
    };

    if (refs?.length) {
        warn('hf.generateImage: референсы игнорируются — text-to-image не поддерживает image-to-image');
    }

    // ── Retry loop for 503 cold-start ──
    let resp;
    for (let attempt = 0; attempt <= MAX_503_RETRIES; attempt++) {
        onStatus?.(attempt === 0 ? 'Картинка...' : `Модель загружается (попытка ${attempt + 1})...`);
        resp = await autoFetch(url, {
            method: 'POST',
            headers,
            body,
            signal,
        }, p.timeoutMs ?? 300000).catch(e => {
            error('hf.generateImage: сетевая ошибка', url, e.message);
            throw new Error(`HF API недоступен (возможно CORS): ${e.message}`);
        });

        if (resp.status === 503 && attempt < MAX_503_RETRIES) {
            const { text } = await readResponseBody(resp);
            let waitSec = 10;
            try { waitSec = Math.min(Math.max(JSON.parse(text || '{}').estimated_time || 10, 3), 30); }
            catch { /* не JSON — используем дефолт */ }
            onStatus?.(`Модель прогревается, ждём ${waitSec}с...`);
            await sleep(waitSec * 1000, signal);
            continue;
        }
        break;
    }

    // 503 исчерпан
    if (resp.status === 503) {
        throw new Error(`HF: модель не загрузилась после ${MAX_503_RETRIES + 1} попыток. Попробуйте ещё раз или выберите другую модель.`);
    }

    if (!resp.ok) {
        const { text } = await readResponseBody(resp);
        throw new Error(`HF API HTTP ${resp.status}: ${(text || '').slice(0, 300)}`);
    }

    const { bytes, mime, text } = await readResponseBody(resp);
    if (mime) {
        const dataUrl = await bytesToDataUrl(bytes, mime || 'image/png');
        return { kind: 'dataUrl', value: dataUrl };
    }
    // 200, но не image — HF вернул JSON-ошибку с 200 (бывает для неподдерживаемых моделей)
    throw new Error(`HF: неожиданный ответ (не изображение): ${(text || '').slice(0, 300)}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/providers.test.js`
Expected: PASS — all existing + 5 new HF tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/providers/hf.js tests/providers.test.js
git commit -m "feat(hf): provider happy path — POST {inputs,parameters}, raw bytes → dataUrl"
```

---

## Task 2: Provider — 503 Cold-Start Retry

**Files:**
- Modify: `tests/providers.test.js` (append 503 tests)

The retry logic is already in the implementation from Task 1. These tests verify it works correctly.

- [ ] **Step 1: Write failing tests**

Append to `tests/providers.test.js`:

```js
// ── Hugging Face: 503 cold-start retry ──

test('hf.generateImage retries on 503 with estimated_time, then succeeds', async () => {
    let callCount = 0;
    const statuses = [];
    const restore = mockFetch((url, options) => {
        callCount++;
        statuses.push({ url, status: callCount === 1 ? 503 : 200 });
        if (callCount === 1) {
            return { ok: false, status: 503, text: async () => JSON.stringify({ estimated_time: 0.001 }) };
        }
        return { ok: true, arrayBuffer: async () => HF_PNG_BYTES.buffer.slice(0, HF_PNG_BYTES.byteLength) };
    });
    try {
        const p = { endpoint: 'https://router.huggingface.co/hf-inference', apiKey: 'hf_tok', model: 'FLUX.1-dev', providerOptions: {} };
        const result = await hf.generateImage(p, { prompt: 'x' }, [], () => {});
        assert.equal(callCount, 2, 'should make exactly 2 requests (1 × 503 + 1 × success)');
        assert.equal(result.kind, 'dataUrl');
    } finally { restore(); }
});

test('hf.generateImage throws after exhausting 503 retries', async () => {
    let callCount = 0;
    const restore = mockFetch(() => {
        callCount++;
        return { ok: false, status: 503, text: async () => JSON.stringify({ estimated_time: 0.001 }) };
    });
    try {
        const p = { endpoint: 'https://router.huggingface.co/hf-inference', apiKey: 'hf_tok', model: 'FLUX.1-dev', providerOptions: {} };
        await assert.rejects(
            hf.generateImage(p, { prompt: 'x' }, [], () => {}),
            /не загрузилась после 3 попыток/,
        );
        assert.equal(callCount, 3, 'should make 3 attempts (initial + 2 retries)');
    } finally { restore(); }
});

test('hf.generateImage sends X-Wait-For-Model on every retry attempt', async () => {
    let callCount = 0;
    const headersSeen = [];
    const restore = mockFetch((url, options) => {
        callCount++;
        headersSeen.push(options.headers?.['X-Wait-For-Model']);
        if (callCount < 3) return { ok: false, status: 503, text: async () => JSON.stringify({ estimated_time: 0.001 }) };
        return { ok: true, arrayBuffer: async () => HF_PNG_BYTES.buffer.slice(0, HF_PNG_BYTES.byteLength) };
    });
    try {
        const p = { endpoint: 'https://router.huggingface.co/hf-inference', apiKey: 'hf_tok', model: 'FLUX.1-dev', providerOptions: {} };
        await hf.generateImage(p, { prompt: 'x' }, [], () => {});
        assert.deepEqual(headersSeen, ['true', 'true', 'true']);
    } finally { restore(); }
});

test('hf.generateImage abort during retry sleep throws AbortError', async () => {
    const ctrl = new AbortController();
    let callCount = 0;
    const restore = mockFetch((url, options) => {
        callCount++;
        if (callCount === 1) {
            // Abort during the sleep that follows this 503.
            setTimeout(() => ctrl.abort(), 0);
            return { ok: false, status: 503, text: async () => JSON.stringify({ estimated_time: 30 }) };
        }
        return { ok: true, arrayBuffer: async () => HF_PNG_BYTES.buffer.slice(0, HF_PNG_BYTES.byteLength) };
    });
    try {
        const p = { endpoint: 'https://router.huggingface.co/hf-inference', apiKey: 'hf_tok', model: 'FLUX.1-dev', providerOptions: {} };
        await assert.rejects(
            hf.generateImage(p, { prompt: 'x' }, [], () => {}, ctrl.signal),
            (e) => e.name === 'AbortError',
        );
        assert.equal(callCount, 1, 'should not retry after abort');
    } finally { restore(); }
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --test tests/providers.test.js`
Expected: PASS — the retry logic from Task 1 handles all 4 cases. If any fail, fix the implementation in `src/providers/hf.js`.

- [ ] **Step 3: Commit**

```bash
git add tests/providers.test.js
git commit -m "test(hf): 503 cold-start retry — success-after-retry, exhaust, X-Wait-For-Model, abort"
```

---

## Task 3: Provider — Error Handling & Edge Cases

**Files:**
- Modify: `tests/providers.test.js` (append error tests)

- [ ] **Step 1: Write failing tests**

Append to `tests/providers.test.js`:

```js
// ── Hugging Face: error handling ──

test('hf.generateImage throws on 401 with body excerpt', async () => {
    const restore = mockFetch(() => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: 'Unauthorized' }) }));
    try {
        const p = { endpoint: 'https://router.huggingface.co/hf-inference', apiKey: 'bad', model: 'FLUX.1-dev', providerOptions: {} };
        await assert.rejects(
            hf.generateImage(p, { prompt: 'x' }, [], () => {}),
            /HF API HTTP 401/,
        );
    } finally { restore(); }
});

test('hf.generateImage throws on 429 with body excerpt', async () => {
    const restore = mockFetch(() => ({ ok: false, status: 429, text: async () => JSON.stringify({ error: 'rate limited' }) }));
    try {
        const p = { endpoint: 'https://router.huggingface.co/hf-inference', apiKey: 'hf_tok', model: 'FLUX.1-dev', providerOptions: {} };
        await assert.rejects(
            hf.generateImage(p, { prompt: 'x' }, [], () => {}),
            /HF API HTTP 429/,
        );
    } finally { restore(); }
});

test('hf.generateImage throws when 200 response is JSON, not image', async () => {
    const restore = mockFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ error: 'Model not supported' }) }));
    try {
        const p = { endpoint: 'https://router.huggingface.co/hf-inference', apiKey: 'hf_tok', model: 'bad/model', providerOptions: {} };
        await assert.rejects(
            hf.generateImage(p, { prompt: 'x' }, [], () => {}),
            /не изображение/,
        );
    } finally { restore(); }
});

test('hf.generateImage warns when refs are provided but ignored', async () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    const restore = mockFetch(() => ({ ok: true, arrayBuffer: async () => HF_PNG_BYTES.buffer.slice(0, HF_PNG_BYTES.byteLength) }));
    try {
        const p = { endpoint: 'https://router.huggingface.co/hf-inference', apiKey: 'hf_tok', model: 'FLUX.1-dev', providerOptions: {} };
        await hf.generateImage(p, { prompt: 'x' }, [{ image: 'data:image/png;base64,abc', role: 'char' }], () => {});
        assert.ok(warnings.some(w => w.includes('референсы игнорируются')), 'should warn about ignored refs');
    } finally {
        console.warn = origWarn;
        restore();
    }
});

test('hf.generateImage throws on empty endpoint', async () => {
    const p = { endpoint: '', apiKey: 'hf_tok', model: 'FLUX.1-dev', providerOptions: {} };
    await assert.rejects(
        hf.generateImage(p, { prompt: 'x' }, [], () => {}),
        /URL endpoint не задан/,
    );
});

test('hf.generateImage throws on empty model', async () => {
    const p = { endpoint: 'https://router.huggingface.co/hf-inference', apiKey: 'hf_tok', model: '', providerOptions: {} };
    await assert.rejects(
        hf.generateImage(p, { prompt: 'x' }, [], () => {}),
        /модель не выбрана/,
    );
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --test tests/providers.test.js`
Expected: PASS — all error-handling paths are already in the Task 1 implementation. If any fail, fix `src/providers/hf.js`.

- [ ] **Step 3: Commit**

```bash
git add tests/providers.test.js
git commit -m "test(hf): error handling — 401, 429, JSON-not-image, refs warning, empty endpoint/model"
```

---

## Task 4: Type Registration — core.js, base.js, image-api.js

**Files:**
- Modify: `src/core.js:30` (`VALID_API_TYPES`), `src/core.js:258` (`resolveApiType`)
- Modify: `src/providers/base.js:32` (`ImageProfile.provider`), `src/providers/base.js:99` (`REF_CAPABILITIES`)
- Modify: `src/image-api.js:19` (import), `src/image-api.js:109` (switch case)
- Modify: `tests/providers.test.js` (extend resolveApiType test)

- [ ] **Step 1: Write failing tests**

In `tests/providers.test.js`, find the existing test `resolveApiType detects pollinations and agnes by endpoint` (around line 24). Add HF assertions to it:

```js
test('resolveApiType detects pollinations, agnes, hf by endpoint', () => {
    assert.equal(resolveApiType('https://image.pollinations.ai/prompt/test', ''), 'pollinations');
    assert.equal(resolveApiType('https://apihub.agnes-ai.com/v1', ''), 'agnes');
    assert.equal(resolveApiType('https://router.huggingface.co/hf-inference', ''), 'hf');
    assert.equal(resolveApiType('https://api-inference.huggingface.co', ''), 'hf');
    assert.equal(resolveApiType('https://api.openai.com/v1', ''), 'openai');
});
```

(Replace the existing test of that name — it's the same test with 2 new assertions added.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/providers.test.js`
Expected: FAIL — `resolveApiType('https://router.huggingface.co/hf-inference', '')` returns `'openai'`, not `'hf'`.

- [ ] **Step 3: Add `'hf'` to `VALID_API_TYPES`**

In `src/core.js` line 30, change:

```js
export const VALID_API_TYPES = ['auto', 'openai', 'gemini', 'pollinations', 'agnes'];
```
to:
```js
export const VALID_API_TYPES = ['auto', 'openai', 'gemini', 'pollinations', 'agnes', 'hf'];
```

- [ ] **Step 4: Add HF detection rule to `resolveApiType`**

In `src/core.js`, in the `resolveApiType` function (line 258), add the HF rule **after** the agnes check and **before** the `return 'openai'` fallback:

```js
export function resolveApiType(endpoint, model) {
    const ep = String(endpoint || '').toLowerCase();
    if (/pollinations\.ai/.test(ep)) return 'pollinations';
    if (/agnes-ai\.com/.test(ep)) return 'agnes';
    if (/huggingface\.co|hf-inference/.test(ep)) return 'hf';
    if (/generativelanguage\.googleapis\.com/.test(ep)) return 'gemini';
    if (/\/v1beta\b/.test(ep)) return 'gemini';
    const m = String(model || '').toLowerCase();
    if (/^(gemini|imagen)/.test(m)) return 'gemini';
    return 'openai';
}
```

- [ ] **Step 5: Add `'hf'` to `ImageProfile.provider` union**

In `src/providers/base.js` line 32, change:

```js
@property {'openai-like' | 'gemini' | 'comfyui' | 'a1111' | 'pollinations' | 'agnes'} provider
```
to:
```js
@property {'openai-like' | 'gemini' | 'comfyui' | 'a1111' | 'pollinations' | 'agnes' | 'hf'} provider
```

- [ ] **Step 6: Add `REF_CAPABILITIES.hf` entry**

In `src/providers/base.js`, after the `agnes` entry in `REF_CAPABILITIES` (around line 99), add:

```js
    hf: {
        strategies: ['none'],
        supportsStrategy: () => false,
        maxRefs: { none: 0 },
    },
```

- [ ] **Step 7: Add import and switch case in `image-api.js`**

In `src/image-api.js`, after line 19 (`import * as agnes from './providers/agnes.js';`), add:

```js
import * as hf from './providers/hf.js';
```

In the `switch (apiType)` block (around line 109), after `case 'agnes':`, add:

```js
            case 'hf':
                return await hf.generateImage(profile, instruction, preparedRefs, onStatus, signal);
```

- [ ] **Step 8: Run all tests to verify they pass**

Run: `node --test tests/providers.test.js`
Expected: PASS — resolveApiType test passes, all provider tests pass.

- [ ] **Step 9: Run full test suite for regression check**

Run: `node --test tests/`
Expected: PASS — no regressions in existing tests.

- [ ] **Step 10: Commit**

```bash
git add src/core.js src/providers/base.js src/image-api.js tests/providers.test.js
git commit -m "feat(hf): register provider type — VALID_API_TYPES, resolveApiType, REF_CAPABILITIES, dispatcher case"
```

---

## Task 5: Model Discovery — fetchHfModels

**Files:**
- Modify: `src/models.js` (add `fetchHfModels`, add imports)
- Create: `tests/models-hf.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/models-hf.test.js`:

```js
// @ts-check
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, installStGlobals } from './_helpers.js';

installStGlobals();

import { _resetCache, clearHostStrategy } from '../src/proxy.js';
import { fetchHfModels } from '../src/models.js';

beforeEach(() => { _resetCache(); clearHostStrategy(); });

// Мок localforage для saveConnection.
const memoryStore = new Map();
globalThis.SillyTavern = {
    getContext: () => ({
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
    }),
    libs: {
        localforage: {
            getItem: async (k) => memoryStore.get(k) || null,
            setItem: async (k, v) => memoryStore.set(k, v),
            removeItem: async (k) => memoryStore.delete(k),
        },
    },
};

beforeEach(() => { memoryStore.clear(); });

test('fetchHfModels returns model ids from Hub API response', async () => {
    const restore = mockFetch((url) => {
        if (url.includes('huggingface.co/api/models')) {
            return {
                ok: true,
                text: async () => JSON.stringify([
                    { id: 'black-forest-labs/FLUX.1-dev', downloads: 100000 },
                    { id: 'stabilityai/sdxl-turbo', downloads: 50000 },
                    { id: 'stabilityai/stable-diffusion-xl-base-1.0', downloads: 40000 },
                ]),
            };
        }
        return { ok: true };
    });
    try {
        const ids = await fetchHfModels('test-conn-1');
        assert.deepEqual(ids, [
            'black-forest-labs/FLUX.1-dev',
            'stabilityai/sdxl-turbo',
            'stabilityai/stable-diffusion-xl-base-1.0',
        ]);
    } finally { restore(); }
});

test('fetchHfModels returns empty array on network error', async () => {
    const restore = mockFetch(() => { throw new TypeError('Failed to fetch'); });
    try {
        const ids = await fetchHfModels('test-conn-2');
        assert.deepEqual(ids, []);
    } finally { restore(); }
});

test('fetchHfModels returns empty array on non-JSON response', async () => {
    const restore = mockFetch(() => ({ ok: true, text: async () => 'not json' }));
    try {
        const ids = await fetchHfModels('test-conn-3');
        assert.deepEqual(ids, []);
    } finally { restore(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/models-hf.test.js`
Expected: FAIL — `fetchHfModels` is not exported from `models.js`.

- [ ] **Step 3: Add imports to `models.js`**

In `src/models.js` line 14, the current import is:

```js
import { fetchWithTimeout, log, warn, getCtx } from './core.js';
```

Change to:

```js
import { fetchWithTimeout, log, warn, getCtx, readResponseBody } from './core.js';
import { autoFetch } from './proxy.js';
```

Also add `saveConnection` to the existing import from `./connections.js` if not already there. Check line 15:

```js
import { getConnection, saveConnection } from './connections.js';
```

(If `saveConnection` is already imported — it is, per `models.js:15` — no change needed.)

- [ ] **Step 4: Add `fetchHfModels` function**

Append to `src/models.js` (after the `fetchModels` function, at the end of the file):

```js
// ── HF model discovery via public Hub API ──

/**
 * Загрузить text-to-image модели с публичного Hub API Hugging Face.
 * Не требует auth. Идёт через autoFetch (CORS-прокси ST при необходимости).
 *
 * HF не имеет OpenAI-совместимого /v1/models для text-to-image, поэтому
 * штатный fetchModels (через chat-completions/status) не работает. Вместо
 * этого используем Hub API: /api/models?pipeline_tag=text-to-image&inference_provider=true
 *
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
    if (!resp.ok) {
        warn(`fetchHfModels: HTTP ${resp.status}`);
        return [];
    }
    const { text } = await readResponseBody(resp);
    let arr;
    try { arr = JSON.parse(text || ''); }
    catch { warn('fetchHfModels: не JSON'); return []; }
    const ids = Array.isArray(arr) ? arr.map(m => m.id).filter(Boolean) : [];
    log(`fetchHfModels: получено ${ids.length} моделей`);
    await saveConnection({ id: connId, availableModels: ids, lastFetch: Date.now() });
    return ids;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/models-hf.test.js`
Expected: PASS — all 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/models.js tests/models-hf.test.js
git commit -m "feat(hf): model discovery via public Hub API — fetchHfModels"
```

---

## Task 6: UI Integration — tab-api.js

**Files:**
- Modify: `src/ui/tab-api.js` (4 edits: option, providerOptionsFields, collectConnCard, fetch-button branching)

This task has no unit tests — `tab-api.js` is DOM-rendering code and the existing test suite doesn't cover it. Verification is by code inspection + manual smoke test.

- [ ] **Step 1: Add `<option value="hf">` to the API type select**

In `src/ui/tab-api.js`, in the `imageConnFields` function (line 319 area), the `<select class="text_pole uris-apiType">` currently ends with:

```html
            <option value="agnes" ${p.apiType === 'agnes' ? 'selected' : ''}>Agnes AI</option></select></div>
```

Change to:

```html
            <option value="agnes" ${p.apiType === 'agnes' ? 'selected' : ''}>Agnes AI</option>
            <option value="hf" ${p.apiType === 'hf' ? 'selected' : ''}>Hugging Face</option></select></div>
```

- [ ] **Step 2: Add HF parameter fields to `providerOptionsFields`**

In `src/ui/tab-api.js`, in `providerOptionsFields` (line 333 area), the function currently ends with:

```js
    return '';
}
```

Change to:

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
    return '';
}
```

- [ ] **Step 3: Add HF branch to `collectConnCard`**

In `src/ui/tab-api.js`, in `collectConnCard` (line 506 area), the current structure is:

```js
    if (o.apiType === 'pollinations') {
        // ... pollinations fields ...
    } else {
        o.providerOptions = {};
    }
    return o;
```

Change the `} else {` to `} else if (o.apiType === 'hf') {` with an hf block, keeping the final `else`:

```js
    if (o.apiType === 'pollinations') {
        const model = card.querySelector('.uris-pollinations-model')?.value ?? '';
        const noLogo = card.querySelector('.uris-pollinations-nologo')?.checked ?? true;
        const enhance = card.querySelector('.uris-pollinations-enhance')?.checked ?? false;
        o.providerOptions = {
            ...(model ? { model } : {}),
            noLogo,
            enhance,
        };
    } else if (o.apiType === 'hf') {
        const steps = parseInt(card.querySelector('.uris-hf-steps')?.value, 10);
        const guidance = parseFloat(card.querySelector('.uris-hf-guidance')?.value);
        const negative = card.querySelector('.uris-hf-negative')?.value?.trim() || '';
        o.providerOptions = {
            ...(Number.isFinite(steps) ? { num_inference_steps: steps } : {}),
            ...(Number.isFinite(guidance) ? { guidance_scale: guidance } : {}),
            ...(negative ? { negative_prompt: negative } : {}),
        };
    } else {
        o.providerOptions = {};
    }
    return o;
```

- [ ] **Step 4: Add fetch-button apiType branching**

In `src/ui/tab-api.js`, in `bindConnRows` (line 447 area), the fetch-models button handler currently calls:

```js
                const models = await fetchModels(id, 'image');
```

Change to branch on the connection's apiType:

```js
                const conn = await getConnection(id);
                const models = conn?.apiType === 'hf'
                    ? await fetchHfModels(id)
                    : await fetchModels(id, 'image');
```

- [ ] **Step 5: Add `fetchHfModels` to the imports**

At the top of `src/ui/tab-api.js`, find the existing import of `fetchModels` from `../models.js` and add `fetchHfModels`:

```js
import { fetchModels, fetchHfModels } from '../models.js';
```

- [ ] **Step 6: Run full test suite for regression check**

Run: `node --test tests/`
Expected: PASS — no regressions. (UI code is not unit-tested, but import errors would surface if any module fails to load.)

- [ ] **Step 7: Commit**

```bash
git add src/ui/tab-api.js
git commit -m "feat(hf): UI — apiType option, parameter fields (steps/guidance/negative), model fetch branching"
```

- [ ] **Step 8: Manual smoke test (optional, if ST environment available)**

1. Open SillyTavern with UR Image Studio enabled.
2. Create a new image connection: select «Hugging Face» as API type.
3. Enter endpoint: `https://router.huggingface.co/hf-inference`
4. Enter HF token (with «Inference Providers» permission) as API key.
5. Click «Загрузить модели» — verify a list of text-to-image models appears.
6. Select `black-forest-labs/FLUX.1-schnell` (fast model).
7. Enter a prompt and generate — verify an image appears in the gallery.
8. Test parameter fields: change steps to 4, guidance to 0 (schnell defaults) — verify generation still works.

---

## Self-Review Notes

**Spec coverage check:**
- §4.1 `hf.js` provider → Tasks 1-3 (happy path, retry, errors)
- §4.2 dispatcher `image-api.js` → Task 4 Step 7
- §4.3 `core.js` VALID_API_TYPES + resolveApiType → Task 4 Steps 3-4
- §4.4 `base.js` ImageProfile + REF_CAPABILITIES → Task 4 Steps 5-6
- §4.5 UI `tab-api.js` (option, fields, collect, fetch-button) → Task 6 Steps 1-5
- §4.6 `models.js` fetchHfModels → Task 5
- §5 Error handling → Task 3
- §6 Testing → Tasks 1-5 include tests; Task 6 is manual
- §7 Limitations → documented in spec, no code action needed
- §9 Files touched → all covered

**Type consistency check:**
- `fetchHfModels(connId)` — same signature in Task 5 implementation and Task 6 import
- `providerOptions.num_inference_steps / guidance_scale / negative_prompt` — consistent between Task 1 `buildParameters`, Task 6 `providerOptionsFields`, and Task 6 `collectConnCard`
- `HF_PNG_BYTES` — defined once in Task 1 test section, reused in Tasks 2-3
