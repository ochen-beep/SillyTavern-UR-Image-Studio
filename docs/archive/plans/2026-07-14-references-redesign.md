# References Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate references management into a single panel on the Generate tab, add text descriptions for pool items injected into Stage1 prompts, fix avatar previews, and add folder filters to the picker.

**Architecture:** Extend the existing pool/chat-binding data model (`description` field on pool items; `descRefs` array on chat binding) with a new Stage1 injection block parallel to `renderCharactersBlock`. Move all chat-scoped references controls from the References tab into a unified panel on the Generate tab, removing the per-generation Override UI entirely. All changes are backward-compatible via normalization defaults.

**Tech Stack:** Vanilla JS (ES modules), SillyTavern extension APIs, `node:test` + `node:assert/strict` for tests, Font Awesome icons, CSS (no preprocessor).

**Spec:** `docs/superpowers/specs/2026-07-14-references-redesign-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `src/refs-library.js` | Pool CRUD, chat binding, collect logic | Modify: +description field, +descRefs binding, +collectDescRefsForCurrentChat |
| `src/prompt-builder.js` | System prompt assembly | Modify: +renderRefDescriptionsBlock, +opts.refDescriptions in buildSystemPrompt |
| `src/pipeline.js` | Stage1/Stage2 orchestration | Modify: runStage1 calls collectDescRefsForCurrentChat |
| `src/ui/tab-generate.js` | Generate tab UI + bindings | Modify: rewrite refs panel, remove Override, rename chips |
| `src/ui/tab-references.js` | References tab (pool editor) | Modify: +description editor, remove chat section, +picker folder filters |
| `src/core.js` | Global state + storage keys | Modify: remove refsOverride field |
| `src/events.js` | Event handlers | Modify: remove refsOverride reset |
| `style.css` | All styling | Modify: remove override/chat CSS, add unified-panel CSS |
| `tests/refs-library.test.js` | refs-library unit tests | Modify: +descRefs tests, +collectDescRefsForCurrentChat tests |
| `tests/prompt-builder.test.js` | prompt-builder unit tests | Modify: +renderRefDescriptionsBlock tests |

---

## Task 1: Pool item `description` field

**Files:**
- Modify: `src/refs-library.js:30-61` (createRef, updateRef)
- Test: `tests/refs-library.test.js`

- [ ] **Step 1: Write failing test for description in createRef**

Add to `tests/refs-library.test.js` (after an existing createRef test group, e.g. after the pool CRUD tests around line 130). Use the same inline-import pattern as the file:

```js
test('createRef stores description field', async () => {
    const { createRef, getRef } = await import('../src/refs-library.js');
    const ref = await createRef({ name: 'Aria', imagePath: '/p/aria.webp', description: 'blue hair, scar' });
    assert.equal(ref.description, 'blue hair, scar');
    const fetched = await getRef(ref.id);
    assert.equal(fetched.description, 'blue hair, scar');
});

test('createRef defaults description to empty string', async () => {
    const { createRef, getRef } = await import('../src/refs-library.js');
    const ref = await createRef({ name: 'NoDesc', imagePath: '/p/x.webp' });
    assert.equal(ref.description, '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/refs-library.test.js`
Expected: FAIL — `ref.description` is `undefined`, assertion `assert.equal(ref.description, 'blue hair, scar')` fails.

- [ ] **Step 3: Add description to createRef**

In `src/refs-library.js`, modify `createRef` (lines 30-47). Add `description` to the item object after `keywords`:

```js
export async function createRef(data = {}) {
    const arr = await listRefs();
    const item = {
        id: uid(),
        name: String(data.name || '').trim() || 'Без названия',
        keywords: Array.isArray(data.keywords)
            ? data.keywords.map(s => String(s).trim()).filter(Boolean)
            : String(data.keywords || '').split(/[,;|]/).map(s => s.trim()).filter(Boolean),
        description: String(data.description || ''),
        imagePath: data.imagePath || '',
        folderId: data.folderId || null,
        createdAt: Date.now(),
    };
    arr.push(item);
    await _setRefs(arr);
    await refreshPoolCache();
    log('Создан референс', item.id, item.name);
    return item;
}
```

- [ ] **Step 4: Add description handling to updateRef**

In `src/refs-library.js`, modify `updateRef` (lines 49-61). Add description patch after keywords handling:

```js
export async function updateRef(id, patch) {
    const arr = await listRefs();
    const i = arr.findIndex(r => r.id === id);
    if (i === -1) return null;
    if (patch.name != null) arr[i].name = String(patch.name).trim() || 'Без названия';
    if (patch.keywords != null)
        arr[i].keywords = String(patch.keywords).split(/[,;|]/).map(s => s.trim()).filter(Boolean);
    if (patch.description != null) arr[i].description = String(patch.description);
    if (patch.imagePath != null) arr[i].imagePath = patch.imagePath;
    if (patch.folderId !== undefined) arr[i].folderId = patch.folderId || null;
    await _setRefs(arr);
    await refreshPoolCache();
    return arr[i];
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/refs-library.test.js`
Expected: PASS — all tests including new description tests.

- [ ] **Step 6: Commit**

```bash
git add src/refs-library.js tests/refs-library.test.js
git commit -m "feat(refs): add description field to pool items"
```

---

## Task 2: Chat binding `descRefs` field

**Files:**
- Modify: `src/refs-library.js:113-156` (defaultChatRefs, getChatRefs)
- Test: `tests/refs-library.test.js`

- [ ] **Step 1: Write failing tests for descRefs in getChatRefs**

Add to `tests/refs-library.test.js` (near the existing `getChatRefs` tests around line 179-226). Note: existing tests assert `defaultChatRefs()` and `getChatRefs()` shapes — these must still pass with the new field added.

```js
test('defaultChatRefs includes empty descRefs', async () => {
    const { defaultChatRefs } = await import('../src/refs-library.js');
    const d = defaultChatRefs();
    assert.deepEqual(d.descRefs, []);
});

test('getChatRefs normalizes descRefs with defaults', async () => {
    const { getChatRefs } = await import('../src/refs-library.js');
    _chatMetadata[META_KEY] = { refs: { descRefs: [{ refId: 'r1' }, { refId: 'r2', mode: 'pinned' }] } };
    const r = getChatRefs();
    assert.deepEqual(r.descRefs, [
        { refId: 'r1', mode: 'auto' },
        { refId: 'r2', mode: 'pinned' },
    ]);
});

test('getChatRefs filters invalid descRefs entries', async () => {
    const { getChatRefs } = await import('../src/refs-library.js');
    _chatMetadata[META_KEY] = { refs: { descRefs: [{ mode: 'auto' }, { refId: 'r1', mode: 'bad' }, null] } };
    const r = getChatRefs();
    // {mode:'auto'} without refId dropped; 'bad' mode → 'auto'; null dropped
    assert.deepEqual(r.descRefs, [{ refId: 'r1', mode: 'auto' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/refs-library.test.js`
Expected: FAIL — `d.descRefs` is `undefined`.

- [ ] **Step 3: Extend defaultChatRefs**

In `src/refs-library.js`, modify `defaultChatRefs` (lines 113-120):

```js
export function defaultChatRefs() {
    return {
        mode: 'smart',
        charSlot: { type: 'auto' },
        userSlot: { type: 'auto' },
        extraRefIds: [],
        descRefs: [],
    };
}
```

- [ ] **Step 4: Add descRefs normalization to getChatRefs**

In `src/refs-library.js`, modify `getChatRefs` (lines 129-139). Add a `_normalizeDescRefs` helper and call it. Place the helper right after `_normalizeSlot` (after line 144):

```js
function _normalizeDescRefs(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
        .filter(d => d && typeof d === 'object' && d.refId)
        .map(d => ({
            refId: String(d.refId),
            mode: d.mode === 'pinned' ? 'pinned' : 'auto',
        }));
}
```

Then update `getChatRefs` to include `descRefs`:

```js
export function getChatRefs() {
    const binding = _rawBinding();
    if (!binding?.refs || typeof binding.refs !== 'object') return defaultChatRefs();
    const r = binding.refs;
    return {
        mode: ['always', 'smart', 'never'].includes(r.mode) ? r.mode : 'smart',
        charSlot: _normalizeSlot(r.charSlot),
        userSlot: _normalizeSlot(r.userSlot),
        extraRefIds: Array.isArray(r.extraRefIds) ? r.extraRefIds.map(String) : [],
        descRefs: _normalizeDescRefs(r.descRefs),
    };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/refs-library.test.js`
Expected: PASS — all tests including new descRefs tests. Existing `defaultChatRefs`/`getChatRefs` shape asserts (lines 179-226) still pass because they use partial `deepEqual` on specific fields, not whole-object.

**Note:** If existing tests use `assert.deepEqual(getChatRefs(), defaultChatRefs())` on the WHOLE object (line 185-187), those now compare `descRefs: []` on both sides — still equal. Verify this by running the full file.

- [ ] **Step 6: Commit**

```bash
git add src/refs-library.js tests/refs-library.test.js
git commit -m "feat(refs): add descRefs field to chat binding"
```

---

## Task 3: collectDescRefsForCurrentChat function

**Files:**
- Modify: `src/refs-library.js` (add new export near collectRefsForCurrentChat, ~line 316-338)
- Test: `tests/refs-library.test.js`

- [ ] **Step 1: Write failing tests for collectDescRefsForCurrentChat**

Add to `tests/refs-library.test.js`. These tests need pool items with descriptions in the localforage mock (`memoryStore`) and chat binding with `descRefs`.

```js
test('collectDescRefsForCurrentChat: pinned always included', async () => {
    const { createRef, saveChatRefs, collectDescRefsForCurrentChat } = await import('../src/refs-library.js');
    const ref = await createRef({ name: 'Aria', description: 'blue hair', imagePath: '/p/a.webp' });
    saveChatRefs({ descRefs: [{ refId: ref.id, mode: 'pinned' }] });
    const result = await collectDescRefsForCurrentChat('совсем другой текст без имени');
    assert.deepEqual(result, [{ name: 'Aria', description: 'blue hair' }]);
});

test('collectDescRefsForCurrentChat: auto included only on name match', async () => {
    const { createRef, saveChatRefs, collectDescRefsForCurrentChat } = await import('../src/refs-library.js');
    const ref = await createRef({ name: 'Aria', description: 'blue hair', imagePath: '/p/a.webp' });
    saveChatRefs({ descRefs: [{ refId: ref.id, mode: 'auto' }] });
    // name mentioned
    let result = await collectDescRefsForCurrentChat('Aria вошла в комнату');
    assert.deepEqual(result, [{ name: 'Aria', description: 'blue hair' }]);
    // name NOT mentioned
    result = await collectDescRefsForCurrentChat('Боб ушёл домой');
    assert.deepEqual(result, []);
});

test('collectDescRefsForCurrentChat: auto matches keywords too', async () => {
    const { createRef, saveChatRefs, collectDescRefsForCurrentChat } = await import('../src/refs-library.js');
    const ref = await createRef({ name: 'Странник', keywords: ['Wanderer', 'бродяга'], description: 'серый плащ' });
    saveChatRefs({ descRefs: [{ refId: ref.id, mode: 'auto' }] });
    const result = await collectDescRefsForCurrentChat('Там стоял бродяга');
    assert.deepEqual(result, [{ name: 'Странник', description: 'серый плащ' }]);
});

test('collectDescRefsForCurrentChat: skips empty description', async () => {
    const { createRef, saveChatRefs, collectDescRefsForCurrentChat } = await import('../src/refs-library.js');
    const ref = await createRef({ name: 'Aria', description: '', imagePath: '/p/a.webp' });
    saveChatRefs({ descRefs: [{ refId: ref.id, mode: 'pinned' }] });
    const result = await collectDescRefsForCurrentChat('Aria here');
    assert.deepEqual(result, []);
});

test('collectDescRefsForCurrentChat: skips deleted refId', async () => {
    const { saveChatRefs, collectDescRefsForCurrentChat } = await import('../src/refs-library.js');
    saveChatRefs({ descRefs: [{ refId: 'nonexistent', mode: 'pinned' }] });
    const result = await collectDescRefsForCurrentChat('anything');
    assert.deepEqual(result, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/refs-library.test.js`
Expected: FAIL — `collectDescRefsForCurrentChat` is not exported.

- [ ] **Step 3: Implement collectDescRefsForCurrentChat**

In `src/refs-library.js`, add the new function after `previewRefsForCurrentChat` (after line 342). It uses the already-exported `isNameInText` and `getRefSync`:

```js
/**
 * Собрать текстовые описания референсов для Stage1 (построение промпта).
 * pinned — всегда; auto — только при smart-матче имени/keywords в sceneText.
 * Пропускает пустые description и несуществующие refId.
 * @param {string} sceneText
 * @returns {Promise<Array<{name: string, description: string}>>}
 */
export async function collectDescRefsForCurrentChat(sceneText = '') {
    const chatRefs = getChatRefs();
    const out = [];
    for (const entry of chatRefs.descRefs) {
        const ref = getRefSync(entry.refId);
        if (!ref) continue;
        if (!ref.description || !String(ref.description).trim()) continue;
        if (entry.mode === 'auto') {
            const haystack = [ref.name, ...(ref.keywords || [])].join(' ');
            if (!isNameInText(haystack, sceneText)) continue;
        }
        out.push({ name: ref.name, description: String(ref.description) });
    }
    return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/refs-library.test.js`
Expected: PASS — all collectDescRefsForCurrentChat tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/refs-library.js tests/refs-library.test.js
git commit -m "feat(refs): collectDescRefsForCurrentChat — Stage1 description collector"
```

---

## Task 4: renderRefDescriptionsBlock + buildSystemPrompt integration

**Files:**
- Modify: `src/prompt-builder.js:25-31` (add renderRefDescriptionsBlock), `:111-139` (buildSystemPrompt)
- Test: `tests/prompt-builder.test.js`

- [ ] **Step 1: Write failing tests for renderRefDescriptionsBlock**

Add to `tests/prompt-builder.test.js`. This file uses no ST mock — pure functions. The `ID` macro resolver is `const ID = (s) => String(s ?? '');` (line 8).

```js
test('buildSystemPrompt includes ref descriptions block when provided', () => {
    const out = buildSystemPrompt(mangaTemplate(), [], {
        macroResolver: ID,
        refDescriptions: [{ name: 'Aria', description: 'blue hair, scar' }],
    });
    assert.match(out, /Референсы сцены/);
    assert.match(out, /Aria/);
    assert.match(out, /blue hair, scar/);
});

test('buildSystemPrompt omits ref descriptions block when empty', () => {
    const out = buildSystemPrompt(mangaTemplate(), [], {
        macroResolver: ID,
        refDescriptions: [],
    });
    assert.equal(/Референсы сцены/.test(out), false);
});

test('buildSystemPrompt omits ref descriptions block when opts.refDescriptions absent', () => {
    const out = buildSystemPrompt(mangaTemplate(), [], { macroResolver: ID });
    assert.equal(/Референсы сцены/.test(out), false);
});

test('buildSystemPrompt dedupes ref descriptions against active characters', () => {
    const chars = [{ name: 'Aria', sceneName: 'Aria', role: 'user', description: 'from chars' }];
    const out = buildSystemPrompt(mangaTemplate(), chars, {
        macroResolver: ID,
        refDescriptions: [{ name: 'Aria', description: 'from refs' }],
    });
    // character block present, ref block should NOT duplicate 'Aria'
    assert.match(out, /from chars/);
    assert.equal(/from refs/.test(out), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/prompt-builder.test.js`
Expected: FAIL — no ref descriptions block in output.

- [ ] **Step 3: Add renderRefDescriptionsBlock function**

In `src/prompt-builder.js`, add the new function right after `renderCharactersBlock` (after line 31):

```js
function renderRefDescriptionsBlock(refDescriptions, activeCharacters) {
    if (!Array.isArray(refDescriptions) || !refDescriptions.length) return '';
    const usedNames = new Set(
        (activeCharacters || [])
            .map(c => (c.sceneName || c.name || '').toLowerCase())
            .filter(Boolean),
    );
    const lines = refDescriptions
        .filter(r => r && r.name && r.description && String(r.description).trim())
        .filter(r => !usedNames.has(String(r.name).toLowerCase()))
        .map(r => `- "${r.name}" (NPC): ${sanitizePrompt(r.description)}`);
    if (!lines.length) return '';
    return `\n\n=== Референсы сцены (используй ТОЧНО эту внешность, не выдумывай) ===\n${lines.join('\n')}`;
}
```

- [ ] **Step 4: Wire refDescriptions into buildSystemPrompt**

In `src/prompt-builder.js`, modify `buildSystemPrompt` (lines 111-139). Add the block render and include it in the concatenation array:

```js
export function buildSystemPrompt(template, activeCharacters = [], opts = {}) {
    const expandMacros = opts.macroResolver || resolveSTMacros;
    const kind = normalizeKind(template?.kind || 'manga');
    const preset = getKindPreset(kind);
    const rules = template?.rules || preset.rules || {};
    const hints = template?.fieldHints || {};
    const fewShot = template?.fewShot || [];

    const fields = resolveFields(template);

    const styleResult = opts.styleResult || resolveStyle(
        template?.style || { mode: 'llm-pick', catalog: preset.styleCatalog, pinned: '' },
        { override: opts.styleOverride, seed: opts.seed },
        expandMacros,
    );

    const head = `Ты — генератор промптов для изображений. Прочитай сцену из чата и составь структурированный JSON-draft для генерации одного изображения вида "${kind}".`;
    const schemaBlock = renderSchemaBlock(fields);
    const styleBlock = renderStyleBlock(styleResult);
    const rulesBlock = renderRulesBlock(rules, kind);
    const hintsBlock = renderHintsBlock(fields, hints, expandMacros);
    const fewShotBlock = renderFewShotBlock(fewShot, kind, expandMacros);
    const chars = renderCharactersBlock(activeCharacters);
    const refDescs = renderRefDescriptionsBlock(opts.refDescriptions, activeCharacters);

    return [head, schemaBlock, styleBlock, rulesBlock, hintsBlock, fewShotBlock, chars, refDescs, JSON_ONLY_TAIL]
        .filter(s => s && s.trim())
        .join('');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/prompt-builder.test.js`
Expected: PASS — all tests including new ref-descriptions tests.

- [ ] **Step 6: Commit**

```bash
git add src/prompt-builder.js tests/prompt-builder.test.js
git commit -m "feat(stage1): inject ref descriptions into system prompt"
```

---

## Task 5: Wire collectDescRefsForCurrentChat into runStage1

**Files:**
- Modify: `src/pipeline.js` (runStage1, ~lines 86-155)

- [ ] **Step 1: Read the current runStage1 and resolveActivePresets**

Read `src/pipeline.js` lines 40-155 to confirm exact variable names and where `buildSystemPrompt` is called (currently around line 120-124).

- [ ] **Step 2: Add import for collectDescRefsForCurrentChat**

In `src/pipeline.js`, find the existing import from `refs-library.js` (search for `collectRefsForCurrentChat`). Add `collectDescRefsForCurrentChat` to that import. Example if the import is:

```js
import { collectRefsForCurrentChat } from './refs-library.js';
```

Change to:

```js
import { collectRefsForCurrentChat, collectDescRefsForCurrentChat } from './refs-library.js';
```

If no such import exists, find the import block and add a new line.

- [ ] **Step 3: Call collectDescRefsForCurrentChat and pass to buildSystemPrompt**

In `src/pipeline.js` inside `runStage1`, after `resolveActivePresets()` resolves `activeChars` and before/around the `buildSystemPrompt` call, add the collection call. Locate the existing call pattern:

```js
const system = buildSystemPrompt(
    templateContent || { kind, schemaVersion: 3 },
    activeChars,
    { styleOverride: styleOverride || undefined, styleResult, macroResolver },
);
```

Change to:

```js
const sceneText = msg?.mes || '';
const refDescriptions = await collectDescRefsForCurrentChat(sceneText);
const system = buildSystemPrompt(
    templateContent || { kind, schemaVersion: 3 },
    activeChars,
    { styleOverride: styleOverride || undefined, styleResult, macroResolver, refDescriptions },
);
```

- [ ] **Step 4: Run syntax check**

Run: `node --check src/pipeline.js`
Expected: no output (success).

- [ ] **Step 5: Run full test suite to verify no regressions**

Run: `node --test tests/*.test.js`
Expected: PASS — all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline.js
git commit -m "feat(stage1): pass ref descriptions through runStage1"
```

---

## Task 6: Description field in pool-item editor

**Files:**
- Modify: `src/ui/tab-references.js:253-330` (openRefEditor)

- [ ] **Step 1: Add description textarea to the editor overlay**

In `src/ui/tab-references.js`, modify `openRefEditor` (lines 253-330). The current editor overlay HTML has rows for name, keywords, folder. Add a description row after keywords. Find the line:

```js
<div class="uris-row"><label>Keywords</label><input class="text_pole uris-ed-keywords" value="${escapeHtml(keywordsStr)}" placeholder="через запятую"></div>
```

Add after it:

```js
<div class="uris-row"><label>Описание</label><textarea class="text_pole uris-ed-desc" rows="3" placeholder="Текст для Stage1 (внешность/детали)">${escapeHtml(ref.description || '')}</textarea></div>
```

- [ ] **Step 2: Wire description save into the save handler**

In the same `openRefEditor` function, find the `save` function (around line 282-288) which currently calls `updateRef(refId, {...})`. Add `description`. Find:

```js
    const save = async () => {
        await updateRef(refId, {
            name: nameInput.value,
            keywords: kwInput.value,
            folderId: folderSel.value || null,
        });
    };
```

Change to:

```js
    const descInput = overlay.querySelector('.uris-ed-desc');
    const save = async () => {
        await updateRef(refId, {
            name: nameInput.value,
            keywords: kwInput.value,
            description: descInput.value,
            folderId: folderSel.value || null,
        });
    };
```

Add the change listener for the description field. Find the existing listeners (around line 289-291):

```js
    nameInput.addEventListener('change', save);
    kwInput.addEventListener('change', save);
    folderSel.addEventListener('change', save);
```

Add after them:

```js
    descInput.addEventListener('change', save);
```

- [ ] **Step 3: Export showPoolPicker for cross-tab use**

In `src/ui/tab-references.js`, `showPoolPicker` (line 334) is currently a private function. It needs to be importable by `tab-generate.js`. Find:

```js
async function showPoolPicker({ title = 'Выберите референсы', multi = true, excludeIds = [] } = {}) {
```

Change to:

```js
export async function showPoolPicker({ title = 'Выберите референсы', multi = true, excludeIds = [] } = {}) {
```

- [ ] **Step 4: Run syntax check**

Run: `node --check src/ui/tab-references.js`
Expected: no output (success).

- [ ] **Step 5: Commit**

```bash
git add src/ui/tab-references.js
git commit -m "feat(refs): description field in pool-item editor; export showPoolPicker"
```

---

## Task 7: Unified references panel on Generate tab — HTML structure

**Files:**
- Modify: `src/ui/tab-generate.js:54-96` (flow-config label + refs-status panel HTML)

- [ ] **Step 1: Rename the "Персонажи" label**

In `src/ui/tab-generate.js`, find line 58:

```js
<div class="uris-row"><label>Персонажи</label>
```

Change to:

```js
<div class="uris-row"><label>Чьи карточки отправим в Stage 1</label>
```

- [ ] **Step 2: Replace the #urisRefsStatus HTML with the unified panel**

In `src/ui/tab-generate.js`, replace the entire `#urisRefsStatus` block (lines 81-96). Find:

```html
            <!-- Плашка референсов: read-back + per-gen override (Phase 1) -->
            <div class="uris-refs-status" id="urisRefsStatus">
                <div class="uris-refs-status-head">
                    <span class="uris-refs-status-label">Референсы</span>
                    <span class="uris-refs-status-badge" id="urisRefsModeBadge">-</span>
                    <span class="uris-refs-profile-name" id="urisRefsProfileName"></span>
                    <label class="checkbox_label uris-override-toggle" title="Перекрыть выбор референсов на эту генерацию (не сохраняется в профиль)">
                        <input type="checkbox" id="urisRefsOverrideEnabled">
                        <span>Override</span>
                    </label>
                    <button class="menu_button uris-refs-edit" id="urisRefsEdit" title="Открыть вкладку «Референсы»"><i class="fa-solid fa-gear"></i></button>
                    <button class="menu_button uris-refs-reset" id="urisRefsReset" title="Сбросить override" style="display:none"><i class="fa-solid fa-rotate-left"></i> Сброс</button>
                </div>
                <div class="uris-refs-status-body" id="urisRefsStatusBody"></div>
                <div class="uris-refs-status-cap" id="urisRefsCap" hidden></div>
            </div>
```

Replace with:

```html
            <!-- Единая панель референсов (управление + read-back) -->
            <div class="uris-refs-panel" id="urisRefsPanel">
                <div class="uris-refs-panel-head">
                    <span class="uris-refs-status-label">Референсы</span>
                    <span class="uris-refs-status-badge" id="urisRefsModeBadge">-</span>
                    <button class="menu_button uris-refs-edit" id="urisRefsEdit" title="Открыть библиотеку референсов"><i class="fa-solid fa-gear"></i></button>
                </div>
                <div class="uris-refs-panel-slots" id="urisRefsSlots"></div>
                <div class="uris-refs-panel-chips">
                    <div class="uris-refs-panel-row">
                        <span class="uris-refs-panel-rowlabel">Картинки (Stage2):</span>
                        <div class="uris-chips" id="urisRefsExtras"></div>
                    </div>
                    <div class="uris-refs-panel-row">
                        <span class="uris-refs-panel-rowlabel">Описания (Stage1):</span>
                        <div class="uris-chips" id="urisRefsDesc"></div>
                    </div>
                </div>
                <div class="uris-refs-panel-preview" id="urisRefsPreview"></div>
                <div class="uris-refs-status-cap" id="urisRefsCap" hidden></div>
            </div>
```

- [ ] **Step 3: Run syntax check**

Run: `node --check src/ui/tab-generate.js`
Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add src/ui/tab-generate.js
git commit -m "refactor(refs): unified panel HTML structure on Generate tab"
```

---

## Task 8: Unified references panel — render + bindings (slots, extras, descRefs)

**Files:**
- Modify: `src/ui/tab-generate.js:25-26` (imports), `:527-765` (rewrite renderRefsStatus/bindRefsStatus, remove override)

This is the largest task. It replaces the old Override-based `renderRefsStatus` with a new unified panel renderer, imports the needed refs-library functions, and adds async avatar preview.

- [ ] **Step 1: Update imports**

In `src/ui/tab-generate.js`, find line 25:

```js
import { previewRefsForCurrentChat, getChatRefs, getRefSync } from '../refs-library.js';
```

Change to:

```js
import {
    previewRefsForCurrentChat, getChatRefs, saveChatRefs, getRefSync,
    getUserAvatarDataUrlForCurrent,
} from '../refs-library.js';
import { showPoolPicker } from './tab-references.js';
import { getCharacterAvatarDataUrl } from '../references.js';
```

- [ ] **Step 2: Replace renderRefsStatus with unified panel renderer**

In `src/ui/tab-generate.js`, replace the entire `renderRefsStatus` function (lines 560-649) with the new version. The new function renders: mode badge, slot rows (char/user) with async avatar previews, extras chips, descRefs chips, and a live "will be sent" preview. It also renders the mode `<select>` inline.

```js
/**
 * Рендеринг единой панели референсов: режим, слоты {{char}}/{{user}},
 * extras-чипы (картинки Stage2), descRefs-чипы (описания Stage1),
 * live-превью «уйдёт в генерацию».
 * @param {HTMLElement} root
 */
async function renderRefsStatus(root) {
    const panel = root.querySelector('#urisRefsPanel');
    if (!panel) return;
    const chatRefs = getChatRefs();

    // Mode badge + inline mode select
    const badge = root.querySelector('#urisRefsModeBadge');
    if (badge) {
        badge.innerHTML = `<select class="text_pole uris-refs-mode-select" title="Режим картинок Stage2">
            <option value="never" ${chatRefs.mode === 'never' ? 'selected' : ''}>Никогда</option>
            <option value="smart" ${chatRefs.mode === 'smart' ? 'selected' : ''}>Умный</option>
            <option value="always" ${chatRefs.mode === 'always' ? 'selected' : ''}>Всегда</option>
        </select>`;
        root.querySelector('.uris-refs-mode-select')?.addEventListener('change', (e) => {
            saveChatRefs({ mode: e.target.value });
            renderRefsStatus(root);
        });
    }

    // Slots: char/user with previews
    renderSlots(root, chatRefs);

    // Extras chips (Stage2 images)
    renderExtrasChips(root, chatRefs);

    // descRefs chips (Stage1 descriptions)
    renderDescRefsChips(root, chatRefs);

    // Live preview "will be sent"
    renderLivePreview(root);

    // Cap warning
    renderCap(root);
}

/**
 * Рендер строк слотов {{char}}/{{user}} с превью + кнопкой «Из пула».
 * @param {HTMLElement} root
 * @param {object} chatRefs
 */
function renderSlots(root, chatRefs) {
    const host = root.querySelector('#urisRefsSlots');
    if (!host) return;
    const slotRow = (slot, label, slotState) => {
        const isPinned = slotState.type === 'pinned';
        const refName = isPinned ? (getRefSync(slotState.refId)?.name || '?') : '';
        const previewId = `uris${slot}Preview`;
        return `<div class="uris-slot-row">
            <span class="uris-slot-label">${label}</span>
            <select class="text_pole uris-slot-select" data-slot="${slot}">
                <option value="auto" ${!isPinned ? 'selected' : ''}>Auto (из ST)</option>
                <option value="pinned" ${isPinned ? 'selected' : ''}>${isPinned ? escapeHtml(refName) : 'Из пула'}</option>
            </select>
            <span class="uris-slot-preview" id="${previewId}"></span>
            <button class="menu_button uris-slot-pick" data-slot="${slot}" title="Выбрать из пула"><i class="fa-solid fa-images"></i></button>
        </div>`;
    };
    host.innerHTML = slotRow('char', '{{char}}', chatRefs.charSlot) + slotRow('user', '{{user}}', chatRefs.userSlot);

    // slot select change
    host.querySelectorAll('.uris-slot-select').forEach(sel => {
        sel.addEventListener('change', async (e) => {
            const slot = e.target.dataset.slot;
            if (e.target.value === 'auto') {
                const key = slot === 'char' ? 'charSlot' : 'userSlot';
                saveChatRefs({ [key]: { type: 'auto' } });
                renderRefsStatus(root);
            }
            // 'pinned' handled by pick button
        });
    });

    // pick from pool
    host.querySelectorAll('.uris-slot-pick').forEach(btn => {
        btn.addEventListener('click', async () => {
            const slot = btn.dataset.slot;
            const refId = await showPoolPicker({ title: `Референс для {{${slot}}}`, multi: false, excludeIds: [] });
            if (!refId) return;
            const key = slot === 'char' ? 'charSlot' : 'userSlot';
            saveChatRefs({ [key]: { type: 'pinned', refId } });
            renderRefsStatus(root);
        });
    });

    // async avatar previews
    loadSlotPreview(root, 'char', chatRefs.charSlot);
    loadSlotPreview(root, 'user', chatRefs.userSlot);
}

/**
 * Асинхронная подгрузка превью слота: pinned → imagePath, auto → реальный аватар ST.
 * @param {HTMLElement} root
 * @param {'char'|'user'} slot
 * @param {object} slotState
 */
async function loadSlotPreview(root, slot, slotState) {
    const el = root.querySelector(`#uris${slot}Preview`);
    if (!el) return;
    // placeholder first
    el.innerHTML = '<span class="uris-slot-preview-empty"><i class="fa-solid fa-robot"></i></span>';
    let src = null;
    try {
        if (slotState.type === 'pinned') {
            const ref = getRefSync(slotState.refId);
            if (ref?.imagePath) src = ref.imagePath;
        } else if (slot === 'char') {
            src = await getCharacterAvatarDataUrl();
        } else {
            src = await getUserAvatarDataUrlForCurrent();
        }
    } catch { /* leave placeholder */ }
    if (src) el.innerHTML = `<img src="${escapeHtml(src)}" alt="">`;
}

/**
 * Рендер extras-чипов (картинки Stage2). Кнопка [+] открывает пикер.
 * @param {HTMLElement} root
 * @param {object} chatRefs
 */
function renderExtrasChips(root, chatRefs) {
    const host = root.querySelector('#urisRefsExtras');
    if (!host) return;
    const chips = chatRefs.extraRefIds.map(id => {
        const ref = getRefSync(id);
        if (!ref) return '';
        return `<span class="uris-extra-chip" data-ref-id="${escapeHtml(id)}" title="${escapeHtml(ref.name)}">
            <img src="${escapeHtml(ref.imagePath)}" alt="${escapeHtml(ref.name)}">
            <span class="uris-extra-name">${escapeHtml(ref.name)}</span>
            <button class="uris-extra-del" title="Убрать"><i class="fa-solid fa-xmark"></i></button>
        </span>`;
    }).join('');
    const empty = !chatRefs.extraRefIds.length ? '<small class="uris-refs-empty">нет</small>' : '';
    host.innerHTML = `<button class="menu_button uris-add-extra" title="Добавить картинки Stage2"><i class="fa-solid fa-plus"></i></button>${chips}${empty}`;

    host.querySelector('.uris-add-extra')?.addEventListener('click', async () => {
        const current = getChatRefs().extraRefIds;
        const chosen = await showPoolPicker({ title: 'Картинки Stage2', multi: true, excludeIds: current });
        if (chosen?.length) {
            saveChatRefs({ extraRefIds: [...current, ...chosen] });
            renderRefsStatus(root);
        }
    });
    host.querySelectorAll('.uris-extra-del').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const chip = btn.closest('.uris-extra-chip');
            const refId = chip?.dataset.refId;
            if (refId) {
                const current = getChatRefs().extraRefIds;
                saveChatRefs({ extraRefIds: current.filter(id => id !== refId) });
                renderRefsStatus(root);
            }
        });
    });
}

/**
 * Рендер descRefs-чипов (описания Stage1). Индикатор 📌 (pinned) / 🔄 (auto).
 * Клик по чипу toggles pinned↔auto. [x] удаляет.
 * @param {HTMLElement} root
 * @param {object} chatRefs
 */
function renderDescRefsChips(root, chatRefs) {
    const host = root.querySelector('#urisRefsDesc');
    if (!host) return;
    const chips = chatRefs.descRefs.map(entry => {
        const ref = getRefSync(entry.refId);
        if (!ref) return '';
        const icon = entry.mode === 'pinned' ? '📌' : '🔄';
        const title = entry.mode === 'pinned' ? 'Всегда (нажми для auto)' : 'Auto по упоминанию (нажми для pinned)';
        return `<span class="uris-descref-chip" data-ref-id="${escapeHtml(entry.refId)}" role="button" tabindex="0" title="${escapeHtml(title)}">
            ${icon} ${escapeHtml(ref.name)}
            <button class="uris-descref-del" title="Убрать"><i class="fa-solid fa-xmark"></i></button>
        </span>`;
    }).join('');
    const empty = !chatRefs.descRefs.length ? '<small class="uris-refs-empty">нет</small>' : '';
    host.innerHTML = `<button class="menu_button uris-add-descref" title="Добавить описание Stage1"><i class="fa-solid fa-plus"></i></button>${chips}${empty}`;

    host.querySelector('.uris-add-descref')?.addEventListener('click', async () => {
        const current = getChatRefs().descRefs.map(e => e.refId);
        const chosen = await showPoolPicker({ title: 'Описания Stage1', multi: true, excludeIds: current });
        if (chosen?.length) {
            const descRefs = [...getChatRefs().descRefs, ...chosen.map(refId => ({ refId, mode: 'auto' }))];
            saveChatRefs({ descRefs });
            renderRefsStatus(root);
        }
    });
    host.querySelectorAll('.uris-descref-chip').forEach(chip => {
        const refId = chip.dataset.refId;
        const toggleMode = () => {
            const descRefs = getChatRefs().descRefs.map(e =>
                e.refId === refId ? { ...e, mode: e.mode === 'pinned' ? 'auto' : 'pinned' } : e);
            saveChatRefs({ descRefs });
            renderRefsStatus(root);
        };
        chip.addEventListener('click', toggleMode);
        chip.querySelector('.uris-descref-del')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const descRefs = getChatRefs().descRefs.filter(e => e.refId !== refId);
            saveChatRefs({ descRefs });
            renderRefsStatus(root);
        });
    });
}

/**
 * Live-превью: какие референсы уйдут в Stage2 для текущего поста.
 * @param {HTMLElement} root
 */
function renderLivePreview(root) {
    const host = root.querySelector('#urisRefsPreview');
    if (!host) return;
    const ctx = getCtx();
    const msgId = state.currentMsgId;
    const msg = ctx.chat?.[msgId];
    const charName = ctx.name2 || ctx.characters?.[ctx.characterId]?.name || '';
    const userName = ctx.name1 || '';
    const instr = collectInstruction();
    const descriptors = previewRefsForCurrentChat({
        chatText: msg?.mes || '',
        instructionText: `${instr.prompt || ''} ${instr.style || ''}`,
        charName, userName,
    }, null);
    if (!descriptors.length) {
        host.innerHTML = '<small class="uris-refs-empty">→ референсы не отправятся</small>';
        return;
    }
    host.innerHTML = `<span class="uris-refs-empty">→ Уйдёт (${descriptors.length}/4):</span>` +
        descriptors.map(d => {
            const label = d.role === 'char' ? '{{char}}' : (d.role === 'user' ? '{{user}}' : escapeHtml(d.name || 'NPC'));
            let thumb = '';
            if (d.imagePath) {
                thumb = `<img src="${escapeHtml(d.imagePath)}" alt="${escapeHtml(d.name || '')}">`;
            } else {
                const icon = d.role === 'char' ? 'fa-user-astronaut' : 'fa-user';
                thumb = `<span class="uris-ref-chip-icon"><i class="fa-solid ${icon}"></i></span>`;
            }
            return `<div class="uris-ref-chip-preview" title="${escapeHtml(label)}">${thumb}<span class="uris-ref-role">${d.role}</span></div>`;
        }).join('');
}

/**
 * Cap warning: 4-ref limit or unsupported provider.
 * Авто-слоты (char/user) всегда занимают место, пока mode != 'never'.
 * @param {HTMLElement} root
 */
async function renderCap(root) {
    const cap = root.querySelector('#urisRefsCap');
    if (!cap) return;
    const chatRefs = getChatRefs();
    // char+user slots count toward the 4-cap regardless of pinned/auto (when mode != never)
    const baseSlots = chatRefs.mode === 'never' ? 0 : 2;
    if (baseSlots + chatRefs.extraRefIds.length > 4) {
        cap.hidden = false;
        cap.textContent = '⚠️ Лимит 4 референса. Останутся первые, остальные будут отброшены.';
        return;
    }
    // provider capability check
    const activeConnId = state.activeImageProfileId;
    if (activeConnId && chatRefs.mode !== 'never') {
        try {
            const conn = await getConnection(activeConnId);
            if (conn) {
                const apiType = conn.apiType === 'auto' ? resolveApiType(conn.endpoint, conn.model) : conn.apiType;
                const provider = apiType === 'openai' ? 'openai-like' : apiType;
                const capObj = REF_CAPABILITIES[provider];
                const strategy = capObj ? capObj.strategies.find(s => capObj.supportsStrategy(s, conn.model)) : null;
                if (!strategy) {
                    cap.hidden = false;
                    cap.textContent = `⚠️ Провайдер (${apiType} / ${conn.model || ''}) не поддерживает референсы.`;
                    return;
                }
            }
        } catch { /* ignore */ }
    }
    cap.hidden = true;
}
```

- [ ] **Step 3: Replace bindRefsStatus (remove override handlers)**

In `src/ui/tab-generate.js`, replace the entire `bindRefsStatus` function (lines 739-765). Remove all override/reset logic; keep only the Edit button:

```js
/**
 * Привязка обработчиков верхней части панели референсов (render-time).
 * @param {HTMLElement} root
 */
function bindRefsStatus(root) {
    root.querySelector('#urisRefsEdit')?.addEventListener('click', () => {
        setActiveTab('references');
    });
}
```

- [ ] **Step 4: Delete dead override functions**

In `src/ui/tab-generate.js`, delete these functions entirely (they are no longer referenced):
- `initOverride` (lines 545-547)
- `buildOverrideControls` (lines 676-698)
- `bindOverrideControls` (lines 704-732)

Also delete the `refDescriptorChip` function (lines 651-670) — its logic is now inlined into `renderLivePreview`.

- [ ] **Step 5: Verify no dangling references to removed code**

Search for any remaining references to removed identifiers:
Run: `grep -n "initOverride\|buildOverrideControls\|bindOverrideControls\|refDescriptorChip\|refsOverride\|OverrideEnabled\|urisRefsReset\|urisRefsStatusBody" src/ui/tab-generate.js`
Expected: no output (all removed). If any remain, remove them.

- [ ] **Step 6: Run syntax check**

Run: `node --check src/ui/tab-generate.js`
Expected: no output (success).

- [ ] **Step 7: Run full test suite**

Run: `node --test tests/*.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ui/tab-generate.js
git commit -m "feat(refs): unified panel render + bindings (slots/extras/descRefs)"
```

---

## Task 9: Remove refsOverride from state and events

**Files:**
- Modify: `src/core.js:83`, `src/events.js:79`

- [ ] **Step 1: Remove refsOverride from state**

In `src/core.js`, find line 83:

```js
    refsOverride: null,
```

Delete that line.

- [ ] **Step 2: Remove refsOverride reset from events**

In `src/events.js`, find line 79:

```js
        state.refsOverride = null;
```

Delete that line.

- [ ] **Step 3: Verify no remaining references**

Run: `grep -rn "refsOverride" src/`
Expected: only the JSDoc typedef comment in `src/refs-library.js:192` (`RefsOverride` typedef) and the `override` parameter docs in `pipeline.js`. These are harmless documentation — the `override` parameter in pipeline/refs-library remains as always-`null`. No executable references to `state.refsOverride`.

- [ ] **Step 4: Run syntax check + tests**

Run: `node --check src/core.js && node --check src/events.js && node --test tests/*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core.js src/events.js
git commit -m "refactor(refs): remove refsOverride state (override UI removed)"
```

---

## Task 10: Remove #urisRefsChat from References tab

**Files:**
- Modify: `src/ui/tab-references.js:18-26` (render), `:28-156` (renderChatSection + helpers)

- [ ] **Step 1: Remove #urisRefsChat host from render**

In `src/ui/tab-references.js`, modify `render` (lines 18-26). Remove the `urisRefsChat` div and the `renderChatSection` call. Find:

```js
export function render(root) {
    root.innerHTML = `
        <div class="uris-references">
            <div class="uris-refs-chat" id="urisRefsChat"></div>
            <div class="uris-refs-pool" id="urisRefsPool"></div>
        </div>`;
    renderChatSection(root);
    renderPoolSection(root);
}
```

Change to:

```js
export function render(root) {
    root.innerHTML = `
        <div class="uris-references">
            <div class="uris-refs-pool" id="urisRefsPool"></div>
        </div>`;
    renderPoolSection(root);
}
```

- [ ] **Step 2: Delete renderChatSection and its helpers**

In `src/ui/tab-references.js`, delete these functions entirely (lines 28-156):
- `renderChatSection` (30-114)
- `slotSelect` (116-123)
- `slotPreview` (125-132)
- `extrasHtml` (134-145)
- `bindExtrasList` (147-156)

Their logic has been reimplemented in `tab-generate.js` (Task 8).

- [ ] **Step 3: Check for unused imports**

After deleting the chat section, some imports may be unused. Check: `saveChatRefs`, `getChatRefs`, `refreshActive` — are they still used elsewhere in `tab-references.js`?
Run: `grep -n "saveChatRefs\|getChatRefs" src/ui/tab-references.js`
- `getChatRefs` — no longer used in this file → remove from import.
- `saveChatRefs` — no longer used → remove from import.
- `refreshActive` — still used in pool section (e.g. after createRef). Keep.

Update the import (lines 7-14). Find:

```js
import {
    listRefs, getRef, createRef, updateRef, deleteRef,
    listFolders, createFolder, renameFolder, deleteFolder,
    getChatRefs, saveChatRefs, refreshPoolCache, getRefSync,
} from '../refs-library.js';
```

Change to:

```js
import {
    listRefs, getRef, createRef, updateRef, deleteRef,
    listFolders, createFolder, renameFolder, deleteFolder,
    refreshPoolCache, getRefSync,
} from '../refs-library.js';
```

- [ ] **Step 4: Run syntax check**

Run: `node --check src/ui/tab-references.js`
Expected: no output (success).

- [ ] **Step 5: Commit**

```bash
git add src/ui/tab-references.js
git commit -m "refactor(refs): remove chat section from References tab (moved to Generate)"
```

---

## Task 11: Folder filters in pool picker

**Files:**
- Modify: `src/ui/tab-references.js:334-376` (showPoolPicker), `:220-228` (extract shared folderChipsHtml)

- [ ] **Step 1: Refactor folderChipsHtml to accept an active filter parameter**

In `src/ui/tab-references.js`, modify `folderChipsHtml` (lines 220-228) to accept an explicit filter instead of the module-level `_activeFolderFilter`. This makes it reusable by the picker:

```js
function folderChipsHtml(folders, activeFilter) {
    const chip = (folder, label) =>
        `<span class="uris-folder-chip ${activeFilter === folder ? 'uris-folder-chip-on' : ''}" data-folder="${folder}">${escapeHtml(label)}</span>`;
    let html = chip('all', 'Все') + chip('none', 'Без папки');
    for (const f of folders) {
        html += chip(f.id, f.name);
    }
    return html;
}
```

- [ ] **Step 2: Update renderPoolSection to pass the module filter**

In `src/ui/tab-references.js`, find where `folderChipsHtml(folders)` is called in `renderPoolSection` (around line 165). Update to pass `_activeFolderFilter`:

```js
    const folderChips = folderChipsHtml(folders, _activeFolderFilter);
```

- [ ] **Step 3: Add folder filters to showPoolPicker**

In `src/ui/tab-references.js`, replace `showPoolPicker` (lines 334-376). The picker now shows folder chips at the top, filters the grid on chip click, and preserves the `selected` Set across re-renders:

```js
async function showPoolPicker({ title = 'Выберите референсы', multi = true, excludeIds = [] } = {}) {
    const allRefs = (await listRefs()).filter(r => r.imagePath && !excludeIds.includes(r.id));
    const folders = await listFolders();
    if (!allRefs.length) {
        toastr?.info('Пул пуст. Добавьте референсы в библиотеку.');
        return multi ? [] : null;
    }
    let pickerFilter = 'all';
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'uris-picker-overlay';
        const selected = new Set();
        const filteredRefs = () => allRefs.filter(r => {
            if (pickerFilter === 'all') return true;
            if (pickerFilter === 'none') return !r.folderId;
            return r.folderId === pickerFilter;
        });
        const renderGrid = () => {
            const grid = overlay.querySelector('.uris-picker-grid');
            if (!grid) return;
            grid.innerHTML = filteredRefs().map(r => `<div class="uris-pool-tile uris-pick-tile ${selected.has(r.id) ? 'uris-pick-selected' : ''}" data-ref-id="${escapeHtml(r.id)}">
                <img src="${escapeHtml(r.imagePath)}" alt="${escapeHtml(r.name)}">
                <div class="uris-pool-tile-name">${escapeHtml(r.name)}</div>
            </div>`).join('');
        };
        overlay.innerHTML = `
            <div class="uris-picker-dialog">
                <h4>${escapeHtml(title)}</h4>
                <div class="uris-folder-chips" id="urisPickerFolders"></div>
                <div class="uris-pool-grid uris-picker-grid"></div>
                <div class="uris-picker-actions">
                    <button class="menu_button uris-pick-cancel">Отмена</button>
                    ${multi ? '<button class="menu_button uris-pick-ok">Готово</button>' : ''}
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const renderFolders = () => {
            const fc = overlay.querySelector('#urisPickerFolders');
            if (!fc) return;
            fc.innerHTML = folderChipsHtml(folders, pickerFilter);
            fc.querySelectorAll('.uris-folder-chip').forEach(chip => {
                chip.addEventListener('click', () => {
                    pickerFilter = chip.dataset.folder;
                    renderFolders();
                    renderGrid();
                });
            });
        };

        renderFolders();
        renderGrid();

        overlay.addEventListener('click', (e) => {
            const tile = e.target.closest('.uris-pick-tile');
            if (!tile) return;
            const id = tile.dataset.refId;
            if (multi) {
                if (selected.has(id)) { selected.delete(id); tile.classList.remove('uris-pick-selected'); }
                else { selected.add(id); tile.classList.add('uris-pick-selected'); }
            } else {
                overlay.remove();
                resolve(id);
            }
        });
        overlay.querySelector('.uris-pick-cancel')?.addEventListener('click', () => { overlay.remove(); resolve(multi ? [] : null); });
        overlay.querySelector('.uris-pick-ok')?.addEventListener('click', () => { overlay.remove(); resolve([...selected]); });
    });
}
```

- [ ] **Step 4: Run syntax check**

Run: `node --check src/ui/tab-references.js`
Expected: no output (success).

- [ ] **Step 5: Commit**

```bash
git add src/ui/tab-references.js
git commit -m "feat(refs): folder filters in pool picker + shared folderChipsHtml"
```

---

## Task 12: CSS — remove dead styles, add unified panel styles

**Files:**
- Modify: `style.css:365-368` (override-toggle), `:369-372` (refs-edit/reset), `:413-439` (override controls), `:570-593` (chat section)

- [ ] **Step 1: Remove override-toggle rule**

In `style.css`, delete lines 365-368 (the `.uris-override-toggle` rule):
```css
365  .uris-override-toggle {
366      font-size: 12px;
367      margin-left: auto;
368  }
```

- [ ] **Step 2: Update .uris-refs-edit (remove .uris-refs-reset)**

In `style.css`, modify lines 369-372. The `.uris-refs-reset` class is gone. Change:
```css
  .uris-refs-edit, .uris-refs-reset {
      padding: 2px 8px;
      font-size: 12px;
  }
```
to:
```css
  .uris-refs-edit {
      padding: 2px 8px;
      font-size: 12px;
  }
```

- [ ] **Step 3: Delete override-controls CSS block**

In `style.css`, delete lines 413-439 (the comment `/* Override-контролы */` and the rules `.uris-override-controls`, `.uris-ov-char`, `.uris-ov-user`, `.uris-ov-npc-chip`, `.uris-npc-chip-on`, and trailing blank line).

- [ ] **Step 4: Add unified-panel CSS classes**

In `style.css`, after the `.uris-refs-status-cap` rule (currently ending around line 388), add new styles for the unified panel. These reuse existing class names (`.uris-slot-row`, `.uris-slot-label`, `.uris-slot-preview`, `.uris-slot-preview-empty`, `.uris-extra-chip`, `.uris-extra-name`, `.uris-extra-del`) which already exist at lines 570-615. Add new classes for panel structure and descRef chips:

```css
  /* Единая панель референсов (Generate tab) */
  .uris-refs-panel {
      background: rgba(255,255,255,.04);
      border: 1px solid rgba(255,255,255,.1);
      border-radius: 8px;
      padding: 8px;
      margin-bottom: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
  }
  .uris-refs-panel-head {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
  }
  .uris-refs-panel-slots {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
  }
  .uris-refs-panel-chips {
      display: flex;
      flex-direction: column;
      gap: 4px;
  }
  .uris-refs-panel-row {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
  }
  .uris-refs-panel-rowlabel {
      font-size: 11px;
      opacity: .7;
      white-space: nowrap;
      min-width: 130px;
  }
  .uris-refs-panel-preview {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
      padding-top: 4px;
      border-top: 1px dashed rgba(255,255,255,.1);
  }
  .uris-descref-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 12px;
      background: rgba(255,255,255,.06);
      cursor: pointer;
      font-size: 11px;
      border: 1px solid transparent;
      user-select: none;
  }
  .uris-descref-chip:hover {
      border-color: var(--SmartThemeQuoteColor, #4a5);
  }
  .uris-descref-del {
      background: none;
      border: none;
      color: inherit;
      cursor: pointer;
      opacity: .5;
      padding: 0;
      font-size: 10px;
  }
  .uris-descref-del:hover { opacity: 1; }
  .uris-refs-mode-select {
      font-size: 11px;
      padding: 1px 6px;
  }
```

- [ ] **Step 5: Remove the standalone .uris-refs-chat CSS block**

The `.uris-refs-chat` container rule (line 570-575) is no longer rendered. Delete lines 570-575:
```css
570  .uris-refs-chat {
571      border: 1px solid var(--SmartThemeBorderColor);
572      border-radius: 8px;
573      padding: 10px;
574      margin-bottom: 12px;
575  }
```
Keep `.uris-slot-row`, `.uris-slot-label`, `.uris-slot-preview`, `.uris-slot-preview-empty` (lines 576-593) — these are reused in the unified panel.

- [ ] **Step 6: Commit**

```bash
git add style.css
git commit -m "style(refs): unified panel CSS, remove override/chat-section styles"
```

---

## Task 13: Final verification

- [ ] **Step 1: Run full test suite**

Run: `node --test tests/*.test.js`
Expected: all tests PASS, zero failures.

- [ ] **Step 2: Syntax-check all modified files**

Run:
```bash
node --check src/refs-library.js && \
node --check src/prompt-builder.js && \
node --check src/pipeline.js && \
node --check src/ui/tab-generate.js && \
node --check src/ui/tab-references.js && \
node --check src/core.js && \
node --check src/events.js
```
Expected: no output (all valid).

- [ ] **Step 3: Verify no dangling references**

Run:
```bash
grep -rn "urisRefsOverrideEnabled\|urisRefsReset\|initOverride\|buildOverrideControls\|bindOverrideControls\|refsOverride\|urisRefsStatusBody\|urisRefsChat\|urisRefsProfileName" src/
```
Expected: no executable references. (Only harmless JSDoc typedef `RefsOverride` in refs-library.js and `override` parameter docs in pipeline.js should remain.)

- [ ] **Step 4: Manual smoke test (documented for human)**

The following must be verified manually in a running SillyTavern:
1. Open extension window → Generate tab → references panel shows mode select, char/user slots with real avatar previews.
2. Click slot "Из пула" → picker opens WITH folder filter chips.
3. Pin a ref to {{char}} → preview shows the ref image.
4. Add Stage2 extras via [+] → chips appear.
5. Add Stage1 descriptions via [+] → chips with 🔄 appear; click toggles to 📌.
6. Pool item editor (References tab) has "Описание" textarea.
7. Click "Построить промпт" (Stage1) → verify a ref description appears in the built prompt (check console/network).
8. Generate image → references attach correctly (Stage2).
9. No "Override" checkbox or "Сброс" button anywhere.

- [ ] **Step 5: Final commit (if any cleanup)**

If steps 1-3 surfaced issues, fix and commit. Otherwise this step is a no-op.

---

## Spec Coverage Checklist

| Spec section | Tasks |
|-------------|-------|
| 1a. Pool `description` field | Task 1 |
| 1b. Chat binding `descRefs` | Task 2 |
| 2. Stage1 injection (collectDescRefsForCurrentChat) | Task 3 |
| 2. Stage1 injection (renderRefDescriptionsBlock) | Task 4 |
| 2. Stage1 injection (runStage1 wiring) | Task 5 |
| 3a. Unified panel on Generate tab | Tasks 7, 8 |
| 3b. Async avatar previews | Task 8 (loadSlotPreview) |
| 3c. Remove #urisRefsChat from References tab | Task 10 |
| 3d. Folder filters in picker | Task 11 |
| 3e. Rename "Персонажи" chips | Task 7 (Step 1) |
| Pool editor description field (3/5 in spec steps) | Task 6 |
| 4a. Backward compat (normalization) | Tasks 1, 2 |
| 4c. Remove Override UI | Tasks 8, 9 |
| 4c. Remove refsOverride state | Task 9 |
| CSS cleanup | Task 12 |
