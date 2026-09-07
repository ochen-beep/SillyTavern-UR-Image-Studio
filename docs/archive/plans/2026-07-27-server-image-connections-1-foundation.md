# Server Image Connections — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Создать устанавливаемый SillyTavern server plugin с безопасным per-user storage, SecretManager, внутренним crash-recoverable connection service, destination policy и status API; публичный create/update откладывается до появления probe validation в плане 2.

**Architecture:** `server-plugin/` — самостоятельный ESM package. Тонкий router делегирует focused services. Все user data вычисляются из `req.user.directories.root`; secrets живут в SillyTavern SecretManager; cross-file operations используют durable markers; внешний HTTP проходит только через policy-enforced client.

**Tech Stack:** Node.js >=20 ESM, SillyTavern server plugin API, `node:test`, `write-file-atomic`, `node-fetch`.

**Depends on:** `docs/superpowers/specs/2026-07-27-server-image-api-connections-design.md`

---

## File structure established by this plan

```text
server-plugin/
├── package.json
├── index.js
└── src/
    ├── router.js
    ├── errors.js
    ├── validation.js
    ├── host/sillytavern.js
    ├── storage/paths.js
    ├── storage/mutex.js
    ├── storage/atomic-json.js
    ├── storage/connections-store.js
    ├── storage/operations-store.js
    ├── secrets/secret-store.js
    ├── network/endpoint.js
    ├── network/destination-policy.js
    ├── network/safe-fetch.js
    └── services/connections.js

tests/
├── server-plugin-entry.test.js
├── server-errors.test.js
├── server-storage.test.js
├── server-operations.test.js
├── server-secrets.test.js
├── server-destination-policy.test.js
├── server-safe-fetch.test.js
├── server-connections.test.js
├── server-router.test.js
└── server-plugin/
    ├── fake-router.js
    ├── fake-user.js
    ├── fake-secret-manager.js
    └── temp-store.js
```

Server test files stay at `tests/server-*.test.js` so current Node test commands include them.

### Versioned connection DTO fixed by this plan

All later server and client tasks use this exact safe projection:

```js
{
    id,
    kind: 'image',
    name,
    endpoint,
    apiFamilyOverride: 'auto' | 'openai-images' | 'gemini-native' | 'openrouter-images',
    modelRouteId,
    selectedRoute: null | {
        id,
        modelId,
        label,
        apiFamily,
        source,
        confidence,
        capabilities,
    },
    timeoutMs,
    hasApiKey,
    catalog: null | {
        routes,
        fetchedAt,
        stale,
        warnings,
    },
    createdAt,
    updatedAt,
}
```

`executionOwner` is never server-returned; `src/connections.js` adds it in the client facade. Create/update requests use `modelRoute`; storage writes its ID to `modelRouteId`; safe projection returns both `modelRouteId` and sanitized `selectedRoute`. List/create/update envelopes are `{ connection }` or `{ connections }`; delete returns `{ deleted: true, connectionId }`; errors use the Task 1 error envelope. No response includes `secretId`, API key, paths, operation markers, full remote metadata, or unbounded warnings.

---

### Task 1: Create the ESM plugin skeleton and status contract

**Files:**
- Create: `server-plugin/package.json`
- Create: `server-plugin/package-lock.json`
- Create: `server-plugin/index.js`
- Create: `server-plugin/src/router.js`
- Create: `server-plugin/src/errors.js`
- Create: `tests/server-plugin-entry.test.js`
- Create: `tests/server-errors.test.js`
- Create: `tests/server-plugin/fake-router.js`

- [ ] **Step 1: Write the failing entry-shape test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const entryUrl = new URL('../server-plugin/index.js', import.meta.url);

test('server plugin exports SillyTavern lifecycle contract', async () => {
    const plugin = await import(entryUrl.href);
    assert.deepEqual(plugin.info, {
        id: 'ur-image-studio',
        name: 'UR Image Studio',
        description: 'Server execution for UR Image Studio image APIs',
    });
    assert.equal(typeof plugin.init, 'function');
    assert.equal(typeof plugin.exit, 'function');
});
```

- [ ] **Step 2: Write the failing status/error tests**

Create a fake router that records `get/post/put/delete` handlers. Test that `init(router)` registers `GET /v1/status`, and that `toErrorEnvelope()` returns only `code`, safe `message`, `retryable`, and `diagnosticsId`.

Expected status body:

```js
{
    ok: true,
    apiVersion: 1,
    features: {
        connections: true,
        discovery: true,
        generation: true,
        requestRecovery: true,
    },
    apiFamilies: [
        'openai-images',
        'gemini-native',
        'openrouter-images',
    ],
}
```

- [ ] **Step 3: Run RED tests**

```bash
node --test tests/server-plugin-entry.test.js tests/server-errors.test.js
```

Expected: FAIL because plugin files do not exist.

- [ ] **Step 4: Add the package boundary**

`server-plugin/package.json`:

```json
{
  "name": "@ur-image-studio/sillytavern-server-plugin",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "main": "./index.js",
  "engines": { "node": ">=20" },
  "dependencies": {
    "node-fetch": "^3.3.2",
    "write-file-atomic": "^5.0.1"
  }
}
```

Run `npm install --package-lock-only --ignore-scripts` in `server-plugin/` and commit `server-plugin/package-lock.json`. Production installation must run `npm ci --omit=dev --ignore-scripts` inside the physically installed plugin directory before SillyTavern starts; symlinking this repository without installed plugin-local dependencies is unsupported. The later integration test imports both dependencies from the installed plugin directory and fails clearly when installation was skipped.

- [ ] **Step 5: Implement minimal entry/router/errors**

`index.js` exports exact `info`, calls `registerRoutes(router)` in `init`, and has no-op async `exit`. `router.js` registers only `/v1/status`. `errors.js` defines `ServerImageError` and `toErrorEnvelope(error)` with `crypto.randomUUID()` diagnostics IDs when absent.

- [ ] **Step 6: Install the plugin-local dependency tree and run GREEN tests**

```bash
npm install --package-lock-only --ignore-scripts --prefix server-plugin
npm ci --omit=dev --ignore-scripts --prefix server-plugin
node --test tests/server-plugin-entry.test.js tests/server-errors.test.js
```

Expected: dependency installation succeeds and tests PASS.

- [ ] **Step 7: Commit**

```bash
git add server-plugin/package.json server-plugin/package-lock.json server-plugin/index.js server-plugin/src/router.js server-plugin/src/errors.js tests/server-plugin-entry.test.js tests/server-errors.test.js tests/server-plugin/fake-router.js
git commit -m "feat(server): add plugin skeleton and status contract"
```

---

### Task 2: Add user-scoped paths, mutex, and atomic JSON

**Files:**
- Create: `server-plugin/src/storage/paths.js`
- Create: `server-plugin/src/storage/mutex.js`
- Create: `server-plugin/src/storage/atomic-json.js`
- Create: `tests/server-storage.test.js`
- Create: `tests/server-plugin/fake-user.js`
- Create: `tests/server-plugin/temp-store.js`

- [ ] **Step 1: Write failing path tests**

Test that:

```js
getUserPaths({ user: { directories: { root: '/data/alice' } } })
```

returns paths rooted under `/data/alice/plugins/ur-image-studio`, and rejects missing `req.user.directories.root` with `SERVER_USER_CONTEXT_MISSING`.

- [ ] **Step 2: Write failing concurrency/atomic tests**

Use a temporary directory. Start 20 concurrent `updateJson(path, defaultValue, updater)` calls incrementing one counter. Assert final value is 20. Inject a writer that throws before rename and assert the old valid JSON remains readable.

- [ ] **Step 3: Run RED**

```bash
node --test tests/server-storage.test.js
```

- [ ] **Step 4: Implement focused storage modules**

Contracts:

```js
export function getUserPaths(req) {
    return {
        root,
        connections,
        requests,
        operations,
        artifacts,
        journalKey,
    };
}

export async function withLock(key, fn);
export async function readJson(file, fallback);
export async function writeJson(file, value);
export async function updateJson(file, fallback, updater);
```

Use `write-file-atomic` async API. Ensure directory creation with POSIX `0700`; write files with `0600`; apply `chmod` best effort outside Windows.

- [ ] **Step 5: Run GREEN**

```bash
node --test tests/server-storage.test.js
```

- [ ] **Step 6: Commit**

```bash
git add server-plugin/src/storage tests/server-storage.test.js tests/server-plugin/fake-user.js tests/server-plugin/temp-store.js
git commit -m "feat(server): add user-scoped atomic storage"
```

---

### Task 3: Add durable operation markers and reconciliation

**Files:**
- Create: `server-plugin/src/storage/operations-store.js`
- Create: `tests/server-operations.test.js`

- [ ] **Step 1: Write failing marker lifecycle tests**

Define marker schema:

```js
{
    id,
    type: 'create' | 'rotate-key' | 'delete',
    connectionId,
    phase,
    oldSecretId: null,
    newSecretId: null,
    createdAt,
    updatedAt,
}
```

Test create/advance/remove and that markers are user-scoped.

- [ ] **Step 2: Write failing reconciliation tests**

Use fake connection store and fake secret store to prove:

- uncommitted create removes unreferenced new secret;
- rotate before metadata commit preserves old secret and removes new orphan;
- rotate after metadata commit preserves new referenced secret and removes old;
- tombstoned delete retries secret/artifact cleanup idempotently;
- reconciliation never deletes any secret ID referenced by committed metadata.

- [ ] **Step 3: Run RED**

```bash
node --test tests/server-operations.test.js
```

- [ ] **Step 4: Implement marker storage and dependency-injected reconciliation**

Exports:

```js
export async function beginOperation(paths, marker);
export async function advanceOperation(paths, id, patch);
export async function finishOperation(paths, id);
export async function listOperations(paths);
export async function reconcileOperations(context);
```

Do not import real SecretManager in this module.

- [ ] **Step 5: Run GREEN**

```bash
node --test tests/server-operations.test.js
```

- [ ] **Step 6: Commit**

```bash
git add server-plugin/src/storage/operations-store.js tests/server-operations.test.js
git commit -m "feat(server): add durable operation reconciliation"
```

---

### Task 4: Integrate SillyTavern SecretManager behind a host bridge

**Files:**
- Create: `server-plugin/src/host/sillytavern.js`
- Create: `server-plugin/src/secrets/secret-store.js`
- Create: `tests/server-secrets.test.js`
- Create: `tests/server-plugin/fake-secret-manager.js`

- [ ] **Step 1: Write failing bridge validation tests**

Test that `assertSecretManagerApi()` accepts a class exposing `writeSecret/readSecret/deleteSecret`, and throws `SERVER_COMPONENT_INCOMPATIBLE` if one is absent.

- [ ] **Step 2: Write failing secret-store tests**

Test exact key:

```text
ur_image_studio.connection_api_secret
```

Test write/read/delete by ID and ensure safe results contain only `{id, present}`. Assert key value never appears in JSON-stringified results or thrown messages.

- [ ] **Step 3: Run RED**

```bash
node --test tests/server-secrets.test.js
```

- [ ] **Step 4: Implement dynamic host loading**

Resolve host module from:

```js
path.resolve(process.env.SILLYTAVERN_ROOT || process.cwd(), 'src/endpoints/secrets.js')
```

Load with `pathToFileURL()`. Production source must not contain `D:\Project\SillyTavern`.

`createSecretStore(req, { SecretManagerClass })` creates a manager with `req.user.directories`.

- [ ] **Step 5: Run GREEN**

```bash
node --test tests/server-secrets.test.js
```

- [ ] **Step 6: Commit**

```bash
git add server-plugin/src/host server-plugin/src/secrets tests/server-secrets.test.js tests/server-plugin/fake-secret-manager.js
git commit -m "feat(server): integrate SillyTavern SecretManager"
```

---

### Task 5: Define endpoint and destination validation

**Files:**
- Create: `server-plugin/src/network/endpoint.js`
- Create: `server-plugin/src/network/destination-policy.js`
- Create: `tests/server-destination-policy.test.js`

- [ ] **Step 1: Write failing table-driven URL tests**

Accept:

```text
https://api.example.com
https://api.example.com/v1
https://api.example.com/custom/v1
https://api.example.com:8443/custom
```

Reject:

```text
http://api.example.com
https://user:pass@api.example.com
https://api.example.com/path?token=x
https://api.example.com/path#fragment
file:///tmp/a
```

Assert custom path and explicit HTTPS port survive normalization.

- [ ] **Step 2: Write failing address classification tests**

Reject IPv4/IPv6 classes:

```text
127.0.0.1
10.0.0.1
172.16.0.1
192.168.0.1
169.254.169.254
0.0.0.0
::1
::
fc00::1
fe80::1
::ffff:127.0.0.1
::ffff:169.254.169.254
224.0.0.1
ff02::1
```

Accept public fixtures such as `8.8.8.8` and `2606:4700:4700::1111`.

- [ ] **Step 3: Write failing DNS policy tests**

Inject a resolver returning several addresses. Reject destination if any selected/pinned address is blocked. Return validated addresses for safe fetch rather than only a boolean.

- [ ] **Step 4: Run RED**

```bash
node --test tests/server-destination-policy.test.js
```

- [ ] **Step 5: Implement endpoint and destination policy**

Exports:

```js
export function normalizeCloudEndpoint(input);
export function isBlockedAddress(address);
export async function resolveAllowedDestination(url, resolver);
```

Do not add `/v1` or `/v1beta` here.

- [ ] **Step 6: Run GREEN**

```bash
node --test tests/server-destination-policy.test.js
```

- [ ] **Step 7: Commit**

```bash
git add server-plugin/src/network tests/server-destination-policy.test.js
git commit -m "feat(server): enforce outbound destination policy"
```

---

### Task 6: Build the safe outbound HTTP client

**Files:**
- Create: `server-plugin/src/network/safe-fetch.js`
- Create: `tests/server-safe-fetch.test.js`

- [ ] **Step 1: Write failing dispatch-boundary test**

The client API must expose a callback that is awaited immediately before any request body can be written:

```js
await safeRequest({
    url,
    method: 'POST',
    headers,
    body,
    beforeDispatch: async () => journal.markDispatching(),
});
```

With injected fake transport, assert `beforeDispatch` completes before transport records `bodyStarted`.

- [ ] **Step 2: Write failing redirect and auth tests**

Assert:

- redirects are manual by default;
- permitted redirect is revalidated;
- cross-origin redirect strips `authorization`, `x-goog-api-key`, and query key;
- redirect count is bounded;
- blocked redirect is rejected before second request.

- [ ] **Step 3: Write failing timeout/size/redaction tests**

Test bounded request/response sizes, AbortSignal propagation, no automatic retry, and redacted errors that do not include auth, prompt, data URL, or signed query.

- [ ] **Step 4: Run RED**

```bash
node --test tests/server-safe-fetch.test.js
```

- [ ] **Step 5: Implement safeRequest with injected transport**

Production transport uses `node-fetch` with a custom `https.Agent` whose `lookup` returns only the validated pinned address. Use `redirect: 'manual'`. Test transport is injected; tests do not use real network.

The module returns a bounded response facade; adapters do not call raw `node-fetch` directly.

- [ ] **Step 6: Run GREEN**

```bash
node --test tests/server-safe-fetch.test.js
```

- [ ] **Step 7: Commit**

```bash
git add server-plugin/src/network/safe-fetch.js tests/server-safe-fetch.test.js
git commit -m "feat(server): add policy-enforced outbound HTTP client"
```

---

### Task 7A: Define connection and route schemas

Treat this as one fresh-subagent dispatch ending at Step 7. It owns `validation.js`, `connections-store.js`, the exact safe-projection DTO, and schema/store tests only. Transaction assertions in Step 3 use a fake service contract and remain RED until Task 7B; Task 7A's GREEN target is the schema/store subset named `connection schema`, `safe projection`, and `connection store`.

**Files:**
- Create: `server-plugin/src/validation.js`
- Create: `server-plugin/src/storage/connections-store.js`
- Create: `tests/server-connections.test.js`

- [ ] **Step 1: Write failing schema tests**

Validate existing client ID format from `src/core.js`:

```text
^[a-z0-9]+[a-z0-9]{6}$
```

Do not rely only on regex length; include fixtures generated by current `uid()` and reject path separators/control chars.

Validate API families:

```text
auto
openai-images
gemini-native
openrouter-images
```

Validate manual route: source `manual`, explicit non-auto family matching route family, model ID non-empty, conservative capabilities.

- [ ] **Step 2: Write failing safe-projection tests**

Assert projection includes `hasApiKey` but excludes `secretId`, key value, operations, absolute paths, and remote unbounded metadata.

- [ ] **Step 3: Write failing store tests**

Test atomic create/replace/tombstone primitives, stable caller-supplied IDs, omission of tombstoned rows from list, and preservation of `modelRouteId` plus sanitized `selectedRoute`. Lifecycle transactions remain Task 7B.

- [ ] **Step 4: Run RED**

```bash
node --test tests/server-connections.test.js
```

- [ ] **Step 5: Implement focused schema and store**

Connection record contains the exact fields from the spec and maps `modelRoute` input to `modelRouteId` plus sanitized `selectedRoute`. `listConnections()` ignores tombstoned records. `createConnection()` accepts a caller-supplied stable ID and a route already validated by its caller; it is not exposed over HTTP in this plan. All writes occur under the user lock. Implement the exact versioned safe-projection DTO defined above.

- [ ] **Step 6: Run GREEN**

```bash
node --test tests/server-connections.test.js
```

- [ ] **Step 7: Commit schemas**

```bash
git add server-plugin/src/validation.js server-plugin/src/storage/connections-store.js tests/server-connections.test.js
git commit -m "feat(server): define connection and route schemas"
```

- [ ] **Step 8: Start Task 7B with a fresh subagent and implement the internal lifecycle service**

Task 7B owns only `server-plugin/src/services/connections.js` and new transaction/reconciliation cases in `tests/server-connections.test.js`. First add tests for `validate → marker → new secret → metadata commit → marker finish`; metadata failure cleanup; write-new-first key rotation; tombstone-before-cleanup delete; and reconciliation safety. Run those tests to verify RED, implement orchestration against the already-green schemas/stores, then run the complete file:

```bash
node --test tests/server-connections.test.js
```

Expected: all PASS.

- [ ] **Step 9: Commit Task 7B service**

```bash
git add server-plugin/src/services/connections.js
git commit -m "feat(server): add crash-safe connection lifecycle"
```

---

### Task 8: Expose safe connection listing and lazy reconciliation

**Files:**
- Modify: `server-plugin/src/router.js`
- Modify: `server-plugin/index.js`
- Create: `tests/server-router.test.js`

- [ ] **Step 1: Write failing fake-router tests**

Assert registration of only the foundation-safe routes:

```text
GET /v1/status
GET /v1/connections
```

Call handlers with fake `req.user` for Alice/Bob and assert strict isolation and the exact `{ connections }` safe envelope. Assert `POST/PUT/DELETE /v1/connections` are not registered yet, because discovered-route writes cannot be accepted before Task 8 of plan 2 installs probe receipts and catalog validation.

- [ ] **Step 2: Write failing lazy reconciliation test**

Before every user-scoped route, including `/v1/status`, call a mandatory coalesced `ensureReconciled(req)` barrier keyed by user root. `init` verifies host compatibility only because the plugin cannot globally enumerate users. Status returns `ok:true` only after that user's reconciliation succeeds; failure returns a safe unavailable/error response and no stateful handler runs. Test concurrent first requests, one reconciliation execution, and failure isolation between Alice and Bob.

- [ ] **Step 3: Run RED**

```bash
node --test tests/server-router.test.js
```

- [ ] **Step 4: Implement dependency-injected route registration**

`registerRoutes(router, services)` maps only HTTP concerns and calls `ensureReconciled(req)` before status/list handlers. Error middleware helper translates `ServerImageError` to status/envelope. Handlers never access filesystem or SecretManager directly. Leave public create/update/delete unregistered until plan 2 validates a transient probe receipt or a manual route.

- [ ] **Step 5: Run foundation gate**

```bash
node --test --test-concurrency=1 \
  tests/server-plugin-entry.test.js \
  tests/server-errors.test.js \
  tests/server-storage.test.js \
  tests/server-operations.test.js \
  tests/server-secrets.test.js \
  tests/server-destination-policy.test.js \
  tests/server-safe-fetch.test.js \
  tests/server-connections.test.js \
  tests/server-router.test.js
```

Expected: all PASS.

- [ ] **Step 6: Run regression delta**

```bash
node --test --test-concurrency=1 tests/*.test.js tests/providers/*.test.js
```

Expected: no new failures beyond recorded baseline.

- [ ] **Step 7: Commit**

```bash
git add server-plugin/index.js server-plugin/src/router.js tests/server-router.test.js
git commit -m "feat(server): expose safe connection listing"
```
