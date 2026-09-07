# Reference Image And Mobile Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every new URIS reference a small, portable canonical image before upload, reduce mobile memory and idle work, and keep generation payloads bounded without adding a permanent image-processing dependency or server migration subsystem.

**Architecture:** A single browser-side optimizer is the only permanent image transformation path. It decodes one file at a time, normalizes orientation, scales to a 1024 px longest edge without upscaling, strips metadata by re-encoding, validates the actual output, and uploads exactly one canonical rendition. The server remains authoritative for metadata and existing SillyTavern image storage; no Sharp/Jimp/native module is introduced, preserving Windows/Termux compatibility. A temporary desktop migration utility is handled by the separate checkpoint plan.

**Tech Stack:** Browser `Blob`, `ImageBitmap`/`HTMLImageElement`, canvas, `canvas.toBlob`, existing SillyTavern `/api/images/upload`, URIS server collection APIs, Node.js test runner, manual Chrome/Firefox/Safari and Termux validation.

---

### Task 1: Establish the optimizer contract and test seams

**Files:**
- Modify: `src/references.js:79-160`
- Test: `tests/references.test.js`
- Modify: `src/refs-library.js:1-80`

- [ ] **Step 1: Write failing contract tests for the canonical result.**

Define the result shape used by every upload path:

```js
{
  dataUrl,
  blob,
  mime,
  width,
  height,
  sourceBytes,
  optimizedBytes,
  optimizationVersion,
}
```

Test that the optimizer rejects non-image data, zero-byte output, undecodable output, and source files above the explicit input guard. Test that dimensions never exceed 1024 on the longest edge and that a smaller image is never upscaled.

- [ ] **Step 2: Add injectable browser primitives for Node tests.**

Keep production defaults bound to `FileReader`, `fetch`, `Image`/`createImageBitmap`, `URL.createObjectURL`, canvas, and `toBlob`. Allow tests to supply deterministic decode and encode fakes so policy decisions can be tested without pretending Node has a DOM.

- [ ] **Step 3: Define the policy constants in one place.**

Use:

```js
const OPTIMIZATION_VERSION = 'ref-v2-1024';
const MAX_EDGE = 1024;
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const WEBP_PHOTO_QUALITY = 0.82;
const WEBP_ALPHA_QUALITY = 0.88;
const JPEG_QUALITY = 0.85;
```

The version must change whenever output semantics change. Do not scatter numeric policy values through UI files.

- [ ] **Step 4: Add metadata normalization tests.**

Verify that `normalizePoolReference()` preserves existing user fields and accepts optional `mime`, `width`, `height`, `optimizedBytes`, `sourceBytes`, and `optimizationVersion` without making them required for old records.

### Task 2: Implement safe decode, orientation normalization, and bounded encoding

**Files:**
- Modify: `src/references.js:79-160`
- Test: `tests/references.test.js`

- [ ] **Step 1: Write failing tests for format selection.**

Cover these cases:

- opaque JPEG/photo: WebP candidate when WebP encoding actually works;
- opaque input with WebP unavailable: JPEG fallback;
- alpha image: WebP alpha candidate;
- alpha image with WebP unavailable: PNG fallback;
- opaque PNG/line art: choose the smaller validated candidate, not PNG by source extension alone;
- candidate larger than a valid source already within policy: retain the source bytes as the single canonical upload, without retaining a second copy;
- unsupported encoder or invalid Blob: fail with a user-facing recoverable error.

- [ ] **Step 2: Implement one-image-at-a-time decode.**

Prefer `createImageBitmap` with an orientation-aware path where supported; otherwise use an `HTMLImageElement` and draw into a canvas. Do not assume `createImageBitmap({ imageOrientation: 'from-image' })` is available. When orientation support is uncertain, use the existing image-loading path and document the manual EXIF fixture check for Safari/Android.

- [ ] **Step 3: Normalize pixels into a bounded canvas.**

Compute the 1024 px longest-edge target, preserve aspect ratio, never upscale, and draw the oriented image into a fresh canvas. Guard against invalid dimensions and browser canvas allocation failures. Do not create multiple full-size canvases.

- [ ] **Step 4: Probe actual WebP encoding, not display support.**

Call `canvas.toBlob('image/webp', quality, callback)` and validate that the returned Blob has a WebP MIME and nonzero size. If it returns null, PNG, or an unusable Blob, fall back according to alpha/opaque policy. Never label a PNG response as WebP.

- [ ] **Step 5: Encode, validate, and compare candidates.**

For each candidate, validate MIME, byte size, dimensions, and decodeability. Compare against the source only when the source is already within the dimension and format policy. Select the smallest valid candidate that preserves required alpha; otherwise use the preferred candidate. Convert the selected Blob to a data URL only at the upload boundary.

- [ ] **Step 6: Release temporary resources in `finally`.**

Revoke object URLs, clear image handlers, close `ImageBitmap`, drop canvas/context references, and release temporary data URLs after the result has been materialized. The function must not retain source Blob, canvas, or bitmap in module state.

- [ ] **Step 7: Run focused tests.**

Run:

```bash
node --test --test-concurrency=1 tests/references.test.js
```

Expected: all optimizer policy tests pass; browser-only EXIF and real canvas tests remain explicitly marked for manual browser validation rather than falsely passing in Node.

### Task 3: Route every ingestion path through the shared optimizer

**Files:**
- Modify: `src/ui/tab-references.js:187-224,330-397,527-607`
- Modify: `src/ui/tab-gallery.js:164-198,235-249`
- Modify: `src/server-store-api.js:134-157`
- Test: `tests/tab-references.test.js`
- Test: `tests/references.test.js`

- [ ] **Step 1: Add failing call-path tests.**

Assert that desktop add, mobile add, replacement, and gallery “save as reference” each call the same optimizer and upload only its selected Blob/data URL. Assert that an optimizer rejection leaves the existing record unchanged and shows a recoverable error.

- [ ] **Step 2: Replace duplicated FileReader/compression blocks.**

Create one small ingestion helper that accepts a `File` or data URL, calls `optimizeReferenceImage`, uploads the returned canonical data, and returns the metadata required for `createRef`/replacement. Keep UI-specific confirmation, naming, folder selection, and cancellation outside the helper.

- [ ] **Step 3: Persist canonical metadata with each record.**

Store `mime`, `width`, `height`, `optimizedBytes`, `sourceBytes`, and `optimizationVersion` alongside `imagePath`. Existing records without these fields must continue to render and remain eligible for the temporary checkpoint tool.

- [ ] **Step 4: Preserve cancellation and error semantics.**

Do not upload until the user has confirmed the reference name and operation. If upload succeeds but metadata creation fails, report the orphan path for cleanup; do not silently claim success. Do not keep source data URLs in UI state after the operation completes.

- [ ] **Step 5: Run focused UI tests.**

Run:

```bash
node --test --test-concurrency=1 tests/tab-references.test.js tests/references.test.js
```

### Task 4: Make image ownership and replacement cleanup explicit

**Files:**
- Modify: `src/refs-library.js:100-230`
- Modify: `src/server-store-api.js`
- Modify: server plugin route/storage files only if a scoped delete endpoint is required
- Test: `tests/refs-library.test.js`
- Test: `tests/server-collection-store.test.js`

- [ ] **Step 1: Write failing lifecycle tests.**

Cover create, replace, cancel-after-upload, delete, and folder deletion. Assert that metadata is not removed before the record write succeeds and that no arbitrary SillyTavern image path is deleted.

- [ ] **Step 2: Add an explicit managed asset marker.**

New uploads receive a URIS asset identifier or dedicated managed path marker. Store enough information to prove ownership without relying only on a filename prefix. Existing unmarked records are treated as unowned.

- [ ] **Step 3: Add narrow deletion support only for owned assets.**

If the existing SillyTavern API cannot delete an uploaded image safely, add a server route constrained to the authenticated user's URIS-managed asset records and a normalized path under the dedicated directory. Reject traversal, absolute paths, mismatched owner, and unmarked legacy paths.

- [ ] **Step 4: Delete replaced/deleted assets after metadata success.**

For replacement, upload and verify the new asset, write metadata, re-read the record, then delete the old asset only if its managed marker proves ownership. For record deletion, remove metadata first only when the deletion operation is retryable and the asset remains reportable; otherwise use a verified delete-then-record transaction appropriate to the actual server API. Tests must pin the chosen ordering.

- [ ] **Step 5: Test old records conservatively.**

Legacy `imagePath` values continue to work. They are never deleted automatically by normal UI operations unless migrated into the managed format and explicitly owned.

### Task 5: Remove duplicated data URLs from generation snapshots

**Files:**
- Modify: `src/pipeline-stage2.js:108-173`
- Modify: `src/generation-drafts.js:297-324`
- Modify: `src/image-api.js:24-64`
- Test: `tests/pipeline-stage2.test.js`
- Test: `tests/generation-drafts.test.js`

- [ ] **Step 1: Write failing snapshot tests.**

Assert that persisted drafts and recovery records contain stable reference IDs, image paths/revisions, and metadata, but no full `dataUrl`/base64 image payload. Assert that the transient generation request still contains materialized image data immediately before dispatch.

- [ ] **Step 2: Add a transient materialization boundary.**

Resolve selected reference IDs, fetch each stored image sequentially, validate MIME and decoded dimensions, and create the request-only data URL. Cache only for the current submission so multiple pipeline stages do not refetch the same reference.

- [ ] **Step 3: Add a bounded legacy path.**

For old records lacking optimization metadata, apply the shared optimizer during materialization when needed, but do not persist the resulting data URL in a draft. Enforce per-reference 25 MiB decoded/input checks and the aggregate outbound cap before provider dispatch.

- [ ] **Step 4: Clear transient resources after dispatch/failure.**

Drop request data URLs and temporary Blobs in both success and error paths. Keep only stable IDs and error diagnostics in recovery state.

- [ ] **Step 5: Run focused pipeline tests.**

Run:

```bash
node --test --test-concurrency=1 tests/pipeline-stage2.test.js tests/generation-drafts.test.js
```

### Task 6: Fix idle mobile work and hidden-tab rendering

**Files:**
- Modify: `src/ui/tab-references.js:1-90`
- Modify: tab registration/activation files identified by `src/ui/tabs.js`
- Modify: `src/ui/tab-gallery.js`
- Test: `tests/tab-references.test.js`
- Test: relevant UI/tab tests

- [ ] **Step 1: Write a regression test for hidden References rendering.**

Stub a root whose `clientWidth` is zero and a `ResizeObserver` that reports zero while the tab is hidden. Assert that rendering is not recursively triggered and that no resize loop continues after the observer disconnects.

- [ ] **Step 2: Make width measurement stable.**

Remove the `clientWidth || 600` oscillation. Skip layout-dependent rendering while width is zero, or use one stable fallback that does not cause observer-triggered rerenders. Re-render only after the tab becomes visible.

- [ ] **Step 3: Defer expensive tab work until activation.**

Do not fetch/render complete References or Gallery collections during extension startup when their tabs are collapsed or hidden. Initialize event wiring cheaply, then load records and image previews on first activation.

- [ ] **Step 4: Bound preview rendering.**

Keep native lazy loading for image elements, use a bounded visible window or pagination for large collections, and avoid decoding every full-size image just to render a thumbnail. Keep stable thumbnail dimensions so layout does not thrash.

- [ ] **Step 5: Debounce search and cancel stale work.**

Use one short debounce for reference filtering and an `AbortController`/generation token so an older search cannot trigger another full render after a newer query.

- [ ] **Step 6: Remove redundant startup/network work.**

Audit Generate and References activation for duplicate `/connections` and collection requests. Cache the current collection for the activation cycle and invalidate only after a mutation. Verify that no timer, animation frame loop, or continuous polling is introduced.

- [ ] **Step 7: Run UI regression tests.**

Run:

```bash
node --test --test-concurrency=1 tests/tab-references.test.js tests/events.test.js
```

### Task 7: Validate browser and Termux behavior manually

**Files:**
- Create: `docs/superpowers/specs/2026-07-29-reference-image-optimization-design.md` update with test matrix
- Create: `docs/testing/reference-image-optimization-matrix.md`

- [ ] **Step 1: Test desktop Chromium and Firefox.**

Use a large JPEG, EXIF-rotated portrait, transparent PNG, opaque PNG screenshot, small image, and an already-compressed WebP. Confirm output MIME, dimensions, byte size, visual orientation, transparency, and no retained original upload.

- [ ] **Step 2: Test Safari/WebKit separately.**

On macOS/iOS Safari, verify that WebP display support is not mistaken for encoder support. Confirm actual `toBlob` MIME, JPEG/PNG fallback, EXIF orientation, large-input failure handling, and no black/blank output. iOS browsers must be treated as WebKit even when the UI says another browser name.

- [ ] **Step 3: Test Android Chrome and the Termux-hosted ST workflow.**

Run SillyTavern from Termux using the private app/data filesystem, not shared FUSE storage. Open the extension in Android Chrome, process one large file, and confirm sequential memory use, no tab reload, no visible idle heating after opening a collapsed References view, and successful generation with selected refs.

- [ ] **Step 4: Test interrupted and offline operations.**

Disconnect during upload and during metadata save. Confirm no false success, no source deletion, and a clear retry path. Test a stale browser tab after another browser changes the collection; server-authoritative reread must win.

- [ ] **Step 5: Record limits and evidence.**

Record browser/device, source dimensions/bytes, output dimensions/bytes/MIME, elapsed time, whether orientation/transparency survived, and any reload/error. Do not claim mobile safety from desktop-only tests.

### Task 8: Run the full regression gate and deploy sequentially

**Files:**
- Modify only files listed above
- Update: `docs/superpowers/plans/2026-07-29-reference-image-optimization-plan.md` with completion notes

- [ ] **Step 1: Run all client and provider tests.**

```bash
node --test --test-concurrency=1 tests/*.test.js tests/providers/*.test.js
```

Expected: zero failures. Browser-only checks remain covered by the manual matrix.

- [ ] **Step 2: Run server tests.**

```bash
node --test --test-concurrency=1 tests/server-*.test.js tests/server-plugin/*.test.js
```

Expected: zero failures, including collection/path security and any managed-asset route tests.

- [ ] **Step 3: Copy the built extension/plugin files to the active Windows SillyTavern installation.**

Do not overwrite user data or `secrets.json`. Do not copy `node_modules`; the permanent design adds no native runtime dependency.

- [ ] **Step 4: Smoke-test Windows before Termux.**

Start only the Windows instance, verify add/replace/gallery import, reference selection in an existing chat, generation, and deletion behavior. Stop it before synchronization.

- [ ] **Step 5: Wait for Syncthing convergence, then test Termux.**

Never run both installations simultaneously against synchronized plugin data. Confirm the Termux data root remains private ext4, ignores remain in place for `node_modules`/`.stversions`, and `secrets.json` remains excluded.

- [ ] **Step 6: Verify final files and report evidence.**

Confirm no temporary migration harness remains in the extension, no original reference bytes are retained by the new upload path, and the full test/manual matrix is recorded with failures stated explicitly.

### Completion criteria

- All four reference ingestion paths share one validated optimizer.
- New images are at most 1024 px on the longest edge unless retaining an already-valid smaller source is strictly smaller.
- Only one canonical uploaded rendition is retained for newly optimized references.
- WebP is selected only after actual encoder validation; Safari/WebKit fallbacks are correct.
- EXIF orientation, alpha, invalid output, oversized input, and canvas failures have explicit behavior.
- Generation drafts and recovery state contain no full reference data URLs.
- Hidden References rendering does not loop, startup does not eagerly decode all collections, and mobile work is sequential/bounded.
- Windows and Termux workflows work with no native image dependency and sequential Syncthing handoff.
