# Browser Image Connection Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make browser-owned image connections reliably refresh catalogs, save browser-local keys transactionally, canonicalize native gallery paths, and honor a safe per-connection timeout without ever replaying a paid generation POST.

**Architecture:** Connection metadata remains in `extensionSettings.ur_image_studio.imageConnections`; API keys remain browser-local in localforage and are projected only as a boolean for the form. A catalog-only GET transport may direct-to-proxy fallback, while image generation remains direct and one-shot. A native-path canonicalizer becomes the single validation boundary for uploads, listings, and gallery metadata, and the normalized connection `timeoutMs` flows through discovery, generation, download, and native upload.

**Tech Stack:** JavaScript ES modules, SillyTavern extension APIs/localforage, Fetch/AbortController, Node.js built-in `node:test`.

---

## File structure

- Modify: `D:/VC CODE/UR Image Studio/src/image-connection-schema.js` — normalize and validate connection `timeoutMs`; continue removing secret fields.
- Modify: `D:/VC CODE/UR Image Studio/src/connection-store.js` — expose observable local key operations and non-secret key-presence lookup.
- Modify: `D:/VC CODE/UR Image Studio/src/connections.js` — return an ephemeral `hasApiKey` UI projection and provide transactional connection/key save behavior.
- Modify: `D:/VC CODE/UR Image Studio/src/ui/server-connection-form.js` — blank-password/presence UI, timeout field, retained-key catalog refresh, and rollback-aware save behavior.
- Modify: `D:/VC CODE/UR Image Studio/src/catalog.js` and `D:/VC CODE/UR Image Studio/src/image-transport.js` — bounded catalog GET fallback only.
- Modify: `D:/VC CODE/UR Image Studio/src/image-api.js`, `src/image-provider-registry.js`, `src/providers/image-openai.js`, `src/providers/image-gemini.js`, `src/providers/image-openrouter.js`, `src/providers/image-chat-completions.js`, and `src/native-image-storage.js` — pass the selected timeout through every network boundary.
- Modify: `D:/VC CODE/UR Image Studio/src/native-image-storage.js`, `src/gallery-index.js`, and `src/storage.js` — canonicalize all accepted native image paths.
- Modify tests: `D:/VC CODE/UR Image Studio/tests/image-connection-schema.test.js`, `tests/connection-store.test.js`, `tests/tab-api-server-connections.test.js`, `tests/catalog.test.js`, `tests/image-transport.test.js`, `tests/image-api-server.test.js`, `tests/image-provider-adapters.test.js`, `tests/native-image-storage.test.js`, and `tests/gallery-index.test.js`.

**Do not create source files, modify the server plugin, put secrets into settings/export/chat/gallery/pending records, or add POST retry/fallback behavior.** This workspace is not a Git repository: do not run Git commands or commit.

### Task 1: Normalize timeout metadata without broadening secret persistence

**Files:**
- Modify: `D:/VC CODE/UR Image Studio/src/image-connection-schema.js`
- Test: `D:/VC CODE/UR Image Studio/tests/image-connection-schema.test.js`
- Test: `D:/VC CODE/UR Image Studio/tests/connection-store.test.js`

- [ ] **Step 1: Write failing timeout-normalization and secret-boundary tests.**

```js
test('normalizes absent connection timeout to 120 seconds and preserves valid millisecond values', () => {
  assert.equal(normalizeConnectionRecord({}).timeoutMs, 120_000);
  assert.equal(normalizeConnectionRecord({ timeoutMs: 15_000 }).timeoutMs, 15_000);
  assert.equal(normalizeConnectionRecord({ timeoutMs: 600_000 }).timeoutMs, 600_000);
});

test('rejects timeout metadata outside the 15 to 600 second range', () => {
  for (const timeoutMs of [14_999, 600_001, 120_500, '120000']) {
    assert.throws(() => normalizeConnectionRecord({ timeoutMs }), /timeoutMs/i);
  }
});
```

Add a store assertion that `timeoutMs` persists but `hasApiKey` and `apiKey` do not:

```js
assert.equal(created.timeoutMs, 120_000);
assert.equal(created.hasApiKey, undefined);
assert.equal(created.apiKey, undefined);
```

- [ ] **Step 2: Run the focused tests and verify failure.**

Run:
```bash
cd "D:/VC CODE/UR Image Studio" && node --test tests/image-connection-schema.test.js tests/connection-store.test.js
```

Expected: FAIL because `timeoutMs` is missing/unchecked and `hasApiKey` is currently not excluded.

- [ ] **Step 3: Implement a single connection timeout normalizer and exclude UI-only presence state.**

In `src/image-connection-schema.js`, define these constants/helpers near existing schema constants and call the helper from `normalizeConnectionRecord`:

```js
const DEFAULT_IMAGE_TIMEOUT_MS = 120_000;
const MIN_IMAGE_TIMEOUT_MS = 15_000;
const MAX_IMAGE_TIMEOUT_MS = 600_000;

function normalizeTimeoutMs(value) {
  if (value === undefined) return DEFAULT_IMAGE_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < MIN_IMAGE_TIMEOUT_MS || value > MAX_IMAGE_TIMEOUT_MS) {
    throw new TypeError('timeoutMs must be an integer between 15000 and 600000');
  }
  return value;
}
```

Ensure the normalized record has `timeoutMs: normalizeTimeoutMs(input.timeoutMs)`. Add `hasApiKey` to the destructured non-persisted fields before `safeInput` is returned. Do not add a secret-shaped timeout alias or permit seconds in metadata.

- [ ] **Step 4: Run the focused tests and verify success.**

Run:
```bash
cd "D:/VC CODE/UR Image Studio" && node --test tests/image-connection-schema.test.js tests/connection-store.test.js
```

Expected: PASS.

### Task 2: Add observable local-key operations, safe key presence, and rollback-capable connection save

**Files:**
- Modify: `D:/VC CODE/UR Image Studio/src/connection-store.js`
- Modify: `D:/VC CODE/UR Image Studio/src/connections.js`
- Modify: `D:/VC CODE/UR Image Studio/src/ui/server-connection-form.js`
- Test: `D:/VC CODE/UR Image Studio/tests/connection-store.test.js`
- Test: `D:/VC CODE/UR Image Studio/tests/tab-api-server-connections.test.js`

- [ ] **Step 1: Write failing tests for blank-but-present key UI and failed key-write rollback.**

Add to `tests/tab-api-server-connections.test.js`:

```js
test('existing saved-key connection renders a blank password and presence label', () => {
  const form = mount({ id: 'browser-1', name: 'Images', hasApiKey: true });
  assert.equal(form.querySelector('.uris-server-api-key').value, '');
  assert.match(form.querySelector('.uris-server-key-status').textContent, /сохранён.*браузер/i);
  assert.equal(form.innerHTML.includes('browser-secret'), false);
});

test('save rolls back metadata when local key storage fails', async () => {
  const selected = route();
  const draft = { id: 'browser-1', name: 'After', endpoint: 'https://images.test', apiKey: 'new-key', selectedRoute: selected };
  const form = mount(draft);
  const updates = [];
  let saved = 0;
  bindServerConnectionForm(form, draft, {
    saveConnection: async patch => { updates.push(patch); return patch; },
    rollbackConnection: async previous => { updates.push({ rollback: previous }); },
    setConnectionApiKey: async () => { throw new Error('localforage unavailable'); },
    rerender: () => {}, onSaved: () => { saved += 1; }, notifyError: () => {},
  });
  await form.querySelector('.uris-server-save').click();
  assert.equal(saved, 0);
  assert.equal(updates.some(item => item.rollback), true);
  assert.match(draft.errorMessage, /localforage unavailable/);
});
```

Add store tests where `localforage.setItem` rejects, then assert the error reaches the caller rather than being swallowed. Also assert `hasConnectionApiKey('primary')` returns only `true`/`false`.

- [ ] **Step 2: Run the focused tests and verify failure.**

Run:
```bash
cd "D:/VC CODE/UR Image Studio" && node --test tests/connection-store.test.js tests/tab-api-server-connections.test.js
```

Expected: FAIL because key errors are swallowed, no presence helper/status exists, and save has no rollback.

- [ ] **Step 3: Make localforage key writes observable and keep reads/presence non-secret.**

In `src/connection-store.js`, retain `getConnectionApiKey(id)` for dispatch, add:

```js
export async function hasConnectionApiKey(id) {
  return Boolean(await getConnectionApiKey(id));
}
```

Change `setConnectionApiKey` and `clearConnectionApiKey` to validate a localforage store exists and let `setItem`/`removeItem` reject. Their contract is now: resolve only after persistence succeeds; reject with the storage error otherwise. Do not return a key value or write it to connection metadata.

- [ ] **Step 4: Implement the UI projection and transactional façade.**

In `src/connections.js`, decorate `listImageConnections()` and `getConnection()` results with only:

```js
hasApiKey: await hasConnectionApiKey(connection.id)
```

Do this after stored metadata normalization; never call `saveConnection` with that property. Add a façade function whose input contains metadata and an optional replacement key, captures the current connection and old browser key first, writes metadata, then writes the new key. On a key failure, restore old metadata using `updateStoredConnection` or delete a newly-created metadata record, restore/remove the former local key, and rethrow the original error. Return a normal projection only after both writes succeed.

- [ ] **Step 5: Implement the form’s blank password UI and call the transactional façade.**

In `renderServerConnectionForm`, keep the password `value` literal empty for every connection. Directly after that input, conditionally render:

```html
<small class="uris-server-key-status">Ключ сохранён в браузере</small>
```

only when `draft.hasApiKey === true`. Do not put status/key in a data attribute. In `collectServerConnectionForm`, calculate `timeoutMs` from a seconds field added in Task 4 and never return `hasApiKey`. In the save handler, call the new transactional façade (injectable as `saveBrowserConnection` in test dependencies); on rejection leave the draft and password text intact, set `errorMessage`, notify, rerender, and skip `onSaved`.

- [ ] **Step 6: Run focused tests and inspect for accidental secret rendering.**

Run:
```bash
cd "D:/VC CODE/UR Image Studio" && node --test tests/connection-store.test.js tests/tab-api-server-connections.test.js
```

Expected: PASS. The rendered-HTML test proves the actual key is absent.

### Task 3: Implement catalog-only direct-to-proxy refresh fallback

**Files:**
- Modify: `D:/VC CODE/UR Image Studio/src/catalog.js`
- Modify: `D:/VC CODE/UR Image Studio/src/image-transport.js`
- Modify: `D:/VC CODE/UR Image Studio/src/ui/server-connection-form.js`
- Test: `D:/VC CODE/UR Image Studio/tests/catalog.test.js`
- Test: `D:/VC CODE/UR Image Studio/tests/image-transport.test.js`
- Test: `D:/VC CODE/UR Image Studio/tests/tab-api-server-connections.test.js`

- [ ] **Step 1: Write failing catalog fallback tests.**

Add direct transport tests using injected direct/proxy functions:

```js
test('catalog GET retries once through proxy after direct CORS failure', async () => {
  const calls = [];
  const response = await fetchCatalogRoute('https://api.example/models', { method: 'GET' }, 120_000, {
    directFetch: async () => { calls.push('direct'); throw new TypeError('Failed to fetch'); },
    proxyFetch: async () => { calls.push('proxy'); return { ok: true, status: 200 }; },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['direct', 'proxy']);
});

test('catalog GET does not proxy HTTP errors, aborts, or timeouts', async () => {
  // Table-drive: direct returns 401; direct throws AbortError; direct throws Error('Таймаут (120с)').
  // Assert proxy call count remains zero in every case.
});
```

In `tests/catalog.test.js`, assert `discoverCatalog({ timeoutMs: 15_000, fetch })` passes that timeout to its fetch abstraction. In UI tests, assert a blank existing form obtains its key transiently from the injected `getConnectionApiKey`, calls discovery with it, then has neither `draft.apiKey` nor `draft.catalog` containing that key.

- [ ] **Step 2: Run focused tests and verify failure.**

Run:
```bash
cd "D:/VC CODE/UR Image Studio" && node --test tests/catalog.test.js tests/image-transport.test.js tests/tab-api-server-connections.test.js
```

Expected: FAIL because catalog discovery uses raw fetch and there is no catalog-specific fallback.

- [ ] **Step 3: Add a GET-only catalog transport.**

In `src/image-transport.js`, export `fetchCatalogRoute(url, options = {}, timeoutMs = 120000, dependencies = {})`. Require `options.method` to be GET (or set it to GET internally), call the injected/default direct function with `fetchWithTimeout`, and only if a real browser CORS/network `TypeError` occurs call the injected/default `proxiedFetch`. Use the same `timeoutMs` and signal on both calls. Return direct HTTP responses unchanged. For abort or `/Таймаут/`, throw unchanged. Do not use this function from `requestJson`, `requestMultipart`, `downloadResult`, or generation code.

- [ ] **Step 4: Route discovery through the catalog transport.**

In `src/catalog.js`, add `timeoutMs = 120000` and a `fetchCatalog` dependency to `discoverCatalog`; make `request` call `fetchCatalog(url.href, { method: 'GET', headers }, timeoutMs)`. The headers remain the only place API keys are present. In `server-connection-form.js`, when refreshing an existing connection with blank form key, retrieve the key from localforage only for `discoverCatalog`; set no draft field from it. Pass `draft.timeoutMs` to discovery.

- [ ] **Step 5: Run focused tests and verify success.**

Run:
```bash
cd "D:/VC CODE/UR Image Studio" && node --test tests/catalog.test.js tests/image-transport.test.js tests/tab-api-server-connections.test.js
```

Expected: PASS, including one direct plus one proxy request only for a CORS/network GET failure.

### Task 4: Add seconds UI and carry timeout through every browser image request

**Files:**
- Modify: `D:/VC CODE/UR Image Studio/src/ui/server-connection-form.js`
- Modify: `D:/VC CODE/UR Image Studio/src/image-api.js`
- Modify: `D:/VC CODE/UR Image Studio/src/image-provider-registry.js`
- Modify: `D:/VC CODE/UR Image Studio/src/providers/image-openai.js`
- Modify: `D:/VC CODE/UR Image Studio/src/providers/image-gemini.js`
- Modify: `D:/VC CODE/UR Image Studio/src/providers/image-openrouter.js`
- Modify: `D:/VC CODE/UR Image Studio/src/providers/image-chat-completions.js`
- Modify: `D:/VC CODE/UR Image Studio/src/native-image-storage.js`
- Test: `D:/VC CODE/UR Image Studio/tests/tab-api-server-connections.test.js`
- Test: `D:/VC CODE/UR Image Studio/tests/image-api-server.test.js`
- Test: `D:/VC CODE/UR Image Studio/tests/image-provider-adapters.test.js`
- Test: `D:/VC CODE/UR Image Studio/tests/native-image-storage.test.js`

- [ ] **Step 1: Write failing UI and propagation tests.**

Add a form test:

```js
test('connection timeout renders in seconds and collects bounded milliseconds', () => {
  const form = mount({ draftId: 'new-1', timeoutMs: 120_000 });
  assert.equal(form.querySelector('.uris-server-timeout').value, '120');
  form.querySelector('.uris-server-timeout').value = '15';
  assert.equal(collectServerConnectionForm(form, {}).timeoutMs, 15_000);
});
```

Add a generation test that injects a provider and materializer and asserts `timeoutMs: 600_000` reaches both without appearing in `savePendingBrowserRequest` data. Add provider adapter assertions that `transport.calls[0].timeoutMs === 15_000`. Add native storage tests asserting `downloadResult` and upload `fetchWithTimeout` receive the provided timeout.

- [ ] **Step 2: Run focused tests and verify failure.**

Run:
```bash
cd "D:/VC CODE/UR Image Studio" && node --test tests/tab-api-server-connections.test.js tests/image-api-server.test.js tests/image-provider-adapters.test.js tests/native-image-storage.test.js
```

Expected: FAIL because provider/materialization network calls default independently to 120 seconds.

- [ ] **Step 3: Add the bounded seconds control and collection validation.**

In `renderServerConnectionForm`, add the control:

```html
<div class="uris-row"><label>Таймаут (сек.)</label><input class="text_pole uris-server-timeout" type="number" min="15" max="600" step="1" value="120"></div>
```

Generate its value from `Math.round((draft.timeoutMs ?? 120000) / 1000)`. In collection, require an integer `15 <= seconds <= 600`; throw `TypeError('Timeout must be an integer between 15 and 600 seconds')` otherwise, then return `timeoutMs: seconds * 1000`. Include `timeoutMs` in the metadata input passed to save.

- [ ] **Step 4: Thread one resolved timeout through generation and materialization.**

In `generateImageRequest`, resolve `const timeoutMs = conn.timeoutMs;`, pass it as `timeoutMs` to `invokeImageProvider`, and call:

```js
materializeImageResult(result, { filename: `uris_${request.requestId}`, signal: signal || state.abortController?.signal, timeoutMs });
```

Do not add it to `pendingSnapshot`. In the registry, preserve `timeoutMs` when invoking the adapter. In every provider adapter, pass `timeoutMs` as the final argument to `transport.requestJson` / `transport.requestMultipart`. Update `requestJson` and `requestMultipart` signatures to forward it to `fetchImageRoute`.

In `native-image-storage.js`, accept `{ timeoutMs = 120000 }`; send it to `downloadResult(result.value, { signal }, timeoutMs)` and make upload fetch use the same timeout-aware fetch boundary rather than bare `fetch`. Preserve ST request headers and abort signal.

- [ ] **Step 5: Run focused timeout propagation tests and verify success.**

Run:
```bash
cd "D:/VC CODE/UR Image Studio" && node --test tests/tab-api-server-connections.test.js tests/image-api-server.test.js tests/image-provider-adapters.test.js tests/native-image-storage.test.js
```

Expected: PASS. Verify 15/120/600 seconds map exactly to 15000/120000/600000 milliseconds.

### Task 5: Canonicalize all native gallery paths at one boundary

**Files:**
- Modify: `D:/VC CODE/UR Image Studio/src/native-image-storage.js`
- Modify: `D:/VC CODE/UR Image Studio/src/gallery-index.js`
- Modify: `D:/VC CODE/UR Image Studio/src/storage.js`
- Test: `D:/VC CODE/UR Image Studio/tests/native-image-storage.test.js`
- Test: `D:/VC CODE/UR Image Studio/tests/gallery-index.test.js`

- [ ] **Step 1: Write failing equivalent-path and unsafe-path tests.**

Add this table-driven test to `tests/native-image-storage.test.js`:

```js
test('canonicalizes supported ST gallery path variants', () => {
  for (const input of [
    'user/images/UR Image Studio/my image.png',
    '/user/images/UR%20Image%20Studio/my%20image.png',
    'user/images/UR%20Image%20Studio/my image.png',
  ]) {
    assert.equal(canonicalizeNativeImagePath(input), 'user/images/UR%20Image%20Studio/my%20image.png');
  }
});

test('rejects unsafe or non-native gallery paths', () => {
  for (const input of [
    '', 'user/images/Other/file.png', 'user/images/UR%20Image%20Studio/%2Fescape.png',
    'user/images/UR%20Image%20Studio/%2e%2e', 'user/images/UR%20Image%20Studio/a.png?x=1',
    'user/images/UR%20Image%20Studio/a%ZZ.png', 'user/images/UR%20Image%20Studio/a/b.png',
  ]) assert.throws(() => canonicalizeNativeImagePath(input), /native image path/i);
});
```

Add gallery-index tests that a literal-space native input is stored canonically and an encoded slash is rejected before a card is created. Add upload response tests for accepted literal-space paths and rejected foreign/unsafe paths.

- [ ] **Step 2: Run focused tests and verify failure.**

Run:
```bash
cd "D:/VC CODE/UR Image Studio" && node --test tests/native-image-storage.test.js tests/gallery-index.test.js
```

Expected: FAIL because current regexes accept only one representation and upload returns raw server paths.

- [ ] **Step 3: Implement the canonicalizer.**

Export `canonicalizeNativeImagePath(value)` from `src/native-image-storage.js`. Its required algorithm is:

```js
// 1. Require a nonempty string; reject ?, #, backslashes, and control characters.
// 2. Remove one optional leading slash; split on '/'; require exactly 4 segments.
// 3. Decode every segment once with decodeURIComponent; malformed percent encoding throws.
// 4. Require decoded segments ['user', 'images', 'UR Image Studio', filename].
// 5. Reject empty filename, '.'/'..', slash/backslash, NUL/control characters in filename.
// 6. Return `user/images/${encodeURIComponent(NATIVE_GALLERY_FOLDER)}/${encodeURIComponent(filename)}`.
```

Never decode repeatedly: `%252F` remains a filename containing literal `%2F` after one decode and is re-encoded safely, while a once-encoded slash `%2F` is rejected.

- [ ] **Step 4: Replace duplicate acceptance checks with canonicalizer calls.**

In `uploadPayload`, return `canonicalizeNativeImagePath(payload.path)`. In `listNativeImages`, construct each candidate then canonicalize it; skip invalid list entries. In `gallery-index.js`, import the canonicalizer and set `out.imagePath = canonicalizeNativeImagePath(existing?.imagePath || cleanText(input.imagePath))`. In `storage.js`, make `isNativeGalleryPath` attempt canonicalization; when a supplied native path is accepted, replace it with the canonical returned value before indexing. Do not accept a raw provider URL as a native path.

- [ ] **Step 5: Run focused path tests and verify success.**

Run:
```bash
cd "D:/VC CODE/UR Image Studio" && node --test tests/native-image-storage.test.js tests/gallery-index.test.js
```

Expected: PASS; all valid variants yield `user/images/UR%20Image%20Studio/<encoded filename>`.

### Task 6: Lock down one-shot paid generation and complete regression verification

**Files:**
- Modify only if tests expose a gap: `D:/VC CODE/UR Image Studio/src/image-transport.js`, `src/image-api.js`, or provider files listed in Task 4
- Test: `D:/VC CODE/UR Image Studio/tests/image-transport.test.js`
- Test: `D:/VC CODE/UR Image Studio/tests/image-api-server.test.js`
- Test: `D:/VC CODE/UR Image Studio/tests/browser-runtime-boundaries.test.js`
- Test: `D:/VC CODE/UR Image Studio/tests/retry-policy.test.js`

- [ ] **Step 1: Write/extend paid-POST no-replay tests.**

Add a timeout case to `tests/image-transport.test.js`:

```js
test('paid POST timeout makes exactly one direct request and never proxies', async () => {
  const calls = [];
  const restore = mockFetch((_url, _options, viaProxy) => {
    calls.push(viaProxy);
    throw new Error('Таймаут (15с)');
  });
  try {
    await assert.rejects(() => fetchImageRoute('https://images.example/v1/generations', { method: 'POST' }, route(), 15_000), /Таймаут/);
    assert.deepEqual(calls, [false]);
  } finally { restore(); }
});
```

In `tests/image-api-server.test.js`, inject a provider that rejects after one call and assert the pending record is `dispatchingUnknown`, contains no `apiKey`, and invocation count is one. Add a source-boundary assertion that `src/catalog.js` is the only new caller of `fetchCatalogRoute` and that provider files do not call `proxiedFetch`.

- [ ] **Step 2: Run the one-shot focused tests and verify failure if a regression exists.**

Run:
```bash
cd "D:/VC CODE/UR Image Studio" && node --test tests/image-transport.test.js tests/image-api-server.test.js tests/browser-runtime-boundaries.test.js tests/retry-policy.test.js
```

Expected: PASS if Tasks 1–5 did not weaken the existing one-shot route. If it fails, do not add a retry; restore POST routing so only catalog GET uses proxy fallback.

- [ ] **Step 3: Verify the complete targeted reliability suite.**

Run:
```bash
cd "D:/VC CODE/UR Image Studio" && node --test tests/image-connection-schema.test.js tests/connection-store.test.js tests/tab-api-server-connections.test.js tests/catalog.test.js tests/image-transport.test.js tests/image-api-server.test.js tests/image-provider-adapters.test.js tests/native-image-storage.test.js tests/gallery-index.test.js tests/browser-runtime-boundaries.test.js tests/retry-policy.test.js
```

Expected: PASS with no test key present in persisted objects or rendered markup.

- [ ] **Step 4: Run the full suite.**

Run:
```bash
cd "D:/VC CODE/UR Image Studio" && node --test tests/*.test.js
```

Expected: PASS. If unrelated baseline failures occur, report their file/test names separately; do not mask them or alter unrelated behavior.

- [ ] **Step 5: Inspect changed code for the scope invariants.**

Run:
```bash
cd "D:/VC CODE/UR Image Studio" && grep -RInE 'apiKey|timeoutMs|fetchCatalogRoute|canonicalizeNativeImagePath' src tests --exclude-dir=node_modules
```

Expected: API keys occur only in runtime request/header/localforage and tests, `timeoutMs` appears in every specified network path, `fetchCatalogRoute` is catalog-only, and canonicalization is used before gallery indexing.

## Self-review

- **Spec coverage:** Task 2 covers browser-local key presence, blank password UI, key error propagation, and rollback; Task 3 covers GET-only model refresh fallback; Task 4 covers the seconds UI and propagation through catalog/adapters/download/ST upload; Task 5 covers canonical native gallery paths and unsafe rejection; Task 6 proves a paid POST is not retried. The no-secret DOM/settings/shared metadata/export/chat/gallery/pending constraints are tested across Tasks 1, 2, and 6.
- **Placeholder scan:** No `TODO`, `TBD`, “appropriate error handling,” or implicit test steps remain. Every code-edit step names the function/value contract and every verification step gives a command and expected result.
- **Type consistency:** Connection metadata uses `timeoutMs` only; UI converts `uris-server-timeout` seconds to it. The UI-only projection is consistently `hasApiKey`. Catalog fallback is consistently `fetchCatalogRoute`. Native path validation is consistently `canonicalizeNativeImagePath`. The transactional UI dependency is consistently `saveBrowserConnection` (with store rollback behavior encapsulated behind it).
