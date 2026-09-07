# Reference Image Migration Checkpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run one controlled, repeatable desktop migration that replaces existing URIS reference images with the new canonical rendition, without leaving migration code in the extension.

**Architecture:** The migration is a temporary Node.js utility, not a runtime feature, endpoint, collection, or UI. Because the current reference bytes live in SillyTavern's `user/images` area and the repository has no portable server-side image encoder, the utility invokes a controlled browser page for decode/resize/encode, then updates the URIS collection only after the new file has been uploaded and verified. It runs against one isolated Windows SillyTavern instance with no other client writing and Syncthing paused; it is deleted after successful validation.

**Tech Stack:** Node.js 20+, existing URIS server-store APIs, a temporary local browser page using the shared browser optimizer, SillyTavern `/api/images/upload`, JSON backup/checkpoint files outside the permanent extension runtime.

---

### Task 1: Freeze the migration input and backup user data

**Files:**
- Read: `D:/SillyTavern/data/default-user/plugins/ur-image-studio/refs.json`
- Read: `D:/SillyTavern/data/default-user/user/images/URIS_Refs/`
- Create temporarily: `tools/reference-image-migration/backup-manifest.json`

- [ ] **Step 1: Start one isolated Windows SillyTavern instance and confirm no second synchronized instance is writing.**

The migration uses SillyTavern's authenticated upload and collection APIs, so the selected Windows instance must be running. Do not run the migration concurrently with the Termux installation or while Syncthing is still converging. Keep the browser harness and controller attached only to this instance.

- [ ] **Step 2: Freeze the migration input and create a backup.**

Create a timestamped backup containing `refs.json` and every referenced image path. Record path, byte size, SHA-256, MIME guess, and modification time. Do not modify the source tree during this step.

- [ ] **Step 3: Fail closed when a referenced file is missing or outside the allowed URIS image directory.**

The script must report the record ID and path, skip that record, and exit nonzero. It must never resolve `..`, follow an arbitrary absolute path, or treat an unrelated SillyTavern image as owned by URIS.

- [ ] **Step 4: Verify the backup before processing.**

Re-read the backup manifest and assert that every source file hash matches the recorded hash. Expected result: migration does not begin unless the manifest is complete and internally consistent.

### Task 2: Add the temporary browser migration harness

**Files:**
- Create temporarily: `tools/reference-image-migration/index.html`
- Create temporarily: `tools/reference-image-migration/migrate.js`
- Reuse: `src/references.js` optimizer after the permanent optimizer is implemented

- [ ] **Step 1: Expose a narrow message-based browser harness.**

The Node controller sends one source image at a time to the browser. The browser decodes it, applies the canonical policy (1024 px longest edge, orientation normalization, metadata stripping, safe MIME fallback), and returns a Blob plus `{ width, height, mime, bytes, optimizationVersion }`.

- [ ] **Step 2: Process exactly one image at a time.**

The harness must release `ImageBitmap`/`Image`, object URLs, canvas references, and temporary data URLs before acknowledging completion. No `Promise.all` or batch of decoded images is allowed; this is required for mobile-browser memory safety even though the checkpoint is intended for desktop.

- [ ] **Step 3: Make the operation idempotent.**

Add a policy/version marker to each successfully migrated reference. A record with the current marker and verified canonical metadata is skipped. A failed or incomplete record remains unchanged and is retried on the next run.

- [ ] **Step 4: Keep the harness temporary.**

Do not import the migration harness from `index.js`, production UI, server routes, or the normal test bootstrap. It exists only under `tools/reference-image-migration/` while the one-time operation is being executed.

### Task 3: Upload, verify, and atomically replace each reference

**Files:**
- Modify temporarily: `tools/reference-image-migration/migrate.js`
- Read/modify through existing server APIs: `src/server-store-api.js`, `src/refs-library.js`

- [ ] **Step 1: Upload the optimized Blob through the existing SillyTavern image upload contract.**

Use the existing authenticated request headers and a sanitized generated filename. Never send the old bytes as the replacement payload.

- [ ] **Step 2: Verify the new path before changing metadata.**

Fetch the returned path, require an image MIME, decode it in the browser, verify nonzero bytes, verify dimensions, and verify that the downloaded byte count matches the recorded optimized size within the transport's exact byte count.

- [ ] **Step 3: Write the new metadata only after verification.**

Update the reference record with the new `imagePath`, `optimizationVersion`, `mime`, `width`, `height`, `optimizedBytes`, and source-byte accounting. Preserve user-facing fields such as name, aliases, description, folders, and ID.

- [ ] **Step 4: Re-read the collection and confirm the replacement.**

After each write, fetch the record again and assert that its ID and new path/metadata are present. If the write fails, leave the old record and old file untouched.

- [ ] **Step 5: Delete the old file only when ownership is explicit.**

Delete only files in the dedicated URIS-owned directory with a path/hash recorded in the backup manifest. For old paths outside that directory or without demonstrable ownership, retain the file and report it for manual review. Never delete arbitrary files from SillyTavern's shared image directory.

### Task 4: Run the checkpoint and validate the result

**Files:**
- Create temporarily: `tools/reference-image-migration/report.json`
- Create temporarily: `tools/reference-image-migration/failed.json`

- [ ] **Step 1: Run a dry-run report first.**

Expected report categories: already canonical, eligible for optimization, missing/invalid, path outside ownership boundary, and would-be output larger than source.

- [ ] **Step 2: Run the real migration sequentially on Windows.**

Keep only the selected Windows instance active, wait for each upload and metadata read-back, and do not start the Termux copy until the report is complete. Pause Syncthing before changing synchronized data, then resume it only after validation.

- [ ] **Step 3: Validate every migrated record.**

For each record, verify the path resolves, the file decodes, the longest edge is at most 1024 px, the recorded MIME matches the actual response, the optimized size is nonzero, and the old path was deleted only when ownership rules allowed it.

- [ ] **Step 4: Run the existing test suites and an application smoke check.**

Run:

```bash
node --test --test-concurrency=1 tests/*.test.js tests/providers/*.test.js
```

Then use the isolated Windows SillyTavern instance to inspect References and one chat with selected refs, and confirm that generation materialization still works. Stop that instance before resuming Syncthing and handing off to Termux.

- [ ] **Step 5: Converge Syncthing sequentially and verify the second installation.**

Wait for Syncthing convergence before starting Termux SillyTavern. Confirm reference names, folders, paths, and selected chat IDs. Do not synchronize `node_modules` or `secrets.json`.

- [ ] **Step 6: Remove temporary migration files after the report and backup are retained.**

Delete the temporary harness, controller, and report from the working extension. Keep the timestamped backup outside the extension until the user has confirmed the migrated references. No migration endpoint, UI, checkpoint collection, or permanent migration module remains.

### Task 5: Migration-specific tests before deletion

**Files:**
- Create temporarily: `tests/reference-image-migration.test.js`
- Delete after execution: `tests/reference-image-migration.test.js`

- [ ] **Step 1: Test path containment and fail-closed behavior.**

Cover missing files, absolute paths, traversal paths, and files outside the URIS-owned directory. Expected behavior: no metadata update and no deletion.

- [ ] **Step 2: Test idempotency.**

A current `optimizationVersion` with valid metadata is skipped; an old or missing marker is processed; an interrupted record is safely retried.

- [ ] **Step 3: Test verify-before-delete ordering.**

Simulate upload failure, decode failure, metadata-write failure, and delete failure. Assert that the old record/file remains until the new path has passed read-back and decode verification.

- [ ] **Step 4: Test preservation of reference metadata.**

Assert that ID, name, aliases, description, folders, and chat-level `referenceIds` remain unchanged.

- [ ] **Step 5: Run the temporary tests, then remove them with the harness.**

The permanent repository must retain only the production optimizer tests and documentation of the one-time procedure, not migration runtime code.

### Completion criteria

- Every eligible existing reference has one verified canonical rendition or an explicit manual-review report.
- No original is deleted before successful upload, read-back, decode, and metadata replacement.
- No unowned SillyTavern image is deleted.
- Windows and Termux installations converge sequentially after the operation.
- Temporary migration code is removed from the production extension.
