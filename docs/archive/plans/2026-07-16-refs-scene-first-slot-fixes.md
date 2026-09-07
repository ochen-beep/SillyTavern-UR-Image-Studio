# Scene-first references — pinned slot + mode filter fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pinned `{{char}}`/`{{user}}` slot references (with aliases and image) actually participate in the scene-first flow on the Generate tab, and make the Stage2 mode badge (`Никогда / Умный / Всегда`) actually filter Stage2 references.

**Architecture:** Two surgical patches layered on top of the scene-first cutover (`e23714c`). (1) `buildCandidates()` reads `getChatRefs().charSlot/userSlot`: when a slot is pinned, the corresponding `char`/`user` SceneEntity inherits `name`, `aliases`, `imagePath`, `description` from the pool ref, and that ref is dropped from the NPC candidate list so it cannot cause ambiguity against itself. (2) A small pure helper `filterRefsByMode(refs, mode)` is applied both at Stage2 materialization (`runStage2ForDraft`) and at the live-preview renderer (`renderLivePreview`) so `mode='never'` zeroes Stage2 refs on the wire and in the UI. No changes to the immutable snapshot shape or the template runtime.

**Tech Stack:** Vanilla JS (ES modules), SillyTavern extension APIs, `node:test` + `node:assert/strict` for tests.

**Background — verified against SillyTavern source (`release` branch):**
- `personas.js::lockPersona` / `selectCurrentPersona` set `chat_metadata.persona = user_avatar` (avatar filename). `power_user.personas[avatarId] = personaName` (keyed by filename, not persona name). `USER_AVATAR_PATH = 'User Avatars/'`, so avatar URL is `User Avatars/<avatarId>`. URIS only **reads** these (never writes) and fetches the file directly; it does not register a `generate_interceptor` or `personaDescription` hijack (verified: 0 matches for `hijack|interceptor|personaDescription` across `src/`).
- `getContext()` (in `public/scripts/st-context.js`) exposes `chatMetadata: chat_metadata`, `powerUserSettings: power_user`, `name1`, `name2`, `characterId: this_chid`, `chatId`, `characters`, `event_types`, `saveMetadata`, `getRequestHeaders`. It does **not** expose `personas`/`default_persona`/`getCharacterAvatar`/`getUserAvatar` directly — URIS reaches them through `powerUserSettings.personas` / `.default_persona` (correct) and uses the legacy `/characters/<avatar>` URL fallback when `typeof ctx.getCharacterAvatar !== 'function'` (`src/references.js:43`).
- Per the scene-first implementation plan (`docs/superpowers/plans/2026-07-15-scene-first-generation-implementation.md:353`): *"Never split canonical names; never read `keywords` or `description` in `detectEntityMentions()`."* So keywords are intentionally excluded from mention detection — the fix is to **carry the pinned ref's `aliases`** onto the `user`/`char` entity, not to start reading `keywords` in the detector.
- Per the references-redesign spec (`docs/superpowers/specs/2026-07-14-references-redesign-design.md`): the shared `mode` (`always`/`smart`/`never`) is a filter **for Stage2 images only** and does not affect Stage1 text. The singleton `chatRefs.userSlot/charSlot` (pinned→refId, otherwise auto) is the canonical source of truth for those two slots.

---

## Root causes (confirmed by reading the code)

1. `src/pipeline.js:182-214` `buildCandidates()` hard-codes `aliases: []` and `imagePath: ''` for the `user` entity and uses `ctx.name1` as its name, ignoring `chatRefs.userSlot`. Pinned pool refs are pushed as **separate NPC candidates**, so the same name (`Rada`) ends up matching both the `user` candidate (via `name` "Рада"/`ctx.name1`) and the NPC candidate (via `aliases` "Рада"/"Rada") → `buildSceneContextSnapshot` (`src/scene-context.js:213-224`) flags them as ambiguous → the NPC `Rada` is dropped (`scene-context.js:247-251`) → the `user` entity has no `imagePath` → `snapshot.stage2Refs` is empty → Stage2 sends nothing.
2. `src/pipeline.js:425` `materializeStage2References(contextSnapshot)` consumes `snapshot.stage2Refs` as-is; no code in the scene-first flow consults `chatRefs.mode`. The mode badge in the UI (`src/ui/tab-generate.js:457-466`) calls `saveChatRefs({mode})` but the persistence is silently ignored by Stage2 → identical behaviour across Never/Smart/Always.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/pipeline.js` | `buildCandidates()` builds SceneEntity[] from ST context + pool | Modify: read `getChatRefs().charSlot/userSlot`; pin inherited fields; drop pinned refs from NPC list |
| `src/refs-library.js` | Chat-scoped refs binding + collect/preview helpers | Add exported pure `filterRefsByMode(refs, mode)` |
| `src/ui/tab-generate.js` | Generate tab renderer + Stage2 actions | Modify: `renderLivePreview` applies `filterRefsByMode` so the UI matches the wire |
| `tests/pipeline-scene-first.test.js` | Scene-first integration tests | Add: `buildCandidates` pinned-slot test, `runStage1ForDraft` end-to-end pinned-user test |
| `tests/refs-library.test.js` | refs-library unit tests | Add: `filterRefsByMode` tests |

---

## Task 1: `buildCandidates` applies pinned `charSlot` / `userSlot`

**Files:**
- Modify: `src/pipeline.js:182-214` (replace `buildCandidates` body)
- Modify: `src/pipeline.js:17` (import `getChatRefs`, `getRefSync` from `./refs-library.js`)
- Test: `tests/pipeline-scene-first.test.js` (append two new tests; add a top-of-file `import { META_KEY } from '../src/core.js';`)

- [ ] **Step 1: Write the failing test for `buildCandidates` pinned user slot**

Append to `tests/pipeline-scene-first.test.js` (after the existing test block, before EOF). Add the `META_KEY` import at the top of the file next to the existing `import` lines:

```js
import { META_KEY } from '../src/core.js';
```

Then append these tests at the bottom of `tests/pipeline-scene-first.test.js`:

```js
test('buildCandidates: pinned userSlot ref supplies name/aliases/imagePath and is de-duped from NPC list', async () => {
    const refRecord = {
        id: 'r-user-pinned',
        name: 'Rada',
        aliases: ['Рада', 'Rada'],
        keywords: ['Рада', 'Rada'],
        description: 'auburn hair, scar on cheek',
        imagePath: '/URIS_Refs/rada.webp',
        folderId: null,
        createdAt: 0,
    };
    await lfMock.setItem('uris_refs_pool', [refRecord]);
    const { refreshPoolCache } = await import('../src/refs-library.js');
    await refreshPoolCache();

    const chatMetadata = {};
    const ctxBase = globalThis.SillyTavern.getContext();
    globalThis.SillyTavern.getContext = () => ({
        ...ctxBase,
        chatId: 'chat-bind',
        chatMetadata,
    });
    try {
        const { saveChatRefs } = await import('../src/refs-library.js');
        await saveChatRefs({
            mode: 'always',
            charSlot: { type: 'auto' },
            userSlot: { type: 'pinned', refId: 'r-user-pinned' },
            extraRefIds: [],
            descRefs: [],
        });

        const { buildCandidates } = await import('../src/pipeline.js');
        const candidates = await buildCandidates('chat-bind');

        const userC = candidates.find(c => c.id === 'user');
        assert.equal(userC.name, 'Rada');
        assert.deepEqual(userC.aliases, ['Рада', 'Rada']);
        assert.equal(userC.imagePath, '/URIS_Refs/rada.webp');
        assert.equal(userC.description, 'auburn hair, scar on cheek');

        // Pinned ref id MUST NOT appear again in the NPC list (otherwise the
        // same mention produces an ambiguity and the NPC is dropped).
        const dupNpc = candidates.filter(c => c.role === 'npc' && c.id === 'r-user-pinned');
        assert.equal(dupNpc.length, 0);
    } finally {
        globalThis.SillyTavern.getContext = () => ctxBase;
    }
});

test('buildCandidates: auto userSlot (no pin) keeps ctx.name1 and empty aliases/imagePath', async () => {
    const ctxBase = globalThis.SillyTavern.getContext();
    globalThis.SillyTavern.getContext = () => ({
        ...ctxBase,
        chatId: 'chat-auto',
        chatMetadata: {},
    });
    try {
        const { buildCandidates } = await import('../src/pipeline.js');
        const candidates = await buildCandidates('chat-auto');
        const userC = candidates.find(c => c.id === 'user');
        assert.equal(userC.name, 'Alex');
        assert.deepEqual(userC.aliases, []);
        assert.equal(userC.imagePath, '');
    } finally {
        globalThis.SillyTavern.getContext = () => ctxBase;
    }
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --test tests/pipeline-scene-first.test.js`
Expected: FAIL — `userC.name` is `Alex` (from `ctx.name1`), not `Rada`; `userC.aliases` is `[]`.

- [ ] **Step 3: Add the `getChatRefs` / `getRefSync` import to `src/pipeline.js`**

In `src/pipeline.js` locate the existing import from `./refs-library.js` (line 17):

```js
import { collectRefsForCurrentChat, collectDescRefsForCurrentChat, listRefs } from './refs-library.js';
```

Replace it with:

```js
import { collectRefsForCurrentChat, collectDescRefsForCurrentChat, listRefs, getChatRefs, getRefSync } from './refs-library.js';
```

- [ ] **Step 4: Rewrite `buildCandidates` body**

In `src/pipeline.js`, replace the `buildCandidates(chatId)` function body (lines 182-214) with:

```js
export async function buildCandidates(chatId) {
    const ctx = getCtx();
    const candidates = [];

    const chatRefs = getChatRefs();
    const slotRef = (slot) =>
        slot && slot.type === 'pinned' && slot.refId ? getRefSync(slot.refId) : null;

    // char — pinned ref overrides name/aliases/description/imagePath; otherwise fall back to ST.
    const charSlotRef = slotRef(chatRefs.charSlot);
    const charDef = ctx.characters?.[ctx.characterId];
    const charName = charSlotRef?.name
        || ctx.name2
        || charDef?.name
        || '';
    const charDesc = charSlotRef?.description
        || charDef?.description
        || '';
    const charAvatar = charSlotRef?.imagePath
        || (charDef?.avatar ? `/characters/${encodeURIComponent(charDef.avatar)}` : '');
    candidates.push(normalizeSceneEntity({
        id: 'char',
        name: charName,
        aliases: charSlotRef?.aliases || [],
        description: charDesc,
        imagePath: charAvatar,
    }, 'char'));

    // user — pinned ref supplies the canonical {{user}} identity for this chat.
    const userSlotRef = slotRef(chatRefs.userSlot);
    candidates.push(normalizeSceneEntity({
        id: 'user',
        name: userSlotRef?.name || ctx.name1 || '',
        aliases: userSlotRef?.aliases || [],
        description: userSlotRef?.description || '',
        imagePath: userSlotRef?.imagePath || '',
    }, 'user'));

    // Pool refs become NPC candidates, EXCEPT those already consumed by a pinned slot.
    const slotRefIds = new Set(
        [chatRefs.charSlot?.refId, chatRefs.userSlot?.refId].filter(Boolean),
    );
    const refs = await listRefs();
    for (const ref of refs) {
        if (slotRefIds.has(ref.id)) continue;
        candidates.push(normalizeSceneEntity(ref, 'npc'));
    }

    return candidates;
}
```

- [ ] **Step 5: Run test to verify pass**

Run: `node --test tests/pipeline-scene-first.test.js`
Expected: PASS — the two new tests pass and the existing 12 tests still pass.

- [ ] **Step 6: Add an end-to-end regression test that the pinned user ref reaches Stage 2**

Append a third test to `tests/pipeline-scene-first.test.js`:

```js
test('runStage1ForDraft with pinned userSlot surfaces pinned ref in snapshot.stage2Refs', async () => {
    await setupTextApi();
    textResponse = 'Rada stands by the wall.';
    await lfMock.setItem('uris_refs_pool', [{
        id: 'r-user-pinned',
        name: 'Rada',
        aliases: ['Рада', 'Rada'],
        keywords: ['Рада', 'Rada'],
        description: 'auburn hair, scar on cheek',
        imagePath: '/URIS_Refs/rada.webp',
        folderId: null,
        createdAt: 0,
    }]);
    const { refreshPoolCache, saveChatRefs } = await import('../src/refs-library.js');
    await refreshPoolCache();

    const chatMetadata = {};
    const ctxBase = globalThis.SillyTavern.getContext();
    globalThis.SillyTavern.getContext = () => ({
        ...ctxBase,
        chatId: 'chat-e2e',
        chatMetadata,
    });
    try {
        await saveChatRefs({
            mode: 'always',
            charSlot: { type: 'auto' },
            userSlot: { type: 'pinned', refId: 'r-user-pinned' },
            extraRefIds: [],
            descRefs: [],
        });

        const { runStage1ForDraft } = await import('../src/pipeline.js');
        const run = await runStage1ForDraft({
            chatId: 'chat-e2e',
            msgId: 1,
            messageText: 'Рада стоит у стены.',
            templateId: null,
        });
        assert.equal(run.applied, true);

        const userRefs = run.snapshot.stage2Refs.filter(r => r.role === 'user');
        assert.equal(userRefs.length, 1);
        assert.equal(userRefs[0].name, 'Rada');
        assert.equal(userRefs[0].imagePath, '/URIS_Refs/rada.webp');
        // NPC with the same refId must not be sent twice.
        const npcsWithSame = run.snapshot.stage2Refs.filter(
            r => r.role === 'npc' && r.id === 'r-user-pinned',
        );
        assert.equal(npcsWithSame.length, 0);
    } finally {
        globalThis.SillyTavern.getContext = () => ctxBase;
    }
});
```

- [ ] **Step 7: Run the new end-to-end test to verify pass**

Run: `node --test tests/pipeline-scene-first.test.js`
Expected: PASS — the pinned `Rada` ref is the single `user` entry in `stage2Refs` and no duplicate NPC is present.

- [ ] **Step 8: Run the full test suite to verify no regressions so far**

Run: `node --test`
Expected: All existing tests + new tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/pipeline.js tests/pipeline-scene-first.test.js
git commit -m "fix(refs): apply chatRefs char/user pinned slots in buildCandidates"
```

---

## Task 2: `filterRefsByMode` + apply in Stage2 and live-preview

**Files:**
- Modify: `src/refs-library.js` (add `filterRefsByMode` export)
- Modify: `src/pipeline.js:415-425` (apply filter in `runStage2ForDraft` after materialize)
- Modify: `src/ui/tab-generate.js:659-687` (apply filter in `renderLivePreview`)
- Test: `tests/refs-library.test.js` (add `filterRefsByMode` tests)

- [ ] **Step 1: Write failing tests for `filterRefsByMode`**

Append to `tests/refs-library.test.js` (after the existing collect/preview tests near the end of the file):

```js
test('filterRefsByMode: never yields empty list', () => {
    const refs = [{ role: 'char', name: 'Aria' }, { role: 'user', name: 'Alex' }];
    assert.deepEqual(filterRefsByMode(refs, 'never'), []);
});

test('filterRefsByMode: smart and always pass refs through untouched', () => {
    const refs = [{ role: 'char', name: 'Aria' }, { role: 'user', name: 'Alex' }];
    assert.deepEqual(filterRefsByMode(refs, 'smart'), refs);
    assert.deepEqual(filterRefsByMode(refs, 'always'), refs);
});

test('filterRefsByMode: unknown mode falls back to passthrough', () => {
    const refs = [{ role: 'char', name: 'Aria' }];
    assert.deepEqual(filterRefsByMode(refs, 'garbage'), refs);
    assert.deepEqual(filterRefsByMode(refs, undefined), refs);
});
```

Add the import at the top of `tests/refs-library.test.js` with the other `refs-library.js` imports (replace the existing line that already imports from `../src/refs-library.js`):

```js
import { listRefs, getRef, createRef, updateRef, deleteRef, filterRefsByMode } from '../src/refs-library.js';
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/refs-library.test.js`
Expected: FAIL — `filterRefsByMode is not a function` (or import error).

- [ ] **Step 3: Implement `filterRefsByMode` in `src/refs-library.js`**

Add this export anywhere among the other pure helpers (e.g. just below `previewRefsForCurrentChat`, around line 360):

```js
/**
 * Apply the chat-scoped Stage2 mode to a resolved refs list.
 * 'never' zeroes Stage2 refs; 'smart'/'always' (and any unknown value)
 * pass the list through — the snapshot already implements smart NPC selection.
 *
 * @param {Array<{role:string,name:string}>} refs
 * @param {'never'|'smart'|'always'|null|undefined} [mode]
 * @returns {Array<typeof refs[number]>}
 */
export function filterRefsByMode(refs, mode) {
    if (mode === 'never') return [];
    return Array.isArray(refs) ? refs : [];
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/refs-library.test.js`
Expected: PASS — the three new tests pass.

- [ ] **Step 5: Apply `filterRefsByMode` in `runStage2ForDraft` (Stage2 wire)**

Open `src/pipeline.js`, locate `runStage2ForDraft` around line 415-427. Today it reads:

```js
        let refs;
        if (Array.isArray(opts.refs)) {
            refs = opts.refs.map(r => ({
                id: r.id || '',
                role: r.role,
                name: r.name || '',
                dataUrl: r.image,
            }));
            log('pipeline: используются готовые референсы (opts.refs)', { count: refs.length });
        } else {
            refs = await materializeStage2References(contextSnapshot);
        }
        log('pipeline: собраны референсы', { count: refs.length });
```

Replace it with (note the added `getChatRefs`/`filterRefsByMode` usage; `getChatRefs` was already imported by Task 1 Step 3, and `filterRefsByMode` needs to be added to the same import line):

```js
        let refs;
        if (Array.isArray(opts.refs)) {
            refs = opts.refs.map(r => ({
                id: r.id || '',
                role: r.role,
                name: r.name || '',
                dataUrl: r.image,
            }));
            log('pipeline: используются готовые референсы (opts.refs)', { count: refs.length });
        } else {
            refs = await materializeStage2References(contextSnapshot);
        }
        // Apply chat-scoped Stage2 mode: 'never' zeroes refs on the wire.
        refs = filterRefsByMode(refs, getChatRefs().mode);
        log('pipeline: собраны референсы', { count: refs.length });
```

Then extend the existing `./refs-library.js` import line in `src/pipeline.js` to also bring in `filterRefsByMode`:

```js
import { collectRefsForCurrentChat, collectDescRefsForCurrentChat, listRefs, getChatRefs, getRefSync, filterRefsByMode } from './refs-library.js';
```

- [ ] **Step 6: Apply `filterRefsByMode` in `renderLivePreview` (UI parity)**

Open `src/ui/tab-generate.js`. Add `filterRefsByMode` to the import from `../refs-library.js` (line 17-20):

```js
import {
    getChatRefs, saveChatRefs, getRefSync,
    getUserAvatarDataUrlForCurrent, MAX_REFS, filterRefsByMode,
} from '../refs-library.js';
```

In `renderLivePreview` (`src/ui/tab-generate.js:659-687`), today it reads:

```js
    const refs = snap?.stage2Refs || [];
    if (!refs.length) {
        host.innerHTML = '<small class="uris-refs-empty">→ референсы не отправятся</small>';
        return;
    }
    host.innerHTML = `<span class="uris-refs-empty">→ Уйдёт (${refs.length}/${MAX_REFS}):</span>` +
```

Replace the first line (`const refs = ...`) with a mode-filtered value:

```js
    const rawRefs = snap?.stage2Refs || [];
    const refs = filterRefsByMode(rawRefs, getChatRefs().mode);
    if (!refs.length) {
        host.innerHTML = '<small class="uris-refs-empty">→ референсы не отправятся</small>';
        return;
    }
    host.innerHTML = `<span class="uris-refs-empty">→ Уйдёт (${refs.length}/${MAX_REFS}):</span>` +
```

(The remaining `.map(...)` block stays unchanged and operates on the now-filtered `refs`.)

- [ ] **Step 7: Add an integration test for the Stage2 wire with `mode='never'`**

Append to `tests/pipeline-scene-first.test.js`:

```js
test('runStage2ForDraft with mode=never sends zero refs to the image provider', async () => {
    await setupTextApi();
    await setupImageApi();

    await lfMock.setItem('uris_refs_pool', [{
        id: 'r-user-pinned',
        name: 'Rada',
        aliases: ['Рада', 'Rada'],
        keywords: ['Рада', 'Rada'],
        description: '',
        imagePath: '/URIS_Refs/rada.webp',
        folderId: null,
        createdAt: 0,
    }]);
    const { refreshPoolCache, saveChatRefs } = await import('../src/refs-library.js');
    await refreshPoolCache();

    const chatMetadata = {};
    const ctxBase = globalThis.SillyTavern.getContext();
    globalThis.SillyTavern.getContext = () => ({
        ...ctxBase,
        chatId: 'chat-never',
        chatMetadata,
    });

    let observedReferences = null;
    try {
        await saveChatRefs({
            mode: 'never',
            charSlot: { type: 'auto' },
            userSlot: { type: 'pinned', refId: 'r-user-pinned' },
            extraRefIds: [],
            descRefs: [],
        });

        // Seed a confirmed Stage 1 draft so Stage 2 does not rebuild the snapshot.
        const { runStage1ForDraft } = await import('../src/pipeline.js');
        textResponse = 'Rada stands by the wall.';
        await runStage1ForDraft({
            chatId: 'chat-never',
            msgId: 1,
            messageText: 'Рада стоит у стены.',
            templateId: null,
        });

        // Intercept generateImageRequest by spying on image fetch URL prefix.
        const restore = mockFetch((url) => {
            if (typeof url === 'string' && url.includes('image.pollinations.ai')) {
                observedReferences = (observedReferences || []);
                observedReferences.push(url);
            }
            return { ok: true, status: 200, blob: async () => new Blob(['x'], { type: 'image/png' }) };
        });

        const { runStage2ForDraft } = await import('../src/pipeline.js');
        await runStage2ForDraft({
            chatId: 'chat-never',
            msgId: 1,
            messageText: 'Рада стоит у стены.',
            templateId: null,
        }, () => {}, null);
        restore();

        // The pollinations provider encodes refs as a `references=<n>` query or
        // PROMPT marker; what we care about is that the resolve chain never
        // materialised refs: assert via the materializeStage2References path.
        // Snapshot may still carry stage2Refs, so inspect the pending draft
        // stage2.lastSubmittedSnapshot.refs.
        const { getGenerationDraft } = await import('../src/generation-drafts.js');
        const draft = await getGenerationDraft('chat-never', 1, 'Рада стоит у стены.');
        assert.equal(draft.stage2?.lastSubmittedSnapshot?.refs?.length, 0);
    } finally {
        globalThis.SillyTavern.getContext = () => ctxBase;
    }
});
```

> Note: `stage2.lastSubmittedSnapshot` is part of the existing snapshot shape produced by `createStage2Snapshot({ draft, contextSnapshot, refs })` (`src/pipeline.js:433`); the `refs` array passed to that helper is now the filtered one.

- [ ] **Step 8: Run the integration test to verify pass**

Run: `node --test tests/pipeline-scene-first.test.js`
Expected: PASS — `draft.stage2.lastSubmittedSnapshot.refs.length === 0` when `mode === 'never'`, even though `userSlot` is pinned.

- [ ] **Step 9: Run the full test suite**

Run: `node --test`
Expected: All existing tests + new tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/refs-library.js src/pipeline.js src/ui/tab-generate.js tests/refs-library.test.js tests/pipeline-scene-first.test.js
git commit -m "fix(refs): apply Stage2 mode filter on the wire and in live preview"
```

---

## Task 3: Manual verification + changelog note

**Files:**
- Modify: `docs/changelog.md` (add a one-line entry if the changelog exists; skip otherwise)

- [ ] **Step 1: Starter verification in SillyTavern**

With ST running and the extension reloaded, open the Generate tab, open a chat where `{{user}}` = Рада, pick a pool ref named `Rada` with aliases `Рада, Rada` as the `{{user}}` pinned slot, and a message post containing the word «Рада»:

1. The `#urisRefsSlots > div:nth-child(2)` row shows the pinned `Rada` ref name and image preview.
2. The live preview below (`.uris-refs-panel-preview`) shows `→ Уйдёт (2/4):` with `{{char}}` and the `Rada` ref (as `user`).
3. Switch the mode badge to «Никогда» — the live preview switches to `→ референсы не отправятся`.
4. Click «Сгенерировать» in «Никогда» — the image generates **without** any reference images attached (provider metadata ends with `refs: 0`).
5. Switch to «Умный» and click «Сгенерировать» — the `Rada` reference image is attached (single text prompt round-trip).

- [ ] **Step 2: Confirm no console errors related to URIS**

In the ST browser console, the only `[URIS]` lines for this flow should be `Chat refs обновлены …`, `Собрано референсов: N` (N = 0 in Never mode), and `Stage 2 готова …`. No `Uncaught` errors mentioning `refs-library`, `pipeline`, or `tab-generate`.

- [ ] **Step 3: Add changelog entry**

If `docs/changelog.md` exists, append under the topmost dated section:

```
- Pinned `{{user}}`/`{{char}}` pool ref now participates in scene-first Stage2 on the Generate tab (previously dropped as an ambiguous NPC). Stage2 mode «Никогда» zeroes references on the wire and in the live preview.
```

If there is no `docs/changelog.md`, skip this step.

- [ ] **Step 4: Commit**

```bash
git add docs/changelog.md
git commit -m "docs(changelog): note pinned-slot and mode-filter Stage2 fix"
```

(Skip the commit if Step 3 was skipped.)

---

## Self-review against the spec

- **Spec coverage** — Spec/plan 2026-07-14 (references redesign): the shared `mode` is a filter for Stage2 images only. `filterRefsByMode` implements exactly that. ✅
- **Spec coverage** — Plan 2026-07-15 scene-first (`docs/superpowers/plans/2026-07-15-scene-first-generation-implementation.md:353`): "never read `keywords` or `description` in `detectEntityMentions()`". The fix carries **aliases** from the pinned ref; no change to the detector. ✅
- **Bug A** (pinned slot ignored in `buildCandidates`): covered by Task 1 (entity inheritance + NPC de-duplication). ✅
- **Bug B** (keywords not read): intentional per spec; resolved indirectly because pinned-ref `aliases` now ride the `user`/`char` entity. ✅
- **Bug C** (mode buttons inert): covered by Task 2 (filter on wire + UI parity). ✅
- **Placeholder scan**: every step has concrete code/commands; no "TODO"/"add appropriate" wording. ✅
- **Type consistency**: `filterRefsByMode(refs, mode)` signature is identical in `refs-library.js`, `tests/refs-library.test.js`, `src/pipeline.js`, `src/ui/tab-generate.js`. ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-16-refs-scene-first-slot-fixes.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, with two-stage review between tasks.
2. **Inline Execution** — batched execution with checkpoints in this session.

Which approach?