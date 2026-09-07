# Server Image Connections — Client Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подключить browser extension к готовому server API, добавить простой server connection form, unified connection facade и durable Stage 2 recovery, не меняя legacy Agnes/Pollinations.

**Architecture:** Новый `server-image-api.js` — единственный HTTP client. `connections.js` остаётся публичным unified facade. Новый UI-модуль рендерит server form, а `tab-api.js` только оркестрирует. `image-api.js` выбирает server branch до старой provider логики. Stage 2 сохраняет `requestId` pending до POST.

**Tech Stack:** Vanilla browser ES modules, SillyTavern context headers, localforage, `node:test`, existing fake DOM.

**Depends on:** foundation and adapters/generation plans completed and server API contract green.

---

## Files created or changed

```text
src/
├── server-image-api.js                    # new
├── server-connection-state.js             # new
├── connections.js                         # unified facade
├── models.js                              # server refresh facade
├── image-api.js                           # server generation branch
├── pipeline-stage2.js                     # pre-request pending
├── image-recovery.js                      # serverRequest states
├── ui/server-connection-form.js           # new
├── ui/tab-api.js                          # orchestration
├── ui/tab-generate.js                     # recovery/reference status
└── index.js                               # handshake/startup recovery

style.css

tests/
├── server-image-api.test.js
├── connections-server-facade.test.js
├── tab-api-server-connections.test.js
├── server-stage2-recovery.test.js
└── server-plugin/client-fixtures.js
```

Do not implement server provider serialization in client files.

---

### Task 1: Add the thin server API client

**Files:**
- Create: `src/server-image-api.js`
- Create: `tests/server-image-api.test.js`
- Create: `tests/server-plugin/client-fixtures.js`

- [ ] **Step 1: Write failing base/status tests**

Exact base:

```text
/api/plugins/ur-image-studio/v1
```

Test `getServerImageApiStatus()` validates `apiVersion === 1` and required features. Missing/incompatible server returns `ServerImageApiError` code `SERVER_COMPONENT_UNAVAILABLE` or `SERVER_COMPONENT_INCOMPATIBLE`.

- [ ] **Step 2: Write failing request-shape tests**

Exports:

```js
getServerImageApiStatus
listServerConnections
probeTransientConnection
probeStoredConnection
createServerConnection
updateServerConnection
deleteServerConnection
generateServerImage
getServerRequest
```

Assert use of `getCtx().getRequestHeaders()`, JSON content type where needed, same-origin paths, and AbortSignal propagation.

- [ ] **Step 3: Write failing error/no-retry tests**

Parse structured server errors. For `/generate` network error, fetch call count remains 1. Do not call `autoFetch`, `probeCorsProxy`, or `callWithRetry`.

- [ ] **Step 4: Run RED**

```bash
node --test tests/server-image-api.test.js
```

- [ ] **Step 5: Implement pluginFetch and methods**

Use `fetchWithTimeout` only as one-attempt transport. For generation, timeout/error is returned to caller for request-status recovery; never retry POST.

- [ ] **Step 6: Run GREEN and commit**

```bash
node --test tests/server-image-api.test.js
git add src/server-image-api.js tests/server-image-api.test.js tests/server-plugin/client-fixtures.js
git commit -m "feat(client): add server image API client"
```

---

### Task 2: Add server availability state and startup handshake

**Files:**
- Create: `src/server-connection-state.js`
- Modify: `index.js`
- Create/Modify: `tests/smoke.test.js`

- [ ] **Step 1: Write failing state tests**

State shape:

```js
{
    status: 'unknown' | 'available' | 'unavailable' | 'incompatible',
    serverInfo: null,
    lastError: null,
}
```

`refreshServerConnectionState()` coalesces concurrent status checks and does not throw into app initialization.

- [ ] **Step 2: Write failing source/lifecycle test**

Assert `index.js` performs handshake before rendering API connection controls, but failure does not block legacy tabs/providers.

- [ ] **Step 3: Run RED**

```bash
node --test tests/server-image-api.test.js tests/smoke.test.js
```

- [ ] **Step 4: Implement state and lifecycle wiring**

No polling/background refresh. UI can explicitly call refresh after plugin installation.

- [ ] **Step 5: Run GREEN and commit**

```bash
node --test tests/server-image-api.test.js tests/smoke.test.js
git add src/server-connection-state.js index.js tests/smoke.test.js
git commit -m "feat(client): detect server image component availability"
```

---

### Task 3: Build unified server + legacy connection facade

**Files:**
- Modify: `src/connections.js`
- Create: `tests/connections-server-facade.test.js`
- Modify: `tests/connections-reference-options.test.js`

- [ ] **Step 1: Preserve dirty legacy behavior in tests**

Before edits, run and record current Pollinations lazy model migration and reference-options tests. Add fixtures for Agnes/Pollinations local records.

- [ ] **Step 2: Write failing merge tests**

`listImageConnections()` returns:

- server projections from plugin with `executionOwner:'server'`;
- local Agnes/Pollinations with `executionOwner:'legacy-browser'`;
- no duplicate local migrated record when same ID exists on server.

Server projection is authority on duplicate ID.

- [ ] **Step 3: Write failing resolve/key tests**

For server record:

```js
resolveConnection(id) // { conn, apiKey: '' }
```

and `getConnectionKey(id)` must not be invoked. Legacy record still returns local key.

- [ ] **Step 4: Write failing CRUD delegation tests**

Server create/update/delete call plugin API. Legacy Agnes/Pollinations use existing local CRUD. New server create accepts caller ID generated with existing `uid()`.

- [ ] **Step 5: Run RED**

```bash
node --test tests/connections-server-facade.test.js tests/connections-reference-options.test.js
```

- [ ] **Step 6: Implement facade without deleting legacy code**

Add normalizers:

```js
normalizeServerProjection
normalizeLegacyProjection
isServerOwnedConnection
```

Keep existing public exports. Do not add server API families to old `VALID_API_TYPES`.

- [ ] **Step 7: Run GREEN and commit**

```bash
node --test tests/connections-server-facade.test.js tests/connections-reference-options.test.js
git add src/connections.js tests/connections-server-facade.test.js tests/connections-reference-options.test.js
git commit -m "refactor(client): unify server and legacy image connections"
```

---

### Task 4: Add focused server connection form module

**Files:**
- Create: `src/ui/server-connection-form.js`
- Modify: `src/ui/tab-api.js`
- Modify: `style.css`
- Create: `tests/tab-api-server-connections.test.js`

- [ ] **Step 1: Write failing pure markup/state tests**

Normal form displays only name, endpoint, key, Connect and load models. After transient probe displays route select, refreshed timestamp, warnings, and Save. When probe returns `CATALOG_UNAVAILABLE`, `CATALOG_UNSUPPORTED`, or `NO_IMAGE_MODELS`, display a conditional manual model-ID input and require Advanced API mode to be a non-auto family. No catalog paths/auth/reference protocol/CORS controls.

- [ ] **Step 2: Write failing persistence tests**

Adding a new server card creates only an in-memory draft. Probe calls the transient endpoint, does not call create, and stores returned `probeId` only in that draft. Save calls create once with exact `modelRoute`, `probeId`, endpoint, and API key; manual routes omit `probeId`. After success, clear key and receipt from memory. API key is never copied into a connection projection or localforage.

- [ ] **Step 3: Write failing existing-card tests**

Existing key input is empty with “leave blank to keep key”; Refresh calls stored probe without key; Save with empty key does not rotate. Stale catalog label is visible but nonblocking.

- [ ] **Step 4: Write failing manual/plugin-state tests**

Manual model requires non-auto API mode. `collectServerConnectionForm()` constructs exactly:

```js
{
    modelRoute: {
        id: stableRouteId(apiFamily, 'manual', modelId),
        modelId,
        label: modelId,
        apiFamily,
        source: 'manual',
        confidence: 'manual',
        capabilities: {
            generation: true,
            references: 'unknown',
            aspectRatios: null,
            imageSizes: null,
            qualities: null,
        },
    },
}
```

Test empty model ID, `auto` family, and unsupported family errors. Missing/incompatible plugin disables server add/save and shows one user message. Legacy Agnes/Pollinations cards remain enabled and keep existing reference/provider controls.

- [ ] **Step 5: Run RED**

```bash
node --test tests/tab-api-server-connections.test.js tests/tab-api-reference-options.test.js
```

- [ ] **Step 6: Implement isolated form module**

Exports should be focused:

```js
renderServerConnectionForm
collectServerConnectionForm
bindServerConnectionForm
validateServerConnectionDraft
```

`tab-api.js` imports it and retains legacy render/bind functions. Avoid a wholesale rewrite of dirty `tab-api.js`.

- [ ] **Step 7: Add narrow CSS states**

Add only namespaced classes for unavailable notice, probe loading/warning/success, stale label, advanced mode, Save/Cancel, and keyless imported connection. Do not rewrite existing proxy/legacy CSS.

- [ ] **Step 8: Run GREEN and commit markup/form**

```bash
node --test tests/tab-api-server-connections.test.js tests/tab-api-reference-options.test.js
git add src/ui/server-connection-form.js src/ui/tab-api.js tests/tab-api-server-connections.test.js
git commit -m "feat(ui): add server image connection form"
```

- [ ] **Step 9: Commit styles**

```bash
git add style.css
git commit -m "style(ui): add server connection states"
```

---

### Task 5: Route model refresh through the server facade

**Files:**
- Modify: `src/models.js`
- Modify: `tests/models.test.js`

- [ ] **Step 1: Write failing server refresh tests**

For `executionOwner:'server'`, `fetchModels(id)` calls stored probe and returns routes/catalog projection; does not read browser key, call `/v1/models` directly, or use `autoFetch`.

- [ ] **Step 2: Preserve legacy tests**

Pollinations catalog path and current dirty model migration must remain green. Agnes legacy manual behavior remains.

- [ ] **Step 3: Run RED**

```bash
node --test tests/models.test.js
```

- [ ] **Step 4: Implement early server branch**

Keep generic browser branch temporarily for unmigrated old records until migration plan retires it.

- [ ] **Step 5: Run GREEN and commit**

```bash
node --test tests/models.test.js
git add src/models.js tests/models.test.js
git commit -m "feat(client): refresh server image model catalogs"
```

---

### Task 6: Delegate server-owned generation before legacy provider logic

**Files:**
- Modify: `src/image-api.js`
- Create/Modify: `tests/image-api-server.test.js`
- Modify: `tests/image-api-references.test.js`

- [ ] **Step 1: Write failing branch-order test**

Server record must call `generateServerImage()` before:

```text
getConnectionKey
resolveApiType
getImageProvider
resolveReferencePolicy
probeCorsProxy
callWithRetry
```

Instrument these functions/mocks to throw if touched.

- [ ] **Step 2: Write failing reference test**

Server path passes all selected references unchanged except canonical field mapping/compression already done upstream. It must not call current `prepareReferences()` and must not slice. Legacy path keeps current behavior.

- [ ] **Step 3: Write failing request ID test**

Server connection requires `request.requestId`; missing ID gives client programming error before network. Legacy request may omit it.

- [ ] **Step 4: Run RED**

```bash
node --test tests/image-api-server.test.js tests/image-api-references.test.js
```

- [ ] **Step 5: Implement early branch**

Return existing `{kind:'dataUrl', value}` contract from ready server envelope. Propagate structured request state/error for Stage 2 recovery; do not retry POST.

- [ ] **Step 6: Run GREEN and commit**

```bash
node --test tests/image-api-server.test.js tests/image-api-references.test.js
git add src/image-api.js tests/image-api-server.test.js tests/image-api-references.test.js
git commit -m "feat(client): delegate server-owned image generation"
```

---

### Task 7: Add `serverRequest` pending records

**Files:**
- Modify: `src/image-recovery.js`
- Create: `tests/server-stage2-recovery.test.js`
- Modify: `tests/image-recovery.test.js`

- [ ] **Step 1: Write failing schema/transition tests**

Add exports:

```js
savePendingServerRequest
updatePendingServerRequest
resumePendingServerRequests
resumeServerRequest
discardPending
```

Pending record uses `id === requestId`, `kind:'serverRequest'`, frozen instruction/ref/gallery metadata, and status `submitted`. Legacy URL/dataURL pending keeps its existing seven-day cleanup. Unresolved `serverRequest` records (`submitted`, `notSubmitted`, `failed-ambiguous`, or definitive `failed` awaiting user discard) are exempt from that automatic TTL and remain until successful gallery finalization or explicit Discard. Add an older-than-seven-days fixture that survives startup recovery.

- [ ] **Step 2: Write failing request-state tests**

Transitions:

- server ready → convert same item to `dataUrl/pending`, then existing `processPending`;
- server unavailable → retain submitted;
- confirmed `REQUEST_NOT_FOUND` → `notSubmitted`;
- failed-ambiguous → retained, never automatically submitted;
- definitive failed → retained with safe error;
- discard removes.

- [ ] **Step 3: Write failing explicit Resume test**

Only `resumeServerRequest(id)` may POST when status is `notSubmitted`; it uses same request ID and immutable stored snapshot. Startup recovery calls only GET status.

- [ ] **Step 4: Run RED**

```bash
node --test tests/server-stage2-recovery.test.js tests/image-recovery.test.js
```

- [ ] **Step 5: Refactor shared pending insert/update minimally**

Extract private `_insertPending` and `_updatePending` without changing URL/dataUrl behavior.

- [ ] **Step 6: Implement transitions and run GREEN**

```bash
node --test tests/server-stage2-recovery.test.js tests/image-recovery.test.js
```

- [ ] **Step 7: Commit**

```bash
git add src/image-recovery.js tests/server-stage2-recovery.test.js tests/image-recovery.test.js
git commit -m "feat(client): add server request recovery states"
```

---

### Task 8: Persist request ID before `/generate` in Stage 2

**Files:**
- Modify: `src/pipeline-stage2.js`
- Modify: `tests/server-stage2-recovery.test.js`
- Modify: `tests/pipeline-stage2-serialization.test.js`

- [ ] **Step 1: Write failing operation-order test**

Capture operations and assert:

```text
persist immutable Stage2 snapshot
→ save serverRequest pending
→ call generateImageRequest
→ update pending with ready data
→ processPending
```

- [ ] **Step 2: Write failing legacy-order regression**

Agnes/Pollinations continue existing post-success pending flow and do not create serverRequest records.

- [ ] **Step 3: Write failing error-state tests**

Network interruption leaves serverRequest. Definitive failure updates draft error and pending safe error. Stage 2 FIFO cleanup remains correct.

- [ ] **Step 4: Run RED**

```bash
node --test tests/server-stage2-recovery.test.js tests/pipeline-stage2-serialization.test.js
```

- [ ] **Step 5: Implement owner-aware Stage 2 branch**

Generate the paid-request idempotency key with `crypto.randomUUID()` after active connection resolution and before network. Validate server request IDs as UUIDs independently from legacy connection IDs; keep existing `uid()` only for stable connection-ID compatibility. Include the UUID in `generateImageRequest`.

- [ ] **Step 6: Run GREEN and commit**

```bash
node --test tests/server-stage2-recovery.test.js tests/pipeline-stage2-serialization.test.js
git add src/pipeline-stage2.js tests/server-stage2-recovery.test.js tests/pipeline-stage2-serialization.test.js
git commit -m "feat(client): persist server request before generation"
```

---

### Task 9: Wire startup recovery and user Resume/Discard controls

**Files:**
- Modify: `index.js`
- Modify: `src/ui/tab-generate.js`
- Modify: `style.css`
- Modify: `tests/server-stage2-recovery.test.js`
- Modify: `tests/tab-generate.test.js`

- [ ] **Step 1: Write failing startup tests**

`index.js` continues `resumePendingImages()` for URL/dataUrl and additionally calls `resumePendingServerRequests()`. Startup never calls `/generate`.

- [ ] **Step 2: Write failing UI tests**

Generate tab displays unresolved safe states:

```text
Checking result
Not sent — Resume / Discard
Provider result uncertain — no automatic retry
Failed — Discard
```

Resume appears only for `notSubmitted`; clicking uses same request ID. Discard removes record and rerenders.

- [ ] **Step 3: Run RED**

```bash
node --test tests/server-stage2-recovery.test.js tests/tab-generate.test.js
```

- [ ] **Step 4: Implement startup and focused UI block**

Do not create a new tab. Do not expose server journal internals or diagnostics by default.

- [ ] **Step 5: Run client gate**

```bash
node --test --test-concurrency=1 \
  tests/server-image-api.test.js \
  tests/connections-server-facade.test.js \
  tests/tab-api-server-connections.test.js \
  tests/image-api-server.test.js \
  tests/server-stage2-recovery.test.js \
  tests/image-recovery.test.js \
  tests/pipeline-stage2-serialization.test.js \
  tests/tab-generate.test.js
```

Expected: all PASS.

- [ ] **Step 6: Commit UI code**

```bash
git add index.js src/ui/tab-generate.js tests/server-stage2-recovery.test.js tests/tab-generate.test.js
git commit -m "feat(client): recover and resume server image requests"
```

- [ ] **Step 7: Commit styles**

```bash
git add style.css
git commit -m "style(ui): add server request recovery states"
```
