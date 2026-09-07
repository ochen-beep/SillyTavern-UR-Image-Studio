# Server Image Connections — Migration and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Транзакционно мигрировать старые OpenAI/Gemini connections и ключи на server ownership, добавить portable export/import, вывести browser OpenAI/Gemini paths из active use и завершить release security/acceptance verification.

**Architecture:** Отдельный migration module сохраняет stable IDs and verifies read-back before deleting browser secrets. Export asks the server for portable templates; import is keyless and returns collision remap. Active browser dispatch remains only for legacy Agnes/Pollinations.

**Tech Stack:** Existing localforage connection store, server API client, SillyTavern chat bindings, `node:test`, source-audit tests.

**Depends on:** client integration plan complete and all client/server gates green.

---

## Files created or changed

```text
src/
├── server-connection-migration.js         # new
├── connections.js
├── data-port.js
├── image-api.js
├── models.js
├── providers/registry.js                  # optional active-registry cleanup
├── ui/tab-api.js
└── index.js

tests/
├── server-connection-migration.test.js
├── data-port.test.js
├── final-verification.test.js
├── server-security.test.js
├── server-st-integration.test.js
└── smoke.test.js
```

Do not migrate Agnes or Pollinations in this plan.

---

### Task 1: Implement stable-ID migration classification

**Files:**
- Create: `src/server-connection-migration.js`
- Create: `tests/server-connection-migration.test.js`

- [ ] **Step 1: Write failing classification tests**

Migratable:

```text
apiType === openai
apiType === gemini
apiType === auto only when probe returns one unambiguous OpenAI/Gemini route for current model
```

Not migratable:

```text
agnes
pollinations
ambiguous auto
missing key
already server-owned
```

- [ ] **Step 2: Write failing probe input tests**

Old `openai` uses explicit `openai-images`; old `gemini` uses `gemini-native`. Old auto uses `auto`. Preserve endpoint, model and timeout; do not copy old browser reference protocol into server route.

- [ ] **Step 3: Write failing route selection tests**

Prefer exact model ID + explicit old family. Ambiguous duplicate routes require user choice and return migration state `needs-route-selection`; do not guess by hostname alone.

- [ ] **Step 4: Run RED**

```bash
node --test tests/server-connection-migration.test.js
```

- [ ] **Step 5: Implement pure helpers only**

Exports:

```js
isMigratableLocalConnection
buildMigrationProbeInput
selectMigrationRoute
```

No local deletion yet.

- [ ] **Step 6: Run GREEN and commit**

```bash
node --test tests/server-connection-migration.test.js
git add src/server-connection-migration.js tests/server-connection-migration.test.js
git commit -m "feat(client): classify stable-ID connection migrations"
```

---

### Task 2: Implement transactional migration and browser-key cleanup

**Files:**
- Modify: `src/server-connection-migration.js`
- Modify: `src/connections.js`
- Modify: `tests/server-connection-migration.test.js`

- [ ] **Step 1: Add failing ordered-operation tests**

Expected:

```text
status compatible
→ read local metadata/key
→ transient probe
→ create server connection with same ID
→ list/read safe projection
→ assert hasApiKey true
→ assert unified getConnection resolves server same ID
→ remove local key
→ remove old mirrored secret
→ remove/mark local duplicate
→ migration complete
```

- [ ] **Step 2: Add a failing test for every pre-cleanup failure point**

Inject failure at status, probe, create, read-back, `hasApiKey`, facade resolution. In every case local key, old secret and local metadata remain.

- [ ] **Step 3: Add failing crash/resume tests**

If server create succeeded but client died before cleanup, next run detects same server ID and completes read-back/cleanup without creating another secret/connection. Add crash fixtures after local-key removal, after first/second bucket delete, and before local metadata removal; each resumes from persisted `cleanupPhase`.

- [ ] **Step 4: Run RED**

```bash
node --test tests/server-connection-migration.test.js
```

- [ ] **Step 5: Add explicit cleanup helpers to connections facade**

```js
removeLocalConnectionKey
removeLegacyMirroredSecret
removeMigratedLocalRecord
```

Before cleanup, persist a resumable migration-state record containing exact `{ connectionId, localKeyName: LF_CONN_KEY_PREFIX + connectionId, oldSecretId, oldBucketCandidates: [ST_SECRET_KEY_URIS, ST_SECRET_KEY_CUSTOM], cleanupPhase }`. Cleanup order is fixed and idempotent: remove local key → delete `oldSecretId` from both bucket candidates best-effort → remove local metadata duplicate last. Advance `cleanupPhase` after each step so restart resumes without needing the already-removed local record. These helpers consume the captured state and never rediscover `secretId` after metadata deletion.

- [ ] **Step 6: Implement migration orchestration**

Preserve exact ID; no chat binding rewrite. Store `needs-route-selection` state for UI rather than blocking the whole app.

- [ ] **Step 7: Run GREEN and commit**

```bash
node --test tests/server-connection-migration.test.js tests/connections-server-facade.test.js
git add src/server-connection-migration.js src/connections.js tests/server-connection-migration.test.js
git commit -m "feat(client): migrate connections and keys after verification"
```

---

### Task 3: Wire startup migration and route-choice UX

**Files:**
- Modify: `index.js`
- Modify: `src/ui/tab-api.js`
- Modify: `src/ui/server-connection-form.js`
- Modify: `tests/tab-api-server-connections.test.js`
- Modify: `tests/smoke.test.js`

- [ ] **Step 1: Write failing lifecycle test**

Startup order:

```text
existing settings migrations
→ server status
→ resumable stable-ID migration
→ load/apply chat config
→ render UI
→ request recovery
```

Server unavailable leaves local connections untouched and legacy UI usable.

- [ ] **Step 2: Write failing needs-selection UI test**

API tab shows pending old connection with exact candidate routes and asks user to choose. Saving performs migration with same ID. It does not expose key again if local key is already present.

- [ ] **Step 3: Run RED**

```bash
node --test tests/tab-api-server-connections.test.js tests/smoke.test.js tests/server-connection-migration.test.js
```

- [ ] **Step 4: Implement lifecycle and UI integration**

Use a two-phase lifecycle. Before facade/UI availability, synchronously classify local IDs and register each candidate as `migration-pending`, which suppresses the local duplicate from the ordinary unified list and makes `resolveConnection(id)` return a non-generatable pending projection. Network probes and server creation may then continue asynchronously after basic settings load. In `migration-pending`/`needs-route-selection`, generation fails locally with `CONNECTION_MIGRATION_PENDING`; after verified server read-back, the facade atomically switches the same ID to server ownership; on unavailable/failed migration it atomically restores legacy ownership. Test list/resolve/generation behavior in every state and prove the ID never appears twice.

- [ ] **Step 5: Run GREEN and commit**

```bash
node --test tests/tab-api-server-connections.test.js tests/smoke.test.js tests/server-connection-migration.test.js
git add index.js src/ui/tab-api.js src/ui/server-connection-form.js tests/tab-api-server-connections.test.js tests/smoke.test.js
git commit -m "feat(client): surface resumable connection migrations"
```

---

### Task 4: Add server portable export

**Files:**
- Modify: `server-plugin/src/router.js`
- Create/Modify: `server-plugin/src/services/connections.js`
- Modify: `src/server-image-api.js`
- Modify: `src/data-port.js`
- Modify: `tests/data-port.test.js`
- Modify: `tests/server-router.test.js`

- [ ] **Step 1: Write failing server export route test**

Add:

```text
GET /v1/connections/export
```

Portable template contains stable ID, name, endpoint, selected route model/family/source/manual capabilities, override, timeout. It excludes key, secret ID, remote catalog payload, journal and artifact.

- [ ] **Step 2: Write failing client backup test**

Bump backup schema to version 5 and add explicit:

```js
imageConnections: {
    legacy: [],
    server: [],
}
```

Export obtains server templates from server, not browser cache/localforage. Existing v2/v3/v4 normalization remains supported.

- [ ] **Step 3: Run RED**

```bash
node --test tests/server-router.test.js tests/data-port.test.js
```

- [ ] **Step 4: Implement server/client export path**

Legacy export includes only Agnes/Pollinations local records after migrated duplicates are removed. Recursive secret sanitization remains defense in depth.

- [ ] **Step 5: Run GREEN and commit server route**

```bash
git add server-plugin/src/router.js server-plugin/src/services/connections.js tests/server-router.test.js
git commit -m "feat(server): export portable connection templates"
```

- [ ] **Step 6: Commit client backup v5**

```bash
git add src/server-image-api.js src/data-port.js tests/data-port.test.js
git commit -m "feat(client): export server connection templates"
```

---

### Task 5A: Add atomic server-side keyless import

This is one fresh-subagent dispatch and ends with the server commit. Do not edit client `data-port.js` in Task 5A.

**Files:**
- Modify: `server-plugin/src/router.js`
- Modify: `server-plugin/src/services/connections.js`
- Modify: `tests/server-router.test.js`

- [ ] **Step 1: Write failing server batch-import tests**

Add:

```text
POST /v1/connections/import
```

Rules:

- unused ID preserved as keyless template;
- identical existing metadata returns `reusedExisting:true`, does not touch existing secret;
- conflict creates new ID and returns old→new map;
- batch metadata write is atomic from API perspective;
- new imports contain no secret ID and `hasApiKey:false`.

- [ ] **Step 2: Defer client remapping to Task 5B**

Define the server response used by Task 5B:

```js
{
    importOperationId,
    rollbackToken,
    connections,
    idMap,
    created: [{ id, version }],
    reusedIds,
}
```

`rollbackToken` is an opaque HMAC-bound token over `importOperationId` and the exact newly created `{id, version}` set. It is never issued for reused records.

- [ ] **Step 3: Write failing manual/remote route server tests**

Manual route remains stored exactly as exported. A remote route is stored as a non-generatable hint with `requiresProbe:true` and `hasApiKey:false`. Identical reused existing connection retains its current key and selected route.

- [ ] **Step 4: Run RED**

```bash
node --test tests/server-router.test.js
```

- [ ] **Step 5: Implement atomic server import transaction**

Write the entire validated metadata batch atomically under the user lock and return the exact Step 2 response. Add `POST /v1/connections/import/:importOperationId/rollback`, requiring `rollbackToken`; under the same lock it compare-and-deletes only newly created records whose current version still equals the issued version. Modified/adopted records are retained and returned as `skippedModified`. Repeated rollback is idempotent.

- [ ] **Step 6: Run GREEN and commit Task 5A server**

```bash
node --test tests/server-router.test.js
git add server-plugin/src/router.js server-plugin/src/services/connections.js tests/server-router.test.js
git commit -m "feat(server): import keyless connection templates"
```

- [ ] **Step 7: Start Task 5B with a fresh subagent and write failing client remap/rollback tests**

Task 5B owns `src/server-image-api.js`, `src/data-port.js`, `tests/data-port.test.js`, and `tests/final-verification.test.js`. Import server templates first, consume `idMap`, apply it only to imported chat bindings' `imageProfileId`, then write local legacy data. Existing user chat bindings remain unchanged. If local import fails, call the rollback route with `importOperationId + rollbackToken`; test idempotent rollback and concurrent server modification being reported in `skippedModified`, never deleted. Test manual-route fidelity, remote-route reprobe requirement, and full local rollback.

Run RED:

```bash
node --test tests/data-port.test.js tests/final-verification.test.js
```

- [ ] **Step 8: Implement Task 5B client import and run GREEN**

```bash
node --test tests/data-port.test.js tests/final-verification.test.js tests/server-router.test.js
```

Expected: all PASS.

- [ ] **Step 9: Commit Task 5B client**

```bash
git add src/server-image-api.js src/data-port.js tests/data-port.test.js tests/final-verification.test.js
git commit -m "feat(client): import server connections with ID remap"
```

---

### Task 6: Retire active browser OpenAI/Gemini paths

**Files:**
- Modify: `src/image-api.js`
- Modify: `src/models.js`
- Modify: `src/providers/registry.js`
- Modify: `src/ui/tab-api.js`
- Modify: `tests/models.test.js`
- Modify: `tests/providers.test.js`
- Modify: `tests/providers/openai-refs.test.js`
- Modify: `tests/smoke.test.js`

- [ ] **Step 1: Write failing source-audit tests**

Assert server-owned or migrated OpenAI/Gemini never use:

```text
probeCorsProxy
browser Authorization/x-goog-api-key
autoFetch provider request
browser multipart edits
Chat Completions fallback
generic browser /v1/models
```

- [ ] **Step 2: Preserve legacy regression tests**

Agnes and Pollinations remain in provider registry and use current legacy transport/model/reference behavior. `src/proxy.js` remains because legacy providers still need it.

- [ ] **Step 3: Reclassify old provider tests**

Remove or rewrite browser OpenAI/Gemini tests only after equivalent server adapter tests exist and are green. Do not delete coverage without mapping each removed assertion to a server test.

- [ ] **Step 4: Run RED**

```bash
node --test tests/smoke.test.js tests/models.test.js tests/providers.test.js tests/providers/openai-refs.test.js
```

- [ ] **Step 5: Remove active dispatch, not necessary compatibility modules**

It is acceptable to leave old modules temporarily for migration fixture imports, but no normal connection can route to them. Remove UI creation of new browser OpenAI/Gemini records.

- [ ] **Step 6: Run GREEN and commit**

```bash
node --test tests/smoke.test.js tests/models.test.js tests/providers.test.js tests/providers/openai-refs.test.js tests/image-api-server.test.js
git add src/image-api.js src/models.js src/providers/registry.js src/ui/tab-api.js tests/models.test.js tests/providers.test.js tests/providers/openai-refs.test.js tests/smoke.test.js
git commit -m "refactor(client): retire migrated browser image API paths"
```

---

### Task 7: Add final security and SillyTavern compatibility suites

**Files:**
- Create: `tests/server-security.test.js`
- Create: `tests/server-st-integration.test.js`
- Modify: `server-plugin/src/host/sillytavern.js` only if compatibility failures reveal a real issue

- [ ] **Step 1: Write security integration matrix**

Cover:

- private/metadata/IPv4-mapped IPv6;
- endpoint query/fragment/credentials;
- redirect revalidation and cross-origin auth stripping;
- oversized references/responses;
- malformed data URL and MIME spoofing;
- header injection;
- no secret/prompt/reference bytes in logs, errors, export;
- Alice/Bob isolation for metadata, secrets, journals, artifacts.

- [ ] **Step 2: Write conditional ST integration test**

Run `npm ci --omit=dev --ignore-scripts` in the physically installed plugin directory before startup; do not rely on SillyTavern's sibling `node_modules`. If absent, skip with explicit reason. If present, verify:

```text
Node >=20
node-fetch import
write-file-atomic import
SecretManager class and write/read/delete methods
plugin entry info/init/exit
router mount assumption documented by plugin loader source
```

Never hardcode a local absolute path in production source.

- [ ] **Step 3: Run tests**

```bash
node --test --test-concurrency=1 tests/server-security.test.js tests/server-st-integration.test.js
```

- [ ] **Step 4: Commit**

```bash
git add tests/server-security.test.js tests/server-st-integration.test.js server-plugin/src/host/sillytavern.js
git commit -m "test(server): verify security and SillyTavern compatibility"
```

---

### Task 8: Resolve legacy baseline failures and run acceptance gate

**Files:**
- Modify only obsolete tests/production code proven obsolete by current specs
- Expected hotspot: `tests/references-profiles.test.js`

- [ ] **Step 1: Re-run recorded baseline failures**

```bash
node --test --test-concurrency=1 tests/references-profiles.test.js
```

Compare exact failures to the pre-feature baseline. Determine whether expectations refer to removed `collectReferencesFromProfile*` behavior already superseded by current reference specs.

- [ ] **Step 2: Update/remove obsolete expectations in a dedicated commit**

Do not weaken current prompt-driven reference resolution coverage. Every removed assertion must be covered by current `scene-context`, `pool-only`, `image-api-references`, or server reference tests.

- [ ] **Step 3: Run all focused gates**

```bash
node --test --test-concurrency=1 tests/server-*.test.js
node --test --test-concurrency=1 tests/image-recovery.test.js tests/pipeline-stage2-serialization.test.js tests/data-port.test.js tests/final-verification.test.js
node --test --test-concurrency=1 tests/providers.test.js tests/providers/openai-refs.test.js tests/models.test.js
```

- [ ] **Step 4: Run full suite**

```bash
node --test --test-concurrency=1 tests/*.test.js tests/providers/*.test.js
```

Expected: all PASS.

- [ ] **Step 5: Validate working tree and source formatting**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended feature files differ.

- [ ] **Step 6: Commit baseline cleanup separately**

```bash
git add tests/references-profiles.test.js
# add production files only if a verified obsolete compatibility export must be removed
git commit -m "test: retire obsolete reference profile expectations"
```

- [ ] **Step 7: Run real installation smoke test**

In a supported SillyTavern checkout:

1. set `enableServerPlugins: true`;
2. install/link `server-plugin/` as `plugins/ur-image-studio`;
3. restart SillyTavern;
4. verify `/api/plugins/ur-image-studio/v1/status` while logged in;
5. create a keyless invalid test connection and verify safe error;
6. with authorized API keys, verify LinkAPI GPT and Gemini merged discovery;
7. verify OpenRouter image catalog;
8. verify one generation per family;
9. interrupt browser response after server result and verify recovery;
10. verify Agnes/Pollinations legacy behavior.

Do not record real keys or reference images in repository fixtures/logs.
