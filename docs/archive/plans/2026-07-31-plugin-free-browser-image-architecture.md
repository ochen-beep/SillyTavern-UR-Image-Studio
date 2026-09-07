# Plugin-Free Browser Image Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the mandatory URIS server-plugin dependency while preserving the current UI, sharing non-secret state through SillyTavern, storing API keys per browser, generating into the native ST gallery, and dispatching image requests through explicit browser-side provider contracts.

**Architecture:** Shared JSON collections move from the plugin store into `extensionSettings[ur_image_studio]`; chat-scoped state remains in schema-v4 `chatMetadata`; image bytes are stored through ST's native `/api/images/upload` and listed through `/api/images/list`; localforage retains only browser-local secrets and transient/cache data. Browser generation uses route-scoped, versioned `generationContract` values and static adapters, with direct fetch followed by the existing ST JSON CORS proxy where eligible. The plugin code is not part of the default runtime path, but migration and optional legacy compatibility are handled explicitly.

**Tech Stack:** ES modules, browser Fetch API, SillyTavern extension APIs, localforage, Node built-in test runner (`node --test`), existing URIS provider/reference utilities.

---

## File Map

### Create

- `src/image-connection-schema.js` - normalize connection records, route contracts, capabilities, transport feasibility, and migrations.
- `src/connection-store.js` - shared connection/catalog persistence in `extensionSettings`, with browser-local API-key accessors.
- `src/catalog.js` - generic, Gemini-native, and explicit OpenRouter discovery plus full-catalog filtering.
- `src/image-transport.js` - direct/proxy fetch policy for JSON and direct-only multipart requests.
- `src/providers/image-base.js` - canonical image request/result types and common response/error helpers.
- `src/providers/image-openai.js` - OpenAI Images generations and multipart edits.
- `src/providers/image-gemini.js` - Gemini Native `generateContent` image generation and inline references.
- `src/providers/image-chat-completions.js` - OpenAI-compatible multimodal chat image generation and response parsing.
- `src/providers/image-openrouter.js` - explicit OpenRouter image catalog/generation/reference handling.
- `src/image-provider-registry.js` - static contract-to-adapter registry.
- `src/gallery-index.js` - shared gallery card metadata and reconciliation with native ST image files.
- `src/native-image-storage.js` - native ST image upload/list helpers.
- `tests/image-connection-schema.test.js`
- `tests/connection-store.test.js`
- `tests/catalog.test.js`
- `tests/image-transport.test.js`
- `tests/image-provider-adapters.test.js`
- `tests/gallery-index.test.js`
- `tests/native-image-storage.test.js`

### Modify

- `src/core.js` - add shared connection/catalog/gallery settings schema, key namespace helpers, and migration defaults; keep API keys outside settings.
- `src/connections.js` - replace server-owned facade with shared metadata plus localforage key resolution; preserve public connection API used by UI.
- `src/image-api.js` - replace server-only generation with route adapter dispatch, local pending states, and canonical result normalization.
- `src/proxy.js` - expose an explicit JSON-only transport capability and reject multipart proxy attempts before network dispatch.
- `src/references.js` - use native ST image storage paths and avoid duplicate bytes where possible.
- `src/refs-library.js` - use shared extension settings for refs/folders; retain chat metadata binding and native upload.
- `src/prompt-templates.js` - restore local mutation fallback as the normal shared settings backend.
- `src/param-presets.js` - restore local mutation fallback as the normal shared settings backend.
- `src/storage.js` - replace localforage gallery source-of-truth with native ST files plus gallery index; preserve cache compatibility.
- `src/data-port.js` - export/import shared settings, safe collections, route contracts, gallery cards, and no secrets.
- `src/ui/server-connection-form.js` - rename/remove server-only operations; add catalog filtering, contract selection, and browser transport status.
- `src/ui/tab-api.js` - use browser connection CRUD/discovery and show missing-key/CORS states.
- `src/ui/tab-generate.js` - use native gallery and explicit reference feasibility errors.
- `src/index.js` - remove mandatory server status/store gating, run shared-settings migrations, and initialize native gallery reconciliation.
- `src/text-connection.js` - leave ST Connection Manager path intact; make custom text transport use the same direct/proxy policy where applicable.
- `tests/connections-server-facade.test.js` - replace plugin-bound expectations with shared metadata/key behavior.
- `tests/image-api-server.test.js` - replace server-only assertions with browser adapter dispatch tests.
- `tests/prompt-templates-store.test.js` - add shared settings mutation assertions.
- `tests/param-presets-store.test.js` - add shared settings mutation assertions.
- `tests/refs-library.test.js` - add shared settings persistence assertions.
- `tests/data-port.test.js` - update export/import shape and secret exclusion assertions.
- `tests/tab-api-server-connections.test.js` - cover new browser connection form flow.
- `docs/cors-proxy-setup.md` - document JSON-only fallback and multipart limitation.
- `manifest.json` or extension metadata only if the current plugin dependency is declared there.

### Retire from the default path

- `src/server-image-api.js`, `src/server-connection-state.js`, `src/server-store-api.js`, and `src/store-state.js` become legacy compatibility modules or are removed only after all imports/tests are migrated.
- `server-plugin/` remains untouched until the browser path is verified; its removal is a separate cleanup decision, not part of the first migration commit.

---

## Task 1: Establish the Shared Connection and Route Schema

**Files:** Create `src/image-connection-schema.js`, modify `src/core.js`, test `tests/image-connection-schema.test.js`.

- [ ] **Step 1: Write failing normalization tests.** Cover: missing IDs, endpoint normalization, supported contract allowlist, `supported/unsupported/unknown` capabilities, `json` versus `multipart` transport, unknown contract rejection, secret-field removal, and migration of current `selectedRoute/apiFamily` records.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConnection, normalizeRoute, stripSecrets } from '../src/image-connection-schema.js';

test('normalizes a route contract and derives JSON transport', () => {
    const route = normalizeRoute({ id: 'r1', modelId: 'gpt-image-1', apiFamily: 'openai', generationContract: 'openai-images' });
    assert.equal(route.generationContract, 'openai-images');
    assert.equal(route.transport.bodyKind, 'json');
    assert.equal(route.capabilities.references, 'unknown');
});

test('rejects executable or unknown contract values', () => {
    assert.throws(() => normalizeRoute({ generationContract: 'javascript:alert(1)' }), /Unsupported generation contract/);
});

test('removes keys from shared connection metadata', () => {
    assert.deepEqual(stripSecrets({ apiKey: 'k', name: 'x', nested: { token: 't' } }), { name: 'x', nested: {} });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails because the schema module is absent.**

Run: `node --test tests/image-connection-schema.test.js`
Expected: FAIL with an import/module-not-found error.

- [ ] **Step 3: Implement the schema.** Define the four contracts (`openai-images`, `gemini-native`, `chat-completions`, `openrouter-images`), version `1`, capability enum, stable route ID derivation from source/model/contract, bounded route metadata, and migration rules from `apiFamily`/`selectedRoute`. Never accept arbitrary request templates or executable catalog metadata.

- [ ] **Step 4: Add settings defaults and key helpers in `core.js`.** Add a versioned shared-settings section for connections, catalogs, gallery index, templates, presets, refs, and folders. Add a connection-key prefix helper such as `uris_api_key:<connectionId>` and do not place key values in defaults or settings.

- [ ] **Step 5: Run the focused test and commit.**

Run: `node --test tests/image-connection-schema.test.js`
Expected: PASS.

Commit: `git add src/core.js src/image-connection-schema.js tests/image-connection-schema.test.js && git commit -m "feat: define browser image connection contracts"`

---

## Task 2: Move Shared Collections and Credentials to Native Client Storage

**Files:** Create `src/connection-store.js`, modify `src/connections.js`, `src/prompt-templates.js`, `src/param-presets.js`, `src/refs-library.js`, test the corresponding collection suites.

- [ ] **Step 1: Write failing store tests.** Verify CRUD writes to `extensionSettings`, reads survive a fresh module call, API keys use localforage by connection ID, `stripSecrets` is applied before settings writes, and missing keys return an explicit empty value.

- [ ] **Step 2: Run focused tests and confirm they fail against the current server-only implementation.**

Run: `node --test tests/connection-store.test.js tests/connections-server-facade.test.js tests/prompt-templates-store.test.js tests/param-presets-store.test.js tests/refs-library.test.js`
Expected: the new store suite fails and existing facade assertions show server-bound behavior.

- [ ] **Step 3: Implement `connection-store.js`.** Expose `listConnections`, `getConnection`, `createConnection`, `updateConnection`, `deleteConnection`, `setConnectionApiKey`, `getConnectionApiKey`, and `clearConnectionApiKey`. Store only normalized metadata under `extensionSettings[MODULE_NAME].imageConnections`; store keys in localforage under the connection-specific prefix.

- [ ] **Step 4: Change `connections.js` to delegate to the new store.** Preserve `listConnections`, `listImageConnections`, `getConnection`, `createConnection`, `saveConnection`, `deleteConnection`, and `resolveConnection` signatures used by the UI. `resolveConnection` returns `{ conn, apiKey }` by reading the current browser key; it must not write the key into the connection record.

- [ ] **Step 5: Restore mutation fallbacks for templates, presets, refs, and folders.** Replace `requireServerStore()` failures with shared-settings collection reads/writes. Keep existing normalization and cache behavior. Native image upload remains separate from metadata CRUD.

- [ ] **Step 6: Update tests and run them.** Replace expectations that keys are removed before the browser adapter receives them; assert that keys never appear in shared settings/export but are available through `resolveConnection` in the current browser.

Run: `node --test tests/connection-store.test.js tests/connections-server-facade.test.js tests/prompt-templates-store.test.js tests/param-presets-store.test.js tests/refs-library.test.js`
Expected: PASS.

- [ ] **Step 7: Commit.**

Commit: `git add src/connection-store.js src/connections.js src/prompt-templates.js src/param-presets.js src/refs-library.js tests && git commit -m "feat: persist shared image metadata in ST settings"`

---

## Task 3: Implement Model Discovery and Contract Selection

**Files:** Create `src/catalog.js`, modify `src/ui/server-connection-form.js` and `src/ui/tab-api.js`, test `tests/catalog.test.js` and `tests/tab-api-server-connections.test.js`.

- [ ] **Step 1: Write failing catalog tests.** Cover one generic `/v1/models` request, full catalog retention, likely-image filtering without deletion, unknown capability state, explicit OpenRouter discovery only, and route contract persistence.

```js
test('keeps unknown generic models for Show all', async () => {
    const catalog = await discoverGenericCatalog({ endpoint: 'https://proxy.example', apiKey: 'k' }, fakeTransport([
        { id: 'custom-image-model', object: 'model' },
        { id: 'text-model', object: 'model' },
    ]));
    assert.equal(catalog.routes.length, 2);
    assert.equal(catalog.routes.find(r => r.modelId === 'custom-image-model').capabilities.generate, 'unknown');
});

test('does not probe OpenRouter for a generic endpoint', async () => {
    const calls = [];
    await discoverGenericCatalog({ endpoint: 'https://proxy.example', apiKey: 'k' }, fakeTransport([], calls));
    assert.deepEqual(calls.map(call => call.url), ['https://proxy.example/v1/models']);
});
```

- [ ] **Step 2: Run the focused test and confirm failure.**

Run: `node --test tests/catalog.test.js`
Expected: FAIL because `catalog.js` does not exist.

- [ ] **Step 3: Implement catalog discovery.** Normalize generic endpoints once, preserve raw bounded descriptors, classify likely image routes without deleting unknowns, derive route-scoped `generationContract` suggestions, and distinguish `supported`, `unsupported`, and `unknown` capabilities. Add Gemini-native listing and explicit OpenRouter listing behind separate functions.

- [ ] **Step 4: Update connection form/UI.** Replace server probe calls with generic/Gemini/OpenRouter discovery. Add the default “Image models” filter and “Show all” control. Add a contract selector for the selected route, show the suggested contract as a suggestion rather than proof, and show transport feasibility (`direct CORS required` for multipart).

- [ ] **Step 5: Add migration of current server route projections.** When loading an old connection without `generationContract`, derive a conservative suggestion once, mark it for user confirmation if ambiguous, and do not silently choose an adapter from model name during generation.

- [ ] **Step 6: Run UI/catalog tests and commit.**

Run: `node --test tests/catalog.test.js tests/tab-api-server-connections.test.js`
Expected: PASS.

Commit: `git add src/catalog.js src/ui/server-connection-form.js src/ui/tab-api.js tests/catalog.test.js tests/tab-api-server-connections.test.js && git commit -m "feat: add explicit browser route discovery"`

---

## Task 4: Add Browser Transport with CORS and Multipart Boundaries

**Files:** Create `src/image-transport.js`, modify `src/proxy.js`, test `tests/image-transport.test.js` and `tests/proxy.test.js`.

- [ ] **Step 1: Write failing transport tests.** Cover direct JSON success, direct CORS failure followed by ST proxy, upstream 4xx/5xx without fallback, abort without fallback, multipart rejection through ST proxy, and direct multipart success.

- [ ] **Step 2: Run focused tests and confirm failure.**

Run: `node --test tests/image-transport.test.js tests/proxy.test.js`
Expected: the new transport suite fails because the module is absent; existing proxy tests remain the baseline.

- [ ] **Step 3: Implement `image-transport.js`.** Expose `requestJson`, `requestMultipart`, and `downloadResult`. `requestJson` uses `autoFetch`; `requestMultipart` uses direct fetch only and throws a typed `MULTIPART_CORS_REQUIRED` error when direct access fails. Never fallback on HTTP responses, abort, or timeout.

- [ ] **Step 4: Tighten `proxy.js`.** Export a capability check for JSON-only proxy use and ensure no caller can pass a `FormData` body through `/proxy/:url`. Keep existing host strategy caching and disabled-proxy diagnostics.

- [ ] **Step 5: Run focused tests and commit.**

Run: `node --test tests/image-transport.test.js tests/proxy.test.js`
Expected: PASS.

Commit: `git add src/image-transport.js src/proxy.js tests/image-transport.test.js tests/proxy.test.js && git commit -m "feat: enforce browser transport and multipart CORS rules"`

---

## Task 5: Port Static Image Provider Adapters

**Files:** Create `src/providers/image-base.js`, `src/providers/image-openai.js`, `src/providers/image-gemini.js`, `src/providers/image-chat-completions.js`, `src/providers/image-openrouter.js`, `src/image-provider-registry.js`, tests `tests/image-provider-adapters.test.js`.

- [ ] **Step 1: Write failing adapter tests.** Include exact request/response assertions for:
  - OpenAI JSON `/images/generations` with `data[0].url` and `data[0].b64_json`;
  - OpenAI multipart `/images/edits` with repeated image fields and no proxy use;
  - Gemini `generateContent` with ordered `inlineData` references and `candidates[].content.parts[].inlineData` response;
  - chat completions multimodal `image_url` parts and `choices[0].message.images[]` response;
  - explicit OpenRouter image request and `input_references` response;
  - malformed success response as an error without resubmission.

- [ ] **Step 2: Run the adapter tests and confirm failure.**

Run: `node --test tests/image-provider-adapters.test.js`
Expected: FAIL because the new adapter modules are absent.

- [ ] **Step 3: Implement the canonical base helpers.** Define one image request shape, one normalized data URL result, bounded upstream error extraction, and response parsers for URL, base64, binary, and documented image-array variants.

- [ ] **Step 4: Port and adapt OpenAI/Gemini behavior.** Use the saved route contract, preserve explicit endpoint versions, omit unsupported fields, use `output_format` where required, use native Gemini key authentication for native endpoints, and encode references according to the selected contract.

- [ ] **Step 5: Implement chat-completions adapter.** Send text plus ordered `image_url` data URLs, support documented image response variants including `message.images`, and reject text-only responses as unsupported image results.

- [ ] **Step 6: Implement explicit OpenRouter adapter.** Keep official OpenRouter paths and metadata rules separate from generic proxies; support its catalog, request parameters, references, headers, and response extraction.

- [ ] **Step 7: Register adapters by `generationContract`, not endpoint or model regex.** Unknown or unsupported contract versions fail before paid dispatch with a clear re-selection error.

- [ ] **Step 8: Run adapter tests and commit.**

Run: `node --test tests/image-provider-adapters.test.js`
Expected: PASS.

Commit: `git add src/providers/image-base.js src/providers/image-openai.js src/providers/image-gemini.js src/providers/image-chat-completions.js src/providers/image-openrouter.js src/image-provider-registry.js tests/image-provider-adapters.test.js && git commit -m "feat: add explicit browser image provider adapters"`

---

## Task 6: Store Generated Bytes in Native ST Gallery and Persist Cards

**Files:** Create `src/native-image-storage.js`, `src/gallery-index.js`, modify `src/storage.js`, `src/references.js`, test `tests/native-image-storage.test.js` and `tests/gallery-index.test.js`.

- [ ] **Step 1: Write failing native-storage/index tests.** Cover upload path/format, list normalization, metadata card persistence in extension settings, joining listed files to cards, marking deleted files missing, and preserving manually added files as metadata-light cards.

- [ ] **Step 2: Run focused tests and confirm failure.**

Run: `node --test tests/native-image-storage.test.js tests/gallery-index.test.js`
Expected: FAIL because the new modules are absent.

- [ ] **Step 3: Implement native storage helpers.** Upload data URLs through `/api/images/upload` into a stable `UR Image Studio` folder, return the ST-relative path, list via `/api/images/list`, and never put image bytes into extension settings.

- [ ] **Step 4: Implement gallery index.** Store full card metadata under shared settings, reconcile against native file paths, create `missing` states, and provide `addCard`, `updateCard`, `removeCard`, `listCards`, and `reconcileCards`.

- [ ] **Step 5: Switch `storage.js` gallery source.** Keep localforage only as optional thumbnail/cache storage. Make native files plus shared cards the source of truth. Keep existing chat-specific gallery compatibility during migration.

- [ ] **Step 6: Update reference ingestion.** Reuse an existing native image path when a gallery card is saved as a reference; otherwise optimize and upload once, then persist only the path and dimensions in the ref record.

- [ ] **Step 7: Run focused tests and commit.**

Run: `node --test tests/native-image-storage.test.js tests/gallery-index.test.js tests/tab-gallery-layout.test.js tests/refs-library.test.js`
Expected: PASS.

Commit: `git add src/native-image-storage.js src/gallery-index.js src/storage.js src/references.js tests/native-image-storage.test.js tests/gallery-index.test.js && git commit -m "feat: use native ST gallery with shared image cards"`

---

## Task 7: Replace Server-Only Generation Boundary

**Files:** Modify `src/image-api.js`, `src/ui/tab-generate.js`, `src/index.js`, create/update generation recovery tests.

- [ ] **Step 1: Write failing dispatch tests.** Assert: selected route resolves its registered adapter; API key comes only from localforage; pending state is written before dispatch; a successful result is uploaded and indexed; unknown dispatch state is not automatically retried; unsupported multipart transport produces a clear error; request IDs use one documented bounded format.

- [ ] **Step 2: Run focused tests and confirm failure against server-only implementation.**

Run: `node --test tests/image-api-server.test.js tests/generation-drafts.test.js`
Expected: failures showing the current `/api/plugins/.../generate` boundary.

- [ ] **Step 3: Implement browser `generateImageRequest`.** Resolve connection metadata and current-browser key, validate the saved route contract, write `notStarted`, call the registry exactly once for the paid POST, transition to `dispatchingUnknown` before network dispatch, normalize the result, upload to native ST storage, add a gallery card, and mark `ready` only after both result and card persistence succeed.

- [ ] **Step 4: Handle safe retries only.** Retry discovery/result downloads using existing bounded policy. Never retry a paid generation after timeout, abort, network ambiguity, or malformed success. Expose a manual “review/discard” state for `dispatchingUnknown`.

- [ ] **Step 5: Remove mandatory server status/store gating from `index.js`.** Run settings/schema migrations and gallery reconciliation regardless of plugin availability. Do not call server store migration as an initialization prerequisite.

- [ ] **Step 6: Update Generate UI.** Replace pending server request actions with local pending-state actions, show missing-key and CORS/multipart errors, preserve existing reference policy and generation draft UI, and display the native gallery path/card state.

- [ ] **Step 7: Run focused tests and commit.**

Run: `node --test tests/image-api-server.test.js tests/generation-drafts.test.js tests/pipeline-stage2-serialization.test.js tests/tab-generate.test.js`
Expected: PASS after replacing server-bound expectations.

Commit: `git add src/image-api.js src/ui/tab-generate.js src/index.js tests && git commit -m "feat: dispatch image generation in the browser"`

---

## Task 8: Update Export/Import and Migrate Existing Data

**Files:** Modify `src/data-port.js`, `src/core.js`, `src/index.js`, tests `tests/data-port.test.js`, `tests/store-migration.test.js`.

- [ ] **Step 1: Write failing export/import tests.** Assert export includes shared connections, route contracts, templates, presets, refs, folders, gallery cards, and schema-v4 metadata; excludes all API keys, secret IDs, request journals, raw image bytes, and transient pending state; import restores normalized metadata and leaves existing local keys untouched.

- [ ] **Step 2: Run tests and confirm current server-shaped export fails the new expectations.**

Run: `node --test tests/data-port.test.js tests/store-migration.test.js`
Expected: failures around `imageConnections.server` and plugin-owned collections.

- [ ] **Step 3: Implement the new backup schema.** Version the snapshot, store shared settings as the portable authority, include only safe localforage collections, include gallery cards and chat metadata, and preserve the explicit excluded-secret declaration.

- [ ] **Step 4: Implement migration.** Import old localforage collections, migrate server projections into shared connection records, convert `selectedRoute.apiFamily` to a route contract where unambiguous, flag ambiguous routes for confirmation, and do not import plugin secrets or recovery state.

- [ ] **Step 5: Run tests and commit.**

Run: `node --test tests/data-port.test.js tests/store-migration.test.js tests/chat-binding.test.js`
Expected: PASS.

Commit: `git add src/data-port.js src/core.js src/index.js tests/data-port.test.js tests/store-migration.test.js && git commit -m "feat: migrate browser-safe URIS data"`

---

## Task 9: Remove Default Plugin Dependency and Update Documentation

**Files:** Modify `src/server-image-api.js`, `src/server-connection-state.js`, `src/server-store-api.js`, `src/store-state.js`, `docs/cors-proxy-setup.md`, extension entrypoints; keep `server-plugin/` unchanged until verified.

- [ ] **Step 1: Search for runtime imports and initialization gates.**

Run: `rg -n "server-image-api|server-store-api|server-connection-state|store-state|/api/plugins/ur-image-studio|refreshServerConnectionState|refreshStoreState|resumePendingServerRequests" index.js src tests`
Expected: only legacy adapters/tests remain after Tasks 2-8.

- [ ] **Step 2: Remove or isolate legacy modules.** Ensure a missing plugin does not prevent extension initialization, UI rendering, shared settings, native gallery browsing, or browser generation. Retain typed compatibility wrappers only where migration/import needs them.

- [ ] **Step 3: Document operational requirements.** State that `enableCorsProxy: true` or `--corsProxy` is required for JSON requests to non-CORS endpoints; multipart edits require direct CORS; one browser is the supported writer; API keys are re-entered per browser; Syncthing is backup/transfer support, not live multi-ST conflict resolution.

- [ ] **Step 4: Run smoke tests and commit.**

Run: `node --test tests/smoke.test.js tests/final-verification.test.js tests/server-st-integration.test.js`
Expected: extension smoke tests pass; any server-plugin-only tests are either explicitly legacy-scoped or removed from the default client command.

Commit: `git add index.js src docs tests && git commit -m "docs: make browser image mode the default"`

---

## Task 10: Full Verification and Optional Plugin Cleanup

**Files:** all changed files; no plugin deletion in the first pass.

- [ ] **Step 1: Run the complete client test suite.**

Run: `node --test tests/*.test.js`
Expected: all browser/shared-storage tests pass. Server-plugin tests may remain as a separate legacy suite if the plugin is retained.

- [ ] **Step 2: Run static dependency checks.**

Run: `rg -n "api/plugins/ur-image-studio|ServerImageApi|ServerStoreApi|serverOwned|executionOwner.*server|apiKey.*extensionSettings|localforage.*gallery" index.js src tests`
Expected: no default runtime path depends on the plugin; API keys remain excluded from shared settings; localforage is not the gallery source of truth.

- [ ] **Step 3: Verify manually in one ST installation.**

Use two browsers against the same ST user and verify:

1. Create a connection in browser A without exporting the key.
2. Open browser B and see the connection card with a missing-key state.
3. Enter the key in B and run safe model discovery.
4. Select a route and contract; reload B and confirm the same route is selected.
5. Generate once; confirm the file appears in native ST gallery and the URIS card shows prompt/model/references.
6. Open A, enter its local key, and confirm the same image/card/reference metadata is visible.
7. Remove the file from native ST gallery and confirm URIS marks it missing.
8. Test a JSON request through ST CORS proxy and a multipart request against a CORS-enabled endpoint.
9. Confirm a multipart request against proxy-only transport fails clearly without a second request.
10. Repeat the flow in Termux.

- [ ] **Step 4: Decide whether to delete `server-plugin/`.** Only after the browser path is verified and no optional legacy workflow is required. If retained, label it optional and keep its tests separate from the default extension test command.

- [ ] **Step 5: Record verification evidence and commit the final integration.**

Commit: `git add . && git commit -m "feat: complete plugin-free browser image architecture"`
