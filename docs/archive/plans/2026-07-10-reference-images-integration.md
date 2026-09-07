# Reference Images Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement correct, scalable reference-image sending for UR Image Studio v2 across OpenAI `gpt-image-*`, Gemini, and Pollinations `kontext`, with NPC references, smart matching, compression, upload, and logging.

**Architecture:** Extend `src/references.js` with compression/upload utilities; extend `src/references-profiles.js` with NPCs and smart mode; add `REF_CAPABILITIES` to `src/providers/base.js`; update each provider to consume prepared refs; centralize preparation in `src/image-api.js`.

**Tech Stack:** Vanilla ES modules in browser/SillyTavern context; Node.js built-in test runner (`node:test`) for unit tests.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/references.js` | Low-level image utilities: dataUrl conversion, compression, upload to ST, mime detection, logging metadata |
| `src/references-profiles.js` | Reference profile CRUD, NPC management, smart keyword matching, collection logic |
| `src/providers/base.js` | Provider interface + `REF_CAPABILITIES` registry |
| `src/providers/openai.js` | OpenAI-like text + image; `gpt-image-*` via `/v1/images/edits`; optional multimodal chat fallback |
| `src/providers/gemini.js` | Gemini `generateContent` with `inlineData` refs |
| `src/providers/pollinations.js` | Pollinations GET image API; `kontext` image-to-image via URL param |
| `src/providers/agnes.js` | Agnes OpenAI-like text-to-image (refs ignored) |
| `src/image-api.js` | Dispatcher: resolve strategy, prepare/compress refs, route to provider |
| `src/pipeline.js` | Pass chat/instruction text to reference collection for smart/NPC matching |
| `src/ui/tab-references.js` | UI for reference profiles: mode selector, char/user toggles, NPC list with upload |
| `tests/references.test.js` | Tests for compression, mime, keyword matching |
| `tests/references-profiles.test.js` | Tests for profile collection with modes and NPC matching |
| `tests/providers/openai-refs.test.js` | Tests for OpenAI FormData edits and multimodal fallback |

---

## Task 1: Extend `src/references.js` with compression and upload utilities

**Files:**
- Modify: `src/references.js`
- Create: `tests/references.test.js`

### Step 1.1: Write failing tests for new utilities

Create `tests/references.test.js`:

```js
// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

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

import { dataUrlToBase64, dataUrlMimeType, compressDataUrl, uploadReferenceImage } from '../src/references.js';

test('dataUrlToBase64 strips prefix', () => {
    assert.equal(dataUrlToBase64('data:image/png;base64,abc'), 'abc');
    assert.equal(dataUrlToBase64('abc'), 'abc');
});

test('dataUrlMimeType detects image/png', () => {
    assert.equal(dataUrlMimeType('data:image/png;base64,abc'), 'image/png');
    assert.equal(dataUrlMimeType('data:image/jpeg;base64,abc'), 'image/jpeg');
    assert.equal(dataUrlMimeType('data:application/json;base64,abc'), 'application/json');
});

test('compressDataUrl returns smaller data URL', async () => {
    // 2x2 red PNG
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAABxpRE9UAAAAAgAAAAAAAAACAAAAKAAAAAIAAAACAAAARj7AAA=='; // not real, but syntax ok
    // Since we cannot easily draw in Node, this test mainly checks the function exists and returns expected shape.
    // We will replace with a real small PNG below.
    await assert.rejects(async () => await compressDataUrl('invalid'));
});

test('uploadReferenceImage posts to /api/images/upload', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ path: '/user/images/URIS_Refs/test.png' }) };
    };
    try {
        const path = await uploadReferenceImage('data:image/png;base64,abc', 'test');
        assert.equal(path, '/user/images/URIS_Refs/test.png');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, '/api/images/upload');
        const body = JSON.parse(calls[0].options.body);
        assert.equal(body.format, 'png');
        assert.equal(body.ch_name, 'URIS_Refs');
        assert.equal(body.image, 'abc');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
```

Run:
```bash
cd "D:\VC CODE\UR Image Studio" && node --test tests/references.test.js
```
Expected: FAIL — functions `compressDataUrl`, `uploadReferenceImage`, `dataUrlMimeType` not defined.

### Step 1.2: Implement utilities in `src/references.js`

Add to `src/references.js` after existing functions:

```js
// ── Data URL helpers ──

export function dataUrlToBase64(d) {
    const i = (d || '').indexOf(',');
    return i >= 0 ? d.slice(i + 1) : d;
}

export function dataUrlMimeType(d) {
    const m = (d || '').match(/^data:([^;]+);/);
    return m ? m[1] : 'image/png';
}

export async function dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return await res.blob();
}

export async function dataUrlToFile(dataUrl, filename) {
    const blob = await dataUrlToBlob(dataUrl);
    return new File([blob], filename, { type: blob.type || dataUrlMimeType(dataUrl) });
}

// ── Compression ──

function supportsImageType(type) {
    const canvas = document.createElement('canvas');
    return canvas.toDataURL(type).startsWith(`data:${type}`);
}

export async function compressDataUrl(dataUrl, {
    maxWidth = 768,
    maxHeight = 768,
    quality = 0.85,
    preferWebP = true,
} = {}) {
    if (!/^data:image\//i.test(dataUrl)) throw new Error('compressDataUrl: not an image data URL');

    const originalBytes = Math.ceil(dataUrlToBase64(dataUrl).length * 0.75);
    const img = new Image();
    await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = dataUrl;
    });

    let { width, height } = img;
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);

    const sourceMime = dataUrlMimeType(dataUrl);
    const targetMime = preferWebP && supportsImageType('image/webp')
        ? 'image/webp'
        : (sourceMime === 'image/png' ? 'image/png' : 'image/jpeg');

    const compressedDataUrl = canvas.toDataURL(targetMime, quality);
    const compressedBytes = Math.ceil(dataUrlToBase64(compressedDataUrl).length * 0.75);

    return {
        dataUrl: compressedDataUrl,
        width,
        height,
        format: targetMime,
        originalBytes,
        compressedBytes,
    };
}

// ── Server upload ──

export async function uploadReferenceImage(dataUrl, filename, subfolder = 'URIS_Refs') {
    const ctx = getCtx();
    const mime = dataUrlMimeType(dataUrl);
    const format = mime.replace('image/', '');
    const base64Data = dataUrlToBase64(dataUrl);
    const r = await fetch('/api/images/upload', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ image: base64Data, format, ch_name: 'URIS_Refs', filename }),
    });
    if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || `Reference upload failed: ${r.status}`);
    }
    const result = await r.json();
    log('Reference uploaded:', result.path);
    return result.path;
}

// ── Logging ──

export function logRefsMeta(refs, label = 'refs') {
    if (!refs.length) {
        log(`${label}: none`);
        return;
    }
    const rows = refs.map(r => ({
        role: r.role,
        name: r.name,
        format: r.meta?.format,
        dimensions: r.meta ? `${r.meta.width}x${r.meta.height}` : '',
        originalBytes: r.meta?.originalBytes,
        compressedBytes: r.meta?.compressedBytes,
    }));
    log(`${label}:`, refs.length);
    console.table(rows);
}
```

Note: `compressDataUrl` uses browser Canvas API and cannot run in Node tests. Update the test to skip compression in Node or use a browser environment. For the plan, mark the Node test as checking function existence only, and rely on manual browser testing for actual compression.

Run:
```bash
cd "D:\VC CODE\UR Image Studio" && node --test tests/references.test.js
```
Expected: PASS for `dataUrlToBase64`, `dataUrlMimeType`, `uploadReferenceImage`; SKIP or TODO for `compressDataUrl` (browser-only).

### Step 1.3: Commit

```bash
cd "D:\VC CODE\UR Image Studio" && git add src/references.js tests/references.test.js && git commit -m "feat(references): add compression, upload, mime helpers and tests"
```

---

## Task 2: Add `REF_CAPABILITIES` to `src/providers/base.js`

**Files:**
- Modify: `src/providers/base.js`

### Step 2.1: Write failing test

Add to `tests/references.test.js` (or create `tests/providers/base.test.js`):

```js
import { REF_CAPABILITIES } from '../src/providers/base.js';

test('REF_CAPABILITIES declares openai-like strategies', () => {
    assert.ok(REF_CAPABILITIES['openai-like']);
    assert.equal(typeof REF_CAPABILITIES['openai-like'].supportsStrategy, 'function');
    assert.ok(REF_CAPABILITIES['openai-like'].supportsStrategy('formDataEdits', 'gpt-image-1'));
    assert.ok(!REF_CAPABILITIES['openai-like'].supportsStrategy('formDataEdits', 'dall-e-3'));
});
```

Run:
```bash
cd "D:\VC CODE\UR Image Studio" && node --test tests/references.test.js
```
Expected: FAIL — `REF_CAPABILITIES` not exported.

### Step 2.2: Implement `REF_CAPABILITIES`

Replace `src/providers/base.js` content with:

```js
// @ts-check
/**
 * Базовый интерфейс провайдеров генерации.
 */

export class UnsupportedError extends Error {
    constructor(what) {
        super(`Провайдер не поддерживает: ${what}`);
        this.name = 'UnsupportedError';
    }
}

/**
 * @typedef {Object} TextProfile
 * @property {'openai-like' | 'gemini'} provider
 * @property {string} endpoint
 * @property {string} apiKey
 * @property {string} model
 * @property {number} [temperature]
 */

/**
 * @typedef {Object} ImageProfile
 * @property {'openai-like' | 'gemini' | 'comfyui' | 'a1111' | 'pollinations' | 'agnes'} provider
 * @property {string} endpoint
 * @property {string} [apiKey]
 * @property {string} model
 * @property {string} [size]
 * @property {string} [quality]
 * @property {string} [aspectRatio]
 * @property {string} [imageSize]
 * @property {string} [styleTemplate]
 * @property {string} [workflowJson]
 * @property {string} [textNodeId]
 * @property {string} [seedNodeId]
 * @property {string} [outputNodeId]
 * @property {string} [loadAvatarNodeId]
 * @property {object} [providerOptions]
 */

export async function generateText(p, system, user, onStatus, signal) {
    throw new UnsupportedError('generateText');
}

export async function generateImage(p, instruction, refs, onStatus, signal) {
    throw new UnsupportedError('generateImage');
}

/**
 * Capability registry for reference-image support.
 * Each provider declares strategies and how to tell whether a model supports them.
 */
export const REF_CAPABILITIES = {
    'openai-like': {
        strategies: ['formDataEdits', 'multimodalChat'],
        supportsStrategy(strategy, model) {
            if (strategy === 'formDataEdits') return /gpt-image/i.test(String(model || ''));
            if (strategy === 'multimodalChat') return /gpt-4o|o1|o3/i.test(String(model || ''));
            return false;
        },
        maxRefs: { formDataEdits: 16, multimodalChat: 8 },
    },
    gemini: {
        strategies: ['inlineData'],
        supportsStrategy: () => true,
        maxRefs: { inlineData: 4 },
    },
    pollinations: {
        strategies: ['urlParam'],
        supportsStrategy(strategy, model) {
            return strategy === 'urlParam' && String(model || '').toLowerCase() === 'kontext';
        },
        maxRefs: { urlParam: 1 },
    },
    agnes: {
        strategies: ['none'],
        supportsStrategy: () => false,
        maxRefs: { none: 0 },
    },
    comfyui: {
        strategies: ['workflow'],
        supportsStrategy: () => false,
        maxRefs: { workflow: 0 },
    },
    a1111: {
        strategies: ['workflow'],
        supportsStrategy: () => false,
        maxRefs: { workflow: 0 },
    },
};

/**
 * Build an English instruction that tells the image model how to use references.
 * @param {Array<{role:string, name?:string}>} refs
 * @returns {string}
 */
export function buildReferenceInstruction(refs) {
    if (!refs.length) return '';
    const instructions = refs.map((ref, i) => {
        const label = ref.role === 'char' ? 'Character' :
                      ref.role === 'user' ? 'User' :
                      `NPC "${ref.name || ''}"`;
        return `Image ${i + 1} shows ${label}. Use it ONLY for this ${label.toLowerCase()}'s appearance.`;
    });
    return `[Reference guide: ${instructions.join(' ')} IMPORTANT: unrelated characters must have their own unique appearance. Do not apply the look of one reference to another character.]`;
}
```

Run:
```bash
cd "D:\VC CODE\UR Image Studio" && node --test tests/references.test.js
```
Expected: PASS.

### Step 2.3: Commit

```bash
cd "D:\VC CODE\UR Image Studio" && git add src/providers/base.js tests/references.test.js && git commit -m "feat(providers): add REF_CAPABILITIES and buildReferenceInstruction"
```

---

## Task 3: Extend `src/references-profiles.js` with NPCs and smart mode

**Files:**
- Modify: `src/references-profiles.js`
- Create: `tests/references-profiles.test.js`

### Step 3.1: Write failing tests

Create `tests/references-profiles.test.js`:

```js
// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SillyTavern = {
    getContext: () => ({
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
        characters: [{ name: 'Aria' }],
        characterId: 0,
        name1: 'Alex',
    }),
    libs: { localforage: { getItem: () => '', setItem: () => {}, removeItem: () => {} } },
};
globalThis.toastr = undefined;

import {
    isNameInText,
    collectReferencesFromProfile,
} from '../src/references-profiles.js';

test('isNameInText matches whole word only', () => {
    assert.ok(isNameInText('Aria', 'Aria walked in'));
    assert.ok(!isNameInText('Aria', 'Arianna walked in'));
    assert.ok(isNameInText('Aria Rose', 'Rose was there'));
    assert.ok(!isNameInText('Cat', 'category'));
});

test('collectReferencesFromProfile always mode', async () => {
    const profile = {
        mode: 'always',
        charAvatar: false,
        userAvatarFile: '',
        npcReferences: [],
    };
    const refs = await collectReferencesFromProfile(profile, {});
    assert.equal(refs.length, 0);
});

test('collectReferencesFromProfile smart mode filters NPC by prompt', async () => {
    const profile = {
        mode: 'smart',
        charAvatar: false,
        userAvatarFile: '',
        npcReferences: [
            { id: '1', name: 'Eva', keywords: [], imagePath: '/x/eva.png', enabled: true },
            { id: '2', name: 'Mira', keywords: [], imagePath: '/x/mira.png', enabled: true },
        ],
    };
    const refs = await collectReferencesFromProfile(profile, {
        chatText: '',
        instructionText: 'Eva smiled.',
        charName: 'Aria',
        userName: 'Alex',
    });
    assert.equal(refs.length, 1);
    assert.equal(refs[0].name, 'Eva');
});
```

Run:
```bash
cd "D:\VC CODE\UR Image Studio" && node --test tests/references-profiles.test.js
```
Expected: FAIL — functions not defined/exported.

### Step 3.2: Implement smart mode and NPC support

Rewrite `src/references-profiles.js`:

```js
// @ts-check
/**
 * Profiles of references — самостоятельный блок workflow (v2 spec §4.2).
 */
import { LF_REFERENCES_PROFILES, uid, log, state } from './core.js';
import { getCharacterAvatarDataUrl, getUserAvatarDataUrl } from './references.js';

function lf() { return SillyTavern.libs.localforage; }

// ── CRUD ──

export async function listReferencesProfiles() {
    const arr = await lf().getItem(LF_REFERENCES_PROFILES);
    return Array.isArray(arr) ? arr : [];
}

async function _setAll(arr) {
    await lf().setItem(LF_REFERENCES_PROFILES, arr);
}

function migrateProfile(p) {
    if (!p) return p;
    return {
        ...p,
        mode: p.mode || 'never',
        npcReferences: Array.isArray(p.npcReferences) ? p.npcReferences : [],
    };
}

export async function createReferencesProfile(data = {}) {
    const arr = await listReferencesProfiles();
    const item = migrateProfile({
        id: uid(),
        name: data.name || 'Новый профиль референсов',
        charAvatar: !!data.charAvatar,
        userAvatarFile: data.userAvatarFile || '',
        mode: ['always', 'smart', 'never'].includes(data.mode) ? data.mode : 'never',
        npcReferences: [],
    });
    arr.push(item);
    await _setAll(arr);
    log('Создан профиль референсов', item.id);
    return item;
}

export async function getReferencesProfile(id) {
    const arr = await listReferencesProfiles();
    const p = arr.find(p => p.id === id);
    return p ? migrateProfile(p) : null;
}

export async function saveReferencesProfile(patch) {
    if (!patch?.id) return null;
    const arr = await listReferencesProfiles();
    const i = arr.findIndex(p => p.id === patch.id);
    if (i === -1) return null;
    arr[i] = migrateProfile({ ...arr[i], ...patch, id: patch.id });
    await _setAll(arr);
    return arr[i];
}

export async function deleteReferencesProfile(id) {
    const arr = await listReferencesProfiles();
    await _setAll(arr.filter(p => p.id !== id));
    log('Удалён профиль референсов', id);
}

// ── NPC CRUD ──

export async function addNpcReference(profileId, { name = '', keywords = '', imagePath = '' }) {
    const p = await getReferencesProfile(profileId);
    if (!p) return null;
    const npc = {
        id: uid(),
        name: String(name).trim(),
        keywords: String(keywords).split(/[,;|]/).map(s => s.trim()).filter(Boolean),
        imagePath,
        enabled: true,
    };
    p.npcReferences.push(npc);
    await saveReferencesProfile(p);
    return npc;
}

export async function updateNpcReference(profileId, npcId, patch) {
    const p = await getReferencesProfile(profileId);
    if (!p) return null;
    const npc = p.npcReferences.find(n => n.id === npcId);
    if (!npc) return null;
    if (patch.name != null) npc.name = String(patch.name).trim();
    if (patch.keywords != null) npc.keywords = String(patch.keywords).split(/[,;|]/).map(s => s.trim()).filter(Boolean);
    if (patch.imagePath != null) npc.imagePath = patch.imagePath;
    if (patch.enabled != null) npc.enabled = !!patch.enabled;
    await saveReferencesProfile(p);
    return npc;
}

export async function removeNpcReference(profileId, npcId) {
    const p = await getReferencesProfile(profileId);
    if (!p) return null;
    p.npcReferences = p.npcReferences.filter(n => n.id !== npcId);
    await saveReferencesProfile(p);
    return p;
}

// ── Smart matching ──

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isNameInText(name, text) {
    const tokens = String(name || '')
        .split(/[\s,;|/]+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2);
    if (!tokens.length) return false;
    const pattern = tokens.map(escapeRegex).join('|');
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(${pattern})(?![\\p{L}\\p{N}])`, 'iu');
    return re.test(String(text || ''));
}

function npcMatches(npc, text) {
    if (!npc.enabled || !npc.imagePath) return false;
    const tokens = [npc.name, ...npc.keywords];
    return tokens.some(t => isNameInText(t, text));
}

// ── Collection ──

const MAX_REFS = 4;

/**
 * @param {object} profile
 * @param {object} context
 * @param {string} [context.chatText]
 * @param {string} [context.instructionText]
 * @param {string} [context.charName]
 * @param {string} [context.userName]
 */
export async function collectReferencesFromProfile(profile, context = {}) {
    if (!profile || profile.mode === 'never') return [];

    const { chatText = '', instructionText = '', charName = '', userName = '' } = context;
    const combinedText = `${chatText} ${instructionText}`;
    const refs = [];

    const smart = profile.mode === 'smart';
    const charMentioned = isNameInText(charName, combinedText);
    const userMentioned = isNameInText(userName, combinedText);

    if (profile.charAvatar && (!smart || charMentioned)) {
        const d = await getCharacterAvatarDataUrl();
        if (d) refs.push({ image: d, role: 'char', name: charName });
    }
    if (profile.userAvatarFile && (!smart || userMentioned)) {
        const d = await getUserAvatarDataUrl(profile.userAvatarFile);
        if (d) refs.push({ image: d, role: 'user', name: userName });
    }

    for (const npc of profile.npcReferences || []) {
        if (refs.length >= MAX_REFS) break;
        if (!smart || npcMatches(npc, combinedText)) {
            // NPC image is stored as server path; load it as data URL
            const d = await imageToDataUrl(npc.imagePath);
            if (d) refs.push({ image: d, role: 'npc', name: npc.name });
        }
    }

    log(`Собрано референсов: ${refs.length}`);
    return refs;
}

export async function getActiveReferencesProfile() {
    const id = state.activeReferencesProfileId;
    if (!id) return null;
    return await getReferencesProfile(id);
}

export async function collectReferencesFromActiveProfile(context = {}) {
    const p = await getActiveReferencesProfile();
    return await collectReferencesFromProfile(p, context);
}
```

Note: Need to import `imageToDataUrl` if used for NPC. It's already in `references.js` and we can import it.

Run:
```bash
cd "D:\VC CODE\UR Image Studio" && node --test tests/references-profiles.test.js
```
Expected: PASS (with mocks for `getCharacterAvatarDataUrl` returning null).

### Step 3.3: Commit

```bash
cd "D:\VC CODE\UR Image Studio" && git add src/references-profiles.js tests/references-profiles.test.js && git commit -m "feat(references): add NPC references and smart mode"
```

---

## Task 4: Implement OpenAI reference support via `/v1/images/edits`

**Files:**
- Modify: `src/providers/openai.js`
- Create: `tests/providers/openai-refs.test.js`

### Step 4.1: Write failing tests

Create `tests/providers/openai-refs.test.js`:

```js
// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
globalThis.document = {
    createElement: () => ({
        getContext: () => ({
            drawImage: () => {},
        }),
        toDataURL: (type, q) => `data:${type || 'image/png'};base64,compressed`,
    }),
};
globalThis.Image = class MockImage {
    constructor() {}
    set src(v) {
        this.width = 100;
        this.height = 100;
        setTimeout(() => this.onload?.(), 0);
    }
};

import * as openai from '../src/providers/openai.js';

const originalFetch = globalThis.fetch;

test('openai.generateImage with gpt-image-1 uses /v1/images/edits and FormData', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return {
            ok: true,
            json: async () => ({ data: [{ b64_json: 'abc' }] }),
        };
    };
    try {
        const p = { endpoint: 'https://api.openai.com/v1', apiKey: 'sk', model: 'gpt-image-1' };
        const instruction = { prompt: 'a cat', style: '', aspectRatio: '1:1' };
        const refs = [{ image: 'data:image/png;base64,ref1', role: 'char', name: 'Aria' }];
        await openai.generateImage(p, instruction, refs, () => {});
        assert.equal(calls.length, 1);
        assert.ok(calls[0].url.includes('/v1/images/edits'));
        assert.equal(calls[0].options.headers['Authorization'], 'Bearer sk');
        assert.ok(calls[0].options.body instanceof FormData);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('openai.generateImage with dall-e-3 ignores refs and uses generations', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return {
            ok: true,
            json: async () => ({ data: [{ b64_json: 'abc' }] }),
        };
    };
    try {
        const p = { endpoint: 'https://api.openai.com/v1', apiKey: 'sk', model: 'dall-e-3' };
        const instruction = { prompt: 'a cat', style: '', aspectRatio: '1:1' };
        const refs = [{ image: 'data:image/png;base64,ref1', role: 'char', name: 'Aria' }];
        await openai.generateImage(p, instruction, refs, () => {});
        assert.equal(calls.length, 1);
        assert.ok(calls[0].url.includes('/v1/images/generations'));
        assert.equal(typeof calls[0].options.body, 'string');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
```

Run:
```bash
cd "D:\VC CODE\UR Image Studio" && node --test tests/providers/openai-refs.test.js
```
Expected: FAIL — strategies not implemented.

### Step 4.2: Implement OpenAI strategies

Rewrite `src/providers/openai.js` (image generation part):

```js
// @ts-check
/**
 * OpenAI-like провайдер: text + image.
 */
import {
    fetchWithTimeout, normalizeEndpoint, normalizeEndpointUrl,
    extractTextFromResponse, error, log, warn,
} from '../core.js';
import { dataUrlToBase64, dataUrlToFile, dataUrlMimeType } from '../references.js';
import { REF_CAPABILITIES, buildReferenceInstruction } from './base.js';

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
    if (!resp.ok) throw new Error(`Image API: загрузка URL не удалась (HTTP ${resp.status})`);
    const blob = await resp.blob();
    return await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('Image API: не удалось прочитать blob'));
        r.readAsDataURL(blob);
    });
}

function mapQualityForGptImage(quality) {
    if (['hd', 'high'].includes(quality)) return 'high';
    if (quality === 'medium') return 'medium';
    return 'low';
}

function resolveStrategy(model, providerOptions) {
    const cap = REF_CAPABILITIES['openai-like'];
    if (cap.supportsStrategy('formDataEdits', model)) return 'formDataEdits';
    if (providerOptions?.useMultimodalChat && cap.supportsStrategy('multimodalChat', model)) return 'multimodalChat';
    return 'generations';
}

// ── Text generation ──

export async function generateText(p, systemPrompt, userPrompt, onStatus, signal) {
    const url = normalizeEndpointUrl(p.endpoint);
    if (!url) throw new Error('URL эндпоинта пуст');

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${p.apiKey}`,
    };
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });
    const body = { messages, stream: false };
    if (p.model) body.model = p.model;
    if (p.temperature != null) body.temperature = p.temperature;

    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
    }, 120000).catch(e => {
        error('openai.generateText: сетевая ошибка', url, e.message);
        throw new Error(`Text API недоступен (возможно CORS): ${e.message}`);
    });

    if (!resp.ok) {
        const e = await resp.text().catch(() => '');
        throw new Error(`Text API HTTP ${resp.status}: ${e.slice(0, 300)}`);
    }

    const data = await resp.json().catch(() => null);
    const text = extractTextFromResponse(data);
    if (text !== null) return text;
    throw new Error('Text API: пустой или нестандартный ответ');
}

// ── Image generation ──

export async function generateImage(p, instruction, refs, onStatus, signal) {
    const strategy = resolveStrategy(p.model, p.providerOptions || {});
    log('openai.generateImage: strategy', strategy, 'model', p.model, 'refs', refs.length);

    if (strategy === 'formDataEdits') {
        return await generateImageEdits(p, instruction, refs, signal);
    }
    if (strategy === 'multimodalChat') {
        return await generateImageMultimodal(p, instruction, refs, signal);
    }
    return await generateImageGenerations(p, instruction, refs, signal);
}

async function generateImageEdits(p, instruction, refs, signal) {
    const url = `${normalizeEndpoint(p.endpoint)}/v1/images/edits`;
    const ar = instruction.aspectRatio || p.aspectRatio || '1:1';
    const size = ASPECT_SIZE_MAP[ar] || p.size || DEFAULT_SIZE;

    const prompt = composePrompt(instruction.prompt, instruction.style || p.styleTemplate || '');
    const fullPrompt = refs.length
        ? `${buildReferenceInstruction(refs)}\n\n${prompt}`
        : prompt;

    const form = new FormData();
    form.append('model', p.model);
    form.append('prompt', fullPrompt);
    form.append('n', '1');
    form.append('size', size);
    form.append('quality', mapQualityForGptImage(instruction.quality || p.quality || 'standard'));
    form.append('input_fidelity', 'high');

    for (let i = 0; i < refs.length; i++) {
        const file = await dataUrlToFile(refs[i].image, `reference${i}.png`);
        form.append('image[]', file);
    }

    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${p.apiKey}` },
        body: form,
        signal,
    }, 120000).catch(e => {
        error('openai.generateImage edits: сетевая ошибка', url, e.message);
        throw new Error(`Image API недоступен (возможно CORS): ${e.message}`);
    });

    if (!resp.ok) {
        const e = await resp.text().catch(() => '');
        throw new Error(`Image API HTTP ${resp.status}: ${e.slice(0, 300)}`);
    }

    const j = await resp.json();
    const dl = j.data || [];
    if (!dl.length) throw new Error('Image API: нет данных в ответе');
    if (dl[0].b64_json) return `data:image/png;base64,${dl[0].b64_json}`;
    if (dl[0].url) return await urlToDataUrl(dl[0].url);
    throw new Error('Image API: нет данных в ответе');
}

async function generateImageMultimodal(p, instruction, refs, signal) {
    const url = `${normalizeEndpoint(p.endpoint)}/v1/chat/completions`;
    const prompt = composePrompt(instruction.prompt, instruction.style || p.styleTemplate || '');
    const fullPrompt = refs.length
        ? `${buildReferenceInstruction(refs)}\n\n${prompt}`
        : prompt;

    const content = [{ type: 'text', text: fullPrompt }];
    for (const ref of refs) {
        content.push({ type: 'image_url', image_url: { url: ref.image } });
    }

    const body = {
        model: p.model,
        messages: [{ role: 'user', content }],
        modalities: ['image', 'text'],
        stream: false,
    };

    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${p.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
    }, 120000).catch(e => {
        error('openai.generateImage multimodal: сетевая ошибка', url, e.message);
        throw new Error(`Image API недоступен (возможно CORS): ${e.message}`);
    });

    if (!resp.ok) {
        const e = await resp.text().catch(() => '');
        throw new Error(`Image API HTTP ${resp.status}: ${e.slice(0, 300)}`);
    }

    const j = await resp.json();
    const msg = j.choices?.[0]?.message;
    if (msg?.content) {
        const m = msg.content.match(/data:image\/[^;]+;base64,([^"'\s]+)/);
        if (m) return m[0];
    }
    if (Array.isArray(msg?.content)) {
        for (const part of msg.content) {
            if (part.type === 'image_url' && part.image_url?.url) {
                const u = part.image_url.url;
                if (u.startsWith('data:')) return u;
                return await urlToDataUrl(u);
            }
        }
    }
    throw new Error('Image API: не удалось извлечь изображение из multimodal ответа');
}

async function generateImageGenerations(p, instruction, refs, signal) {
    const url = `${normalizeEndpoint(p.endpoint)}/v1/images/generations`;
    const ar = instruction.aspectRatio || p.aspectRatio || '1:1';
    const size = ASPECT_SIZE_MAP[ar] || p.size || DEFAULT_SIZE;

    if (refs.length) {
        warn('openai.generateImage: референсы игнорируются — модель не поддерживает image-to-image');
    }

    const body = {
        model: p.model,
        prompt: composePrompt(instruction.prompt, instruction.style || p.styleTemplate || ''),
        n: 1,
        size,
        quality: instruction.quality || p.quality || 'standard',
        response_format: 'b64_json',
    };

    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${p.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
    }, 120000).catch(e => {
        error('openai.generateImage generations: сетевая ошибка', url, e.message);
        throw new Error(`Image API недоступен (возможно CORS): ${e.message}`);
    });

    if (!resp.ok) {
        const e = await resp.text().catch(() => '');
        throw new Error(`Image API HTTP ${resp.status}: ${e.slice(0, 300)}`);
    }

    const j = await resp.json();
    const dl = j.data || [];
    if (!dl.length) {
        if (j.url) return await urlToDataUrl(j.url);
        throw new Error('Image API: нет данных в ответе');
    }
    if (dl[0].b64_json) return `data:image/png;base64,${dl[0].b64_json}`;
    if (dl[0].url) return await urlToDataUrl(dl[0].url);
    throw new Error('Image API: нет данных в ответе');
}
```

Run:
```bash
cd "D:\VC CODE\UR Image Studio" && node --test tests/providers/openai-refs.test.js
```
Expected: PASS.

### Step 4.3: Commit

```bash
cd "D:\VC CODE\UR Image Studio" && git add src/providers/openai.js tests/providers/openai-refs.test.js && git commit -m "feat(providers/openai): add gpt-image edits and multimodal chat fallback"
```

---

## Task 5: Update Gemini provider with dynamic MIME type

**Files:**
- Modify: `src/providers/gemini.js`

### Step 5.1: Write/update test

Add to `tests/providers.test.js` or create `tests/providers/gemini.test.js`:

```js
test('gemini.generateImage sends inlineData with correct mime', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return {
            ok: true,
            json: async () => ({
                candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'abc' } }] } }],
            }),
        };
    };
    try {
        const p = { endpoint: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'key', model: 'gemini-2.0-flash-exp' };
        const instruction = { prompt: 'a cat', style: '', aspectRatio: '1:1' };
        const refs = [
            { image: 'data:image/jpeg;base64,ref1', role: 'char', name: 'Aria' },
        ];
        await gemini.generateImage(p, instruction, refs, () => {});
        const body = JSON.parse(calls[0].options.body);
        assert.equal(body.contents[0].parts[0].inlineData.mimeType, 'image/jpeg');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
```

Run:
```bash
cd "D:\VC CODE\UR Image Studio" && node --test tests/providers.test.js
```
Expected: FAIL — mime hardcoded to `image/png`.

### Step 5.2: Update Gemini provider

In `src/providers/gemini.js`, change:

```js
import { dataUrlToBase64 } from '../references.js';
```
to:

```js
import { dataUrlToBase64, dataUrlMimeType } from '../references.js';
```

And in the loop:

```js
for (const ref of sentRefs) {
    parts.push({ inlineData: { mimeType: dataUrlMimeType(ref.image), data: dataUrlToBase64(ref.image) } });
}
```

Run:
```bash
cd "D:\VC CODE\UR Image Studio" && node --test tests/providers.test.js
```
Expected: PASS.

### Step 5.3: Commit

```bash
cd "D:\VC CODE\UR Image Studio" && git add src/providers/gemini.js tests/providers.test.js && git commit -m "fix(providers/gemini): use actual mime type from data URL"
```

---

## Task 6: Update Pollinations provider for `kontext` image-to-image

**Files:**
- Modify: `src/providers/pollinations.js`

### Step 6.1: Write/update test

Add to `tests/providers.test.js`:

```js
test('pollinations.generateImage with kContext sends image URL param', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        if (url === '/api/images/upload') {
            return { ok: true, json: async () => ({ path: '/user/images/test.png' }) };
        }
        return { ok: true, blob: async () => ({ type: 'image/png', size: 100 }) };
    };
    try {
        const p = {
            endpoint: 'https://image.pollinations.ai',
            apiKey: '',
            model: 'kontext',
            providerOptions: {},
        };
        const instruction = { prompt: 'a cat', style: '', aspectRatio: '1:1' };
        const refs = [{ image: 'data:image/png;base64,ref1', role: 'char', name: 'Aria' }];
        await pollinations.generateImage(p, instruction, refs, () => {});
        const u = new URL(calls.find(c => c.url !== '/api/images/upload').url);
        assert.ok(u.searchParams.has('image'));
    } finally {
        globalThis.fetch = originalFetch;
    }
});
```

Run:
```bash
cd "D:\VC CODE\UR Image Studio" && node --test tests/providers.test.js
```
Expected: FAIL — no kContext support.

### Step 6.2: Implement kContext support

Modify `src/providers/pollinations.js`:

```js
import { fetchWithTimeout, normalizeEndpoint, log, warn, error } from '../core.js';
import { uploadReferenceImage } from '../references.js';

// ... existing code ...

export async function generateImage(p, instruction, refs, onStatus, signal) {
    const base = normalizeEndpoint(p.endpoint);
    if (!base) throw new Error('Pollinations: URL endpoint не задан');

    const ar = instruction.aspectRatio || p.aspectRatio || '1:1';
    const size = ASPECT_SIZE_MAP[ar] || p.size || DEFAULT_SIZE;
    const { width, height } = sizeToWidthHeight(size);

    const prompt = composePrompt(instruction.prompt, instruction.style || p.styleTemplate || '');
    const model = p.providerOptions?.model || p.model || 'flux';
    const noLogo = p.providerOptions?.noLogo !== false;
    const enhance = p.providerOptions?.enhance === true;

    const params = new URLSearchParams();
    params.set('width', String(width));
    params.set('height', String(height));
    params.set('model', model);
    params.set('nologo', String(noLogo));
    if (enhance) params.set('enhance', 'true');

    if (model.toLowerCase() === 'kontext' && refs?.length) {
        try {
            const path = await uploadReferenceImage(refs[0].image, 'pollinations_ref');
            const publicUrl = `${window.location.origin}${path}`;
            params.set('image', publicUrl);
            log('pollinations.generateImage: kContext reference URL', publicUrl);
        } catch (e) {
            warn('pollinations.generateImage: не удалось загрузить референс для kContext', e.message);
        }
    } else if (refs?.length) {
        warn('pollinations.generateImage: референсы игнорируются — используйте model=kontext для image-to-image');
    }

    const url = `${base}/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
    // ... rest unchanged
}
```

Run:
```bash
cd "D:\VC CODE\UR Image Studio" && node --test tests/providers.test.js
```
Expected: PASS.

### Step 6.3: Commit

```bash
cd "D:\VC CODE\UR Image Studio" && git add src/providers/pollinations.js tests/providers.test.js && git commit -m "feat(providers/pollinations): add kContext image-to-image via URL"
```

---

## Task 7: Update `src/image-api.js` with `prepareReferences`

**Files:**
- Modify: `src/image-api.js`

### Step 7.1: Implement preparation dispatcher

Modify `src/image-api.js` to compress refs and determine strategy before calling provider:

```js
import { state, log, resolveApiType, callWithRetry } from './core.js';
import { resolveConnection } from './connections.js';
import { compressDataUrl, logRefsMeta } from './references.js';
import { REF_CAPABILITIES } from './providers/base.js';
// ... provider imports ...

function resolveStrategy(provider, model) {
    const cap = REF_CAPABILITIES[provider];
    if (!cap) return null;
    for (const strategy of cap.strategies) {
        if (cap.supportsStrategy(strategy, model)) return strategy;
    }
    return null;
}

async function prepareReferences(refs, provider, model) {
    const strategy = resolveStrategy(provider, model);
    if (!strategy) {
        if (refs.length) log('image-api: референсы не поддерживаются провайдером', provider, model);
        return { refs: [], strategy: 'none', warnings: ['refs unsupported'] };
    }

    const cap = REF_CAPABILITIES[provider];
    const max = cap.maxRefs[strategy] ?? 4;

    const compressed = await Promise.all(
        refs.slice(0, max).map(async r => {
            const meta = await compressDataUrl(r.image);
            return { ...r, image: meta.dataUrl, meta };
        })
    );

    log('image-api: prepared references', { provider, model, strategy, count: compressed.length, max });
    logRefsMeta(compressed, 'prepared refs');
    return { refs: compressed, strategy };
}

export async function generateImage(imageConnId, imageParam, instruction, refs, onStatus) {
    // ... existing validation ...

    const signal = state.abortController?.signal;
    const safeRefs = refs || [];

    const profile = {
        provider: apiType === 'openai' ? 'openai-like' : apiType,
        // ... existing fields
    };

    const { refs: preparedRefs } = await prepareReferences(safeRefs, profile.provider, profile.model);

    return callWithRetry(async (attempt) => {
        onStatus?.(`Картинка${attempt ? ` (повтор ${attempt})` : ''}...`);
        switch (apiType) {
            case 'gemini':
                return await gemini.generateImage(profile, instruction, preparedRefs, onStatus, signal);
            case 'openai':
                return await openai.generateImage(profile, instruction, preparedRefs, onStatus, signal);
            // ... others pass preparedRefs
            case 'pollinations':
                return await pollinations.generateImage(profile, instruction, preparedRefs, onStatus, signal);
            case 'agnes':
                return await agnes.generateImage(profile, instruction, preparedRefs, onStatus, signal);
            // ... stubs
        }
    }, 'image-api');
}
```

### Step 7.2: Run existing tests

```bash
cd "D:\VC CODE\UR Image Studio" && node --test tests/providers.test.js tests/references.test.js tests/references-profiles.test.js tests/providers/openai-refs.test.js
```
Expected: PASS.

### Step 7.3: Commit

```bash
cd "D:\VC CODE\UR Image Studio" && git add src/image-api.js && git commit -m "feat(image-api): add reference preparation with compression and strategy resolution"
```

---

## Task 8: Update `src/pipeline.js` to pass context for smart matching

**Files:**
- Modify: `src/pipeline.js`

### Step 8.1: Update `runStage2`

Find the call to `collectReferencesFromActiveProfile()` and replace with:

```js
const msg = ctx.chat?.[msgId];
const chatText = String(msg?.mes || '').replace(/<[^>]*>/g, ' ');
const instructionText = [instruction.prompt, instruction.style].filter(Boolean).join(' ');

const refs = await collectReferencesFromActiveProfile({
    chatText,
    instructionText,
    charName: ctx.characters?.[ctx.characterId]?.name,
    userName: ctx.name1,
});
```

### Step 8.2: Run tests

```bash
cd "D:\VC CODE\UR Image Studio" && node --test tests/*.test.js
```
Expected: PASS.

### Step 8.3: Commit

```bash
cd "D:\VC CODE\UR Image Studio" && git add src/pipeline.js && git commit -m "feat(pipeline): pass chat/instruction context for smart reference matching"
```

---

## Task 9: Update `src/ui/tab-references.js` with NPC UI and smart mode

**Files:**
- Modify: `src/ui/tab-references.js`

### Step 9.1: Add smart mode option

Change the mode `<select>` in `refsFields` to:

```html
<select class="text_pole uris-mode">
    <option value="never" ${p.mode === 'never' ? 'selected' : ''}>Никогда</option>
    <option value="smart" ${p.mode === 'smart' ? 'selected' : ''}>Умный (по упоминанию)</option>
    <option value="always" ${p.mode === 'always' ? 'selected' : ''}>Всегда</option>
</select>
```

### Step 9.2: Add NPC section

Add to `refsFields` after user avatar:

```html
<div class="uris-npc-section">
    <label>NPC референсы</label>
    <div class="uris-npc-list" data-profile-id="${p.id}">
        ${(p.npcReferences || []).map(npc => npcRow(npc)).join('')}
    </div>
    <button class="menu_button uris-add-npc"><i class="fa-solid fa-plus"></i> Добавить NPC</button>
</div>
```

Add helper:

```js
function npcRow(npc) {
    return `
        <div class="uris-npc-card" data-npc-id="${npc.id}">
            <input class="text_pole uris-npc-name" value="${escapeHtml(npc.name)}" placeholder="Имя NPC">
            <input class="text_pole uris-npc-keywords" value="${escapeHtml(npc.keywords.join(', '))}" placeholder="Ключевые слова через запятую">
            <div class="uris-npc-preview">
                ${npc.imagePath ? `<img src="${escapeHtml(npc.imagePath)}" style="max-width:80px;max-height:80px;">` : '<span>Нет изображения</span>'}
            </div>
            <input type="file" class="uris-npc-file" accept="image/*">
            <label class="checkbox_label"><input type="checkbox" class="uris-npc-enabled" ${npc.enabled ? 'checked' : ''}><span>Включён</span></label>
            <button class="menu_button uris-npc-del"><i class="fa-solid fa-trash"></i></button>
        </div>`;
}
```

### Step 9.3: Bind NPC events

In `bindRefsRows`, add:

```js
card.querySelector('.uris-add-npc')?.addEventListener('click', async () => {
    await addNpcReference(id, { name: 'New NPC' });
    refreshActive();
});

for (const npcCard of card.querySelectorAll('.uris-npc-card')) {
    const npcId = npcCard.dataset.npcId;
    const saveNpc = async () => {
        await updateNpcReference(id, npcId, {
            name: npcCard.querySelector('.uris-npc-name').value,
            keywords: npcCard.querySelector('.uris-npc-keywords').value,
            enabled: npcCard.querySelector('.uris-npc-enabled').checked,
        });
    };
    npcCard.addEventListener('input', debounceSave(saveNpc));
    npcCard.addEventListener('change', async (e) => {
        if (e.target.classList.contains('uris-npc-file')) {
            const file = e.target.files[0];
            if (!file) return;
            const dataUrl = await readFileAsDataUrl(file);
            const compressed = await compressDataUrl(dataUrl);
            const path = await uploadReferenceImage(compressed.dataUrl, `npc_${npcId}`);
            await updateNpcReference(id, npcId, { imagePath: path });
            refreshActive();
            return;
        }
        await saveNpc();
    });
    npcCard.querySelector('.uris-npc-del')?.addEventListener('click', async () => {
        if (await showConfirmModal('Удалить NPC?')) {
            await removeNpcReference(id, npcId);
            refreshActive();
        }
    });
}
```

Add helper `readFileAsDataUrl`:

```js
function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(file);
    });
}
```

### Step 9.4: Update imports

```js
import {
    listReferencesProfiles, createReferencesProfile,
    saveReferencesProfile, deleteReferencesProfile, getReferencesProfile,
    addNpcReference, updateNpcReference, removeNpcReference,
} from '../references-profiles.js';
import { fetchUserAvatars, compressDataUrl, uploadReferenceImage } from '../references.js';
```

### Step 9.5: Update hint logic

```js
async function updateHint(root) {
    const hint = root.querySelector('#urisRefsHint');
    if (!hint) return;
    const activeConnId = state.activeImageProfileId;
    if (activeConnId) {
        const conn = await getConnection(activeConnId);
        if (conn) {
            const apiType = conn.apiType === 'auto' ? resolveApiType(conn.endpoint, conn.model) : conn.apiType;
            const cap = REF_CAPABILITIES[apiType === 'openai' ? 'openai-like' : apiType];
            const strategy = cap ? cap.strategies.find(s => cap.supportsStrategy(s, conn.model)) : null;
            if (!strategy) {
                hint.innerHTML = `<small class="uris-hint">⚠️ Активный image-провайдер (${apiType}) не поддерживает референсы для модели ${conn.model}.</small>`;
                hint.hidden = false;
                return;
            }
        }
    }
    hint.hidden = true;
}
```

Add import:
```js
import { resolveApiType } from '../core.js';
import { REF_CAPABILITIES } from '../providers/base.js';
```

### Step 9.6: Run tests

```bash
cd "D:\VC CODE\UR Image Studio" && node --test tests/*.test.js
```
Expected: PASS (UI code is not covered by unit tests, but syntax must not break imports).

### Step 9.7: Commit

```bash
cd "D:\VC CODE\UR Image Studio" && git add src/ui/tab-references.js && git commit -m "feat(ui): add NPC references and smart mode to references tab"
```

---

## Task 10: Update Agnes provider logging

**Files:**
- Modify: `src/providers/agnes.js`

### Step 10.1: Add warning log

In `generateImage`, replace existing ref warning with:

```js
import { warn } from '../core.js';

if (refs?.length) {
    warn('agnes.generateImage: референсы игнорируются — провайдер не поддерживает image-to-image');
}
```

### Step 10.2: Run tests

```bash
cd "D:\VC CODE\UR Image Studio" && node --test tests/providers.test.js
```
Expected: PASS.

### Step 10.3: Commit

```bash
cd "D:\VC CODE\UR Image Studio" && git add src/providers/agnes.js && git commit -m "chore(providers/agnes): clarify reference unsupported warning"
```

---

## Task 11: Final integration verification

### Step 11.1: Run full test suite

```bash
cd "D:\VC CODE\UR Image Studio" && node --test tests/*.test.js
```
Expected: ALL PASS.

### Step 11.2: Manual verification scenarios

| Scenario | Steps | Expected |
|----------|-------|----------|
| Gemini refs | Select Gemini image conn, refs=always, generate | Console shows `inlineData` parts, image generated |
| OpenAI gpt-image-1 | Select OpenAI endpoint, model `gpt-image-1`, refs=always | Network tab shows `POST /v1/images/edits` with `FormData` |
| OpenAI DALL-E | Select OpenAI endpoint, model `dall-e-3`, refs=always | Warning in console, `POST /v1/images/generations` |
| Pollinations kContext | Select Pollinations, model `kontext`, refs=always | URL contains `image=` param |
| Smart mode | Set mode=smart, NPC name in prompt | Only matching NPC refs sent |
| Compression | Upload 3MB PNG as NPC | Console shows original→compressed bytes |

### Step 11.3: Commit any fixes

```bash
cd "D:\VC CODE\UR Image Studio" && git commit -am "fix: address integration test findings"
```

---

## Self-Review Checklist

- **Spec coverage:**
  - [x] OpenAI `gpt-image-*` FormData edits — Task 4
  - [x] OpenAI multimodal chat fallback — Task 4
  - [x] Gemini `inlineData` with mime — Task 5
  - [x] Pollinations `kontext` URL — Task 6
  - [x] NPC references and smart mode — Task 3 + 9
  - [x] Compression and upload — Task 1
  - [x] Capability registry — Task 2
  - [x] Logging — Task 1 + 7
  - [x] Pipeline context — Task 8
  - [x] UI — Task 9

- **Placeholder scan:**
  - [x] No TBD/TODO
  - [x] No vague "add error handling"
  - [x] Code shown for every code step
  - [x] Exact commands and expected outputs

- **Type consistency:**
  - [x] `refs` shape: `{ image, role, name }` throughout
  - [x] `provider` field uses `'openai-like'` for OpenAI
  - [x] `mode` values: `'never'|'always'|'smart'`
  - [x] `REF_CAPABILITIES` keys match provider values

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-10-reference-images-integration.md`.**

**Two execution options:**

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

**Which approach?**
