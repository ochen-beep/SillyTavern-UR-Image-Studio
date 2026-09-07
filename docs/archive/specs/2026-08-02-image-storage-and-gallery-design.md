# Image Storage & Gallery Integration — Design

- **Date:** 2026-08-02
- **Status:** Draft, awaiting user review
- **Supersedes (partially):** `2026-07-01-ur-image-studio-v2-design.md` — sections on `galleryMode` and `copyToStGallery` (lines 183-184, 193-219, 406-424). This spec redefines both.

## 1. Problem

Generated images never reach the SillyTavern **Show Gallery** (the magic-wand / `/show-gallery` button). They only exist in the extension's own gallery. The user expects them to appear in the character's ST gallery.

### Root cause (verified)

Two compounding defects:

1. **Wrong folder.** `src/native-image-storage.js:62` hardcodes `ch_name: 'UR Image Studio'` (constant `NATIVE_IMAGE_FOLDER` at `src/native-image-path.js:3`). Show Gallery is a **directory scan** of `user/images/<character name>/` (`SillyTavern/SillyTavern`, `public/scripts/extensions/gallery/index.js`, `getGalleryFolder()` returns `extensionSettings.gallery.folders[char.avatar] ?? char.name`; server `src/endpoints/images.js:80` does `fs.readdirSync`). The extension's folder name never matches the character's, so the gallery sees nothing.

2. **Path validator hardcodes the same folder.** `canonicalizeNativeImagePath()` at `src/native-image-path.js:21-31` rejects any path whose folder segment `!== NATIVE_IMAGE_FOLDER`. So even fixing #1 alone would break: cards wouldn't validate, `reconcileCards` would splice them, `listNativeImages` scans the wrong folder.

### What was confirmed NOT the cause

`message.extra` / `appendMediaToMessage` / `saveChat` are **not** involved in Show Gallery at all. Show Gallery is purely file-system-based. The prior analysis that blamed "extension never writes to `message.extra`" was a misdiagnosis — `message.extra.media` controls **inline images in chat posts** (the SD-extension feature), which is a separate surface from Show Gallery. Source citations are in §9.

## 2. Decisions (final)

| Decision | Choice | Rationale |
|---|---|---|
| File location | `user/images/<character name>/` (match SD extension) | This is what Show Gallery scans; SD does the same (`stable-diffusion/index.js:3012-3014`, `ch_name = characters[characterId].name`) |
| Inline image in post | **No** `message.extra.media` | User explicitly does not want images in the chat feed. Show Gallery works without it. |
| Future in-post widget | DOM overlay on the post, keyed by `sourceMsgId` | Future-only; separate spec. Does not require `message.extra` — reads from the extension's card index. Existing `sourceMsgId` field is the hook. |
| Delete (extension-only, default) | Set `hidden: true` flag on card via single "delete with checkbox" UI | File stays in Show Gallery; reconcile is unaffected because the card remains in the index |
| Delete (everywhere, opt-in checkbox) | `removeCard` + `POST /api/images/delete` | File erased → disappears from both gallery extension and Show Gallery. Improves on SD, which never deletes files (orphaned-file problem). |
| Reconcile | No change to logic; `hidden` cards stay indexed | Avoids a separate "hidden paths" blacklist — the card's continued presence satisfies reconcile's existence check |
| `copyToStGallery` flag | **Remove** | Dead config (zero branches read it, verified by grep). Replaced by: file always goes to the character folder. No user-facing toggle needed. |
| `galleryMode` enum | **Remove** the `'st-only'` / `'localforage'` values; keep `'anchor'` only if a branch reads it, else remove entirely | Same family of dead config. Before removal, grep for `galleryMode === 'anchor'` / `state.settings.galleryMode` to confirm whether `'anchor'` is live; if dead, drop the whole field. |
| Migration of existing files in `user/images/UR Image Studio/` | Leave in place; optional manual migration button | YAGNI. They remain visible in the extension gallery (their cards already exist with the old path). New generations go to the character folder. |

## 3. Architecture

### 3.1 Path canonicalization — the core change

Currently `native-image-path.js` treats `NATIVE_IMAGE_FOLDER` as the **only** legal folder. This must become **any single folder segment under `user/images/`**.

**New contract for `canonicalizeNativeImagePath(value)`:**
- Accept `user/images/<folder>/<file>` where `<folder>` is any single sanitized segment (no control chars, no `/\?#`, not `.`/`..`).
- Preserve the existing security invariants: 4 parts, `user`/`images` prefix, no scheme, segment decode safety checks (existing `decodeSegment`).
- Return the canonical form `user/images/<encodedFolder>/<encodedFile>` (both segments percent-encoded).
- Reject everything else (returns `null`).

**New helper:** `canonicalizeNativeImagePathForFolder(value, folder)` — optional, for cases where a specific expected folder is known (e.g., validating that a card's path matches the current character). Keeps the strict check available where wanted.

**Removed constant:** `NATIVE_IMAGE_FOLDER` / `NATIVE_IMAGE_FOLDER_PATH` as the single source of truth. They may remain as a default fallback for the migration/legacy case, but no longer gate validation.

**Why this is necessary, not optional:** every consumer (`gallery-index.js`, `storage.js`, `tab-gallery.js`) calls `canonicalizeNativeImagePath`. If it rejects character-folder paths, the whole subsystem returns `null`/`null` paths and breaks. This is the load-bearing change.

### 3.2 Character-aware upload

`uploadGeneratedImage` / `uploadPayload` (`src/native-image-storage.js:51, 56`) accept an **optional** `ch_name` parameter that defaults to the legacy `NATIVE_IMAGE_FOLDER` for backward compatibility with existing callers:

```
uploadGeneratedImage(dataUrl, { filename, ch_name, signal, timeoutMs })
uploadPayload({ image, format }, { filename, ch_name, signal, timeoutMs })
materializeImageResult(result, { ..., ch_name })
```

- `ch_name` defaults to `NATIVE_IMAGE_FOLDER` when omitted, so existing call sites that don't pass it (`storage.js:59, 62` legacy materialization, `storage.js:102` `saveImageToFile`) keep working unchanged.
- The POST body at line 62 changes from `ch_name: NATIVE_GALLERY_FOLDER` to `ch_name: ch_name ?? NATIVE_GALLERY_FOLDER`.
- The generation pipeline (§3.4) is the one caller that always passes a real `ch_name`.

`listNativeImages({ signal, folder })` gains a `folder` argument. When omitted, behavior is unchanged (lists the legacy folder) — used by reconcile's legacy-folder pass.

### 3.3 `ch_name` resolution

`getCharacterImageFolder()` resolves the folder name, in priority order (mirrors SD at `stable-diffusion/index.js:3012-3014`):

1. Solo chat: `getContext().characters[getContext().characterId]?.name`.
2. Group chat: SD uses the group id. We adopt the same: `'group_' + getContext().groupId`. Group-generated images land in a group-scoped folder; ST has no per-group Show Gallery, so these are reachable only via the extension gallery (acceptable — see §7.3).
3. Fallback (no character, no group): `NATIVE_IMAGE_FOLDER` ('UR Image Studio'), so background/standalone generation doesn't crash.

Lives in a new helper `getCharacterImageFolder()` in `src/native-image-storage.js`, called from `image-api.js` at the materialization call site (line 98-102).

### 3.4 Generation pipeline change

`src/image-api.js:97-117`. After computing the result, before `addCard`:

```
const characterFolder = getCharacterImageFolder();
const imagePath = await materializeImageResult(result, {
    filename: `uris_${request.requestId}`,
    ch_name: characterFolder,
    signal, timeoutMs,
});
const galleryEntry = await addCard({
    ...
    provenance: { chatId: snapshot.chatId, sourceMsgId: snapshot.sourceMsgId, characterFolder },
    ...
});
```

`provenance.characterFolder` is stored so a card always knows which folder its file lives in — needed for delete (`/api/images/delete` uses the path), for the future "migrate to current character name on rename", and for reconcile to scan the right folder per card.

### 3.5 Card schema additions

`src/gallery-index.js`, `ALLOWED` array (line 9-13):

- **Add** `hidden` (boolean, default `false`). Hidden cards are excluded from `getGallery()` UI output (filter `card.hidden !== true` in the `getGallery` map at `src/storage.js:39`) but kept in the index. They still count for reconcile (file existence check passes), so the file is not resurrected.
- **Add** `provenance.characterFolder` (covered by `provenance` already being in `ALLOWED` and passed through `sanitizeMetadata`).

### 3.6 Reconcile across multiple folders

After §3.1-3.3, cards no longer all live under one folder: legacy cards keep `user/images/UR Image Studio/...`, new cards live under `user/images/<char>/...`. The current `reconcileCards()` (`src/gallery-index.js:123-143`) does a **single** `listNativeImages()` of the legacy folder — this would now mark every new character-folder card as `'missing'` and resurrect phantom cards.

New reconcile logic:

1. Collect the **set of distinct folders** referenced by card `imagePath` values (extracted from the path's 3rd segment), plus the legacy folder (always scanned, to catch orphaned files there).
2. For each folder, call `listNativeImages({ folder })` once and union the results into a single `nativePaths` set.
3. Run the existing existence-check + resurrect logic against the unioned set.

This keeps reconcile correct regardless of how many character folders are in use. The per-folder scan is bounded by the number of characters the user has generated for (typically small).

### 3.7 Delete operations

A single UI flow with one confirmation modal and an **opt-in checkbox** (rather than two separate operations):

```
deleteGalleryCard(chatId, id, { deleteFile = false })
```

- `deleteFile: false` (default) → `updateCard(id, { hidden: true })`. Card stays indexed (reconcile-safe), file untouched, image disappears only from the extension gallery. Show Gallery keeps the file.
- `deleteFile: true` → `removeCard(id)` + `POST /api/images/delete` with `{ path: <imagePath> }`. File erased → gone from both surfaces.

`POST /api/images/delete` server guard requires the path be under `user/images/` (`src/endpoints/images.js:133-157`, `isPathUnderParent`). Our paths already are.

**Multi-card safety:** when `deleteFile: true`, first check whether any **other** card shares the same `imagePath`. If so, degrade to the `hidden: true` path and warn the user ("файл используется другой записью; скрыто из расширения, файл оставлен"). This handles the rare case of path reuse.

**UI modal** (lightbox + grid delete button): single confirm with the checkbox unchecked by default — safe, reversible default; the user opts into the destructive file deletion explicitly.

**`clearGallery(chatId)` interaction** (`src/storage.js:106-110`): currently removes all of a chat's cards metadata-only. Add a parameter `clearGallery(chatId, { deleteFiles = false })`. When `deleteFiles`, also call `/api/images/delete` for each card's path (respecting multi-card safety). Default `false` preserves current behavior. The "Очистить" button can offer the same checkbox as single-card delete.

### 3.8 Lightbox actions panel

`src/ui/lightbox.js` currently renders image + prompt + nav only (view-only). Add an actions bar with buttons. To avoid duplicating the logic that already lives in `tab-gallery.js:80-196`, **extract** the action handlers into a new module `src/ui/gallery-actions.js`:

- `copyPrompt(item)`
- `saveAsReference(item)`
- `regenerate(item, root)`
- `deleteImage(item, chatId, root)` — opens a confirm modal with an **opt-in checkbox** (unchecked by default):
  - confirm (checkbox off) → `deleteGalleryCard(chatId, id, { deleteFile: false })` — hides from extension only
  - confirm (checkbox on) → `deleteGalleryCard(chatId, id, { deleteFile: true })` — also erases the file and removes from Show Gallery

Both the grid (`tab-gallery.js`) and the lightbox consume `gallery-actions.js`. This removes the existing duplication smell (handlers wired only to grid cards).

### 3.9 Removal of dead config

- `defaultSettings.copyToStGallery` (`src/core.js:184`) — remove.
- `DEFAULT_CHAT_CONFIG_ENVELOPE.config.copyToStGallery` (`src/core.js:210`) — remove.
- `DEFAULT_CHAT_CONFIG_ENVELOPE.config.galleryMode` — first grep `src/` for any read of `galleryMode` / `'anchor'`. If `'anchor'` is live somewhere, keep only `'anchor'` and drop `'st-only'`/`'localforage'`. If fully dead, remove the field entirely.
- All reads in `chat-binding.js:80, 152`, `pipeline-config.js:27, 41` — remove the corresponding `copyToStGallery` fields (and `galleryMode` if fully dead).
- UI checkbox in `tab-gallery.js:28-31, 39-46` — remove.
- Bump `schemaVersion` to 5 and write a migration in `chat-binding.js` normalize path that drops the old keys from loaded configs (so old chats don't carry dead data).

## 4. Data Flow (after generation)

```
generateImageRequest()                          [src/image-api.js]
  ├─ invokeImageProvider()                      [exists]
  ├─ getCharacterImageFolder()                  [NEW]
  ├─ materializeImageResult(result, { ch_name }) → user/images/<char>/<file>
  ├─ addCard({ ..., provenance:{ chatId, sourceMsgId, characterFolder }, hidden:false })
  └─ updatePendingBrowserRequest(...)
```

No `message.extra`, no `saveChat`, no `appendMediaToMessage`. The file's presence in the character folder is sufficient for Show Gallery.

## 5. Out of scope (explicit)

- ❌ `message.extra.media` / inline image in chat post (user declined).
- ❌ In-post collapsible widget with Stage 1/2 launch and per-post image carousel (future, separate spec).
- ❌ Automatic migration of existing `user/images/UR Image Studio/` files to character folders.
- ❌ Handling `CHARACTER_RENAMED` to move files between character folders (future; documented as known limitation §7).
- ❌ Group-chat gallery UI specifics (group folder works; gallery UX for groups is ST's domain).

## 6. Testing strategy

- **Unit** (`native-image-path.test.js`, new cases): `canonicalizeNativeImagePath` accepts arbitrary single-segment folders (`user/images/Alice/foo.png`, `user/images/Group%201/bar.png`), still rejects traversal (`..`, `./`, multi-segment, scheme, control chars). Regression: existing `'UR Image Studio'` paths still canonicalize.
- **Unit** (`gallery-index.test.js`): `hidden` flag round-trips through `sanitizeGalleryCard`; hidden cards excluded from a `getGallery`-style filter but present in `listCards`.
- **Unit** (`storage.test.js`): `deleteGalleryCard(..., { deleteFile: true })` calls `/api/images/delete` with the correct path; `deleteFile: false` only sets `hidden`; multi-card safety degrades to hide when path is shared.
- **Integration (manual):** generate an image in a 1:1 chat → confirm it appears in Show Gallery for that character. Delete with checkbox on → confirm file gone from disk and from Show Gallery. Delete with checkbox off → confirm card hidden, file still in Show Gallery, reconcile does not resurrect.
- **Regression:** existing `UR Image Studio` cards still render in the extension gallery (their paths still canonicalize under the relaxed validator).

## 7. Known limitations / future work

1. **Character rename.** If a character is renamed, their old images stay in the old folder and disappear from Show Gallery (gallery reads the new name). Future: subscribe to ST's `CHARACTER_RENAMED` event and offer to move files. Not in this spec.
2. **In-post widget.** The user's desired future feature: a collapsible, injectable lightbox in the chat post (mid-message), with per-post image carousel and Stage 1/2 launch controls. Implementation path: DOM overlay anchored to `.mes[mesid=N]`, reading cards by `sourceMsgId`. Does not touch `message.extra`. Separate spec when prioritized.
3. **Group chat gallery.** Group images save to `group_<id>/`; ST has no per-group gallery concept, so these are only reachable via the extension gallery. Acceptable.
4. **Migration of legacy folder.** Existing `user/images/UR Image Studio/` files remain only in the extension gallery. A future "migrate" command could move them by `provenance.characterFolder` once backfilled.

## 8. Files touched (summary)

- `src/native-image-path.js` — relax `canonicalizeNativeImagePath`; add folder-aware variant.
- `src/native-image-storage.js` — `ch_name` param through upload chain; `getCharacterImageFolder()`; `listNativeImages` folder arg.
- `src/image-api.js:97-117` — pass `ch_name`; store `provenance.characterFolder`.
- `src/gallery-index.js` — `hidden` in `ALLOWED`; multi-card path check helper.
- `src/storage.js` — `deleteGalleryCard(chatId, id, { deleteFile })`; filter hidden in `getGallery`; `clearGallery` `deleteFiles` option.
- `src/ui/lightbox.js` — actions bar.
- `src/ui/gallery-actions.js` — NEW, extracted action handlers.
- `src/ui/tab-gallery.js` — consume `gallery-actions.js`; remove dead `copyToStGallery` checkbox.
- `src/core.js` — remove `copyToStGallery` from defaults; trim `galleryMode` enum.
- `src/chat-binding.js`, `src/pipeline-config.js` — drop dead config fields; schema-v5 migration.

## 9. Research sources

- `SillyTavern/SillyTavern` `release` branch:
  - `public/scripts/extensions/gallery/index.js` — Show Gallery = directory scan, `getGalleryFolder()` = `folders[avatar] ?? char.name`.
  - `public/scripts/extensions/stable-diffusion/index.js:3012-3014, 4960-5000` — canonical pattern: `ch_name = characters[characterId].name`, file to char folder.
  - `src/endpoints/images.js:39-78` (`/upload`), `:80-113` (`/list`), `:133-157` (`/delete`).
  - `public/scripts/utils.js:1652` (`saveBase64AsFile`).
- Docs: https://docs.sillytavern.app/extensions/stable-diffusion/ — "view all saved images for a character (including other chats)" confirms gallery is cross-chat, i.e. folder-based not message-based.
