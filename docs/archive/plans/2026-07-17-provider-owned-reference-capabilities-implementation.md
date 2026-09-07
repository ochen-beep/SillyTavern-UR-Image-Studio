# Provider-Owned Reference Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the global reference capability matrix with provider-owned capability declarations, reusable reference serializers, one shared connection policy resolver, and consistent UI/request behavior without changing Stage 1/Stage 2 scene resolution.

**Architecture:** Provider modules declare supported reference protocols and choose their automatic protocol. A pure `reference-policy.js` combines provider capabilities with normalized per-connection settings and the application ceiling of four. `image-api.js` applies that policy only at the outbound request boundary; scene snapshots and logical `stage2Refs` stay provider-independent.

**Tech Stack:** ES modules, vanilla JavaScript, SillyTavern extension APIs, localforage connection metadata, Node.js built-in test runner (`node --test`).

**Design spec:** `docs/superpowers/specs/2026-07-17-provider-owned-reference-capabilities-design.md`

---

## File Map

### New files

- `src/providers/reference-protocols.js` — canonical protocol names and pure/narrow reference serialization helpers only; no generic HTTP client.
- `src/providers/registry.js` — normalized API-type-to-provider-module lookup used by capability and image dispatch.
- `src/reference-policy.js` — normalization of `referenceOptions` and pure effective policy resolution.
- `tests/reference-protocols.test.js` — serializer ordering, MIME, multipart, chat, and public-URL tests.
- `tests/reference-policy.test.js` — capability/connection precedence and malformed-record tests.
- `tests/connections-reference-options.test.js` — persisted connection normalization tests.

### Modified files

- `src/providers/base.js` — capability typedefs/constants; remove `REF_CAPABILITIES`; retain provider base errors and prompt guide.
- `src/providers/openai.js` — provider-owned capability/protocol decision and shared serializers; no duplicate strategy resolver.
- `src/providers/gemini.js` — capability declaration and inline-data serializer.
- `src/providers/pollinations.js` — capability declaration and one-reference URL serializer.
- `src/providers/agnes.js` — explicit deferred reference support comment/export.
- `src/providers/comfyui.js` — explicit deferred reference support comment/export.
- `src/providers/a1111.js` — explicit deferred reference support comment/export.
- `src/connections.js` — normalized `referenceOptions` on read/create/save.
- `src/image-api.js` — registry dispatch and one request-boundary policy application.
- `src/ui/tab-api.js` — connection reference mode/protocol/max controls.
- `src/ui/tab-generate.js` — shared policy status, true `N/M`, hidden picker for unsupported/deferred.
- `style.css` — small status/control styling only if existing row/status styles are insufficient.
- `tests/providers.test.js` — provider capability and routing regressions.
- `tests/references.test.js` — remove global table assertions; keep generic reference helper tests.
- `tests/tab-generate.test.js` — reference panel view-state tests.
- `tests/smoke.test.js` — import/registry smoke coverage.

### Explicitly unchanged

- `src/scene-context.js`
- `src/references.js` materialization contract
- `src/pipeline.js` Stage 1/Stage 2 logic
- generation drafts, queue, gallery, retry, download, and recovery modules

---

## Task 1: Establish Provider Capability Types and Provider Registry

**Files:**
- Modify: `src/providers/base.js:21-43,70-110`
- Create: `src/providers/registry.js`
- Modify: `tests/references.test.js:40,272-297`
- Modify: `tests/smoke.test.js`

- [ ] **Step 1: Replace global-table tests with failing base-contract tests**

In `tests/references.test.js`, remove the `REF_CAPABILITIES` import and the four tests at lines 272-297. Import these symbols from `base.js` instead:

```js
import {
    REFERENCE_STATUS,
    REFERENCE_PROTOCOL,
    deferredReferenceCapabilities,
    buildReferenceInstruction,
} from '../src/providers/base.js';
```

Add:

```js
test('reference capability constants use canonical values', () => {
    assert.deepEqual(REFERENCE_STATUS, {
        SUPPORTED: 'supported',
        UNSUPPORTED: 'unsupported',
        DEFERRED: 'deferred',
    });
    assert.deepEqual(REFERENCE_PROTOCOL, {
        MULTIPART_EDITS: 'multipart-edits',
        MULTIMODAL_CHAT: 'multimodal-chat',
        INLINE_DATA: 'inline-data',
        URL_PARAM: 'url-param',
    });
});

test('deferredReferenceCapabilities returns an isolated deferred declaration', () => {
    const first = deferredReferenceCapabilities();
    const second = deferredReferenceCapabilities();
    assert.deepEqual(first, {
        status: 'deferred',
        protocols: [],
        preferredProtocol: null,
        maxRefs: 0,
        reason: 'Работа с референсами для этого провайдера временно отложена.',
    });
    assert.notEqual(first.protocols, second.protocols);
});
```

- [ ] **Step 2: Add a failing registry smoke test**

At the end of `tests/smoke.test.js`, add:

```js
test('image provider registry resolves every current API type', async () => {
    const { getImageProvider } = await import('../src/providers/registry.js');
    for (const apiType of ['openai', 'gemini', 'pollinations', 'agnes', 'comfyui', 'a1111']) {
        const provider = getImageProvider(apiType);
        assert.equal(typeof provider.generateImage, 'function');
        assert.equal(typeof provider.getReferenceCapabilities, 'function');
    }
    assert.equal(getImageProvider('unknown'), null);
});
```

- [ ] **Step 3: Run tests and verify the missing exports/files fail**

Run:

```bash
node --test tests/references.test.js tests/smoke.test.js
```

Expected: FAIL because capability constants, deferred helper, and `registry.js` do not exist.

- [ ] **Step 4: Replace `REF_CAPABILITIES` with base contract exports**

In `src/providers/base.js`, delete `REF_CAPABILITIES` and add:

```js
export const REFERENCE_STATUS = Object.freeze({
    SUPPORTED: 'supported',
    UNSUPPORTED: 'unsupported',
    DEFERRED: 'deferred',
});

export const REFERENCE_PROTOCOL = Object.freeze({
    MULTIPART_EDITS: 'multipart-edits',
    MULTIMODAL_CHAT: 'multimodal-chat',
    INLINE_DATA: 'inline-data',
    URL_PARAM: 'url-param',
});

export const DEFERRED_REFERENCE_REASON = 'Работа с референсами для этого провайдера временно отложена.';

/**
 * @typedef {Object} ReferenceCapabilities
 * @property {'supported'|'unsupported'|'deferred'} status
 * @property {string[]} protocols
 * @property {string|null} preferredProtocol
 * @property {number|null} maxRefs
 * @property {string} reason
 */

/** @returns {ReferenceCapabilities} */
export function deferredReferenceCapabilities() {
    return {
        status: REFERENCE_STATUS.DEFERRED,
        protocols: [],
        preferredProtocol: null,
        maxRefs: 0,
        reason: DEFERRED_REFERENCE_REASON,
    };
}
```

Extend `ImageProfile` with request-scoped protocol metadata:

```js
 * @property {string|null} [referenceProtocol] - Protocol resolved once at request dispatch.
```

- [ ] **Step 5: Add temporary provider capability exports needed by the registry**

Before creating the registry, add minimal exports to each provider so imports stay executable. These are expanded in later tasks.

In `src/providers/openai.js`:

```js
export function getReferenceCapabilities() {
    return {
        status: 'supported',
        protocols: ['multipart-edits', 'multimodal-chat'],
        preferredProtocol: null,
        maxRefs: null,
        reason: '',
    };
}
```

In `src/providers/gemini.js`:

```js
export function getReferenceCapabilities() {
    return {
        status: 'supported',
        protocols: ['inline-data'],
        preferredProtocol: 'inline-data',
        maxRefs: null,
        reason: '',
    };
}
```

In `src/providers/pollinations.js`:

```js
export function getReferenceCapabilities() {
    return {
        status: 'unsupported',
        protocols: ['url-param'],
        preferredProtocol: null,
        maxRefs: 1,
        reason: 'Выбранная модель Pollinations не принимает референсы.',
    };
}
```

In each of `agnes.js`, `comfyui.js`, and `a1111.js`, import `deferredReferenceCapabilities` and add:

```js
// Работа с референсами для этого провайдера временно отложена.
export const getReferenceCapabilities = deferredReferenceCapabilities;
```

- [ ] **Step 6: Create the provider registry**

Create `src/providers/registry.js`:

```js
// @ts-check
import * as openai from './openai.js';
import * as gemini from './gemini.js';
import * as pollinations from './pollinations.js';
import * as agnes from './agnes.js';
import * as comfyui from './comfyui.js';
import * as a1111 from './a1111.js';

export const IMAGE_PROVIDERS = Object.freeze({
    openai,
    gemini,
    pollinations,
    agnes,
    comfyui,
    a1111,
});

export function getImageProvider(apiType) {
    return IMAGE_PROVIDERS[apiType] || null;
}
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --test tests/references.test.js tests/smoke.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit the contract slice**

```bash
git add src/providers/base.js src/providers/registry.js src/providers/openai.js src/providers/gemini.js src/providers/pollinations.js src/providers/agnes.js src/providers/comfyui.js src/providers/a1111.js tests/references.test.js tests/smoke.test.js
git commit -m "refactor: move reference capabilities into providers"
```

---

## Task 2: Add Reusable Reference Protocol Serializers

**Files:**
- Create: `src/providers/reference-protocols.js`
- Create: `tests/reference-protocols.test.js`
- Reuse: `src/references.js:30-94,159-180`

- [ ] **Step 1: Write failing serializer tests**

Create `tests/reference-protocols.test.js`:

```js
// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals, mockFetch } from './_helpers.js';

installStGlobals();
globalThis.window = { location: { origin: 'http://localhost:8000' } };

const {
    encodeMultipartEditFiles,
    encodeMultimodalImageParts,
    encodeInlineDataParts,
    encodePublicReferenceUrl,
} = await import('../src/providers/reference-protocols.js');

const REFS = [
    { image: 'data:image/png;base64,AAAA', role: 'char', name: 'Aria' },
    { image: 'data:image/jpeg;base64,BBBB', role: 'npc', name: 'Borin' },
];

test('multipart serializer preserves order and creates named files', async () => {
    const files = await encodeMultipartEditFiles(REFS);
    assert.deepEqual(files.map(file => file.name), ['reference1.png', 'reference2.jpg']);
    assert.deepEqual(files.map(file => file.type), ['image/png', 'image/jpeg']);
});

test('multimodal serializer preserves image data URLs', () => {
    assert.deepEqual(encodeMultimodalImageParts(REFS), [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } },
    ]);
});

test('inline-data serializer preserves MIME and payload', () => {
    assert.deepEqual(encodeInlineDataParts(REFS), [
        { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
        { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } },
    ]);
});

test('public URL serializer uploads exactly one retained reference', async () => {
    const calls = [];
    const restore = mockFetch((url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ path: '/user/images/pollinations_ref.png' }) };
    });
    try {
        const url = await encodePublicReferenceUrl([REFS[0]], 'pollinations_ref');
        assert.equal(url, 'http://localhost:8000/user/images/pollinations_ref.png');
        assert.equal(calls.filter(call => call.url === '/api/images/upload').length, 1);
    } finally { restore(); }
});

test('public URL serializer rejects zero or multiple references', async () => {
    await assert.rejects(() => encodePublicReferenceUrl([], 'x'), /exactly one/i);
    await assert.rejects(() => encodePublicReferenceUrl(REFS, 'x'), /exactly one/i);
});
```

- [ ] **Step 2: Run the test and verify module-not-found failure**

Run:

```bash
node --test tests/reference-protocols.test.js
```

Expected: FAIL because `reference-protocols.js` does not exist.

- [ ] **Step 3: Implement the serializer module**

Create `src/providers/reference-protocols.js`:

```js
// @ts-check
import {
    dataUrlMimeType,
    dataUrlToBase64,
    dataUrlToFile,
    uploadReferenceImage,
} from '../references.js';

function extensionForMime(mime) {
    if (mime === 'image/jpeg') return 'jpg';
    if (mime === 'image/webp') return 'webp';
    if (mime === 'image/gif') return 'gif';
    return 'png';
}

export async function encodeMultipartEditFiles(refs) {
    return Promise.all((refs || []).map((ref, index) => {
        const mime = dataUrlMimeType(ref.image);
        return dataUrlToFile(ref.image, `reference${index + 1}.${extensionForMime(mime)}`);
    }));
}

export function encodeMultimodalImageParts(refs) {
    return (refs || []).map(ref => ({
        type: 'image_url',
        image_url: { url: ref.image },
    }));
}

export function encodeInlineDataParts(refs) {
    return (refs || []).map(ref => ({
        inlineData: {
            mimeType: dataUrlMimeType(ref.image),
            data: dataUrlToBase64(ref.image),
        },
    }));
}

export async function encodePublicReferenceUrl(refs, filename) {
    if (!Array.isArray(refs) || refs.length !== 1) {
        throw new Error('URL reference protocol requires exactly one reference');
    }
    const path = await uploadReferenceImage(refs[0].image, filename);
    return `${window.location.origin}${path}`;
}
```

- [ ] **Step 4: Run serializer and existing helper tests**

Run:

```bash
node --test tests/reference-protocols.test.js tests/references.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit serializers**

```bash
git add src/providers/reference-protocols.js tests/reference-protocols.test.js
git commit -m "feat: add reusable reference protocol serializers"
```

---

## Task 3: Normalize Per-Connection Reference Options

**Files:**
- Modify: `src/connections.js:108-187`
- Create: `tests/connections-reference-options.test.js`

- [ ] **Step 1: Write failing normalization tests**

Create `tests/connections-reference-options.test.js` using an in-memory localforage stub before importing `connections.js`:

```js
// @ts-check
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.SillyTavern = {
    getContext: () => ({ getRequestHeaders: () => ({}) }),
    libs: { localforage: {
        getItem: async key => store.get(key) ?? null,
        setItem: async (key, value) => { store.set(key, value); },
        removeItem: async key => { store.delete(key); },
    } },
};

const {
    normalizeReferenceOptions,
    createConnection,
    listConnections,
    saveConnection,
} = await import('../src/connections.js');

beforeEach(() => store.clear());

test('normalizeReferenceOptions supplies backward-compatible auto defaults', () => {
    assert.deepEqual(normalizeReferenceOptions(undefined), {
        mode: 'auto', protocol: null, maxRefs: null,
    });
});

test('normalizeReferenceOptions validates mode, protocol, and max', () => {
    assert.deepEqual(normalizeReferenceOptions({ mode: 'custom', protocol: 'inline-data', maxRefs: 9 }), {
        mode: 'custom', protocol: 'inline-data', maxRefs: 4,
    });
    assert.deepEqual(normalizeReferenceOptions({ mode: 'bad', protocol: 3, maxRefs: -1 }), {
        mode: 'auto', protocol: null, maxRefs: null,
    });
});

test('new connections persist normalized reference options', async () => {
    const conn = await createConnection({ referenceOptions: { mode: 'off', maxRefs: 2 } });
    assert.deepEqual(conn.referenceOptions, { mode: 'off', protocol: null, maxRefs: 2 });
    assert.deepEqual((await listConnections())[0].referenceOptions, conn.referenceOptions);
});

test('saveConnection accepts and normalizes referenceOptions without changing providerOptions', async () => {
    const conn = await createConnection({ providerOptions: { noLogo: true } });
    const saved = await saveConnection({
        id: conn.id,
        referenceOptions: { mode: 'custom', protocol: 'url-param', maxRefs: 1 },
    });
    assert.deepEqual(saved.referenceOptions, { mode: 'custom', protocol: 'url-param', maxRefs: 1 });
    assert.deepEqual(saved.providerOptions, { noLogo: true });
});
```

- [ ] **Step 2: Run test and verify missing export/default failures**

Run:

```bash
node --test tests/connections-reference-options.test.js
```

Expected: FAIL because `normalizeReferenceOptions` and persistence support do not exist.

- [ ] **Step 3: Implement connection option normalization**

In `src/connections.js`, add near CRUD helpers:

```js
const REFERENCE_MODES = new Set(['auto', 'off', 'custom']);
const REFERENCE_PROTOCOLS = new Set(['multipart-edits', 'multimodal-chat', 'inline-data', 'url-param']);
const MAX_CONNECTION_REFS = 4;

export function normalizeReferenceOptions(value) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const mode = REFERENCE_MODES.has(input.mode) ? input.mode : 'auto';
    const protocol = typeof input.protocol === 'string' && REFERENCE_PROTOCOLS.has(input.protocol)
        ? input.protocol
        : null;
    const numericMax = Number(input.maxRefs);
    const maxRefs = Number.isInteger(numericMax) && numericMax > 0
        ? Math.min(numericMax, MAX_CONNECTION_REFS)
        : null;
    return {
        mode,
        protocol: mode === 'custom' ? protocol : null,
        maxRefs,
    };
}
```

Update `listConnections()` result:

```js
referenceOptions: normalizeReferenceOptions(c.referenceOptions),
```

Update `createConnection()`:

```js
referenceOptions: normalizeReferenceOptions(data.referenceOptions),
```

Add `referenceOptions` to the `saveConnection()` allow-list and normalize it in the loop exactly as `providerOptions` is normalized:

```js
if (k === 'referenceOptions') {
    next[k] = normalizeReferenceOptions(patch[k]);
    continue;
}
```

- [ ] **Step 4: Run connection tests**

Run:

```bash
node --test tests/connections-reference-options.test.js tests/data-port.test.js
```

Expected: PASS; export/import tests continue to accept connection metadata.

- [ ] **Step 5: Commit connection schema**

```bash
git add src/connections.js tests/connections-reference-options.test.js
git commit -m "feat: persist connection reference options"
```

---

## Task 4: Implement the Single Effective Reference Policy Resolver

**Files:**
- Create: `src/reference-policy.js`
- Create: `tests/reference-policy.test.js`
- Read/reuse: `src/providers/registry.js`, `src/connections.js`, `src/refs-library.js:16`

- [ ] **Step 1: Write failing pure policy tests**

Create `tests/reference-policy.test.js`:

```js
// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReferencePolicy } from '../src/reference-policy.js';

function provider(capabilities) {
    return { getReferenceCapabilities: () => capabilities };
}

const supported = {
    status: 'supported',
    protocols: ['inline-data'],
    preferredProtocol: 'inline-data',
    maxRefs: null,
    reason: '',
};

test('auto uses provider protocol and application ceiling', () => {
    assert.deepEqual(resolveReferencePolicy({}, {}, provider(supported)), {
        supported: true,
        status: 'supported',
        protocol: 'inline-data',
        maxRefs: 4,
        reason: '',
        source: 'provider',
    });
});

test('off wins over supported provider', () => {
    const policy = resolveReferencePolicy({ referenceOptions: { mode: 'off' } }, {}, provider(supported));
    assert.equal(policy.supported, false);
    assert.equal(policy.maxRefs, 0);
    assert.equal(policy.source, 'connection-off');
});

test('known provider and connection limits can only reduce max', () => {
    const cap = { ...supported, maxRefs: 3 };
    assert.equal(resolveReferencePolicy({ referenceOptions: { maxRefs: 2 } }, {}, provider(cap)).maxRefs, 2);
});

test('custom requires a protocol declared by the provider', () => {
    const ok = resolveReferencePolicy({ referenceOptions: { mode: 'custom', protocol: 'inline-data' } }, {}, provider(supported));
    assert.equal(ok.supported, true);
    assert.equal(ok.source, 'connection-custom');
    assert.throws(
        () => resolveReferencePolicy({ referenceOptions: { mode: 'custom', protocol: 'url-param' } }, {}, provider(supported)),
        /not available/i,
    );
});

test('unsupported and deferred capabilities return a visible reason', () => {
    for (const status of ['unsupported', 'deferred']) {
        const policy = resolveReferencePolicy({}, {}, provider({
            status, protocols: [], preferredProtocol: null, maxRefs: 0, reason: `reason-${status}`,
        }));
        assert.equal(policy.supported, false);
        assert.equal(policy.maxRefs, 0);
        assert.equal(policy.reason, `reason-${status}`);
    }
});

test('supported declaration without preferred protocol is rejected in auto mode', () => {
    assert.throws(
        () => resolveReferencePolicy({}, {}, provider({ ...supported, preferredProtocol: null })),
        /preferred protocol/i,
    );
});
```

- [ ] **Step 2: Run and verify module-not-found failure**

Run:

```bash
node --test tests/reference-policy.test.js
```

Expected: FAIL because `reference-policy.js` does not exist.

- [ ] **Step 3: Implement the policy resolver**

Create `src/reference-policy.js`:

```js
// @ts-check
import { normalizeReferenceOptions } from './connections.js';
import { MAX_REFS } from './refs-library.js';

function positiveLimit(value) {
    return Number.isInteger(value) && value > 0 ? value : null;
}

export function resolveReferencePolicy(conn, profile, providerModule) {
    if (!providerModule || typeof providerModule.getReferenceCapabilities !== 'function') {
        throw new Error('Image provider does not declare reference capabilities');
    }
    const options = normalizeReferenceOptions(conn?.referenceOptions);
    const capabilities = providerModule.getReferenceCapabilities(profile);

    if (options.mode === 'off') {
        return {
            supported: false,
            status: capabilities.status,
            protocol: null,
            maxRefs: 0,
            reason: 'Референсы выключены в настройках соединения.',
            source: 'connection-off',
        };
    }

    let protocol = capabilities.preferredProtocol;
    let source = 'provider';
    if (options.mode === 'custom') {
        if (!options.protocol || !capabilities.protocols.includes(options.protocol)) {
            throw new Error(`Reference protocol is not available for this provider: ${options.protocol || '(empty)'}`);
        }
        protocol = options.protocol;
        source = 'connection-custom';
    } else if (capabilities.status !== 'supported') {
        return {
            supported: false,
            status: capabilities.status,
            protocol: null,
            maxRefs: 0,
            reason: capabilities.reason || 'Провайдер не принимает референсы.',
            source,
        };
    }

    if (!protocol || !capabilities.protocols.includes(protocol)) {
        throw new Error('Provider reference capabilities have no valid preferred protocol');
    }

    const limits = [MAX_REFS];
    const providerMax = positiveLimit(capabilities.maxRefs);
    const connectionMax = positiveLimit(options.maxRefs);
    if (providerMax !== null) limits.push(providerMax);
    if (connectionMax !== null) limits.push(connectionMax);

    return {
        supported: true,
        status: capabilities.status,
        protocol,
        maxRefs: Math.min(...limits),
        reason: '',
        source,
    };
}
```

- [ ] **Step 4: Run policy tests**

Run:

```bash
node --test tests/reference-policy.test.js tests/connections-reference-options.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit policy resolver**

```bash
git add src/reference-policy.js tests/reference-policy.test.js
git commit -m "feat: resolve effective reference delivery policy"
```

---

## Task 5: Make Existing Providers Own Capabilities and Use Shared Serializers

**Files:**
- Modify: `src/providers/openai.js:10-14,77-99,159-188,220-239`
- Modify: `src/providers/gemini.js:10-13,117-151`
- Modify: `src/providers/pollinations.js:9-12,38-92`
- Modify: `src/providers/agnes.js:1-10`
- Modify: `src/providers/comfyui.js:1-10`
- Modify: `src/providers/a1111.js:1-10`
- Modify: `tests/providers.test.js`

- [ ] **Step 1: Write failing provider capability tests**

Add to `tests/providers.test.js`:

```js
test('openai owns automatic and custom reference protocols', () => {
    const edits = openai.getReferenceCapabilities({ model: 'gpt-image-1', proxyAvailable: false, providerOptions: {} });
    assert.equal(edits.preferredProtocol, 'multipart-edits');
    assert.deepEqual(edits.protocols, ['multipart-edits', 'multimodal-chat']);
    assert.equal(edits.maxRefs, null);

    const chat = openai.getReferenceCapabilities({ model: 'gpt-4o', proxyAvailable: true, providerOptions: {} });
    assert.equal(chat.preferredProtocol, 'multimodal-chat');

    const unknown = openai.getReferenceCapabilities({ model: 'future-gateway-model', proxyAvailable: false, providerOptions: {} });
    assert.equal(unknown.status, 'unsupported');
    assert.deepEqual(unknown.protocols, ['multipart-edits', 'multimodal-chat']);
});

test('gemini publishes inline-data with documented 2.5 guidance', () => {
    assert.equal(gemini.getReferenceCapabilities({ model: 'gemini-2.5-flash-image' }).maxRefs, 3);
    assert.equal(gemini.getReferenceCapabilities({ model: 'gemini-3-pro-image' }).maxRefs, null);
    assert.equal(gemini.getReferenceCapabilities({ model: 'future-gemini-image' }).preferredProtocol, 'inline-data');
});

test('pollinations supports URL reference only for effective kontext model', () => {
    const kontext = pollinations.getReferenceCapabilities({ model: 'flux', providerOptions: { model: 'kontext' } });
    assert.equal(kontext.status, 'supported');
    assert.equal(kontext.preferredProtocol, 'url-param');
    assert.equal(kontext.maxRefs, 1);

    const flux = pollinations.getReferenceCapabilities({ model: 'flux', providerOptions: {} });
    assert.equal(flux.status, 'unsupported');
    assert.deepEqual(flux.protocols, ['url-param']);
});

test('agnes comfyui and a1111 declare reference work deferred', async () => {
    const comfyui = await import('../src/providers/comfyui.js');
    const a1111 = await import('../src/providers/a1111.js');
    for (const module of [agnes, comfyui, a1111]) {
        const cap = module.getReferenceCapabilities({});
        assert.equal(cap.status, 'deferred');
        assert.deepEqual(cap.protocols, []);
        assert.match(cap.reason, /временно отложена/i);
    }
});
```

- [ ] **Step 2: Run and verify capability tests fail on temporary implementations**

Run:

```bash
node --test tests/providers.test.js
```

Expected: FAIL on model-specific OpenAI, Gemini, and Pollinations expectations.

- [ ] **Step 3: Implement OpenAI provider-owned capability resolution**

In `src/providers/openai.js`, remove the `REF_CAPABILITIES` import. Import `REFERENCE_PROTOCOL`, `REFERENCE_STATUS`, and serializer helpers:

```js
import { REFERENCE_PROTOCOL, REFERENCE_STATUS, buildReferenceInstruction } from './base.js';
import { encodeMultipartEditFiles, encodeMultimodalImageParts } from './reference-protocols.js';
```

Replace the temporary capability export and old `resolveStrategy` with:

```js
export function getReferenceCapabilities(p = {}) {
    const model = String(p.model || '');
    const protocols = [REFERENCE_PROTOCOL.MULTIPART_EDITS, REFERENCE_PROTOCOL.MULTIMODAL_CHAT];
    let preferredProtocol = null;

    if (p.providerOptions?.useMultimodalChat && /gpt-4o|o1|o3/i.test(model)) {
        preferredProtocol = REFERENCE_PROTOCOL.MULTIMODAL_CHAT;
    } else if (p.proxyAvailable === true && /gpt-4o|o1|o3/i.test(model)) {
        preferredProtocol = REFERENCE_PROTOCOL.MULTIMODAL_CHAT;
    } else if (/gpt-image/i.test(model)) {
        preferredProtocol = REFERENCE_PROTOCOL.MULTIPART_EDITS;
    } else if (/gpt-4o|o1|o3/i.test(model)) {
        preferredProtocol = REFERENCE_PROTOCOL.MULTIMODAL_CHAT;
    }

    return {
        status: preferredProtocol ? REFERENCE_STATUS.SUPPORTED : REFERENCE_STATUS.UNSUPPORTED,
        protocols,
        preferredProtocol,
        maxRefs: null,
        reason: preferredProtocol ? '' : 'Для этой OpenAI-compatible модели не выбран протокол референсов.',
    };
}
```

Update `generateImage` to consume the request-scoped protocol and never resolve it again:

```js
export async function generateImage(p, instruction, refs, onStatus, signal) {
    if (refs?.length && p.referenceProtocol === REFERENCE_PROTOCOL.MULTIPART_EDITS) {
        return generateImageEdits(p, instruction, refs, onStatus, signal);
    }
    if (refs?.length && p.referenceProtocol === REFERENCE_PROTOCOL.MULTIMODAL_CHAT) {
        return generateImageMultimodal(p, instruction, refs, onStatus, signal);
    }
    return generateImageGenerations(p, instruction, refs, onStatus, signal);
}
```

In `generateImageEdits`, replace per-ref `dataUrlToFile` calls with:

```js
const files = await encodeMultipartEditFiles(refs || []);
for (const file of files) form.append('image[]', file);
```

In `generateImageMultimodal`, replace the loop with:

```js
content.push(...encodeMultimodalImageParts(refs || []));
```

- [ ] **Step 4: Implement Gemini and Pollinations capabilities/serializers**

In `gemini.js`, import constants and `encodeInlineDataParts`; replace its temporary capability export with:

```js
export function getReferenceCapabilities(p = {}) {
    const model = String(p.model || '').toLowerCase();
    return {
        status: REFERENCE_STATUS.SUPPORTED,
        protocols: [REFERENCE_PROTOCOL.INLINE_DATA],
        preferredProtocol: REFERENCE_PROTOCOL.INLINE_DATA,
        maxRefs: model.includes('gemini-2.5-flash-image') ? 3 : null,
        reason: '',
    };
}
```

Replace its local `refs.slice(0, 4)` and inline-data loop with:

```js
const sentRefs = refs || [];
const parts = encodeInlineDataParts(sentRefs);
```

In `pollinations.js`, import constants and `encodePublicReferenceUrl`; replace its temporary capability export with:

```js
export function getReferenceCapabilities(p = {}) {
    const model = String(p.providerOptions?.model || p.model || 'flux').toLowerCase();
    const supported = model === 'kontext';
    return {
        status: supported ? REFERENCE_STATUS.SUPPORTED : REFERENCE_STATUS.UNSUPPORTED,
        protocols: [REFERENCE_PROTOCOL.URL_PARAM],
        preferredProtocol: supported ? REFERENCE_PROTOCOL.URL_PARAM : null,
        maxRefs: 1,
        reason: supported ? '' : 'Pollinations принимает референс только в модели kontext.',
    };
}
```

Replace its upload block with:

```js
if (refs?.length && p.referenceProtocol === REFERENCE_PROTOCOL.URL_PARAM) {
    try {
        params.set('image', await encodePublicReferenceUrl(refs, 'pollinations_ref'));
    } catch (e) {
        throw new Error(`Pollinations: failed to upload reference image for kontext: ${e.message}`);
    }
} else if (refs?.length) {
    warn('pollinations.generateImage: refs are ignored — no URL reference protocol selected');
}
```

- [ ] **Step 5: Keep deferred providers explicit**

Confirm `agnes.js`, `comfyui.js`, and `a1111.js` each contain this exact comment next to their export:

```js
// Работа с референсами для этого провайдера временно отложена.
export const getReferenceCapabilities = deferredReferenceCapabilities;
```

Do not add any request fields, img2img paths, ControlNet, IPAdapter, or workflows.

- [ ] **Step 6: Run provider and serializer tests**

Run:

```bash
node --test tests/providers.test.js tests/reference-protocols.test.js tests/references.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit provider implementations**

```bash
git add src/providers/openai.js src/providers/gemini.js src/providers/pollinations.js src/providers/agnes.js src/providers/comfyui.js src/providers/a1111.js tests/providers.test.js
git commit -m "refactor: let providers select reference protocols"
```

---

## Task 6: Wire Policy and Registry at the Image Request Boundary

**Files:**
- Modify: `src/image-api.js:9-55,66-134`
- Create: `tests/image-api-references.test.js`
- Verify unchanged: `src/pipeline.js:389-438`, `src/references.js:183-203`

- [ ] **Step 1: Write failing request-boundary tests**

Create `tests/image-api-references.test.js`. Stub the connection store and providers through real module behavior; use Pollinations and mock fetch so the assertions inspect the request:

```js
// @ts-check
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals, mockFetch } from './_helpers.js';

installStGlobals();
const { state, LF_CONNECTIONS } = await import('../src/core.js');
const { generateImageRequest } = await import('../src/image-api.js');

const refs = [
    { id: 'a', role: 'char', name: 'A', dataUrl: 'data:image/png;base64,AAAA' },
    { id: 'b', role: 'npc', name: 'B', dataUrl: 'data:image/png;base64,BBBB' },
];

beforeEach(async () => {
    state.abortController = null;
    await SillyTavern.libs.localforage.setItem(LF_CONNECTIONS, []);
});

async function setConnection(conn) {
    await SillyTavern.libs.localforage.setItem(LF_CONNECTIONS, [{
        id: 'img', kind: 'image', name: 'Image', endpoint: 'https://image.pollinations.ai',
        model: 'kontext', apiType: 'pollinations', providerOptions: { model: 'kontext' },
        referenceOptions: { mode: 'auto', protocol: null, maxRefs: null },
        ...conn,
    }]);
}

const request = {
    prompt: 'scene', aspectRatio: '1:1', imageSize: '1K', quality: 'auto', references: refs,
};

test('request boundary applies provider max before provider invocation', async () => {
    await setConnection({});
    const calls = [];
    const restore = mockFetch((url, options) => {
        calls.push({ url, options });
        if (url === '/api/images/upload') return { ok: true, json: async () => ({ path: '/ref.png' }) };
        return { ok: true, blob: async () => ({ type: 'image/png', size: 1 }) };
    });
    try {
        await generateImageRequest('img', request);
        assert.equal(calls.filter(call => call.url === '/api/images/upload').length, 1);
    } finally { restore(); }
});

test('connection off sends text-only request without uploading references', async () => {
    await setConnection({ referenceOptions: { mode: 'off' } });
    const calls = [];
    const restore = mockFetch((url, options) => {
        calls.push({ url, options });
        return { ok: true, blob: async () => ({ type: 'image/png', size: 1 }) };
    });
    try {
        await generateImageRequest('img', request);
        assert.equal(calls.some(call => call.url === '/api/images/upload'), false);
    } finally { restore(); }
});

test('custom protocol is propagated to provider profile', async () => {
    await setConnection({
        model: 'future-kontext',
        providerOptions: { model: 'future-kontext' },
        referenceOptions: { mode: 'custom', protocol: 'url-param', maxRefs: 1 },
    });
    const restore = mockFetch((url) => {
        if (url === '/api/images/upload') return { ok: true, json: async () => ({ path: '/custom.png' }) };
        return { ok: true, blob: async () => ({ type: 'image/png', size: 1 }) };
    });
    try {
        await assert.doesNotReject(() => generateImageRequest('img', request));
    } finally { restore(); }
});
```

If the existing `installStGlobals` localforage implementation is not writable across imports, replace it in this test with the in-memory map pattern from Task 3 before importing `core.js` and `image-api.js`.

- [ ] **Step 2: Run and verify the tests fail under the old global matrix**

Run:

```bash
node --test tests/image-api-references.test.js
```

Expected: FAIL because custom/off policy is not applied and dispatch still reads `REF_CAPABILITIES`.

- [ ] **Step 3: Replace image-api imports and remove old preparation strategy**

In `src/image-api.js`:

- remove all direct provider imports;
- remove `REF_CAPABILITIES` import;
- import `MAX_REFS` only if needed for warning text, not strategy;
- import `getImageProvider` from `./providers/registry.js`;
- import `resolveReferencePolicy` from `./reference-policy.js`.

Delete `resolveStrategy()` and change `prepareReferences` signature to:

```js
async function prepareReferences(refs, policy, providerLabel) {
    if (!policy.supported) {
        if (refs.length) {
            log('image-api: reference delivery disabled', {
                provider: providerLabel,
                count: refs.length,
                reason: policy.reason,
            });
            if (typeof toastr !== 'undefined' && toastr?.warning) {
                toastr.warning(`${policy.reason} ${refs.length} референс(а/ов) не отправлены.`);
            }
        }
        return [];
    }

    if (refs.length > policy.maxRefs && typeof toastr !== 'undefined' && toastr?.warning) {
        toastr.warning(`Из ${refs.length} референсов будут отправлены первые ${policy.maxRefs}`);
    }
    const retained = refs.slice(0, policy.maxRefs);
    return Promise.all(retained.map(async ref => {
        const meta = await compressDataUrl(ref.image);
        return { ...ref, image: meta.dataUrl, meta };
    }));
}
```

- [ ] **Step 4: Resolve provider and policy once inside `generateImageRequest`**

After resolving `apiType`, add:

```js
const providerModule = getImageProvider(apiType);
if (!providerModule) throw new Error(`Неизвестный тип API: ${apiType}`);
```

After profile construction:

```js
const referencePolicy = resolveReferencePolicy(conn, profile, providerModule);
profile.referenceProtocol = referencePolicy.protocol;
const preparedRefs = await prepareReferences(safeRefs, referencePolicy, apiType);
```

Replace the entire provider switch in the retry callback with:

```js
return providerModule.generateImage(profile, instruction, preparedRefs, onStatus, useSignal);
```

Keep `callWithRetry(..., 'image-api', 'generation')`, status callbacks, abort signal, timeout, and result return unchanged.

- [ ] **Step 5: Run focused image boundary and pipeline tests**

Run:

```bash
node --test tests/image-api-references.test.js tests/providers.test.js tests/pipeline-scene-first.test.js tests/pipeline-stage2-serialization.test.js tests/image-recovery.test.js tests/retry-policy.test.js
```

Expected: PASS. The pipeline tests prove scene resolution/materialization and recovery contracts remain intact.

- [ ] **Step 6: Add a pipeline isolation regression**

In `tests/pipeline-scene-first.test.js`, add a pure regression near existing Stage 2 reference tests:

```js
test('reference delivery policy does not mutate Stage 2 logical references', async () => {
    const resolution = await resolvePromptReferenceContext({
        prompt: 'Aria and Borin',
        candidates: [
            { id: 'a', name: 'Aria', aliases: ['Aria'], role: 'char', imagePath: '/a.png' },
            { id: 'b', name: 'Borin', aliases: ['Borin'], role: 'npc', imagePath: '/b.png' },
        ],
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });
    const before = structuredClone(resolution.stage2Refs);
    const provider = { getReferenceCapabilities: () => ({
        status: 'supported', protocols: ['url-param'], preferredProtocol: 'url-param', maxRefs: 1, reason: '',
    }) };
    const policy = resolveReferencePolicy({}, {}, provider);
    assert.equal(policy.maxRefs, 1);
    assert.deepEqual(resolution.stage2Refs, before);
    assert.equal(resolution.stage2Refs.length, 2);
});
```

Add the required imports from `scene-context.js` and `reference-policy.js`.

- [ ] **Step 7: Re-run pipeline isolation tests**

Run:

```bash
node --test tests/pipeline-scene-first.test.js tests/pool-only-resolver.test.js tests/scene-context.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit request-boundary integration**

```bash
git add src/image-api.js tests/image-api-references.test.js tests/pipeline-scene-first.test.js
git commit -m "refactor: apply reference policy at image dispatch"
```

---

## Task 7: Add Reference Settings to Connection UI

**Files:**
- Modify: `src/ui/tab-api.js:305-350,420-540`
- Modify: `style.css`
- Create: `tests/tab-api-reference-options.test.js`

- [ ] **Step 1: Export pure UI helpers and write failing tests**

Create `tests/tab-api-reference-options.test.js` with the same minimal document/SillyTavern stubs used by `tests/tab-generate.test.js`, then import exported helpers:

```js
// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Install the same document/window/SillyTavern stubs as tests/tab-generate.test.js before import.
const { referenceOptionsFields, readReferenceOptions } = await import('../src/ui/tab-api.js');

test('referenceOptionsFields renders auto, off, custom and max controls', () => {
    const html = referenceOptionsFields({
        apiType: 'gemini', model: 'gemini-3-pro-image', referenceOptions: { mode: 'auto', maxRefs: null },
    });
    assert.match(html, /uris-reference-mode/);
    assert.match(html, /value="auto"/);
    assert.match(html, /value="off"/);
    assert.match(html, /value="custom"/);
    assert.match(html, /uris-reference-max/);
    assert.match(html, /inline-data/);
});

test('referenceOptionsFields marks deferred providers and disables custom mode', () => {
    const html = referenceOptionsFields({ apiType: 'agnes', referenceOptions: { mode: 'auto' } });
    assert.match(html, /временно отложена/i);
    assert.match(html, /value="custom"[^>]*disabled/);
});

test('readReferenceOptions returns normalized card values', () => {
    const card = {
        querySelector(selector) {
            const map = {
                '.uris-reference-mode': { value: 'custom' },
                '.uris-reference-protocol': { value: 'inline-data' },
                '.uris-reference-max': { value: '2' },
            };
            return map[selector] || null;
        },
    };
    assert.deepEqual(readReferenceOptions(card), {
        mode: 'custom', protocol: 'inline-data', maxRefs: 2,
    });
});
```

- [ ] **Step 2: Run and verify missing export failures**

Run:

```bash
node --test tests/tab-api-reference-options.test.js
```

Expected: FAIL because UI helpers are not exported/implemented.

- [ ] **Step 3: Implement pure connection reference controls**

In `src/ui/tab-api.js`, import provider registry/capability helpers and connection normalization. Export:

```js
export function referenceOptionsFields(p) {
    const apiType = p.apiType === 'auto' ? resolveApiType(p.endpoint, p.model) : p.apiType;
    const provider = getImageProvider(apiType);
    const options = normalizeReferenceOptions(p.referenceOptions);
    const capabilities = provider?.getReferenceCapabilities({
        model: p.model,
        endpoint: p.endpoint,
        providerOptions: p.providerOptions || {},
        proxyAvailable: false,
    });
    const protocols = capabilities?.protocols || [];
    const deferred = capabilities?.status === 'deferred';
    const protocolOptions = protocols.map(protocol =>
        `<option value="${escapeHtml(protocol)}" ${options.protocol === protocol ? 'selected' : ''}>${escapeHtml(protocol)}</option>`
    ).join('');
    return `
        <div class="uris-reference-options">
            <div class="uris-row"><label>Референсы</label>
                <select class="text_pole uris-reference-mode">
                    <option value="auto" ${options.mode === 'auto' ? 'selected' : ''}>Авто</option>
                    <option value="off" ${options.mode === 'off' ? 'selected' : ''}>Выключены</option>
                    <option value="custom" ${options.mode === 'custom' ? 'selected' : ''} ${deferred || !protocols.length ? 'disabled' : ''}>Свой протокол</option>
                </select></div>
            <div class="uris-row uris-reference-protocol-row" ${options.mode === 'custom' ? '' : 'hidden'}>
                <label>Протокол</label><select class="text_pole uris-reference-protocol">${protocolOptions}</select></div>
            <div class="uris-row"><label>Максимум</label>
                <input class="text_pole uris-reference-max" type="number" min="1" max="4" value="${options.maxRefs ?? ''}" placeholder="Авто (до 4)"></div>
            ${deferred ? `<small class="uris-reference-note">${escapeHtml(capabilities.reason)}</small>` : ''}
        </div>`;
}

export function readReferenceOptions(card) {
    const mode = card.querySelector('.uris-reference-mode')?.value || 'auto';
    const protocol = card.querySelector('.uris-reference-protocol')?.value || null;
    const rawMax = card.querySelector('.uris-reference-max')?.value || '';
    return normalizeReferenceOptions({
        mode,
        protocol,
        maxRefs: rawMax === '' ? null : Number(rawMax),
    });
}
```

Append `${referenceOptionsFields(p)}` after provider options in `imageConnFields()`.

In `collectConnCard()` add:

```js
o.referenceOptions = readReferenceOptions(card);
```

- [ ] **Step 4: Bind custom protocol visibility and API-type refresh**

Add:

```js
function bindReferenceOptions(card) {
    const mode = card.querySelector('.uris-reference-mode');
    const row = card.querySelector('.uris-reference-protocol-row');
    if (!mode || !row) return;
    const sync = () => { row.hidden = mode.value !== 'custom'; };
    mode.addEventListener('change', sync);
    sync();
}
```

Call `bindReferenceOptions(card)` alongside `bindModelSelectToggle(card)`. When API type changes, re-render both `.uris-provider-options` and `.uris-reference-options` from the fresh connection and call `bindReferenceOptions(card)` again before save.

- [ ] **Step 5: Add minimal styling**

In `style.css`, add only scoped rules:

```css
.uris-reference-options { margin-top: 0.5rem; }
.uris-reference-note { display: block; color: var(--SmartThemeQuoteColor); margin: 0.25rem 0 0.5rem; }
.uris-reference-protocol-row[hidden] { display: none; }
```

- [ ] **Step 6: Run UI and connection tests**

Run:

```bash
node --test tests/tab-api-reference-options.test.js tests/connections-reference-options.test.js tests/data-port.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit connection UI**

```bash
git add src/ui/tab-api.js style.css tests/tab-api-reference-options.test.js
git commit -m "feat: configure references per image connection"
```

---

## Task 8: Make Generate UI Consume the Shared Policy

**Files:**
- Modify: `src/ui/tab-generate.js:7-23,815-876`
- Modify: `tests/tab-generate.test.js`
- Modify: `style.css`

- [ ] **Step 1: Add a pure reference panel state helper test**

In `tests/tab-generate.test.js`, import `buildReferencePanelState` and add:

```js
test('buildReferencePanelState reports effective max and over-limit delivery', () => {
    const state = buildReferencePanelState(
        [{ id: 'a' }, { id: 'b' }],
        { supported: true, maxRefs: 1, reason: '' },
    );
    assert.deepEqual(state, {
        count: 2,
        max: 1,
        canAdd: false,
        unsupported: false,
        overLimit: true,
        message: 'Будет отправлен первый 1 из 2 референсов.',
    });
});

test('buildReferencePanelState hides picker for unsupported policy', () => {
    const state = buildReferencePanelState(
        [{ id: 'a' }],
        { supported: false, maxRefs: 0, reason: 'Работа временно отложена.' },
    );
    assert.equal(state.canAdd, false);
    assert.equal(state.unsupported, true);
    assert.equal(state.message, 'Работа временно отложена.');
});
```

- [ ] **Step 2: Run and verify missing helper failure**

Run:

```bash
node --test tests/tab-generate.test.js
```

Expected: FAIL because `buildReferencePanelState` is not exported.

- [ ] **Step 3: Implement pure panel state and shared policy loading**

Remove the `REF_CAPABILITIES` import from `tab-generate.js`. Import:

```js
import { getImageProvider } from '../providers/registry.js';
import { resolveReferencePolicy } from '../reference-policy.js';
```

Add:

```js
export function buildReferencePanelState(refs, policy) {
    const count = refs?.length || 0;
    if (!policy?.supported) {
        return {
            count,
            max: 0,
            canAdd: false,
            unsupported: true,
            overLimit: false,
            message: policy?.reason || 'Референсы недоступны для этого соединения.',
        };
    }
    const overLimit = count > policy.maxRefs;
    return {
        count,
        max: policy.maxRefs,
        canAdd: count < policy.maxRefs,
        unsupported: false,
        overLimit,
        message: overLimit ? `Будет отправлен первый ${policy.maxRefs} из ${count} референсов.` : '',
    };
}

async function getActiveReferencePolicy() {
    const conn = state.activeImageProfileId ? await getConnection(state.activeImageProfileId) : null;
    if (!conn) return { supported: false, maxRefs: 0, reason: 'Image-коннект не выбран.' };
    const apiType = conn.apiType === 'auto' ? resolveApiType(conn.endpoint, conn.model) : conn.apiType;
    const provider = getImageProvider(apiType);
    if (!provider) return { supported: false, maxRefs: 0, reason: `Неизвестный тип API: ${apiType}` };
    const profile = {
        provider: apiType === 'openai' ? 'openai-like' : apiType,
        endpoint: conn.endpoint,
        model: conn.model,
        providerOptions: conn.providerOptions || {},
        proxyAvailable: false,
    };
    return resolveReferencePolicy(conn, profile, provider);
}
```

UI capability display intentionally does not probe CORS. OpenAI's model/default declaration is shown; request dispatch remains authoritative after real `probeCorsProxy()`.

- [ ] **Step 4: Update `renderLivePreview` and `renderCap`**

Change `renderLivePreview` to obtain policy and panel state:

```js
const policy = await getActiveReferencePolicy();
const panelState = buildReferencePanelState(refs, policy);
```

Use `${panelState.count}/${panelState.max}` when supported. Render the add tile only when `panelState.canAdd`; when unsupported, render:

```html
<small class="uris-refs-policy-info">${escapeHtml(panelState.message)}</small>
```

When over limit, keep all logical chips visible and render the `panelState.message`; do not mutate corrections or `stage2Refs`.

Replace `renderCap`'s global-table lookup with the same policy/state computation. Its text is either `N/M` or the policy message. Remove all `REF_CAPABILITIES` references.

- [ ] **Step 5: Add status styling**

In `style.css` add:

```css
.uris-refs-policy-info { display: block; color: var(--SmartThemeQuoteColor); margin-top: 0.35rem; }
.uris-refs-policy-info.uris-warning { color: var(--warning-color, #d8a657); }
```

- [ ] **Step 6: Run Generate UI and scene pipeline tests**

Run:

```bash
node --test tests/tab-generate.test.js tests/pipeline-scene-first.test.js tests/pool-only-references.test.js tests/pool-only-resolver.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Generate UI integration**

```bash
git add src/ui/tab-generate.js style.css tests/tab-generate.test.js
git commit -m "feat: show effective reference policy in generation UI"
```

---

## Task 9: Remove Obsolete Capability Code and Verify No Consumer Remains

**Files:**
- Modify: `src/providers/base.js`
- Modify: `src/providers/openai.js`
- Modify: `src/image-api.js`
- Modify: `src/ui/tab-generate.js`
- Modify: `tests/references.test.js`

- [ ] **Step 1: Search for obsolete identifiers**

Run:

```bash
grep -R "REF_CAPABILITIES\|supportsStrategy\|formDataEdits\|multimodalChat\|inlineData: 4\|maxRefs\." -n src tests
```

Expected: no `REF_CAPABILITIES` or `supportsStrategy` results. Camel-case old strategy strings must be absent; `inlineData` may remain only as Gemini wire-format keys.

- [ ] **Step 2: Remove obsolete imports/comments/tests found by the search**

Delete only dead capability-table imports, duplicate strategy comments, and old table assertions. Keep:

- Gemini response keys `inlineData`/`inline_data`;
- provider wire-format comments;
- `buildReferenceInstruction` tests;
- provider request behavior tests.

- [ ] **Step 3: Run syntax checks for all changed runtime files**

Run:

```bash
node --check src/providers/base.js
node --check src/providers/registry.js
node --check src/providers/reference-protocols.js
node --check src/providers/openai.js
node --check src/providers/gemini.js
node --check src/providers/pollinations.js
node --check src/providers/agnes.js
node --check src/providers/comfyui.js
node --check src/providers/a1111.js
node --check src/connections.js
node --check src/reference-policy.js
node --check src/image-api.js
node --check src/ui/tab-api.js
node --check src/ui/tab-generate.js
```

Expected: each exits 0 with no output.

- [ ] **Step 4: Run all targeted reference/provider tests**

Run:

```bash
node --test tests/reference-protocols.test.js tests/reference-policy.test.js tests/connections-reference-options.test.js tests/image-api-references.test.js tests/providers.test.js tests/references.test.js tests/tab-api-reference-options.test.js tests/tab-generate.test.js tests/pipeline-scene-first.test.js tests/pipeline-stage2-serialization.test.js tests/pool-only-references.test.js tests/pool-only-resolver.test.js tests/scene-context.test.js
```

Expected: PASS with zero failures.

- [ ] **Step 5: Commit cleanup**

```bash
git add src tests
git commit -m "test: cover provider-owned reference delivery"
```

---

## Task 10: Full Regression Verification and Documentation

**Files:**
- Modify: `docs/changelog.md`
- Verify: all runtime/test files

- [ ] **Step 1: Add a concise changelog entry**

At the top of `docs/changelog.md`, add:

```markdown
## 2026-07-17 — Provider-owned reference capabilities

- Удалена глобальная таблица `REF_CAPABILITIES`: поддержку и протокол референсов теперь объявляет сам image-провайдер.
- Добавлены настройки референсов для каждого image-коннекта: auto/off/custom protocol и необязательный предел 1–4.
- UI и фактическая отправка используют единый effective policy; неподдерживаемые или лишние референсы больше не отбрасываются без объяснения.
- Stage 1/Stage 2 scene resolution, snapshots, очередь, retry и image recovery не изменены.
- Работа с референсами Agnes, ComfyUI и A1111 явно помечена как временно отложенная.
```

- [ ] **Step 2: Run the complete test suite**

Run:

```bash
node --test tests/*.test.js
```

Expected: all tests PASS, zero failures/cancellations.

- [ ] **Step 3: Run repository diff checks**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` has no output. `git status --short` lists only intentional feature files plus any pre-existing unrelated user changes.

- [ ] **Step 4: Review the final diff for protected pipeline files**

Run:

```bash
git diff -- src/scene-context.js src/pipeline.js src/references.js src/generation-drafts.js src/image-recovery.js
```

Expected: no feature diff in these protected modules. If pre-existing user changes are present, verify this implementation did not add provider/reference-policy edits to them.

- [ ] **Step 5: Commit documentation and verification state**

```bash
git add docs/changelog.md
git commit -m "docs: document provider-owned reference capabilities"
```

- [ ] **Step 6: Final behavior checklist**

Confirm from test output and code inspection:

- OpenAI GPT Image sends retained refs through multipart edits.
- OpenAI multimodal custom/automatic routes send image content parts.
- Gemini 2.5 sends up to 3; other Gemini image models remain bounded by application max 4.
- Pollinations Kontext sends exactly one public URL reference.
- Agnes, ComfyUI, A1111 show the postponed message and cannot be custom-enabled.
- Switching connection changes UI/delivery policy without changing logical `stage2Refs`.
- `mode: off` sends text-only with a visible warning when refs were selected.
- `custom` rejects protocols not declared by the provider.
- Retry, abort, provider result, queue, gallery, and recovery contracts remain unchanged.
