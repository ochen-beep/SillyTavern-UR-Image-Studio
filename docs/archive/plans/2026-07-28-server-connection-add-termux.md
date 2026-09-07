# Server Connection Add Flow and Standalone Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `#urisAddImageConn` create memory-only server connection drafts and make the server plugin load from a standalone SillyTavern/Termux plugin directory.

**Architecture:** Reuse the existing server draft form and Probe/Save lifecycle in `src/ui/tab-api.js`; the add action itself performs no persistence. Move UID generation inside `server-plugin/` so its service layer has no dependency on client source files.

**Tech Stack:** ES modules, Node.js 20 test runner, fake DOM, SillyTavern server plugin APIs.

---

### Task 1: Primary Server-Draft Add Action

**Files:**
- Modify: `tests/tab-api-server-connections.test.js`
- Modify: `src/ui/tab-api.js`

- [ ] Add a failing integration test that renders an available server state, clicks `#urisAddImageConn` twice, and verifies two distinct `.uris-server-connection` drafts remain rendered.
- [ ] In the same test, record localforage writes and fetch calls; verify adding drafts makes no localforage write and no `POST /connections` request.
- [ ] Add a failing unavailable-state test verifying the primary button remains visible, is disabled, creates no draft, and `.uris-add-server-conn` is absent.
- [ ] Run `node --test --test-concurrency=1 tests/tab-api-server-connections.test.js` and confirm failures describe the legacy add flow and duplicate button.
- [ ] Remove `.uris-add-server-conn` markup and handler from `src/ui/tab-api.js`.
- [ ] Render `#urisAddImageConn` as the sole server-add action, disabled unless `serverState.status === 'available'`.
- [ ] Change its handler to append `{ draftId, name: '', endpoint: '', apiKey: '', apiFamilyOverride: 'auto', timeoutMs: 300000 }` to `serverDrafts` and await the existing rerender callback.
- [ ] Guard the handler against unavailable state and remove the now-unused legacy `createConnection` import only if no other code in the module uses it.
- [ ] Run `node --test --test-concurrency=1 tests/tab-api-server-connections.test.js tests/tab-api-reference-options.test.js` and confirm both files pass.

### Task 2: Standalone Server Plugin UID

**Files:**
- Create: `server-plugin/src/id.js`
- Modify: `server-plugin/src/services/connections.js`
- Modify: `tests/server-connections.test.js`
- Modify: `tests/server-plugin-entry.test.js`

- [ ] Add a failing test that imports the plugin-local `uid`, generates a sample of distinct IDs, and verifies every ID passes server connection ID validation.
- [ ] Add a failing test that copies only `server-plugin/` and its installed dependencies to a temporary directory, imports the physical copied `index.js`, and verifies `info.id`, `init`, and `exit` without any sibling client `src/` tree.
- [ ] Run `node --test --test-concurrency=1 tests/server-connections.test.js tests/server-plugin-entry.test.js` and confirm standalone import fails at the external `src/core.js` dependency.
- [ ] Create `server-plugin/src/id.js` with a synchronous lowercase base-36 timestamp plus random suffix generator matching the accepted URIS ID format.
- [ ] Replace `../../../src/core.js` in `server-plugin/src/services/connections.js` with the plugin-local utility while preserving `createOperationId` dependency injection and import collision behavior.
- [ ] Run `rg -n "from ['\"]\.\./\.\./\.\./|src/core\.js" server-plugin` and confirm no package-escaping imports remain.
- [ ] Run `node --test --test-concurrency=1 tests/server-connections.test.js tests/server-plugin-entry.test.js tests/server-router.test.js` and confirm all pass.

### Task 3: Acceptance Verification

**Files:**
- Verify only; no new files expected.

- [ ] Run focused client/server regression tests:

```bash
node --test --test-concurrency=1 tests/tab-api-server-connections.test.js tests/tab-api-reference-options.test.js tests/connections-server-facade.test.js tests/server-connection-migration.test.js tests/server-image-api.test.js tests/server-connections.test.js tests/server-plugin-entry.test.js tests/server-router.test.js
```

- [ ] Run the complete repository suite:

```bash
node --test --test-concurrency=1 tests/*.test.js tests/providers/*.test.js
```

- [ ] Inspect `git diff` for only the approved UI flow, standalone utility, tests, spec, and plan. Confirm no Agnes/Pollinations, schema, storage, secret, SSRF, or package metadata behavior changed.
