# Figma Reference Folder and Connection Parity Implementation Plan

> **For implementation:** Use `superpowers:executing-plans` to execute this plan task by task with review checkpoints.

**Goal:** Close the approved Figma parity gaps without introducing per-connection reference options: make server-owned reference policy reflect the selected server route, enable folder metadata editing, align the server connection form labels and API-family control, and finish the reference-card editor/mobile polish.

**Architecture:** Keep provider capability ownership where it already lives. The Generate tab receives a small pure server-route policy resolver before its browser-provider path; server request validation remains untouched. Folder persistence gains one patch-oriented repository operation, while the References tab owns transient inline-editor state and rerenders after mutations. Form changes remain presentational because existing collection/probe code already carries `apiFamilyOverride`.

**Tech Stack:** Vanilla ES modules, localforage-backed reference storage, DOM rendering, CSS, Node built-in test runner (`node --test`).

**Constraints:**
- Preserve all existing uncommitted workspace changes.
- Do not add `referenceOptions` controls, a configurable maximum-reference control, or learned provider limits.
- Server-owned routes with unknown/null capabilities are allowed up to `MAX_REFS`; only explicitly unsupported or zero-capability routes are blocked in the UI.
- Keep the server's `MAX_REFERENCES = 16` validation unchanged.
- Do not alter legacy/browser-owned `resolveReferencePolicy` behavior.

## Task 1: Resolve server-owned reference policies in Generate

**Files:**
- Modify: `src/ui/tab-generate.js`
- Modify: `tests/tab-generate.test.js`

### Step 1: Add failing unit tests

Add direct tests beside the existing `buildReferencePanelState` coverage. The tests should exercise a pure exported helper, not `getActiveReferencePolicy()`, because the latter reaches module state and connection storage.

```js
import { MAX_REFS } from '../src/refs-library.js';

// Server routes have no browser provider registry entry. Unknown catalog data is
// intentionally usable under the library cap until the server says otherwise.
test('server-owned route with unknown reference capability uses MAX_REFS', () => {
    assert.deepEqual(resolveServerOwnedReferencePolicy({ selectedRoute: {
        capabilities: { references: 'unknown', maxReferences: null },
    } }), {
        supported: true,
        status: 'unknown',
        protocol: null,
        maxRefs: MAX_REFS,
        reason: '',
        source: 'server-route',
    });
});

test('server-owned route caps references by route and library maximum', () => {
    assert.equal(resolveServerOwnedReferencePolicy({ selectedRoute: {
        capabilities: { references: 'supported', maxReferences: 2 },
    } }).maxRefs, 2);
    assert.equal(resolveServerOwnedReferencePolicy({ selectedRoute: {
        capabilities: { references: 'supported', maxReferences: MAX_REFS + 9 },
    } }).maxRefs, MAX_REFS);
});

test('server-owned route rejects explicit unsupported and zero capabilities', () => {
    for (const capabilities of [
        { references: 'unsupported', maxReferences: null },
        { references: 'supported', maxReferences: 0 },
    ]) {
        assert.deepEqual(resolveServerOwnedReferencePolicy({ selectedRoute: { capabilities } }), {
            supported: false,
            status: 'unsupported',
            protocol: null,
            maxRefs: 0,
            reason: 'Выбранный маршрут не принимает референсы.',
            source: 'server-route',
        });
    }
});
```

Update the `tab-generate.js` import in the test to include `resolveServerOwnedReferencePolicy`. Use the existing test's import style rather than creating global mocks.

### Step 2: Run the focused test and confirm it fails

Run:

```bash
node --test tests/tab-generate.test.js
```

Expected: the new tests fail because `resolveServerOwnedReferencePolicy` is not exported yet. Record any unrelated pre-existing failures separately; do not modify them in this task.

### Step 3: Implement the smallest pure policy resolver

In `src/ui/tab-generate.js`:

1. Extend the connection import:

```js
import { getConnection, isServerOwnedConnection } from '../connections.js';
```

2. Add this exported helper near `buildReferencePanelState` or immediately before `getActiveReferencePolicy`:

```js
export function resolveServerOwnedReferencePolicy(conn) {
    const capabilities = conn?.selectedRoute?.capabilities;
    if (capabilities?.references === 'unsupported' || capabilities?.maxReferences === 0) {
        return {
            supported: false,
            status: 'unsupported',
            protocol: null,
            maxRefs: 0,
            reason: 'Выбранный маршрут не принимает референсы.',
            source: 'server-route',
        };
    }
    const routeMax = Number.isSafeInteger(capabilities?.maxReferences) && capabilities.maxReferences > 0
        ? capabilities.maxReferences
        : MAX_REFS;
    return {
        supported: true,
        status: capabilities?.references || 'unknown',
        protocol: null,
        maxRefs: Math.min(MAX_REFS, routeMax),
        reason: '',
        source: 'server-route',
    };
}
```

3. In `getActiveReferencePolicy()`, return this helper before calling `resolveApiType()` or `getImageProvider()`:

```js
if (isServerOwnedConnection(conn)) return resolveServerOwnedReferencePolicy(conn);
```

This ensures server route metadata does not go through the browser-only provider registry. Keep the legacy `resolveReferencePolicy()` code unchanged.

### Step 4: Run focused verification

Run:

```bash
node --test tests/tab-generate.test.js
```

Expected: all Generate-tab tests pass, including unknown/null, positive cap, unsupported, and zero-capability server-route cases.

### Step 5: Commit only this task's files

```bash
git add src/ui/tab-generate.js tests/tab-generate.test.js
git commit -m "fix(generate): honor server route reference capabilities"
```

## Task 2: Add patchable folder metadata storage

**Files:**
- Modify: `src/refs-library.js`
- Modify: `tests/refs-library.test.js`

### Step 1: Add failing persistence tests

Import `updateFolder` from `src/refs-library.js` in the existing test file. Add tests alongside the current create/rename/delete folder tests:

```js
test('updateFolder changes a folder name and color', async () => {
    const created = await createFolder('Characters', { color: '#4a90d9' });
    const updated = await updateFolder(created.id, { name: 'Characters v2', color: '#c94040' });
    assert.deepEqual(updated, { ...created, name: 'Characters v2', color: '#c94040' });
});

test('updateFolder preserves its color when patch omits color', async () => {
    const created = await createFolder('Characters', { color: '#7a5cc9' });
    const updated = await updateFolder(created.id, { name: 'People' });
    assert.equal(updated.color, '#7a5cc9');
});

test('updateFolder normalizes an invalid supplied color and returns null for an unknown id', async () => {
    const created = await createFolder('Characters', { color: '#4a90d9' });
    const updated = await updateFolder(created.id, { color: 'invalid-color' });
    assert.ok(FOLDER_COLOR_PALETTE.includes(updated.color));
    assert.equal(await updateFolder('missing-folder', { name: 'Nope' }), null);
});
```

Use the test suite's existing storage reset hook. Do not test deletion here again; its multi-folder membership behavior is already covered and remains unchanged.

### Step 2: Run focused test and confirm the red state

```bash
node --test tests/refs-library.test.js
```

Expected: failures identify the missing `updateFolder` export/function.

### Step 3: Implement `updateFolder` and preserve `renameFolder` compatibility

In `src/refs-library.js`, add an exported async function near `renameFolder`:

```js
export async function updateFolder(id, patch = {}) {
    const folders = await listFolders();
    const index = folders.findIndex(folder => folder.id === id);
    if (index === -1) return null;

    const current = folders[index];
    const hasColor = Object.hasOwn(patch, 'color');
    folders[index] = normalizeFolder({
        ...current,
        name: Object.hasOwn(patch, 'name') ? String(patch.name || '').trim() || 'Папка' : current.name,
        color: hasColor ? patch.color : current.color,
    }, index);
    await _setFolders(folders);
    return folders[index];
}

export function renameFolder(id, name) {
    return updateFolder(id, { name });
}
```

Use the actual local variable naming used by the existing module if it differs. The decisive behavior is that omitted `color` retains the stored color, while a supplied invalid color flows through `normalizeFolder` and receives its palette fallback.

### Step 4: Run focused verification

```bash
node --test tests/refs-library.test.js
```

Expected: the complete folder storage suite passes, including existing rename/delete behavior.

### Step 5: Commit the storage change

```bash
git add src/refs-library.js tests/refs-library.test.js
git commit -m "feat(refs): add editable folder metadata"
```

## Task 3: Render and bind the inline folder editor

**Files:**
- Modify: `src/ui/tab-references.js`
- Modify: `style.css`
- Modify: `tests/tab-references.test.js`
- Modify: `tests/refs-add-button-css.test.js`

### Step 1: Add failing UI and CSS tests

Update the References tab imports to include `updateFolder` and `FOLDER_COLOR_PALETTE`. Extend the fake-DOM tests with structural and interaction coverage compatible with `makeFakeDocument()`:

```js
test('desktop sidebar gives custom folders an edit control but not pseudo-folders', async () => {
    // Seed a custom folder, render the desktop view, then assert:
    // - exactly one `.uris-folder-edit` exists for that folder;
    // - controls for `all` and `none` do not exist;
    // - the custom folder filter button is a sibling, not an ancestor, of the edit button.
});

test('folder editor applies name and color and cancel leaves stored data unchanged', async () => {
    // Open `.uris-folder-edit`, set `.uris-folder-editor-name`, select a color
    // swatch, press `.uris-folder-editor-apply`, and assert listFolders().
    // Repeat with cancel and assert the original saved folder is unchanged.
});

test('deleting the active folder confirms, removes it, and switches filter to none', async () => {
    // Stub the existing confirm modal to return true, select the folder filter,
    // open its editor, click delete, and assert the folder is gone plus unfiled
    // references are displayed through the `none` filter.
});
```

Add CSS assertions using existing `readCss` / `ruleBodyFor` helpers:

```js
test('folder editor palette wraps and its swatches have an active state', () => {
    const css = readCss();
    assert.match(ruleBodyFor(css, '.uris-folder-editor-palette'), /flex-wrap:\s*wrap/);
    assert.match(css, /\.uris-folder-editor-swatch\.uris-folder-editor-swatch-on/);
});
```

Keep test assertions centered on selectors and persistence outcomes, rather than implementation-specific markup strings.

### Step 2: Run targeted tests and verify they fail

```bash
node --test tests/tab-references.test.js tests/refs-add-button-css.test.js
```

Expected: failure because the editor markup, bindings, and styles do not exist.

### Step 3: Add folder-editor state and sidebar markup

In `src/ui/tab-references.js`:

1. Add module state next to `_activeFolderFilter`:

```js
let _editingFolderId = null;
```

2. Change sidebar labels exactly to `Все карточки` and `Без папки`.

3. Preserve pseudo-folder rows as plain filter buttons. For every custom folder, render a row wrapper with a filter button and its sibling pencil button; never place a button inside an existing button:

```js
const editor = _editingFolderId === folder.id ? `
    <div class="uris-folder-editor" data-folder-id="${escapeHtml(folder.id)}">
        <input class="text_pole uris-folder-editor-name" value="${escapeHtml(folder.name)}" aria-label="Название папки">
        <div class="uris-folder-editor-palette" role="group" aria-label="Цвет папки">
            ${FOLDER_COLOR_PALETTE.map(color => `<button type="button" class="uris-folder-editor-swatch${color === folder.color ? ' uris-folder-editor-swatch-on' : ''}" data-color="${color}" aria-label="${color}" style="background:${color}"></button>`).join('')}
        </div>
        <div class="uris-folder-editor-actions">
            <button type="button" class="uris-folder-editor-apply" title="Сохранить" aria-label="Сохранить"><i class="fa-solid fa-check"></i></button>
            <button type="button" class="uris-folder-editor-cancel" title="Отменить" aria-label="Отменить"><i class="fa-solid fa-xmark"></i></button>
            <button type="button" class="uris-folder-editor-delete" title="Удалить папку" aria-label="Удалить папку"><i class="fa-solid fa-trash"></i></button>
        </div>
    </div>` : '';
const row = `
    <div class="uris-folder-row" data-folder-id="${escapeHtml(folder.id)}">
        <button type="button" class="uris-folder-item uris-folder-filter">${escapeHtml(folder.name)}</button>
        <button type="button" class="uris-folder-edit" title="Редактировать папку" aria-label="Редактировать папку">
            <i class="fa-solid fa-pencil"></i>
        </button>
    </div>
    ${editor}`;
```

Use the selected color from the current folder for the active swatch state. A local `selectedColor` in the binding closure is sufficient; do not add durable draft storage.

### Step 4: Bind mutations and filtering

In the sidebar binding path:

1. Edit control sets `_editingFolderId` and rerenders.
2. Palette swatches update the local selected color and its active class without committing storage.
3. Apply calls `await updateFolder(folder.id, { name: input.value, color: selectedColor })`, clears `_editingFolderId`, then calls `_renderAll(root)`.
4. Cancel only clears `_editingFolderId`, then rerenders; it must not call `updateFolder`.
5. Delete calls the existing `showConfirmModal`, then `await deleteFolder(folder.id)` only after confirmation. Clear `_editingFolderId`. If `_activeFolderFilter === folder.id`, set `_activeFolderFilter = 'none'` before `_renderAll(root)`.
6. Keep `showInputModal` as the creation flow.

Do not refactor folder deletion itself; `refs-library.js` already removes only the deleted folder id from every reference's `folders[]`.

### Step 5: Add styles scoped to the Reference sidebar

In the existing References CSS section of `style.css`, add compact styles for:

- `.uris-folder-row`: flex row, controls remain readable in the 170px sidebar.
- `.uris-folder-row .uris-folder-item`: flexible width.
- `.uris-folder-edit`: icon-sized pencil control, hidden until row hover/focus-within if that is compatible with keyboard access.
- `.uris-folder-editor`: inline full-width editor below its row.
- `.uris-folder-editor-palette`: wrapped ten-swatch layout.
- `.uris-folder-editor-swatch` and `.uris-folder-editor-swatch-on`: stable circular swatch geometry and a visible selection outline.
- `.uris-folder-editor-actions` and delete control: compact action row with danger color for deletion.

Use existing CSS variables and `var(--uris-radius)`; do not introduce a new color system or rounded section cards.

### Step 6: Run targeted verification

```bash
node --test tests/tab-references.test.js tests/refs-add-button-css.test.js
```

Expected: all existing References tests plus new edit/apply/cancel/delete/CSS tests pass.

### Step 7: Commit the UI/editor task

```bash
git add src/ui/tab-references.js style.css tests/tab-references.test.js tests/refs-add-button-css.test.js
git commit -m "feat(refs): add inline folder editor"
```

## Task 4: Align server connection form fields and localization

**Files:**
- Modify: `src/ui/server-connection-form.js`
- Modify: `src/ui/tab-api.js`
- Modify: `tests/tab-api-server-connections.test.js`

### Step 1: Add failing markup and behavior tests

Revise the first draft-render test so it expects `.uris-server-api-family` even before discovery, while `.uris-server-manual-model` remains absent:

```js
test('normal draft renders name, endpoint, key, API family and Probe before discovery', () => {
    const form = mount({ draftId: 'new-1', name: '', endpoint: '', apiKey: '' });
    assert.ok(form.querySelector('.uris-server-api-family'));
    assert.equal(form.querySelector('.uris-server-manual-model'), null);
});
```

Add assertions that the rendered Russian labels/actions are present:

```js
assert.match(form.textContent, /URL endpoint/);
assert.match(form.textContent, /Ключ/);
assert.match(form.textContent, /Тип API/);
assert.match(form.textContent, /Проверить/);
assert.equal(form.querySelector('.uris-server-name').getAttribute('placeholder'), 'Имя коннекта');
assert.equal(form.querySelector('.uris-server-name').getAttribute('aria-label'), 'Имя коннекта');
```

For successful route and manual fallback forms, assert `.uris-server-api-family` is present. Retain the current manual-model gate test; only the model field is gated.

Update the API tab add-control assertion to expect `+ Добавить коннект` rather than its English/server-specific wording.

### Step 2: Run the focused server-form tests and confirm failure

```bash
node --test tests/tab-api-server-connections.test.js
```

Expected: failures show that API family is absent outside manual mode and labels are still English.

### Step 3: Make API family always visible and localize display text

In `src/ui/server-connection-form.js`:

1. Place the API-family `.uris-row` unconditionally in the form body before route selection.
2. Retain only the manual Model ID row inside `canManual`.
3. Keep classes and option values unchanged, so `collectServerConnectionForm()`, `validateServerConnectionDraft()`, and probe calls retain their current behavior.
4. Replace visible text exactly:

| Existing | New |
| --- | --- |
| `Connection name` | `Имя коннекта` |
| `Endpoint` | `URL endpoint` |
| `API key` | `Ключ` |
| `Route` | `Модель` |
| `API family` | `Тип API` |
| `Model ID` | `ID модели` |
| `Probe` | `Проверить` |
| `Refresh` | `Обновить` |
| `Save` | `Сохранить` |
| `Delete` | `Удалить` |

Keep internal errors, server availability notices, and destructive-confirmation wording out of scope unless a changed label directly belongs to the form.

In `src/ui/tab-api.js`, change only the primary add button text to:

```js
'+ Добавить коннект'
```

Do not add References or Maximum inputs, and do not invalidate an already discovered route if the family selector changes.

### Step 4: Run focused verification

```bash
node --test tests/tab-api-server-connections.test.js
```

Expected: all server connection form/accordion tests pass with the selector present in normal, discovered, and manual states.

### Step 5: Commit the form parity task

```bash
git add src/ui/server-connection-form.js src/ui/tab-api.js tests/tab-api-server-connections.test.js
git commit -m "feat(api): align server connection card fields"
```

## Task 5: Polish reference cards, editors, and mobile search

**Files:**
- Modify: `src/ui/tab-references.js`
- Modify: `style.css`
- Modify: `tests/tab-references.test.js`
- Modify: `tests/refs-add-button-css.test.js`

### Step 1: Add failing UI tests

Add focused tests to `tests/tab-references.test.js`:

```js
test('reference editor renders an explicit save button on desktop and mobile', async () => {
    // Open a seeded reference in each renderer and assert `.uris-ed-save`.
});

test('role badges carry a role-specific class in desktop, mobile, and picker cards', async () => {
    // Seed char, npc, and user cards and assert e.g.
    // `.uris-pool-tile-role-char`, `.uris-pool-tile-role-npc`, and
    // `.uris-pool-tile-role-user` in each of the three markup paths.
});

test('mobile reference grid search filters by name and aliases', async () => {
    // Render narrow mode, enter a card alias into `.uris-mobile-refs-search`,
    // dispatch its input event, and assert matching card remains while others do not.
});
```

Add a structural assertion that `.uris-ed-replace` is inside a positioned preview wrapper in both desktop and mobile editor markup.

Add CSS checks:

```js
test('reference role badges define distinct char, npc, and user styles', () => {
    const css = readCss();
    for (const role of ['char', 'npc', 'user']) {
        assert.match(css, new RegExp(`\\.uris-pool-tile-role-${role}`));
    }
});

test('editor replacement button is positioned over its preview', () => {
    const css = readCss();
    assert.match(ruleBodyFor(css, '.uris-editor-preview-wrap'), /position:\s*relative/);
    assert.match(ruleBodyFor(css, '.uris-editor-preview-wrap .uris-ed-replace'), /position:\s*absolute/);
});
```

### Step 2: Run tests to establish the red state

```bash
node --test tests/tab-references.test.js tests/refs-add-button-css.test.js
```

Expected: new explicit-save, role-class, mobile-search, and preview-wrapper tests fail.

### Step 3: Add role-specific badge markup and styles

In all three tile renderers in `src/ui/tab-references.js` (desktop grid, mobile grid, and pool picker), derive the class only for valid role values:

```js
const role = r.role
    ? `<span class="uris-pool-tile-role uris-pool-tile-role-${escapeHtml(r.role)}">${escapeHtml(r.role)}</span>`
    : '';
```

If the renderer does not already validate roles, constrain the class to `char`, `npc`, and `user` first, while continuing to escape displayed text. This avoids arbitrary stored role strings becoming CSS-class content.

In `style.css`, retain the shared neutral badge rule and add color-specific rules based on existing role variables:

```css
.uris-pool-tile-role-char { background: var(--uris-role-char); }
.uris-pool-tile-role-npc { background: var(--uris-role-npc); }
.uris-pool-tile-role-user { background: var(--uris-role-user); }
```

Ensure text remains readable against each background; add a narrow text-shadow or foreground override only if the existing palette requires it.

### Step 4: Add editor Save and image-replacement overlay

In both `_renderEditor()` and `_renderMobileCard()`:

1. Wrap preview and replacement button:

```html
<div class="uris-editor-preview-wrap">
    <img class="uris-editor-preview" ...>
    <button class="uris-btn uris-btn-subtle uris-ed-replace" type="button">
        <i class="fa-solid fa-image"></i> Заменить картинку
    </button>
</div>
```

2. Add a visible `.uris-ed-save` button in the existing editor action area.
3. Bind `.uris-ed-save` to `await saveBasic()` and rerender or refresh the editor state after a successful save. Keep the existing `change` autosave listeners intact.

In `style.css`:

```css
.uris-editor-preview-wrap { position: relative; margin-bottom: 8px; }
.uris-editor-preview-wrap .uris-editor-preview { margin-bottom: 0; }
.uris-editor-preview-wrap .uris-ed-replace {
    position: absolute; right: 6px; bottom: 6px;
}
```

Adjust button padding/font size only as needed to keep it within the preview on narrow mobile screens.

### Step 5: Add mobile grid search

In `_renderMobileGrid(root)`, add a search input below or within the existing mobile toolbar, on the grid screen only:

```html
<div class="uris-mobile-refs-search">
    <input class="text_pole" type="search" placeholder="Поиск" aria-label="Поиск референсов">
</div>
```

Use a local query variable or module state scoped to the mobile grid. Filter the same currently selected folder results used by desktop, matching either `ref.name` or `ref.aliases` case-insensitively. Bind the input event to rerender/filter the grid without resetting the folder screen or selected card.

Add compact CSS that keeps the search full-width and does not crowd the back/title/add controls.

### Step 6: Apply the two approved wording corrections

While editing `src/ui/tab-references.js`, ensure user-visible strings use:

- `Все карточки`
- `Без папки`

Do not alter aliases, roles, or stored metadata as part of a wording-only change.

### Step 7: Run focused verification

```bash
node --test tests/tab-references.test.js tests/refs-add-button-css.test.js
```

Expected: all existing and new references UI/CSS tests pass.

### Step 8: Commit the polish task

```bash
git add src/ui/tab-references.js style.css tests/tab-references.test.js tests/refs-add-button-css.test.js
git commit -m "feat(refs): polish reference card editor"
```

## Task 6: Final regression verification and review

**Files:** No planned source changes unless a verification failure proves one is necessary.

### Step 1: Inspect the task diff

```bash
git diff --check main -- src/ui/tab-generate.js src/refs-library.js src/ui/tab-references.js src/ui/server-connection-form.js src/ui/tab-api.js style.css tests/tab-generate.test.js tests/refs-library.test.js tests/tab-references.test.js tests/tab-api-server-connections.test.js tests/refs-add-button-css.test.js
git diff --stat main
```

Expected: no whitespace errors; only files within the approved scope appear. Preserve unrelated server-plugin and workspace changes.

### Step 2: Run all relevant suites together

```bash
node --test tests/tab-generate.test.js tests/refs-library.test.js tests/tab-references.test.js tests/tab-api-server-connections.test.js tests/refs-add-button-css.test.js
```

Expected: all targeted tests pass together without order-dependent state leakage.

### Step 3: Run the full repository test command

```bash
node --test tests/*.test.js
```

Expected: full suite passes. If pre-existing failures occur, capture their exact test names/output and distinguish them from this feature's targeted suite.

### Step 4: Review against approved scope

Confirm all of the following before reporting completion:

- Generate tab recognizes server-owned connections without resolving them through `getImageProvider()`.
- Unknown/null server route capability enables up to four UI references; explicit unsupported/zero blocks them.
- `updateFolder` is exported, patch-based, and preserves a color omitted from the patch.
- Folder editor has one active editor, palette, apply/cancel/delete, confirmation, and active-filter reset to `none`.
- API family selector is always visible; only manual model input remains conditional.
- Server form labels and primary add text are localized as specified.
- No References/Maximum connection fields were added.
- Desktop/mobile/picker role badge markup is role-specific.
- Both editor variants have Save plus an image replacement overlay.
- Mobile search filters name and aliases.

### Step 5: Check repository state before final response

```bash
git status --short
git log --oneline -5
```

Expected: identify the four task commits and any pre-existing unrelated changes. Do not auto-stage, revert, or commit unrelated files.
