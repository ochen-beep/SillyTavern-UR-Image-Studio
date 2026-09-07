# Server-Only Connections and UI Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make UR Image Studio server-connection-only, persist the last selected tab and model, fix connection draft/edit behavior, remove obsolete References and Fields/legacy-template UI, and tighten the Gallery/API controls.

**Architecture:** Server-backed image connections become the only image connection contract. Their name and selected `modelRoute` remain authoritative in the server plugin; transient probe routes live in the form draft only until Save. Global UI state such as the selected tab stays in extension settings, while instruction templates remain in localforage and chat-specific active IDs remain in schema-v4 chat metadata.

**Tech Stack:** Browser ES modules, SillyTavern extension APIs, localforage, Node.js `node:test`, server plugin ES modules, CSS.

---

## Scope and File Map

**Retained boundaries**

- `src/ui/tabs.js`: tab registry, active-tab rendering, global tab persistence.
- `src/ui/server-connection-form.js`: server connection draft/card markup, probe, Save, Cancel, Delete.
- `src/ui/tab-api.js`: Text-LLM settings, active server connection selector, server card list.
- `src/connections.js`: server-only client facade over `server-image-api.js`.
- `server-plugin/src/services/connections.js`: portable server connection export/import and route identity.
- `src/prompt-templates.js`: instruction-template CRUD only.
- `src/template-runtime.js`: base/instruction Stage 1 runtime only.

**Files removed after import checks**

- `src/models.js`
- `src/ui/tab-connections.js`
- `src/providers/registry.js`
- `src/providers/pollinations.js`
- `src/providers/agnes.js`
- `src/providers/comfyui.js`
- `src/providers/a1111.js`
- `src/default-template.js`
- `src/style-resolver.js`
- `src/registry/fields.js`
- `src/registry/kinds.js`
- `src/registry/resolve.js`
- `src/parser.js`
- `src/stage1-adapter.js`
- `src/prompt-schema.js`
- `src/prompt-flatter.js`

`src/prompt-builder.js` is removed only after its still-needed `resolveSTMacros` helper is moved to `src/template-runtime.js` or a focused `src/st-macros.js`. `src/providers/openai.js`, `src/providers/gemini.js`, `src/providers/base.js`, `src/providers/reference-protocols.js`, `src/proxy.js`, reference migrations, and generation-draft migrations remain because custom Text-LLM or current data flows still use them.

### Task 1: Establish a clean test baseline

**Files:**
- Read: `tests/*.test.js`
- Read: `server-plugin/tests/*.test.js`
- Record: `tests-output.log`

- [ ] **Step 1: Run the current client test suite**

```bash
node --test tests/*.test.js
```

Expected: capture exact pass/fail totals before edits. Record unrelated failures rather than treating them as regressions.

- [ ] **Step 2: Run the current server-plugin suite**

```bash
node --test server-plugin/tests/*.test.js
```

Expected: capture exact pass/fail totals before edits.

- [ ] **Step 3: Inventory legacy dependencies before deletion**

```bash
rg -n "LF_CONNECTIONS|LF_CONN_KEY_PREFIX|legacy-v3|type.?[:=].?['\"]fields|createFieldsTemplate|getImageProvider|Pollinations|Agnes|DEFAULT_TEMPLATE_V3|stage1-adapter|prompt-flatter|registry/(fields|kinds|resolve)" src index.js tests server-plugin
```

Expected: every production and test dependency is accounted for by Tasks 4-8 before deleting a source file.

### Task 2: Persist and restore the globally active tab

**Files:**
- Modify: `src/core.js:148-182`
- Modify: `src/ui/tabs.js:1-44`
- Modify: `index.js:75-128,280-305`
- Create: `tests/tabs-persistence.test.js`

- [ ] **Step 1: Write failing tests for validation, persistence, and restoration**

Register `api`, `generate`, and `templates`. Assert that a valid stored tab is restored, a tab selection updates settings, and an unknown value falls back to Generate.

```js
test('setActiveTab persists a valid global tab selection', () => {
    state.settings = { ...defaultSettings };
    setActiveTab('templates');
    assert.equal(state.settings.activeTab, 'templates');
});

test('resolveInitialTab falls back when the stored tab is unknown', () => {
    state.settings = { ...defaultSettings, activeTab: 'removed-tab' };
    assert.equal(resolveInitialTab('generate'), 'generate');
});
```

- [ ] **Step 2: Run the focused test and verify failure**

```bash
node --test tests/tabs-persistence.test.js
```

Expected: FAIL because `activeTab`/`resolveInitialTab` do not exist and `setActiveTab` does not persist.

- [ ] **Step 3: Add guarded global persistence**

Add to `defaultSettings`:

```js
activeTab: 'generate',
```

In `tabs.js`, import `state` and `saveSettings`, validate IDs against the registry, and persist only valid selections:

```js
export function resolveInitialTab(fallback = 'generate') {
    const saved = state.settings?.activeTab;
    return registry.some(tab => tab.id === saved) ? saved : fallback;
}

export function setActiveTab(id, { persist = true } = {}) {
    const tab = registry.find(item => item.id === id);
    if (!tab) return false;
    _active = id;
    if (persist && state.settings && state.settings.activeTab !== id) {
        state.settings.activeTab = id;
        saveSettings();
    }
    renderTabs();
    const body = document.getElementById('urisBody');
    if (body) {
        body.innerHTML = '';
        body.className = 'uris-body';
        tab.render(body);
    }
    return true;
}
```

- [ ] **Step 4: Restore the selected tab at initialization/open call sites**

Replace unconditional `setActiveTab('generate')` calls in `index.js` with validated restoration. Opening a hidden panel keeps the current valid tab and restores from settings only when no active tab exists.

```js
setActiveTab(resolveInitialTab('generate'), { persist: false });
```

- [ ] **Step 5: Verify tab persistence**

```bash
node --test tests/tabs-persistence.test.js tests/ui-persistence.test.js
```

Expected: PASS; tab state is global extension state, not chat metadata.

- [ ] **Step 6: Commit the tab-state unit when running in Git**

```bash
git add src/core.js src/ui/tabs.js index.js tests/tabs-persistence.test.js
git commit -m "fix: persist active image studio tab"
```

The current workspace is not a Git repository, so execution here skips commit steps.

### Task 3: Make server connection edits explicit and durable

**Files:**
- Modify: `src/ui/server-connection-form.js:23-294`
- Modify: `src/ui/tab-api.js:285-356`
- Modify: `server-plugin/src/services/connections.js:239-342`
- Test: `tests/tab-api-server-connections.test.js`
- Test: `tests/server-connections.test.js`
- Test: `tests/server-storage.test.js`

- [ ] **Step 1: Add failing tests for edited name, route, and Cancel**

```js
test('existing card keeps edited name and selected route until Save', async () => {
    const draft = savedDraft({ catalog: { routes: [routeA, routeB] } });
    const form = mount(draft);
    bindServerConnectionForm(form, draft, { rerender: () => {} });
    form.querySelector('.uris-server-name').value = 'Renamed';
    await form.querySelector('.uris-server-name').input();
    form.querySelector('.uris-server-route').value = routeB.id;
    await form.querySelector('.uris-server-route').change();
    assert.equal(draft.name, 'Renamed');
    assert.equal(draft.modelRoute.id, routeB.id);
});

test('new draft exposes Cancel and never exposes Delete', () => {
    const form = mount({ draftId: 'draft-1' });
    assert.ok(form.querySelector('.uris-server-cancel'));
    assert.equal(form.querySelector('.uris-server-delete'), null);
});
```

Add an integration assertion that Cancel removes only the target draft and causes no POST, PUT, or localforage write.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
node --test tests/tab-api-server-connections.test.js
```

Expected: FAIL because drafts have no Cancel control/callback.

- [ ] **Step 3: Keep one mutable edit object per server card**

Make every input/select synchronization notify the owner, not only probe completion:

```js
const sync = () => {
    Object.assign(draft, collectServerConnectionForm(form, draft));
    dependencies.onDraftChanged?.(draft);
};
```

Keep `serverEdits` merged over fresh server records. Do not auto-save on every keystroke; Save remains the server transaction boundary. A section rerender, active-connection toggle, or tab switch therefore cannot replace unsaved values with a stale server snapshot.

- [ ] **Step 4: Render and bind Cancel for unsaved drafts**

```js
${existing
    ? `<button class="uris-btn uris-btn-danger uris-server-delete" type="button">Удалить</button>`
    : `<button class="uris-btn uris-btn-subtle uris-server-cancel" type="button">Отменить</button>`}
```

```js
form.querySelector('.uris-server-cancel')?.addEventListener('click', () => {
    dependencies.onCancelled?.(draft);
    rerender();
});
```

`tab-api.js` removes the exact object from `serverDrafts` in `onCancelled`. No confirmation is needed because no persisted object exists.

- [ ] **Step 5: Preserve route identity through server export/import**

Include route `id` in export and import:

```js
selectedRoute: route ? {
    id: route.id ?? null,
    modelId: route.modelId ?? null,
    apiFamily: route.apiFamily ?? null,
    source: route.source ?? null,
    confidence: route.confidence ?? null,
    capabilities: route.capabilities ?? null,
} : null,
```

Set `modelRouteId: route?.id ?? null` and compare route IDs in metadata equality. This fixes the existing mismatch where import stored a model ID in a route-ID field.

- [ ] **Step 6: Verify durable name/model contracts**

```bash
node --test tests/tab-api-server-connections.test.js tests/server-connections.test.js tests/server-storage.test.js
```

Expected: PASS, including fresh-render tests that recover saved name and model.

- [ ] **Step 7: Commit when running in Git**

```bash
git add src/ui/server-connection-form.js src/ui/tab-api.js server-plugin/src/services/connections.js tests/tab-api-server-connections.test.js tests/server-connections.test.js tests/server-storage.test.js
git commit -m "fix: preserve server connection edits and model route"
```

### Task 4: Remove browser/legacy image connections and migrations

**Files:**
- Modify: `src/connections.js`
- Modify: `src/image-api.js`
- Modify: `src/reference-policy.js`
- Modify: `src/ui/tab-api.js`
- Modify: `src/ui/tab-generate.js`
- Modify: `src/core.js`
- Modify: `src/data-port.js`
- Delete: browser image files listed in the file map
- Test: `tests/connections-server-facade.test.js`
- Test: `tests/image-api-server.test.js`
- Test: `tests/data-port.test.js`

- [ ] **Step 1: Rewrite facade tests around a server-only contract**

Assert that connection CRUD calls only server APIs. Remove expectations around `uris_connections`, `uris_conn_key_*`, Pollinations, Agnes, local browser secrets, and merging arrays.

```js
test('resolveConnection returns only the server projection', async () => {
    const resolved = await resolveConnection(SERVER_ID);
    assert.equal(resolved.conn.executionOwner, 'server');
    assert.equal(Object.hasOwn(resolved, 'apiKey'), false);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

```bash
node --test tests/connections-server-facade.test.js tests/image-api-server.test.js tests/data-port.test.js
```

Expected: FAIL while legacy branches and backup shape remain.

- [ ] **Step 3: Reduce `connections.js` to the server facade**

Retain server ownership reservation and server projection normalization:

```js
export async function listImageConnections() {
    return _listServerConnections();
}

export async function getConnection(id) {
    const connection = (await _listServerConnections()).find(item => item.id === id);
    return connection || (_reservedServerIds().has(id) ? _unavailableServerProjection(id) : null);
}

export async function resolveConnection(id) {
    const conn = await getConnection(id);
    return conn ? { conn } : null;
}
```

Delete localforage CRUD, browser keys, ST secret migration, `normalizeLegacyProjection`, provider/reference options, and browser fallback branches.

- [ ] **Step 4: Reduce image generation to server dispatch**

Remove provider registry, browser API-key, retry, compression, and browser reference policy. `generateImageRequest` resolves the server connection and calls only `generateServerOwnedImage`:

```js
const resolved = await resolveConnection(imageConnId);
if (!resolved?.conn) throw new Error('Image-коннект не найден');
return generateServerOwnedImage(
    imageConnId,
    resolved.conn,
    request,
    signal || state.abortController?.signal,
);
```

- [ ] **Step 5: Remove legacy card UI and model-fetch code**

In `tab-api.js`, render only server connections and drafts. Delete `imageConnRow`, provider/reference options, browser model controls, `bindConnRows`, and the `fetchModels` import. Delete `src/models.js` and `src/ui/tab-connections.js` after import search is clean.

- [ ] **Step 6: Remove browser reference-policy branches**

Keep `resolveServerOwnedReferencePolicy`; delete `resolveReferencePolicy`. Update `tab-generate.js` to use server policy only. Missing/unavailable active connections produce existing unsupported/no-connection UI state and never probe a browser provider.

- [ ] **Step 7: Remove connection constants and backup compatibility**

Delete `LF_CONNECTIONS`, `LF_CONN_KEY_PREFIX`, `ST_SECRET_KEY_URIS`, and browser image API types from `core.js`. Keep `LF_API_KEY` for custom Text-LLM.

Change backup output to:

```js
imageConnections: { server: [] },
secrets: { excluded: true, excludedKeys: [LF_API_KEY] },
```

Remove legacy image connection export/import, rebinding, sanitization, summaries, and compatibility branches. Keep server connection export/import, current chat metadata, instruction templates, references, and rollback.

- [ ] **Step 8: Delete browser-only providers after import verification**

```bash
rg -n "providers/(registry|pollinations|agnes|comfyui|a1111)|getImageProvider|LF_CONNECTIONS|LF_CONN_KEY_PREFIX" src index.js tests
```

Expected: no retained production imports. Delete browser provider files and browser-focused tests only after retained server behavior is covered elsewhere.

- [ ] **Step 9: Verify the server-only client and backup layer**

```bash
node --test tests/connections-server-facade.test.js tests/image-api-server.test.js tests/data-port.test.js tests/tab-api-server-connections.test.js
```

Expected: PASS with no local image connection writes and no legacy connections in exported/imported data.

- [ ] **Step 10: Commit when running in Git**

```bash
git add -A
git commit -m "refactor: remove legacy browser image connections"
```

### Task 5: Keep the server model selector stable across probe and reload

**Files:**
- Modify: `src/ui/server-connection-form.js:23-196`
- Test: `tests/tab-api-server-connections.test.js`

- [ ] **Step 1: Add failing route-selector regression tests**

```js
test('saved selected route remains selected when catalog contains other routes', () => {
    const form = mount(savedDraft({
        selectedRoute: routeB,
        catalog: { routes: [routeA, routeB], fetchedAt: FETCHED_AT },
    }));
    assert.equal(form.querySelector('.uris-server-route').value, routeB.id);
});

test('probe preserves the current model when it still exists', async () => {
    // Mount with routeB selected, return [routeA, routeB] from probe,
    // click Refresh, and assert draft.selectedRouteId remains routeB.id.
});
```

Also test that a saved selected route appears in the dropdown when a stale catalog omits it, preventing a blank selected model.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
node --test tests/tab-api-server-connections.test.js
```

Expected: probe-preservation FAILS because `applyProbeResult` always selects `routes[0]`.

- [ ] **Step 3: Normalize selectable routes in one helper**

```js
function selectableRoutes(draft) {
    const routes = routesFor(draft);
    const saved = draft.selectedRoute || draft.modelRoute;
    const all = saved?.id && !routes.some(route => route.id === saved.id)
        ? [saved, ...routes]
        : routes;
    return all.filter((route, index) =>
        all.findIndex(item => item.id === route.id) === index);
}
```

Use it for dropdown options, summary, collection, and validation.

- [ ] **Step 4: Preserve selection on probe refresh**

```js
const previousId = selectedRouteId(draft);
draft.routes = nextRoutes;
draft.selectedRouteId = nextRoutes.some(route => route.id === previousId)
    ? previousId
    : nextRoutes[0]?.id || '';
```

Changing the selector updates the draft immediately; Save sends the selected route object. A fresh page/server load reconstructs selection from server `selectedRoute` and catalog routes.

- [ ] **Step 5: Verify model persistence**

```bash
node --test tests/tab-api-server-connections.test.js tests/server-connections.test.js tests/server-catalog-store.test.js
```

Expected: PASS after probe, Save, and fresh render.

- [ ] **Step 6: Commit when running in Git**

```bash
git add src/ui/server-connection-form.js tests/tab-api-server-connections.test.js
git commit -m "fix: retain selected server image model"
```

### Task 6: Remove Fields and legacy-v3 template support

**Files:**
- Modify: `src/prompt-templates.js`
- Modify: `src/template-runtime.js`
- Modify: `src/ui/tab-templates.js`
- Modify: `src/core.js:39-40,68-71`
- Create: `src/st-macros.js`
- Delete: legacy template/parser files listed in the file map
- Test: `tests/template-runtime.test.js`
- Test: `tests/tab-templates.test.js`

- [ ] **Step 1: Rewrite tests for instruction-only behavior**

```js
test('classifyTemplate supports only base and instruction', () => {
    assert.equal(classifyTemplate(null), 'base');
    assert.equal(classifyTemplate({ type: 'instruction', instruction: 'x' }), 'instruction');
    assert.throws(() => classifyTemplate({ type: 'fields', fields: [] }), /Unsupported template format/);
    assert.throws(() => classifyTemplate({ content: { schemaVersion: 3 } }), /Unsupported template format/);
});

test('templates create actions expose only Instruction', () => {
    const html = renderTemplateCreateActions(false);
    assert.match(html, /data-create-type="instruction"/);
    assert.doesNotMatch(html, /fields|legacy-v3|copy-legacy/i);
});
```

Experimental “Из описания” tests assert accepted JSON is exactly `{name, instruction}` and never Fields.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
node --test tests/template-runtime.test.js tests/tab-templates.test.js
```

Expected: FAIL because Fields/legacy-v3 are still supported and rendered.

- [ ] **Step 3: Make CRUD instruction-only**

Remove v3 creation/defaults, Fields creation/validation, copying, and aliases:

```js
export function classifyTemplate(template) {
    if (template == null) return 'base';
    if (template.type === 'instruction') return 'instruction';
    throw new Error('Unsupported template format');
}
```

`listTemplates()` returns only instruction records, logging and ignoring unsupported stored records so one old record cannot crash the tab. No migration or conversion runs.

- [ ] **Step 4: Extract the retained ST macro helper**

Create `src/st-macros.js` using the exact existing substitution/fallback behavior from `prompt-builder.js`:

```js
export function resolveSTMacros(text) {
    const value = String(text || '');
    try {
        return SillyTavern.getContext().substituteParams?.(value) ?? value;
    } catch {
        return value;
    }
}
```

Retain macro regression tests before deleting `prompt-builder.js`.

- [ ] **Step 5: Reduce Stage 1 runtime to base/instruction**

Remove Fields JSON assembly/parsing and legacy adapter branches. Results always use plain prompt text and `structuredDraft: null`:

```js
const prompt = sanitizePrompt(String(raw || ''));
return {
    prompt,
    templateId: template?.id || null,
    templateType,
    structuredDraft: null,
    sourceMsgId: snapshot.msgId,
    contextRevision: snapshot.contextRevision,
    raw: String(raw || ''),
};
```

Update `TemplateType` documentation to `'base'|'instruction'`.

- [ ] **Step 6: Reduce Templates UI to instruction cards**

Delete Fields and legacy markup, handlers, constants, registry imports, `legacyContents`, and advanced accordion cleanup. Keep instruction create/edit/activate/delete. Experimental generation requests and validates only:

```json
{ "name": "...", "instruction": "..." }
```

Persist the generated instruction rather than creating an empty template and discarding it.

- [ ] **Step 7: Delete orphaned legacy modules and suites**

```bash
rg -n "default-template|prompt-builder|style-resolver|registry/(fields|kinds|resolve)|parser.js|stage1-adapter|prompt-schema|prompt-flatter" src index.js tests
```

Expected: only files/suites scheduled for deletion remain. Delete them. Do not delete current generation-draft or reference migrations.

- [ ] **Step 8: Verify instruction-only runtime/UI**

```bash
node --test tests/template-runtime.test.js tests/tab-templates.test.js tests/ui-persistence.test.js tests/pipeline-scene-first.test.js
```

Expected: PASS; base generation and instruction templates work, Fields/v3 records are neither created nor rendered.

- [ ] **Step 9: Commit when running in Git**

```bash
git add -A
git commit -m "refactor: remove fields and legacy prompt templates"
```

### Task 7: Remove the References shortcut and prevent generation tab jumps

**Files:**
- Modify: `src/ui/tab-generate.js:1-20,330-338,930-938`
- Modify: `index.js:131-180`
- Test: `tests/tab-generate.test.js`
- Test: `tests/events.test.js`
- Test: `tests/tabs-persistence.test.js`

- [ ] **Step 1: Add failing DOM and event-flow tests**

```js
test('generate tab does not render a references edit shortcut', async () => {
    await render(root);
    assert.equal(root.querySelector('#urisRefsEdit'), null);
});

test('stage completion does not change the active tab', async () => {
    setActiveTab('api');
    await dispatchSuccessfulStage1AndStage2();
    assert.equal(getActiveTab(), 'api');
});
```

Cover Stage1-only, full pipeline, auto-after Stage2, panel close/reopen, and initialization restoration.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
node --test tests/tab-generate.test.js tests/events.test.js tests/tabs-persistence.test.js
```

Expected: FAIL because `#urisRefsEdit` exists and startup/open paths currently force Generate.

- [ ] **Step 3: Remove the shortcut completely**

Delete `#urisRefsEdit`, `bindRefsStatus`, its call site, and the now-unused `setActiveTab` import. Keep the reference preview, whitelist, and dedicated References tab unchanged.

- [ ] **Step 4: Guard refreshes without switching tabs**

Generation completion may call `refreshActive()` only when the currently active tab needs refreshed data. It must never call `setActiveTab()`.

```js
if (isPanelVisible() && getActiveTab() === 'gallery') refreshActive();
```

For Stage1 data, retain the existing Generate-only guard. Confirm no unconditional `setActiveTab('generate')` remains outside validated fallback restoration.

- [ ] **Step 5: Verify stability through generation**

```bash
node --test tests/tab-generate.test.js tests/events.test.js tests/tabs-persistence.test.js
```

Expected: PASS; API/Templates remain selected through generation, close/open, and reload-shaped initialization.

- [ ] **Step 6: Commit when running in Git**

```bash
git add src/ui/tab-generate.js index.js tests/tab-generate.test.js tests/events.test.js tests/tabs-persistence.test.js
git commit -m "fix: preserve user-selected tab during generation"
```

### Task 8: Tighten Gallery and Add Connection controls

**Files:**
- Modify: `src/ui/tab-api.js:317-325`
- Modify: `src/ui/tab-gallery.js:20-49`
- Modify: `style.css`
- Test: `tests/tab-api-server-connections.test.js`
- Create: `tests/tab-gallery-layout.test.js`

- [ ] **Step 1: Add failing markup/CSS tests**

```js
assert.equal(host.querySelector('#urisAddImageConn').textContent.trim(), 'Добавить коннект');
assert.equal(host.querySelector('#urisAddImageConn').querySelectorAll('.fa-plus').length, 1);
assert.match(galleryMarkup, /id="urisGalleryClear"[^>]*uris-gallery-clear/);
assert.match(css, /\.uris-gallery-clear\s*\{[^}]*margin-left:\s*auto/);
```

- [ ] **Step 2: Run focused tests and verify failure**

```bash
node --test tests/tab-api-server-connections.test.js tests/tab-gallery-layout.test.js
```

Expected: FAIL because Add has a literal plus and Clear has no compact/alignment class.

- [ ] **Step 3: Fix Add button markup**

```html
<button class="uris-btn uris-btn-outline uris-add-btn" id="urisAddImageConn" type="button">
    <i class="fa-solid fa-plus"></i> Добавить коннект
</button>
```

- [ ] **Step 4: Make Gallery Clear compact and right-aligned**

Add `uris-gallery-clear` to the button and CSS:

```css
.uris-gallery-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.uris-gallery-clear {
    width: auto;
    min-width: 0;
    min-height: 32px;
    padding: 5px 9px;
    margin-left: auto;
    flex: 0 0 auto;
}
```

At narrow widths the toolbar may wrap, but the button must not stretch.

- [ ] **Step 5: Remove obsolete template CSS**

Delete `.uris-template-fields`, `.uris-field-row`, legacy-template badge/editor selectors, and `#urisTemplatesActions` rules that existed solely for removed controls. Retain shared instruction-card and generic button styles.

- [ ] **Step 6: Verify focused UI tests**

```bash
node --test tests/tab-api-server-connections.test.js tests/tab-gallery-layout.test.js tests/tab-templates.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit when running in Git**

```bash
git add src/ui/tab-api.js src/ui/tab-gallery.js style.css tests/tab-api-server-connections.test.js tests/tab-gallery-layout.test.js
git commit -m "style: tighten gallery and connection controls"
```

### Task 9: Full verification and dead-code audit

**Files:**
- Verify: all retained `src/`, `server-plugin/src/`, and `tests/`
- Update if necessary: current docs that advertise removed Fields/browser connections

- [ ] **Step 1: Run the dead-code audit**

```bash
rg -n "LF_CONNECTIONS|LF_CONN_KEY_PREFIX|legacy-v3|createFieldsTemplate|copyLegacyTemplate|uris-template-fields|urisRefsEdit|getImageProvider|Pollinations|Agnes|\+ Добавить коннект" src index.js style.css server-plugin tests
```

Expected: no runtime references. Historical design documents may retain historical text; current user-facing docs must not advertise removed behavior.

- [ ] **Step 2: Run syntax/import checks**

```bash
node --check index.js
node --check src/ui/tab-api.js
node --check src/ui/server-connection-form.js
node --check src/ui/tab-templates.js
node --check src/template-runtime.js
node --check src/connections.js
```

Expected: all commands exit 0.

- [ ] **Step 3: Run the complete client suite**

```bash
node --test tests/*.test.js
```

Expected: PASS. Removed suites correspond only to deliberately removed behavior; retained server/instruction/UI coverage remains.

- [ ] **Step 4: Run the complete server suite**

```bash
node --test server-plugin/tests/*.test.js
```

Expected: PASS, including server connection export/import route-ID tests.

- [ ] **Step 5: Perform browser verification against SillyTavern**

Use `http://127.0.0.1:8000/`:

1. Open API, rename a saved server connection, choose another fetched model, Save, switch tabs, reload, and confirm both values remain.
2. Create a draft and press Cancel before probe/Save; confirm no connection appears after reload.
3. Select API, close/reopen URIS, run Stage1/Stage2, and confirm API remains selected.
4. Select Templates, reload browser/server, and confirm Templates remains selected.
5. Confirm Templates offers only Instruction and unsupported Fields/v3 records are not displayed.
6. Confirm Generate has no References gear/edit shortcut.
7. Confirm Add Connection shows one plus and Gallery Clear is compact at the right edge on desktop/mobile widths.

Expected: no URIS console errors, overlap, or unexpected tab change.

- [ ] **Step 6: Inspect the final diff when running in Git**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only task-related changes.

## Self-Review Results

- Every requirement maps to a task: name/model durability (Tasks 3 and 5), model dropdown (Task 5), tab persistence and generation stability (Tasks 2 and 7), References shortcut removal (Task 7), Gallery/Add controls (Task 8), Cancel draft (Task 3), and complete Fields/legacy removal (Tasks 4 and 6).
- Legacy removal is scoped to browser image connections, Fields/legacy-v3 templates, and their compatibility/import layers. Current reference and generation-draft migrations remain intentionally.
- The selected model uses the server route identity contract (`selectedRoute.id`/`modelRouteId`), while model ID/label remain display metadata.
- No migration is introduced for unsupported Fields/v3 records; instruction-only listing ignores them without rewriting storage.
- Every deletion is gated by import search and retained-behavior tests.
