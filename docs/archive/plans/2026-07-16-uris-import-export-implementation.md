# URIS Safe Import/Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Восстановить UI импорта/экспорта URIS и расширить существующий backup так, чтобы переносились безопасные данные и референсы с chat-scoped привязками по исходному `chatId`, но никогда не переносились галерея и секреты.

**Architecture:** `src/data-port.js` остаётся единой границей backup. Экспорт формирует version-3 JSON с отдельными секциями для безопасных localforage-данных, extension settings и доступных текущих chat metadata; импорт сначала нормализует/валидирует вход, затем выполняет безопасную атомарную запись с rollback. UI вызывает этот API, показывает сводку и явно различает merge/replace. `localforage` остаётся источником текущих библиотек, а `chatMetadata` читается только через публичный контекст ST; отдельный серверный плагин не добавляется.

**Tech Stack:** Vanilla ES modules, SillyTavern `getContext()`/`saveSettingsDebounced()`/`saveMetadata()`, SillyTavern shared `localforage`, browser JSON file APIs, Node built-in `node:test`.

---

## File Map

- Modify `src/data-port.js`: v3 backup schema, allowlist, legacy v2 adapter, recursive secret sanitizer, reference-only export, current chat binding export, validation, rollback, import result summary, and download/upload helpers.
- Modify `src/core.js`: export any missing storage constants needed by the explicit backup allowlist and add a stable helper for obtaining the current chat id only if existing context conventions support it; do not alter domain storage behavior.
- Modify `src/refs-library.js`: expose a small cache refresh/invalidation entry point only if the import layer cannot already call the existing `refreshPoolCache()` safely; keep reference CRUD unchanged.
- Modify `src/ui/window.js` or the actual registered settings UI location found during implementation: restore export/import controls and handlers; do not add gallery controls.
- Modify `index.js`: wire lifecycle/runtime refresh after import only if the current settings UI is assembled here; remove stale comments claiming the UI is intentionally disabled.
- Modify `tests/data-port.test.js`: schema, filtering, v2 compatibility, merge/replace, rollback, chat metadata, references-only behavior, and secret regression tests.
- Modify/add UI smoke tests in the existing test style only if the project has a testable window fixture; otherwise cover exported handler wiring with focused module tests.
- Update `docs/changelog.md`: document the restored safe backup feature and its exclusions.

No server plugin, gallery migration, external dependency, or automatic chat-ID remapping is part of this plan.

---

### Task 1: Establish the v3 backup contract and explicit key policy

**Files:**
- Modify: `src/data-port.js`
- Test: `tests/data-port.test.js`

- [ ] **Step 1: Inspect the current test harness and add fixtures for safe/secret/gallery keys**

Use the existing `SillyTavern.libs.localforage` Map mock in `tests/data-port.test.js`. Add fixture values for `uris_refs_pool`, `uris_refs_folders`, `uris_prompt_templates`, `uris_bundles`, `uris_instruction:chat-1`, `uris_generation_draft:chat-1:3`, `uris_gallery_chat-1`, `uris_custom_apikey`, and `uris_conn_key_conn-1`; put `secretId` and `apiKey` inside a nested object to exercise recursive sanitization.

- [ ] **Step 2: Write failing tests for the v3 export shape and allowlist**

Add tests asserting:

```js
const backup = await exportUrisData();
assert.equal(backup.version, 3);
assert.deepEqual(Object.keys(backup.data.localforage).sort(), [
  'uris_bundles',
  'uris_generation_draft:chat-1:3',
  'uris_instruction:chat-1',
  'uris_prompt_templates',
  'uris_refs_folders',
  'uris_refs_pool',
]);
assert.equal(Object.hasOwn(backup.data.localforage, 'uris_gallery_chat-1'), false);
assert.equal(JSON.stringify(backup).includes('api-key-value'), false);
assert.equal(JSON.stringify(backup).includes('secret-id-value'), false);
```

The exact key list must follow the repository’s actual constants and current key spellings; the test should use the real prefixes rather than inventing alternate names.

- [ ] **Step 3: Run the focused test and verify it fails**

Run:

```bash
node --test tests/data-port.test.js
```

Expected: the existing v2 `keys` shape/version or gallery-inclusive sweep causes the new v3 assertions to fail.

- [ ] **Step 4: Implement explicit safe-key classification**

In `src/data-port.js`, replace the unrestricted `startsWith('uris_')` export policy with small pure predicates:

```js
const EXCLUDED_LF_KEYS = new Set([LF_API_KEY]);
const EXCLUDED_PREFIXES = [LF_CONN_KEY_PREFIX, LF_GALLERY_PREFIX];

function isExportableLfKey(key) {
    if (typeof key !== 'string' || !key.startsWith('uris_')) return false;
    if (EXCLUDED_LF_KEYS.has(key)) return false;
    if (EXCLUDED_PREFIXES.some(prefix => key.startsWith(prefix))) return false;
    return ALLOWED_LF_KEYS.has(key) || ALLOWED_LF_PREFIXES.some(prefix => key.startsWith(prefix));
}
```

Use explicit constants for global collections and approved chat-scoped prefixes. Keep secret filtering as a separate `isSecretLfKey()` predicate so import and replace cannot regress. Export under `data.localforage`, not the old top-level `keys` field.

- [ ] **Step 5: Run the focused tests and verify they pass**

Run:

```bash
node --test tests/data-port.test.js
```

Expected: v3 shape, no gallery, and no secret values pass while the existing pre-change tests may still require adaptation in the same task.

- [ ] **Step 6: Commit the contract change**

```bash
git add src/data-port.js tests/data-port.test.js
git commit -m "feat: define safe URIS backup v3"
```

---

### Task 2: Add non-mutating recursive secret sanitization and legacy v2 normalization

**Files:**
- Modify: `src/data-port.js`
- Test: `tests/data-port.test.js`

- [ ] **Step 1: Write failing sanitizer tests**

Add a test with nested arrays and objects:

```js
const input = {
  safe: { name: 'ref' },
  apiKey: 'top-secret',
  nested: [{ token: 'nested-secret', value: 1 }],
  secretId: 'server-secret-id',
};
const backup = await exportUrisData({ extraFixture: input });
assert.equal(JSON.stringify(backup).includes('top-secret'), false);
assert.equal(JSON.stringify(backup).includes('nested-secret'), false);
assert.equal(JSON.stringify(backup).includes('server-secret-id'), false);
```

Also assert that the source object in localforage is unchanged after export.

- [ ] **Step 2: Add v2 adapter tests**

Pass the old shape:

```js
const legacy = {
  version: 2,
  module: MODULE_NAME,
  keys: {
    uris_refs_pool: [{ id: 'r1' }],
    uris_gallery_chat1: [{ id: 'g1' }],
    uris_conn_key_c1: 'secret',
  },
  extensionSettings: { enabled: true },
};
```

Assert that normalization retains `uris_refs_pool`, drops gallery and secret keys, returns v3 internally, and never writes either excluded value.

- [ ] **Step 3: Run tests and verify failure**

```bash
node --test tests/data-port.test.js
```

Expected: no recursive sanitizer/normalizer exists yet.

- [ ] **Step 4: Implement `sanitizeBackupValue()` and `normalizeBackup()`**

Implement a pure recursive clone that:

- returns primitives unchanged;
- maps arrays recursively;
- skips object keys matching `apiKey`, `api_key`, `token`, `password`, `secret`, `secretId` case-insensitively;
- preserves safe data;
- does not mutate source values.

`normalizeBackup(data)` must validate the module, adapt v2 `keys` to v3 `data.localforage`, omit gallery and secret keys, sanitize extension settings, and preserve only supported sections. Unknown top-level sections are ignored, not written.

- [ ] **Step 5: Run tests and verify pass**

```bash
node --test tests/data-port.test.js
```

Expected: sanitizer and v2 compatibility tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/data-port.js tests/data-port.test.js
git commit -m "feat: sanitize and normalize URIS backups"
```

---

### Task 3: Export current chat metadata and produce an import summary

**Files:**
- Modify: `src/data-port.js`
- Modify: `src/core.js` only if needed for existing `getCtx()` helpers
- Test: `tests/data-port.test.js`

- [ ] **Step 1: Write failing current-chat metadata tests**

Configure the test context with:

```js
chatId: 'chat-1',
chatMetadata: {
  uris_binding: {
    bundleId: 'b1',
    overrides: { imageProfileId: 'i1' },
    refs: { mode: 'smart', extraRefIds: ['r1'] },
  },
  unrelated: 'do-not-export',
},
```

Assert that export includes only the URIS binding under `data.chatMetadata['chat-1']`, not unrelated metadata. Assert that `summarizeBackup()` reports refs, folders, bundles, connections, and chat binding counts and reports gallery/secrets excluded.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
node --test tests/data-port.test.js
```

Expected: current export has no `data.chatMetadata` or summary API.

- [ ] **Step 3: Implement current-chat metadata export**

Read `getCtx()` at export time. Obtain the current chat ID only through the current ST context conventions used by the project. Copy only `chatMetadata[META_KEY]` and only its safe URIS binding fields (`bundleId`, `overrides`, `refs`). Do not retain a long-lived metadata reference. If no current chat ID is available, return an empty metadata section and a warning/count of zero.

- [ ] **Step 4: Implement `summarizeBackup(data)`**

Return a plain object with counts for local collections, connections without keys, refs, folders, bundles, chat bindings, plus fixed flags `galleryIncluded: false` and `secretsIncluded: false`. Use the same normalization path as import so the UI and importer count the same data.

- [ ] **Step 5: Run tests and verify pass**

```bash
node --test tests/data-port.test.js
```

Expected: metadata isolation and summary tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/data-port.js src/core.js tests/data-port.test.js
git commit -m "feat: include safe chat bindings in URIS backups"
```

---

### Task 4: Implement validated atomic import with merge/replace and rollback

**Files:**
- Modify: `src/data-port.js`
- Test: `tests/data-port.test.js`

- [ ] **Step 1: Write failing validation and rollback tests**

Add tests asserting:

```js
await assert.rejects(() => importUrisData({ module: MODULE_NAME, version: 3, data: { localforage: [] } }));
```

For rollback, configure the localforage mock to throw on the second write, run `replace`, and assert that the original safe keys remain and secret keys were never removed.

- [ ] **Step 2: Run tests and verify failure**

```bash
node --test tests/data-port.test.js
```

Expected: malformed input may currently write or fail after partial mutation.

- [ ] **Step 3: Implement preflight validation**

Normalize and validate all incoming sections before touching localforage. Reject malformed `data.localforage`, non-object extension settings, invalid chat metadata, foreign keys, and unsupported secret-bearing values. Return a structured error before the first write.

- [ ] **Step 4: Implement a safe snapshot and restore helper**

Before `replace`, collect the current exportable safe keys and current extension settings. Never include gallery or secret keys in the deletion list. Store the snapshot in memory for the duration of the operation; do not persist a second secret-bearing backup.

- [ ] **Step 5: Implement merge and replace writes**

For `merge`, write normalized incoming safe keys and merge settings without touching absent local values. For `replace`, remove only exportable non-gallery keys, write incoming keys, restore sanitized settings, and apply available chat metadata through the current context. Imported connection records must have `secretId: ''` before writing.

- [ ] **Step 6: Implement rollback on failure**

Wrap destructive/write operations in `try/catch`. On failure, restore the preflight safe-key snapshot and extension settings; leave existing API keys and gallery untouched. Re-throw the original failure after logging rollback status.

- [ ] **Step 7: Keep v2 public compatibility**

`importUrisData()` accepts both v2 and v3, internally calls `normalizeBackup()`, and returns:

```js
{
  importedKeys,
  importedChatBindings,
  connectionsSynced: 0,
  summary,
}
```

`connectionsSynced` must remain zero when no imported keys are available; do not attempt to recreate secrets from excluded credentials.

- [ ] **Step 8: Run the full persistence test file**

```bash
node --test tests/data-port.test.js
```

Expected: validation, merge, replace, rollback, v2, gallery preservation, and secret preservation tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/data-port.js tests/data-port.test.js
git commit -m "feat: make URIS import validated and rollback-safe"
```

---

### Task 5: Refresh runtime state after import

**Files:**
- Modify: `src/data-port.js`
- Modify: `src/refs-library.js` only if the current exported cache helper is insufficient
- Modify: `index.js` or `src/ui/tabs.js` at the actual refresh boundary
- Test: `tests/data-port.test.js` and existing smoke tests

- [ ] **Step 1: Write a failing cache-refresh test**

Populate the refs pool, call import with a replacement pool, then assert `getRefSync(importedId)` returns the imported ref after the operation. Add an assertion that the returned result exposes a refresh-needed/refresh-complete state rather than silently leaving stale cache.

- [ ] **Step 2: Run the focused tests and verify failure**

```bash
node --test tests/data-port.test.js tests/refs-library.test.js
```

Expected: `_poolCache` still contains old data after import.

- [ ] **Step 3: Refresh refs and UI state after successful import**

After successful writes, call the existing `refreshPoolCache()`, invalidate/reload connection/template lists through their normal render paths, and trigger the smallest existing tab refresh mechanism. Do not add a second global cache or duplicate CRUD logic.

- [ ] **Step 4: Run focused and smoke tests**

```bash
node --test tests/data-port.test.js tests/refs-library.test.js tests/smoke.test.js
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/data-port.js src/refs-library.js index.js src/ui/tabs.js tests/data-port.test.js tests/smoke.test.js
 git commit -m "feat: refresh URIS runtime after import"
```

---

### Task 6: Restore the import/export UI with explicit mode and warnings

**Files:**
- Modify: the registered settings UI file identified during implementation (`index.js` and/or `src/ui/window.js`)
- Modify: `src/data-port.js` only for UI-facing helpers
- Test: existing UI/smoke test file or `tests/data-port.test.js` for handler behavior

- [ ] **Step 1: Add failing UI wiring assertions**

Assert that the rendered settings markup contains controls with stable IDs, for example `uris_export_data` and `uris_import_data`, and that handlers call `runExport()`/`runImport()` rather than duplicating file logic. If there is no DOM fixture, test `runExport`/`runImport` directly and verify the mode passed to `importUrisData`.

- [ ] **Step 2: Run the focused test and verify failure**

```bash
node --test tests/smoke.test.js
```

Expected: controls are absent because the old UI cut intentionally removed them.

- [ ] **Step 3: Restore export and import controls**

Add two buttons to the existing URIS settings panel. Export calls `runExport()`. Import opens the file picker, normalizes/validates the file, displays `summarizeBackup()` counts, then lets the user choose `merge` or `replace`; `replace` requires explicit confirmation. Keep gallery and secret exclusions visible in the confirmation text.

- [ ] **Step 4: Add user-facing warnings**

Show that API keys are not included, gallery is not included, chat bindings use original `chatId`, and server `imagePath` references require the same ST files. After success, tell the user how many connections need keys re-entered.

- [ ] **Step 5: Run focused UI/persistence tests**

```bash
node --test tests/data-port.test.js tests/smoke.test.js
```

Expected: controls/handlers and all persistence assertions pass.

- [ ] **Step 6: Commit**

```bash
git add index.js src/ui/window.js src/data-port.js tests/data-port.test.js tests/smoke.test.js
 git commit -m "feat: restore safe URIS backup controls"
```

---

### Task 7: Update documentation and regression coverage

**Files:**
- Modify: `docs/changelog.md`
- Modify: `tests/data-port.test.js`
- Optional modify: relevant settings migration/smoke tests if `BACKUP_VERSION` or UI IDs are asserted there

- [ ] **Step 1: Add final regression cases**

Cover these concrete invariants:

```js
assert.equal(backup.data.localforage[LF_GALLERY_PREFIX + 'chat-1'], undefined);
assert.equal(backup.data.extensionSettings?.apiKey, undefined);
assert.equal(backup.data.localforage[LF_CONNECTIONS][0].secretId, undefined);
assert.equal(importedConnection.secretId, '');
```

Also test that a malformed backup is rejected before the mock’s write counter increments.

- [ ] **Step 2: Run all relevant tests**

```bash
node --test tests/data-port.test.js tests/refs-library.test.js tests/settings-migration.test.js tests/smoke.test.js
```

Expected: PASS. If unrelated dirty-worktree tests fail, record their exact failure and do not rewrite unrelated changes.

- [ ] **Step 3: Document the feature**

Add a changelog entry stating: export/import is manual backup; refs and safe settings are included; gallery and API keys are excluded; chat bindings use original `chatId`; imported connections require keys to be entered again.

- [ ] **Step 4: Run the full test suite**

```bash
node --test tests/*.test.js
```

Expected: all tests pass. If the repository’s current dirty changes produce failures, report them separately with command output.

- [ ] **Step 5: Review the final diff**

```bash
git diff --check
git status --short
git diff --stat HEAD~7..HEAD
```

Verify that only intended files from this feature were changed and no backup fixture contains a real secret.

- [ ] **Step 6: Commit documentation and final tests**

```bash
git add docs/changelog.md tests/data-port.test.js
git commit -m "docs: describe URIS backup limitations"
```

---

## Plan Self-Review

- **Spec coverage:** v3 schema and allowlist are covered by Task 1; recursive secret removal and v2 compatibility by Task 2; current chat metadata and summary by Task 3; validation, merge/replace, rollback, and secret/gallery preservation by Task 4; cache/UI refresh by Task 5; restored UI and warnings by Task 6; test/documentation closure by Task 7.
- **No gallery transfer:** gallery prefixes are excluded at export, never deleted by replace, and covered by regression tests.
- **No secrets:** key filtering, nested sanitizer, imported connection `secretId` reset, and preservation of existing local keys are covered.
- **Chat ID policy:** metadata uses the current/original `chatId`; no remapping is introduced.
- **Compatibility:** v2 adapter is explicit and tested.
- **Rollback:** preflight validation occurs before any write, and replace has an in-memory safe snapshot.
- **Potential runtime limitation:** SillyTavern exposes current chat metadata publicly, not a stable public enumeration of every chat’s metadata. The implementation must not invent an unsupported enumeration; it exports available current metadata and reports the count honestly.
- **Placeholder scan:** no `TBD`, `TODO`, or undefined implementation choice remains in the plan. Where the exact UI file is uncertain, the existing repository must be inspected first, and the plan explicitly names the registered settings boundary rather than assuming a nonexistent module.
