# Sequential Server Storage - Implementation Plan

> **Scope:** Implement `docs/superpowers/specs/2026-07-29-sequential-server-storage-design.md` (v2). Move durable URIS data off browser localforage into server-plugin collection files; reuse ST's image filesystem; rework the gallery into a derived viewer (model B′). No transition to implementation is performed by this document - it is the plan only.
>
> **Spec:** `docs/superpowers/specs/2026-07-29-sequential-server-storage-design.md`
> **Depends on:** shipped server image-connections plugin (`server-plugin/`), `2026-07-28-server-connection-add-termux-design.md`.
> **Conventions:** TDD (RED -> implement -> GREEN -> commit). Tests use `node:test` (`node --test`). Server tests: `node --test tests/server-*.test.js`. Full gate: `node --test --test-concurrency=1 tests/*.test.js tests/providers/*.test.js`. Each task commits independently. Migration is per-collection, idempotent, verify-before-delete-localforage.
>
> **v2 changes vs v1:** pagination removed; custom server archive/restore removed (use ST native backup); `data-port.js` retired after migration; sync-tool reframed (rsync primary, Syncthing alt) with an explicit ignore-list; Windows rename-retry added to `atomic-json.js`; `/store/status` reports `filesystem` instead of `synchronizedRootAvailable`; gallery model B′ verification resolved (file-ref confirmed) with concrete ST client API; secrets.json sync-exclusion made explicit; `prompt-history` growth guard added.
>
> **v2.1 changes vs v2 (second-round source verification):** migration checkpoint moved from `extensionSettings` to a server file (avoids the ST extension-init ordering footgun where a third-party module slot is undefined until `activateExtensions()` runs); gallery attach mechanics pinned to the real exported function `ensureMessageMediaIsArray` (not a non-existent `ensureMessageMediaToMessage`) with string constants `MEDIA_TYPE.IMAGE='image'`/`MEDIA_SOURCE.GENERATED='generated'`/`media_display='gallery'`; regen context stored per-swipe in `swipe_info[swipe_id].extra` for the swipe/re-generate path; DR points to ST **manual** full-data export (auto chat-backup has known bugs #5796/#5780); sequential contract cited to ST issue #5864 + #737; secrets future path notes draft PR #5553 at-rest encryption and the csrfSecret mismatch-on-handoff behavior.

## Architecture recap (from spec v2)

- Server is the persistence authority. Browser reaches it only through a facade.
- Per-collection mutable atomic JSON under `<user-root>/plugins/ur-image-studio/<collection>.json`, reusing `atomic-json.js` (`readJson`/`updateJson`/`withLock`/`write-file-atomic`) **plus a new Windows rename-retry**.
- Images reuse ST `/api/images/upload` (`user/images/<char>/`, root-relative URL path, unique filenames). No blob store.
- Gallery (B′): no `gallery.json`; generate -> save to ST char gallery (`saveImageToFile`, `uris_` prefix) + attach file-ref to originating message (`extra.media` + `appendMediaToMessage` + `saveChat`) + regen context in `extra.uris_regen`; gallery tab = viewer of ST char gallery (`/api/images/list`, `uris_` filter).
- Secrets in SecretManager (`secrets.json`, **sync-excluded**); custom API key moves there. localforage retired as authority (migration source only). Last-write-wins; no versioning/polling. Conflict-copy scan + filesystem detection in `/store/status`. No pagination. No custom archive (ST **manual** full-data export = DR; auto chat-backup has known bugs #5796/#5780).

## File structure

```text
server-plugin/src/
    storage/
        collection-store.js      (new - generic per-collection CRUD + registry)
        conflict-scan.js         (new - detect *.sync-conflict* / conflicted copies)
    services/store.js            (new - store service bound to paths)
    validation.js                (modify - collection registry + record validators + server-side SECRET_FIELD_NAMES)
    router.js                    (modify - /store routes)
    index.js                     (modify - wire store service)
src/
    server-store-api.js          (new - client facade, modeled on server-image-api.js)
    store-state.js               (new - /store/status feature-detect + availability)
    store-migration.js           (new - per-collection migrate-verify-clear)
    prompt-templates.js          (modify - facade-backed)
    refs-library.js              (modify - facade-backed)
    characters.js                (modify - facade-backed)
    history.js                   (modify - facade-backed; prompt-history growth guard)
    param-presets.js             (modify - facade-backed)
    pipeline-config.js / chat-binding.js  (modify - drafts facade-backed)
    core.js                      (modify - getApiKey/setApiKey -> SecretManager via facade)
    storage.js                   (modify - gallery -> viewer; drop localforage gallery)
    image-recovery.js            (modify - attach-to-message + regen context in extra.uris_regen)
    ui/tab-gallery.js            (modify - viewer of ST char gallery)
    ui/lightbox.js               (modify - drop "save to ST" button)
    data-port.js                 (retire after migration - section Phase 6.2)
tests/
    server-collection-store.test.js   (new)
    server-store-routes.test.js       (new)
    server-conflict-scan.test.js      (new)
    server-store-api.test.js          (new)
    store-migration.test.js           (new)
    atomic-json-windows-retry.test.js (new)
    prompt-templates.test.js          (modify)
    refs-library.test.js              (modify)
    ... (per-collection test updates)
```

---

## Phase 1 - Foundation + templates

The riskiest, most reusable layer. No domain data moves except templates.

### Task 1.0: Windows rename-retry in atomic-json

**Files:** `server-plugin/src/storage/atomic-json.js` (modify).

- [ ] **RED:** `tests/atomic-json-windows-retry.test.js` - stub `write-file-atomic` to fail with `EPERM` (then `EBUSY`) N-1 times then succeed; assert `writeJson`/`updateJson` retry and ultimately succeed on Windows (`process.platform === 'win32'` guarded, or forced via an injectable flag). Assert no retry on non-EPERM errors and on non-Windows.
- [ ] **Implement:** wrap the `writeFileAtomicPromise` call in a short retry loop (e.g. 4 attempts, ~25-75ms backoff) that retries only on `EPERM`/`EBUSY`/`ENOTEMPTY` and only on Windows (`isWindows`). Non-retryable errors reject immediately. Keep the existing chmod/lock behavior unchanged.
- [ ] **GREEN:** `node --test tests/atomic-json-windows-retry.test.js`.
- [ ] **Commit:** `fix(server): retry atomic rename on Windows transient locks`.

### Task 1.1: Collection registry and validators

**Files:** `server-plugin/src/validation.js` (modify), `server-plugin/src/storage/collection-store.js` (new).

- [ ] **RED:** `tests/server-collection-store.test.js` - assert the registry rejects an unknown collection name with `COLLECTION_UNKNOWN`; assert each registered collection (templates, param-presets, characters, ref-folders, refs, prompt-history, generation-drafts, preferences) normalizes a sample record and strips secret fields (`apiKey`, `api_key`, `token`, `password`, `secret`) via the server-side `SECRET_FIELD_NAMES` set. Assert `secretId` is NOT stripped from a record that legitimately carries an id-reference (document the distinction).
- [ ] **Implement:** a `COLLECTION_REGISTRY` mapping `collection -> { shape: 'array'|'object', normalize(record), idPattern }`. `collection-store.js` exports `listCollection(paths, name)` (returns the whole collection - no pagination), `getRecord`, `createRecord`, `replaceRecord`, `deleteRecord`, `replaceWhole(paths, name, value)` (for migration), all built on `updateJson`/`readJson` over `join(paths.root, name + '.json')`. Array shape filters/patches by `id`; object shape keys by `id`. `updatedAt` assigned by the server on every write. Unknown collection -> `COLLECTION_UNKNOWN`. Path construction uses the validated name only (no caller path). Add a **server-side** `SECRET_FIELD_NAMES` set + recursive `stripSecrets` (mirror `src/data-port.js` `sanitizeBackupValue`, minus `secretId` over-stripping).
- [ ] **GREEN:** `node --test tests/server-collection-store.test.js`.
- [ ] **Commit:** `feat(server): add generic collection store and registry`.

### Task 1.2: Conflict-copy scan

**Files:** `server-plugin/src/storage/conflict-scan.js` (new).

- [ ] **RED:** `tests/server-conflict-scan.test.js` - in a temp dir, create `refs.json`, `refs.sync-conflict-20260729-120000-ABC.json` (real Syncthing format), `refs (conflicted copy).json`, `templates.sync-conflict-20260729-120000-ABC.json`, and an unrelated `.tmp`/hidden file. Assert `scanConflictCopies(paths)` returns only the three conflict files with `{ file, mtime }` and ignores temp/hidden/non-matching files. Also assert a file named `x-templates.sync-conflict-....json` does NOT match (anchoring).
- [ ] **Implement:** `scanConflictCopies(paths)` reads `paths.root` dir entries and matches, per registered collection, an anchored pattern: `^<collection>\.(sync-conflict.*)$` OR `^<collection> \((conflicted copy).*\)\.json$` (escape the collection name; anchor with `^`; account for the extension). Returns safe descriptors (basename + mtime only, never absolute paths).
- [ ] **GREEN:** `node --test tests/server-conflict-scan.test.js`.
- [ ] **Commit:** `feat(server): detect replication conflict copies`.

### Task 1.3: Store service and routes

**Files:** `server-plugin/src/services/store.js` (new), `server-plugin/src/router.js` (modify), `server-plugin/index.js` (modify).

- [ ] **RED:** `tests/server-store-routes.test.js` (fake-router + fake-user, like existing server-router tests):
  - `GET /v1/store/status` returns `{ schemaVersion, state:'ready', lastScanAt, conflictCopies, filesystem:{type,degraded}, migratedCollections }`; absolute paths absent; no `synchronizedRootAvailable`.
  - `GET /v1/store/templates` returns `{ templates: [...] }` safe envelope (whole collection, no pagination); Alice and Bob are isolated (separate roots).
  - `POST /v1/store/templates` creates a record; `PUT /v1/store/templates/:id` updates; `DELETE` removes; `PUT /v1/store/templates` (whole-collection replace) for migration.
  - Unknown collection -> safe error envelope `COLLECTION_UNKNOWN`.
  - Secret fields stripped from a create payload containing `apiKey`.
  - `ensureReconciled` barrier runs before handlers (reuse existing pattern).
- [ ] **Implement:** `createStoreService({ paths })` binds collection-store + conflict-scan + a filesystem detector (resolve the data-root path to `ext4`/`ntfs`/`fuse`/`unknown` via `/proc/mounts` on Linux and a `~/storage/shared`|`/sdcard` FUSE check on Termux; `ntfs` on Windows; set `degraded:true` for `fuse`). `registerRoutes` adds `/v1/store/status` and `/v1/store/:collection[/:id]` (GET/POST/PUT/DELETE), delegating to the service under `ensureReconciled`. Reuse the existing error-envelope helper. Add `store` to the `bound(req)` factory and the default-services wiring in `index.js`.
- [ ] **GREEN:** `node --test tests/server-store-routes.test.js`.
- [ ] **Commit:** `feat(server): expose store collection CRUD and status`.

### Task 1.4: Client facade

**Files:** `src/server-store-api.js` (new).

- [ ] **RED:** `tests/server-store-api.test.js` - assert `BASE_PATH` reuse, `listCollection('templates')` -> `GET /store/templates` (whole collection), `createRecord`, `updateRecord`, `deleteRecord`, `replaceWhole` (migration), `getStoreStatus`; errors map to `ServerImageApiError` (reuse from `server-image-api.js` or a shared envelope); `SERVER_COMPONENT_UNAVAILABLE` when `/store/status` fetch fails. `listCharGallery('char')` builds full URLs from the basenames returned by `/api/images/list` and filters `uris_`.
- [ ] **Implement:** facade modeled on `src/server-image-api.js` (same `getRequestHeaders`, same `request()` helper, same error class). Export `listCollection`, `getRecord`, `createRecord`, `updateRecord`, `deleteRecord`, `replaceWhole`, `getStoreStatus`, `uploadImage` (wraps ST `/api/images/upload`), `listCharGallery` (wraps `/api/images/list`), `attachImageToMessage` (stub returning not-implemented until Phase 5).
- [ ] **GREEN:** `node --test tests/server-store-api.test.js`.
- [ ] **Commit:** `feat(client): add server-store facade`.

### Task 1.5: Store availability state

**Files:** `src/store-state.js` (new).

- [ ] **RED:** `tests/store-state.test.js` - `refreshStoreState()` resolves `available`/`incompatible`/`unavailable` from `getStoreStatus()`; subscribers notified; coalesced in-flight refresh (mirror `src/server-connection-state.js`).
- [ ] **Implement:** clone the `server-connection-state.js` pattern against `getStoreStatus()`. Gate migration and facade use on `state === 'available'`.
- [ ] **GREEN:** `node --test tests/store-state.test.js`.
- [ ] **Commit:** `feat(client): add store availability state`.

### Task 1.6: Migration engine

**Files:** `src/store-migration.js` (new).

- [ ] **RED:** `tests/store-migration.test.js`:
  - `migrateCollection('templates')` reads `LF_TEMPLATES` from a fake localforage, calls `replaceWhole`, force-reads back, compares IDs/counts/hashes, marks verified, then removes the localforage key.
  - Idempotent rerun: second run with empty localforage is a no-op (no server writes, no error). Cross-install rerun (checkpoint already set via the synced server file) is a no-op.
  - On read-back mismatch: localforage key is NOT removed; error thrown.
  - Crash between write and cleanup: rerun converges without duplicates (server replace is idempotent).
  - Checkpoint is read from the server file; assert it survives even when `extensionSettings[MODULE_NAME]` is undefined (mocking a pre-activation first-load path).
- [ ] **Implement:** `migrateCollection(name, { lfKey, normalize, toCollectionValue })`. Flow: inventory localforage -> normalize -> `replaceWhole` -> `listCollection` -> compare -> on match, `localforage.removeItem(lfKey)`; record checkpoint as a per-user **server file** (`<plugin-dir>/migration-checkpoint.json` via the store facade, e.g. `replaceWhole('migration-checkpoint', { [name]: { verifiedAt, count } })` merged by idempotent read-modify-write). **Do not store the checkpoint in `extensionSettings`** - for a third-party plugin that slot is `undefined` until `activateExtensions()` runs, and a checkpoint that syncs with the collections (server file inside the replicated root) blocks re-migration on the other install. Reuse the server-side sanitization semantics (no secrets written).
- [ ] **GREEN:** `node --test tests/store-migration.test.js`.
- [ ] **Commit:** `feat(client): add per-collection migration engine`.

### Task 1.7: Migrate templates end-to-end

**Files:** `src/prompt-templates.js` (modify), `index.js` (modify - run migration on init).

- [ ] **RED:** update `tests/prompt-templates.test.js` - `listTemplates`/`getTemplate`/`createInstructionTemplate`/`saveTemplate`/`deleteTemplate` route through the facade (inject a fake facade); no localforage calls in the hot path; in-memory cache populated on first `listTemplates`.
- [ ] **Implement:** rewrite `prompt-templates.js` storage calls to the facade; keep the existing `listTemplates` cache pattern. In `init()` (after `loadSettings` and store availability check), call `migrateCollection('templates')` once (guarded by the migration checkpoint). If store unavailable, fall back to reading localforage read-only with a status warning (do not migrate).
- [ ] **GREEN:** `node --test tests/prompt-templates.test.js tests/store-migration.test.js`.
- [ ] **Regression:** `node --test --test-concurrency=1 tests/*.test.js tests/providers/*.test.js` - no new failures beyond baseline.
- [ ] **Commit:** `feat(templates): server-backed templates with migration`.

### Task 1.8: Phase 1 gate

- [ ] Run the full server + client test gate (including `atomic-json-windows-retry`).
- [ ] Manual smoke (documented in commit, not automated): two-browser same-install test - create a template in Chrome, reload Firefox, see it. (Cross-install deferred to Phase 6 docs.)
- [ ] **Commit:** `test: phase 1 foundation gate`.

---

## Phase 2 - References

Images already on ST FS; only metadata moves. Lowest-risk domain after templates.

### Task 2.1: Ref-folders + refs facade
- **Files:** `src/refs-library.js` (modify).
- **RED:** `tests/refs-library.test.js` - `listRefs`/`createRef`/`updateRef`/`deleteRef`/`listFolders`/`createFolder`/`updateFolder`/`deleteFolder` route through the facade; `refreshPoolCache`/`getRefSync` populated from server; `imagePath` untouched.
- **Implement:** swap localforage calls (`LF_REFS_POOL`, `LF_REFS_FOLDERS`) for facade `listCollection('refs')` / `('ref-folders')`. Keep `normalizePoolReference`/`normalizeFolder` as the registry normalizers (server-side mirrors them). Folder-delete still patches refs (now via facade `updateRecord`).
- **GREEN + commit:** `feat(refs): server-backed reference metadata`.

### Task 2.2: Migrate refs + folders
- **Files:** `src/store-migration.js` (extend), `index.js`.
- **RED:** extend `tests/store-migration.test.js` - migrate `refs` then `ref-folders`; verify `imagePath` values preserved; idempotent.
- **Implement:** register `refs`/`ref-folders` migrations; run after templates in `init()`. Verify chat bindings (`chatMetadata.uris_binding.refs.referenceIds`) still resolve against migrated refs.
- **GREEN + commit:** `feat(refs): migrate reference pool and folders`.

---

## Phase 3 - Presets, characters, preferences + API key

### Status: partially implemented, deferred as technical debt

The `param-presets` and `characters` server collections, client CRUD adapters, migrations, and tests were implemented and deployed. They are technically sound, but the current registered UI has no parameter-preset or URIS-character management screen. The active tabs are only `API`, `Референсы`, `Генерация`, `Галерея`, and `Шаблоны`.

Therefore this work does not presently provide a user-facing cross-browser workflow. It must not be treated as a completed product feature or used as a reason to expand the generic store further.

- Do not add or migrate `LF_TEXT_PARAMS` into `param-presets`; one collection cannot safely combine the unused text and image preset models.
- Do not build or revive the legacy hidden preset/character UI merely to justify the migration. A future UI needs its own product design against the current schema-v4 tab model.
- Recommended cleanup before the next release: revert only the Phase 3 client migration and server-authoritative adapters for `param-presets` and `characters`, retaining the generic store, templates, and reference collections. Preserve the already-created JSON files until their contents have been inspected or explicitly discarded; deletion is a separate irreversible data action.
- Revisit the domain only when an active UI needs shared parameter or character records. At that point, define the workflow first, then decide whether the existing collection schemas remain appropriate.

### Task 3.1: Param-presets, characters, preferences facade + migration
- **Status:** Deferred. The param-preset and character subset is implemented but has no active UI, as recorded above. Preferences remain unstarted.
- **Files:** `src/param-presets.js`, `src/characters.js`, `src/pipeline-config.js` (preferences subset) (modify); `server-plugin/src/validation.js` (registry entries).
- **RED:** per-collection tests route through the facade; preferences split into synced (`preferences.json`) vs local-only (stay in `extensionSettings`).
- **Implement:** only migrate a domain once it has an active, user-visible workflow. Migrate each with verify-before-clear.
- **GREEN + commit:** `feat(store): server-backed <active domain>`.

### Task 3.2: Custom API key -> SecretManager
- **Files:** `src/core.js` (modify `getApiKey`/`setApiKey`), `src/server-store-api.js` (add `setCustomKey`/`hasCustomKey` via a server key endpoint reusing the connection secret-store), `server-plugin/src/router.js` + `services/connections.js` (extend key endpoints to a `text-llm` slot).
- **RED:** `tests/api-key.test.js` - `getApiKey`/`setApiKey` round-trip through SecretManager; key never present in any synchronized collection file or log; `LF_API_KEY` migrated then removed. Assert `secrets.json` is treated as sync-excluded (documented, not written to collection files).
- **Implement:** add a replica-local secret slot `ur_image_studio.text_llm` in the existing secret-store; `getApiKey`/`setApiKey` call the facade. Migrate `LF_API_KEY` once (read localforage -> store secret -> remove localforage key); never write the value to a collection file. `secrets.json` is excluded from sync by the deployment ignore-list (Phase 6.3).
- **GREEN + commit:** `feat(secrets): move custom API key to SecretManager`.

---

## Phase 4 - History and drafts

### Task 4.1: Prompt-history facade + migration + growth guard
- **Files:** `src/history.js` (modify); registry entry (object keyed by chatId).
- **RED:** `tests/history.test.js` - `getHistory`/`pushHistory`/`clearHistory` route through facade; keyed-object shape; `historyLimit` enforced client-side before `updateRecord`. Add a guard test: when the collection exceeds the documented record cap (e.g. 10k), a prune/shard hook runs (or a warning is surfaced) - assert the cap is enforced.
- **Implement:** swap `LF_HISTORY_PREFIX` localforage for facade; collection shape `object` keyed by chatId. Migrate all `uris_prompt_history_*` keys into one `prompt-history.json`. Add a `prompt-history` growth guard (cap total records; prune oldest per chat, or document sharding to per-chat files as the escalation path).
- **GREEN + commit:** `feat(history): server-backed prompt history with growth guard`.

### Task 4.2: Generation-drafts facade + migration
- **Files:** `src/generation-drafts.js` (modify); registry entry (object keyed by `chatId:msgId`).
- **RED:** `tests/generation-drafts.test.js` - drafts route through facade; keyed by `chatId:msgId`; regen context references blobs/paths only (no data URLs).
- **Implement:** swap `LF_GENERATION_DRAFT_PREFIX` for facade; migrate all draft keys into `generation-drafts.json`. (Completed-image regen context is separate - it lives in message `extra.uris_regen`, Phase 5.)
- **GREEN + commit:** `feat(drafts): server-backed generation drafts`.

---

## Phase 5 - Gallery (model B′)

The ST message-attach mechanism is **verified** (spec section 4): images are stored as file-refs in `message.extra.media[].url`, not base64. Use the exported `ensureMessageMediaIsArray` (`script.js:1991` - auto-run on load and inside `appendMediaToMessage`; the name `ensureMessageMediaToMessage` does NOT exist) + manual push to `extra.media` + exported `appendMediaToMessage` (`script.js:2157`) + `saveChat()`. `MEDIA_TYPE.IMAGE='image'` / `MEDIA_SOURCE.GENERATED='generated'` are **strings**, not numbers; `media_display='gallery'`; `media_index` = the new item's index. Regen context (`extra.uris_regen`) survives save↔reload (ST serializes chat JSONL verbatim, `extra` Object.assign'd without whitelisting).

### Task 5.1: Attach generated image to message + regen context
- **Files:** `src/image-recovery.js` (modify), `src/pipeline-stage2.js` (modify), `src/server-store-api.js` (implement `attachImageToMessage`).
- **Verified (no further code check needed):** ST attaches a generated image as a file-ref: save to disk under `userImages/<char>/` -> `clientRelativePath` -> push `{ url, type:'image', title, source:'generated' }` into `message.extra.media`, set `extra.media_display='gallery'`, set `extra.media_index` to the new index, `appendMediaToMessage(chat[mesId], mesDivElement)`, `saveChat()`. Document the exact fields in the commit.
- **Per-swipe (verified):** ST stores `extra` per swipe in `message.swipe_info[swipe_id].extra`; `syncSwipeToMes` replaces `message.extra` wholesale when switching swipes. The finalization path branches: if the generation goes through ST's swipe/re-generate (the message already has swipes, or this is a regenerate swipe), write `extra.media` AND `extra.uris_regen` into `swipe_info[message.swipe_id].extra` (mirrored to `message.extra` for the live view); if it merely appends a new message, write only `message.extra`.
- **RED:** `tests/image-recovery.test.js` - a completed generation (1) calls `saveImageToFile` (ST char gallery, `uris_` prefix), (2) calls `attachImageToMessage(msgId, imagePath, regenContext)` which pushes the file-ref into `message.extra.media` (and into `swipe_info[swipe_id].extra` when on a swipe), sets `media_display`/`media_index`, calls `appendMediaToMessage`, calls `saveChat()`, and stores `{ prompt, referenceIds, stage2Snapshot, connectionId, generatedAt }` in `extra.uris_regen` (per-swipe when applicable), (3) does NOT write a `dataUrl` to localforage, (4) does NOT call the legacy `addToGallery`. Assert the swipe path writes the snapshot to `swipe_info[id].extra`. Add a verify-assertion that ST preserves unknown `extra` fields (`uris_regen`) across a `saveChat`/load round-trip.
- **Implement:** in the generation finalization path, after `saveImageToFile`, attach the file-ref to the originating message (swipe-aware), and store regen context in `extra.uris_regen` (per-swipe when on a swipe). Drop the `addToGallery`/`setGallery` localforage writes.
- **GREEN + commit:** `feat(gallery): attach generated images to messages with regen context`.

### Task 5.2: Gallery tab as viewer (per-character, v1)
- **Files:** `src/ui/tab-gallery.js` (modify), `src/ui/lightbox.js` (modify), `src/storage.js` (gut localforage gallery).
- **RED:** `tests/tab-gallery.test.js` - `render()` lists ST char-gallery images filtered by `uris_` (via `listCharGallery`, which builds full URLs from `/api/images/list` basenames); no localforage reads. Lightbox no longer renders a "save to ST" button; regen reads regen context from the originating message's `extra.uris_regen`; go-to-message navigates to the message. (v1 = per-character view only; per-chat view deferred.)
- **Implement:** rewrite `tab-gallery.js` to source from `listCharGallery(char)` (filtered `uris_`); read folder from `extensionSettings.gallery.folders[char.avatar] ?? char.name` to match ST's gallery folder. Remove `getGallery`/`setGallery`/`addToGallery`/`updateGalleryEntry`/`clearGallery` localforage functions from `storage.js` (keep `saveImageToFile`). Remove the `copyToStGallery`/`galleryMode` settings and their UI.
- **GREEN + commit:** `feat(gallery): viewer of ST character gallery`.

### Task 5.3: Backfill legacy gallery
- **Files:** `src/store-migration.js` (extend).
- **RED:** extend `tests/store-migration.test.js` - for each legacy `uris_gallery_*` entry: upload `src` dataUrl via `/api/images/upload` -> attach to `sourceMessageId` (if the chat/message exists) with regen context -> no localforage deletion before read-back; missing source message -> warning, image still uploaded to char gallery. Batch/resume for large legacy galleries (progress + idempotency).
- **Implement:** `migrateGallery()` iterates `uris_gallery_<chatId>` keys, uploads each image, attaches where the originating message is found, writes regen context to `extra.uris_regen`, then clears the localforage gallery keys after verification.
- **GREEN + commit:** `feat(gallery): backfill legacy localforage gallery`.

---

## Phase 6 - Operations and docs

### Task 6.1: Conflict-copy warning UI
- **Files:** `src/ui/window.js` or a status banner (modify); subscribe to `store-state`.
- **RED:** `tests/store-conflict-ui.test.js` - when `/store/status` reports `conflictCopies`, a non-dismissable banner lists the collection; dismissing is impossible; resolution is manual (documented). When `filesystem.degraded` is true, a separate advisory is shown.
- **Implement:** render a banner from `getStoreStatus().conflictCopies`; render a filesystem-degraded advisory from `getStoreStatus().filesystem.degraded`; refresh on panel open and on `store-state` changes.
- **GREEN + commit:** `feat(ui): conflict-copy and filesystem-degraded warnings`.

### Task 6.2: Retire data-port.js + document ST native backup as DR
- **Files:** `src/data-port.js` (retire), callers/UI (modify), `docs/sequential-storage-deployment.md` (new).
- **RED:** `tests/data-port-retirement.test.js` - after all collections are migrated, the legacy `runExport`/`runImport`/`exportUrisData`/`importUrisData` paths are removed (or reduced to a legacy-import shim that rejects non-v6 backups with a clear message). Assert no remaining hot-path references to localforage export/import. Assert the disaster-recovery flow points to ST's native full-data backup (zip of `data/<handle>/`, secrets excluded by default).
- **Implement:** remove the localforage-centric export/import from `data-port.js` and its UI entry points (keep a legacy-import shim only if migrating from old `uris-backup-*.json` files is a supported path). Document that DR = ST's **manual** full-data **export** zip (covers the URIS plugin dir `<user-root>/plugins/ur-image-studio/` + `user/images/`, excludes `secrets.json` by default). Recommend the manual export over ST's **auto** chat-backup subsystem, which has known reliability bugs in the current release (#5796 backup-time gaps, #5780 filename collisions). Note re-entry of API keys is required after restore (secrets excluded).
- **GREEN + commit:** `chore(store): retire legacy localforage export/import; DR via ST manual full-data export`.

### Task 6.3: Deployment docs (sync ignore-list + platform)
- **Files:** `docs/sequential-storage-deployment.md` (new).
- **Content:**
  - **Sync ignore-list** (the mechanism for replica-local + secrets): exclude `secrets.json`, `<plugin-dir>/journal.key`, `operations.json`, `requests.json`, `import-operations.json`, `artifacts/`, ST `backups/`, ST `thumbnails/`. Provide concrete `.stignore` (Syncthing) and `--exclude` (rsync) snippets.
  - **Recommended tool:** `rsync` over SSH (`pkg install openssh`) for sequential two-device use (pull before use, push after; no conflict files; stays on ext4; documented passwordless-Key workflow in termux-app #1680/#4708). Syncthing alternative: run inside Termux on ext4 (de-facto Android route now that the Android app is archived - syncthing #10104), not as an Android app on shared storage; expect conflict files and `signal 9` stops (phantom-process killer - termux-app #2366/#4388; app killed too - syncthing-android #781/#2045). Note on exFAT/FAT32 external SD: rejected - documented FAT-family failures (syncthing #9485/#9982/#9227/#9539/#1734/#9432); cite these when documenting why exFAT is unsupported.
  - **Termux prerequisites:** Node 20+ (`nodejs-lts`; `engines.node >= 20`, confirmed; no known Node 22/24-on-Termux break documented - ST routinely runs on 22.22.x), `enableServerPlugins: true` (manual `config.yaml` edit; default false), keep `dataRoot` on private ext4 (never `~/storage/shared`/exFAT), `termux-wake-lock` + unrestricted battery + Termux:Boot (mechanism in termux-boot README: sortable executables in `~/.termux/boot/`), localhost access (`listen: false`; SSH/Tailscale tunnel for cross-device).
  - **Sequential-use + sync-barrier contract** (ST is "effectively a one-window application"; concurrent multi-device silently loses data - issue #5864; maintainer-preferred topology is one server + tunneling, issue #737), API-key re-entry per install, conflict-copy manual resolution, recovery from migration, recovery via ST **manual** full-data export.
- **Commit:** `docs: sequential server storage deployment guide`.

### Task 6.4: Final gate + acceptance
- [ ] Full test gate passes on Windows (including `atomic-json-windows-retry`).
- [ ] **Real Termux smoke (required):** pure-JS install on a real Termux device (no native compilation), atomic publish on ext4, FUSE-degraded detection, one real cross-device sequential cycle (two roots + rsync or Syncthing barrier) converging to identical projections with no conflict warning under correct sequential use.
- [ ] Acceptance criteria 1-10 from spec section 18 checked.
- [ ] **Commit:** `test: sequential server storage acceptance gate`.

---

## Cross-cutting

- **Migration safety:** every collection migration uses `store-migration.js` (verify-before-delete). The migration checkpoint is a per-user **server file** (`<plugin-dir>/migration-checkpoint.json` via the store facade) - not `extensionSettings`, which for a third-party plugin is undefined until `activateExtensions()` runs. The checkpoint makes reruns idempotent and crash-safe, and (because it lives inside the replicated root) prevents re-migration on the other install. Never delete localforage data before server read-back matches.
- **Fallback:** when `store-state` is `unavailable`/`incompatible`, migrated collections degrade to read-only-from-localforage (legacy data still present until migrated) with a status warning; no silent divergence. Once a collection is verified-migrated, localforage is no longer an authority.
- **Sequential contract:** ST is "effectively a one-window application" where concurrent multi-window/device access silently loses data (issue #5864; maintainer-preferred topology is one server + tunneling, issue #737). The plugin does not enforce single-writer; it surfaces conflict + filesystem warnings (Phase 6.1). For concurrent two-install operation the upgrade path is the concurrent spec (align with PR #5865 opt-in multi-window when it ships).
- **No new dependencies:** server plugin stays `write-file-atomic` + `node-fetch`, pure JS (Termux-safe). No image library (ST handles images). No SQLite, no native modules.
- **Security:** collection registry validates names/IDs; secret fields stripped on every write (server-side `SECRET_FIELD_NAMES`, not over-stripping `secretId` id-references); paths derived only from `req.user.directories.root`; no browser-supplied paths; absolute paths never returned or logged; `secrets.json` sync-excluded (csrfSecret would force a reload on handoff if mismatched; re-enter API keys per install).
- **Rollback:** each phase ships independently and is reversible by re-reading localforage (cleared only after verification, and only per collection). A failed phase does not block already-migrated collections.
- **Disaster recovery:** ST **manual** full-data export (no custom archive); avoid relying on the auto chat-backup subsystem (#5796/#5780).

## Sequencing and risk

- Phase 1 is the critical path; it delivers the reusable store, facade, migration engine, the Windows rename-retry, and one proven collection (templates). Everything else is repetition of the Phase 1 pattern per collection.
- Phase 5 (gallery B′) carries the most behavior change; its external verification (ST message-attach / file-ref) is now **resolved** (file-ref confirmed in ST source). It is deliberately last among data phases so the store foundation is stable.
- Phases are independently shippable; a phase can merge without the later ones.
