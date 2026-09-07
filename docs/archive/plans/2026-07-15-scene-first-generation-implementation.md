# Scene-First Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mutable template-first generation flow with a scene-first `scene → editable prompt → image` flow that uses one message-scoped draft and one immutable context snapshot while preserving existing user data and compatibility formats.

**Architecture:** Add focused draft, scene-resolution, and template-runtime modules beside the current modules, then expose snapshot-safe pipeline entry points while retaining the old exports as compatibility wrappers. Cut the UI and event callers over only after storage, template, reference, pipeline, recovery, and settings compatibility is covered by tests; remove only dead runtime/UI branches in the final checkpoint, never persisted user records.

**Tech Stack:** Vanilla JavaScript ES modules, `// @ts-check`, JSDoc types, SillyTavern extension APIs, browser `localforage`, Node.js 24 built-in `node:test`, `node:assert/strict`, HTML strings, CSS.

---

## Execution prerequisites

The repository root is `D:\VC CODE\UR Image Studio`. There is no `package.json`; do not run npm commands. The only test command in this plan is:

```bash
node --test tests/*.test.js
```

`main` is dirty and contains unrelated untracked files. Before Task 1, use `superpowers:using-git-worktrees` and create an isolated worktree from the current `HEAD` on a feature branch, for example:

```bash
git worktree add "../UR Image Studio-scene-first" -b feature/scene-first-generation HEAD
git -C "../UR Image Studio-scene-first" status --short --branch
node --test tests/*.test.js
```

Expected: the status reports `feature/scene-first-generation`; the baseline suite passes. Run every remaining command inside that worktree. Never use `git add .`, `git add -A`, or `git commit -a`; each commit command below names only its feature files, so these unrelated files from dirty `main` cannot enter execution commits:

- `.zcode/plans/plan-sess_7a04f941-abcc-41cf-aabc-a3621db14bac.md`
- `docs/plans/2026-07-14-references-chat-scoped-pool-implementation.md`
- `docs/plans/2026-07-14-references-chat-scoped-pool.md`
- `docs/superpowers/specs/2026-07-15-scene-first-generation-design.md`
- `tests-output.log`

After every commit, run `git status --short` and confirm that no unrelated path is staged. Do not copy the dirty working tree into the worktree.

## File structure map

### New focused modules and tests

- `src/generation-drafts.js` — owns `GenerationDraft`, message hashing, `chatId + msgId` keys, legacy chat-draft migration, stale-state reset, and immutable Stage 2 submission snapshots.
- `src/scene-context.js` — owns strict canonical-name/alias matching, ambiguity handling, deterministic entity ordering, and construction/materialization of the one `SceneContextSnapshot` shared by UI and both stages.
- `src/template-runtime.js` — classifies base/instruction/fields/schema-v3 templates, validates new template shapes, builds deterministic Stage 1 prompts, assembles fields output, and locally normalizes the single LLM response.
- `tests/generation-drafts.test.js` — draft scope, migration, stale messages, immutable Stage 2 snapshots.
- `tests/scene-context.test.js` — strict matching, aliases, ambiguity, corrections, ordering, shared snapshot shape.
- `tests/template-runtime.test.js` — template classification, empty-content behavior, deterministic fields assembly, legacy-v3 dispatch, one-request contract.
- `tests/pipeline-scene-first.test.js` — snapshot-safe Stage 1/Stage 2 APIs, compatibility wrappers, queue identity and race handling.
- `tests/settings-migration.test.js` — global and bundle migration from the two old mode selectors to one automation enum.

### Existing modules modified

- `src/core.js:1-220` — add localforage key constants, automation defaults/migration, and only the state fields needed by compatibility wrappers.
- `src/storage.js:1-190` — retain `getInstruction(chatId)`/`setInstruction(chatId, instr)` as legacy readers; delegate new draft operations to `generation-drafts.js` without deleting old keys.
- `src/refs-library.js:1-420` — preserve pool/chat-binding readers and keywords for library search; normalize additive `aliases`; delegate scene-presence decisions to `scene-context.js` only after caller cutover.
- `src/references.js:1-220` — materialize resolved entities into provider-ready reference records.
- `src/prompt-templates.js:1-250` — preserve stored schema-v3 records byte-for-byte; add instruction/fields creation and copy APIs with explicit types.
- `src/stage1-adapter.js:1-240` — retain local legacy parsing but remove the hidden text-model normalization request.
- `src/pipeline.js:1-520` — add snapshot-safe APIs and queue item shape, then keep old `runStage1`, `runStage2`, `runFullPipeline`, and `enqueue` wrappers until final cleanup.
- `src/image-api.js:1-180` — accept one provider-independent request object internally while preserving the positional compatibility export during caller migration.
- `src/image-recovery.js:1-260` — persist complete Stage 2 snapshots additively and accept old pending entries without that field.
- `src/storage.js:190-420` and gallery conversion code called by `src/image-recovery.js` — preserve old gallery readers and add `stage2Snapshot` to new entries.
- `src/bundles.js:1-260` — migrate old per-bundle modes non-destructively and persist one automation value.
- `src/events.js:1-190` — use the single automation enum and preserve source message identity.
- `index.js:1-260` — switch lifecycle/auto callers to snapshot-safe pipeline APIs; stop auto-creating a stored default template only after base mode exists.
- `src/ui/tab-generate.js:1-end` — become a prompt-first renderer/controller over message-scoped drafts and one shared snapshot.
- `src/ui/tab-templates.js:1-end` — expose instruction/fields creation, legacy-v3 label/copy, and gated experimental creation.
- `src/ui/tab-references.js:1-205` — edit explicit aliases separately from search keywords.
- `style.css:95-107,235-end` — style prompt-first cards, reference states, ambiguity controls, stale/error states, and template editors.
- `tests/stage1-adapter.test.js:1-117` — prove local parsing does not call a text provider.
- `tests/refs-library.test.js:matching and CRUD sections` — preserve legacy readers while moving scene-presence assertions to the strict resolver suite.
- `tests/pipeline-stage2-serialization.test.js:1-199` — retain same-message FIFO, auto bypass, cleanup, and abort isolation.
- `tests/image-recovery.test.js:60-227` — cover additive snapshot persistence and old pending records.
- `tests/events.test.js:39-180` — cover automation migration and message identity.

## Canonical contracts used by every task

All new runtime records use these exact JSDoc shapes. Later tasks must import or reference these names rather than creating variants.

```js
/** @typedef {'base'|'instruction'|'fields'|'legacy-v3'} TemplateType */
/** @typedef {'manual'|'build-prompt'|'full-pipeline'} AutomationMode */

/** @typedef {{
 * id:string,
 * role:'char'|'user'|'npc',
 * name:string,
 * aliases:string[],
 * description:string,
 * imagePath:string
 * }} SceneEntity */

/** @typedef {{includedIds:string[], excludedIds:string[], revision:number}} ReferenceCorrections */

/** @typedef {{
 * chatId:string,
 * msgId:number,
 * messageHash:string,
 * contextRevision:number,
 * entities:SceneEntity[],
 * stage1Descriptions:Array<{id:string,name:string,description:string}>,
 * stage2Refs:Array<{id:string,role:'char'|'user'|'npc',name:string,imagePath:string}>,
 * ambiguities:Array<{mention:string,candidateIds:string[]}>,
 * lorebookEntries:Array<{uid:string|number,content:string}>
 * }} SceneContextSnapshot */

/** @typedef {{
 * prompt:string,
 * templateId:string|null,
 * templateType:TemplateType,
 * structuredDraft:object|null,
 * sourceMsgId:number,
 * contextRevision:number,
 * raw:string|null
 * }} Stage1Result */

/** @typedef {{
 * chatId:string,
 * msgId:number,
 * messageHash:string,
 * templateId:string|null,
 * prompt:string,
 * promptOrigin:'empty'|'legacy-chat'|'stage1'|'manual',
 * aspectRatio:string,
 * imageSize:string,
 * quality:string,
 * references:ReferenceCorrections,
 * stage1:{status:'idle'|'running'|'ready'|'error',structuredDraft:object|null,contextSnapshot:SceneContextSnapshot|null,builtAt:string|null,error:string|null},
 * stage2:{status:'idle'|'running'|'ready'|'error',lastSubmittedSnapshot:Stage2Snapshot|null,error:string|null}
 * }} GenerationDraft */

/** @typedef {{
 * sourceMsgId:number,
 * messageHash:string,
 * prompt:string,
 * aspectRatio:string,
 * imageSize:string,
 * quality:string,
 * refs:Array<{id:string,role:'char'|'user'|'npc',name:string,dataUrl?:string,url?:string}>,
 * templateId:string|null,
 * contextRevision:number,
 * submittedAt:string
 * }} Stage2Snapshot */

/** @typedef {{
 * chatId:string,
 * msgId:number,
 * messageHash:string,
 * requestedAction:'full-pipeline'|'current-prompt-stage2',
 * templateId:string|null,
 * enqueuedAt:string
 * }} GenerationQueueItem */
```

---

### Task 1: Message identity, immutable records, and draft defaults

**Files:**
- Create: `src/generation-drafts.js`
- Create: `tests/generation-drafts.test.js`
- Modify: `src/core.js:constants and state declarations near lines 1-170`

- [ ] **Step 1: Write the failing identity/default/immutability tests**

Create `tests/generation-drafts.test.js` with in-memory localforage setup matching `tests/image-recovery.test.js`, then add these exact assertions:

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Install SillyTavern.libs.localforage before importing the module.
const drafts = await import('../src/generation-drafts.js');

test('draft key and default are scoped by chatId plus msgId', async () => {
  const a = await drafts.getGenerationDraft('chat/a', 7, 'same message');
  const b = await drafts.getGenerationDraft('chat/a', 8, 'same message');
  assert.equal(drafts.generationDraftKey('chat/a', 7), 'uris_generation_draft:chat%2Fa:7');
  assert.equal(a.chatId, 'chat/a');
  assert.equal(a.msgId, 7);
  assert.equal(a.promptOrigin, 'empty');
  assert.equal(a.templateId, null);
  assert.deepEqual(a.references, { includedIds: [], excludedIds: [], revision: 0 });
  assert.notEqual(drafts.generationDraftKey(a.chatId, a.msgId), drafts.generationDraftKey(b.chatId, b.msgId));
});

test('deepFreezeSnapshot prevents nested mutation', () => {
  const frozen = drafts.deepFreezeSnapshot({ refs: [{ id: 'aria' }] });
  assert.throws(() => { frozen.refs[0].id = 'changed'; }, TypeError);
  assert.equal(frozen.refs[0].id, 'aria');
});
```

- [ ] **Step 2: Run the suite and verify the new module is missing**

Run: `node --test tests/*.test.js`

Expected: FAIL in `tests/generation-drafts.test.js` with `ERR_MODULE_NOT_FOUND` for `src/generation-drafts.js`; pre-existing tests remain green.

- [ ] **Step 3: Add the minimal draft domain implementation**

In `src/core.js`, export `LF_GENERATION_DRAFT_PREFIX = 'uris_generation_draft:'` and initialize no singleton current draft. In the new module export these exact signatures:

```js
export function hashMessage(messageText) // stable lower-case hex from UTF-8 text
export function generationDraftKey(chatId, msgId)
export function createGenerationDraft(chatId, msgId, messageText)
export async function getGenerationDraft(chatId, msgId, messageText)
export async function saveGenerationDraft(draft)
export function deepFreezeSnapshot(value)
```

`createGenerationDraft()` must emit every property from `GenerationDraft`, with `aspectRatio: '1:1'`, `imageSize: '1K'`, `quality: 'auto'`, both statuses `idle`, and `messageHash: hashMessage(messageText)`. `deepFreezeSnapshot()` recursively freezes arrays and plain objects. Reject invalid identities with exact errors `chatId is required` and `msgId must be a non-negative integer`; do not write an invalid key.

- [ ] **Step 4: Run the full suite and verify the checkpoint**

Run: `node --test tests/*.test.js`

Expected: PASS; the two new tests pass and existing storage/pipeline tests still pass.

- [ ] **Step 5: Commit only the identity foundation**

```bash
git add src/core.js src/generation-drafts.js tests/generation-drafts.test.js
git commit -m "feat: add message-scoped generation draft domain"
git status --short
```

Expected: commit succeeds; no unrelated file is staged.

### Task 2: Non-destructive legacy instruction migration and stale drafts

**Files:**
- Modify: `src/generation-drafts.js`
- Modify: `src/storage.js:instruction functions near lines 1-190`
- Modify: `tests/generation-drafts.test.js`

- [ ] **Step 1: Add failing migration and stale-message tests**

Add tests that seed `uris_instruction_<legacy chat id>` through the actual current `setInstruction(chatId, instr)` function, then assert:

```js
const migrated = await migrateLegacyInstruction('chat-1', 4, 'current text');
assert.equal(migrated.prompt, 'legacy prompt');
assert.equal(migrated.promptOrigin, 'legacy-chat');
assert.equal(migrated.aspectRatio, '9:16');
assert.ok(await lf.getItem(legacyKey), 'legacy value must remain');

const stale = await getGenerationDraft('chat-1', 4, 'edited text');
assert.equal(stale.prompt, '');
assert.equal(stale.promptOrigin, 'empty');
assert.equal(stale.messageHash, hashMessage('edited text'));
assert.deepEqual(stale.references, { includedIds: [], excludedIds: [], revision: 0 });
```

Also assert a second migration call does not overwrite a message draft whose `promptOrigin` is `manual`.

- [ ] **Step 2: Run the suite and verify missing migration behavior**

Run: `node --test tests/*.test.js`

Expected: FAIL because `migrateLegacyInstruction` is not exported or the new message draft does not contain the legacy prompt; no old key is removed.

- [ ] **Step 3: Implement additive migration and stale reset**

Export:

```js
export async function migrateLegacyInstruction(chatId, msgId, messageText)
export async function updateGenerationDraft(chatId, msgId, messageText, updater)
```

`migrateLegacyInstruction()` reads through existing `getInstruction(chatId)`, maps `prompt/style/aspectRatio/imageSize` into the new draft only when no message draft exists, sets `promptOrigin: 'legacy-chat'`, and leaves the old localforage entry untouched. `getGenerationDraft()` must compare the persisted hash to `hashMessage(messageText)`; on mismatch create and persist a fresh draft rather than carrying prompt, corrections, snapshots, or errors across edited/swiped messages. `updateGenerationDraft()` reloads the current message draft, applies a pure updater, validates unchanged identity, and persists it.

Keep these legacy exports and behavior in `src/storage.js`:

```js
export async function getInstruction(chatId)
export async function setInstruction(chatId, instr)
```

They remain readers/writers for old installs and are not redirected to a guessed message id.

- [ ] **Step 4: Run all tests and verify migration compatibility**

Run: `node --test tests/*.test.js`

Expected: PASS; tests prove the old key remains, existing storage callers still work, and a changed source message resets only its message draft.

- [ ] **Step 5: Commit the storage migration checkpoint**

```bash
git add src/generation-drafts.js src/storage.js tests/generation-drafts.test.js
git commit -m "feat: migrate legacy prompts into message drafts"
git status --short
```

Expected: clean feature paths only.

### Task 3: Explicit aliases and strict scene-presence matching

**Files:**
- Create: `src/scene-context.js`
- Create: `tests/scene-context.test.js`
- Modify: `src/refs-library.js:pool normalization and CRUD near lines 1-180`
- Modify: `tests/refs-library.test.js:pool CRUD assertions only`

- [ ] **Step 1: Write failing strict-matching and alias-normalization tests**

Use exact assertions:

```js
assert.equal(matchesScenePhrase('Aria Rose', 'Aria Rose entered.'), true);
assert.equal(matchesScenePhrase('Aria Rose', 'Rose entered.'), false);
assert.equal(matchesScenePhrase('Aria', 'Ariana entered.'), false);
assert.equal(matchesScenePhrase('Ария', '«Ария» вошла.'), true);
assert.equal(matchesScenePhrase('A.B', 'A.B waits'), true);

const entity = normalizeSceneEntity({
  id: 'aria', name: 'Aria Rose', aliases: [' Aria ', 'Ария', 'Aria'],
  keywords: ['red dress'], description: 'red dress', imagePath: '/aria.png'
}, 'npc');
assert.deepEqual(entity.aliases, ['Aria', 'Ария']);
assert.equal(detectEntityMentions(entity, 'The red dress waits').length, 0);
assert.equal(detectEntityMentions(entity, 'Aria waits').length, 1);
```

Extend pool CRUD assertions so an omitted alias list reads as `[]`, while create/update round-trip `aliases: ['Aria', 'Ария']`; existing `keywords` remain stored for library search.

- [ ] **Step 2: Run the suite and verify old token/keyword behavior fails**

Run: `node --test tests/*.test.js`

Expected: FAIL because `src/scene-context.js` is missing and current reference records do not normalize `aliases`; the failure captures that surname tokens/keywords cannot prove presence in the new resolver.

- [ ] **Step 3: Implement Unicode boundary matching and additive aliases**

Export from `src/scene-context.js`:

```js
export function matchesScenePhrase(phrase, text)
export function normalizeSceneEntity(record, role)
export function detectEntityMentions(entity, text)
```

Escape the whole phrase, preserve internal whitespace as `\s+`, and use Unicode alphanumeric boundaries:

```js
new RegExp(`(?<![\\p{L}\\p{N}])${escapedWholePhrase}(?![\\p{L}\\p{N}])`, 'giu')
```

Test canonical `name` and each explicit alias independently. Never split canonical names; never read `keywords` or `description` in `detectEntityMentions()`. In `refs-library.js`, normalize aliases from an array or comma/newline-separated editor value, default old records to `[]`, and retain all existing keyword fields/readers.

- [ ] **Step 4: Run all tests and verify strict and legacy contracts coexist**

Run: `node --test tests/*.test.js`

Expected: PASS; strict behavior lives in `scene-context.js`, pool CRUD preserves keywords, and old chat-binding/gallery readers are unchanged.

- [ ] **Step 5: Commit strict matching without switching callers**

```bash
git add src/scene-context.js src/refs-library.js tests/scene-context.test.js tests/refs-library.test.js
git commit -m "feat: add strict explicit-alias scene matching"
git status --short
```

Expected: application remains on compatibility callers; only the new resolver uses strict semantics.

### Task 4: One deterministic SceneContextSnapshot

**Files:**
- Modify: `src/scene-context.js`
- Modify: `src/references.js:reference materialization near lines 1-220`
- Modify: `tests/scene-context.test.js`

- [ ] **Step 1: Add failing snapshot, ambiguity, correction, and ordering tests**

Construct `char`, `user`, and NPC fixtures and assert:

```js
const snapshot = await buildSceneContextSnapshot({
  chatId: 'chat-1', msgId: 9, messageText: 'Mira met Aria. Later Borin waved.',
  contextRevision: 3, candidates, corrections: { includedIds: ['manual'], excludedIds: ['borin'], revision: 2 },
  lorebookEntries: [{ uid: 8, content: 'night market' }]
});
assert.deepEqual(snapshot.entities.map(x => x.id), ['manual', 'char', 'user', 'aria']);
assert.deepEqual(snapshot.stage1Descriptions.map(x => x.id), ['manual', 'char', 'user', 'aria']);
assert.deepEqual(snapshot.stage2Refs.map(x => x.id), ['manual', 'char', 'user', 'aria']);
assert.equal(snapshot.contextRevision, 3);
assert.equal(snapshot.messageHash, hashMessage('Mira met Aria. Later Borin waved.'));
assert.throws(() => { snapshot.entities.push(candidates[0]); }, TypeError);
```

For two entities sharing alias `Rose`, assert `entities` excludes both and `ambiguities` equals `[{ mention: 'Rose', candidateIds: ['aria-rose', 'rose-smith'] }]`. Then assert manual inclusion chooses the included candidate and exclusion suppresses the other. Assert auto NPC ordering follows first match index, not pool order.

- [ ] **Step 2: Run the suite and verify the snapshot builder is absent**

Run: `node --test tests/*.test.js`

Expected: FAIL with `buildSceneContextSnapshot is not a function` or mismatched deterministic ordering.

- [ ] **Step 3: Implement one resolver and provider-reference materializer**

Export:

```js
export async function buildSceneContextSnapshot(input)
export async function materializeStage2References(snapshot)
```

`input` has exact fields from the test plus `candidates: SceneEntity[]`. Build one mention index, group identical matched mention text case-insensitively, mark groups with multiple effective candidate IDs ambiguous, apply `excludedIds` before `includedIds`, then order: unique manual includes in supplied order, `char`, `user`, remaining unambiguous NPCs by first mention index and ID as tie-breaker. Derive `entities`, non-empty `stage1Descriptions`, and image-bearing `stage2Refs` from that one ordered list and deep-freeze the complete snapshot.

`materializeStage2References(snapshot)` in `references.js` (re-exported from `scene-context.js` if convenient) loads each `imagePath` in snapshot order and returns `{id, role, name, dataUrl}`. It must throw `Reference image unavailable: <id>` for a selected image that cannot be loaded; Stage 2 displays this error and sends no request.

- [ ] **Step 4: Run all tests and verify one frozen ordering**

Run: `node --test tests/*.test.js`

Expected: PASS; the exact same IDs and order appear in `entities`, Stage 1 descriptions, and Stage 2 refs, with ambiguity and errors deterministic.

- [ ] **Step 5: Commit the shared context snapshot**

```bash
git add src/scene-context.js src/references.js tests/scene-context.test.js
git commit -m "feat: build one immutable scene context snapshot"
git status --short
```

Expected: no UI caller has switched yet; application remains working.

### Task 5: Additive instruction and fields template storage

**Files:**
- Modify: `src/prompt-templates.js:1-250`
- Create: `tests/template-runtime.test.js`
- Modify: existing prompt-template tests if present, only for additive type assertions

- [ ] **Step 1: Write failing storage/classification tests**

Seed an existing schema-v3 record, capture its JSON, and assert:

```js
assert.equal(classifyTemplate(null), 'base');
assert.equal(classifyTemplate(existingV3), 'legacy-v3');

const instruction = await createInstructionTemplate({ name: 'Director' });
assert.deepEqual(instruction, {
  id: instruction.id, name: 'Director', type: 'instruction', instruction: '', createdAt: instruction.createdAt, updatedAt: instruction.updatedAt
});

const fields = await createFieldsTemplate({ name: 'Shot list' });
assert.equal(fields.type, 'fields');
assert.deepEqual(fields.fields, []);
assert.equal(JSON.stringify(await getTemplate(existingV3.id)), originalJson);
```

Assert `saveTemplate()` rejects an instruction record without string `instruction` using `Instruction template content must be a string`, and rejects duplicate/empty field keys using `Field keys must be unique non-empty strings`.

- [ ] **Step 2: Run the suite and verify new template APIs are missing**

Run: `node --test tests/*.test.js`

Expected: FAIL because `classifyTemplate`, `createInstructionTemplate`, and `createFieldsTemplate` do not exist.

- [ ] **Step 3: Implement additive template types and validators**

Export from `src/prompt-templates.js`:

```js
export function classifyTemplate(template)
export async function createInstructionTemplate({name})
export async function createFieldsTemplate({name})
export async function copyLegacyTemplateAsInstruction(id)
```

New instruction shape is `{id,name,type:'instruction',instruction:'',createdAt,updatedAt}`. New fields shape is `{id,name,type:'fields',fields:[],createdAt,updatedAt}`, where every field is exactly `{key,label,instruction,required,prefix,suffix}`. `classifyTemplate(null)` is `base`; explicit new types retain their type; any `isV3Template(content)` record is `legacy-v3`; unknown records throw `Unsupported template format`. Do not rewrite or version-bump existing records during list/get. `copyLegacyTemplateAsInstruction()` creates a new record with empty `instruction`, a name suffixed ` — copy`, and leaves the source untouched.

- [ ] **Step 4: Run all tests and verify schema-v3 bytes are preserved**

Run: `node --test tests/*.test.js`

Expected: PASS; existing schema-v3 tests continue to pass, new templates start empty, and legacy records are neither rewritten nor deleted.

- [ ] **Step 5: Commit additive template persistence**

```bash
git add src/prompt-templates.js tests/template-runtime.test.js
git commit -m "feat: add instruction and fields template records"
git status --short
```

Expected: old template editor remains functional at this checkpoint.

### Task 6: Deterministic template runtime and exactly one Stage 1 request

**Files:**
- Create: `src/template-runtime.js`
- Modify: `src/stage1-adapter.js:local normalization and adapter request near lines 1-240`
- Modify: `tests/template-runtime.test.js`
- Modify: `tests/stage1-adapter.test.js:adaptStage1Response section near lines 66-115`

- [ ] **Step 1: Add failing runtime and request-count tests**

Assert exact dispatch and assembly:

```js
assert.deepEqual(buildStage1Messages({ template: null, messageText: 'She enters.', snapshot }), {
  templateType: 'base',
  system: BASE_SCENE_INSTRUCTION,
  user: expectedUserContainingOneSceneAndDescriptions
});

assert.equal(assembleFieldsPrompt(fieldsTemplate, { camera: 'low angle', mood: 'tense' }),
  'Camera: low angle\nMood: tense.');
assert.throws(() => assembleFieldsPrompt(fieldsTemplate, { camera: '' }), /Required field missing: camera/);
```

Use an injected `generateText` spy:

```js
let calls = 0;
const result = await executeStage1({ template, messageText, snapshot, generateText: async () => {
  calls += 1;
  return '{"camera":"wide","mood":"quiet"}';
}});
assert.equal(calls, 1);
assert.equal(result.templateType, 'fields');
assert.equal(result.prompt, 'Camera: wide\nMood: quiet.');
assert.equal(result.sourceMsgId, snapshot.msgId);
assert.equal(result.contextRevision, snapshot.contextRevision);
```

In `stage1-adapter.test.js`, pass arbitrary locally unrecognized JSON and spy on provider/fetch access; assert the result falls back locally and `calls === 0` inside the adapter.

- [ ] **Step 2: Run the suite and expose the hidden normalization request**

Run: `node --test tests/*.test.js`

Expected: FAIL because `template-runtime.js` is missing and/or current `adaptStage1Response()` attempts `runAdapterPrompt`, proving a second text-model request is possible.

- [ ] **Step 3: Implement runtime dispatch with local-only response parsing**

Export:

```js
export const BASE_SCENE_INSTRUCTION
export function buildStage1Messages({template, messageText, snapshot})
export function assembleFieldsPrompt(template, values)
export async function executeStage1({template, messageText, snapshot, generateText, signal, onStatus})
```

Branches:

- `base`: generic scene-to-image instruction; plain response becomes prompt.
- `instruction`: template `instruction` is the system instruction; empty content throws `Template instruction is empty` before any request.
- `fields`: system prompt requests one JSON object with exactly the configured keys; parse locally, reject malformed JSON as `Fields template returned invalid JSON`, reject missing required values, then assemble fields in stored order using `prefix + trimmed value + suffix`, joined by newline.
- `legacy-v3`: call existing `buildSystemPrompt()` and local schema-v3 parsing/flattening.

`executeStage1()` invokes injected `generateText` exactly once, then performs only local parsing. Return every `Stage1Result` property. Remove `runAdapterPrompt()` and its call from `stage1-adapter.js`; keep inline tags, simple JSON, structured legacy drafts, arbitrary smart extraction, and plain-text fallback. Do not silently issue a repair request.

- [ ] **Step 4: Run all tests and verify one-request behavior**

Run: `node --test tests/*.test.js`

Expected: PASS; the request spy is exactly `1` for every Stage 1 runtime branch and exactly `0` inside response normalization; all old local adapter fixtures pass.

- [ ] **Step 5: Commit the Stage 1 runtime**

```bash
git add src/template-runtime.js src/stage1-adapter.js tests/template-runtime.test.js tests/stage1-adapter.test.js
git commit -m "feat: execute templates with one stage1 request"
git status --short
```

Expected: application still uses old pipeline wrappers until Task 7.

### Task 7: Snapshot-safe Stage 1 APIs with compatibility wrappers

**Files:**
- Modify: `src/pipeline.js:Stage 1 and full-pipeline sections near lines 1-360`
- Modify: `src/generation-drafts.js`
- Create: `tests/pipeline-scene-first.test.js`

- [ ] **Step 1: Write failing Stage 1 snapshot/race tests**

Inject dependencies through an exported testable coordinator and assert:

```js
const run = await runStage1ForDraft({ chatId:'c', msgId:4, messageText:'Aria waits', templateId:null }, onStatus);
assert.equal(run.result.sourceMsgId, 4);
assert.strictEqual(run.snapshot, run.draft.stage1.contextSnapshot);
assert.equal(run.draft.promptOrigin, 'stage1');
assert.equal(run.draft.prompt, run.result.prompt);
```

Start run revision 1, edit the prompt through `updateGenerationDraft()` while the text request is pending, resolve the request, and assert the late Stage 1 result does not overwrite the manual prompt. Start runs 1 and 2 for the same message, resolve 2 first, and assert run 1 returns `{ applied:false, reason:'superseded' }`. Assert navigating `state.currentMsgId` to 12 during a run for 4 does not alter `sourceMsgId`, stored key, or snapshot.

- [ ] **Step 2: Run the suite and verify snapshot-safe API is absent**

Run: `node --test tests/*.test.js`

Expected: FAIL because `runStage1ForDraft` and run-token handling do not exist.

- [ ] **Step 3: Implement explicit Stage 1 input and wrappers**

Export from `pipeline.js`:

```js
export async function runStage1ForDraft(input, onStatus = () => {}, signal)
export async function runFullPipelineForDraft(input, onStatus = () => {}, signal)
```

`input` is `{chatId,msgId,messageText,templateId,requestedAction?}`. Capture it once; load/migrate the message draft; increment an internal run token keyed by `chatId + msgId`; build one `SceneContextSnapshot`; pass that exact object to `executeStage1`; and apply the result only if token and prompt revision still match. Return `{applied, reason:null|'superseded'|'prompt-edited', result, snapshot, draft}`.

Keep existing signatures as compatibility wrappers:

```js
export async function runStage1(msgId, onStatus, signal)
export async function runFullPipeline(msgId, onStatus)
```

Each wrapper captures `chatId`, message text, and template ID once from current context, then delegates. It must not reread `state.currentMsgId` after an await. At this checkpoint, `runFullPipelineForDraft()` may call the existing positional Stage 2 wrapper with the captured prompt; Task 8 replaces that boundary.

- [ ] **Step 4: Run all tests and verify compatibility exports remain green**

Run: `node --test tests/*.test.js`

Expected: PASS; new race assertions pass and old imports of `runStage1`/`runFullPipeline` remain valid.

- [ ] **Step 5: Commit compatibility-first Stage 1 pipeline**

```bash
git add src/pipeline.js src/generation-drafts.js tests/pipeline-scene-first.test.js
git commit -m "feat: add snapshot-safe stage1 pipeline wrappers"
git status --short
```

Expected: no UI switch has occurred.

### Task 8: Immutable Stage 2 submission and provider-independent request

**Files:**
- Modify: `src/generation-drafts.js`
- Modify: `src/pipeline.js:Stage 2 section near lines 180-420`
- Modify: `src/image-api.js:1-180`
- Modify: `tests/pipeline-scene-first.test.js`
- Modify: `tests/pipeline-stage2-serialization.test.js:1-199`

- [ ] **Step 1: Add failing immutable-submission tests**

Assert:

```js
const snapshot = createStage2Snapshot({ draft, contextSnapshot, refs, now: () => '2026-07-15T10:00:00.000Z' });
assert.deepEqual(snapshot, {
  sourceMsgId: 4, messageHash: draft.messageHash, prompt: 'edited prompt',
  aspectRatio:'9:16', imageSize:'2K', quality:'high', refs,
  templateId:null, contextRevision:3, submittedAt:'2026-07-15T10:00:00.000Z'
});
assert.throws(() => { snapshot.prompt = 'later edit'; }, TypeError);
```

Call `runStage2ForDraft({chatId:'c',msgId:4,messageText:'scene'})`, mutate the live draft after provider start, and assert the provider received exactly `{prompt,aspectRatio,imageSize,quality,references}` from the frozen snapshot and the saved `lastSubmittedSnapshot` did not change. Assert empty prompt rejects `Prompt is empty` and stale message hash rejects `Source message changed; rebuild the prompt`, both with zero provider calls.

- [ ] **Step 2: Run the suite and verify old mutable positional behavior fails**

Run: `node --test tests/*.test.js`

Expected: FAIL because `createStage2Snapshot`/`runStage2ForDraft` are absent and `image-api.js` still accepts separate mutable arguments.

- [ ] **Step 3: Implement frozen submission and internal request object**

Export:

```js
export function createStage2Snapshot({draft, contextSnapshot, refs, now})
export async function runStage2ForDraft(input, onStatus = () => {}, signal, opts = {})
export async function generateImageRequest(imageConnId, request, onStatus, signal)
```

`runStage2ForDraft()` loads the exact message draft, verifies hash and non-empty prompt, reuses `draft.stage1.contextSnapshot` when its hash/revision match, otherwise builds and stores one snapshot before submission, materializes references once, freezes a `Stage2Snapshot`, saves it before provider invocation, and calls:

```js
await generateImageRequest(connId, {
  prompt: submission.prompt,
  aspectRatio: submission.aspectRatio,
  imageSize: submission.imageSize,
  quality: submission.quality,
  references: submission.refs
}, onStatus, signal);
```

Keep `generateImage(imageConnId, instruction, refs, onStatus, signal)` and `runStage2(msgId, instruction, onStatus, signal, opts)` as adapters into the new request path. Preserve same-message manual FIFO, `isAuto` bypass, chain cleanup, abort isolation, and three distinct upstream calls already asserted by `pipeline-stage2-serialization.test.js`.

- [ ] **Step 4: Run all tests and verify Stage 2 compatibility**

Run: `node --test tests/*.test.js`

Expected: PASS; immutable request assertions pass and all five existing Stage 2 serialization tests remain green.

- [ ] **Step 5: Commit the provider boundary checkpoint**

```bash
git add src/generation-drafts.js src/pipeline.js src/image-api.js tests/pipeline-scene-first.test.js tests/pipeline-stage2-serialization.test.js
git commit -m "feat: submit immutable stage2 request snapshots"
git status --short
```

Expected: old positional callers still work through wrappers.

### Task 9: Add Stage 2 snapshots to pending and gallery records

**Files:**
- Modify: `src/image-recovery.js:1-260`
- Modify: `src/storage.js:gallery entry creation/readers near lines 190-420`
- Modify: `tests/image-recovery.test.js:60-227`
- Modify: gallery storage tests if present

- [ ] **Step 1: Add failing additive-persistence tests**

Save a pending image with a frozen `stage2Snapshot`, then assert exact deep equality on the pending record and processed gallery entry. Seed the old pending fixture already used around `tests/image-recovery.test.js:173-183` without `stage2Snapshot`, resume it, and assert processing succeeds and the resulting gallery entry has `stage2Snapshot === null`. Seed an old gallery entry without the field and assert its existing prompt/style/refs are still readable.

- [ ] **Step 2: Run the suite and verify snapshot metadata is dropped**

Run: `node --test tests/*.test.js`

Expected: FAIL because new pending/gallery records do not retain `stage2Snapshot`; the old pending fixture itself must continue to process.

- [ ] **Step 3: Persist snapshots additively and normalize legacy reads**

Extend the existing signature without removing fields:

```js
export async function savePendingImage({
  connId, chatId, sourceMsgId = null, url, dataUrl, instruction,
  refsSig, refs, prompt, stage2Snapshot = null
})
```

Clone the already-frozen snapshot into pending storage. During `processPending()`, pass it to gallery creation. Normalize absent `stage2Snapshot` to `null` only in returned in-memory records; do not rewrite old localforage arrays merely because they were read. Preserve `instruction`, `refsSig`, `refs`, `prompt`, URL/data URL, retry counters, TTL, and max-attempt behavior.

- [ ] **Step 4: Run all tests and verify old/new recovery paths**

Run: `node --test tests/*.test.js`

Expected: PASS; all current recovery tests pass, new records round-trip complete snapshots, and legacy records process without migration or deletion beyond existing successful-processing/TTL semantics.

- [ ] **Step 5: Commit additive recovery metadata**

```bash
git add src/image-recovery.js src/storage.js tests/image-recovery.test.js
git commit -m "feat: persist stage2 snapshots in recovery metadata"
git status --short
```

Expected: no destructive migration has been added.

### Task 10: Migrate two old settings to one automation enum

**Files:**
- Modify: `src/core.js:default settings and loadSettings near lines 80-220`
- Modify: `src/bundles.js:bundle normalize/apply/persist near lines 1-260`
- Create: `tests/settings-migration.test.js`

- [ ] **Step 1: Write failing global and bundle migration matrix tests**

Assert this exact migration table:

```js
const cases = [
  [{ stage1Mode:'manual', stage2Mode:'manual' }, 'manual'],
  [{ stage1Mode:'auto', stage2Mode:'manual' }, 'build-prompt'],
  [{ stage1Mode:'auto', stage2Mode:'auto-after' }, 'full-pipeline'],
  [{ stage1Mode:'off', stage2Mode:'auto-after' }, 'manual']
];
for (const [old, expected] of cases) assert.equal(migrateAutomationMode(old), expected);
assert.equal(migrateAutomationMode({ automationMode:'build-prompt', stage1Mode:'auto', stage2Mode:'auto-after' }), 'build-prompt');
```

For bundles, load an old bundle, assert effective `automationMode`, save it, and assert the old fields remain unchanged while the additive field is present. Assert unknown explicit values normalize to `manual`.

- [ ] **Step 2: Run the suite and verify the single setting is absent**

Run: `node --test tests/*.test.js`

Expected: FAIL because `migrateAutomationMode` and `automationMode` defaults are missing.

- [ ] **Step 3: Implement non-destructive dual migration**

Export:

```js
export function migrateAutomationMode(settingsLike)
```

Add `automationMode: 'manual'` and `experimentalTemplateFromDescription: false` to defaults. `loadSettings()` fills `automationMode` only when absent, using the matrix above, and does not delete or overwrite `stage1Mode`/`stage2Mode`. Bundle normalization follows the same rule; new saves include `automationMode` while retaining old fields currently present in the record. `persistBundleFields()` and `applyBundleToState()` use the new effective value but continue to round-trip old values.

- [ ] **Step 4: Run all tests and verify migration stability**

Run: `node --test tests/*.test.js`

Expected: PASS; old settings/bundles map deterministically, explicit new mode wins, old properties remain available, and the experimental option defaults false.

- [ ] **Step 5: Commit settings compatibility**

```bash
git add src/core.js src/bundles.js tests/settings-migration.test.js
git commit -m "feat: migrate generation automation settings"
git status --short
```

Expected: no caller switch yet; old UI controls still render at this checkpoint.

### Task 11: Queue actions and event auto-flow preserve source identity

**Files:**
- Modify: `src/pipeline.js:queue near lines 360-520`
- Modify: `src/events.js:1-190`
- Modify: `index.js:auto-generation callback near lines 80-220`
- Modify: `tests/pipeline-scene-first.test.js`
- Modify: `tests/events.test.js:39-180`

- [ ] **Step 1: Add failing queue/event identity tests**

Assert `enqueueGeneration()` stores exactly:

```js
{
  chatId:'chat-1', msgId:7, messageHash:hashMessage('scene'),
  requestedAction:'full-pipeline', templateId:null,
  enqueuedAt:'2026-07-15T11:00:00.000Z'
}
```

Change current chat/message before draining and assert execution still targets `chat-1/7`. Change source text before draining and assert item fails with `Queued source message changed` before either provider call. Assert `current-prompt-stage2` skips Stage 1 and uses the saved prompt; `full-pipeline` performs Stage 1 then Stage 2 with the same snapshot object.

Update event tests so `automationMode:'manual'` triggers neither event, `build-prompt` calls Stage 1 only, and `full-pipeline` calls the full snapshot-safe flow. Keep `generationFlow` filtering assertions for AI-only, user-only, all, and manual.

- [ ] **Step 2: Run the suite and verify mutable queue/event behavior**

Run: `node --test tests/*.test.js`

Expected: FAIL because queue items contain only mutable `msgId` work and events still branch on `stage1Mode`/`stage2Mode`.

- [ ] **Step 3: Implement explicit queue actions and event dispatch**

Export:

```js
export function createQueueItem({chatId,msgId,messageText,requestedAction,templateId,now})
export function enqueueGeneration(item)
```

Validate `requestedAction` against the two canonical literals. At dequeue, resolve the source message by captured chat/message identity and verify its hash; never substitute `state.currentMsgId`. Preserve existing `enqueue(msgId)` as a `full-pipeline` compatibility wrapper.

In `events.js`, compute the effective `automationMode`; preserve existing `generationFlow` post selection. Pass a captured `{chatId,msgId,messageText,templateId}` to callbacks. In `index.js`, dispatch `runStage1ForDraft()` for `build-prompt`, `runFullPipelineForDraft()` for `full-pipeline`, and no request for `manual`; do not call Stage 2 later with mutable `state.currentMsgId`.

- [ ] **Step 4: Run all tests and verify race-free automation**

Run: `node --test tests/*.test.js`

Expected: PASS; queue and event tests retain source identity, full pipeline shares one snapshot, and prior event flow filters still pass.

- [ ] **Step 5: Commit caller compatibility before UI cutover**

```bash
git add src/pipeline.js src/events.js index.js tests/pipeline-scene-first.test.js tests/events.test.js
git commit -m "feat: preserve source identity in queue and events"
git status --short
```

Expected: all backend compatibility APIs are available before Task 12 changes Generate UI.

### Task 12: Cut Generate UI over to prompt-first message drafts

**Files:**
- Modify: `src/ui/tab-generate.js:1-end`
- Modify: `style.css:95-107,235-end`
- Create: `tests/tab-generate.test.js`

- [ ] **Step 1: Write failing renderer/controller tests**

Extract and export pure view helpers so Node tests do not require a DOM:

```js
export function buildGenerateViewModel({draft,snapshot,automationMode,templates})
export function decidePrimaryAction(draft)
export function renderGenerateMarkup(viewModel)
```

Assert:

```js
assert.equal(decidePrimaryAction(emptyDraft), 'build-prompt');
assert.equal(decidePrimaryAction({...emptyDraft,prompt:'ready',promptOrigin:'manual'}), 'generate-image');
assert.match(renderGenerateMarkup(vm), /id="urisPrompt"/);
assert.match(renderGenerateMarkup(vm), /id="urisPrimaryGenerate"/);
assert.doesNotMatch(renderGenerateMarkup(vm), /id="urisStage1Mode"/);
assert.doesNotMatch(renderGenerateMarkup(vm), /id="urisStage2Mode"/);
assert.match(renderGenerateMarkup(ambiguousVm), /data-ambiguity="Rose"/);
```

Controller test: in manual mode with empty prompt, primary click calls Stage 1 once, persists prompt, and does not call Stage 2; second click calls Stage 2 once. Editing the prompt sets `promptOrigin:'manual'`. Changing message loads a different draft key and never copies prompt text.

- [ ] **Step 2: Run the suite and verify old template-first markup/behavior**

Run: `node --test tests/*.test.js`

Expected: FAIL because helpers are not exported, old dual mode controls exist, and current empty-prompt click continues directly from Stage 1 into Stage 2.

- [ ] **Step 3: Implement the prompt-first renderer and bindings**

Main visible order must be: post navigator; source excerpt/stale badge; large `#urisPrompt`; primary action; compact ratio/size/quality; one references card; Advanced disclosure. Bind autosave through `updateGenerationDraft(chatId,msgId,messageText, updater)` and never `setInstruction(chatId, ...)`.

Primary action branches:

- empty prompt: call `runStage1ForDraft`, render built editable prompt, stop;
- non-empty prompt: call `runStage2ForDraft` with current identity;
- Stage 1 running: disable primary action and show status;
- Stage 1 error: retain prior manual prompt and render exact error text;
- stale message hash: reset/load new draft and require rebuild;
- unresolved ambiguity: show candidate include/exclude controls; saving a correction increments `references.revision`, rebuilds one snapshot, and updates both description/reference previews.

Advanced contains template selection, automation mode, legacy structured draft editor when `templateType === 'legacy-v3'`, and queue buttons whose labels map explicitly to `full-pipeline` and `current-prompt-stage2`. Base mode is the `templateId:null` option and must work with an empty template library.

Add CSS classes `.uris-prompt-card`, `.uris-scene-context`, `.uris-reference-included`, `.uris-reference-excluded`, `.uris-ambiguity`, `.uris-draft-stale`, and `.uris-stage-error`, including mobile wrapping without changing window dimensions.

- [ ] **Step 4: Run all tests and perform a focused browser smoke check**

Run: `node --test tests/*.test.js`

Expected: PASS; renderer tests prove dual selectors are absent and manual empty-prompt behavior stops after Stage 1.

Then load the extension in SillyTavern and verify: message A and B retain separate prompts; base with no saved templates builds a prompt; editing a prompt then Generate sends that exact text; ambiguity include/exclude updates one reference list; changing posts during Stage 1 does not write into the new post. Record the observations in the execution log/output, not in a repository file.

- [ ] **Step 5: Commit the Generate UI cutover**

```bash
git add src/ui/tab-generate.js style.css tests/tab-generate.test.js
git commit -m "feat: switch generate tab to prompt-first drafts"
git status --short
```

Expected: application is working on the new UI with backend wrappers still available.

### Task 13: Template and reference editors, with experimental flow gated off

**Files:**
- Modify: `src/ui/tab-templates.js:1-end`
- Modify: `src/ui/tab-references.js:18-202`
- Modify: `style.css:template/reference sections`
- Create: `tests/tab-templates.test.js`
- Modify: `tests/refs-library.test.js:alias editor-normalization assertions`

- [ ] **Step 1: Write failing pure-render/gating tests**

Export pure helpers and assert:

```js
assert.match(renderTemplateCreateActions(false), /data-create-type="instruction"/);
assert.match(renderTemplateCreateActions(false), /data-create-type="fields"/);
assert.doesNotMatch(renderTemplateCreateActions(false), /data-create-type="description"/);
assert.match(renderTemplateCreateActions(true), /data-create-type="description"/);
assert.match(renderTemplateCard(existingV3), /Legacy v3/);
assert.match(renderTemplateCard(existingV3), /data-action="copy-legacy"/);
```

Assert instruction editor starts with empty textarea; fields editor emits exact field keys `key,label,instruction,required,prefix,suffix` in stored order. Assert description creation throws `Experimental template creation is disabled` before a text request when the setting is false. For references, assert aliases and keywords render in distinct controls and saving aliases does not modify keywords.

- [ ] **Step 2: Run the suite and verify missing create flows/gate**

Run: `node --test tests/*.test.js`

Expected: FAIL because the existing template tab has one schema-v3 create action and the reference editor has no aliases control.

- [ ] **Step 3: Implement two standard editors and one opt-in experiment**

Expose `+ Instruction` and `+ Fields`. Instruction UI edits only `name` and `instruction`. Fields UI adds/reorders/removes rows of the canonical six-property shape and validates before save. Render existing schema-v3 cards as `Legacy v3`, retain their current editor, and add Copy that calls `copyLegacyTemplateAsInstruction()` without altering the source.

Render the description creation action only when `state.settings.experimentalTemplateFromDescription === true`. Its handler rechecks the setting, makes one explicit text request, locally validates the returned object as either instruction or fields, creates a new record only on valid output, and reports `Template description returned invalid JSON` or `Template description returned unsupported type`; it never runs during ordinary Stage 1 and is disabled by default.

In `tab-references.js`, add an `Aliases` control beside existing Keywords. Parse comma/newline input through the pool normalizer. Explain in UI text that aliases prove scene presence while keywords only organize/search the library.

- [ ] **Step 4: Run all tests and perform editor smoke checks**

Run: `node --test tests/*.test.js`

Expected: PASS; tests prove both empty standard types, preserved legacy-v3 editing/copying, separate aliases, and a hard-disabled experimental request path by default.

In SillyTavern verify create/edit/reload for instruction and fields, inspect a legacy card without modifying it, and confirm the description action appears only after enabling the setting. Do not persist test records in a user's real library; use disposable records and delete only those records explicitly created in this smoke check.

- [ ] **Step 5: Commit template/reference UI support**

```bash
git add src/ui/tab-templates.js src/ui/tab-references.js style.css tests/tab-templates.test.js tests/refs-library.test.js
git commit -m "feat: add scene-first template and alias editors"
git status --short
```

Expected: user-created existing templates/references remain intact.

### Task 14: Final cleanup, base-mode startup, and full compatibility verification

**Files:**
- Modify: `index.js:startup default-template path near lines 1-100`
- Modify: `src/ui/tab-generate.js:obsolete controls/branches`
- Modify: `src/pipeline.js:obsolete internal branches only`
- Modify: `src/refs-library.js:obsolete scene-presence callers only`
- Modify: `style.css:obsolete flow-control selectors`
- Modify: `tests/smoke.test.js:1-186`
- Modify: relevant tests from Tasks 1-13

- [ ] **Step 1: Add failing no-default/no-dead-runtime compatibility tests**

Add startup test with an empty template store and assert no template is created, base Stage 1 still returns `templateType:'base'`, and the prompt is usable. Add source inspections that assert production callers no longer invoke keyword-based scene matching, `runAdapterPrompt`, or dual Generate selectors. Do not assert that legacy storage exports/keys are absent. Add an end-to-end fixture for each template type and assert its final `Stage1Result` shape exactly matches the canonical contract.

Add compatibility fixtures that read: an untouched schema-v3 template, old chat instruction, old pending entry, old gallery entry, old global settings, and old bundle. Assert all read successfully and no fixture key/record count changes merely from loading.

- [ ] **Step 2: Run the suite and verify cleanup targets are still present**

Run: `node --test tests/*.test.js`

Expected: FAIL because `ensureDefaultTemplate()` still creates `Манга (дефолт)` and/or obsolete internal UI/runtime caller strings remain; all compatibility fixture reads should already pass.

- [ ] **Step 3: Remove only dead callers after compatibility is proven**

Remove the startup call/function that auto-creates `DEFAULT_TEMPLATE`; empty storage now selects `templateId:null` base mode. Remove old dual-selector markup/bindings, prompt autosave to chat-only storage, independent UI description/image matching, the hidden adapter request branch, and internal pipeline recomputation that has been replaced by the shared snapshot.

Retain these compatibility surfaces:

```js
getInstruction(chatId)
setInstruction(chatId, instr)
runStage1(msgId, onStatus, signal)
runStage2(msgId, instruction, onStatus, signal, opts)
runFullPipeline(msgId, onStatus)
enqueue(msgId)
generateImage(imageConnId, instruction, refs, onStatus, signal)
isV3Template(content)
getDefaultV2
```

Retain old settings fields and old localforage data. Do not add broad clearing, key removal, template rewriting, pending/gallery rewriting, or reference deletion. Existing `migrateWipeLegacyProfiles()` behavior is outside this feature; do not expand or call it for any new key.

- [ ] **Step 4: Run automated and manual final verification**

Run: `node --test tests/*.test.js`

Expected: PASS with zero failures under Node 24.

Then verify in SillyTavern, in this order: base mode with zero templates; instruction template; fields template; untouched schema-v3 template as legacy-v3; one Stage 1 network request per run; canonical full-name and explicit alias presence; surname-only, keyword-only, and description-only absence; ambiguity correction; message A/B draft isolation; navigation during Stage 1; exact edited prompt in Stage 2; reference order manual/char/user/NPC; manual empty prompt builds and stops; both queue actions; auto build-prompt; auto full-pipeline; recovery of an old pending item; gallery display of old and new entries. Confirm browser console has no uncaught errors.

- [ ] **Step 5: Commit cleanup last and inspect the branch**

```bash
git add index.js src/ui/tab-generate.js src/pipeline.js src/refs-library.js style.css tests/smoke.test.js tests/generation-drafts.test.js tests/scene-context.test.js tests/template-runtime.test.js tests/pipeline-scene-first.test.js tests/settings-migration.test.js tests/tab-generate.test.js tests/tab-templates.test.js tests/stage1-adapter.test.js tests/refs-library.test.js tests/image-recovery.test.js tests/events.test.js tests/pipeline-stage2-serialization.test.js
git commit -m "refactor: finish scene-first generation cutover"
git status --short --branch
git diff HEAD^ --check
```

Expected: final commit succeeds; status has no staged files and no unrelated files; `git diff HEAD^ --check` prints nothing. Do not merge, push, or commit the implementation-plan file unless the person executing the plan explicitly requests that separately.

## Completion criteria

- All 14 checkpoints were committed independently on the feature branch and each checkpoint passed `node --test tests/*.test.js`.
- Every ordinary Stage 1 run performs exactly one text-model request; response parsing performs none.
- UI, Stage 1, and Stage 2 use the same frozen `SceneContextSnapshot` for a source message/revision.
- Scene presence comes only from the complete canonical name or explicit aliases at Unicode alphanumeric boundaries.
- Draft and queue identity is `chatId + msgId + messageHash`; navigation cannot redirect pending work.
- Stage 2 sends and persists an immutable exact submission snapshot through a provider-independent request object.
- Base, instruction, fields, and legacy-v3 execute; ordinary new template content starts empty.
- Experimental description creation remains absent/blocked until explicitly enabled.
- Schema-v3 records, old instruction drafts, pending/gallery records, old global settings, old bundle fields, keywords, chat bindings, and all user data remain readable and are not destructively migrated.
- Cleanup occurred only after compatibility wrappers and UI cutover were tested.
