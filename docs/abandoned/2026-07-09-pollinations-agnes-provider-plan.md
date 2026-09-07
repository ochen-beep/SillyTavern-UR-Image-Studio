# Pollinations.ai + Agnes AI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dedicated `pollinations` and `agnes` image providers to UR Image Studio with a reusable `providerOptions` field on image connections.

**Architecture:** Two new provider modules (`src/providers/pollinations.js`, `src/providers/agnes.js`) handle provider-specific request/response logic. The dispatcher (`src/image-api.js`) routes by `apiType` and passes `providerOptions`. `src/core.js` recognizes the new types and auto-detects them by endpoint. `src/ui/tab-api.js` renders provider-specific controls. `src/connections.js` persists `providerOptions`.

**Tech Stack:** ES modules, vanilla JS, Node.js built-in test runner (`node --test`).

---

## File map

| File | Responsibility |
|------|----------------|
| `src/providers/base.js` | `ImageProfile` typedef: add `providerOptions` field. |
| `src/connections.js` | Create/save `providerOptions` on image connections. |
| `src/core.js` | Add `pollinations`/`agnes` to `VALID_API_TYPES` and `resolveApiType`. |
| `src/image-api.js` | Import providers, pass `providerOptions`, relax key check for Pollinations, dispatch. |
| `src/providers/pollinations.js` | Native GET endpoint, query params, binary → dataUrl. |
| `src/providers/agnes.js` | OpenAI-like POST without top-level `response_format`, `return_base64: true`. |
| `src/ui/tab-api.js` | Dropdown options + Pollinations-specific fields. |
| `tests/providers.test.js` | Unit tests for provider URL/body building and response parsing. |

---

### Task 1: Update `ImageProfile` typedef in `src/providers/base.js`

**Files:**
- Modify: `src/providers/base.js:30-44`

- [ ] **Step 1: Add `providerOptions` and new provider values**

Replace the `ImageProfile` typedef block with:

```js
/**
 * @typedef {Object} ImageProfile
 * @property {string} provider       — 'openai-like' | 'gemini' | 'comfyui' | 'a1111' | 'pollinations' | 'agnes'
 * @property {string} endpoint
 * @property {string} [apiKey]
 * @property {string} model
 * @property {string} [size]         — OpenAI: '1024x1024' | '1792x1024' | ...
 * @property {string} [quality]      — OpenAI: 'standard' | 'hd'
 * @property {string} [aspectRatio]  — Gemini / Pollinations
 * @property {string} [imageSize]    — Gemini: '1K' | '2K' | '4K'
 * @property {string} [styleTemplate] — Fallback style prefix
 * @property {string} [workflowJson] — ComfyUI
 * @property {string} [textNodeId]   — ComfyUI
 * @property {string} [seedNodeId]   — ComfyUI (опц.)
 * @property {string} [outputNodeId] — ComfyUI
 * @property {string} [loadAvatarNodeId] — ComfyUI (опц.)
 * @property {Object} [providerOptions] — Провайдер-специфичные настройки (model, noLogo, enhance и т.д.)
 */
```

- [ ] **Step 2: Commit**

```bash
git add src/providers/base.js
git commit -m "feat(providers): add providerOptions to ImageProfile typedef"
```

---

### Task 2: Persist `providerOptions` in `src/connections.js`

**Files:**
- Modify: `src/connections.js:106-124`, `src/connections.js:135-154`

- [ ] **Step 1: Add default `providerOptions` in `createConnection`**

Inside `createConnection`, in the `item` object, add after `model`:

```js
        providerOptions: data.providerOptions || {},
```

The full `item` object should look like:

```js
    const item = {
        id: uid(),
        kind: 'image',
        name: data.name || 'Новый image-коннект',
        apiType: VALID_API_TYPES.includes(data.apiType) ? data.apiType : 'auto',
        endpoint: (data.endpoint || '').trim(),
        model: data.model || '',
        providerOptions: data.providerOptions || {},
        availableModels: Array.isArray(data.availableModels) ? data.availableModels : [],
        lastFetch: 0,
        secretId: '',
    };
```

- [ ] **Step 2: Allow saving `providerOptions` in `saveConnection`**

Update the field whitelist loop in `saveConnection`:

```js
    for (const k of ['kind', 'name', 'apiType', 'endpoint', 'model', 'availableModels', 'lastFetch', 'secretId', 'providerOptions']) {
```

- [ ] **Step 3: Commit**

```bash
git add src/connections.js
git commit -m "feat(connections): persist providerOptions on image connections"
```

---

### Task 3: Register new API types and auto-detection in `src/core.js`

**Files:**
- Modify: `src/core.js:28`, `src/core.js:226-233`

- [ ] **Step 1: Extend `VALID_API_TYPES`**

Change:

```js
export const VALID_API_TYPES = ['auto', 'openai', 'gemini'];
```

to:

```js
export const VALID_API_TYPES = ['auto', 'openai', 'gemini', 'pollinations', 'agnes'];
```

- [ ] **Step 2: Extend `resolveApiType`**

Update `resolveApiType` to check Pollinations/Agnes before Gemini:

```js
export function resolveApiType(endpoint, model) {
    const ep = String(endpoint || '').toLowerCase();
    if (/pollinations\.ai/.test(ep)) return 'pollinations';
    if (/agnes-ai\.com/.test(ep)) return 'agnes';
    if (/generativelanguage\.googleapis\.com/.test(ep)) return 'gemini';
    if (/\/v1beta\b/.test(ep)) return 'gemini';
    const m = String(model || '').toLowerCase();
    if (/^(gemini|imagen)/.test(m)) return 'gemini';
    return 'openai';
}
```

- [ ] **Step 3: Commit**

```bash
git add src/core.js
git commit -m "feat(core): add pollinations and agnes to VALID_API_TYPES and resolveApiType"
```

---

### Task 4: Update dispatcher in `src/image-api.js`

**Files:**
- Modify: `src/image-api.js:12-17`, `src/image-api.js:43-53`, `src/image-api.js:58-70`

- [ ] **Step 1: Import new providers**

After the existing provider imports, add:

```js
import * as pollinations from './providers/pollinations.js';
import * as agnes from './providers/agnes.js';
```

- [ ] **Step 2: Relax API-key check for Pollinations**

Change:

```js
    if (!apiKey) throw new Error('Image-коннект: API ключ не задан');
```

to:

```js
    if (!apiKey && apiType !== 'pollinations') throw new Error('Image-коннект: API ключ не задан');
```

- [ ] **Step 3: Pass `providerOptions` in profile**

In the `profile` object, add after `styleTemplate`:

```js
        providerOptions: conn.providerOptions || {},
```

The full `profile` object:

```js
    const profile = {
        provider: apiType === 'gemini' ? 'gemini' : 'openai-like',
        endpoint: conn.endpoint,
        apiKey,
        model: conn.model,
        size: imageParam?.size,
        quality: imageParam?.quality,
        aspectRatio: imageParam?.aspectRatio,
        imageSize: imageParam?.imageSize,
        styleTemplate: imageParam?.styleTemplate,
        providerOptions: conn.providerOptions || {},
    };
```

- [ ] **Step 4: Dispatch new providers**

Inside the `switch (apiType)` block, before `default`, add:

```js
            case 'pollinations':
                return await pollinations.generateImage(profile, instruction, refs, onStatus, signal);
            case 'agnes':
                return await agnes.generateImage(profile, instruction, refs, onStatus, signal);
```

- [ ] **Step 5: Commit**

```bash
git add src/image-api.js
git commit -m "feat(image-api): dispatch pollinations/agnes providers and pass providerOptions"
```

---

### Task 5: Create `src/providers/pollinations.js`

**Files:**
- Create: `src/providers/pollinations.js`

- [ ] **Step 1: Write the provider file**

Create `src/providers/pollinations.js` with:

```js
// @ts-check
/**
 * Pollinations.ai image provider.
 * Использует нативный GET-эндпоинт https://image.pollinations.ai/prompt/{encoded}.
 * Free tier работает без ключа; ключ передаётся как Authorization Bearer при наличии.
 *
 * v1: text-to-image только. Image-to-image (kontext) — в следующей итерации.
 */
import { fetchWithTimeout, normalizeEndpoint, log, error } from '../core.js';

// ── Image size mapping ──
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

function composePrompt(prompt, style) {
    return [style, prompt].filter(Boolean).join(' ').trim();
}

function sizeToWidthHeight(size) {
    const m = /^(\d+)x(\d+)$/.exec(size || DEFAULT_SIZE);
    if (!m) return { width: 1024, height: 1024 };
    return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('Pollinations: не удалось прочитать blob'));
        r.readAsDataURL(blob);
    });
}

/**
 * @param {import('./base.js').ImageProfile} p
 * @param {object} instruction — { prompt, style, aspectRatio }
 * @param {Array<{image:string,role:string}>} refs
 * @param {(s:string)=>void} [onStatus]
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} — dataUrl изображения
 */
export async function generateImage(p, instruction, refs, onStatus, signal) {
    const base = normalizeEndpoint(p.endpoint);
    if (!base) throw new Error('Pollinations: URL endpoint не задан');

    const ar = instruction.aspectRatio || p.aspectRatio || '1:1';
    const size = ASPECT_SIZE_MAP[ar] || p.size || DEFAULT_SIZE;
    const { width, height } = sizeToWidthHeight(size);

    const prompt = composePrompt(instruction.prompt, instruction.style || p.styleTemplate || '');
    const model = p.providerOptions?.model || p.model || 'flux';
    const noLogo = p.providerOptions?.noLogo !== false; // default true
    const enhance = p.providerOptions?.enhance === true;

    const params = new URLSearchParams();
    params.set('width', String(width));
    params.set('height', String(height));
    params.set('model', model);
    params.set('nologo', String(noLogo));
    if (enhance) params.set('enhance', 'true');

    const url = `${base}/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;

    if (refs.length) {
        log('pollinations.generateImage: референсы игнорируются — провайдер не поддерживает image-to-image в этой итерации');
    }

    const headers = {};
    if (p.apiKey) headers['Authorization'] = `Bearer ${p.apiKey}`;

    const resp = await fetchWithTimeout(url, {
        method: 'GET',
        headers,
        signal,
    }, 120000).catch(e => {
        error('pollinations.generateImage: сетевая ошибка', url, e.message);
        throw new Error(`Pollinations API недоступен (возможно CORS): ${e.message}`);
    });

    if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        throw new Error(`Pollinations API HTTP ${resp.status}: ${t.slice(0, 300)}`);
    }

    const blob = await resp.blob();
    return await blobToDataUrl(blob);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/providers/pollinations.js
git commit -m "feat(providers): add Pollinations.ai image provider"
```

---

### Task 6: Create `src/providers/agnes.js`

**Files:**
- Create: `src/providers/agnes.js`

- [ ] **Step 1: Write the provider file**

Create `src/providers/agnes.js` with:

```js
// @ts-check
/**
 * Agnes AI image provider.
 * OpenAI-совместимый endpoint, но НЕ принимает top-level response_format.
 * Используем return_base64: true для получения b64_json.
 *
 * v1: text-to-image только. Image-to-image — в следующей итерации.
 */
import { fetchWithTimeout, normalizeEndpoint, log, error } from '../core.js';

// ── Image size mapping ──
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

function composePrompt(prompt, style) {
    return [style, prompt].filter(Boolean).join(' ').trim();
}

async function urlToDataUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Agnes API: загрузка URL не удалась (HTTP ${resp.status})`);
    const blob = await resp.blob();
    return await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('Agnes API: не удалось прочитать blob'));
        r.readAsDataURL(blob);
    });
}

/**
 * @param {import('./base.js').ImageProfile} p
 * @param {object} instruction — { prompt, style, aspectRatio }
 * @param {Array<{image:string,role:string}>} refs
 * @param {(s:string)=>void} [onStatus]
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} — dataUrl изображения
 */
export async function generateImage(p, instruction, refs, onStatus, signal) {
    const url = `${normalizeEndpoint(p.endpoint)}/v1/images/generations`;

    const ar = instruction.aspectRatio || p.aspectRatio || '1:1';
    const size = ASPECT_SIZE_MAP[ar] || p.size || DEFAULT_SIZE;

    const body = {
        model: p.model,
        prompt: composePrompt(instruction.prompt, instruction.style || p.styleTemplate || ''),
        size,
        return_base64: true,
    };

    if (refs.length) {
        log('agnes.generateImage: референсы игнорируются — провайдер не поддерживает image-to-image в этой итерации');
    }

    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${p.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
    }, 120000).catch(e => {
        error('agnes.generateImage: сетевая ошибка', url, e.message);
        throw new Error(`Agnes API недоступен (возможно CORS): ${e.message}`);
    });

    if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        throw new Error(`Agnes API HTTP ${resp.status}: ${t.slice(0, 300)}`);
    }

    const j = await resp.json();
    const dl = j.data || [];
    if (!dl.length) {
        if (j.url) return await urlToDataUrl(j.url);
        throw new Error('Agnes API: нет данных в ответе');
    }
    if (dl[0].b64_json) return `data:image/png;base64,${dl[0].b64_json}`;
    if (dl[0].url) return await urlToDataUrl(dl[0].url);
    throw new Error('Agnes API: нет данных в ответе');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/providers/agnes.js
git commit -m "feat(providers): add Agnes AI image provider"
```

---

### Task 7: Update UI in `src/ui/tab-api.js`

**Files:**
- Modify: `src/ui/tab-api.js:236-253`, `src/ui/tab-api.js:268-293`, `src/ui/tab-api.js:343-351`

- [ ] **Step 1: Add dropdown options**

In `imageConnFields`, update the API type `<select>` to include the new options:

```html
        <div class="uris-row"><label>Тип API</label><select class="text_pole uris-apiType">
            <option value="auto" ${p.apiType === 'auto' ? 'selected' : ''}>Авто (по URL/модели)</option>
            <option value="openai" ${p.apiType === 'openai' ? 'selected' : ''}>OpenAI-compatible</option>
            <option value="gemini" ${p.apiType === 'gemini' ? 'selected' : ''}>Gemini</option>
            <option value="pollinations" ${p.apiType === 'pollinations' ? 'selected' : ''}>Pollinations.ai</option>
            <option value="agnes" ${p.apiType === 'agnes' ? 'selected' : ''}>Agnes AI</option></select></div>
```

- [ ] **Step 2: Render provider-specific fields**

Add the helper `providerOptionsFields` after `imageConnFields`:

```js
function providerOptionsFields(p) {
    if (p.apiType === 'pollinations') {
        const opts = ['flux', 'turbo', 'gptimage', 'kontext', 'seedream', 'nanobanana', 'nanobanana-pro']
            .map(m => `<option value="${escapeHtml(m)}"></option>`).join('');
        const model = escapeHtml(p.providerOptions?.model || '');
        const noLogo = p.providerOptions?.noLogo !== false ? 'checked' : '';
        const enhance = p.providerOptions?.enhance === true ? 'checked' : '';
        return `
            <div class="uris-row"><label>Модель Pollinations</label>
                <input class="text_pole uris-pollinations-model" value="${model}" list="uris-pollinations-models-${p.id}" placeholder="flux">
                <datalist id="uris-pollinations-models-${p.id}">${opts}</datalist></div>
            <div class="uris-row"><label class="checkbox_label"><input type="checkbox" class="uris-pollinations-nologo" ${noLogo}> Без watermark (nologo)</label></div>
            <div class="uris-row"><label class="checkbox_label"><input type="checkbox" class="uris-pollinations-enhance" ${enhance}> Улучшать промпт (enhance)</label></div>`;
    }
    return '';
}
```

Then insert the provider-options container into `imageConnFields` before the delete button:

```html
        <div class="uris-provider-options">${providerOptionsFields(p)}</div>
        <button class="menu_button uris-del"><i class="fa-solid fa-trash"></i> Удалить</button>
```

- [ ] **Step 3: Re-render options on apiType change**

In `bindConnRows`, inside the card loop, add after the apiKey block and before the delete button handler:

```js
        const apiTypeSelect = card.querySelector('.uris-apiType');
        apiTypeSelect?.addEventListener('change', async () => {
            const optionsHost = card.querySelector('.uris-provider-options');
            if (optionsHost) {
                optionsHost.innerHTML = providerOptionsFields({ ...p, apiType: apiTypeSelect.value, providerOptions: p.providerOptions || {} });
            }
            // Общий change-обработчик карточки сработает раньше и сохранит старые providerOptions;
            // пересохраняем сразу после перерисовки, чтобы для нового типа записались актуальные defaults.
            await saveConnection({ id, ...collect() });
        });
```

- [ ] **Step 4: Collect providerOptions**

Replace `collectConnCard` with:

```js
function collectConnCard(card) {
    const get = (cls) => card.querySelector('.' + cls)?.value ?? null;
    const o = {};
    if (card.querySelector('.uris-name')) o.name = get('uris-name');
    if (card.querySelector('.uris-apiType')) o.apiType = get('uris-apiType');
    if (card.querySelector('.uris-endpoint')) o.endpoint = get('uris-endpoint');
    if (card.querySelector('.uris-model')) o.model = get('uris-model');

    if (o.apiType === 'pollinations') {
        const model = card.querySelector('.uris-pollinations-model')?.value ?? '';
        const noLogo = card.querySelector('.uris-pollinations-nologo')?.checked ?? true;
        const enhance = card.querySelector('.uris-pollinations-enhance')?.checked ?? false;
        o.providerOptions = {
            ...(model ? { model } : {}),
            noLogo,
            enhance,
        };
    }
    return o;
}
```

- [ ] **Step 5: Commit**

```bash
git add src/ui/tab-api.js
git commit -m "feat(ui): add pollinations/agnes api types and pollinations options"
```

---

### Task 8: Add provider unit tests

**Files:**
- Create: `tests/providers.test.js`

- [ ] **Step 1: Write the test file**

Create `tests/providers.test.js`:

```js
// @ts-check
// Unit-тесты для провайдеров Pollinations и Agnes.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Мок SillyTavern и FileReader до импорта провайдеров, т.к. они тянут core.js.
before(() => {
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getRequestHeaders: () => ({}),
        }),
        libs: { localforage: { getItem: () => '', setItem: () => {}, removeItem: () => {} } },
    };
    globalThis.toastr = undefined;
    globalThis.FileReader = class MockFileReader {
        constructor() {}
        readAsDataURL(blob) {
            this.result = 'data:image/png;base64,mock';
            setTimeout(() => this.onload?.(), 0);
        }
    };
});

import * as pollinations from '../src/providers/pollinations.js';
import * as agnes from '../src/providers/agnes.js';
import { resolveApiType } from '../src/core.js';

const originalFetch = globalThis.fetch;

// ── Auto-detection ──

test('resolveApiType detects pollinations and agnes by endpoint', () => {
    assert.equal(resolveApiType('https://image.pollinations.ai/prompt/test', ''), 'pollinations');
    assert.equal(resolveApiType('https://apihub.agnes-ai.com/v1', ''), 'agnes');
    assert.equal(resolveApiType('https://api.openai.com/v1', ''), 'openai');
});

// ── Pollinations ──

test('pollinations.generateImage builds GET URL with width/height/model/nologo', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, blob: async () => ({ type: 'image/png', size: 100 }) };
    };
    try {
        const p = {
            endpoint: 'https://image.pollinations.ai',
            apiKey: '',
            model: '',
            providerOptions: { model: 'flux', noLogo: true, enhance: false },
        };
        const instruction = { prompt: 'a cat', style: 'anime', aspectRatio: '16:9' };
        await pollinations.generateImage(p, instruction, [], () => {});
        assert.equal(calls.length, 1);
        const u = new URL(calls[0].url);
        assert.equal(u.origin + u.pathname, 'https://image.pollinations.ai/prompt/a%20cat');
        assert.equal(u.searchParams.get('width'), '1792');
        assert.equal(u.searchParams.get('height'), '1024');
        assert.equal(u.searchParams.get('model'), 'flux');
        assert.equal(u.searchParams.get('nologo'), 'true');
        assert.equal(u.searchParams.get('enhance'), null);
        assert.equal(calls[0].options.headers?.Authorization, undefined);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('pollinations.generateImage sends Authorization when apiKey is set', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, blob: async () => ({ type: 'image/png', size: 100 }) };
    };
    try {
        const p = {
            endpoint: 'https://image.pollinations.ai',
            apiKey: 'pk_test',
            model: '',
            providerOptions: {},
        };
        await pollinations.generateImage(p, { prompt: 'x' }, [], () => {});
        assert.equal(calls[0].options.headers.Authorization, 'Bearer pk_test');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('pollinations.generateImage returns dataUrl from blob', async () => {
    globalThis.fetch = async () => ({ ok: true, blob: async () => ({ type: 'image/png', size: 100 }) });
    try {
        const p = { endpoint: 'https://image.pollinations.ai', apiKey: '', model: '', providerOptions: {} };
        const result = await pollinations.generateImage(p, { prompt: 'x' }, [], () => {});
        assert.equal(result, 'data:image/png;base64,mock');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ── Agnes ──

test('agnes.generateImage posts without response_format and with return_base64', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ data: [{ b64_json: 'YWJj' }] }) };
    };
    try {
        const p = {
            endpoint: 'https://apihub.agnes-ai.com',
            apiKey: 'key',
            model: 'agnes-image-2.1-flash',
            providerOptions: {},
        };
        const instruction = { prompt: 'a cat', style: 'cinematic', aspectRatio: '1:1' };
        await agnes.generateImage(p, instruction, [], () => {});
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, /\/v1\/images\/generations$/);
        const body = JSON.parse(calls[0].options.body);
        assert.equal(body.model, 'agnes-image-2.1-flash');
        assert.equal(body.prompt, 'cinematic a cat');
        assert.equal(body.size, '1024x1024');
        assert.equal(body.return_base64, true);
        assert.equal(body.response_format, undefined);
        assert.equal(calls[0].options.headers.Authorization, 'Bearer key');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('agnes.generateImage returns dataUrl from b64_json', async () => {
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ data: [{ b64_json: 'YWJj' }] }),
    });
    try {
        const p = { endpoint: 'https://apihub.agnes-ai.com', apiKey: 'k', model: 'm', providerOptions: {} };
        const result = await agnes.generateImage(p, { prompt: 'x' }, [], () => {});
        assert.equal(result, 'data:image/png;base64,YWJj');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
```

- [ ] **Step 2: Run new tests**

```bash
node --test tests/providers.test.js
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/providers.test.js
git commit -m "test(providers): add unit tests for pollinations and agnes providers"
```

---

### Task 9: Run full test suite

- [ ] **Step 1: Run all tests**

```bash
node --test tests/*.test.js
```

Expected: all existing tests still pass, new provider tests pass.

- [ ] **Step 2: Commit if any fixes were needed**

If no changes were needed, no extra commit. If fixes were made, commit them with a descriptive message.

---

### Task 10: Final review commit (optional)

- [ ] **Step 1: Review git log**

```bash
git log --oneline -10
```

- [ ] **Step 2: Confirm spec alignment**

Check that the implementation matches `docs/superpowers/specs/2026-07-09-pollinations-agnes-provider-design.md`.

---

## Self-review checklist

- [ ] **Spec coverage:** every section of the design spec has a corresponding task.
- [ ] **No placeholders:** no TBD/TODO, all code shown, all commands exact.
- [ ] **Type consistency:** `providerOptions` field name matches in base.js typedef, connections.js, image-api.js profile, tab-api.js collect, and test mocks.
- [ ] **API key handling:** Pollinations allowed without key; Agnes still requires key.
- [ ] **No top-level response_format:** confirmed in agnes.js body and test assertion.
- [ ] **Tests run:** `node --test tests/*.test.js` passes.
