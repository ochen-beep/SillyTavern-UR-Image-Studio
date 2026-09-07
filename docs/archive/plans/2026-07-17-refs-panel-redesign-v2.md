# References Panel Redesign v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Унифицировать управление Stage 1/2 референсами в компактной панели `#urisRefsPanel`, удалить режим `mode` в пользу авто-детекта + ручных коррекций, исправить неотправляемый аватар `{{user}}`, сузить NPC-кандидатов до whitelist `extraRefIds`, и добавить алиасы для `{{char}}/{{user}}`.

**Architecture:** Stage 2 остаётся prompt-driven (`resolvePromptReferenceContext`, `alwaysIncludeRoles: []`). Меняется только то, как строится candidate-список: `buildCandidates` теперь берёт char/user slot (ST аватар или pinned ref из пула, плюс алиасы) и NPC только из `chatRefs.extraRefIds`. UI `#urisRefsPanel` становится двухъярусным: верхняя лента эффективных refs с `×` / trailing `＋`-плиткой, нижние сворачиваемые секции источников (Слоты / NPC whitelist / Stage 1 описания).

**Tech Stack:** Vanilla ESM JS, `node:test` + `node:assert/strict` для unit-тестов, SillyTavern extension API, CSS в `style.css`.

---

## Design Summary (одобренный дизайн)

**Модель данных** (`chatRefs`, `chatMetadata.uris_binding.refs`):
```js
{
  // mode удалён; legacy-значения молча игнорируются
  charSlot: { type:'auto'|'pinned', refId?: string, aliases?: string[] },
  userSlot: { type:'auto'|'pinned', refId?: string, aliases?: string[] },
  extraRefIds: string[],
  descRefs: Array<{refId:string, mode:'auto'|'pinned'}>,
}
```
- `charSlot.aliases`, `userSlot.aliases` — новые, по умолчанию `[]`.
- `draft.references = { includedIds, excludedIds, revision }` — без изменений; apply: `(auto − excluded) ∪ included`.

**Candidate resolver (`buildCandidates`)**: char (ST avatar или pinned ref + aliases), user (path к аватару ST: **новое** `resolveUserAvatarPathForCurrent()` или pinned ref + aliases), NPC whitelist из `extraRefIds`. Записи пула вне `extraRefIds` больше не candidates.

**UI `#urisRefsPanel`**:
- Шапка: `Референсы ............... ⚙` (без badge режима).
- Ярус 1 (Effective, → Stage 2): лента 64×64 thumbs, role caption, `×` в углу, source-полоска снизу (char=золото, user=синий, npc=серий), 📌+зелёная окантовка для `includedIds`, trailing `＋`-плитка (pool picker → `includedIds` + auto-add в `extraRefIds`). Cap-индикатор `N/M` в заголовке строки.
- Ярус 2 (Sources): три `<details>`-секции:
  - **Слоты {char}/{user}** (свёрнуты): аватар 28×28, имя read-only, поле «Алиасы», ⚙-кнопка для pinned ref.
  - **NPC whitelist** (раскрыт при непустом `extraRefIds`): чипы 48×48 + имя + `×`, trailing `＋` (pool picker multi → `extraRefIds`).
  - **Stage 1 описания** (раскрыт при непустом `descRefs`): чипы 48×48 + имя + toggle `🔄↔📌`, trailing `＋` (pool picker multi → `descRefs` как auto).

**Rerender contract**:
- `charSlot`/`userSlot`/`extraRefIds` mutation → `renderRefsStatus(root)` (full local pass).
- `descRefs` mutation → только `#urisRefsDesc`.
- `draft.references.includedIds/excludedIds` → `resolveDraftPromptReferences` → `renderLivePreview` + cap.
- Prompt autosave → `renderLivePreview` (текущий паттерн).

**Не меняется**: `buildSceneContextSnapshot`, `resolvePromptReferenceContext`, `descRefs`-канал в pipeline, `showPoolPicker`, `getRefSync`, `normalizeSceneEntity`, `applyReferenceCorrection`, `collectRefsForCurrentChat` (legacy, остаётся для tests/обратной совместимости).

---

## File Structure

- `src/refs-library.js` — расширение `defaultChatRefs`/`_normalizeSlot`/`getChatRefs` (aliases, drop mode), новый `resolveUserAvatarPathForCurrent()`.
- `src/pipeline.js` — `buildCandidates(chatId)` переписывается на slot + extras whitelist, использует `getChatRefs()`.
- `src/ui/tab-generate.js` — `renderRefsStatus` без mode-select, `renderSlots` с alias-полем, `renderLivePreview` с `＋`-плиткой и role/source-разметкой, новый `addEffectiveRefsFromPool`.
- `style.css` — `.uris-refs-source-bar`, `.uris-refs-pinned`, `.uris-refs-add-tile`, `.uris-slot-aliases-field`, `.uris-refs-stage2-cap`.
- `tests/refs-library.test.js` — обновить (!) или добавить тесты для aliases/normalize без `mode`.
- `tests/pipeline-buildcandidates.test.js` — новый файл: candidates = slots + extras only, user imagePath non-empty.
- `tests/tab-generate.test.js` (или `tests/smoke.test.js`) — DOM-с Removingmode-select, наличие alias-field и `＋`-плитки.

---

## Task 1: Расширить chatRefs slot на aliases и подготовить чтение без mode

**Files:**
- Modify: `src/refs-library.js:108-170`
- Test: `tests/refs-library.test.js:206-270`

- [ ] **Step 1: Write the failing test in `tests/refs-library.test.js`** (вставить после существующего блока chat-refs тестов, после строки ~270)

```js
test('defaultChatRefs содержит slot aliases пустыми и не имеет mode', () => {
    const d = defaultChatRefs();
    assert.deepEqual(d.charSlot.aliases, []);
    assert.deepEqual(d.userSlot.aliases, []);
    assert.equal(d.mode, undefined);
});

test('getChatRefs нормализует slot.aliases как массив строк', async () => {
    const { saveChatRefs, getChatRefs } = await import('../src/refs-library.js');
    await saveChatRefs({ charSlot: { type: 'auto', aliases: ['Aria', 'Проблеск'] } });
    const r = getChatRefs();
    assert.deepEqual(r.charSlot.aliases, ['Aria', 'Проблеск']);
    assert.equal(r.charSlot.type, 'auto');
});

test('getChatRefs читает legacy-запись без mode (возвращает undefined)', async () => {
    const { saveChatRefs, getChatRefs } = await import('../src/refs-library.js');
    // Эмулируем старую запись, где mode отсутствовал
    const ctx = globalThis.SillyTavern.getContext();
    ctx.chatMetadata.uris_binding = { refs: { charSlot: { type: 'auto' }, userSlot: { type: 'auto' }, extraRefIds: [], descRefs: [] } };
    const r = getChatRefs();
    assert.equal(r.mode, undefined);
    assert.deepEqual(r.charSlot.aliases, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/refs-library.test.js`
Expected: FAIL — текущий `defaultChatRefs` возвращает `mode:'smart'`, `_normalizeSlot` не добавляет aliases.

- [ ] **Step 3: Modify `src/refs-library.js` — `defaultChatRefs`**

Найти строки ~118-126 (текущая функция) и заменить:
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
на:
```js
export function defaultChatRefs() {
    return {
        charSlot: { type: 'auto', aliases: [] },
        userSlot: { type: 'auto', aliases: [] },
        extraRefIds: [],
        descRefs: [],
    };
}
```

- [ ] **Step 4: Modify `_normalizeSlot` (строки ~156-159)**

Заменить:
```js
function _normalizeSlot(s) {
    if (s && s.type === 'pinned' && s.refId) return { type: 'pinned', refId: String(s.refId) };
    return { type: 'auto' };
}
```
на:
```js
function _normalizeSlot(s) {
    const aliases = normalizeAliases(s?.aliases);
    if (s && s.type === 'pinned' && s.refId) {
        return { type: 'pinned', refId: String(s.refId), aliases };
    }
    return { type: 'auto', aliases };
}
```

(Импорт `normalizeAliases` уже есть в `refs-library.js:12` — проверить строкой `grep -n "normalizeAliases" src/refs-library.js`.)

- [ ] **Step 5: Modify `getChatRefs` — удалить валидацию `mode` (строки ~129-140)**

Заменить:
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
на:
```js
export function getChatRefs() {
    const binding = _rawBinding();
    if (!binding?.refs || typeof binding.refs !== 'object') return defaultChatRefs();
    const r = binding.refs;
    // mode убран из модели; legacy-значения остаточно игнорируются в прод-пути.
    return {
        charSlot: _normalizeSlot(r.charSlot),
        userSlot: _normalizeSlot(r.userSlot),
        extraRefIds: Array.isArray(r.extraRefIds) ? r.extraRefIds.map(String) : [],
        descRefs: _normalizeDescRefs(r.descRefs),
    };
}
```

- [ ] **Step 6: Run tests**

Run: `node --test tests/refs-library.test.js`
Expected: новые 3 теста PASS, но существующие тесты c `mode` (стр. 210, 219, 238, 273, 340, 368, 394, 401, 459, 474, 486, 502) **могут** упасть — это ожидаемо и фиксится в Task 1.5.

- [ ] **Step 1.5 (встроенный): Update legacy assertions on `mode`**

Для каждой упавшей строки компилируем update. Заменить фикстуру в строках 206-213:
```js
test('defaultChatRefs fields after migration (no mode, slot aliases present)', () => {
    const d = defaultChatRefs();
    assert.deepEqual(d, {
        charSlot: { type: 'auto', aliases: [] },
        userSlot: { type: 'auto', aliases: [] },
        extraRefIds: [],
        descRefs: [],
    });
});
```

В строках 218-222 (`saveChatRefs persists merge-patch`) заменить assertion `mode` на безусловное отсутствие:完结ь `mode` в `assert.deepEqual(...)` либо удалить это поле из сравнения. Конкретно:
```js
test('saveChatRefs persists merge-patch to chatMetadata (без mode)', async () => {
    await saveChatRefs({ extraRefIds: ['x'] });
    const r = getChatRefs();
    assert.deepEqual(r.extraRefIds, ['x']);
    assert.equal(r.mode, undefined);
});
```

Для строк 238-241 (`getChatRefs normalizes invalid mode to smart`) — удалить тест полностью (поведение `mode` упразднено). Для строк ~340 (`mode:'never'` → 0 refs в `collectRefsForCurrentChat`): legacy-путь сохраняет `mode` internaly, для него оставляем тесты без изменения. Проверить: `collectRefsForCurrentChat` в `_resolveRefs` (refs-library.js:230) использует `chatRefs.mode || 'smart'` — при отсутствии `mode` удачно дефолтится на `'smart'`, поэтому legacy-тесты на `collectRefsForCurrentChat` с явным `saveChatRefs({ mode: 'always' })` остаются рабочими (перекрытие идёт через `saveChatRefs`, который merge-patch — `mode` всё ещё может быть записан на уровне chatMetadata). После шага 5 `getChatRefs` не возвращает `mode`, но `collectRefsForCurrentChat`/`_resolveRefs` читают `chatRefs.mode` — станет `undefined`, что fallback в `'smart'` (см. refs-library.js:233). Проверить упавшие тесты и при необходимости в `_resolveRefs` изменить `let mode = chatRefs.mode || 'smart';` на `let mode = chatRefs.mode === 'never' ? 'never' : (chatRefs.mode === 'always' ? 'always' : 'smart');` (НЕ обязательно, если старые тесты не падают — оставить). Перед записью — запустить тесты и поправить упавшие конкретно.

- [ ] **Step 7: Run full test suite**

Run: `node --test tests/refs-library.test.js tests/pipeline-scene-first.test.js`
Expected: PASS. Если упадёт `pipeline-scene-first.test.js` на assertion с `mode` — корректировать так же (legacy-путь сохраняет `mode`).

- [ ] **Step 8: Node --check syntax**

Run: `node --check src/refs-library.js`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add src/refs-library.js tests/refs-library.test.js
git commit -m "feat(refs): drop chatRefs.mode, add slot.aliases field

mode field removed from defaultChatRefs/getChatRefs; legacy values silently
ignored. charSlot/userSlot now carry optional string[] aliases used by
buildCandidates for prompt mention matching."
```

---

## Task 2: Добавить `resolveUserAvatarPathForCurrent()` helper

**Files:**
- Modify: `src/refs-library.js` (новый экспорт рядом с `getUserAvatarDataUrlForCurrent`, строки ~307-314)
- Test: `tests/refs-library.test.js`

- [ ] **Step 1: Write the failing test**

Добавить в `tests/refs-library.test.js` (после блока об аватаре ~строка 502 или в Nähe `_resolveCurrentUserAvatarId` тестов — найти `grep -n "resolveCurrentUserAvatarId\|getUserAvatarDataUrlForCurrent" tests/refs-library.test.js`):

```js
test('resolveUserAvatarPathForCurrent возвращает путь к аватару persona', async () => {
    const { resolveUserAvatarPathForCurrent } = await import('../src/refs-library.js');
    // Глобальный stub в beforeEach уже даёт name1: 'User', personas через powerUserSettings не заданы.
    // Эмулируем persona lock в chatMetadata.
    const ctx = globalThis.SillyTavern.getContext();
    ctx.chatMetadata.persona = 'persona-42';
    ctx.powerUserSettings = { personas: { 'persona-42': 'User' } };
    const path = await resolveUserAvatarPathForCurrent();
    assert.equal(path, '/User Avatars/persona-42');
});

test('resolveUserAvatarPathForCurrent возвращает null если persona не найдена', async () => {
    const { resolveUserAvatarPathForCurrent } = await import('../src/refs-library.js');
    const ctx = globalThis.SillyTavern.getContext();
    ctx.chatMetadata.persona = undefined;
    ctx.powerUserSettings = {};
    const path = await resolveUserAvatarPathForCurrent();
    assert.equal(path, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/refs-library.test.js`
Expected: FAIL — `resolveUserAvatarPathForCurrent` not exported.

- [ ] **Step 3: Add the helper in `src/refs-library.js`** (после `getUserAvatarDataUrlForCurrent`, ~строка 314)

```js
/**
 * Возвращает путь изображения аватара текущего user (для imagePath в SceneEntity),
 * а не data URL. Возвращает null, если persona не найдена — в этом случае
 * buildCandidates оставляет user.imagePath пустым, и user не попадает в Stage 2
 * refs как изображение.
 *
 * @returns {Promise<string|null>}
 */
export async function resolveUserAvatarPathForCurrent() {
    const avatarId = _resolveCurrentUserAvatarId();
    if (!avatarId) return null;
    return `/User Avatars/${encodeURIComponent(avatarId)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/refs-library.test.js`
Expected: PASS для новых тестов.

- [ ] **Step 5: Commit**

```bash
git add src/refs-library.js tests/refs-library.test.js
git commit -m "feat(refs): add resolveUserAvatarPathForCurrent helper

Returns /User Avatars/<id> path (or null when persona unknown) for use as
SceneEntity.imagePath in buildCandidates, so {{user}} can materialize as
Stage 2 image like char already does."
```

---

## Task 3: Переписать `buildCandidates` (slot-based + extras whitelist)

**Files:**
- Modify: `src/pipeline.js:188-225` (`buildCandidates`)
- Test: `tests/pipeline-buildcandidates.test.js` (create)

- [ ] **Step 1: Create failing test file `tests/pipeline-buildcandidates.test.js`**

```js
// @ts-check
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const memoryStore = new Map();

beforeEach(() => {
    memoryStore.clear();
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            saveMetadata: () => {},
            getRequestHeaders: () => ({}),
            chat: {},
            chatId: 'test-chat',
            name1: 'Alex',
            name2: 'Aria Brightblade',
            characters: [{ name: 'Aria Brightblade', description: 'elf', avatar: 'aria.png' }],
            characterId: 0,
            chatMetadata: {},
            powerUserSettings: { personas: { 'persona-7': 'Alex' }, default_persona: 'persona-7' },
        }),
        libs: {
            localforage: {
                getItem: (k) => memoryStore.has(k) ? memoryStore.get(k) : null,
                setItem: (k, v) => { memoryStore.set(k, v); },
                removeItem: (k) => { memoryStore.delete(k); },
            },
        },
    };
});

test('buildCandidates: char с ST avatar + user с user avatar path', async () => {
    const { buildCandidates } = await import('../src/pipeline.js');
    const candidates = await buildCandidates('test-chat');
    const char = candidates.find(c => c.id === 'char');
    const user = candidates.find(c => c.id === 'user');
    assert.equal(char.name, 'Aria Brightblade');
    assert.equal(char.imagePath, '/characters/aria.png');
    assert.equal(char.role, 'char');
    assert.equal(user.name, 'Alex');
    assert.equal(user.imagePath, '/User%20Avatars/persona-7');
    assert.equal(user.role, 'user');
});

test('buildCandidates: aliases из chatRefs.charSlot попадают в candidate', async () => {
    const { saveChatRefs } = await import('../src/refs-library.js');
    const { buildCandidates } = await import('../src/pipeline.js');
    await saveChatRefs({ charSlot: { type: 'auto', aliases: ['Aria', 'Проблеск'] } });
    const candidates = await buildCandidates('test-chat');
    const char = candidates.find(c => c.id === 'char');
    assert.deepEqual(char.aliases, ['Aria', 'Проблеск']);
});

test('buildCandidates: NPC только из extraRefIds, не весь пул', async () => {
    const { createRef, saveChatRefs } = await import('../src/refs-library.js');
    const { buildCandidates } = await import('../src/pipeline.js');
    const refA = await createRef({ name: 'Bob', keywords: ['bob'], imagePath: '/x/bob.png', folderId: null });
    const refB = await createRef({ name: 'Carol', keywords: ['carol'], imagePath: '/x/carol.png', folderId: null });
    await saveChatRefs({ extraRefIds: [refA.id] });      // только Bob
    const candidates = await buildCandidates('test-chat');
    const npcNames = candidates.filter(c => c.role === 'npc').map(c => c.name);
    assert.deepEqual(npcNames, ['Bob']);                // Carol не кандидат
});

test('buildCandidates: pinned slot char использует ref imagePath и name', async () => {
    const { createRef, saveChatRefs } = await import('../src/refs-library.js');
    const { buildCandidates } = await import('../src/pipeline.js');
    const ref = await createRef({ name: 'AriaAlt', keywords: ['aria'], imagePath: '/x/aria-alt.png', folderId: null });
    await saveChatRefs({ charSlot: { type: 'pinned', refId: ref.id, aliases: ['Aria'] } });
    const candidates = await buildCandidates('test-chat');
    const char = candidates.find(c => c.id === 'char');
    assert.equal(char.name, 'AriaAlt');
    assert.equal(char.imagePath, '/x/aria-alt.png');
    assert.deepEqual(char.aliases, ['Aria']);
});

test('buildCandidates: pinned slot user использует ref imagePath', async () => {
    const { createRef, saveChatRefs } = await import('../src/refs-library.js');
    const { buildCandidates } = await import('../src/pipeline.js');
    const ref = await createRef({ name: 'AlexAlt', keywords: ['alex'], imagePath: '/x/alex-alt.png', folderId: null });
    await saveChatRefs({ userSlot: { type: 'pinned', refId: ref.id, aliases: [] } });
    const candidates = await buildCandidates('test-chat');
    const user = candidates.find(c => c.id === 'user');
    assert.equal(user.name, 'AlexAlt');
    assert.equal(user.imagePath, '/x/alex-alt.png');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pipeline-buildcandidates.test.js`
Expected: FAIL — current `buildCandidates` returns NPCs from entire pool, user.imagePath is `''`, no aliases.

- [ ] **Step 3: Rewrite `buildCandidates` in `src/pipeline.js:188-225`**

Найти существующее тело:
```js
export async function buildCandidates(chatId) {
    const ctx = getCtx();
    const candidates = [];

    const charName = ctx.name2 || ctx.characters?.[ctx.characterId]?.name || '';
    const charDesc = ctx.characters?.[ctx.characterId]?.description || '';
    const charAvatar = ctx.characters?.[ctx.characterId]?.avatar
        ? `/characters/${encodeURIComponent(ctx.characters[ctx.characterId].avatar)}`
        : '';
    candidates.push(normalizeSceneEntity({
        id: 'char', name: charName, aliases: [],
        description: charDesc, imagePath: charAvatar,
    }, 'char'));

    const userName = ctx.name1 || '';
    candidates.push(normalizeSceneEntity({
        id: 'user', name: userName, aliases: [],
        description: '', imagePath: '',
    }, 'user'));

    const refs = await listRefs();
    for (const ref of refs) {
        candidates.push(normalizeSceneEntity(ref, 'npc'));
    }

    return candidates;
}
```
Заменить на:
```js
export async function buildCandidates(chatId) {
    const ctx = getCtx();
    const chatRefs = getChatRefs();
    const candidates = [];

    // ── char slot ──
    const charSlot = chatRefs.charSlot;
    const stCharName = ctx.name2 || ctx.characters?.[ctx.characterId]?.name || '';
    const stCharDesc = ctx.characters?.[ctx.characterId]?.description || '';
    const stCharAvatar = ctx.characters?.[ctx.characterId]?.avatar
        ? `/characters/${encodeURIComponent(ctx.characters[ctx.characterId].avatar)}`
        : '';
    if (charSlot.type === 'pinned') {
        const ref = getRefSync(charSlot.refId);
        candidates.push(normalizeSceneEntity({
            id: 'char',
            name: ref?.name || stCharName,
            aliases: charSlot.aliases || [],
            description: ref?.description || stCharDesc,
            imagePath: ref?.imagePath || stCharAvatar,
        }, 'char'));
    } else {
        candidates.push(normalizeSceneEntity({
            id: 'char',
            name: stCharName,
            aliases: charSlot.aliases || [],
            description: stCharDesc,
            imagePath: stCharAvatar,
        }, 'char'));
    }

    // ── user slot ──
    const userSlot = chatRefs.userSlot;
    const stUserName = ctx.name1 || '';
    if (userSlot.type === 'pinned') {
        const ref = getRefSync(userSlot.refId);
        candidates.push(normalizeSceneEntity({
            id: 'user',
            name: ref?.name || stUserName,
            aliases: userSlot.aliases || [],
            description: '',
            imagePath: ref?.imagePath || '',
        }, 'user'));
    } else {
        const userAvatarPath = await resolveUserAvatarPathForCurrent();
        candidates.push(normalizeSceneEntity({
            id: 'user',
            name: stUserName,
            aliases: userSlot.aliases || [],
            description: '',
            imagePath: userAvatarPath || '',
        }, 'user'));
    }

    // ── NPC whitelist (extraRefIds only) ──
    for (const refId of chatRefs.extraRefIds) {
        const ref = getRefSync(refId);
        if (ref) {
            candidates.push(normalizeSceneEntity(ref, 'npc'));
        }
    }

    return candidates;
}
```

- [ ] **Step 4: Update imports в `src/pipeline.js:17`**

Найти:
```js
import { collectRefsForCurrentChat, collectDescRefsForCurrentChat, listRefs } from './refs-library.js';
```
Заменить на:
```js
import { collectRefsForCurrentChat, collectDescRefsForCurrentChat, listRefs, getChatRefs, getRefSync, resolveUserAvatarPathForCurrent } from './refs-library.js';
```

(Verify `getRefSync`, `getChatRefs` уже экспортируются из `refs-library.js` через `grep -n "export function getRefSync\|export function getChatRefs\|export async function resolveUserAvatarPathForCurrent" src/refs-library.js`.)

- [ ] **Step 5: Check for unused `listRefs` import**

Run: `grep -n "listRefs" src/pipeline.js`
Если `listRefs` больше не используется — убрать его из import во избежание line. Заменить импортную строку так:
```js
import { collectRefsForCurrentChat, collectDescRefsForCurrentChat, getChatRefs, getRefSync, resolveUserAvatarPathForCurrent } from './refs-library.js';
```

- [ ] **Step 6: Run tests**

Run: `node --test tests/pipeline-buildcandidates.test.js`
Expected: PASS для всех 5 тестов.

- [ ] **Step 7: Run regression suite**

Run: `node --test tests/pipeline-scene-first.test.js tests/scene-context.test.js tests/refs-library.test.js`
Expected: PASS. Если `pipeline-scene-first.test.js` ожидает весь пул NPC как candidates — найти тест (`grep -n "buildCandidates" tests/pipeline-scene-first.test.js`) и обновить fixture: добавить `saveChatRefs({ extraRefIds: [<все ref ids теста>] })` в before-each/setup.

- [ ] **Step 8: Node --check**

Run: `node --check src/pipeline.js`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add src/pipeline.js tests/pipeline-buildcandidates.test.js tests/pipeline-scene-first.test.js
git commit -m "feat(pipeline): buildCandidates from slots + extras whitelist

char/user slots now drive aliases + imagePath (ST avatar or pinned ref;
{{user}} avatar path resolved via resolveUserAvatarPathForCurrent). NPC
candidates limited to chatRefs.extraRefIds instead of whole reference pool."
```

---

## Task 4: Убрать `mode` селектор из UI и врендерить cap в строку «→ Stage 2»

**Files:**
- Modify: `src/ui/tab-generate.js:640-669` (`renderRefsStatus`), и связанный `renderCap` (найти `grep -n "renderCap" src/ui/tab-generate.js`)
- Test: `tests/tab-generate.test.js`

- [ ] **Step 1: Inspect existing renderRefsStatus + renderCap**

Run: `grep -n "renderCap\|renderLivePreview\|renderSlots\|renderExtrasChips\|renderDescRefsChips" src/ui/tab-generate.js`
Expected: locate `renderCap` around line 859; its current implementation sets text into `#urisRefsCap`.

- [ ] **Step 2: Write failing DOM test in `tests/tab-generate.test.js`** (найти подходящий конец файла; проверить паттерн через `grep -n "renderRefsStatus\|urisRefsPanel" tests/tab-generate.test.js` — если тестируется DOM, использовать тот-же mock. Если `tab-generate.test.js` ещё не тестирует renderRefsStatus — добавить в `tests/smoke.test.js`)

```js
test('renderRefsStatus: mode-select отсутствует, есть Stage 2 cap-индикатор', async () => {
    const { renderRefsStatus } = await import('../src/ui/tab-generate.js');
    const root = document.createElement('div');
    root.innerHTML = `<div class="uris-refs-panel" id="urisRefsPanel">
        <div class="uris-refs-panel-head"><span id="urisRefsModeBadge"></span></div>
        <div class="uris-refs-panel-preview" id="urisRefsPreview"></div>
        <div class="uris-refs-panel-cap" id="urisRefsCap"></div>
        <div class="uris-refs-panel-slots" id="urisRefsSlots"></div>
        <div class="uris-refs-panel-extras" id="urisRefsExtras"></div>
        <div class="uris-refs-panel-desc" id="urisRefsDesc"></div>
    </div>`;
    document.body.appendChild(root);
    const resolution = { stage2Refs: [{ id: 'char', role: 'char', name: 'Aria', imagePath: '/c.png' }] };
    await renderRefsStatus(root, resolution);
    assert.equal(root.querySelector('.uris-refs-mode-select'), null, 'mode-select должен быть удалён');
    const cap = root.querySelector('#urisRefsCap');
    assert.ok(cap, '#urisRefsCap host остаётся');
    assert.match(cap.textContent, /1\/\d+/, 'cap показывает N/M');
    document.body.removeChild(root);
});
```

(Если `jsdom` недоступен в проекте — проверить через `grep -n "jsdom\|document" tests/tab-generate.test.js`. Если используется plain mock, адаптировать создание root по существующему паттерну. Если `tab-generate.test.js` использует `globalThis.document` через shim — переиспользовать.)

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/tab-generate.test.js` (или `node --test tests/smoke.test.js` если добавили туда)
Expected: FAIL — текущий `renderRefsStatus` рендерит `<select class="uris-refs-mode-select">`.

- [ ] **Step 4: Modify `renderRefsStatus` в `src/ui/tab-generate.js:640-669`**

Заменить существующее тело:
```js
async function renderRefsStatus(root, referenceResolution = null) {
    if (!root.querySelector('#urisRefsPanel')) return;
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
            renderRefsStatus(root, referenceResolution);
        });
    }

    // Live preview "will be sent" — driven by the current prompt, not the historical Stage 1 snapshot.
    await renderLivePreview(root, referenceResolution);

    // Cap warning based on the effective prompt-driven set.
    await renderCap(root, referenceResolution);

    // Legacy chat-scoped slots/extras/descRefs remain available for compatibility,
    // but they no longer drive the prompt-first effective set.
    await renderSlots(root, chatRefs);
    renderExtrasChips(root, chatRefs);
    renderDescRefsChips(root, chatRefs);
}
```
на:
```js
async function renderRefsStatus(root, referenceResolution = null) {
    if (!root.querySelector('#urisRefsPanel')) return;
    const chatRefs = getChatRefs();

    // Mode badge удалён. Cap-индикатор переезжает в строку «→ Stage 2»
    // (рендерится внутри renderLivePreview в виде .uris-refs-stage2-cap).
    const badge = root.querySelector('#urisRefsModeBadge');
    if (badge) badge.innerHTML = '';

    // Live preview "will be sent" — driven by the current prompt, not the historical Stage 1 snapshot.
    await renderLivePreview(root, referenceResolution);

    // Cap warning оставляет отдельный #urisRefsCap как fallback/legacy host.
    await renderCap(root, referenceResolution);

    // Sources — slots (с aliases, см. Task 5), NPC whitelist, Stage 1 описания.
    await renderSlots(root, chatRefs);
    renderExtrasChips(root, chatRefs);
    renderDescRefsChips(root, chatRefs);
}
```

- [ ] **Step 5: Run test**

Run: `node --test tests/tab-generate.test.js`
Expected: PASS — `.uris-refs-mode-select` отсутствует, `#urisRefsCap` содержит `N/M`.

- [ ] **Step 6: Commit**

```bash
git add src/ui/tab-generate.js tests/tab-generate.test.js
git commit -m "feat(ui): remove mode-select from refs panel

Stage 2 send mode (never/smart/always) removed from UI; behavior is now
always prompt-driven auto-detect + persistent per-message corrections.
#urisRefsModeBadge emptied; #urisRefsCap still hosts N/M cap indicator."
```

---

## Task 5: Alias-поле в slot row

**Files:**
- Modify: `src/ui/tab-generate.js:677-753` (`renderSlots`, `loadSlotPreview`)
- Test: `tests/tab-generate.test.js`

- [ ] **Step 1: Write failing test**

Добавить в `tests/tab-generate.test.js`:
```js
test('renderSlots: alias field присутствует и пишется в chatRefs.charSlot.aliases', async () => {
    const { renderRefsStatus } = await import('../src/ui/tab-generate.js');
    const { saveChatRefs, getChatRefs } = await import('../src/refs-library.js');
    const root = document.createElement('div');
    root.innerHTML = `<div class="uris-refs-panel" id="urisRefsPanel">
        <div class="uris-refs-panel-head"></div>
        <div class="uris-refs-panel-preview" id="urisRefsPreview"></div>
        <div class="uris-refs-panel-cap" id="urisRefsCap"></div>
        <div class="uris-refs-panel-slots" id="urisRefsSlots"></div>
        <div class="uris-refs-panel-extras" id="urisRefsExtras"></div>
        <div class="uris-refs-panel-desc" id="urisRefsDesc"></div>
    </div>`;
    document.body.appendChild(root);
    await saveChatRefs({ charSlot: { type: 'auto', aliases: ['Aria', 'Проблеск'] } });
    await renderRefsStatus(root, null);
    const aliasField = root.querySelector('[data-slot-aliases="char"]');
    assert.ok(aliasField, 'alias field для char должен рендериться');
    assert.equal(aliasField.value, 'Aria, Проблеск');
    // Изменение сохраняется
    aliasField.value = 'Aria, Блэйд';
    aliasField.dispatchEvent(new Event('change'));
    assert.deepEqual(getChatRefs().charSlot.aliases, ['Aria', 'Блэйд']);
    document.body.removeChild(root);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tab-generate.test.js`
Expected: FAIL — `data-slot-aliases` not in DOM.

- [ ] **Step 3: Modify `renderSlots` в `src/ui/tab-generate.js`**

Найти `renderSlots` (строки ~677-720). Заменить тело `slotRow`:
```js
    const slotRow = (slot, label, slotState) => {
        const isPinned = slotState.type === 'pinned';
        const refName = isPinned ? (getRefSync(slotState.refId)?.name || '?') : '';
        const previewId = `uris${slot}Preview`;
        const aliasesStr = Array.isArray(slotState.aliases) ? slotState.aliases.join(', ') : '';
        return `<div class="uris-slot-row">
            <span class="uris-slot-label">${label}</span>
            <select class="text_pole uris-slot-select" data-slot="${slot}">
                <option value="auto" ${!isPinned ? 'selected' : ''}>Auto (из ST)</option>
                <option value="pinned" ${isPinned ? 'selected' : ''}>${isPinned ? escapeHtml(refName) : 'Из пула'}</option>
            </select>
            <span class="uris-slot-preview" id="${previewId}"></span>
            <button class="menu_button uris-slot-pick" data-slot="${slot}" title="Выбрать из пула"><i class="fa-solid fa-images"></i></button>
            <input type="text" class="text_pole uris-slot-aliases-field" data-slot-aliases="${slot}"
                   placeholder="Алиасы (через запятую)" value="${escapeHtml(aliasesStr)}" title="Дополнительные имена для распознавания в prompt">
        </div>`;
    };
```

В обработчиках внутри `renderSlots` после `host.querySelectorAll('.uris-slot-pick')...` (строка ~718) добавить alias change-handling:
```js
    host.querySelectorAll('.uris-slot-aliases-field').forEach(input => {
        input.addEventListener('change', (e) => {
            const slot = e.target.dataset.slotAliases;
            const aliases = String(e.target.value || '')
                .split(/[,\n]/)
                .map(s => s.trim())
                .filter(Boolean);
            const key = slot === 'char' ? 'charSlot' : 'userSlot';
            const current = getChatRefs()[key];
            saveChatRefs({ [key]: { ...current, aliases } });
            renderRefsStatus(root);
        });
    });
```

(Проверить импорт `saveChatRefs` / `getChatRefs` сверху файла через `grep -n "saveChatRefs\|getChatRefs" src/ui/tab-generate.js` — должен существовать.)

- [ ] **Step 4: Run tests**

Run: `node --test tests/tab-generate.test.js`
Expected: PASS.

- [ ] **Step 5: Add CSS for alias field in `style.css`** (рядом с `.uris-slot-row`, ~строка 556)

```css
.uris-slot-aliases-field {
    flex: 2 1 120px;
    min-width: 0;
    font-size: 12px;
}
```

- [ ] **Step 6: Commit**

```bash
git add src/ui/tab-generate.js style.css tests/tab-generate.test.js
git commit -m "feat(ui): alias field for {{char}}/{{user}} slot

Slot row in #urisRefsSlots now exposes text input for comma-separated
aliases; persisted to chatRefs.charSlot/userSlot.aliases and consumed by
buildCandidates for prompt mention matching."
```

---

## Task 6: Effective strip — trailing `＋`-плитка и единые role/source-чипы

**Files:**
- Modify: `src/ui/tab-generate.js` — `renderLivePreview` (строки ~846-851), `renderReferencePreviewMarkup` (найти `grep -n "renderReferencePreviewMarkup" src/ui/tab-generate.js`), добавление `addStage2Includes`.
- Test: `tests/tab-generate.test.js`

- [ ] **Step 1: Inspect current `renderReferencePreviewMarkup` and click delegation**

Run: `grep -n "renderReferencePreviewMarkup\|uris-effective-ref-remove\|uris-effective-ref-add" src/ui/tab-generate.js`
Ожидается: `renderReferencePreviewMarkup` ~создаёт чипы с `.uris-ref-chip-preview`, click-delegation для remove — `tab-generate.js:448`.

- [ ] **Step 2: Write failing test**

```js
test('renderLivePreview: trailing ＋-плитка присутствует и показывает Stage 2 cap', async () => {
    const { renderRefsStatus } = await import('../src/ui/tab-generate.js');
    const root = document.createElement('div');
    root.innerHTML = `<div class="uris-refs-panel" id="urisRefsPanel">
        <div class="uris-refs-panel-head"></div>
        <div class="uris-refs-panel-preview" id="urisRefsPreview"></div>
        <div class="uris-refs-panel-cap" id="urisRefsCap"></div>
        <div class="uris-refs-panel-slots" id="urisRefsSlots"></div>
        <div class="uris-refs-panel-extras" id="urisRefsExtras"></div>
        <div class="uris-refs-panel-desc" id="urisRefsDesc"></div>
    </div>`;
    document.body.appendChild(root);
    const resolution = { stage2Refs: [
        { id: 'char', role: 'char', name: 'Aria', imagePath: '/c.png' },
        { id: 'user', role: 'user', name: 'Alex', imagePath: '/u.png' },
    ] };
    await renderRefsStatus(root, resolution);
    const addTile = root.querySelector('.uris-refs-add-tile');
    assert.ok(addTile, 'trailing ＋-плитка должна быть в ленте Stage 2');
    const chip = root.querySelector('.uris-ref-chip-preview');
    assert.ok(chip, 'хотя бы один чип рендерится');
    assert.match(chip.dataset.role || '', /^(char|user|npc)$/, 'chip имеет data-role');
    document.body.removeChild(root);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/tab-generate.test.js`
Expected: FAIL — нет `.uris-refs-add-tile`.

- [ ] **Step 4: Modify `renderLivePreview` в `src/ui/tab-generate.js`** (строки ~846-851)

Заменить:
```js
export async function renderLivePreview(root, referenceResolution) {
    const host = root.querySelector('#urisRefsPreview');
    if (!host) return;
    const refs = referenceResolution?.stage2Refs || [];
    host.innerHTML = renderReferencePreviewMarkup(refs);
}
```
на:
```js
export async function renderLivePreview(root, referenceResolution) {
    const host = root.querySelector('#urisRefsPreview');
    if (!host) return;
    const refs = referenceResolution?.stage2Refs || [];
    const effectiveIds = new Set(refs.map(r => r.id));
    const cap = root.querySelector('#urisRefsCap');
    const capValue = cap?.textContent.match(/(\d+)\/(\d+)/);
    const cur = capValue ? Number(capValue[1]) : refs.length;
    const max = capValue ? Number(capValue[2]) : 10;
    const capLabel = `<div class="uris-refs-stage2-cap">→ Stage 2  ·  ${cur}/${max}</div>`;
    const chips = renderReferencePreviewMarkup(refs);
    const addTile = `<button class="uris-refs-add-tile" title="Добавить референс в Stage 2"><i class="fa-solid fa-plus"></i></button>`;
    const empty = refs.length === 0
        ? `<small class="uris-refs-empty">prompt никого не упомянул — нажмите ＋</small>`
        : '';
    host.innerHTML = `${capLabel}<div class="uris-refs-strip">${chips}${addTile}</div>${empty}`;

    host.querySelector('.uris-refs-add-tile')?.addEventListener('click', async () => {
        const chosen = await showPoolPicker({ title: 'Референсы → Stage 2', multi: true, excludeIds: Array.from(effectiveIds) });
        if (!chosen?.length) return;
        await addStage2Includes(root, chosen);
    });
}
```

- [ ] **Step 5: Modify `renderReferencePreviewMarkup`** — добавить role + source badge

Найти функцию. Заменить тело, чтобы чип получал `data-role`:
```js
function renderReferencePreviewMarkup(refs) {
    return refs.map(r => {
        const role = r.role || '';
        const pin = ''; // populated by caller via includedIds; here не доступно без resolution
        return `<span class="uris-ref-chip-preview uris-role-${role}" data-ref-id="${escapeHtml(r.id)}" data-role="${escapeHtml(role)}" title="${escapeHtml(r.name || '')}">
            <img src="${escapeHtml(r.imagePath || '')}" alt="${escapeHtml(r.name || '')}">
            <span class="uris-refs-source-bar"></span>
            <button class="uris-effective-ref-remove" title="Убрать из Stage 2"><i class="fa-solid fa-xmark"></i></button>
            <span class="uris-ref-role">${escapeHtml(role)}</span>
        </span>`;
    }).join('');
}
```

(Если функция уже рендерит remove-кнопку и клик-делегирование через `.uris-effective-ref-remove` (см. tab-generate.js:448) рабочее — сохранить существующий делегат, не дублировать.)

- [ ] **Step 6: Add `addStage2Includes` helper**

После `applyReferenceCorrection` (или в зоне exports) добавить:
```js
/**
 * Закрепить выбранные IDs в Stage 2 set и при необходимости добавить их в NPC whitelist.
 * Если refId ещё не является кандидатом (т.е. не char/user, и не в extraRefIds),
 * он добавляется в chatRefs.extraRefIds так, чтобы resolver мог его разрешить.
 * @param {HTMLElement} root
 * @param {string[]} refIds
 */
async function addStage2Includes(root, refIds) {
    const chatRefs = getChatRefs();
    const knownIds = new Set(['char', 'user', ...chatRefs.extraRefIds]);
    const newNpcIds = refIds.filter(id => !knownIds.has(id));
    if (newNpcIds.length) {
        saveChatRefs({ extraRefIds: [...chatRefs.extraRefIds, ...newNpcIds] });
    }
    for (const refId of refIds) {
        await applyReferenceCorrection(root, refId, true);
    }
}
```

Импортировать `showPoolPicker` через `grep -n "showPoolPicker" src/ui/tab-generate.js` — убедиться что уже импортирован, иначе добавить в импорт строку pool-picker.

- [ ] **Step 7: Run test**

Run: `node --test tests/tab-generate.test.js`
Expected: PASS.

- [ ] **Step 8: Add CSS for strip / add-tile / source-bar in `style.css`**

После существующего `.uris-ref-chip-preview` (~строка 502):
```css
.uris-refs-stage2-cap {
    font-size: 12px;
    color: var(--SmartThemeBodyColor, #ccc);
    opacity: 0.9;
    margin-bottom: 4px;
}
.uris-refs-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: flex-start;
}
.uris-ref-chip-preview {
    position: relative;
    width: 64px;
    height: 64px;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--SmartThemeBorderColor, #444);
}
.uris-ref-chip-preview img { width: 100%; height: 100%; object-fit: cover; }
.uris-refs-source-bar {
    position: absolute; left: 0; right: 0; bottom: 0;
    height: 4px;
}
.uris-role-char .uris-refs-source-bar { background: #fc6; }
.uris-role-user .uris-refs-source-bar { background: #6cf; }
.uris-role-npc  .uris-refs-source-bar { background: #888; }
.uris-ref-role {
    position: absolute; left: 2px; top: 2px;
    font-size: 9px; padding: 1px 3px;
    background: rgba(0,0,0,.6); color: #eee;
    border-radius: 3px;
}
.uris-effective-ref-remove {
    position: absolute; right: 2px; top: 2px;
    background: rgba(0,0,0,.6); color: #eee;
    border: none; border-radius: 3px; cursor: pointer;
    padding: 1px 4px; font-size: 11px;
}
.uris-refs-add-tile {
    width: 64px; height: 64px;
    border: 2px dashed var(--SmartThemeBorderColor, #666);
    background: transparent; color: var(--SmartThemeBodyColor, #aaa);
    border-radius: 6px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px;
}
.uris-refs-add-tile:hover {
    border-color: var(--SmartThemeQuoteColor, #4a5);
    color: var(--SmartThemeQuoteColor, #4a5);
}
/* Pinned-indicator */
.uris-ref-chip-preview.uris-ref-pinned {
    outline: 2px solid var(--SmartThemeQuoteColor, #4a5);
    outline-offset: -2px;
}
```

- [ ] **Step 9: Mark pinned chips (optional pass — при наличии resolution.includedIds)**

`renderLivePreview` имеет доступ к correction state через `referenceResolution`? Resolution не хранит includedIds в текущей модели (`resolvePromptReferenceContext` возвращает `entities/stage2Refs/ambiguities`). На данном этапе не добавляем pin-метку в выражении effective (она будет производной). Оставляем CSS-класс `.uris-ref-pinned` для будущего — Task не наложен. Решение: пропустить pin-разметку в v2.1; в коде `renderReferencePreviewMarkup` выше поле `pin` нормально — значением может быть `''`. Оставить как есть.

- [ ] **Step 10: Commit**

```bash
git add src/ui/tab-generate.js style.css tests/tab-generate.test.js
git commit -m "feat(ui): effective strip with trailing ＋ tile + role/source badges

#urisRefsPreview now renders Stage 2 cap line, 64×64 chips with role caption
and bottom source color bar (char/user/npc), and trailing dashed ＋ tile
that opens pool picker and includes chosen NPCs as draft.references.includedIds
(+ auto-adds them to chatRefs.extraRefIds as candidates)."
```

---

## Task 7: Sources — collapse behavior и стилизация чипов

ВОМожно большую часть CSS уже есть (`uris-extra-chip`, `uris-refs-panel-row`). Задача — обернуть 3 секции в `<details>` и раскрыть по умолчанию при непустых.

**Files:**
- Modify: `src/ui/tab-generate.js` — `renderRefsStatus` (обернуть секции), или `renderGenerateMarkup` (изменить host разметку), `tab-generate.js:242-254`.
- Test: `tests/tab-generate.test.js`

- [ ] **Step 1: Write failing test**

```js
test('renderRefsStatus: три details-секции; NPC whitelist раскрыт при непустом extraRefIds', async () => {
    const { renderRefsStatus } = await import('../src/ui/tab-generate.js');
    const { saveChatRefs, createRef } = await import('../src/refs-library.js');
    const ref = await createRef({ name: 'Bob', keywords: ['bob'], imagePath: '/x/bob.png', folderId: null });
    await saveChatRefs({ extraRefIds: [ref.id] });
    const root = document.createElement('div');
    root.innerHTML = `<div class="uris-refs-panel" id="urisRefsPanel">
        <div class="uris-refs-panel-head"></div>
        <div class="uris-refs-panel-preview" id="urisRefsPreview"></div>
        <div class="uris-refs-panel-cap" id="urisRefsCap"></div>
        <div class="uris-refs-panel-slots" id="urisRefsSlots"></div>
        <div class="uris-refs-panel-extras" id="urisRefsExtras"></div>
        <div class="uris-refs-panel-desc" id="urisRefsDesc"></div>
    </div>`;
    document.body.appendChild(root);
    await renderRefsStatus(root, null);
    const slotsDetails = root.querySelector('details.uris-refs-sources-details[data-source="slots"]');
    const npcDetails = root.querySelector('details.uris-refs-sources-details[data-source="npc"]');
    const descDetails = root.querySelector('details.uris-refs-sources-details[data-source="desc"]');
    assert.ok(slotsDetails && npcDetails && descDetails, 'все три details-секции присутствуют');
    assert.equal(slotsDetails.hasAttribute('open'), false, 'Слоты свёрнуты по умолчанию');
    assert.equal(npcDetails.hasAttribute('open'), true, 'NPC whitelist раскрыт при непустом extras');
    assert.equal(descDetails.hasAttribute('open'), false, 'DescRefs свёрнуты при пустом');
    document.body.removeChild(root);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tab-generate.test.js`
Expected: FAIL.

- [ ] **Step 3: Modify `renderRefsStatus`** в `src/ui/tab-generate.js` — обернуть sources-хосты в `<details>`-обёртки. После `await renderLivePreview...`:

Заменить строки:
```js
    // Sources — slots (с aliases, см. Task 5), NPC whitelist, Stage 1 описания.
    await renderSlots(root, chatRefs);
    renderExtrasChips(root, chatRefs);
    renderDescRefsChips(root, chatRefs);
```
на:
```js
    // Sources — три сворачиваемые секции (details).
    const slotsOpen = false; // по умолчанию свёрнуты
    const npcOpen = chatRefs.extraRefIds.length > 0;
    const descOpen = chatRefs.descRefs.length > 0;
    root.querySelector('#urisRefsSlots').closest('details.uris-refs-sources-details[data-source="slots"]')?.toggleAttribute('open', slotsOpen);
    root.querySelector('#urisRefsExtras')?.closest('details.uris-refs-sources-details[data-source="npc"]')?.toggleAttribute('open', npcOpen);
    root.querySelector('#urisRefsDesc')?.closest('details.uris-refs-sources-details[data-source="desc"]')?.toggleAttribute('open', descOpen);

    await renderSlots(root, chatRefs);
    renderExtrasChips(root, chatRefs);
    renderDescRefsChips(root, chatRefs);
```

(Предполагается что статичная разметка `#urisRefsPanel` в `renderGenerateMarkup` обернула эти хосты в `<details>` — следующий шаг.)

- [ ] **Step 4: Modify `renderGenerateMarkup` в `src/ui/tab-generate.js:242-254`**

Заменить:
```js
<div class="uris-refs-panel" id="urisRefsPanel">
    <div class="uris-refs-panel-head">
        <span class="uris-refs-status-label">Референсы</span>
        <span id="urisRefsModeBadge"></span>
        <button class="menu_button uris-effective-ref-add" id="urisAddEffectiveRef" title="Добавить референс"><i class="fa-solid fa-plus"></i></button>
        <button class="menu_button uris-refs-edit" id="urisRefsEdit" title="Открыть библиотеку референсов"><i class="fa-solid fa-gear"></i></button>
    </div>
    <div class="uris-refs-panel-preview" id="urisRefsPreview"></div>
    <div class="uris-refs-panel-cap" id="urisRefsCap"></div>
    <div class="uris-refs-panel-slots" id="urisRefsSlots"></div>
    <div class="uris-refs-panel-extras" id="urisRefsExtras"></div>
    <div class="uris-refs-panel-desc" id="urisRefsDesc"></div>
</div>
```
на:
```js
<div class="uris-refs-panel" id="urisRefsPanel">
    <div class="uris-refs-panel-head">
        <span class="uris-refs-status-label">Референсы</span>
        <button class="menu_button uris-refs-edit" id="urisRefsEdit" title="Открыть библиотеку референсов"><i class="fa-solid fa-gear"></i></button>
    </div>
    <div class="uris-refs-panel-preview" id="urisRefsPreview"></div>
    <input type="hidden" id="urisRefsModeBadge">
    <input type="hidden" id="urisRefsCap">
    <details class="uris-refs-sources-details" data-source="slots"><summary>Слоты {char}/{user}</summary><div class="uris-refs-panel-slots" id="urisRefsSlots"></div></details>
    <details class="uris-refs-sources-details" data-source="npc"><summary>NPC whitelist</summary><div class="uris-refs-panel-extras" id="urisRefsExtras"></div></details>
    <details class="uris-refs-sources-details" data-source="desc"><summary>Stage 1 описания</summary><div class="uris-refs-panel-desc" id="urisRefsDesc"></div></details>
</div>
```

(`#urisRefsModeBadge` и `#urisRefsCap` теперь скрытые input — на всякий случай, если другой код их читает; дать grep: `grep -rn "urisRefsModeBadge\|urisRefsCap" src/ tests/`. Если не используются вне `renderRefsStatus` — удалить совсем. Если используются — оставляем hidden host.)

- [ ] **Step 5: Run test**

Run: `node --test tests/tab-generate.test.js`
Expected: PASS.

- [ ] **Step 6: Add CSS**

В `style.css`:
```css
.uris-refs-sources-details {
    margin-top: 8px;
    border-top: 1px solid var(--SmartThemeBorderColor, #333);
    padding-top: 4px;
}
.uris-refs-sources-details > summary {
    cursor: pointer;
    font-size: 12px;
    opacity: 0.9;
    margin-bottom: 4px;
}
.uris-refs-sources-details[open] > summary {
    margin-bottom: 6px;
}
```

- [ ] **Step 7: Run regression**

Run: `node --test tests/tab-generate.test.js tests/smoke.test.js`
Expected: PASS. Если smoke-тест на `#urisRefsExtras`/`#urisRefsCap` проверяетuge структуру — обновить (найти через `grep -n "urisRefs" tests/smoke.test.js`).

- [ ] **Step 8: Commit**

```bash
git add src/ui/tab-generate.js style.css tests/tab-generate.test.js tests/smoke.test.js
git commit -m "feat(ui): collapsible Sources sections in refs panel

Slots / NPC whitelist / Stage 1 descriptions wrapped in <details>; Slots
collapsed by default, NPC whitelist and Descriptions auto-open when
non-empty. Head simplified to label + gear; ＋ tile moved into strip."
```

---

## Task 8: Финальный smoke + ручная проверка

**Files:**
- Modify: `tests/smoke.test.js`

- [ ] **Step 1: Add smoke test asserting unified refs panel layout**

```js
test('smoke: refs panel без mode-select; alias field и ＋ tile присутствуют', async () => {
    const { renderRefsStatus } = await import('../src/ui/tab-generate.js');
    const root = document.createElement('div');
    root.innerHTML = `<div class="uris-refs-panel" id="urisRefsPanel">
        <div class="uris-refs-panel-head"></div>
        <div class="uris-refs-panel-preview" id="urisRefsPreview"></div>
        <input type="hidden" id="urisRefsModeBadge"><input type="hidden" id="urisRefsCap">
        <details class="uris-refs-sources-details" data-source="slots"><div class="uris-refs-panel-slots" id="urisRefsSlots"></div></details>
        <details class="uris-refs-sources-details" data-source="npc"><div class="uris-refs-panel-extras" id="urisRefsExtras"></div></details>
        <details class="uris-refs-sources-details" data-source="desc"><div class="uris-refs-panel-desc" id="urisRefsDesc"></div></details>
    </div>`;
    document.body.appendChild(root);
    await renderRefsStatus(root, { stage2Refs: [] });
    assert.equal(root.querySelector('.uris-refs-mode-select'), null);
    assert.ok(root.querySelector('.uris-refs-add-tile'));
    assert.ok(root.querySelector('[data-slot-aliases="char"]'));
    document.body.removeChild(root);
});
```

- [ ] **Step 2: Run full suite**

Run: `node --test tests/*.test.js`
Expected: PASS (или легаси-упоминания `mode` в `collectRefsForCurrentChat` тестах — они не должны падать, т.к. тестируют legacy-функцию напрямую).

- [ ] **Step 3: Manual check (notes)**

Открыть SillyTavern → UR Image Studio → Generate → проверить:
- Шапка `Референсы` + ⚙; без mode-селектора.
- В Stage 2 ленте при пустом prompt — пунктирная `＋`-плитка и надпись «prompt никого не упомянул».
- Ввести prompt с именем {{char}} — миниатюра char появляется с золотой source-bar и `char`-капшеном.
- `＋`-плитка открывает pool picker, выбор закрепляет NPC → chip появляется с зелёной outline? (Тask 6 Step 9: pin-marking не включено в v2.0 — оставлено v2.1). ОК просто проверить что chip появился.
- `×` на chip удаляет его (excludedIds); при следующем auto-resolve (например, поправить prompt) — не возвращается.
- Слоты {char}/{user} (развернуть): alias-поле сохраняет алиасы; при вводе «A, B» после `change` в `chatRefs.charSlot.aliases` остаётся `['A', 'B']`.
- NPC whitelist: `＋` (внутри секции) открывает pool picker multi; выбранные добавляются в `extraRefIds`; чипы показываются; `×` удаляет.
- Stage 1 описания: то же с `mode` toggle (📌/🔄) и сохранением.

- [ ] **Step 4: Commit final**

```bash
git add tests/smoke.test.js
git commit -m "test: smoke for refs panel redesign v2 layout

Asserts: no mode-select, ＋ tile present, alias field present for char slot.
All other suites green after redesign."
```

---

## Task 9: Update CHANGELOG / spec reminder (optional)

- [ ] **Step 1: Append CHANGELOG entry**

Найти `docs/changelog.md`. Добавить сверху новую секцию:
```md
## 2026-07-17 — Refs panel redesign v2

- **UI**: `#urisRefsPanel` переделан в двухъярусную компоновку: верхняя лента effective refs (→ Stage 2) с `＋`-плиткой и `×` на каждый chip; нижние `<details>`-секции (Слоты / NPC whitelist / Stage 1 описания).
- **Удалён `mode`** (never/smart/always). Поведение всегда: prompt-driven auto-detect + persistent per-message corrections.
- **`buildCandidates`** теперь берёт только char slot, user slot, и NPC whitelist (`extraRefIds`); записи пула вне whitelist больше не являются кандидатами.
- **Алиасы `{{char}}/{{user}}`**: в slot row добавлено текстовое поле, сохраняется в `chatRefs.{char,user}Slot.aliases`.
- **`{{user}}` аватар** теперь подгружается в `imagePath` через новый `resolveUserAvatarPathForCurrent()` — Stage 2 получает user-аватар как изображение.
- Source-бейджи (полоска снизу чипа): char=золото, user=синий, npc=серый.
```

- [ ] **Step 2: Commit**

```bash
git add docs/changelog.md
git commit -m "docs: changelog for refs panel redesign v2"
```

---

## Self-Review

**1. Spec coverage:**
- ✅ Пункт 1 (аватары char/user после распознавания Stage 1 → Stage 2): Task 3 — `buildCandidates` подставляет ST avatar/pinned ref в `imagePath`, и `resolvePromptReferenceContext` (без изменений) их детектит по упоминанию в prompt.
- ✅ Пункт 1.1 (NPC из `#urisRefsExtras` распознаётся по alias, попадает в `#urisRefsPreview`): Task 3 — candidates ограничены `extraRefIds`, `resolvePromptReferenceContext` распознаёт по alias; лента показывает в `#urisRefsPreview`.
- ✅ Пункт 2 (удалён режим «Никогда», ручной выбор через миниатюры): Task 1 убирает `mode`; Task 6 — `×` на чипах (correction), `＋`-плитка + `＋` в NPC whitelist закрепляют refs.
- ✅ Алиасы для двойных/странных имён: Task 1 (data) + Task 5 (UI).
- ✅ Stage 1 описания входят в redesign: Task 7 — обёрнут в `<details>`, та же компактная стилистика (toggle `🔄↔📌` остаётся, не трогается).
- ⚠ Pin-индикатор (зелёная outline + 📌 уголок для `includedIds`) оставлен как CSS-класс `.uris-ref-pinned`, но фактическая разметка в `renderReferencePreviewMarkup` в v2.0 не используется (resolution не содержит includedIds в текущей модели). Если нужно — фолловап-task v2.1 добавить чтение `draft.references.includedIds` в `renderLivePreview` и класс. Решение принято в Task 6 Step 9: оставить pin-разметку в будущем итерации. Здесь честно отмечено.

**2. Placeholder scan:** нет TODO/TBD. Каждый шаг с кодом.

**3. Type consistency:** signatures сверены:
- `saveChatRefs(patch)` мердж-патч ✓
- `getChatRefs()` без `mode` ✓
- `resolveUserAvatarPathForCurrent() returns Promise<string|null>` ✓
- `addStage2Includes(root, refIds)` определён в Task 6 ✓
- `_resolveCurrentUserAvatarId` (internal) уже есть ✓
- `showPoolPicker({title, multi, excludeIds})` matches existing usage ✓
- `applyReferenceCorrection(root, candidateId, include)` existing ✓
- `data-slot-aliases` attribute в тестах consistent ✓
- `details.uris-refs-sources-details[data-source="slots|npc|desc"]` consistent ✓

Если находишь баг/несоответствие при выполнении — фикс инлайн с явным комментарием "fixplan: <что>" в коммите.

---

## End-of-plan note

После завершения Task 9 — собрать полный прогон `node --test tests/*.test.js`, затем `git log --oneline -10` убедиться, что коммиты в порядке. Ручную визуальную доводку (color tweaks, exact wording) делать после preliminary smoke.