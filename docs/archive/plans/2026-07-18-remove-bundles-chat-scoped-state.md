# Remove Bundles And Scope Configuration To Chats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the global bundle/live-link model and the Profiles tab, while preserving existing behavior by storing each chat's effective generation configuration independently and lazily migrating legacy bundle bindings.

**Architecture:** Keep global libraries and extension preferences global, but introduce one versioned, self-contained configuration object in the current chat's metadata. Replace bundle application with serialized chat-config loading and patching. Keep a read-only legacy bundle lookup only for lazy migration and legacy import compatibility; do not create, mutate, select, or delete bundles during normal operation. Remove the Profiles tab registration and UI/module after all consumers are moved to chat-scoped config.

**Tech Stack:** Browser JavaScript ES modules, SillyTavern chat metadata APIs, localforage-backed storage, DOM tab UI, Node built-in test runner.

---

## Target Data Model

Use the existing `uris_binding` metadata key for compatibility, but replace the bundle pointer with a versioned record:

```js
{
    schemaVersion: 4,
    config: {
        imageProfileId: null,
        templateId: null,
        automationMode: 'manual',
        generationFlow: 'ai-only',
        characterIds: [],
        galleryMode: 'anchor',
        copyToStGallery: false
    },
    refs: {
        referenceIds: [],
        descRefs: []
    }
}
```

The exact default values must follow the existing state defaults and `migrateAutomationMode()` behavior rather than introducing new semantics. Text-provider configuration remains in the existing global extension settings unless code inspection proves that a currently visible text selector is intended to be chat-specific; do not persist inert `queueSettings` until a queue consumer exists. Message-level generation drafts continue to override the chat default template for that message.

Global records remain global resources: API/profile records, templates, characters, reference pool, secrets, extension enablement, panel state, and UI preferences. A chat stores only which resources it uses and the behavioral settings that affect that chat.

## File Map

- Modify `src/chat-binding.js`: own schema defaults, normalization, lazy legacy migration, load/save/patch helpers, and chat-local runtime projection.
- Modify `src/core.js`: remove bundle-derived runtime fields and make the new chat config the source of active selections; retain the legacy storage key only as migration input.
- Modify `index.js`: remove Profiles/bundle initialization and call chat-config loading before rendering and event registration.
- Modify `src/events.js`: serialize chat changes and publish events only after the new chat config is loaded.
- Modify `src/pipeline.js`: resolve connection/template/characters/gallery policy from a captured chat-config snapshot, not a mutable global bundle.
- Modify `src/ui/tab-api.js`: persist API/text selections into current-chat config where the control is chat-specific.
- Modify `src/ui/tab-generate.js`: persist automation and generation-flow settings into current-chat config; preserve message draft overrides.
- Modify `src/ui/tab-templates.js`: persist the active default template into current-chat config.
- Modify `src/ui/tab-gallery.js`: persist gallery-copy behavior into current-chat config.
- Modify `src/ui/refs-library.js` only if required to preserve the existing chat-local refs shape while adding `config`.
- Modify `src/data-port.js`: export/import schema-v4 chat metadata, accept legacy bundles for migration, and stop describing bundles as current user data.
- Delete or retire `src/ui/tab-profiles.js`: no Profiles tab remains after registration is removed.
- Delete or retire `src/ui/tab-content.js`: it is already unregistered and contains obsolete flat-binding logic; preserve any still-needed character UI only after explicitly rewriting it against the new config.
- Keep `src/tabs.js` generic tab navigation, but remove no generic tab behavior merely because Profiles is gone.
- Modify `style.css`: remove selectors used only by Profiles/binding cards, retain shared tab/card/accordion rules used by API, Templates, Generate, Gallery, and References.
- Modify tests: `tests/chat-binding.test.js`, `tests/settings-migration.test.js`, `tests/smoke.test.js`, `tests/data-port.test.js`, `tests/refs-library.test.js`, plus event/pipeline/pending-image tests where existing coverage supports them.
- Update `docs/changelog.md` and add a current design/migration note; leave historical bundle-era specs intact but mark the new design as superseding them.

---

### Task 1: Establish the chat-config contract and regression tests

**Files:**
- Modify: `tests/chat-binding.test.js`
- Modify: `tests/settings-migration.test.js`
- Modify: `tests/refs-library.test.js`
- Create or modify: a focused test fixture/helper only if the existing test harness needs one

- [ ] **Step 1: Add failing tests for new-chat defaults.**

Cover a chat with no `uris_binding`: loading creates no bundle, returns schema version 4, returns fixed defaults, and persists the record to that chat only. Assert that the first global bundle is not selected as a fallback.

- [ ] **Step 2: Add failing tests for valid schema-v4 loading.**

Assert that a complete `config` is normalized without changing valid IDs, arrays, modes, or reference metadata. Assert that `patchChatConfig()` changes only the requested config fields and preserves `refs`.

- [ ] **Step 3: Add failing tests for chat independence.**

Set different image profile/template/automation values for two mocked chats. Switch between them and assert that loading chat B never returns or applies chat A's values.

- [ ] **Step 4: Add failing tests for legacy migration.**

Provide a legacy `uris_bundles` record and chat metadata containing `{ bundleId, overrides, refs }`. Assert that migration maps the first template ID, image profile, characters, automation mode, gallery settings, and valid overrides into schema version 4, preserves refs, persists the migrated record, and is idempotent.

- [ ] **Step 5: Add failing tests for missing legacy bundles.**

Assert that a dangling or absent `bundleId` produces fixed defaults plus valid refs and never adopts another bundle in the global array.

- [ ] **Step 6: Run the focused tests and confirm the new assertions fail.**

Run:

```bash
node --test tests/chat-binding.test.js tests/settings-migration.test.js tests/refs-library.test.js
```

Expected: existing bundle-oriented behavior may pass, but the newly added schema-v4/default/independence assertions fail until the implementation is changed.

---

### Task 2: Implement schema-v4 loading, persistence, and lazy migration

**Files:**
- Modify: `src/chat-binding.js`
- Modify: `src/core.js`
- Modify: `src/bundles.js` or move its legacy reader into `src/chat-binding.js`
- Modify: `src/refs-library.js` if metadata normalization requires it

- [ ] **Step 1: Define one source of truth for defaults and normalization.**

Add functions with stable names and narrow responsibilities, for example:

```js
export function createDefaultChatConfig();
export function normalizeChatBinding(binding); // returns schema-v4 binding
export async function loadChatConfig();
export async function saveChatConfig(binding); // current chat only
export async function patchChatConfig(patch); // deep merge config only
```

Use defensive copies for arrays and nested objects so UI code cannot mutate persisted state accidentally.

- [ ] **Step 2: Implement the legacy reader as read-only migration code.**

Read `LF_BUNDLES` only when the current chat has a legacy `bundleId`. Map the effective legacy fields as follows:

```js
imageProfileId <- bundle.imageProfileId
 templateId <- first valid bundle.templatesIds entry
characterIds <- bundle.characterIds
automationMode <- bundle.automationMode || migrateAutomationMode(bundle.stage1Mode, bundle.stage2Mode)
galleryMode <- bundle.galleryMode
copyToStGallery <- bundle.copyToStGallery
```

Apply `overrides.imageProfileId` last. Do not select the first remaining bundle when the ID is invalid. Treat `generationFlow` as a current global/default value because the old bundle path did not reliably apply it. Do not expose or migrate inert queue settings as active behavior.

- [ ] **Step 3: Preserve references while changing the binding shape.**

Keep `refs` in the current chat metadata and normalize it through existing reference helpers. Ensure schema migration does not overwrite selected reference IDs, description-reference modes, or unrelated metadata fields.

- [ ] **Step 4: Replace bundle fallback behavior.**

Remove calls that create the `Базовый` bundle, choose array index zero, or mutate `activeBundleId`. A new or damaged chat gets fixed schema defaults only.

- [ ] **Step 5: Update runtime projection.**

Make the loaded chat config populate the runtime fields that existing UI/pipeline code still reads during transition. Remove active bundle IDs and deprecated profile fields from the canonical state once all consumers are migrated; temporary aliases must be clearly marked as compatibility-only.

- [ ] **Step 6: Run the focused tests and confirm they pass.**

Run:

```bash
node --test tests/chat-binding.test.js tests/settings-migration.test.js tests/refs-library.test.js
```

Expected: PASS, including migration idempotence and no-first-bundle fallback.

---

### Task 3: Remove Profiles from initialization and visual navigation

**Files:**
- Modify: `index.js`
- Modify: `src/ui/tabs.js` only if registry cleanup is required by the existing lifecycle
- Delete or retire: `src/ui/tab-profiles.js`
- Delete or retire: `src/ui/tab-content.js` if no character UI is reused
- Modify: `style.css`
- Modify: `tests/smoke.test.js`

- [ ] **Step 1: Add a failing smoke assertion that Profiles is absent.**

Assert that tab registration contains API, References, Generate, Gallery, and Templates only, and that no Profiles button or Profiles renderer is created. Keep the generic `#urisTabs` host if the remaining tabs still use it; remove only the Profiles concept, not the shared navigation needed by the other tabs.

- [ ] **Step 2: Remove bundle imports and registration from `index.js`.**

Remove `tab-profiles` imports, `registerTab('profiles', ...)`, bundle initialization, and the startup call that applies a bundle. Replace them with awaited `loadChatConfig()` before the first render. Update backup/help text that still calls the global bundle pool current data.

- [ ] **Step 3: Remove Profiles-only DOM and CSS.**

Delete selectors whose only consumers are `.uris-binding`, Profiles bundle cards, bundle snapshot/apply/delete controls, and binding summary elements. Retain `.uris-tab`, `.uris-tab-active`, `#urisTabs`, and shared tab styles because they belong to the remaining navigation. Retain `.uris-card-active` if Templates still uses it.

- [ ] **Step 4: Delete obsolete modules only after import search confirms no consumers.**

Run:

```bash
rg -n "tab-profiles|tab-content|bundle|Bundles|activeBundleId|uris_binding\.bundleId|persistBundleFields|applyBundle" index.js src tests
```

Do not delete `tab-content.js` if it contains a still-needed character selector; instead extract or rewrite that behavior against `chatConfig.characterIds` in a later task.

- [ ] **Step 5: Run smoke tests and inspect the rendered tab strip.**

Run:

```bash
node --test tests/smoke.test.js
```

Expected: no Profiles tab, no bundle controls, and all remaining tabs still register and render.

---

### Task 4: Move API and generation controls to current-chat config

**Files:**
- Modify: `src/ui/tab-api.js`
- Modify: `src/ui/tab-generate.js`
- Modify: `src/ui/tab-templates.js`
- Modify: `src/ui/tab-gallery.js`
- Modify: `src/core.js` if these modules currently depend on removed active-bundle fields

- [ ] **Step 1: Add failing persistence tests for each control group.**

Cover image profile selection, default template selection, automation mode, generation flow, and gallery copy behavior. For each, assert that the control calls `patchChatConfig()` and that switching chats restores the other chat's value.

- [ ] **Step 2: Replace bundle writes in `tab-api.js`.**

Change the current `persistBundleFields()` calls to chat-config patches. Preserve global API/profile libraries and credentials; only persist the selected profile ID in the current chat. Keep any truly global provider setting in extension settings.

- [ ] **Step 3: Replace bundle writes in `tab-generate.js`.**

Persist current chat automation and generation-flow settings. Keep message-level draft template selection and per-message overrides separate from the chat default. Do not restore or expose queue settings without a working queue consumer.

- [ ] **Step 4: Replace active-template writes in `tab-templates.js`.**

The active template marker and activation action must read/write `chatConfig.templateId`. Template records remain global library entries. Ensure the template card state is recalculated after chat changes.

- [ ] **Step 5: Replace gallery policy writes in `tab-gallery.js`.**

Read/write `chatConfig.copyToStGallery` and any actually-used gallery mode. Gallery contents remain keyed by chat ID as before.

- [ ] **Step 6: Run focused UI/state tests.**

Run:

```bash
node --test tests/chat-binding.test.js tests/smoke.test.js
```

Expected: all changed controls persist per chat and no test references `persistBundleFields()` as a normal runtime API.

---

### Task 5: Make chat changes and pipeline execution use isolated snapshots

**Files:**
- Modify: `src/events.js`
- Modify: `src/pipeline.js`
- Modify: `src/image-recovery.js`
- Add/modify: `tests/events.test.js`, pipeline tests, and pending-image tests

- [ ] **Step 1: Add failing tests for serialized chat switching.**

Assert that a `CHAT_CHANGED` handler waits for chat-config migration/loading before publishing the ready event or allowing automation to run. Assert that rapid switches cannot finish out of order and apply the wrong config.

- [ ] **Step 2: Add failing tests for captured pipeline config.**

Start work for chat A, switch runtime state to chat B before the asynchronous request resolves, and assert that the request still uses chat A's selected connection, template, characters, and gallery policy.

- [ ] **Step 3: Update event flow.**

Await `loadChatConfig()` on chat change, apply the config, then update navigator/UI and dispatch the chat-changed event. Use a monotonically increasing load token or serialized promise chain so stale loads cannot overwrite the current chat.

- [ ] **Step 4: Update pipeline resolution.**

Replace `getBundle()`/global bundle reads with an immutable config snapshot passed into queue items and generation functions. Resolve global resource records by IDs from that snapshot. Ensure a request created in chat A cannot observe chat B's current config.

- [ ] **Step 5: Snapshot delayed image-recovery policy.**

Pending recovery records must retain the originating chat's gallery/copy policy or config snapshot. Do not read mutable current-chat settings when delayed recovery runs.

- [ ] **Step 6: Run event, pipeline, and full test suites.**

Run:

```bash
node --test tests/events.test.js tests/*pipeline*.test.js tests/*image*.test.js
node --test tests/*.test.js
```

Expected: no cross-chat config leakage and no regressions in queue/generation behavior.

---

### Task 6: Make import/export compatible with chat-scoped configuration

**Files:**
- Modify: `src/data-port.js`
- Modify: `tests/data-port.test.js`
- Modify: `docs/changelog.md`

- [ ] **Step 1: Add failing export tests for schema-v4 metadata.**

Assert that an export contains the current chat's complete binding/config and refs, does not require the current installation's active bundle, and does not present the global bundle pool as the primary current state.

- [ ] **Step 2: Add failing import tests for schema-v4 metadata.**

Assert that importing into the matching/current chat restores config and refs, while unrelated current-chat metadata is not overwritten unless the existing import contract says so. Preserve current secret-clearing behavior for imported API connection records.

- [ ] **Step 3: Add legacy import compatibility tests.**

Provide an old backup with `uris_bundles` plus a legacy chat `bundleId`. Assert that import stores/accepts the legacy source and the next chat-config load migrates it; do not eagerly delete the legacy pool while unopened chats may still reference it.

- [ ] **Step 4: Implement version bump and summary changes.**

Bump the backup/schema version according to the existing format. Export schema-v4 chat metadata, accept legacy fields for migration, and update user-facing summary text so it describes chat configuration rather than bundle management.

- [ ] **Step 5: Run data-port tests.**

Run:

```bash
node --test tests/data-port.test.js
```

Expected: new-format round trips pass and legacy imports remain readable.

---

### Task 7: Remove dead bundle code and clean the visual surface

**Files:**
- Modify or delete: `src/bundles.js`
- Modify: `src/core.js`
- Modify: `style.css`
- Modify: `tests/settings-migration.test.js`, `tests/smoke.test.js`
- Modify: documentation files that describe bundles as current behavior

- [ ] **Step 1: Confirm all runtime bundle references are gone.**

Run:

```bash
rg -n "LF_BUNDLES|uris_bundles|bundleId|activeBundleId|createBundle|saveBundle|deleteBundle|snapshotBundle|persistBundleFields|getBundle|applyBundle|Profiles|profiles" index.js src tests docs
```

Classify each remaining match as either intentional legacy migration/import support or dead runtime code.

- [ ] **Step 2: Remove normal bundle CRUD and projection code.**

Delete bundle creation, saving, deleting, snapshotting, default-bundle selection, and runtime projection. Retain only the smallest legacy lookup/normalization path needed by lazy migration and legacy import compatibility, preferably in a clearly named migration module/function.

- [ ] **Step 3: Remove obsolete state fields.**

Delete `activeBundleId`, deprecated active profile fields, and bundle-only defaults once no consumer remains. Keep compatibility aliases only if a test demonstrates an unavoidable transition dependency, and document their removal point.

- [ ] **Step 4: Remove Profiles-only CSS and verify remaining selectors.**

Use a selector search against the remaining DOM class names. Remove unused binding/preset card styles, but preserve generic tab navigation and styles used by API, References, Generate, Gallery, and Templates. Check the UI at narrow and wide panel widths for layout gaps after the Profiles tab disappears.

- [ ] **Step 5: Update documentation and changelog.**

Add an entry explaining that configuration is now isolated per chat, old bundle bindings migrate on access, and named/shared bundles are no longer available. Mark the July bundle design as superseded without rewriting historical documents.

- [ ] **Step 6: Run static checks and the complete test suite.**

Run:

```bash
node --check index.js
node --check src/core.js src/chat-binding.js src/events.js src/pipeline.js src/data-port.js
node --check src/ui/tab-api.js src/ui/tab-generate.js src/ui/tab-gallery.js src/ui/tab-templates.js
node --test tests/*.test.js
```

Expected: all checks pass, with only intentional legacy migration/import references remaining.

---

### Task 8: Final migration and manual verification

**Files:**
- Modify only if verification exposes a defect

- [ ] **Step 1: Exercise a fresh chat.**

Open a chat with no binding, verify schema-v4 defaults are created, confirm no bundle is created, and verify the Profiles tab and bundle controls are absent.

- [ ] **Step 2: Exercise two independent chats.**

Set different API/template/automation/gallery values in chat A and chat B. Switch repeatedly and verify each chat restores its own values. Start a generation in A, switch to B while it is pending, and verify the request and delayed result retain A's configuration.

- [ ] **Step 3: Exercise legacy migration.**

Use a backup or fixture containing a legacy `bundleId`, open that chat, verify the effective settings are copied into schema-v4 metadata, then change the settings and verify no other legacy-linked chat changes.

- [ ] **Step 4: Exercise import/export.**

Export a migrated chat, clear or change its current config, import the backup, and verify config/refs restoration and expected secret handling.

- [ ] **Step 5: Review the final diff for accidental UI removal.**

Confirm that only Profiles/bundle UI disappeared; API, References, Generate, Gallery, and Templates remain reachable through `#urisTabs`, and the active-tab class still works for those remaining tabs.

- [ ] **Step 6: Record verification results.**

Report exact commands and outcomes. Do not claim completion if any test or manual check remains failing.

---

## Self-Review

- **Coverage:** The plan covers the data model, lazy migration, initialization, UI persistence, event ordering, pipeline snapshots, delayed recovery, import/export, dead-code cleanup, CSS cleanup, documentation, and tests.
- **Migration safety:** It never deletes the legacy bundle pool at startup because unopened chats may still reference it. Dangling references resolve to fixed defaults rather than another chat's configuration.
- **Isolation:** Every normal write targets the current chat metadata; shared global resource libraries remain reusable but their selected IDs are chat-local.
- **UI safety:** The generic tab host and active-tab styling remain; only Profiles registration and Profiles-specific visuals are removed.
- **Scope control:** Queue settings are intentionally excluded until a real consumer exists; this avoids preserving inert configuration under a new schema.
- **Compatibility:** Legacy metadata and old imports remain readable through lazy migration, while normal runtime code no longer depends on bundles.
