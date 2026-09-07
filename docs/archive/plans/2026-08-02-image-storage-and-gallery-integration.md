# Image Storage & Gallery Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated images appear in the SillyTavern character "Show Gallery" by saving them into `user/images/<character name>/` (matching the canonical stable-diffusion extension), with a relaxed path validator, character-aware uploads, multi-folder reconcile, soft/hard delete, a lightbox actions panel, and removal of the dead `copyToStGallery` config.

**Architecture:** Generated image files move from a single hardcoded `user/images/UR Image Studio/` folder into the active character's folder. The path validator `canonicalizeNativeImagePath` is relaxed to accept any single sanitized folder segment under `user/images/`. `ch_name` is threaded from the generation pipeline through the upload chain. `message.extra` is NOT used (user explicitly declined inline images) — Show Gallery works from the file's presence in the character folder alone. Delete is a single UI flow with an opt-in checkbox: default hides the card (file survives in Show Gallery), the checkbox erases the file via `POST /api/images/delete`.

**Tech Stack:** JavaScript ES modules, SillyTavern extension APIs (`getContext()`, `/api/images/*` endpoints), Fetch, Node.js built-in `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-02-image-storage-and-gallery-design.md`

---

## File structure

- **Modify:** `src/native-image-path.js` — relax `canonicalizeNativeImagePath` to accept any single folder segment; relax `nativeImagePathFromBasename` to take an optional folder.
- **Modify:** `src/native-image-storage.js` — thread `ch_name` through `uploadGeneratedImage`/`uploadPayload`/`materializeImageResult`; add `getCharacterImageFolder()`; `listNativeImages({ folder })`.
- **Modify:** `src/image-api.js` — resolve `ch_name`, pass it to `materializeImageResult`, store `provenance.characterFolder`.
- **Modify:** `src/gallery-index.js` — add `hidden` to `ALLOWED`; multi-folder `reconcileCards`; `countCardsByImagePath` helper.
- **Modify:** `src/storage.js` — `deleteGalleryCard({ deleteFile })`; `clearGallery({ deleteFiles })`; filter `hidden` in `getGallery`.
- **Create:** `src/ui/gallery-actions.js` — extracted action handlers (copy/save-ref/regen/delete) consumed by both grid and lightbox.
- **Modify:** `src/ui/lightbox.js` — render an actions bar using `gallery-actions.js`.
- **Modify:** `src/ui/tab-gallery.js` — consume `gallery-actions.js`; remove the dead `copyToStGallery` checkbox.
- **Modify:** `src/core.js` — remove `copyToStGallery` from `defaultSettings` and `DEFAULT_CHAT_CONFIG_ENVELOPE.config`; trim `galleryMode` enum.
- **Modify:** `src/chat-binding.js` + `src/pipeline-config.js` — drop dead config fields; schema-v5 migration in normalize.
- **Modify:** `tests/native-image-path.test.js`, `tests/gallery-index.test.js`, `tests/native-image-storage.test.js` — update tests broken by the relaxed validator; add new coverage.
- **Create:** `tests/image-storage-integration.test.js` — multi-folder reconcile + delete + character-folder upload integration tests.

---

## Task 1: Relax the native image path validator

**Files:**
- Modify: `src/native-image-path.js` (whole file, ~37 lines)
- Test: `tests/native-image-path.test.js`

**Why first:** This is the load-bearing change. Every downstream task depends on paths in arbitrary character folders being valid. Without it, nothing else works.

- [ ] **Step 1: Update the failing test for the new contract**

Replace the entire contents of `tests/native-image-path.test.js` with:

```js
// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalizeNativeImagePath, nativeImagePathFromBasename } from '../src/native-image-path.js';

const legacy = 'user/images/UR%20Image%20Studio/literal%20name.png';

test('canonicalizes legacy folder paths (literal or encoded spaces)', () => {
    for (const value of [
        'user/images/UR Image Studio/literal name.png',
        '/user/images/UR%20Image%20Studio/literal%20name.png',
        legacy,
    ]) {
        assert.equal(canonicalizeNativeImagePath(value), legacy);
    }
});

test('canonicalizes arbitrary single-segment character folder paths', () => {
    assert.equal(canonicalizeNativeImagePath('user/images/Alice/portrait.png'), 'user/images/Alice/portrait.png');
    assert.equal(canonicalizeNativeImagePath('user/images/Group%201/scene.webp'), 'user/images/Group%201/scene.webp');
    assert.equal(canonicalizeNativeImagePath('user/images/Bob%20the%20Cat/f.jpg'), 'user/images/Bob%20the%20Cat/f.jpg');
    assert.equal(canonicalizeNativeImagePath('/user/images/Алиса/портрет.png'), 'user/images/%D0%90%D0%BB%D0%B8%D1%81%D0%B0/%D0%BF%D0%BE%D1%80%D1%82%D1%80%D0%B5%D1%82.png');
});

test('nativeImagePathFromBasename builds a path for a given folder', () => {
    assert.equal(nativeImagePathFromBasename('literal name.png'), legacy);
    assert.equal(nativeImagePathFromBasename('pic.png', 'Alice'), 'user/images/Alice/pic.png');
    assert.equal(nativeImagePathFromBasename('pic.png', 'Group 1'), 'user/images/Group%201/pic.png');
});

test('rejects unsafe, malformed, nested, or non-native image path values', () => {
    const invalid = [
        '', 'https://images.example/file.png', 'data:image/png;base64,aGVsbG8=',
        'user/images/Alice/file\\name.png',
        'user/images/Alice/bad%2',
        'user/images/Alice/../file.png',
        'user/images/Alice/%2E%2E/file.png',
        'user/images/Alice/file%2Fname.png',
        'user/images/Alice/file%252Fname.png',
        'user/images/Alice/file.png?x=1',
        'user/images/Alice/file.png#part',
        'user/images/Alice/nested/file.png',
        'user/images/Alice/',
        'user/images//file.png',
        'user/images/Alice',
        'file.png',
        'user/images/Alice/file\nname.png',
    ];
    for (const value of invalid) {
        assert.equal(canonicalizeNativeImagePath(value), null, value);
    }
    for (const value of ['nested/file.png', '../file.png', 'file%2Fname.png', 'file%252Fname.png', '']) {
        assert.equal(nativeImagePathFromBasename(value), null, value);
    }
});
```

Key changes from the old test: `'user/images/Other%20Folder/file.png'` is removed from the invalid list (now valid); new tests assert arbitrary folders work; `nativeImagePathFromBasename` now takes an optional folder argument.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/native-image-path.test.js`
Expected: FAIL — `canonicalizeNativeImagePath('user/images/Alice/...')` returns `null` because the current implementation hardcodes `folder !== NATIVE_IMAGE_FOLDER` rejection (`src/native-image-path.js:29`).

- [ ] **Step 3: Implement the relaxed validator**

Replace the entire contents of `src/native-image-path.js` with:

```js
// @ts-check

export const NATIVE_IMAGE_FOLDER = 'UR Image Studio';
export const NATIVE_IMAGE_FOLDER_PATH = `user/images/${encodeURIComponent(NATIVE_IMAGE_FOLDER)}`;

function hasControls(value) {
    return /[\u0000-\u001F\u007F]/.test(value);
}

function decodeSegment(value) {
    if (typeof value !== 'string' || !value || hasControls(value) || /[\\/?#]/.test(value)) return null;
    let decoded;
    try { decoded = decodeURIComponent(value); }
    catch { return null; }
    if (!decoded || hasControls(decoded) || /[\\/?#]/.test(decoded) || decoded === '.' || decoded === '..') return null;
    if (/%(?:2f|2e|5c|25)/i.test(decoded)) return null;
    return decoded;
}

function encodeSegment(value) {
    return encodeURIComponent(value);
}

/**
 * Return one canonical ST-native image path under any single folder segment,
 * or null for untrusted input.
 *
 * Accepts `user/images/<folder>/<file>` where <folder> is any single sanitized
 * segment (matches how ST's character gallery scans user/images/<char.name>/).
 * Rejects traversal, schemes, control chars, query/fragment, nested paths.
 */
export function canonicalizeNativeImagePath(value) {
    if (typeof value !== 'string' || !value || hasControls(value) || /[\\?#]/.test(value)) return null;
    const source = value.startsWith('/') ? value.slice(1) : value;
    if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return null;
    const parts = source.split('/');
    if (parts.length !== 4 || parts[0] !== 'user' || parts[1] !== 'images') return null;
    const folder = decodeSegment(parts[2]);
    const filename = decodeSegment(parts[3]);
    if (!folder || !filename) return null;
    return `user/images/${encodeSegment(folder)}/${encodeSegment(filename)}`;
}

/**
 * Turn a single ST list basename into the canonical native image path.
 * @param {string} value - filename (with optional percent-encoding)
 * @param {string} [folder] - folder name; defaults to the legacy UR Image Studio folder
 */
export function nativeImagePathFromBasename(value, folder = NATIVE_IMAGE_FOLDER) {
    const filename = decodeSegment(value);
    if (!filename || !folder) return null;
    return `user/images/${encodeSegment(folder)}/${encodeSegment(filename)}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/native-image-path.test.js`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/native-image-path.js tests/native-image-path.test.js
git commit -m "refactor(image-path): relax canonicalizer to accept any single folder segment under user/images/"
```

---

## Task 2: Fix broken tests and thread `ch_name` through the upload chain

**Files:**
- Modify: `src/native-image-storage.js:51-112`
- Test: `tests/native-image-storage.test.js`

**Why:** Task 1's relaxed validator means uploads into a character folder now return valid paths, but the storage layer still hardcodes the legacy folder and the tests assert the legacy folder. We thread `ch_name` through and keep the legacy folder as the default for backward compatibility.

- [ ] **Step 1: Add a failing test for `ch_name` threading**

Append to `tests/native-image-storage.test.js`:

```js
test('uploads to a character folder when ch_name is provided', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ path: 'user/images/Alice/uris_card.png' }) };
    };
    const { uploadGeneratedImage } = await import('../src/native-image-storage.js');

    const path = await uploadGeneratedImage('data:image/png;base64,aGVsbG8=', { filename: 'uris_card', ch_name: 'Alice' });

    assert.equal(path, 'user/images/Alice/uris_card.png');
    assert.deepEqual(JSON.parse(calls[0].options.body).ch_name, 'Alice');
});

test('defaults to the legacy folder when ch_name is omitted', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ path: 'user/images/UR%20Image%20Studio/x.png' }) });
    const { uploadGeneratedImage } = await import('../src/native-image-storage.js');
    const path = await uploadGeneratedImage('data:image/png;base64,aGVsbG8=', { filename: 'x' });
    assert.equal(path, 'user/images/UR%20Image%20Studio/x.png');
});

test('lists native images in a specified folder', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return { ok: true, json: async () => ['portrait.png'] };
    };
    const { listNativeImages } = await import('../src/native-image-storage.js');
    const paths = await listNativeImages({ folder: 'Alice' });
    assert.deepEqual(paths, ['user/images/Alice/portrait.png']);
    assert.equal(calls[0].body.folder, 'Alice');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/native-image-storage.test.js`
Expected: FAIL — `ch_name` is currently ignored (hardcoded to `NATIVE_GALLERY_FOLDER`); `listNativeImages` does not accept `folder`.

- [ ] **Step 3: Thread `ch_name` and `folder` through the upload/list chain**

In `src/native-image-storage.js`, make these edits:

Change the `uploadGeneratedImage` signature (line 51):
```js
export async function uploadGeneratedImage(dataUrl, { filename, ch_name, signal, timeoutMs } = {}) {
    const { image, format } = parseDataUrl(dataUrl);
    return uploadPayload({ image, format }, { filename, ch_name, signal, timeoutMs });
}
```

Change the `uploadPayload` body line (line 62) — replace `ch_name: NATIVE_GALLERY_FOLDER` with:
```js
        body: JSON.stringify({ image, format, ch_name: ch_name ?? NATIVE_GALLERY_FOLDER, filename: safeFilename(filename) }),
```

Change the `uploadPayload` signature (line 56):
```js
async function uploadPayload({ image, format }, { filename, ch_name, signal, timeoutMs } = {}) {
```

Change `materializeImageResult` (line 99) to forward `ch_name`:
```js
export async function materializeImageResult(result, options = {}) {
    const ch_name = options.ch_name;
    if (typeof result === 'string' && result.startsWith('data:')) return uploadGeneratedImage(result, options);
    if (result?.kind === 'dataUrl') return uploadGeneratedImage(result.value, options);
    if (result?.kind === 'bytes' && result.value != null) {
        const blob = new Blob([result.value], { type: result.mimeType || 'image/png' });
        return uploadPayload(await blobPayload(blob), { filename: options.filename, ch_name, signal: options.signal, timeoutMs: options.timeoutMs });
    }
    if (result?.kind !== 'url' || typeof result.value !== 'string') {
        throw new Error('Expected a data URL, byte result, or downloadable image URL');
    }
    const response = await downloadResult(result.value, { signal: options.signal }, options.timeoutMs);
    if (!response.ok) throw new Error(`Image result download failed (${response.status})`);
    return uploadPayload(await blobPayload(await response.blob()), { filename: options.filename, ch_name, signal: options.signal, timeoutMs: options.timeoutMs });
}
```

Change `listNativeImages` (line 78) to accept `folder`:
```js
export async function listNativeImages({ signal, folder } = {}) {
    const targetFolder = folder ?? NATIVE_GALLERY_FOLDER;
    let response;
    try {
        response = await fetch('/api/images/list', {
            method: 'POST', headers: headers(), body: JSON.stringify({ folder: targetFolder }),
            ...(signal === undefined ? {} : { signal }),
        });
    } catch (cause) {
        throw new Error(`SillyTavern image list failed: ${cause?.message || cause}`);
    }
    const payload = await response.json().catch(() => []);
    if (!response.ok) throw new Error(payload?.error || `SillyTavern image list failed (${response.status})`);
    if (!Array.isArray(payload)) return [];
    return [...new Set(payload.flatMap(name => {
        if (typeof name !== 'string') return [];
        const canonical = canonicalizeNativeImagePath(name) || nativeImagePathFromBasename(name, targetFolder);
        return canonical ? [canonical] : [];
    }))];
}
```

Note: `nativeImagePathFromBasename` now takes the `targetFolder` so basenames from a character-folder listing map to that folder, not the legacy one.

- [ ] **Step 4: Run the storage tests to verify they pass**

Run: `node --test tests/native-image-storage.test.js`
Expected: PASS — including the new `ch_name` tests and the pre-existing tests (which omit `ch_name` and still default to the legacy folder).

- [ ] **Step 5: Commit**

```bash
git add src/native-image-storage.js tests/native-image-storage.test.js
git commit -m "feat(image-storage): thread ch_name through upload chain; listNativeImages accepts folder"
```

---

## Task 3: Add `getCharacterImageFolder()` and wire it into the generation pipeline

**Files:**
- Modify: `src/native-image-storage.js` (add helper)
- Modify: `src/image-api.js:97-117`
- Test: `tests/image-api-server.test.js` (or a new section)

**Why:** This is the change that actually makes images land in the character folder. Resolves the root cause of the Show Gallery bug.

- [ ] **Step 1: Write a failing test for `getCharacterImageFolder`**

Append to `tests/native-image-storage.test.js`:

```js
test('getCharacterImageFolder resolves character name for solo chats', async () => {
    globalThis.SillyTavern = {
        getContext: () => ({
            characterId: 0,
            characters: [{ name: 'Alice' }],
            groupId: null,
        }),
    };
    const { getCharacterImageFolder } = await import('../src/native-image-storage.js');
    assert.equal(getCharacterImageFolder(), 'Alice');
});

test('getCharacterImageFolder resolves group_ prefix for group chats', async () => {
    globalThis.SillyTavern = {
        getContext: () => ({
            characterId: null,
            characters: [],
            groupId: 'group123',
        }),
    };
    const { getCharacterImageFolder } = await import('../src/native-image-storage.js');
    assert.equal(getCharacterImageFolder(), 'group_group123');
});

test('getCharacterImageFolder falls back to the legacy folder when no character or group', async () => {
    globalThis.SillyTavern = {
        getContext: () => ({ characterId: null, characters: [], groupId: null }),
    };
    const { getCharacterImageFolder, NATIVE_GALLERY_FOLDER } = await import('../src/native-image-storage.js');
    assert.equal(getCharacterImageFolder(), NATIVE_GALLERY_FOLDER);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/native-image-storage.test.js`
Expected: FAIL — `getCharacterImageFolder` is not exported.

- [ ] **Step 3: Implement `getCharacterImageFolder`**

Add to `src/native-image-storage.js` (after the `getCtx` helper near the top):

```js
/**
 * Resolve the image-storage folder for the current chat context.
 * Mirrors stable-diffusion/index.js:3012-3014: character name for solo chats,
 * group id for group chats, legacy folder as a safe fallback.
 * @returns {string}
 */
export function getCharacterImageFolder() {
    const ctx = getCtx();
    if (ctx.groupId) return `group_${ctx.groupId}`;
    const name = ctx.characters?.[ctx.characterId]?.name;
    return name || NATIVE_GALLERY_FOLDER;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/native-image-storage.test.js`
Expected: PASS.

- [ ] **Step 5: Wire `getCharacterImageFolder` into `image-api.js`**

In `src/image-api.js`, add to the imports at the top (after line 6):
```js
import { getCharacterImageFolder } from './native-image-storage.js';
```

Replace the block at lines 97-117 (the `try` block after `resultReceived`) with:
```js
    await updatePendingBrowserRequest(request.requestId, { status: 'resultReceived', error: null });
    try {
        const characterFolder = getCharacterImageFolder();
        const imagePath = await materializeImageResult(result, {
            filename: `uris_${request.requestId}`,
            ch_name: characterFolder,
            signal: signal || state.abortController?.signal,
            timeoutMs: conn.timeoutMs,
        });
        const galleryEntry = await addCard({
            imagePath,
            prompt: snapshot.prompt,
            connectionId: imageConnId,
            routeId: route.id,
            modelId: route.modelId,
            generationContract: route.generationContract,
            aspectRatio: snapshot.aspectRatio,
            imageSize: snapshot.imageSize,
            quality: snapshot.quality,
            referenceIds: snapshot.referenceIds,
            provenance: { chatId: snapshot.chatId, sourceMsgId: snapshot.sourceMsgId, characterFolder },
            sourceMsgId: snapshot.sourceMsgId,
            status: 'ready',
        });
        await updatePendingBrowserRequest(request.requestId, { status: 'ready', error: null, cardId: galleryEntry.id, imagePath });
        return { ...result, galleryEntry };
    } catch (error) {
        await updatePendingBrowserRequest(request.requestId, { status: 'resultReceived', error: error?.message || String(error) });
        throw error;
    }
```

- [ ] **Step 6: Run the full test suite to catch regressions**

Run: `node --test`
Expected: PASS for all tests. The `image-api` tests (if any mock `materializeImageResult`) should still pass because `ch_name` is forwarded; verify nothing asserts the absence of `ch_name`.

- [ ] **Step 7: Commit**

```bash
git add src/native-image-storage.js src/image-api.js tests/native-image-storage.test.js
git commit -m "feat(image-api): route generated images into the character folder (fixes Show Gallery)"
```

---

## Task 4: Add `hidden` flag to the card schema and filter it in `getGallery`

**Files:**
- Modify: `src/gallery-index.js:9-13` (ALLOWED), `:61-85` (sanitize), `:107-114` (no change to removeCard)
- Modify: `src/storage.js:35-40` (getGallery filter)
- Test: `tests/gallery-index.test.js`

- [ ] **Step 1: Write failing tests for the `hidden` flag**

Append to `tests/gallery-index.test.js`:

```js
test('hidden flag round-trips through sanitizeGalleryCard and defaults to false', async () => {
    const { addCard, updateCard, listCards } = await import('../src/gallery-index.js');
    await addCard({ id: 'h1', imagePath: 'user/images/Alice/one.png', prompt: 'p' });
    const hidden = await updateCard('h1', { hidden: true });
    assert.equal(hidden.hidden, true);
    const cards = await listCards({ reconcile: false });
    assert.equal(cards.find(c => c.id === 'h1').hidden, true);
    const fresh = await addCard({ id: 'h2', imagePath: 'user/images/Alice/two.png', prompt: 'p2' });
    assert.equal(fresh.hidden, false);
});
```

And add a storage-layer test (append to `tests/native-image-storage.test.js`, which already has `addToGallery`/`getGallery` coverage):

```js
test('getGallery excludes hidden cards but keeps them in the shared index', async () => {
    const context = { extensionSettings: {}, getRequestHeaders: () => ({}), saveSettingsDebounced: () => {} };
    globalThis.SillyTavern = { getContext: () => context, libs: { localforage: { getItem: async () => '' } } };
    globalThis.fetch = async () => ({ ok: true, json: async () => [] });
    const { addCard, listCards } = await import('../src/gallery-index.js');
    const { getGallery } = await import('../src/storage.js');

    await addCard({ id: 'vis', imagePath: 'user/images/Alice/vis.png', prompt: 'visible', provenance: { chatId: 'c1' } });
    await addCard({ id: 'hid', imagePath: 'user/images/Alice/hid.png', prompt: 'hidden', hidden: true, provenance: { chatId: 'c1' } });

    const visible = await getGallery('c1');
    assert.deepEqual(visible.map(c => c.id), ['vis']);
    const all = await listCards({ reconcile: false });
    assert.deepEqual(all.map(c => c.id).sort(), ['hid', 'vis']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/gallery-index.test.js tests/native-image-storage.test.js`
Expected: FAIL — `hidden` is not in `ALLOWED`, so it is stripped; `getGallery` does not filter it.

- [ ] **Step 3: Add `hidden` to the schema**

In `src/gallery-index.js`:

Add `'hidden'` to the `ALLOWED` array (line 9-13):
```js
const ALLOWED = [
    'id', 'imagePath', 'prompt', 'negativePrompt', 'connectionId', 'routeId', 'modelId',
    'generationContract', 'aspectRatio', 'imageSize', 'quality', 'referenceIds', 'provenance',
    'status', 'createdAt', 'updatedAt', 'sourceMsgId', 'style', 'refs', 'refsSig', 'stage2Snapshot',
    'hidden',
];
```

In `sanitizeGalleryCard` (after the `out.status = ...` line, ~line 77), add:
```js
    out.hidden = out.hidden === true ? true : false;
```

- [ ] **Step 4: Filter hidden cards in `getGallery`**

In `src/storage.js`, change `getGallery` (line 35-40) to exclude hidden cards:

```js
export async function getGallery(chatId) {
    let cards = [];
    try { cards = await listCards(); }
    catch (error) { log('Native gallery unavailable:', error.message); }
    return cards
        .filter(card => belongsToChat(card, chatId) && card.hidden !== true)
        .map(cardForGallery);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/gallery-index.test.js tests/native-image-storage.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full suite for regressions**

Run: `node --test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/gallery-index.js src/storage.js tests/gallery-index.test.js tests/native-image-storage.test.js
git commit -m "feat(gallery): add hidden flag; getGallery excludes hidden cards"
```

---

## Task 5: Multi-folder `reconcileCards`

**Files:**
- Modify: `src/gallery-index.js:123-143` (reconcileCards)
- Test: `tests/gallery-index.test.js`

**Why:** After Tasks 1-3, cards live in different folders (legacy + per-character). The current `reconcileCards` scans only the legacy folder and would mark every character-folder card as `'missing'`.

- [ ] **Step 1: Write a failing test for multi-folder reconcile**

Append to `tests/gallery-index.test.js`:

```js
test('reconcileCards scans every distinct folder referenced by cards plus the legacy folder', async () => {
    const listedFolders = [];
    const ctx = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    globalThis.SillyTavern = {
        getContext: () => ctx,
        libs: { localforage: { getItem: async () => '' } },
    };
    globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        listedFolders.push(body.folder);
        if (body.folder === 'UR Image Studio') return { ok: true, json: async () => ['legacy.png'] };
        if (body.folder === 'Alice') return { ok: true, json: async () => ['alice1.png'] };
        return { ok: true, json: async () => [] };
    };
    const { addCard, reconcileCards } = await import('../src/gallery-index.js');
    await addCard({ id: 'a', imagePath: 'user/images/Alice/alice1.png', prompt: 'alice' });
    await addCard({ id: 'l', imagePath: 'user/images/UR%20Image%20Studio/legacy.png', prompt: 'legacy' });
    await addCard({ id: 'gone', imagePath: 'user/images/Alice/missing.png', prompt: 'gone' });

    const cards = await reconcileCards();

    assert.ok(listedFolders.includes('Alice'), 'Alice folder scanned');
    assert.ok(listedFolders.includes('UR Image Studio'), 'legacy folder scanned');
    assert.equal(cards.find(c => c.id === 'a').status, 'ready');
    assert.equal(cards.find(c => c.id === 'l').status, 'ready');
    assert.equal(cards.find(c => c.id === 'gone').status, 'missing');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/gallery-index.test.js`
Expected: FAIL — current `reconcileCards` calls `listNativeImages()` once (legacy folder only); the Alice card is never confirmed, the gone card is wrongly treated, and only one folder is listed.

- [ ] **Step 3: Rewrite `reconcileCards` to scan all distinct folders**

First, add `NATIVE_IMAGE_FOLDER` to the import at `src/gallery-index.js:5` (it's already statically importing `canonicalizeNativeImagePath` from the same module):

```js
import { canonicalizeNativeImagePath, NATIVE_IMAGE_FOLDER } from './native-image-path.js';
```

(`listNativeImages` is already imported statically at line 4, so no dynamic `import()` is needed inside `reconcileCards`.)

In `src/gallery-index.js`, replace `reconcileCards` (lines 123-143) with:

```js
export async function reconcileCards(paths = null) {
    let nativePaths;
    if (paths) {
        // paths is a precomputed array (used by tests / direct callers)
        nativePaths = new Set(paths.flatMap(path => {
            const canonical = canonicalizeNativeImagePath(path);
            return canonical ? [canonical] : [];
        }));
    } else {
        // Scan every distinct folder referenced by cards, plus the legacy folder,
        // so reconcile stays correct once cards live across character folders.
        const cards = index();
        const folders = new Set([NATIVE_IMAGE_FOLDER]);
        for (const card of cards) {
            const folder = decodeFolderFromPath(card.imagePath);
            if (folder) folders.add(folder);
        }
        const lists = await Promise.all([...folders].map(folder => listNativeImages({ folder }).catch(() => [])));
        nativePaths = new Set(lists.flat());
    }
    const cards = index();
    for (let i = cards.length - 1; i >= 0; i--) {
        const canonical = canonicalizeNativeImagePath(cards[i]?.imagePath);
        if (!canonical) {
            cards.splice(i, 1);
            continue;
        }
        cards[i] = sanitizeGalleryCard({ ...cards[i], imagePath: canonical, status: nativePaths.has(canonical) ? 'ready' : 'missing' }, cards[i]);
    }
    const known = new Set(cards.map(card => card.imagePath));
    for (const imagePath of nativePaths) {
        if (!known.has(imagePath)) cards.unshift(sanitizeGalleryCard({ imagePath, prompt: '', status: 'ready', provenance: 'native' }));
    }
    persist();
    return [...cards];
}
```

And add a `decodeFolderFromPath` helper near the top of `src/gallery-index.js` (after the imports):

```js
function decodeFolderFromPath(value) {
    const canonical = canonicalizeNativeImagePath(value);
    if (!canonical) return null;
    const parts = canonical.split('/');
    try { return decodeURIComponent(parts[2]); }
    catch { return null; }
}
```

- [ ] **Step 4: Run the reconcile tests**

Run: `node --test tests/gallery-index.test.js`
Expected: PASS — including the new multi-folder test and the existing reconcile tests (the existing tests pass `paths` explicitly, so they take the `paths` branch and are unaffected by the folder-scan change).

- [ ] **Step 5: Run the full suite for regressions**

Run: `node --test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/gallery-index.js tests/gallery-index.test.js
git commit -m "fix(gallery): reconcile scans every distinct card folder plus legacy"
```

---

## Task 6: `deleteGalleryCard` with `deleteFile` option and multi-card safety

**Files:**
- Modify: `src/storage.js` (add `deleteGalleryCard`, extend `clearGallery`)
- Modify: `src/gallery-index.js` (add `countCardsByImagePath` helper)
- Test: `tests/native-image-storage.test.js` (extend — it already has `storage.js` coverage)

- [ ] **Step 1: Write failing tests**

Append to `tests/native-image-storage.test.js`:

```js
test('deleteGalleryCard hides the card when deleteFile is false', async () => {
    const context = { extensionSettings: {}, getRequestHeaders: () => ({}), saveSettingsDebounced: () => {} };
    globalThis.SillyTavern = { getContext: () => context, libs: { localforage: { getItem: async () => '' } } };
    globalThis.fetch = async () => ({ ok: true, json: async () => [] });
    const { addCard, listCards } = await import('../src/gallery-index.js');
    const { deleteGalleryCard, getGallery } = await import('../src/storage.js');

    await addCard({ id: 'd1', imagePath: 'user/images/Alice/x.png', prompt: 'p', provenance: { chatId: 'c1' } });
    const result = await deleteGalleryCard('c1', 'd1', { deleteFile: false });

    assert.equal(result, true);
    assert.deepEqual((await getGallery('c1')).map(c => c.id), []);
    const all = await listCards({ reconcile: false });
    assert.equal(all.find(c => c.id === 'd1').hidden, true);
});

test('deleteGalleryCard removes the card and deletes the file when deleteFile is true', async () => {
    const calls = [];
    const context = { extensionSettings: {}, getRequestHeaders: () => ({}), saveSettingsDebounced: () => {} };
    globalThis.SillyTavern = { getContext: () => context, libs: { localforage: { getItem: async () => '' } } };
    globalThis.fetch = async (url, options) => {
        calls.push({ url, body: options ? JSON.parse(options.body) : null });
        return { ok: true, json: async () => [] };
    };
    const { addCard } = await import('../src/gallery-index.js');
    const { deleteGalleryCard, getGallery } = await import('../src/storage.js');

    await addCard({ id: 'd2', imagePath: 'user/images/Alice/y.png', prompt: 'p', provenance: { chatId: 'c1' } });
    const result = await deleteGalleryCard('c1', 'd2', { deleteFile: true });

    assert.equal(result, true);
    assert.deepEqual((await getGallery('c1')).map(c => c.id), []);
    const deleteCall = calls.find(c => c.url === '/api/images/delete');
    assert.ok(deleteCall, 'called /api/images/delete');
    assert.deepEqual(deleteCall.body, { path: 'user/images/Alice/y.png' });
});

test('deleteGalleryCard degrades to hide when the file path is shared by another card', async () => {
    const calls = [];
    const context = { extensionSettings: {}, getRequestHeaders: () => ({}), saveSettingsDebounced: () => {} };
    globalThis.SillyTavern = { getContext: () => context, libs: { localforage: { getItem: async () => '' } } };
    globalThis.fetch = async (url) => { calls.push(url); return { ok: true, json: async () => [] }; };
    const { addCard, listCards } = await import('../src/gallery-index.js');
    const { deleteGalleryCard } = await import('../src/storage.js');

    await addCard({ id: 's1', imagePath: 'user/images/Alice/shared.png', prompt: 'p1', provenance: { chatId: 'c1' } });
    await addCard({ id: 's2', imagePath: 'user/images/Alice/shared.png', prompt: 'p2', provenance: { chatId: 'c1' } });

    const result = await deleteGalleryCard('c1', 's1', { deleteFile: true });

    assert.equal(result, true);
    assert.equal(calls.includes('/api/images/delete'), false, 'did not delete the shared file');
    const all = await listCards({ reconcile: false });
    assert.equal(all.find(c => c.id === 's1').hidden, true, 's1 hidden instead');
    assert.equal(all.find(c => c.id === 's2').hidden, false, 's2 untouched');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/native-image-storage.test.js`
Expected: FAIL — `deleteGalleryCard` is not exported.

- [ ] **Step 3: Add the `countCardsByImagePath` helper**

In `src/gallery-index.js`, add after `removeCard` (line 114):

```js
/** Count how many cards reference the given canonical image path. */
export function countCardsByImagePath(imagePath) {
    const canonical = canonicalizeNativeImagePath(imagePath);
    if (!canonical) return 0;
    return index().filter(card => canonicalizeNativeImagePath(card.imagePath) === canonical).length;
}
```

- [ ] **Step 4: Implement `deleteGalleryCard` and extend `clearGallery`**

In `src/storage.js`:

Add imports — change line 7 to include `countCardsByImagePath`:
```js
import { addCard, clearCards, countCardsByImagePath, listCards, removeCard, updateCard } from './gallery-index.js';
```

Add a `deleteNativeImageFile` helper and `deleteGalleryCard`. Insert after `removeFromGallery` (around line 91):

```js
async function deleteNativeImageFile(imagePath) {
    const ctx = getCtx();
    try {
        await fetch('/api/images/delete', {
            method: 'POST',
            headers: { ...(ctx.getRequestHeaders?.() ?? {}), 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: imagePath }),
        });
    } catch (error) {
        log('Native image file delete failed:', error.message);
    }
}

/**
 * Delete a gallery card. With deleteFile=false (default) the card is hidden
 * (file survives in ST Show Gallery); with deleteFile=true the card is removed
 * and the file is erased via POST /api/images/delete, unless another card still
 * references the same path (then degrade to hide to avoid breaking the other card).
 */
export async function deleteGalleryCard(chatId, id, { deleteFile = false } = {}) {
    const card = (await listCards({ reconcile: false })).find(item => item.id === id);
    if (!belongsToChat(card, chatId)) return false;
    if (deleteFile) {
        const shared = countCardsByImagePath(card.imagePath) > 1;
        if (shared) {
            await updateCard(id, { hidden: true });
            log('Delete file skipped: path shared by another card; hidden instead', id);
            return true;
        }
        await removeCard(id);
        await deleteNativeImageFile(card.imagePath);
        log('Deleted gallery card and file', id);
        return true;
    }
    await updateCard(id, { hidden: true });
    log('Hidden gallery card', id);
    return true;
}
```

Extend `clearGallery` (line 106-110) to accept `deleteFiles`:

```js
export async function clearGallery(chatId, { deleteFiles = false } = {}) {
    const cards = await listCards({ reconcile: false });
    const mine = cards.filter(card => belongsToChat(card, chatId));
    if (deleteFiles) {
        for (const card of mine) {
            const shared = countCardsByImagePath(card.imagePath) > 1;
            if (!shared) await deleteNativeImageFile(card.imagePath);
        }
        await Promise.all(mine.map(card => removeCard(card.id)));
    } else {
        await Promise.all(mine.map(card => updateCard(card.id, { hidden: true })));
    }
    log('Gallery cleared for chat', chatId, deleteFiles ? '(files deleted)' : '(cards hidden)');
}
```

Note: changing `clearGallery` default behavior from "remove" to "hide" is intentional and matches the new soft-delete default. The existing test `'gallery authority is shared index only and clearGallery removes only the active chat cards'` (`tests/native-image-storage.test.js:167`) asserts that after `clearGallery('chat-a')`, `getGallery('chat-a')` is empty and `getGallery('chat-b')` still shows `['b']` — both still hold: hidden cards are filtered from `getGallery`, and other chats' cards are untouched. The test does NOT assert the card is physically gone from the index, so the hide default is compatible. (If you want to assert the new hide behavior explicitly, add: `assert.equal((await listCards({reconcile:false})).find(c=>c.id==='a').hidden, true)`.)

- [ ] **Step 5: Run the tests**

Run: `node --test tests/native-image-storage.test.js`
Expected: PASS — including the three new delete tests. The existing `clearGallery` test still passes (hidden cards are filtered).

- [ ] **Step 6: Run the full suite for regressions**

Run: `node --test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/storage.js src/gallery-index.js tests/native-image-storage.test.js
git commit -m "feat(gallery): deleteGalleryCard with deleteFile option + multi-card safety"
```

---

## Task 7: Extract action handlers into `gallery-actions.js`

**Files:**
- Create: `src/ui/gallery-actions.js`
- Modify: `src/ui/tab-gallery.js:80-196` (consume the new module; remove duplication)

**Why:** The lightbox (Task 8) needs the same actions the grid has. Extracting them removes duplication and gives both consumers a single source of truth.

- [ ] **Step 1: Create the `gallery-actions.js` module**

Create `src/ui/gallery-actions.js`:

```js
// @ts-check
/**
 * Shared action handlers for gallery cards, consumed by both the grid
 * (tab-gallery.js) and the lightbox (lightbox.js). Extracted from tab-gallery.js
 * to avoid duplication and keep a single source of truth.
 */
import { getCtx, showConfirmModal, showInputModal, setStatus, log, saveSettings } from '../core.js';
import { deleteGalleryCard } from '../storage.js';
import { runStage2 } from '../pipeline.js';
import { createRef, createReferenceFromGalleryCard, listRefs, updateRef } from '../refs-library.js';
import { imageToDataUrl, uploadReferenceImage } from '../references.js';
import { canonicalizeNativeImagePath } from '../native-image-path.js';

export async function copyPrompt(item) {
    try {
        await navigator.clipboard.writeText(item.prompt || '');
        toastr?.success('Промпт скопирован');
    } catch {
        toastr?.error('Не удалось скопировать');
    }
}

export async function saveAsReference(item) {
    if (!item) return;
    try {
        const createNew = await showConfirmModal(
            'Сохранить картинку в пул референсов?\n\n' +
            '«OK» — создать новый референс.\n' +
            '«Отмена» — заменить изображение в существующем.'
        );
        if (createNew) {
            const name = await showInputModal('Имя референса:', 'Из галереи');
            if (!name) return;
            const uploaded = await uploadEntryAsRef(item);
            const ref = uploaded.reusedNativePath
                ? await createReferenceFromGalleryCard(item, { name })
                : await createRef({ name, imagePath: uploaded.imagePath, ...uploaded.metadata });
            if (item.prompt && !ref.description) await updateRef(ref.id, { description: item.prompt });
            toastr?.success('Референс создан: ' + name);
        } else {
            const refs = await listRefs();
            if (!refs.length) { toastr?.info('Пул пуст. Создайте через «OK».'); return; }
            const chosen = await showRefPicker('Выберите референс для замены изображения:', refs);
            if (!chosen) return;
            const uploaded = await uploadEntryAsRef(item);
            await updateRef(chosen, { imagePath: uploaded.imagePath, ...uploaded.metadata });
            toastr?.success('Изображение обновлено');
        }
        refreshActive();
    } catch (err) {
        log('saveRef error:', err.message);
        toastr?.error('Не удалось сохранить: ' + err.message);
    }
}

export async function regenerate(item, root, regenBtn) {
    if (regenBtn?.disabled) return;
    const snapshot = Array.isArray(item.refs) ? item.refs : null;
    let useSameRefs = false;
    if (snapshot && snapshot.length) {
        const names = snapshot.map(r => r.name || r.id || 'ref').join(', ');
        useSameRefs = await showConfirmModal(
            `Регенерировать с теми же референсами (${snapshot.length}: ${names})?\n\n` +
            `«OK» - те же референсы (снапшот на момент первичной генерации).\n` +
            `«Отмена» - использовать текущий активный профиль (мог измениться).`
        );
    }
    try {
        if (regenBtn) regenBtn.disabled = true;
        setStatus('Перегенерация...');
        const instr = { style: item.style, prompt: item.prompt, aspectRatio: item.aspectRatio, imageSize: item.imageSize };
        let opts = {};
        if (useSameRefs && snapshot) {
            const refs = await rebuildRefsFromSnapshot(snapshot);
            opts = { refs };
            const curSig = refs.map(r => r.id || '').sort().join(',');
            if (item.refsSig && item.refsSig !== curSig) {
                toastr?.info('Состав референсов отличается от первичной генерации (профиль/аватар изменился)');
            }
        }
        await runStage2(item.sourceMsgId, instr, s => setStatus(s), undefined, opts);
        toastr?.success('Перегенерировано');
        if (root) refreshRoot(root);
    } catch (err) {
        toastr?.error('Перегенерация: ' + err.message);
    } finally {
        setStatus('');
        if (regenBtn) regenBtn.disabled = false;
    }
}

export async function deleteImage(item, chatId, root) {
    const ctx = getCtx();
    const deleteFile = await confirmDeleteModal(ctx);
    if (deleteFile === null) return; // cancelled
    await deleteGalleryCard(chatId, item.id, { deleteFile });
    if (root) refreshRoot(root);
}

async function confirmDeleteModal(ctx) {
    // Returns: true (delete file too), false (hide only), null (cancelled).
    if (!ctx?.callGenericPopup || !ctx?.POPUP_TYPE) {
        // Fallback: simple confirm = hide only.
        return await showConfirmModal('Удалить картинку из галереи расширения?') ? false : null;
    }
    const result = await ctx.callGenericPopup(
        'Удалить картинку из галереи расширения?' +
        '<label class="checkbox_label" style="margin-top:10px;display:block;">' +
        '<input type="checkbox" id="urisDeleteFile">' +
        '<span>Также стереть файл и убрать из галереи чата (Show Gallery)</span>' +
        '</label>',
        ctx.POPUP_TYPE.CONFIRM,
        '',
        { okButton: 'Удалить', cancelButton: 'Отмена' },
    );
    if (result === ctx.POPUP_RESULT.AFFIRMATIVE) {
        const cb = document.querySelector('#urisDeleteFile');
        return cb?.checked ? true : false;
    }
    return null;
}

async function uploadEntryAsRef(it) {
    const nativePath = typeof it.imagePath === 'string' ? it.imagePath : it.stGalleryPath;
    const canonicalNativePath = canonicalizeNativeImagePath(nativePath);
    if (canonicalNativePath) {
        return { imagePath: canonicalNativePath, metadata: {}, reusedNativePath: true };
    }
    const src = it.src;
    if (!src) throw new Error('нет изображения');
    let dataUrl = src;
    if (!src.startsWith('data:')) {
        dataUrl = await imageToDataUrl(src);
    }
    if (!dataUrl) throw new Error('не удалось получить изображение');
    return await uploadReferenceImage(dataUrl, `npc_capture_${Date.now()}`, 'URIS_Refs');
}

async function showRefPicker(title, refs) {
    const ctx = getCtx();
    if (!ctx.callGenericPopup || !ctx.POPUP_TYPE || !ctx.POPUP_RESULT) return null;
    const MAX_CUSTOM = 9;
    if (refs.length > MAX_CUSTOM) {
        toastr?.warning(`Слишком много референсов (${refs.length}). Покажем первые ${MAX_CUSTOM}.`);
        refs = refs.slice(0, MAX_CUSTOM);
    }
    const customButtons = refs.map((r, i) => ({
        text: r.name || '?',
        result: ctx.POPUP_RESULT[`CUSTOM${i + 1}`],
    }));
    const res = await ctx.callGenericPopup(
        title, ctx.POPUP_TYPE.TEXT, '',
        { okButton: 'Отмена', cancelButton: 'Отмена', customButtons },
    );
    if (res == null || res === ctx.POPUP_RESULT.NEGATIVE || res === ctx.POPUP_RESULT.CANCELLED) return null;
    for (let i = 0; i < refs.length; i++) {
        if (res === ctx.POPUP_RESULT[`CUSTOM${i + 1}`]) return refs[i]?.id || null;
    }
    return null;
}

async function rebuildRefsFromSnapshot(snapshot) {
    const poolRefs = await listRefs();
    const out = [];
    for (const descriptor of snapshot) {
        try {
            const ref = descriptor.id ? poolRefs.find(item => item.id === descriptor.id) : null;
            if (!ref?.imagePath) continue;
            const dataUrl = await imageToDataUrl(ref.imagePath);
            if (dataUrl) {
                out.push({ image: dataUrl, id: ref.id, role: ref.role || '', name: ref.name || '' });
            }
        } catch { /* ignore individual failures */ }
    }
    return out;
}

function refreshActive() {
    // Re-dispatch a refresh of whichever view is active. saveSettings triggers
    // ST's settings redraw; the gallery tab re-renders on its own render() call.
    saveSettings();
}

function refreshRoot(root) {
    // Re-render the gallery tab by re-importing and calling render.
    // The grid passes its own render closure; lightbox can pass null.
    import('./tab-gallery.js').then(({ render }) => render(root)).catch(() => {});
}
```

- [ ] **Step 2: Update `tab-gallery.js` to consume the new module**

In `src/ui/tab-gallery.js`, replace the inline action handlers (lines 80-196 inside `bindCards`) with calls to the extracted module. The `bindCards` function becomes:

```js
function bindCards(root, items, chatId) {
    const { copyPrompt, saveAsReference, regenerate, deleteImage } = await import('./gallery-actions.js');
    root.querySelectorAll('.uris-card').forEach(cardEl => {
        const id = cardEl.dataset.id;
        const idx = parseInt(cardEl.dataset.idx, 10);
        const it = () => items.find(x => x.id === id);
        cardEl.querySelector('[data-act="view"]')?.addEventListener('click', (e) => {
            e.stopPropagation(); showLightbox(items, idx);
        });
        cardEl.querySelector('[data-act="copy"]')?.addEventListener('click', async (e) => {
            e.stopPropagation(); await copyPrompt(it());
        });
        cardEl.querySelector('[data-act="regen"]')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            const regenBtn = cardEl.querySelector('[data-act="regen"]');
            await regenerate(it(), root, regenBtn);
        });
        cardEl.querySelector('[data-act="goto"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const msgId = it()?.sourceMsgId;
            if (msgId == null) { toastr?.info('Пост-источник не указан'); return; }
            const mes = document.querySelector(`.mes[mesid="${msgId}"]`);
            if (!mes) { toastr?.info('Пост не найден в чате (возможно удалён)'); return; }
            mes.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        cardEl.querySelector('[data-act="del"]')?.addEventListener('click', async (e) => {
            e.stopPropagation(); await deleteImage(it(), chatId, root);
        });
        cardEl.querySelector('[data-act="saveRef"]')?.addEventListener('click', async (e) => {
            e.stopPropagation(); await saveAsReference(it());
        });
    });
}
```

**Important:** `bindCards` now uses `await import(...)`, so it must become `async`. Change `function bindCards(...)` to `async function bindCards(...)` and `await bindCards(root, items, chatId)` at the call site in `render()` (line 38).

Remove the now-unused helpers at the bottom of `tab-gallery.js`: `showRefPicker`, `uploadEntryAsRef`, `rebuildRefsFromSnapshot` (they now live in `gallery-actions.js`). Also remove unused imports (`runStage2`, `createRef`, `createReferenceFromGalleryCard`, `listRefs`, `updateRef`, `imageToDataUrl`, `uploadReferenceImage`, `canonicalizeNativeImagePath`) if no longer referenced — keep `getCtx`, `escapeHtml`, `showConfirmModal`, `state`, `saveSettings`, `getGallery`, `removeFromGallery`, `clearGallery`, `showLightbox`, `setStatus`, `patchChatConfig`.

- [ ] **Step 3: Verify nothing references the removed helpers**

Run: `grep -rn "showRefPicker\|uploadEntryAsRef\|rebuildRefsFromSnapshot" src/`
Expected: no hits outside `src/ui/gallery-actions.js`.

- [ ] **Step 4: Run the gallery-related tests**

Run: `node --test tests/tab-gallery-layout.test.js tests/gallery-index.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/gallery-actions.js src/ui/tab-gallery.js
git commit -m "refactor(gallery-ui): extract action handlers into gallery-actions.js for grid+lightbox reuse"
```

---

## Task 8: Add the actions bar to the lightbox

**Files:**
- Modify: `src/ui/lightbox.js`
- Modify: `style.css` (add styles for the actions bar)

**Why:** The lightbox is currently view-only. The user wants prompt view / save-as-reference / regenerate / delete accessible from the lightbox itself.

- [ ] **Step 1: Add the actions bar to the lightbox render**

In `src/ui/lightbox.js`, the module currently holds `_items` and `_index`. Extend it to also remember the chat context and render an actions bar.

First, add imports at the top of the file (alongside the existing `import { escapeHtml } from '../core.js';`):

```js
import { copyPrompt, saveAsReference, regenerate, deleteImage } from './gallery-actions.js';
import { escapeHtml, getCtx } from '../core.js';
```

Then replace the existing `escapeHtml` import line with the combined one above (remove the standalone `import { escapeHtml } from '../core.js';` to avoid a duplicate).

Add module-level state after the existing `_onKey` declaration:

```js
let _chatId = null;
let _root = null;   // optional gallery root for post-action re-render
```

Replace `showLightbox` (lines 14-18) with:

```js
export function showLightbox(items, index = 0, { chatId = null, root = null } = {}) {
    if (!items?.length) return;
    _items = items;
    _index = Math.max(0, Math.min(items.length - 1, index));
    _chatId = chatId ?? getCtx().chatId ?? null;
    _root = root;
    render();
}
```

Replace the `render` function (lines 20-63) with:
    document.querySelector('.uris-lightbox')?.remove();
    const item = _items[_index];
    const lb = document.createElement('div');
    lb.className = 'uris-lightbox';
    lb.innerHTML = `
        <div class="uris-lb-content">
            <img alt="" class="uris-lb-img">
            <div class="uris-lb-info">
                ${item.style ? `<div class="uris-lb-style">🎨 ${escapeHtml(item.style)}</div>` : ''}
                <div class="uris-lb-prompt">${escapeHtml(item.prompt || '')}</div>
            </div>
            <div class="uris-lb-actions">
                <button class="uris-lb-act" data-act="copy" title="Копировать промпт"><i class="fa-solid fa-copy"></i></button>
                <button class="uris-lb-act" data-act="saveRef" title="Сохранить как референс"><i class="fa-solid fa-bookmark"></i></button>
                <button class="uris-lb-act" data-act="regen" title="Перегенерировать"><i class="fa-solid fa-rotate-right"></i></button>
                <button class="uris-lb-act uris-lb-act-danger" data-act="del" title="Удалить"><i class="fa-solid fa-trash"></i></button>
            </div>
            ${_items.length > 1 ? `<div class="uris-lb-nav prev">‹</div><div class="uris-lb-nav next">›</div>` : ''}
            <div class="uris-lb-counter">${_index + 1} / ${_items.length}</div>
            <div class="uris-lb-close">✕</div>
        </div>`;
    lb.querySelector('.uris-lb-img').src = item.src;
    document.body.appendChild(lb);
    lb.querySelector('.uris-lb-close').addEventListener('click', close);
    lb.querySelector('.uris-lb-nav.prev')?.addEventListener('click', prev);
    lb.querySelector('.uris-lb-nav.next')?.addEventListener('click', next);
    lb.querySelector('[data-act="copy"]')?.addEventListener('click', () => copyPrompt(item));
    lb.querySelector('[data-act="saveRef"]')?.addEventListener('click', () => saveAsReference(item));
    lb.querySelector('[data-act="regen"]')?.addEventListener('click', async () => {
        await regenerate(item, _root, null);
        // After regeneration the items list is stale; close so the grid re-render shows the new image.
        close();
    });
    lb.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
        await deleteImage(item, _chatId, _root);
        // The card may be hidden/removed; close the lightbox.
        close();
    });

    // Один листенер на document: Escape/←/→. Снимается в close() и при re-render.
    if (_onKey) document.removeEventListener('keydown', _onKey);
    _onKey = (e) => {
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowLeft') prev();
        else if (e.key === 'ArrowRight') next();
    };
    document.addEventListener('keydown', _onKey);

    // swipe: вниз — закрыть, влево/вправо — листать
    let sx = 0, sy = 0;
    lb.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    lb.addEventListener('touchend', (e) => {
        const dx = e.changedTouches[0].clientX - sx;
        const dy = e.changedTouches[0].clientY - sy;
        if (Math.abs(dy) > Math.abs(dx) && dy > 80) close();
        else if (Math.abs(dx) > 60) {
            if (dx < 0) next();
            else prev();
        }
    }, { passive: true });
}
```

Update the `showLightbox` call site in `tab-gallery.js` (Task 7 already touched the view handler) to pass the chat context and root:

```js
        cardEl.querySelector('[data-act="view"]')?.addEventListener('click', (e) => {
            e.stopPropagation(); showLightbox(items, idx, { chatId, root });
        });
```

- [ ] **Step 2: Add the actions bar styles**

Append to `style.css` (find the existing `.uris-lightbox` block and add these adjacent rules):

```css
.uris-lb-actions {
    display: flex;
    gap: 8px;
    justify-content: center;
    padding: 10px 12px;
    background: rgba(0, 0, 0, 0.4);
    border-radius: 8px;
    margin-top: 10px;
}
.uris-lb-act {
    background: rgba(255, 255, 255, 0.1);
    border: none;
    color: #fff;
    width: 38px;
    height: 38px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s;
}
.uris-lb-act:hover { background: rgba(255, 255, 255, 0.22); }
.uris-lb-act-danger:hover { background: rgba(220, 53, 69, 0.6); }
```

- [ ] **Step 3: Run the lightbox-related tests**

Run: `node --test tests/tab-gallery-layout.test.js`
Expected: PASS (the layout test checks structure; verify it doesn't assert the absence of an actions bar — if it does, update it).

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/lightbox.js src/ui/tab-gallery.js style.css
git commit -m "feat(lightbox): add actions bar (copy/save-ref/regen/delete) reusing gallery-actions"
```

---

## Task 9: Remove the dead `copyToStGallery` config

**Files:**
- Modify: `src/core.js:184, 210`
- Modify: `src/chat-binding.js:18, 80, 152` (and the schema-v5 migration)
- Modify: `src/pipeline-config.js:27, 41`
- Modify: `src/ui/tab-gallery.js:28-31, 39-46`
- Test: `tests/chat-binding.test.js`

- [ ] **Step 1: Confirm `galleryMode` is also dead**

Verified by grep at plan-writing time: `galleryMode` appears ONLY in normalization/assignment (no `if galleryMode ===` branch anywhere):
- `src/chat-binding.js:79` (normalize enum), `:151` (assign to state.settings)
- `src/core.js:129` (doc comment), `:183` (default), `:209` (envelope default)
- `src/pipeline-config.js:26, :40` (snapshot copy)

**Conclusion: `galleryMode` is fully dead. Remove it entirely** (same treatment as `copyToStGallery`). No need to keep `'anchor'`.

If you want to re-verify before implementing, run:
`grep -rn "galleryMode ===\|galleryMode !==\|if.*galleryMode\|switch.*galleryMode" src/ --include="*.js"`
Expected: no hits.

- [ ] **Step 2: Write a failing test for the schema-v5 migration**

Append to `tests/chat-binding.test.js`:

```js
test('schema-v5 migration drops copyToStGallery and galleryMode from loaded configs', async () => {
    const { normalizeChatConfig } = await import('../src/chat-binding.js');
    const legacy = {
        schemaVersion: 4,
        config: { imageProfileId: 'p1', templateId: 't1', automationMode: 'manual', generationFlow: 'ai-only', galleryMode: 'st-only', copyToStGallery: true },
        refs: { referenceIds: [] },
    };
    const normalized = normalizeChatConfig(legacy);
    assert.equal(normalized.schemaVersion, 5);
    assert.equal(Object.hasOwn(normalized.config, 'copyToStGallery'), false);
    assert.equal(Object.hasOwn(normalized.config, 'galleryMode'), false);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/chat-binding.test.js`
Expected: FAIL — `normalizeChatConfig` does not yet drop the keys or bump the schema.

- [ ] **Step 4: Remove `copyToStGallery` from defaults**

In `src/core.js`:
- Remove the line `copyToStGallery: false, // автосохранение...` (line 184) from `defaultSettings`.
- Remove `copyToStGallery: false,` (line 210) and `galleryMode: 'anchor',` (line 209) from `DEFAULT_CHAT_CONFIG_ENVELOPE.config`.

- [ ] **Step 5: Update `chat-binding.js` — drop the fields and add the migration**

In `src/chat-binding.js`:
- In `VALID_GALLERY_MODES` (line 18), remove the array entirely (Step 1 confirmed `galleryMode` fully dead).
- Remove the `galleryMode` normalization at line 79 and the `copyToStGallery` read at line 80.
- Remove `state.settings.galleryMode = ...` at line 151 and the `copyToStGallery` read at line 152.
- In the schema-version normalize path (find the `schemaVersion` handling), add migration from v4 → v5 that drops `copyToStGallery` and `galleryMode`:

```js
// In the normalize function, after ensuring the envelope shape:
if (envelope.schemaVersion < 5) {
    delete envelope.config?.copyToStGallery;
    delete envelope.config?.galleryMode;
    envelope.schemaVersion = 5;
}
```

The exact location depends on the existing structure — place it where other schema-version migrations live.

- [ ] **Step 6: Remove the `copyToStGallery` and `galleryMode` reads from `pipeline-config.js`**

In `src/pipeline-config.js`:
- In `createChatConfigSnapshot()` (lines 22-29), remove lines 26 (`galleryMode`) and 27 (`copyToStGallery`). The snapshot becomes just `{ imageProfileId, templateId }`.
- In `resolveChatConfigSnapshot()` (lines 37-44), remove lines 40 (`galleryMode`) and 41 (`copyToStGallery`). The return becomes `{ imageProfileId, templateId, imageRoute }`.

Then in `src/core.js`, find the `ChatConfigSnapshot` JSDoc typedef (around lines 126-133) and remove the `galleryMode:string` and `copyToStGallery:boolean` lines from it.

**Check for consumers:** after editing, run `grep -rn "\.galleryMode\|\.copyToStGallery" src/ --include="*.js"`. Expected: no hits (any consumer reading these fields would now break). If a hit appears (e.g. `pipeline-stage2.js` reading `snapshot.copyToStGallery`), remove that read too — recall the spec confirmed no branch consumes them, so any read is dead passthrough.

- [ ] **Step 7: Remove the dead UI checkbox**

In `src/ui/tab-gallery.js`, remove the checkbox label block (lines 28-31) and its `change` listener (lines 39-46). Also remove the now-unused imports `patchChatConfig` and `state` if no longer used.

- [ ] **Step 8: Run the chat-binding tests**

Run: `node --test tests/chat-binding.test.js`
Expected: PASS — including the new migration test.

- [ ] **Step 9: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 10: Verify no references remain**

Run: `grep -rn "copyToStGallery" src/ --include="*.js"`
Expected: no hits (or only in a migration comment if you keep one).

Run: `grep -rn "galleryMode" src/ --include="*.js"`
Expected: no hits.

- [ ] **Step 11: Commit**

```bash
git add src/core.js src/chat-binding.js src/pipeline-config.js src/ui/tab-gallery.js tests/chat-binding.test.js
git commit -m "refactor(config): remove dead copyToStGallery/galleryMode; schema-v5 migration"
```

---

## Task 10: Integration test — end-to-end generation → Show Gallery → delete

**Files:**
- Create: `tests/image-storage-integration.test.js`

**Why:** Verify the whole chain works together: generation resolves the character folder, the file lands there, reconcile finds it, and delete (both modes) behaves correctly across folders.

- [ ] **Step 1: Write the integration test**

Create `tests/image-storage-integration.test.js`:

```js
// @ts-check
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

let originalFetch;
let originalSt;
let uploadedFolders = [];
let deletedPaths = [];
let listedFolders = [];

beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalSt = globalThis.SillyTavern;
    uploadedFolders = [];
    deletedPaths = [];
    listedFolders = [];
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getRequestHeaders: () => ({}),
            characterId: 0,
            characters: [{ name: 'Aria' }],
            groupId: null,
        }),
        libs: { localforage: { getItem: async () => '' } },
    };
    globalThis.fetch = async (url, options) => {
        if (url === '/api/images/upload') {
            const body = JSON.parse(options.body);
            uploadedFolders.push(body.ch_name);
            return { ok: true, json: async () => ({ path: `user/images/${encodeURIComponent(body.ch_name)}/${body.filename}.png` }) };
        }
        if (url === '/api/images/delete') {
            deletedPaths.push(JSON.parse(options.body).path);
            return { ok: true, json: async () => ({}) };
        }
        if (url === '/api/images/list') {
            const folder = JSON.parse(options.body).folder;
            listedFolders.push(folder);
            return { ok: true, json: async () => [] };
        }
        return { ok: true, json: async () => ({}) };
    };
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.SillyTavern = originalSt;
});

test('generation lands in the character folder and reconcile confirms it', async () => {
    const { addCard, listCards } = await import('../src/gallery-index.js');
    // Simulate a card that the generation pipeline would have produced:
    await addCard({
        id: 'gen-1',
        imagePath: 'user/images/Aria/aria_scene.png',
        prompt: 'portrait',
        provenance: { chatId: 'c1', characterFolder: 'Aria' },
    });
    const cards = await listCards(); // triggers reconcile
    assert.equal(cards.find(c => c.id === 'gen-1').status, 'ready');
    assert.ok(listedFolders.includes('Aria'), 'reconcile scanned the Aria folder');
});

test('soft delete hides; hard delete removes card and file', async () => {
    const { addCard, listCards } = await import('../src/gallery-index.js');
    const { deleteGalleryCard, getGallery } = await import('../src/storage.js');
    await addCard({ id: 'soft', imagePath: 'user/images/Aria/s.png', prompt: 'p', provenance: { chatId: 'c1' } });
    await addCard({ id: 'hard', imagePath: 'user/images/Aria/h.png', prompt: 'p', provenance: { chatId: 'c1' } });

    await deleteGalleryCard('c1', 'soft', { deleteFile: false });
    await deleteGalleryCard('c1', 'hard', { deleteFile: true });

    const visible = await getGallery('c1');
    assert.deepEqual(visible.map(c => c.id), []);
    const all = await listCards({ reconcile: false });
    assert.equal(all.find(c => c.id === 'soft').hidden, true);
    assert.equal(all.find(c => c.id === 'hard'), undefined);
    assert.ok(deletedPaths.includes('user/images/Aria/h.png'));
    assert.equal(deletedPaths.includes('user/images/Aria/s.png'), false);
});

test('legacy folder cards still reconcile after the validator relaxation', async () => {
    const { addCard, listCards } = await import('../src/gallery-index.js');
    await addCard({ id: 'legacy-1', imagePath: 'user/images/UR%20Image%20Studio/old.png', prompt: 'p', provenance: { chatId: 'c1' } });
    const cards = await listCards();
    assert.equal(cards.find(c => c.id === 'legacy-1').status, 'ready');
    assert.ok(listedFolders.includes('UR Image Studio'), 'legacy folder still scanned');
});
```

- [ ] **Step 2: Run the integration test**

Run: `node --test tests/image-storage-integration.test.js`
Expected: PASS — all three tests green.

- [ ] **Step 3: Run the entire suite one final time**

Run: `node --test`
Expected: PASS — full suite green, no regressions.

- [ ] **Step 4: Commit**

```bash
git add tests/image-storage-integration.test.js
git commit -m "test(image-storage): end-to-end generation/reconcile/delete integration coverage"
```

---

## Task 11: Manual verification in SillyTavern

**Files:** none (manual).

- [ ] **Step 1: Load the extension in ST and generate an image**

In a 1:1 chat with a character (e.g. "Aria"), trigger a Stage 2 generation. Open the ST "Show Gallery" (magic-wand button / `/show-gallery`).
Expected: the newly generated image appears in the character's gallery.

- [ ] **Step 2: Verify the extension gallery + lightbox actions**

Open the extension's Gallery tab. The image card should be present. Click the expand icon to open the lightbox. Verify all four actions work: copy prompt (clipboard), save-as-reference (creates a ref), regenerate (produces a new image), delete (shows the modal with the file-deletion checkbox).

- [ ] **Step 3: Verify delete behavior**

- Delete with the checkbox OFF → the card disappears from the extension gallery but the file remains in ST Show Gallery.
- Delete with the checkbox ON → the file is erased from disk and disappears from both the extension gallery and ST Show Gallery.

- [ ] **Step 4: Verify legacy images still render**

Any pre-existing image in `user/images/UR Image Studio/` should still appear in the extension gallery (its card's path still canonicalizes under the relaxed validator).

- [ ] **Step 5: Note any issues for follow-up**

Record observations. If character-rename causes images to disappear from Show Gallery (known limitation §7.1 of the spec), confirm it is documented, not a regression.
