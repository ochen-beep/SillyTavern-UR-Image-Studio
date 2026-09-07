# Persistent Prompt Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep manual Stage 1 prompt construction/rebuilding available at all times while exposing Stage 2 as an independent action whenever a nonempty prompt exists.

**Architecture:** Replace the Generate tab's single prompt-dependent action with two explicit action capabilities represented by the view model: a Stage 1 action whose label changes from build to rebuild, and a Stage 2 action enabled only for nonempty current prompts. Bind each button directly to its pipeline stage, preserving existing draft persistence, busy handling, status reporting, and rerender behavior.

**Tech Stack:** JavaScript ES modules with `// @ts-check`, Node built-in `node:test`, SillyTavern DOM integration, existing Font Awesome and Generate-tab styles.

---

## File Map

- Modify `src/ui/tab-generate.js`: replace the unreachable `rebuild-prompt` primary-action contract with explicit Stage 1/Stage 2 view state, render independent controls, and bind each control directly to the matching pipeline function.
- Modify `tests/tab-generate.test.js`: add regression coverage for empty, generated, manual, and stale prompts and for the two independent operation paths.
- Modify `style.css` only if focused verification shows the existing `.uris-gen-actions` flex rules do not lay out two buttons correctly; do not introduce unrelated visual changes.
- Read-only regression boundaries: `src/pipeline.js`, `src/generation-drafts.js`, and prompt-driven reference modules. Their contracts already support rerunning Stage 1 and running Stage 2 independently.

## Task 1: Define Explicit Prompt Action State

**Files:**
- Modify: `tests/tab-generate.test.js:24-78`
- Modify: `src/ui/tab-generate.js:26-80`

- [ ] **Step 1: Replace primary-action tests with failing explicit action-state tests**

Update the helper import to use `decidePromptActions` instead of `decidePrimaryAction`:

```js
const { state } = await import('../src/core.js');
const { POST_FILTER } = await import('../src/post-navigator.js');
const { hashMessage } = await import('../src/generation-drafts.js');
const {
    decidePromptActions,
    buildGenerateViewModel,
    renderGenerateMarkup,
    enqueueCurrent,
    updateReferenceCorrections,
    renderReferencePreviewMarkup,
} = await import('../src/ui/tab-generate.js');
```

Replace the three `decidePrimaryAction` tests with:

```js
test('decidePromptActions offers Stage 1 build and disables Stage 2 for an empty prompt', () => {
    assert.deepEqual(decidePromptActions({ prompt: '', promptOrigin: 'empty' }), {
        stage1Action: 'build-prompt',
        canGenerateImage: false,
    });
});

test('decidePromptActions offers rebuild and Stage 2 for a generated prompt', () => {
    assert.deepEqual(decidePromptActions({ prompt: 'a cat', promptOrigin: 'stage1' }), {
        stage1Action: 'rebuild-prompt',
        canGenerateImage: true,
    });
});

test('decidePromptActions offers rebuild without confirmation for a manual prompt', () => {
    assert.deepEqual(decidePromptActions({ prompt: 'a cat', promptOrigin: 'manual' }), {
        stage1Action: 'rebuild-prompt',
        canGenerateImage: true,
    });
});
```

Update the stale and matching-draft assertions:

```js
assert.equal(vm.stage1Action, 'rebuild-prompt');
assert.equal(vm.canGenerateImage, true);
```

The stale badge remains informational; because the visible draft still contains a prompt, Stage 1 is a rebuild and Stage 2 remains available for that visible text.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
node --test tests/tab-generate.test.js
```

Expected: FAIL because `decidePromptActions` is not exported and the view model does not expose `stage1Action` or `canGenerateImage`.

- [ ] **Step 3: Implement the minimal pure action-state helper**

Replace `decidePrimaryAction` in `src/ui/tab-generate.js` with:

```js
/**
 * Decide the independent Stage 1 and Stage 2 actions from the visible prompt.
 *
 * @param {import('../generation-drafts.js').GenerationDraft} draft
 * @returns {{stage1Action:'build-prompt'|'rebuild-prompt',canGenerateImage:boolean}}
 */
export function decidePromptActions(draft) {
    const hasPrompt = Boolean(draft?.prompt?.trim());
    return {
        stage1Action: hasPrompt ? 'rebuild-prompt' : 'build-prompt',
        canGenerateImage: hasPrompt,
    };
}
```

In `buildGenerateViewModel`, replace `primaryAction` construction and return with:

```js
const promptActions = decidePromptActions(normalizedDraft);
```

and:

```js
stage1Action: promptActions.stage1Action,
canGenerateImage: promptActions.canGenerateImage,
```

Do not special-case stale drafts in action selection. `isStale` continues to drive only the stale badge.

- [ ] **Step 4: Run the focused tests and verify the pure state tests pass**

Run:

```bash
node --test tests/tab-generate.test.js
```

Expected: action-state and view-model tests PASS; markup tests that still expect the old primary button may fail until Task 2.

- [ ] **Step 5: Review the diff without committing**

Run:

```bash
git diff -- src/ui/tab-generate.js tests/tab-generate.test.js
```

Expected: only the action-state helper, view-model fields, and their tests have changed. Do not commit unless the user separately asks.

## Task 2: Render Independent Stage 1 and Stage 2 Controls

**Files:**
- Modify: `tests/tab-generate.test.js:119-147`
- Modify: `src/ui/tab-generate.js:170-215`
- Inspect/possibly modify: `style.css` existing `.uris-gen-actions` rule

- [ ] **Step 1: Write failing markup regression tests**

Replace the old primary-action markup test with:

```js
test('renderGenerateMarkup shows only prompt building as runnable when prompt is empty', () => {
    const messageText = 'message text';
    const draft = {
        prompt: '', promptOrigin: 'empty', aspectRatio: '9:16', imageSize: '2K',
        quality: 'high', templateId: null, messageHash: hashMessage(messageText),
    };
    const markup = renderGenerateMarkup(baseVm({ draft, messageText }));

    assert.match(markup, /id="urisBuildPrompt"/);
    assert.match(markup, /Построить промпт/);
    assert.match(markup, /id="urisGenerateImage"[^>]*disabled/);
    assert.doesNotMatch(markup, /id="urisPrimaryGenerate"/);
});

test('renderGenerateMarkup keeps rebuild and image generation available for generated prompt', () => {
    const messageText = 'message text';
    const draft = {
        prompt: 'a cat', promptOrigin: 'stage1', aspectRatio: '9:16', imageSize: '2K',
        quality: 'high', templateId: null, messageHash: hashMessage(messageText),
    };
    const markup = renderGenerateMarkup(baseVm({ draft, messageText }));

    assert.match(markup, /id="urisBuildPrompt"/);
    assert.match(markup, /Перестроить промпт/);
    assert.match(markup, /id="urisGenerateImage"/);
    assert.doesNotMatch(markup, /id="urisGenerateImage"[^>]*disabled/);
    assert.match(markup, /Сгенерировать/);
});

test('renderGenerateMarkup keeps rebuild available for manually edited prompt', () => {
    const messageText = 'message text';
    const draft = {
        prompt: 'manual cat', promptOrigin: 'manual', aspectRatio: '9:16', imageSize: '2K',
        quality: 'high', templateId: null, messageHash: hashMessage(messageText),
    };
    const markup = renderGenerateMarkup(baseVm({ draft, messageText }));

    assert.match(markup, /Перестроить промпт/);
    assert.match(markup, /Сгенерировать/);
    assert.doesNotMatch(markup, /confirm|Подтверд/i);
});
```

Update the stale markup test to expect the stale badge plus `Перестроить промпт` because its visible prompt is nonempty.

- [ ] **Step 2: Run markup tests and verify they fail**

Run:

```bash
node --test tests/tab-generate.test.js
```

Expected: FAIL because `#urisBuildPrompt` and `#urisGenerateImage` are not rendered and `#urisPrimaryGenerate` still exists.

- [ ] **Step 3: Render the two controls from explicit state**

In `renderGenerateMarkup`, destructure `stage1Action` and `canGenerateImage` instead of `primaryAction`, then derive:

```js
const stage1Label = stage1Action === 'build-prompt' ? 'Построить промпт' : 'Перестроить промпт';
const generateDisabledAttr = isRunning || !canGenerateImage ? ' disabled' : '';
```

Replace the old action markup with:

```html
<div class="uris-gen-actions">
    <button class="menu_button" id="urisBuildPrompt"${runningAttr}>
        <i class="fa-solid fa-wand-magic-sparkles"></i> ${stage1Label}
    </button>
    <button class="menu_button" id="urisGenerateImage"${generateDisabledAttr}>
        <i class="fa-solid fa-image"></i> Сгенерировать
    </button>
</div>
```

Ensure attributes have valid spacing by keeping `runningAttr` and `generateDisabledAttr` as either `''` or `' disabled'` and not adding a duplicate literal `disabled`.

- [ ] **Step 4: Run focused tests and verify markup passes**

Run:

```bash
node --test tests/tab-generate.test.js
```

Expected: all pure and markup tests PASS except any integration-style handler tests added in Task 3.

- [ ] **Step 5: Inspect existing layout before changing CSS**

Search and inspect `.uris-gen-actions`:

```bash
git grep -n "uris-gen-actions" -- style.css src tests
```

If its existing flex/wrap/button rules already support two buttons, make no CSS change. If the buttons overflow, add only:

```css
.uris-gen-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}
.uris-gen-actions .menu_button {
    flex: 1 1 180px;
}
```

- [ ] **Step 6: Review the diff without committing**

Run:

```bash
git diff -- src/ui/tab-generate.js tests/tab-generate.test.js style.css
```

Expected: the action container now has two explicit controls; no unrelated UI or reference-panel changes. Do not commit unless requested.

## Task 3: Bind Each Button Directly to Its Pipeline Stage

**Files:**
- Modify: `src/ui/tab-generate.js:323-430`
- Modify: `tests/tab-generate.test.js`

- [ ] **Step 1: Extract and test the shared current-draft input preparation**

Export a focused helper that can be tested without a full browser DOM:

```js
export function readGenerationParams(root, draft) {
    return {
        ...draft,
        aspectRatio: root.querySelector('#urisAspect')?.value || draft.aspectRatio,
        imageSize: root.querySelector('#urisImgSize')?.value || draft.imageSize,
        quality: root.querySelector('#urisQuality')?.value || draft.quality,
    };
}
```

First add it to the test import and write:

```js
test('readGenerationParams preserves draft while reading visible Stage 2 controls', () => {
    const values = { '#urisAspect': '16:9', '#urisImgSize': '4K', '#urisQuality': 'high' };
    const root = { querySelector: selector => values[selector] ? { value: values[selector] } : null };
    const draft = { prompt: 'cat', aspectRatio: '1:1', imageSize: '1K', quality: 'auto' };

    assert.deepEqual(readGenerationParams(root, draft), {
        prompt: 'cat', aspectRatio: '16:9', imageSize: '4K', quality: 'high',
    });
});
```

Run `node --test tests/tab-generate.test.js` before implementation and expect `readGenerationParams is not a function`; implement the helper; rerun and expect PASS.

- [ ] **Step 2: Replace the multiplexed primary handler with an explicit Stage 1 handler**

Create a local input-preparation function inside `bindGenerate` to preserve current draft/template behavior:

```js
async function prepareRunInput() {
    const ctx = getCtx();
    const msgId = state.currentMsgId;
    if (msgId == null) {
        toastr?.warning('Нет поста');
        return null;
    }
    const messageText = ctx.chat?.[msgId]?.mes || '';
    const currentDraft = await getGenerationDraft(ctx.chatId, msgId, messageText);
    const templateId = resolveDraftTemplateId(currentDraft, state.activeTemplateId);
    await updateGenerationDraft(ctx.chatId, msgId, messageText, d => readGenerationParams(root, d));
    return { chatId: ctx.chatId, msgId, messageText, templateId };
}
```

Bind `#urisBuildPrompt` directly:

```js
const buildPromptButton = root.querySelector('#urisBuildPrompt');
buildPromptButton?.addEventListener('click', withBusy(buildPromptButton, async () => {
    const input = await prepareRunInput();
    if (!input) return;
    try {
        setStatus('Построение промпта...');
        const run = await runStage1ForDraft(input, s => setStatus(s));
        if (run.applied) {
            notifyStage1Ready(run.draft.prompt);
            setStatus('Промпт готов');
            toastr?.success('Промпт построен');
        }
    } catch (e) {
        error('Stage 1:', e.message);
        toastr?.error(e.message);
        setStatus('');
    }
    await render(root);
}));
```

Do not call `confirm()` and do not branch on `promptOrigin`; the requested overwrite behavior is unconditional.

- [ ] **Step 3: Bind `#urisGenerateImage` directly to Stage 2**

```js
const generateImageButton = root.querySelector('#urisGenerateImage');
generateImageButton?.addEventListener('click', withBusy(generateImageButton, async () => {
    const input = await prepareRunInput();
    if (!input) return;
    try {
        setStatus('Генерация изображения...');
        await runStage2ForDraft(input, s => setStatus(s));
        setStatus('Готово');
        toastr?.success('Картинка сгенерирована');
        if (getActiveTab() === 'gallery') refreshActive();
    } catch (e) {
        error('Stage 2:', e.message);
        toastr?.error(e.message);
        setStatus('');
    }
    await render(root);
}));
```

Delete the old `#urisPrimaryGenerate` handler and all `decidePrimaryAction(draft)` dispatch logic.

- [ ] **Step 4: Add static regression assertions for direct event targets**

Because this test file uses lightweight DOM stubs rather than jsdom, add a source-level regression test following the repository's existing static test style:

```js
import { readFile } from 'node:fs/promises';

const tabGenerateSource = await readFile(new URL('../src/ui/tab-generate.js', import.meta.url), 'utf8');

test('Generate tab binds Stage 1 and Stage 2 to independent controls', () => {
    assert.match(tabGenerateSource, /querySelector\('#urisBuildPrompt'\)/);
    assert.match(tabGenerateSource, /querySelector\('#urisGenerateImage'\)/);
    assert.doesNotMatch(tabGenerateSource, /querySelector\('#urisPrimaryGenerate'\)/);
    assert.doesNotMatch(tabGenerateSource, /decidePrimaryAction/);
});
```

Run:

```bash
node --test tests/tab-generate.test.js
```

Expected: PASS with both direct action targets covered.

- [ ] **Step 5: Run all directly related suites**

Run:

```bash
node --test tests/tab-generate.test.js tests/generation-drafts.test.js tests/pipeline-scene-first.test.js tests/events.test.js
```

Expected: all tests PASS. Any failure involving automation naming is pre-existing and outside this fix only if it reproduces on the unchanged `main`; do not silently ignore a new regression.

- [ ] **Step 6: Review the complete implementation diff without committing**

Run:

```bash
git diff --check
git diff -- src/ui/tab-generate.js tests/tab-generate.test.js style.css docs/superpowers/specs/2026-07-16-persistent-prompt-rebuild-design.md docs/superpowers/plans/2026-07-16-persistent-prompt-rebuild-implementation.md
```

Expected: no whitespace errors; implementation is limited to independent Generate-tab controls, tests, and approved documentation. Do not stage or commit unrelated untracked files.

## Task 4: Manual UI Verification

**Files:**
- No source changes expected

- [ ] **Step 1: Identify the project runtime command**

Inspect repository scripts/configuration without installing or upgrading dependencies. Use the existing development workflow documented by the project.

- [ ] **Step 2: Verify the empty-prompt state**

Open the Generate tab on a message without a prompt and confirm:

- `Построить промпт` is visible and enabled;
- `Сгенерировать` is disabled;
- clicking Stage 1 generates and saves a prompt.

- [ ] **Step 3: Verify the post-Stage-1 rerender state**

After Stage 1 finishes, confirm:

- the prompt textarea contains the result;
- `Перестроить промпт` remains visible;
- `Сгенерировать` is enabled;
- clicking `Перестроить промпт` replaces the prompt and leaves both actions visible afterward.

- [ ] **Step 4: Verify unconditional manual-prompt replacement**

Edit the prompt, wait for autosave, click `Перестроить промпт`, and confirm there is no confirmation dialog and the Stage 1 result replaces the manual text.

- [ ] **Step 5: Verify Stage 2 isolation**

Click `Сгенерировать` and confirm the visible prompt is submitted to Stage 2 without a preceding Stage 1 run; after completion, both actions remain available.

## Task 5: Final Verification

**Files:**
- No source changes expected

- [ ] **Step 1: Run the repository's complete test command**

If `package.json` defines a test script, run it. Otherwise run:

```bash
node --test tests/*.test.js
```

Expected: all tests PASS.

- [ ] **Step 2: Run syntax and whitespace checks**

Run:

```bash
node --check src/ui/tab-generate.js
git diff --check
```

Expected: both commands exit successfully with no output.

- [ ] **Step 3: Inspect final status and diff summary**

Run:

```bash
git status --short
git diff --stat
git diff -- src/ui/tab-generate.js tests/tab-generate.test.js style.css
```

Expected: only intended tracked files are modified; pre-existing untracked plan/spec files remain untouched except the two documents created for this task.

- [ ] **Step 4: Report evidence without committing**

Report the exact test counts, manual verification result or reason it could not be run, changed files, and any pre-existing failures. Do not commit, merge, or push unless the user explicitly requests it.
