# Sequential Server Storage Design

**Date:** 2026-07-29
**Status:** Proposed (revised v2.1 after a second round of source verification: ST `release` chat save/load + media attach + integrity + backup paths; ST issue tracker on multi-device sync. v2 added the first-pass corrections - sequential framing, ignore-list, pagination removal, Windows retry, rsync reframing, gallery verification; v2.1 adds the verified attachment mechanics, per-swipe storage, server-file migration checkpoint, csrfSecret/PR#5553 future path, and manual-export DR notes)
**Scope:** Cross-browser and cross-installation persistence for UR Image Studio under sequential (non-concurrent) usage with external file replication.
**Supersedes (for this usage profile):** `2026-07-28-synchronized-server-storage-design.md` (targets concurrent multi-replica convergence; retained as a future option if simultaneous two-install operation is ever required).
**Depends on:** `2026-07-27-server-image-api-connections-design.md`, `2026-07-28-server-connection-add-termux-design.md`.

## 1. Goal

Move UR Image Studio's durable user data out of browser-local IndexedDB/localforage into server-owned files, so that:

- one SillyTavern installation opened from Chrome, Firefox, or a phone browser sees identical durable data without export/import;
- two SillyTavern installations (Windows and Termux) used strictly one at a time, with file replication completed before switching, see identical durable data;
- the browser is no longer the persistence authority for migrated entities.

The design removes routine browser export/import from the normal workflow. Export/import of legacy localforage data is retired once migration completes; disaster recovery uses SillyTavern's native full-data backup.

## 2. Usage contract and replication assumption

This design is correct under:

1. **Sequential use.** At most one install is active (writing) at any time.
2. **Replication barrier.** Before switching installs, the user waits until file replication reports complete.
3. **Replication unit = the SillyTavern user data directory** (`data/<handle>/`, e.g. `data/default-user/`). ST source (`src/constants.js` `USER_DIRECTORY_TEMPLATE`, `src/users.js` `getUserDirectories`) places characters, chats, settings, and `userImages` (`user/images/`) in the per-user folder, so replicating this one tree carries settings, chats, characters, uploaded/generated images, and the URIS plugin directory together. Image files live in ST's `userImages` under that root (section 7).

The barrier is discipline, not a distributed lock. The plugin assists by surfacing conflict copies (section 8) but does not enforce mutual exclusion. This matches ST core: ST is "effectively a one-window application" where concurrent multi-window/device access silently loses data via last-writer-wins on whole-`settings.json`, whole-array chat `.jsonl`, and whole-file world/character rewrites (SillyTavern issue #5864, maintainer-acknowledged; per-chat `chat_metadata.integrity` is only an identity UUID guard against stale-tab overwrite, not a revision check). The maintainer-preferred multi-device topology is "one server, many clients" (issue #737; tunneling/reverse-proxy/SSO in the docs) - replicating data between two full installs is a userland workaround, not an ST-blessed sync path. If concurrent two-install operation is ever required, this design is replaced by the concurrent spec (and aligned with ST PR #5865 opt-in multi-window/sessions when it ships), not extended in place.

### 2.1 Replication is selective, not whole-root

Everything under `data/<handle>/` is inside the replicated tree, so "replica-local" is **not** automatic - it is enforced by an explicit sync ignore-list. The following must be **excluded** from replication (Syncthing `.stignore` / rsync `--exclude`):

- `secrets.json` (ST SecretManager - holds API keys **and** `csrfSecret`; syncing it is a security hazard and a CSRF hazard; re-enter keys per install);
- `<plugin-dir>/journal.key`, `operations.json`, `requests.json`, `import-operations.json` (replica-local logs/journal);
- `<plugin-dir>/artifacts/` (replica-local provider result cache);
- ST `backups/` (per-install, regenerable);
- ST `thumbnails/` (regenerable).

Everything else under `data/<handle>/` - settings, chats, characters, `user/images/`, the URIS plugin collection files - replicates. This ignore-list is the mechanism that makes the "replica-local" files in section 5 actually replica-local.

## 3. Non-goals

- concurrent multi-replica write convergence, automatic conflict merging, or an immutable event log;
- a custom content-addressed blob store (images reuse ST's filesystem - section 7);
- optimistic-concurrency versioning, change-token polling, or live multi-tab sync (last-write-wins matches ST core semantics);
- peer discovery, network transfer, encrypted credential sync, or replay of generations on another device;
- a custom server-side archive/restore format (ST's native full-data backup covers disaster recovery - section 17).

## 4. Evidence from SillyTavern docs and source

The revision is grounded in the following findings (all verified against the ST `release` branch):

- **ST writing-extensions doc:** `extensionSettings` is saved to the server via `saveSettingsDebounced()` into `data/<handle>/settings.json` (a full atomic rewrite, `src/endpoints/settings.js`), but ST warns "Don't store large data in extensionSettings" ("loaded into memory and saved frequently") and "Never store API keys or secrets in extensionSettings". Large data is directed to `localforage`; secrets to server plugins / SecretManager.
- **ST built-in `vectors` extension** (`public/scripts/extensions/vectors/index.js`): stores settings in `extensionSettings` + `saveSettingsDebounced`, but stores vector data server-side on disk. URIS follows the same split.
- **ST `src/endpoints/images.js`:** `POST /api/images/upload` writes under `request.user.directories.userImages` (= `data/<handle>/user/images/`), optionally in a per-character subfolder (`ch_name`), and returns a **user-root-relative URL path** via `clientRelativePath` (e.g. `user/images/CharName/1700000000000.png`) - portable across installs sharing the data layout; not an absolute FS path. `POST /api/images/list` returns an **array of basenames** in `userImages/<folder>` (the caller builds the full URL). Default upload filename is `${Date.now()}.${format}` - unique, collision-free.
- **ST image-in-message mechanism (verified end-to-end):** a generated image is stored as a **file-ref** in `message.extra.media[].url` (the `clientRelativePath`), **not** base64. ST's own SD generation does: save to disk -> get the path -> push `{ url, type, title, generation_type, source }` into `message.extra.media` -> `appendMediaToMessage` -> `saveChat()` (`public/scripts/extensions/stable-diffusion/index.js:4966-5001`; `appendMediaToMessage` at `public/script.js:2157`). A plugin reuses this verbatim (section 7).
- **ST remoteconnections doc:** the official multi-device model is client-server (one host, many browsers). Multi-install file sync is not documented; the community-standard replication unit is `data/default-user/`.
- **SecretManager** (`src/endpoints/secrets.js`): `writeSecret(directories, key, value)` / `readSecret(directories, key)` store per-user secrets in `data/<handle>/secrets.json` (atomic file ops), **excluded from ST's full-data backup by default** (PR #5360). Because `secrets.json` is inside the replicated root, it must be in the sync ignore-list (section 2.1).
- **localforage:** IndexedDB is per-origin per-browser with no cross-device sync (MDN); localforage adds no sync driver. A community extension `LenAnderson/SillyTavern-LocalStorageHelper` exists solely to manually export/import browser-local settings - the workaround this design replaces.

Consequences for the design:

- **Data collections go in server-plugin files, not `extensionSettings`.** Isolates URIS replication from ST core `settings.json` churn (last-writer-wins across installs) and keeps one storage mechanism for all URIS data, consistent with the existing `connections.json`. URIS's `defaultSettings` (UI flags, limits) stay in `extensionSettings` where they already are.
- **Images need no custom store:** ST's `/api/images/upload` already stores them on the server filesystem under the user root and returns a portable relative path.
- **Secrets belong in SecretManager** (already used for connections). `secrets.json` is excluded from sync; keys are re-entered per install.

## 5. Storage model

All durable URIS data lives under the existing per-user plugin directory derived from `req.user.directories.root` (`server-plugin/src/storage/paths.js`, base `join(root, 'plugins', 'ur-image-studio')`), which is inside the replicated user root.

```text
<user-root>/plugins/ur-image-studio/
    connections.json          (existing - image connections)
    templates.json            (new)
    param-presets.json        (new)
    characters.json           (new)
    ref-folders.json          (new)
    refs.json                 (new - reference metadata; images stay in ST userImages)
    prompt-history.json       (new)
    generation-drafts.json    (new)
    preferences.json          (new - synced user preferences)
    import-operations.json    (existing - replica-local, sync-excluded)
    requests.json             (existing - replica-local, sync-excluded)
    operations.json           (existing - replica-local, sync-excluded)
    journal.key               (existing - replica-local, sync-excluded)
    artifacts/                (existing - replica-local provider results, sync-excluded)
```

**Replicated (synchronized) authority:** `connections.json`, the new `*.json` collections, and ST's `user/images/` (images live there, not under the plugin dir).

**Replica-local (sync-excluded via the ignore-list in section 2.1, not authoritative):** `import-operations.json`, `requests.json`, `operations.json`, `journal.key`, `artifacts/`. These files live under the replicated root; without the ignore-list they would sync - the list is what keeps them replica-local.

Each collection file is a bounded JSON array (or object for keyed collections) of normalized records with stable `id` and `updatedAt`. The file is rewritten atomically as a whole on every mutation. This mirrors the proven `connections.json` model.

## 6. Write protocol

Mutations reuse the existing atomic primitives in `server-plugin/src/storage/atomic-json.js`:

- `readJson(path, fallback)` / `updateJson(path, fallback, updater)`;
- per-path `withLock` (`mutex.js`) so concurrent in-process calls serialize;
- `write-file-atomic` (pure JS, ST pins `^5.0.1`; deps `imurmurhash` + `signal-exit`) temp-plus-rename so a crash never truncates a collection file.

**Windows robustness (new):** `write-file-atomic` does **not** retry on `EPERM`/`EBUSY`/`ENOTEMPTY` from transient rename locks (antivirus, search indexer, file watchers - upstream issue closed *not planned*). The current `atomic-json.js` wraps it without retry. A short retry loop (a few attempts with backoff, Windows-only) is added around the atomic write so transient locks do not surface as failed mutations. This also benefits the existing `connections.json` path. On Termux private ext4 the underlying POSIX rename is atomic and unaffected.

The browser never writes collection files directly; all writes go through the server API (section 9), which validates, normalizes, sanitizes, and publishes atomically under the lock. Last write wins; there is no version field and no conflict-merge machinery, matching ST core's own `saveSettingsDebounced` semantics for sequential single-writer use. Concurrent plugin writes to URIS files are safe alongside ST writing `settings.json` - they are different files, and `write-file-atomic` serializes per-file.

## 7. Images

Images are not stored in a URIS-owned blob store. They reuse ST's `/api/images/upload` (already used by `src/storage.js` `saveImageToFile`, which saves with an `uris_` filename prefix and returns the portable `clientRelativePath`):

- the server stores bytes under the user root's `user/images/<ch_name>/`;
- the server returns a **root-relative URL path** that is portable to any install sharing the data layout;
- default filenames are timestamp-unique, so two installs never collide on the same filename;
- because the user replicates the whole user root (section 2), image files travel with the metadata.

Behavior changes:

- **References** already store `imagePath` (an ST path). Only their metadata moves from localforage to `refs.json`; images are untouched.
- **Gallery (model B′).** There is no URIS-owned gallery collection. A completed generation is (1) saved to ST's character gallery via the existing `saveImageToFile` (`user/images/<char>/uris_*`), and (2) attached to its originating message as a **file-ref** by pushing `{ url: path, type, title, source }` into `message.extra.media`, setting `media_index`, calling ST's exported `appendMediaToMessage`, and `saveChat()` - exactly ST's native SD-generation path (section 4). Chat files are not bloated with base64. Regeneration context (prompt, reference IDs, Stage 2 snapshot, connectionId, generatedAt) is stored in a URIS-namespaced field on that message's `extra` (e.g. `extra.uris_regen`); ST preserves unknown `extra` fields across save/load. The gallery tab is a **viewer**: ST's per-character gallery via `/api/images/list` filtered to the `uris_` filename prefix. (The message-attached file-refs already render inline in chat, so the planned "insert image into the generating post" feature is natively enabled.)

**v1 scope:** the gallery tab shows the per-character view only (ST char-gallery, `uris_`-filtered). A per-chat message-attachment view is deferred (section 19).

An image path may resolve before its file arrives via sync; it renders as missing and recovers when the file arrives. No content-addressing, no dedup logic, no custom image endpoint.

**Attachment mechanics (verified against ST `release`):** ST attaches a generated image as a file-ref by pushing `{ url, type:'image', title, source:'generated' }` (note: `MEDIA_TYPE`/`MEDIA_SOURCE` are string constants) into `message.extra.media`, setting `extra.media_display = 'gallery'` and `extra.media_index` to the new item's index, calling the exported `appendMediaToMessage(chat[mesId], mesDivElement)` (which internally runs the exported `ensureMessageMediaIsArray` - auto-run on load as well), then `saveChat()`. There is no `addFileToMessage`; image media uses `extra.media`, distinct from `extra.files`. Regeneration context goes into a URIS-namespaced field `extra.uris_regen` (verified to survive save↔reload: ST serializes chat messages verbatim as JSONL and `Object.assign`s `extra` without rebuilding or whitelisting it; the built-in memory extension relies on the same persistence for `extra.memory`).

**Per-swipe storage (important nuance).** ST stores media and `extra` per swipe: `message.swipe_info[swipe_id].extra` is a snapshot, and `syncSwipeToMes` replaces `message.extra` wholesale when the user switches swipes. So a generation that goes through ST's swipe/re-generate path must write `uris_regen` (and `extra.media`) into `swipe_info[message.swipe_id].extra` (mirrored to `message.extra` for the live view), not just into `message.extra`. A generation that merely appends a new message needs only `message.extra`. The finalization path branches accordingly.

## 8. Replication, conflict copies, and the sync tool

The plugin does not perform replication. The design is **sync-tool-agnostic**; the contract is sequential use + a completed sync barrier (section 2) + the ignore-list (section 2.1).

**Recommended tool: `rsync` over SSH** for sequential two-device use. It gives an explicit one-directional handoff (pull before use, push after), produces no conflict files, stays on Termux-private ext4, and is event-driven rather than a persistent daemon (rsync-over-SSH in Termux is a documented, passwordless-Key workflow - termux-app #1680/#4708). **Syncthing** is a supported alternative; if used, run it *inside* Termux on ext4, not as the Java Android app on shared storage. Note Syncthing-in-Termux is the de-facto Android route now that the official Android app is archived (syncthing #10104), but it stops whenever Android kills Termux (`signal 9` / phantom-process killer - termux-app #2366/#4388; even the native app gets killed, syncthing-android #781/#2045) and can emit conflict files. Reasoned directional preference (not a documented community vote): on-demand rsync sidesteps the persistent-daemon survivability problem; Syncthing adds the conflict-file surfacing the plugin scans for. The plugin stays tool-agnostic - it only scans for conflict artifacts.

On startup and on each status check the plugin scans the plugin directory for replication conflict artifacts that match a collection name: Syncthing `*.sync-conflict-*` (real format: `refs.sync-conflict-20260729-103000-ABC.json`, i.e. the marker is inserted before the final extension) and Dropbox/OneDrive `* (conflicted copy)*`. When found:

- `/store/status` reports the collection, file, and mtime;
- the UI shows a non-dismissable warning;
- the user resolves manually (keep one file, delete the other) or restores from backup.

The plugin never auto-merges or silently picks a winner. Under disciplined sequential use this should never trigger. No conflict-resolution UI is built in v1 beyond the warning.

## 9. Browser client model

One `server-store-api.js` facade, modeled on `src/server-image-api.js` (same `BASE_PATH`, same error envelope, same `getRequestHeaders`). Domain modules stop using localforage as the authority.

```js
listCollection(type)          // whole collection (no pagination - see section 10)
getRecord(type, id)
createRecord(type, payload)
updateRecord(type, id, payload)
deleteRecord(type, id)
replaceWhole(type, value)     // migration bulk import
uploadImage(file)             // wraps ST /api/images/upload
listCharGallery(char)         // wraps ST /api/images/list, uris_ filter, builds full URLs from basenames
attachImageToMessage(msgId, imagePath, regenContext)  // extra.media + appendMediaToMessage + saveChat
getStoreStatus()
```

- **In-memory cache only.** The existing `refreshPoolCache` / `getRefSync` pattern (`src/refs-library.js`) is retained but sourced from the server: on panel/tab open, fetch the collection into memory; UI reads synchronously from the cache.
- **No localforage authority, no offline fallback.** The server component is required for generation anyway (connections live there), so when it is unavailable the extension is largely non-functional and reads degrade to empty with a status message (reuse `src/server-connection-state.js`). localforage is only a migration source, read once and then cleared per collection.
- **Refresh on focus/open, no polling.** Sequential use means a device switch is a fresh page load (fresh fetch). Within one browser, ST core itself does not live-sync two tabs; matching that is acceptable. Live polling is deferred.

Browser-local storage remains only for UI state (panel geometry, active tab, accordion state) in `extensionSettings`/localStorage, unsaved form drafts, and diagnostics - never for migrated durable entities.

## 10. Server API

All endpoints under `/api/plugins/ur-image-studio/v1`.

```text
GET    /store/status
GET    /store/:collection
GET    /store/:collection/:id
POST   /store/:collection
PUT    /store/:collection/:id
DELETE /store/:collection/:id
PUT    /store/:store/:collection   (whole-collection replace, migration only)
```

- The server validates `:collection` against a static registry, maps it to `<collection>.json`, normalizes and sanitizes the payload (stripping secret fields via a **server-side** `SECRET_FIELD_NAMES` set - section 13), assigns `updatedAt`, and writes atomically under the lock.
- **No pagination.** Collections are small and fully cached client-side; `GET /store/:collection` returns the whole collection (like `connections.json`). Cursor pagination is deferred until a collection (e.g. `prompt-history`) measurably grows.
- `GET /store/status` returns `{ state, lastScanAt, conflictCopies:[{collection,file,mtime}], filesystem:{type,degraded}, migratedCollections }`. `filesystem` reports the detected type (`ext4`/`ntfs`/`fuse`/`unknown`) and `degraded:true` when the root is on FUSE (Termux shared storage) or another filesystem where atomic rename/fsync are not guaranteed. Absolute paths are never returned. (The server cannot observe replication state, so no "synchronized" flag is reported.)
- Domain endpoints (connection probe/create/update/delete, key management, `/generate`, `/requests/:id`) remain authoritative and unchanged. Connection mutations keep writing `connections.json` through the existing service.
- Image upload is delegated to ST's `/api/images/upload`; the facade wraps it for convenience.

## 11. Entity collections

Schemas preserve existing stable IDs and fields so migration is lossless.

- **templates** - `{ id, name, type:'instruction', instruction, createdAt, updatedAt }` (`src/prompt-templates.js`).
- **param-presets** - image/text param presets (`LF_IMAGE_PARAMS`/`LF_TEXT_PARAMS`).
- **characters** - URIS character slots (`src/characters.js`).
- **ref-folders** - `{ id, name, color, order }` (`src/refs-library.js`).
- **refs** - `{ id, name, role, aliases, description, folders, imagePath, createdAt, updatedAt }`. `imagePath` stays an ST path; no blob reference.
- **prompt-history** - keyed by chatId; `{ prompt, ts, style, sourceMsgId }` (`src/history.js`). **Growth watch:** `historyLimit` bounds per-chat history; the file still grows across chats. Cap or shard (per-chat files) beyond ~10k records.
- **generation-drafts** - keyed by `chatId:msgId` (`LF_GENERATION_DRAFT_PREFIX`); pre-completion Stage-2 snapshots. (Completed-image regen context lives in message `extra.uris_regen` - section 7; the two are distinct lifecycle stages.)
- **gallery** - NOT a URIS collection. A generated image is saved to ST's character gallery and attached to its originating message as a file-ref; regeneration context lives in that message's `extra.uris_regen`. The gallery tab is a viewer of ST's per-character gallery (`/api/images/list`, `uris_`-filtered). No `gallery.json`, no localforage gallery (`src/storage.js`, `src/image-recovery.js`, `src/ui/tab-gallery.js`).
- **preferences** - synced subset (default template/preset IDs, generation defaults, automation policy, reference-selection policy, gallery policy). Local-only prefs (geometry, active tab, diagnostics) stay in `extensionSettings`.

Chat-specific selection (active template/profile/refs for a chat) stays in `chatMetadata.uris_binding` (replicates with ST chat files). It stores stable entity IDs only.

## 12. Credentials

Connection metadata and URIS collections synchronize; API keys do not. Keys stay in SillyTavern SecretManager, whose store is `data/<handle>/secrets.json`. Because that file is inside the replicated root, it is **sync-excluded** (section 2.1) - so secrets are **replica-local by exclusion, not by nature**. The custom Text-LLM API key (`LF_API_KEY`, `src/core.js`) moves from localforage into a URIS secret slot (e.g. `ur_image_studio.text_llm`) via `writeSecret`/`readSecret`, alongside connection keys, so it never appears in any synchronized collection file and is shared across browsers on the same install (Chrome and Firefox see one key) without being synced across installs.

A connection or custom key arriving on the other install is visible but keyless until the user enters the key locally. **Note:** because `csrfSecret` lives in `secrets.json` too, mismatched secrets across installs mean a session established on one install fails CSRF on the other (expected symptom: a forced page reload re-establishes the session after the data handoff). Re-entering keys per install is an accepted v1 cost; the SillyTavern Secrets Manager (PR #4131) makes managing per-device labeled keys easier. **Future:** the maintainers' `secrets.json` direction is opt-in at-rest encryption with a shared master password (draft PR #5553); once shipped and adopted, an encrypted `secrets.json` with a shared master password *could* be synced instead of excluded, removing the re-entry cost. v1 sticks with exclude + re-enter. Encrypted multi-install credential sync is otherwise future work (concurrent spec).

## 13. Security and limits

- Derive the user root only from authenticated `req.user.directories.root`; validate collection names and IDs against strict patterns; reject browser-supplied paths/filenames; prevent traversal/symlink/junction escape.
- Recursively strip secret fields from every collection write using a **server-side** `SECRET_FIELD_NAMES` set (`apiKey`, `api_key`, `token`, `password`, `secret`). The existing `SECRET_FIELD_NAMES`/`sanitizeBackupValue` live client-side in `src/data-port.js`; a server-side copy (or shared module) is required for server sanitization. Note: `secretId` is a *reference* stored by connections (not a secret) - the connection service is not on the new collection store, but document the distinction so a future collection storing an id-reference is not over-stripped.
- Hard limits on collection file bytes, per-record payload depth/string/array cardinality, and migration batches.
- Never log API keys, auth headers, full prompts by default, image bytes/data URLs, signed provider query strings, or absolute paths.

## 14. Termux and platform compatibility

- **Private ext4** (`/data/data/com.termux/files/home/...`, the default `dataRoot`): atomic rename, fsync, POSIX mode bits hold. Supported location for the plugin dir and ST `userImages`. **Keep `dataRoot` here; never move data to `~/storage/shared`** (FUSE) or exFAT external SD - documented file corruption (termux-app #2460), broken atomic temp+rename (ST #2092), >200x slower for many small files (termux-app #2174).
- **Shared FUSE** (`~/storage/shared/`): atomic rename not guaranteed, fsync may be a no-op, mode bits ignored. If the replicated root lands on FUSE, `/store/status` reports `filesystem.degraded:true`; writes remain best-effort with weaker durability. **exFAT/FAT32 external SD is unsupported and rejected** - documented load-bearing failures on FAT-family Android SD with Syncthing: deleted files persist while the UI falsely reports in-sync (syncthing #9485, closed not_planned), deleted directories reappear (syncthing #9982), FAT local-time timestamps cause DST mass-resync (syncthing #9227), illegal `*:<>?|` filenames cause Out-of-Sync (syncthing #9539/#1734), and sdcardfs has no symlink support (syncthing #9432).
- **Process can be SIGKILL'd at any time** (Android phantom-process killer - the canonical Android-12 regression tracked in termux-app #2366; maintainer-confirmed `signal 9` detection request in #4388; survival asks in #4219/#5050). Tying Syncthing to this: it dies with Termux because it is a child process (syncthing #10104). Writes are already atomic and idempotent, so a kill mid-mutation leaves either the old or the new file, never a torn one; migration is verify-before-clear and idempotent. Recommend `termux-wake-lock`, unrestricted battery, and Termux:Boot (the boot mechanism runs sorted executables in `~/.termux/boot/`, README-documented; combined ST/Syncthing boot scripts are user-assembled from those blocks) for auto-restart (documented, not enforced).
- **No native modules.** `write-file-atomic` and `node-fetch` are pure JS and already used by the shipping plugin. No new dependencies. Image handling reuses ST's own upload, so no image library is added.
- **Prerequisites:** Node.js 20+ (`pkg install nodejs-lts`; `engines.node >= 20`, confirmed). No known Node 22/24-on-Termux break is documented; ST issue reports routinely run on Node 22.22.x, so newer `nodejs-lts` is acceptable. `enableServerPlugins: true` (manual `config.yaml` edit; default false), installed plugin deps, writable Termux-private data dir.
- **Windows/NTFS** works with the existing atomic-json implementation (chmod skipped); add the rename-retry in section 6 for transient-lock robustness.
- **Network access:** keep ST on localhost (`listen: false`); access from the same device at `localhost:8000`; for cross-device access prefer an SSH/Tailscale tunnel over `listen: true`.

## 15. Migration

Incremental, idempotent, per-collection, verify-before-delete-localforage. Reuses `src/data-port.js` concepts (which is itself retired afterward - section 17).

1. templates (lowest risk, pure text);
2. param-presets, characters;
3. ref-folders, refs (metadata only; images already on ST FS);
4. prompt-history, generation-drafts;
5. gallery: existing localforage gallery `dataUrl` entries are uploaded to ST's character gallery via `/api/images/upload`, attached to their originating messages (file-ref), and their regeneration context written into `extra.uris_regen`; `copyToStGallery`/`galleryMode` settings are removed;
6. synchronized preferences; move custom API key to SecretManager;
7. chat-binding verification (entity IDs in `chatMetadata.uris_binding` still resolve);
8. localforage cleanup per collection after read-back verification.

Existing stable IDs are preserved. Missing image sources produce a warning tied to the entity; metadata is not falsely marked complete. `connections.json` already uses this model and is not migrated again.

**Migration checkpoint lives in a server file, not `extensionSettings`.** For a third-party plugin, `extensionSettings[MODULE_NAME]` is `undefined` until the plugin's own `activate`/`loadSettings` runs inside `activateExtensions()` (ST only `Object.assign`s the saved `extension_settings` literal, which has no slot for a custom module); code that runs early on a first-load event would miss the slot. To avoid that timing footgun and to keep the checkpoint replicated with the collections, it is stored as a per-user server file (`<plugin-dir>/migration-checkpoint.json` via the store facade). Because the plugin dir sits inside the replicated user root, the checkpoint syncs: once install A migrates a collection and syncs, install B receives both the checkpoint and the migrated collection file and correctly skips re-migration (abandoning B's stale browser-local data). The first migration should run on the install with the most complete localforage data. The checkpoint is also covered by ST's native backup.

## 16. Testing

- **Collection store:** atomic create/update/delete under in-process concurrency, tombstone omission, sanitization of secret fields, path-traversal rejection, registry validation of collection names.
- **Images:** gallery backfill converts a dataUrl to an ST character-gallery path, attaches it to the originating message (file-ref via `extra.media` + `appendMediaToMessage`), and writes regen context to `extra.uris_regen`; the gallery tab lists ST character-gallery images filtered by `uris_`; refs keep working with their existing ST paths unchanged.
- **Replication:** conflict-copy scan surfaces a warning and picks no winner (tested against real Syncthing naming `refs.sync-conflict-*.json` and `refs (conflicted copy).json`); out-of-order image arrival reprojects; missing collection file degrades to empty.
- **Client facade:** server-authoritative read into in-memory cache; refresh on panel open; empty + status when server unavailable.
- **Migration:** each category idempotent rerun; no localforage deletion before verification; chat-binding ID preservation; checkpoint read from the server file (not `extensionSettings`) so it exists independent of extension-init ordering.
- **Windows:** atomic publish with the rename-retry survives a simulated transient `EPERM`/`EBUSY`.
- **Termux (required, not optional):** pure-JS install without compilation on a real Termux device; atomic publish on ext4; FUSE-degraded path reported; one real cross-device sequential cycle (two roots + simulated/real sync barrier) converges to identical projections with no conflict warning under correct sequential use.

Deterministic tests need no real Syncthing; a real Termux + real-sync smoke test runs before release.

## 17. Delivery phases

1. **Foundation + templates** - generic collection CRUD (no pagination), `/store/status` with conflict scan + filesystem detection, Windows rename-retry in `atomic-json.js`, client facade, migrate templates.
2. **References** - ref-folders and refs metadata (images already on ST FS); adapt `src/refs-library.js`.
3. **Presets, characters, preferences** - migrate each; move custom API key to SecretManager.
4. **History and drafts** - migrate each; add the `prompt-history` growth cap/shard guard.
5. **Gallery (model B′)** - drop the URIS gallery collection; generate -> save to ST character gallery + attach file-ref to originating message + regen context in `extra.uris_regen`; gallery tab = viewer of ST character gallery (`/api/images/list`, `uris_` filter); backfill legacy localforage gallery; remove `copyToStGallery`/`galleryMode`; adapt `src/storage.js`, `src/image-recovery.js`, `src/ui/tab-gallery.js`.
6. **Operations** - conflict-copy warning UI, sync ignore-list + deployment docs (Termux prerequisites, rsync/Syncthing setup, key re-entry, conflict-copy manual resolution, recovery via ST native backup); retire `src/data-port.js` (legacy localforage export/import) once all collections are migrated.

Disaster recovery uses SillyTavern's native **manual** full-data backup (zip of the whole user root via `createBackupArchive`, which includes the URIS plugin dir `<user-root>/plugins/ur-image-studio/` + `user/images/` and excludes `secrets.json` by default when `allowKeysExposure: false`). Note ST's backup zips the entire `data/<handle>/` root (including `thumbnails/` and `backups/chat_*`), so it is large but complete; re-entry of API keys is required after restoring (secrets excluded). Prefer the manual full-data **export** over ST's **auto** chat-backup subsystem, which has known reliability bugs in the current release (issue #5796 backup-time gaps; issue #5780 filename collisions). No custom server archive/restore format is built in v1.

## 18. Acceptance criteria

1. Chrome and Firefox on one ST install see the same durable data without export/import.
2. A Windows install and a Termux install, used sequentially with a completed sync barrier, show the same templates, references, and gallery after switching.
3. No migrated entity uses localforage as the persistence authority.
4. A Syncthing conflict copy produces a visible warning and no silent data loss.
5. Reference and gallery images render on the other install after synchronization (gallery images travel as file-refs in chat files plus files in ST `user/images/`).
6. Existing image connections remain unaffected.
7. The plugin installs and runs on a real Termux device without native-module compilation and with no new dependencies (verified, not reasoned).
8. API keys never appear in synchronized collection files, logs, or diagnostics; `secrets.json` is sync-excluded.
9. Existing localforage data is removed collection-by-collection only after verification.
10. Routine use no longer needs browser JSON export/import.

## 19. Open questions and future

- **Replication scope:** the design targets the community-standard unit `data/default-user/` (carries settings, chats, characters, `user/images/`, and the plugin dir). A user who replicates only the plugin directory would lose image sync; that setup is documented as unsupported in v1.
- **Gallery model (B′):** gallery is a derived view (ST per-character gallery), not a URIS collection. v1 ships the per-character view only; a per-chat (message-attachment) view is a deferred sub-decision.
- **Sync tool:** rsync-over-SSH is recommended for sequential two-device use; Syncthing is supported. The plugin stays tool-agnostic.
- **Encrypted credential sync:** re-entering API keys per install is the accepted v1 cost; a future encrypted-vault design would remove it.
- **Live multi-tab refresh:** deferred; add change polling/SSE only if two-tab staleness becomes a real complaint.
- **Collection pagination:** deferred until a collection (likely `prompt-history`) grows enough to matter.
- **Upgrade path to concurrent sync:** if simultaneous two-install operation is later required, mutable collection files migrate into the concurrent spec's event log; images are unaffected.
