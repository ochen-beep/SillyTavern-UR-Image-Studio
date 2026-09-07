# Remove `descRefs` dead path + split `pipeline.js`

**Date:** 2026-07-18
**Status:** Approved (sections 1-3 reviewed)
**Scope:** Refactor — remove dead code, reorganize module structure.

## Background

The reference panel `#urisRefsPanel` has two `<details>` children:

- **Child 5** (`data-source="whitelist"`, host `#urisRefsWhitelist`) — binds to `chatMetadata.refs.referenceIds`. Drives **Stage 2** (visual references).
- **Child 6** (`data-source="desc"`, host `#urisRefsDesc`) — binds to `chatMetadata.refs.descRefs`. Was meant to drive **Stage 1** (text descriptions) via `mode: 'auto'|'pinned'`.

Investigation revealed that **child 6 is orphaned infrastructure**. There are two parallel Stage 1 code paths in `src/pipeline.js`:

| Path | Function | Description source | Live? |
|---|---|---|---|
| Legacy | `runStage1` (pipeline.js:145) | `collectDescRefsForCurrentChat` → `descRefs` list | **Dead** — zero importers |
| Scene-first | `runStage1ForDraft` (pipeline.js:264) | `buildCandidates` → `referenceIds` → pool card `description` field directly | **Live** |

`runStage1` is reachable from exactly one caller: `runFullPipeline` (pipeline.js:574), and `runFullPipeline` itself has zero importers. No UI button, no event handler, no queue path, no `automationMode` value routes to either. The smoke test at `tests/smoke.test.js:259` explicitly labels this the "legacy wrapper" and pins its scope.

The live path (`runStage1ForDraft`) already pulls `description` directly from the pool card through `buildCandidates` → `buildSceneContextSnapshot`. The split between Stage 1 (text) and Stage 2 (visual) is done at snapshot level via field filters (`entities.filter(e => e.description)` / `entities.filter(e => e.imagePath)`), which is cleaner than maintaining two parallel id lists.

## Decision

Remove the `descRefs` parallel path entirely and split `pipeline.js` into focused modules.

Project is single-developer / single-user — **no data migration, no schema-version bump**. Stale `descRefs` data in existing chat metadata is ignored (not actively migrated).

## Architecture (Section 1)

### Final data model

```
Pool card (single entity):
  { id, name, aliases, description, imagePath, role, folderId, createdAt }
                                              ▲              ▲
                                              │              │
Whitelist (#urisRefsWhitelist → referenceIds: string[])
              │
              ▼
        buildCandidates()  ── fetches whole card by id
              │
              ▼
   buildSceneContextSnapshot(messageText, candidates)
              │
              ├─ resolveEntitiesFromText() — alias match against post text
              │
              ├─ stage1Descriptions = entities.filter(e => e.description)
              └─ stage2Refs         = entities.filter(e => e.imagePath)
              │
              ▼
        Stage 1 (template-runtime) → Stage 2 (runStage2ForDraft)
```

"Description to Stage 1" and "image to Stage 2" become **two independent field filters on the same pool card**, not two parallel id lists at the chat-config level. User manages everything via Whitelist + card editor.

### Removals

| Layer | What | Location |
|---|---|---|
| UI | `<details data-source="desc">` (panel 6) | `tab-generate.js:280` |
| UI | `renderDescRefsChips()` (whole function) | `tab-generate.js:793-839` |
| UI | `renderDescRefsChips` call from `refreshReferencePanel` | `tab-generate.js:739` |
| Schema | `descRefs: []` in `DEFAULT_CHAT_CONFIG_ENVELOPE.refs` | `core.js:198` |
| Schema | `normalizeDescRefs()` (whole function) | `core.js:292-300` |
| Schema | `descRefs` branches in `getChatRefs`/`saveChatRefs` | `refs-library.js:170,194` |
| Schema | `descRefs` in `chat-binding.js` (2 sites) | `chat-binding.js:91,209` |
| Schema | `descRefs` in `migratePoolOnlyReferences` | `refs-library.js:326` |
| Pipeline | `collectDescRefsForCurrentChat()` (whole) | `refs-library.js:286-299` |
| Pipeline | import of `collectDescRefsForCurrentChat` | `pipeline.js:17` |
| Pipeline | `runStage1()` (whole, legacy) | `pipeline.js:145-218` |
| Pipeline | `runFullPipeline()` (whole, legacy) | `pipeline.js:574-587` |

### Unchanged

- Live pipeline `runStage1ForDraft` / `runStage2ForDraft` / `runFullPipelineForDraft` — zero logic changes.
- `runStage2` (positional adapter) — live, called from `tab-gallery.js`.
- `buildSceneContextSnapshot` — already does what's needed.
- Whitelist, preview, queue.
- `corrections.includedIds` on draft — remains the only "force-include in scene" mechanism.

### Behavioral consequence

After refactor, description goes to Stage 1 **only if the card's alias is mentioned in the post text** (via `resolveEntitiesFromText`). For always-present-but-unmentioned characters, use `corrections.includedIds` on the specific draft (already supported).

## Module split (Section 2)

After removing legacy code, `pipeline.js` shrinks from 706 → ~516 lines and naturally splits into 4 focused modules. `pipeline.js` becomes a thin barrel re-exporting the public API so no importer needs to change.

### Target structure

```
src/
├── pipeline.js          ← barrel: re-exports public API only, no logic
├── pipeline-config.js   ← createChatConfigSnapshot, resolveChatConfigSnapshot, resolveActivePresets
├── pipeline-stage1.js   ← buildCandidates, resolveTemplateForDraft, runStage1ForDraft, runFullPipelineForDraft
├── pipeline-stage2.js   ← loadDraftForStage2, runStage2ForDraft, runStage2 (positional adapter)
└── pipeline-queue.js    ← createQueueItem, enqueueGeneration, enqueue, processQueue, stopQueue
```

### Per-current-line mapping

| Current lines | Content | Destination |
|---|---|---|
| L1-43 | imports + `hashMes()` | distributed to each module |
| L44-68 | `createChatConfigSnapshot()` | `pipeline-config.js` |
| L70-88 | `resolveChatConfigSnapshot()` | `pipeline-config.js` |
| L90-125 | `resolveActivePresets()` | `pipeline-config.js` |
| L127-218 | **`runStage1` legacy** | **deleted** |
| L220-237 | `buildCandidates()` | `pipeline-stage1.js` |
| L239-248 | `resolveTemplateForDraft()` | `pipeline-stage1.js` |
| L250-333 | `runStage1ForDraft()` | `pipeline-stage1.js` |
| L335-356 | `runFullPipelineForDraft()` | `pipeline-stage1.js` |
| L358-376 | `loadDraftForStage2()` | `pipeline-stage2.js` |
| L378-537 | `runStage2ForDraft()` | `pipeline-stage2.js` |
| L539-563 | `runStage2()` positional adapter | `pipeline-stage2.js` |
| L565-587 | **`runFullPipeline` legacy** | **deleted** |
| L589-612 | `createQueueItem()` | `pipeline-queue.js` |
| L614-625 | `enqueueGeneration()` | `pipeline-queue.js` |
| L627-644 | `enqueue()` compat | `pipeline-queue.js` |
| L646-697 | `processQueue()` | `pipeline-queue.js` |
| L699-705 | `stopQueue()` | `pipeline-queue.js` |

### Dependency direction (no cycles)

```
pipeline-config.js
    ▲
    │
pipeline-stage1.js ───► scene-context, generation-drafts, template-runtime, pipeline-stage2.js
    ▲
    │ (runFullPipelineForDraft calls runStage2ForDraft)
    │
pipeline-queue.js ───► pipeline-stage1.js + pipeline-stage2.js
```

Stage 2 does not depend on Stage 1 → no cycle.

### `runFullPipelineForDraft` placement

Goes in `pipeline-stage1.js`, imports `runStage2ForDraft` from `pipeline-stage2.js`. Rationale: Stage 1 is the entry point; Stage 2 is the tail. Symmetric with `processQueue` in `pipeline-queue.js` (also orchestrates both stages, no concern). Barrel stays pure re-export.

### Barrel contents

```js
// pipeline.js — public API barrel
export { createChatConfigSnapshot, resolveActivePresets } from './pipeline-config.js';
export { buildCandidates, runStage1ForDraft, runFullPipelineForDraft } from './pipeline-stage1.js';
export { runStage2ForDraft, runStage2 } from './pipeline-stage2.js';
export { createQueueItem, enqueueGeneration, enqueue, stopQueue } from './pipeline-queue.js';
```

All existing importers (`index.js`, `tab-generate.js`, `tab-gallery.js`, tests) continue to work unchanged.

### Removed from public API

- `runStage1` (legacy)
- `runFullPipeline` (legacy)

Neither has any importer (verified via grep).

## Tests (Section 3)

### Category A — Delete entirely (unit tests of dead function)

| File:line | Test |
|---|---|
| `refs-library.test.js:235` | `collectDescRefsForCurrentChat: pinned always included` |
| `refs-library.test.js:243` | `collectDescRefsForCurrentChat: auto uses aliases only` |
| `refs-library.test.js:251` | `collectDescRefsForCurrentChat: skips empty description` |
| `refs-library.test.js:259` | `collectDescRefsForCurrentChat: skips deleted refId` |
| `refs-library.test.js:173` | `getChatRefs normalizes descRefs with defaults` |
| `pool-only-references.test.js:81` | `collectDescRefsForCurrentChat matches aliases only for auto descriptions` |
| `pool-only-references.test.js:97` | `collectDescRefsForCurrentChat treats a multiword alias as one exact phrase` |

### Category B — Update assertions (schema/round-trip tests)

Remove `descRefs: [...]` from expected objects / fixtures, keep only `referenceIds`:

- `chat-binding.test.js` — lines 113, 173, 189, 209, 221, 227, 261, 274, 285, 292
- `data-port.test.js` — lines 190, 207, 226, 411, 424, 442, 478, 497, 527, 567, 585
- `final-verification.test.js` — lines 35, 185, 196, 235, 253, 277
- `refs-library.test.js` — lines 157, 168, 307, 334, 343, 348, 356, 362
- `events.test.js` — lines 225, 328

After: `defaultChatRefs()` returns `{ referenceIds: [] }` (no `descRefs` key).

### Category C — Smoke test (special)

`smoke.test.js:259` currently asserts `collectDescRefsForCurrentChat` appears in `pipeline.js` ≤2 times. Invert it to assert **full removal from `src/`**:

```js
test('source: collectDescRefsForCurrentChat is fully removed from src/', () => {
    const code = readSrc('pipeline.js');
    const matches = code.match(/collectDescRefsForCurrentChat/g) || [];
    assert.strictEqual(matches.length, 0,
        'collectDescRefsForCurrentChat should be removed — descRefs path is dead');
});
```

### Category D — Pipeline test import paths

`pipeline-scene-first.test.js` imports from `'../src/pipeline.js'` — leave untouched. Barrel re-exports keep the contract stable.

### Category E — `pipeline-scene-first.test.js:904`

Test "prompt-first corrections do not mutate chat-scoped referenceIds or descRefs" — drop the `descRefs` setup and assertions, keep the `referenceIds` invariants:

```js
test('prompt-first corrections do not mutate chat-scoped referenceIds', async () => {
    saveChatRefs({ referenceIds: ['legacy-extra', aaron.id] });
    const before = getChatRefs();
    // ... run pipeline ...
    const after = getChatRefs();
    assert.deepEqual(after.referenceIds, before.referenceIds);
});
```

### Data compatibility

No migration. Stale `descRefs` in existing chat metadata is ignored by readers and not written by `saveChatRefs`. Optional: in `saveChatRefs`, on next write, `delete binding.refs.descRefs` to clean up lazily. Import path may drop `descRefs` for cleanliness (optional).

## Implementation phases

Structural multi-phase refactor — run tests after each phase.

1. **Phase 1 — Remove dead code.** Delete `runStage1`, `runFullPipeline`, `collectDescRefsForCurrentChat`, `normalizeDescRefs`, the 6th panel HTML, `renderDescRefsChips`, all `descRefs` branches in schema/config. Update Category A/B/C/D/E tests. Run `npm test` → expect green.

2. **Phase 2 — Split `pipeline.js`.** Create `pipeline-config.js`, `pipeline-stage1.js`, `pipeline-stage2.js`, `pipeline-queue.js`. Move functions per the line mapping. Convert `pipeline.js` to barrel. Run `npm test` → expect green (imports unchanged due to barrel).

3. **Phase 3 — Verification.** Final full test run. Confirm zero references to `descRefs` / `collectDescRefsForCurrentChat` / `runStage1` / `runFullPipeline` in `src/`.

## Out of scope

- No changes to live Stage 1 / Stage 2 / queue logic.
- No pinned-always semantics replacement at chat-config level (use `corrections.includedIds` on drafts).
- No data migration.
- No `runStage2` positional adapter removal (still used by gallery).
