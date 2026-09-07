# Server Connection Cards Accordion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render server image connections as collapsible cards matching the legacy `uris-preset-card` accordion, persist collapse state in `accordionState`, and delete the local→server migration subsystem entirely.

**Architecture:** Reuse the existing card CSS (`style.css:178-195`) and `accordion-state.js` helpers instead of adding new visual primitives. `renderServerConnectionForm` gains a header/body split; the collapse toggle is a card-local binder modelled on `bindConnRows` (`src/ui/tab-api.js:668-680`) because the card CSS keys off `uris-collapsed` on the root, not `hidden` on the body. Migration removal comes first so later tasks edit an already-shrunk `renderImageConnSection`.

**Tech Stack:** ES modules, Node.js test runner, fake DOM (`tests/fake-dom.js`), SillyTavern extension settings.

**Baseline:** `node --test "tests/*.test.js"` reports 1140 tests, 1139 pass, 1 fail. The single pre-existing failure is `reports auth, transport, upstream, malformed model, and malformed endpoint failures safely` in `tests/server-openrouter-images.test.js:254` (warning text mismatch, unrelated to this plan). Do not fix it here; do not count it as a regression.

**Design:** `docs/superpowers/specs/2026-07-29-server-connection-cards-accordion-design.md`

---

### Task 1: Delete the Migration Subsystem

**Files:**
- Delete: `src/server-connection-migration.js`
- Delete: `tests/server-connection-migration.test.js`
- Modify: `index.js`
- Modify: `src/connections.js`
- Modify: `src/ui/tab-api.js`
- Modify: `style.css`
- Modify: `tests/tab-api-server-connections.test.js`
- Modify: `tests/smoke.test.js`

- [x] Delete the migration test files first so the suite stops asserting the removed behaviour: `tests/server-connection-migration.test.js` (1050 lines).
- [x] In `tests/smoke.test.js`, delete the block from `// ── Task 3 Phase 4: Server connection migration ──` (line 477) through the last migration test, stopping before `// ── Refs tab redesign v4 (Figma) smoke ──` — 7 tests total.
- [x] In `tests/tab-api-server-connections.test.js`, delete the `// ── Migration-pending card render tests ──` region (line 191) through the end of `migration-pending card shows probing state with disabled button`, including the `await import('../src/ui/tab-api.js')` destructuring of `renderMigrationPendingCard` / `migrationPendingProbes`.
- [x] In the same file, delete `migration-pending section appears when server available and migratable connections with keys exist`, `migration-pending section hidden when server is unavailable`, and `migration-pending card binding: probe fetches routes` (line 363 to end of file). Keep `available state has one primary add control…` and `unavailable state keeps guarded primary add disabled…`.
- [x] Delete `src/server-connection-migration.js`.
- [x] In `index.js`, delete the `migrateLocalConnections` function (the whole `async function migrateLocalConnections()` block, ~line 262-311) plus its call site and preceding comment at lines 100-104.
- [x] In `index.js`, delete the `./src/server-connection-migration.js` import and the `./src/server-image-api.js` import, and delete the `./src/connections.js` import line. Narrow the `./src/server-connection-state.js` import to `refreshServerConnectionState` only.
- [x] Verify no dangling references: `rg -n "migrateLocalConnections|isMigratableLocalConnection|migrateConnection|listImageConnections|getConnectionKey|probeTransientConnection|getServerConnectionState" index.js` must return nothing.
- [x] In `src/connections.js`, delete the `── Migration cleanup helpers ──` region: `LF_MIGRATION_STATE_PREFIX`, `removeLocalConnectionKey`, `removeLegacyMigratedSecret`, `removeMigratedLocalRecord`, `saveMigrationState`, `loadMigrationState`, `deleteMigrationState`.
- [x] Keep `_deleteStSecret` and `_deleteStSecretAny`: both stay reachable after the removal (`_deleteStSecretAny` calls `_deleteStSecret`, and `deleteConnection` plus the import/export paths call `_deleteStSecretAny`).
- [x] In `src/ui/tab-api.js`, delete the `../server-connection-migration.js` import and the `../server-image-api.js` import, and drop `listConnections`, `removeLocalConnectionKey`, `removeLegacyMigratedSecret`, `removeMigratedLocalRecord`, `saveMigrationState`, `loadMigrationState`, `deleteMigrationState` from the `../connections.js` import. Keep `listImageConnections`, `saveConnection`, `deleteConnection`, `getConnection`, `getConnectionKey`, `setConnectionKey`, `normalizeReferenceOptions`.
- [x] In `src/ui/tab-api.js`, delete the `── Migration-pending state ──` region: `migrationPendingProbes`, `renderMigrationPendingCard`, `buildMigrationDeps`, `bindMigrationPendingCard`.
- [x] In `renderImageConnSection`, delete the migration candidate scan (the `const allLegacy = await listConnections()` loop building `migrationPendingConns`), the `.uris-migration-pending-section` markup block, and the `for (const card of host.querySelectorAll('.uris-migration-pending'))` binding loop.
- [x] In `style.css`, delete the `/* ── Migration-pending section ── */` block through `.uris-migration-probing`, stopping before `/* ── Генерация ── */`.
- [x] Verify the codebase is clean: `rg -n "migration|Migratable|migrationPending" --glob '!docs/**' --glob '!node_modules/**' -i src index.js style.css tests` must return no functional hits.
- [x] Run `node --test --test-concurrency=1 tests/tab-api-server-connections.test.js tests/smoke.test.js tests/connections-server-facade.test.js` and confirm all pass.

### Task 2: Card Header/Body Markup

**Files:**
- Modify: `tests/tab-api-server-connections.test.js`
- Modify: `src/ui/server-connection-form.js`
- Modify: `style.css`

- [x] Add a failing test asserting `renderServerConnectionForm` for a saved connection (`{ id, name, ... }`) produces a root carrying both `uris-preset-card` and `uris-server-connection`, containing `.uris-preset-card-header` with `.uris-acc-chevron` and `.uris-server-name`, plus `.uris-preset-card-body`.
- [x] Add a failing test asserting the header shows the selected route label when a route is selected, `manualModelId` when manual entry is used, and a "роут не выбран" hint for a draft with no route.
- [x] Add a failing test asserting `.uris-server-name` lives inside the header and every other control (`.uris-server-endpoint`, `.uris-server-api-key`, `.uris-server-probe`, `.uris-server-route`, `.uris-server-save`, `.uris-server-delete`) lives inside `.uris-preset-card-body`.
- [x] Add a failing test asserting `.uris-server-unavailable` renders outside `.uris-preset-card-body`, since it appears on render rather than in response to a user action and must stay visible while collapsed.
- [x] Add a failing test asserting Probe/Save/Delete are wrapped in a single `.uris-server-actions` container.
- [x] Run `node --test --test-concurrency=1 tests/tab-api-server-connections.test.js` and confirm the new tests fail on the current flat markup.
- [x] In `renderServerConnectionForm`, add a `headerSummary(draft, routes, selectedId)` helper returning the selected route's `label || modelId`, else `draft.manualModelId`, else `'роут не выбран'`.
- [x] Restructure the returned markup: root gets `class="uris-preset-card uris-server-connection"`, then the unavailable block, then `.uris-preset-card-header` (chevron `<i class="fa-solid fa-chevron-down uris-acc-chevron">` + `.uris-server-name` input + `<span class="uris-server-route-summary">`), then `.uris-preset-card-body` wrapping endpoint, key, route, fetched, warnings, manual block and a `.uris-server-actions` row with Probe/Save/Delete.
- [x] Keep the `Name` label out of the header; the input alone is enough there. Preserve every existing class name and `disabledAttr` placement so `collectServerConnectionForm` and the existing tests keep working unchanged.
- [x] In `style.css`, replace the standalone `.uris-server-connection` box rules (padding/border/background now inherited from `.uris-preset-card`) with a `.uris-server-connection .uris-server-route-summary` rule styling the summary as dim small text, and keep `.uris-server-connection .uris-row { margin-bottom: 0; }`.
- [x] Run `node --test --test-concurrency=1 tests/tab-api-server-connections.test.js` and confirm all tests in the file pass, including the pre-existing render and probe/save tests.

### Task 3: Persistent Collapse State

**Files:**
- Modify: `tests/tab-api-server-connections.test.js`
- Modify: `src/ui/server-connection-form.js`
- Modify: `src/ui/tab-api.js`

- [x] Prerequisite: `tests/tab-api-server-connections.test.js` never populates `state.settings` (its ST stub uses `extensionSettings: {}`), so `setAccordionOpen` would silently no-op. Import `state` and `defaultSettings` from `../src/core.js` and set `state.settings = { ...defaultSettings, accordionState: {} }` in the existing `beforeEach`, following the `resetState` pattern in `tests/accordion-state.test.js:37-40`.
- [x] Add a failing test asserting a saved connection renders collapsed by default when `accordionState` has no entry for it. Assert via `classList.contains('uris-collapsed')` on the root and `classList.contains('hidden')` on the body — never via the `.hidden` DOM property, which fake-dom only sets from an explicit `hidden` attribute, not from a class.
- [x] Add a failing test asserting a draft (`draftId`, no `id`) renders expanded and writes nothing to `accordionState`.
- [x] Add a failing test asserting a header click on a saved card toggles `uris-collapsed`, toggles body visibility, and writes `api:server-conn:<id>` into `state.settings.accordionState`; a second click restores the original state.
- [x] Add a failing test asserting a click originating on `.uris-server-name` does not toggle collapse, so the name stays editable in place. Two fake-dom limits shape this test: `dispatchEvent` propagates *down* to children and there is no upward bubbling (`tests/fake-dom.js:42-47`), so `nameInput.click()` never reaches the header listener. Drive it instead with `header.dispatchEvent({ type: 'click', target: nameInput, stopPropagation: () => {} })`.
- [x] Because fake-dom `matches` cannot parse comma-separated selectors (`tests/fake-dom.js:59-63`), the guard must test each tag individually — e.g. `['input','select','textarea','button'].some(t => e.target.closest(t))` — rather than copying the single-string `closest('input,select,textarea,button')` form used by `bindHeaderToggle`. With the comma form the guard silently never matches under test.
- [x] Add a failing test asserting a stored `accordionState` entry of `true` renders that card expanded.
- [x] Run `node --test --test-concurrency=1 tests/tab-api-server-connections.test.js` and confirm the collapse tests fail.
- [x] In `renderServerConnectionForm`, read `getAccordionOpen('api:server-conn:' + draft.id, false)` for saved connections and force open for drafts; apply `uris-collapsed` on the root and `hidden` on the body accordingly.
- [x] In `bindServerConnectionForm`, add a header click handler that ignores `input,select,textarea,button` targets, flips `hidden` on `.uris-preset-card-body` and `uris-collapsed` on the card, then calls `setAccordionOpen` for saved connections only. Mutate the DOM directly rather than calling `rerender`, matching the `bindConnRows` rationale about preserving scroll position.

**Deviation from the two steps above:** the body is *not* toggled with `hidden`. `style.css:193`
already hides it via `.uris-preset-card.uris-collapsed .uris-preset-card-body { display: none; }`,
so `.uris-collapsed` on the root is the single source of truth. Driving `hidden` in parallel would
be a second, desyncable state — the legacy `bindConnRows` path does exactly that and is the reason
the two mechanisms had to be kept apart. Tests assert `classList.contains('uris-collapsed')` only.
- [x] Import `getAccordionOpen`, `setAccordionOpen`, `forgetAccordion` from `./accordion-state.js` in `src/ui/server-connection-form.js`.
- [x] In the existing `.uris-server-delete` handler, call `forgetAccordion('api:server-conn:' + draft.id)` after a successful `deleteConnection` so no orphan keys accumulate.
- [x] Add a failing-then-passing test asserting delete clears the connection's `accordionState` entry.
- [x] Run `node --test --test-concurrency=1 tests/tab-api-server-connections.test.js tests/accordion-state.test.js` and confirm all pass.

### Task 4: Acceptance Verification

**Files:**
- Verify only; no new files expected.

- [x] Run the focused regression set:

```bash
node --test --test-concurrency=1 tests/tab-api-server-connections.test.js tests/smoke.test.js tests/connections-server-facade.test.js tests/server-image-api.test.js tests/tab-api-reference-options.test.js
```

Result: `tests 74 / pass 74 / fail 0`.

- [x] Run the complete suite and compare against the recorded baseline:

```bash
node --test --test-concurrency=1 "tests/*.test.js" "tests/providers/*.test.js"
```

Result: `tests 1084 / pass 1083 / fail 1`. Baseline re-measured in a `b34a53d` worktree with the same
uncommitted `server-plugin/` + `src/server-image-api.js` changes applied: `tests 1143 / pass 1142 / fail 1`.

- [x] Confirm the only failure is the pre-existing `tests/server-openrouter-images.test.js` warning-text mismatch. Total test count will drop by roughly 40 (the deleted migration tests) — that is expected, not a regression.

Delta is −59, fully accounted for: `tests/server-connection-migration.test.js` deleted (−59),
`tests/smoke.test.js` migration block removed (−7), `tests/tab-api-server-connections.test.js`
rewritten 16 → 23 (+7). Both runs fail only on
`reports auth, transport, upstream, malformed model, and malformed endpoint failures safely`.

- [x] Confirm `rg -n "uris-migration" src style.css tests` returns nothing. Also verified for
  `uris_migration_state`, `migration-pending`, `migrationPending`, `migrateConnection` and `MigrationState`.
- [x] Report the pass/fail counts and the diff versus baseline verbatim; do not claim success without pasting the summary output.

---

## Manual step for the user (after Task 4)

The three legacy `openai`/`gemini` connection records stay in localforage and become fully invisible once the migration section is gone. Recreate them with **Добавить server image-коннект**, then clear the stale records in DevTools:

- `uris_connections` — remove entries whose `apiType` is `openai`, `gemini`, or `auto`. Leave `agnes` and `pollinations` entries alone; they are still live.
- `uris_conn_key_<id>` — remove one key per removed connection id.
- `uris_migration_state_<id>` — remove any leftovers; nothing reads this prefix after Task 1.

