# Prompt-Driven Stage 2 References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make automatic Stage 2 references follow the current Stage 1 prompt, with persistent message-scoped `+`/`x` corrections and an immediately updating preview.

**Architecture:** Keep `buildSceneContextSnapshot()` as the historical Stage 1 resolver over source-message text. Add a pure `resolvePromptReferenceContext()` in the same domain module; it uses the same strict name/alias matcher but analyzes the current prompt and returns an immutable Stage 2-only resolution. Pipeline and Generate UI both call that contract, while provider capability/cap filtering remains at the existing provider boundary.

**Tech Stack:** JavaScript ES modules with `// @ts-check`, Node built-in `node:test`, SillyTavern/localforage integration, existing Font Awesome UI and pool picker.

---

## File Map

- Modify `src/scene-context.js`: add the reusable prompt-driven Stage 2 resolver and shared deterministic matching helpers without changing the Stage 1 snapshot contract.
- Modify `src/pipeline.js`: resolve and materialize Stage 2 refs from the exact current draft prompt; stop rebuilding or rewriting Stage 1 snapshots during Stage 2.
- Modify `src/ui/tab-generate.js`: build the view model from separate Stage 1 and Stage 2 resolutions; add effective reference `+`/`x` controls; refresh preview after prompt autosave.
- Modify `style.css`: provide stable chip/add-button layout for interactive effective references.
- Modify `tests/scene-context.test.js`: cover prompt-only matching, corrections, ambiguity, ordering, and Stage 1 isolation.
- Modify `tests/pipeline-scene-first.test.js`: cover manual and automatic prompt-derived provider refs and immutable submission behavior.
- Modify `tests/tab-generate.test.js`: cover separate view-model inputs, correction transitions, and interactive preview markup.
- Read-only regression boundary: `src/generation-drafts.js`, `src/references.js`, `src/image-api.js`, `src/refs-library.js`. Existing APIs are sufficient; do not add persisted derived state or move provider limits into the resolver.

## Task 1: Add the Prompt Reference Resolver

**Files:**
- Modify: `src/scene-context.js:120-320`
- Test: `tests/scene-context.test.js`

- [ ] **Step 1: Write failing tests for source-message and prompt separation**

Extend the import in `tests/scene-context.test.js` with `resolvePromptReferenceContext`, then add a test that proves Stage 1 and Stage 2 can intentionally disagree:

```js
test('Stage 2 refs follow prompt while Stage 1 context follows source message', async () => {
    const candidates = [
        normalizeSceneEntity({ id: 'aaron', name: 'Aaron', description: 'red coat', imagePath: '/aaron.png' }, 'npc'),
        normalizeSceneEntity({ id: 'beth', name: 'Beth', description: 'blue dress', imagePath: '/beth.png' }, 'npc'),
    ];
    const corrections = { includedIds: [], excludedIds: [], revision: 0 };

    const stage1 = await buildSceneContextSnapshot({
        chatId: 'chat-1', msgId: 1, messageText: 'Aaron enters.',
        contextRevision: 0, candidates, corrections,
    });
    const stage2 = resolvePromptReferenceContext({
        prompt: 'Beth stands alone in a blue dress.', candidates, corrections,
    });

    assert.deepEqual(stage1.stage1Descriptions.map(ref => ref.id), ['aaron']);
    assert.deepEqual(stage2.stage2Refs.map(ref => ref.id), ['beth']);
    assert.deepEqual(stage1.stage2Refs.map(ref => ref.id), ['aaron']);
});
```

- [ ] **Step 2: Write failing tests for strict prompt matching and empty prompt**

Add cases proving canonical names and aliases match, Unicode case and word boundaries are preserved, keywords/descriptions do not match, and an empty prompt has no automatic refs:

```js
test('prompt reference resolver uses only strict canonical names and aliases', () => {
    const candidates = [normalizeSceneEntity({
        id: 'aaron', name: 'Аарон Вейл', aliases: ['Аарон'],
        keywords: ['prince'], description: 'silver-haired prince', imagePath: '/aaron.png',
    }, 'npc')];
    const corrections = { includedIds: [], excludedIds: [], revision: 2 };

    assert.deepEqual(resolvePromptReferenceContext({
        prompt: 'ААРОН watches the road.', candidates, corrections,
    }).stage2Refs.map(ref => ref.id), ['aaron']);
    assert.deepEqual(resolvePromptReferenceContext({
        prompt: 'Ааронов плащ; silver-haired prince.', candidates, corrections,
    }).stage2Refs, []);
    assert.deepEqual(resolvePromptReferenceContext({
        prompt: '', candidates, corrections,
    }).stage2Refs, []);
});
```

- [ ] **Step 3: Write failing tests for corrections, all-role matching, ordering, and ambiguity**

Use candidates with `char`, `user`, and NPC roles. Assert that `char`/`user` are automatic only when their name/alias is present in the prompt, manual includes appear first, exclusions win over auto matches, missing candidate IDs are ignored, and duplicate aliases produce an ambiguity without auto-inclusion:

```js
test('prompt reference resolver applies persistent corrections and stable ordering', () => {
    const candidates = [
        normalizeSceneEntity({ id: 'char', name: 'Aria', imagePath: '/aria.png' }, 'char'),
        normalizeSceneEntity({ id: 'user', name: 'Alex', imagePath: '/alex.png' }, 'user'),
        normalizeSceneEntity({ id: 'aaron', name: 'Aaron', aliases: ['Ron'], imagePath: '/aaron.png' }, 'npc'),
        normalizeSceneEntity({ id: 'beth', name: 'Beth', imagePath: '/beth.png' }, 'npc'),
    ];
    const result = resolvePromptReferenceContext({
        prompt: 'Beth looks at Aria, then Aaron arrives.',
        candidates,
        corrections: { includedIds: ['user', 'missing'], excludedIds: ['aaron'], revision: 4 },
    });

    assert.deepEqual(result.stage2Refs.map(ref => ref.id), ['user', 'char', 'beth']);
    assert.equal(result.referencesRevision, 4);
    assert.throws(() => { result.stage2Refs.push({}); }, TypeError);
});
```

Add a separate duplicate-alias case and assert `ambiguities` contains both candidate IDs while neither appears in `stage2Refs`.

- [ ] **Step 4: Run the focused tests and confirm RED**

Run:

```bash
node --test tests/scene-context.test.js
```

Expected: FAIL because `resolvePromptReferenceContext` is not exported.

- [ ] **Step 5: Implement a shared text-resolution core and Stage 2 projection**

In `src/scene-context.js`, extract the mention grouping, ambiguity collection, correction application, and ordering currently embedded in `buildSceneContextSnapshot()` into a synchronous private helper. Parameterize whether roles are always included:

```js
function resolveEntitiesFromText({ text, candidates, corrections, alwaysIncludeRoles = [] }) {
    // Existing phraseRegex matching, ambiguity detection, corrections, and ordering.
    // Only roles listed in alwaysIncludeRoles bypass the text-match requirement.
    return { entities: orderedEntities, ambiguities };
}
```

Keep Stage 1 behavior stable by calling it with `alwaysIncludeRoles: ['char', 'user']`. Add the public Stage 2 contract with no always-included roles:

```js
/**
 * @param {{prompt:string,candidates:SceneEntity[],corrections:{includedIds:string[],excludedIds:string[],revision:number}}} input
 */
export function resolvePromptReferenceContext({ prompt, candidates, corrections }) {
    const resolved = resolveEntitiesFromText({
        text: String(prompt || ''),
        candidates,
        corrections,
        alwaysIncludeRoles: [],
    });
    return deepFreeze({
        promptHash: hashMessage(prompt),
        referencesRevision: corrections?.revision || 0,
        entities: resolved.entities,
        stage2Refs: resolved.entities
            .filter(entity => entity.imagePath && String(entity.imagePath).trim())
            .map(entity => ({
                id: entity.id,
                role: entity.role,
                name: entity.name,
                imagePath: String(entity.imagePath),
            })),
        ambiguities: resolved.ambiguities,
    });
}
```

Do not change `SceneContextSnapshot`, `messageHash`, `stage1Descriptions`, or its historical `stage2Refs` projection.

- [ ] **Step 6: Run resolver and draft regression tests**

Run:

```bash
node --test tests/scene-context.test.js tests/generation-drafts.test.js
```

Expected: PASS. Existing Stage 1 tests, including current `char`/`user` behavior, remain green.

- [ ] **Step 7: Commit the domain change**

```bash
git add src/scene-context.js tests/scene-context.test.js
git commit -m "feat: resolve Stage 2 refs from prompt"
```

Skip this commit if executing in the user's dirty `main` worktree; make commits only on an isolated feature branch/worktree.

## Task 2: Switch Manual and Automatic Stage 2 to Prompt-Derived Refs

**Files:**
- Modify: `src/pipeline.js:17-37,305-312,347-448`
- Test: `tests/pipeline-scene-first.test.js`

- [ ] **Step 1: Write a failing manual Stage 2 test**

In `tests/pipeline-scene-first.test.js`, create the pool records through the public library API so `buildCandidates()` sees the same cache as production:

```js
const { createRef } = await import('../src/refs-library.js');
await createRef({
    name: 'Aaron', aliases: [], description: 'red coat',
    imagePath: 'data:image/png;base64,iVBORw0KGgo=', keywords: [],
});
const beth = await createRef({
    name: 'Beth', aliases: [], description: 'blue dress',
    imagePath: 'data:image/png;base64,iVBORw0KGgo=', keywords: [],
});
```

Then arrange source text/prompt disagreement:

```js
test('manual Stage 2 sends refs matched by prompt instead of source message', async () => {
    await setupImageApi();
    // The returned Beth ID is asserted because createRef generates pool IDs.
    await updateGenerationDraft('chat-1', 4, 'Aaron enters.', draft => ({
        ...draft,
        prompt: 'Beth stands alone.',
        promptOrigin: 'manual',
    }));

    let sentRefs = null;
    await runStage2ForDraft(
        { chatId: 'chat-1', msgId: 4, messageText: 'Aaron enters.', templateId: null },
        () => {}, undefined,
        { onRefsSent: refs => { sentRefs = refs; } },
    );

    assert.deepEqual(sentRefs.map(ref => ref.id), ['beth']);
});
```

Use `mockFetch()` to return image blobs for reference URLs and PNG bytes for Pollinations output. Assert Aaron is absent even though the source message contains his name.

- [ ] **Step 2: Write failing correction and prompt-edit tests**

Add one test where prompt matches Aaron and Beth, `excludedIds: ['aaron']`, `includedIds: ['claire']`; assert provider refs are `claire`, then Beth. Add a second Stage 2 run after replacing the prompt and assert the newly resolved IDs change while corrections remain effective.

- [ ] **Step 3: Write failing automatic Stage 2 tests**

Add two `runFullPipelineForDraft()` cases:

```js
test('auto Stage 2 resolves refs from the Stage 1 result prompt', async () => {
    await setupTextApi();
    await setupImageApi();
    textResponse = 'Beth stands alone.';
    // Source contains Aaron, pool contains Aaron and Beth.
    // Capture on-provider reference loading/request behavior.
    const entry = await runFullPipelineForDraft({
        chatId: 'chat-1', msgId: 4, messageText: 'Aaron enters.', templateId: null,
    });
    assert.ok(entry);
    const draft = await getGenerationDraft('chat-1', 4, 'Aaron enters.');
    assert.deepEqual(draft.stage2.lastSubmittedSnapshot.refs.map(ref => ref.id), ['beth']);
    assert.deepEqual(draft.stage1.contextSnapshot.stage2Refs.map(ref => ref.id), ['aaron']);
});
```

This simultaneously verifies that the historical Stage 1 snapshot is not rewritten.

- [ ] **Step 4: Run focused pipeline tests and confirm RED**

Run:

```bash
node --test tests/pipeline-scene-first.test.js
```

Expected: FAIL because Stage 2 still materializes `contextSnapshot.stage2Refs`.

- [ ] **Step 5: Resolve Stage 2 refs after the final prompt update**

Update imports in `src/pipeline.js`:

```js
import {
    buildSceneContextSnapshot,
    normalizeSceneEntity,
    resolvePromptReferenceContext,
} from './scene-context.js';
```

In `runStage2ForDraft()`, after applying `opts.instruction` and checking the prompt, replace the Stage 1 snapshot rebuild block with:

```js
const candidates = await buildCandidates(chatId);
const referenceResolution = resolvePromptReferenceContext({
    prompt: draft.prompt,
    candidates,
    corrections: draft.references || { includedIds: [], excludedIds: [], revision: 0 },
});
```

Keep `opts.refs` as the explicit compatibility override. Otherwise materialize `referenceResolution`, whose `.stage2Refs` has the existing materializer shape:

```js
refs = await materializeStage2References(referenceResolution);
```

Do not write `referenceResolution` into `draft.stage1.contextSnapshot` and do not rebuild that snapshot based on correction revision during Stage 2.

- [ ] **Step 6: Make Stage 2 snapshot metadata independent of a missing Stage 1 snapshot**

Pass an explicit context-revision carrier to the existing snapshot function without persisting derived resolution:

```js
const submission = createStage2Snapshot({
    draft,
    contextSnapshot: {
        contextRevision: referenceResolution.referencesRevision,
    },
    refs,
});
```

For the `opts.refs` compatibility path, use `draft.references?.revision || 0`. Keep `createStage2Snapshot()` itself unchanged unless type checking requires broadening its JSDoc parameter to `{contextRevision:number}`.

- [ ] **Step 7: Make full auto call the explicit Stage 2 API**

Replace the compatibility bridge in `runFullPipelineForDraft()` with:

```js
return await runStage2ForDraft(input, onStatus, signal, { isAuto: true });
```

This ensures Stage 2 reads the prompt just applied by Stage 1 and preserves the existing auto-chain bypass semantics.

- [ ] **Step 8: Run pipeline and serialization tests**

Run:

```bash
node --test tests/pipeline-scene-first.test.js tests/pipeline-stage2-serialization.test.js tests/image-recovery.test.js
```

Expected: PASS. Manual FIFO behavior, auto bypass, immutable snapshots, queue identity, and gallery recovery remain green.

- [ ] **Step 9: Commit the pipeline change**

```bash
git add src/pipeline.js tests/pipeline-scene-first.test.js
git commit -m "fix: derive provider refs from current prompt"
```

Skip this commit in a dirty `main` worktree.

## Task 3: Add Pure Message-Scoped Correction Transitions

**Files:**
- Modify: `src/ui/tab-generate.js:26-74,330-381`
- Test: `tests/tab-generate.test.js`
- Test: `tests/generation-drafts.test.js`

- [ ] **Step 1: Write failing tests for correction transitions**

Export a pure helper named `updateReferenceCorrections` and add tests:

```js
test('include correction removes exclusion and increments revision', () => {
    const current = { includedIds: [], excludedIds: ['aaron'], revision: 2 };
    assert.deepEqual(updateReferenceCorrections(current, 'aaron', true), {
        includedIds: ['aaron'], excludedIds: [], revision: 3,
    });
});

test('exclude correction removes inclusion and increments revision', () => {
    const current = { includedIds: ['aaron'], excludedIds: [], revision: 7 };
    assert.deepEqual(updateReferenceCorrections(current, 'aaron', false), {
        includedIds: [], excludedIds: ['aaron'], revision: 8,
    });
});
```

Also test duplicate calls do not duplicate IDs and missing arrays are normalized.

- [ ] **Step 2: Run the UI helper test and confirm RED**

Run:

```bash
node --test tests/tab-generate.test.js
```

Expected: FAIL because `updateReferenceCorrections` is not exported.

- [ ] **Step 3: Implement the pure transition helper**

Add near the existing pure view helpers:

```js
export function updateReferenceCorrections(current, candidateId, include) {
    const included = new Set(current?.includedIds || []);
    const excluded = new Set(current?.excludedIds || []);
    if (include) {
        included.add(candidateId);
        excluded.delete(candidateId);
    } else {
        excluded.add(candidateId);
        included.delete(candidateId);
    }
    return {
        includedIds: Array.from(included),
        excludedIds: Array.from(excluded),
        revision: (current?.revision || 0) + 1,
    };
}
```

Refactor the async draft updater to call this helper. Remove the block that rebuilds and writes `stage1.contextSnapshot`; a prompt reference correction must not mutate historical Stage 1 input.

- [ ] **Step 4: Add a persistence regression test**

In `tests/generation-drafts.test.js`, update one draft with `updateReferenceCorrections`, reload it, and assert corrections persist only for that `chatId + msgId`; a second message remains at empty defaults.

- [ ] **Step 5: Run correction and persistence tests**

Run:

```bash
node --test tests/tab-generate.test.js tests/generation-drafts.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit the correction helper**

```bash
git add src/ui/tab-generate.js tests/tab-generate.test.js tests/generation-drafts.test.js
git commit -m "feat: persist message reference corrections"
```

Skip this commit in a dirty `main` worktree.

## Task 4: Render Prompt-Driven Preview and Interactive `+`/`x`

**Files:**
- Modify: `src/ui/tab-generate.js:40-213,221-328,421-713`
- Modify: `style.css:459-510`
- Test: `tests/tab-generate.test.js`

- [ ] **Step 1: Write failing view-model tests for separate Stage 1 and Stage 2 inputs**

Change test helpers to pass `referenceResolution`. Replace the old snapshot-driven expectation with:

```js
test('view model keeps Stage 1 descriptions separate from prompt refs', () => {
    const stage1Snapshot = {
        entities: [{ id: 'aaron', name: 'Aaron' }],
        stage1Descriptions: [{ id: 'aaron', name: 'Aaron', description: 'red coat' }],
        stage2Refs: [{ id: 'aaron', role: 'npc', name: 'Aaron', imagePath: '/aaron.png' }],
        ambiguities: [],
    };
    const referenceResolution = {
        entities: [{ id: 'beth', name: 'Beth' }],
        stage2Refs: [{ id: 'beth', role: 'npc', name: 'Beth', imagePath: '/beth.png' }],
        ambiguities: [],
    };
    const messageText = 'source scene';
    const matchingDraft = {
        prompt: 'Beth stands alone.', promptOrigin: 'stage1',
        messageHash: hashMessage(messageText),
        aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
    };
    const vm = buildGenerateViewModel({
        draft: matchingDraft,
        snapshot: stage1Snapshot,
        referenceResolution,
        automationMode: 'manual', templates: [], messageText,
    });
    assert.deepEqual(vm.descriptions, stage1Snapshot.stage1Descriptions);
    assert.deepEqual(vm.refs, referenceResolution.stage2Refs);
    assert.deepEqual(vm.ambiguities, referenceResolution.ambiguities);
});
```

- [ ] **Step 2: Write failing preview markup tests**

Export `renderReferencePreviewMarkup(refs)` and assert it renders:

```js
const markup = renderReferencePreviewMarkup([
    { id: 'beth', role: 'npc', name: 'Beth', imagePath: '/beth.png' },
]);
assert.match(markup, /data-ref-id="beth"/);
assert.match(markup, /uris-effective-ref-remove/);
assert.match(markup, /fa-xmark/);
```

Also assert the empty state and a stable count label. Assert `renderGenerateMarkup()` includes a prompt-first add button `#urisAddEffectiveRef` next to `#urisRefsPreview`.

- [ ] **Step 3: Run UI tests and confirm RED**

Run:

```bash
node --test tests/tab-generate.test.js
```

Expected: FAIL because the view model and preview are still Stage 1 snapshot-driven.

- [ ] **Step 4: Resolve prompt refs during Generate render**

Import `resolvePromptReferenceContext` and build a small UI-only resolver wrapper:

```js
async function resolveDraftPromptReferences(chatId, draft) {
    const candidates = await buildCandidates(chatId);
    return resolvePromptReferenceContext({
        prompt: draft.prompt,
        candidates,
        corrections: draft.references || { includedIds: [], excludedIds: [], revision: 0 },
    });
}
```

In `render(root)`, compute `referenceResolution` separately and pass it to both `buildGenerateViewModel()` and `renderRefsStatus()`. Update `buildGenerateViewModel()` so `descriptions` comes from `snapshot`, while `refs`, `ambiguities`, and reference entities come from `referenceResolution`.

- [ ] **Step 5: Replace snapshot-driven live preview**

Implement the pure renderer:

```js
export function renderReferencePreviewMarkup(refs) {
    if (!refs.length) {
        return '<small class="uris-refs-empty">референсы не отправятся</small>';
    }
    return `<span class="uris-refs-empty">Уйдет (${refs.length}/${MAX_REFS}):</span>` + refs.map(ref => {
        const label = ref.role === 'char' ? '{{char}}' : ref.role === 'user' ? '{{user}}' : ref.name || 'NPC';
        const thumb = ref.imagePath
            ? `<img src="${escapeHtml(ref.imagePath)}" alt="${escapeHtml(ref.name || '')}">`
            : `<span class="uris-ref-chip-icon"><i class="fa-solid fa-user"></i></span>`;
        return `<div class="uris-ref-chip-preview" data-ref-id="${escapeHtml(ref.id)}" title="${escapeHtml(label)}">` +
            `${thumb}<span class="uris-ref-role">${escapeHtml(ref.role)}</span>` +
            `<button class="uris-effective-ref-remove" title="Убрать референс"><i class="fa-solid fa-xmark"></i></button></div>`;
    }).join('');
}
```

Make `renderLivePreview(root, referenceResolution)` assign this markup directly. It must never fall back to `draft.stage1.contextSnapshot`.

- [ ] **Step 6: Add message-scoped remove and add bindings**

Add `#urisAddEffectiveRef` to the reference-panel header. Bind remove clicks through the existing panel event delegation and call the correction updater with `include = false`.

For add:

```js
const effectiveIds = referenceResolution.stage2Refs.map(ref => ref.id);
const chosen = await showPoolPicker({
    title: 'Добавить референс Stage 2',
    multi: true,
    excludeIds: effectiveIds,
});
for (const refId of chosen || []) {
    await applyReferenceCorrection(root, refId, true);
}
```

Batch multiple chosen IDs in one `updateGenerationDraft()` call so `references.revision` increments once and the tab rerenders once. Do not call `saveChatRefs()` and do not mutate `extraRefIds` or `descRefs`.

- [ ] **Step 7: Refresh preview after prompt autosave**

Capture `chatId` and `msgId` inside each autosave invocation, save the prompt, then verify the user has not navigated before updating the current panel:

```js
const savedDraft = await updateGenerationDraft(chatId, msgId, messageText, updater);
if (getCtx().chatId === chatId && state.currentMsgId === msgId) {
    const resolution = await resolveDraftPromptReferences(chatId, savedDraft);
    await renderLivePreview(root, resolution);
    renderPromptAmbiguities(root, resolution);
}
```

Extract and export `renderPromptAmbiguities(root, resolution)`. It must rebuild only `.uris-scene-context` from `resolution.ambiguities` and `resolution.entities`, then reattach the existing delegated include/exclude handler to that host. Call it after autosave so prompt edits update ambiguities without replacing the textarea or moving focus. Pipeline remains the authoritative final recalculation before provider submission.

- [ ] **Step 8: Retire misleading effective-set legacy controls from the primary panel**

Remove the calls to `renderExtrasChips()` and `renderDescRefsChips()` from the primary prompt-first status flow, or move those legacy controls under an explicitly labelled compatibility/advanced block. The effective `+` control must be the only add action adjacent to `#urisRefsPreview`. Keep slot configuration available because `buildCandidates()` still uses pinned slot definitions, but do not present `extraRefIds` as refs that automatically enter the new effective set.

- [ ] **Step 9: Add stable interactive chip styles**

Extend `style.css` near `.uris-ref-chip-preview`:

```css
.uris-ref-chip-preview {
    position: relative;
    width: 44px;
    height: 44px;
    flex: 0 0 44px;
}

.uris-effective-ref-remove {
    position: absolute;
    top: 1px;
    right: 1px;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 3px;
    display: grid;
    place-items: center;
}
```

Match existing panel colors and focus styles; do not introduce a new palette or nested card.

- [ ] **Step 10: Run UI and domain tests**

Run:

```bash
node --test tests/tab-generate.test.js tests/scene-context.test.js tests/generation-drafts.test.js
```

Expected: PASS.

- [ ] **Step 11: Commit the UI change**

```bash
git add src/ui/tab-generate.js style.css tests/tab-generate.test.js
git commit -m "feat: edit effective Stage 2 references"
```

Skip this commit in a dirty `main` worktree.

## Task 5: Verify Provider Boundaries and Regressions

**Files:**
- Test: `tests/pipeline-scene-first.test.js`
- Test: `tests/refs-library.test.js`
- Test: `tests/references.test.js`
- Test: `tests/image-recovery.test.js`
- Verify: all changed source files

- [ ] **Step 1: Add the final provider-boundary regression**

Add a pipeline test with more refs than the active provider supports. Assert `draft.stage2.lastSubmittedSnapshot.refs` records the materialized effective set used as provider input, while existing `generateImageRequest()` capability handling performs any provider-specific truncation/warning. Do not implement limits in `resolvePromptReferenceContext()`.

Also assert changing prompt-first corrections does not change `getChatRefs().extraRefIds` or `descRefs`.

- [ ] **Step 2: Run syntax checks**

Run:

```bash
node --check src/scene-context.js
node --check src/pipeline.js
node --check src/ui/tab-generate.js
```

Expected: all commands exit 0 with no output.

- [ ] **Step 3: Run the focused regression suite**

Run:

```bash
node --test tests/scene-context.test.js tests/generation-drafts.test.js tests/pipeline-scene-first.test.js tests/pipeline-stage2-serialization.test.js tests/tab-generate.test.js tests/refs-library.test.js tests/references.test.js tests/image-recovery.test.js
```

Expected: all tests pass; no unhandled rejection or leaked queue task.

- [ ] **Step 4: Run the full automated suite**

Run:

```bash
node --test tests/*.test.js
```

Expected: all tests pass. The repository has no `package.json`, so do not use `npm test` or add package metadata for this feature.

- [ ] **Step 5: Inspect the final diff**

Run:

```bash
git diff --check
git diff --stat
git status --short
```

Expected: no whitespace errors. Confirm only scoped source/tests/styles/spec/plan files changed and preserve all pre-existing user changes.

- [ ] **Step 6: Perform a manual Generate-tab smoke check**

In SillyTavern with an NPC reference named Aaron:

1. Select a post that names Aaron.
2. Build a Stage 1 prompt that omits Aaron; verify Aaron is absent from `#urisRefsPreview`.
3. Type Aaron into the prompt; after autosave, verify his chip appears without rebuilding Stage 1.
4. Click `x`; verify the chip disappears and stays absent after removing/retyping the name.
5. Click `+`; select a different pool NPC not named in the prompt; verify it appears and survives another prompt edit.
6. Generate an image; verify the submitted Stage 2 snapshot contains exactly the visible effective refs subject to the active provider capability.
7. Switch messages and return; verify corrections stayed with the original message.

Expected: preview, saved corrections, immutable submission snapshot, and provider request agree.

- [ ] **Step 7: Commit final regressions when working on a feature branch**

```bash
git add tests/pipeline-scene-first.test.js tests/refs-library.test.js tests/references.test.js tests/image-recovery.test.js
git commit -m "test: cover prompt-driven reference flow"
```

Do not commit or push from the current dirty `main` worktree unless the user explicitly requests it.
