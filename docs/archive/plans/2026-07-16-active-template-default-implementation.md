# Active Template Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Templates tab's active template the default for every message draft that has no explicit local selection, while preserving per-post overrides including an explicit base-mode choice.

**Architecture:** Add `templateSelection: 'default' | 'override'` to message-scoped generation drafts. Keep `templateId` as the selected template id or `null`; resolve the effective id through one helper that uses `state.activeTemplateId` for default drafts and the stored id for overrides. The Generate UI persists `override` on every selector change, while the pipeline resolves the same effective id for manual, automatic, and queued Stage 1 runs.

**Tech Stack:** Browser ES modules, JavaScript with `// @ts-check`, SillyTavern localforage, Node built-in test runner (`node --test`).

---

## File Map

- Modify `src/generation-drafts.js`: extend the draft type/defaults, normalize legacy records, and export the shared effective-template resolver.
- Modify `src/ui/tab-generate.js`: pass active-template state into the view model, render the effective selection, persist local selector changes as overrides, and capture the effective template for manual/queued operations.
- Modify `src/pipeline.js`: resolve the template from the draft/default when Stage 1 input does not provide an operation snapshot; preserve explicit queue/manual ids without changing draft selection mode.
- Modify `src/core.js`: document the new draft selection field in the local typedefs if the existing typedef is expanded there.
- Modify `tests/generation-drafts.test.js`: test defaults, legacy normalization, resolver behavior, and migration persistence.
- Modify `tests/tab-generate.test.js`: test effective-template rendering and the selected base mode.
- Modify `tests/pipeline-scene-first.test.js`: test that Stage 1 resolves the active default and respects a local override.
- Create `tests/template-selection.test.js` only if the existing test files cannot isolate the resolver without duplicating their harness; prefer extending the existing focused suites.
- Create `docs/superpowers/plans/2026-07-16-active-template-default-implementation.md`: this implementation plan.

## Data Contract

Use these exact values and meanings:

```js
/** @type {'default'|'override'} */
templateSelection
```

- New draft: `{ templateSelection: 'default', templateId: null }`.
- Default draft: effective template id is the current `state.activeTemplateId`.
- Override draft: effective template id is the stored `templateId`, including `null` for explicit base mode.
- Legacy draft without `templateSelection`: normalize non-null `templateId` to `override`; normalize null/missing `templateId` to `default`.

Export a pure helper with this stable contract:

```js
export function normalizeTemplateSelection(draft) {
    // returns a shallow normalized draft or selection metadata without mutating input
}

export function resolveDraftTemplateId(draft, activeTemplateId) {
    // returns string|null; override wins, otherwise activeTemplateId
}
```

The implementation may choose one normalization helper shape, but all callers must use the same semantics and no caller may infer default/override independently.

---

### Task 1: Add draft selection state and pure resolver tests

**Files:**
- Modify: `src/generation-drafts.js:37-49, 98-129, 140-149`
- Test: `tests/generation-drafts.test.js`

- [ ] **Step 1: Write failing tests for new-draft defaults and resolver semantics**

Add tests covering the public behavior:

```js
test('new drafts follow the active template by default', async () => {
    const draft = await drafts.getGenerationDraft('chat-1', 7, 'scene');
    assert.equal(draft.templateSelection, 'default');
    assert.equal(drafts.resolveDraftTemplateId(draft, 'tpl-active'), 'tpl-active');
});

test('override template wins over active template', () => {
    const draft = { templateSelection: 'override', templateId: 'tpl-local' };
    assert.equal(drafts.resolveDraftTemplateId(draft, 'tpl-active'), 'tpl-local');
});

test('explicit base override remains base', () => {
    const draft = { templateSelection: 'override', templateId: null };
    assert.equal(drafts.resolveDraftTemplateId(draft, 'tpl-active'), null);
});

test('legacy non-null template id is normalized as override', async () => {
    await lfMock.setItem(drafts.generationDraftKey('chat-1', 9), {
        chatId: 'chat-1', msgId: 9, messageHash: drafts.hashMessage('scene'), templateId: 'tpl-old',
    });
    const draft = await drafts.getGenerationDraft('chat-1', 9, 'scene');
    assert.equal(draft.templateSelection, 'override');
    assert.equal(drafts.resolveDraftTemplateId(draft, 'tpl-active'), 'tpl-old');
});

test('legacy null template id is normalized as default', async () => {
    await lfMock.setItem(drafts.generationDraftKey('chat-1', 10), {
        chatId: 'chat-1', msgId: 10, messageHash: drafts.hashMessage('scene'), templateId: null,
    });
    const draft = await drafts.getGenerationDraft('chat-1', 10, 'scene');
    assert.equal(draft.templateSelection, 'default');
    assert.equal(drafts.resolveDraftTemplateId(draft, 'tpl-active'), 'tpl-active');
});
```

Keep the existing required draft fields in the fixture or build it from `createGenerationDraft` and remove only the new field to model old storage. The test must verify that a legacy read does not mutate the stored object unless the implementation explicitly persists normalization.

- [ ] **Step 2: Run the focused test file and verify failure**

Run:

```bash
node --test tests/generation-drafts.test.js
```

Expected: FAIL because `templateSelection` and `resolveDraftTemplateId` do not exist yet.

- [ ] **Step 3: Implement the minimal draft model and normalization**

In `src/generation-drafts.js`:

1. Add `@property {'default'|'override'} templateSelection` to `GenerationDraft`.
2. Add `templateSelection: 'default'` immediately before `templateId` in `createGenerationDraft`.
3. Add a pure normalizer that returns a copy and uses this rule:

```js
function normalizeTemplateSelection(draft) {
    if (draft?.templateSelection === 'override' || draft?.templateSelection === 'default') {
        return { ...draft };
    }
    return {
        ...draft,
        templateSelection: draft?.templateId == null ? 'default' : 'override',
    };
}
```

4. Export `normalizeTemplateSelection` if callers need the normalized copy.
5. Export:

```js
export function resolveDraftTemplateId(draft, activeTemplateId) {
    const normalized = normalizeTemplateSelection(draft || {});
    return normalized.templateSelection === 'override'
        ? (normalized.templateId || null)
        : (activeTemplateId || null);
}
```

Do not mutate a frozen draft or the localforage object. In `getGenerationDraft`, normalize an existing fresh record before returning it. Persisting the normalized field is optional; if chosen, write only the normalized copy and preserve all other fields. Do not reset an existing prompt or stage data.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```bash
node --test tests/generation-drafts.test.js
```

Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Commit the draft-model change**

```bash
git add src/generation-drafts.js tests/generation-drafts.test.js
git commit -m "feat: add message template selection mode"
```

---

### Task 2: Make Generate UI display and persist effective selection

**Files:**
- Modify: `src/ui/tab-generate.js:29-57, 65-73, 181-195, 231-281, 328-332, 404-420`
- Test: `tests/tab-generate.test.js`

- [ ] **Step 1: Extend view-model tests with active default and explicit base override cases**

Add tests using `buildGenerateViewModel` and `renderGenerateMarkup`:

```js
test('renderGenerateMarkup selects active template for a default draft', () => {
    const messageText = 'scene';
    const draft = {
        templateSelection: 'default', templateId: null,
        messageHash: hashMessage(messageText), prompt: '',
        aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
    };
    const markup = renderGenerateMarkup(baseVm({
        draft, messageText,
        templates: [{ id: 'tpl-active', name: 'Active' }, { id: 'tpl-other', name: 'Other' }],
        activeTemplateId: 'tpl-active',
    }));
    assert.match(markup, /value="tpl-active"[^>]*selected/);
    assert.doesNotMatch(markup, /value="tpl-other"[^>]*selected/);
});

test('renderGenerateMarkup keeps explicit base override selected', () => {
    const messageText = 'scene';
    const draft = {
        templateSelection: 'override', templateId: null,
        messageHash: hashMessage(messageText), prompt: '',
        aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
    };
    const markup = renderGenerateMarkup(baseVm({
        draft, messageText,
        templates: [{ id: 'tpl-active', name: 'Active' }],
        activeTemplateId: 'tpl-active',
    }));
    const baseBlock = markup.match(/<select[^>]*id="urisTemplate"[^>]*>[\s\S]*?<\/select>/)?.[0];
    assert.ok(baseBlock);
    assert.match(baseBlock, /<option value="" selected>— базовый режим —<\/option>/);
});
```

Update `baseVm` to pass `activeTemplateId` through to `buildGenerateViewModel`; keep existing tests unchanged by defaulting it to `null`.

- [ ] **Step 2: Run the focused UI tests and verify failure**

Run:

```bash
node --test tests/tab-generate.test.js
```

Expected: FAIL because the view model and markup currently compare only `draft.templateId`.

- [ ] **Step 3: Implement effective-template view-model data**

In `src/ui/tab-generate.js`:

1. Import `resolveDraftTemplateId` and `normalizeTemplateSelection` from `generation-drafts.js`.
2. Extend `buildGenerateViewModel` input with `activeTemplateId` and return:

```js
const normalizedDraft = normalizeTemplateSelection(draft);
const effectiveTemplateId = resolveDraftTemplateId(normalizedDraft, activeTemplateId);
return { ..., draft: normalizedDraft, activeTemplateId, effectiveTemplateId };
```

3. Render options against `vm.effectiveTemplateId`, not `draft.templateId`.
4. In `render(root)`, pass `state.activeTemplateId` into the view model.
5. Keep an unknown stored override visible if its id is absent from `templates` by adding a non-destructive option such as `value="<id>" selected` with the draft id/name fallback only when selection mode is `override` and the id is non-null. Do not silently convert it to base in the UI.

- [ ] **Step 4: Persist selector changes as explicit overrides**

Replace the current bundle mutation in the `#urisTemplate` change listener with a draft update for the current `(chatId, msgId)`:

```js
root.querySelector('#urisTemplate')?.addEventListener('change', async () => {
    const ctx = getCtx();
    const msgId = state.currentMsgId;
    if (msgId == null) return;
    const messageText = ctx.chat?.[msgId]?.mes || '';
    const templateId = root.querySelector('#urisTemplate')?.value || null;
    await updateGenerationDraft(ctx.chatId, msgId, messageText, d => ({
        ...d,
        templateSelection: 'override',
        templateId,
    }));
});
```

This must make selecting `— базовый режим —` persist `{ templateSelection: 'override', templateId: null }`. Do not call `persistBundleFields` here.

- [ ] **Step 5: Use the effective id when starting manual Stage 1/Stage 2**

When the Build Prompt and Generate Image handlers read the current draft, resolve the operation id from the draft/default rather than blindly reading the select value. Use the selector value only after persisting it as an override, or use the rendered `vm.effectiveTemplateId` for a default draft. The resulting input should be:

```js
const currentDraft = await getGenerationDraft(ctx.chatId, msgId, messageText);
const templateId = resolveDraftTemplateId(currentDraft, state.activeTemplateId);
const input = { chatId: ctx.chatId, msgId, messageText, templateId };
```

When the handler persists aspect/size/quality, do not overwrite `templateSelection` or convert a default draft into an override. If the user changed the select, its listener has already persisted the override.

- [ ] **Step 6: Run UI tests and commit**

Run:

```bash
node --test tests/tab-generate.test.js
```

Expected: PASS.

Commit:

```bash
git add src/ui/tab-generate.js tests/tab-generate.test.js
git commit -m "feat: use active template for default drafts"
```

---

### Task 3: Resolve defaults consistently in pipeline and queue

**Files:**
- Modify: `src/pipeline.js:10-34, 234-290, 392-404, 527-538, 567-645`
- Test: `tests/pipeline-scene-first.test.js`
- Modify: `src/events.js:50-59` only if automation payload documentation or behavior needs a comment update

- [ ] **Step 1: Add failing pipeline tests for default and override resolution**

Add tests around the existing scene-first Stage 1 harness. Verify the generated system prompt identifies the template used, or stub `getTemplate`/the text request in the same style as existing tests. The behavior assertions should be:

```js
test('runStage1ForDraft resolves the active template for a default draft', async () => {
    // Persist a draft with templateSelection:'default', templateId:null.
    // Set state.activeTemplateId = 'tpl-active'.
    // Run Stage 1 and assert the active template content reaches executeStage1.
});

test('runStage1ForDraft preserves a local template override', async () => {
    // Persist a draft with templateSelection:'override', templateId:'tpl-local'.
    // Set state.activeTemplateId = 'tpl-active'.
    // Run Stage 1 and assert tpl-local is used.
});
```

Also add a queue test ensuring the queue item captures the effective template id at enqueue time without changing the stored draft's selection mode. Keep the existing `createQueueItem` contract compatible where possible.

- [ ] **Step 2: Run the focused pipeline tests and verify failure**

Run:

```bash
node --test tests/pipeline-scene-first.test.js
```

Expected: FAIL because `runStage1ForDraft` currently trusts its `input.templateId`, and automatic calls pass `null`.

- [ ] **Step 3: Resolve the template id at the Stage 1 boundary**

In `src/pipeline.js`:

1. Import `resolveDraftTemplateId` from `generation-drafts.js`.
2. In `runStage1ForDraft`, load the draft first, then compute:

```js
const effectiveTemplateId = input.templateId != null
    ? input.templateId
    : resolveDraftTemplateId(draft, state.activeTemplateId);
```

Use `effectiveTemplateId` in `resolveTemplateForDraft`. This preserves an operation-level id captured by manual/queue code while making automatic payloads with `null` follow the draft/default.

3. Do not write `effectiveTemplateId` back into `draft.templateId` unless the draft is already `override`. `applyStage1Result` must preserve `templateSelection`; its `templateId` update must not turn a default draft into an override. Prefer storing the effective id in Stage 1 result metadata only if existing consumers require it, while keeping selection mode unchanged.
4. Ensure `runStage2ForDraft` does not reinterpret a null operation id as an instruction to clear the draft selection. Its existing `templateId: templateId ?? d.templateId` update must be reviewed: preserve `d.templateId` for `override`, and preserve the `default` mode for default drafts.

- [ ] **Step 4: Make queue operations capture an effective operation id without mutating draft mode**

In `enqueueCurrent` in `tab-generate.js`:

1. Read the current draft.
2. Resolve `templateId` with `resolveDraftTemplateId(draft, state.activeTemplateId)`.
3. Pass that id into `createQueueItem`.

In `processQueue`, pass the captured queue item id to `runStage1ForDraft` as an operation-level id. The queue snapshot is intentionally stable if the active template changes while the item waits; it is not persisted as a draft override.

For automatic event payloads in `events.js`, keep `templateId: null`; this means the pipeline resolves the current draft/default at processing time.

- [ ] **Step 5: Run pipeline tests and commit**

Run:

```bash
node --test tests/pipeline-scene-first.test.js
```

Expected: PASS.

Commit:

```bash
git add src/pipeline.js src/ui/tab-generate.js src/events.js tests/pipeline-scene-first.test.js
git commit -m "feat: resolve active template in all generation paths"
```

---

### Task 4: Update typings, migration coverage, and regression tests

**Files:**
- Modify: `src/core.js:59-67` if the shared `Stage1Result`/draft typedefs need the new field
- Modify: `src/generation-drafts.js` comments and JSDoc
- Modify: `tests/generation-drafts.test.js`
- Modify: `tests/tab-generate.test.js`
- Modify: `tests/pipeline-scene-first.test.js`

- [ ] **Step 1: Add explicit migration persistence coverage**

If `getGenerationDraft` persists normalization, assert the localforage value now includes `templateSelection`. If normalization is read-only, assert subsequent `updateGenerationDraft` writes the field. Cover both legacy shapes:

```js
const old = { ...createGenerationDraft('chat-1', 11, 'scene') };
delete old.templateSelection;
old.templateId = 'tpl-local';
await lfMock.setItem(generationDraftKey('chat-1', 11), old);
const loaded = await getGenerationDraft('chat-1', 11, 'scene');
assert.equal(loaded.templateSelection, 'override');
```

- [ ] **Step 2: Test active-template changes without rewriting overrides**

Create two drafts in the test harness: one default and one override. Resolve both against `tpl-a`, then against `tpl-b`; assert only the default result changes.

- [ ] **Step 3: Update JSDoc and inline comments**

Document that `state.activeTemplateId` is the default source, while `GenerationDraft.templateId` is only authoritative when `templateSelection === 'override'`. Update stale comments in `core.js`, `pipeline.js`, and `tab-generate.js` that currently describe `templateId` as the sole selection source.

- [ ] **Step 4: Run the complete test suite**

First discover the repository's test command if needed. The existing project uses Node's built-in test runner; run:

```bash
node --test
```

Expected: all tests pass. If the repository has a documented wrapper command, run that as well.

- [ ] **Step 5: Inspect the final diff and commit regression updates**

Run:

```bash
git diff HEAD~3..HEAD -- src/generation-drafts.js src/ui/tab-generate.js src/pipeline.js src/core.js src/events.js tests
```

Check specifically that:

- no selector change still calls `persistBundleFields({ templatesIds: ... })`;
- default drafts are not mutated into overrides by Stage 1/Stage 2;
- explicit base selection remains `templateSelection: 'override'` with `templateId: null`;
- automatic events still pass `templateId: null` and rely on the shared resolver;
- queue ids are operation snapshots, not persisted draft choices.

Commit:

```bash
git add src/generation-drafts.js src/ui/tab-generate.js src/pipeline.js src/core.js src/events.js tests
git commit -m "test: cover active template default and overrides"
```

---

## Verification Checklist

- [ ] `node --test tests/generation-drafts.test.js` passes.
- [ ] `node --test tests/tab-generate.test.js` passes.
- [ ] `node --test tests/pipeline-scene-first.test.js` passes.
- [ ] `node --test` passes.
- [ ] A fresh post with no selector interaction displays the current Templates-tab active template.
- [ ] Selecting another template on a post keeps that template after changing the global active template.
- [ ] Selecting `— базовый режим —` on a post keeps it on base after changing the global active template.
- [ ] Automatic and queued Stage 1 use the same effective-template rule as the UI.
- [ ] No unrelated dirty files are reverted or included in commits.
