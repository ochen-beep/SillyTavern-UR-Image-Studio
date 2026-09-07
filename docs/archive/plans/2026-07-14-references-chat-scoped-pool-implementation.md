# Референсы: глобальный пул + привязка по чату — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить глобальные профили референсов на модель «глобальный пул + привязка по чату», чтобы рефы не «протекали» между чатами разных персонажей.

**Architecture:** Три хранилища: пул референсов (`uris_refs_pool`), папки (`uris_refs_folders`), и привязка чата (`chatMetadata.uris_binding.refs`). Старые профили стираются. См. спеку `docs/plans/2026-07-14-references-chat-scoped-pool.md` для полного дизайна и готового кода — этот план разбивает её на задачи.

**Tech Stack:** Vanilla JS (ESM), localforage (через ST), node:test для unit-тестов, SillyTavern extension API.

**Справочник по коду:** Подробный код всех модулей уже написан в спеке `docs/plans/2026-07-14-references-chat-scoped-pool.md` (§2 = refs-library.js, §5 = tab-generate, §6 = tab-references, и т.д.). Задачи ниже ссылаются на секции спеки для конкретного кода, чтобы не дублировать сотни строк. Читай соответствующую секцию спеки перед каждой задачей.

---

## File Structure

| Файл | Действие | Ответственность |
|------|----------|-----------------|
| `src/core.js` | Modify | Новые LF-ключи; deprecated state. |
| `src/refs-library.js` | **Create** | Pool CRUD, folders CRUD, chat-binding, smart-matching, collect, кэш, wipe-миграция. Заменяет `references-profiles.js`. |
| `src/references-profiles.js` | **Delete** | Удаляется (заменён refs-library.js). |
| `src/references.js` | Modify (комментарий) | Утилиты без изменений; обновить шапку-комментарий. |
| `src/bundles.js` | Modify | Deprecate `referencesProfileId`. |
| `src/chat-binding.js` | Modify | Убрать override refsProfileId; добавить refreshPoolCache. |
| `src/pipeline.js` | Modify | collect → новый модуль. |
| `src/ui/tab-references.js` | **Full rewrite** | Chat-секция + pool-секция + picker overlay. |
| `src/ui/tab-generate.js` | Modify | refs status/override под новую модель. |
| `src/ui/tab-gallery.js` | Modify | saveRef → пул; rebuildRefs → пул. |
| `src/ui/tab-profiles.js` | Modify | Убрать refs-лейбл бандла. |
| `index.js` | Modify | Убрать createReferencesProfile; wipe + refreshPoolCache. |
| `src/events.js` | Modify | refreshPoolCache в CHAT_CHANGED. |
| `style.css` | Modify | Удалить V3-классы; добавить новые. |
| `tests/references-profiles.test.js` | **Delete** | Заменён. |
| `tests/refs-library.test.js` | **Create** | Pool/folders/chat/collect/smart/wipe тесты. |

---

## Task 1: core.js — новые LF-ключи и deprecated state

**Files:**
- Modify: `src/core.js:24-26` (LF-ключи) и `src/core.js:46-77` (state)

- [ ] **Step 1: Добавить новые LF-ключи**

В `src/core.js`, после строки `export const LF_REFERENCES_PROFILES = 'uris_references_profiles';` (строка 24), добавить:

```js
// v3-redesign: пул референсов + папки (заменяют профили).
export const LF_REFS_POOL = 'uris_refs_pool';        // массив референсов
export const LF_REFS_FOLDERS = 'uris_refs_folders';  // массив папок (плоские)
```

- [ ] **Step 2: Пометить LF_REFERENCES_PROFILES deprecated**

Изменить комментарий над `export const LF_REFERENCES_PROFILES` (строка 24):

```js
export const LF_REFERENCES_PROFILES = 'uris_references_profiles';  // DEPRECATED (v3-redesign): wipe'ается при миграции. Заменён на LF_REFS_POOL + LF_REFS_FOLDERS.
```

- [ ] **Step 3: Deprecate state.activeReferencesProfileId**

В объекте `state` (строки 62-64), обновить комментарий:

```js
    activeTextProfileId: null,
    activeImageProfileId: null,
    activeReferencesProfileId: null,   // DEPRECATED (v3-redesign): не читается как источник рефов. Оставлено для back-compat структуры state.
    activeBundleId: null,
```

- [ ] **Step 4: Обновить комментарий refsOverride в state**

Строка ~73, комментарий над `refsOverride: null`:

```js
    // v3-redesign: эфемерный per-gen override референсов (вкладка «Генерация»).
    // Структура: { enabled, mode, includeChar, includeUser, extraEnabled } (см. refs-library.js RefsOverride).
    refsOverride: null,
```

- [ ] **Step 5: Verify syntax**

Run: `node --check src/core.js`
Expected: нет вывода (success).

- [ ] **Step 6: Commit**

```bash
git add src/core.js
git commit -m "refactor(refs): add LF_REFS_POOL/FOLDERS keys, deprecate activeReferencesProfileId"
```

---

## Task 2: refs-library.js — Pool CRUD (TDD)

**Files:**
- Create: `src/refs-library.js`
- Create: `tests/refs-library.test.js`

**Спека:** §2.1 (Pool CRUD).

- [ ] **Step 1: Создать тестовый mock-каркас**

Создать `tests/refs-library.test.js` с mock ST-контекста (на основе старого `tests/references-profiles.test.js`). Этот каркас — основа для всех последующих тестов:

```js
// @ts-check
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, LF_REFS_POOL, LF_REFS_FOLDERS, LF_REFERENCES_PROFILES, META_KEY } from '../src/core.js';

const memoryStore = new Map();

function makeLocalforage() {
    return {
        async getItem(key) { return memoryStore.has(key) ? memoryStore.get(key) : []; },
        async setItem(key, value) { memoryStore.set(key, value); },
        async removeItem(key) { memoryStore.delete(key); },
    };
}

let _chatMetadata = {};
globalThis.SillyTavern = {
    getContext: () => ({
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        saveMetadata: () => {},
        getRequestHeaders: () => ({}),
        characters: [{ name: 'Aria', avatar: 'aria.png' }, { name: 'Bob', avatar: 'bob.png' }],
        characterId: 0,
        name1: 'Alex',
        name2: 'Aria',
        get chatMetadata() { return _chatMetadata; },
    }),
    libs: { localforage: makeLocalforage() },
};
globalThis.toastr = undefined;

globalThis.FileReader ??= class FileReader {
    readAsDataURL(blob) {
        setTimeout(() => {
            this.result = 'data:image/png;base64,ZmFrZQ==';
            this.onloadend?.();
        }, 0);
    }
};

function withFetchBlob(fn) {
    return async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ blob: async () => new Blob(['fake'], { type: 'image/png' }) });
        try { await fn(); } finally { globalThis.fetch = originalFetch; }
    };
}

beforeEach(() => {
    memoryStore.clear();
    _chatMetadata = {};
});

// импорты появятся в следующих шагах
```

- [ ] **Step 2: Написать failing-тест на Pool CRUD**

Добавить в конец `tests/refs-library.test.js`:

```js
import { listRefs, getRef, createRef, updateRef, deleteRef } from '../src/refs-library.js';

test('createRef creates ref with normalized keywords and defaults', async () => {
    const r = await createRef({ name: 'Aria', keywords: 'red, hair', imagePath: '/a.png' });
    assert.ok(r.id);
    assert.equal(r.name, 'Aria');
    assert.deepEqual(r.keywords, ['red', 'hair']);
    assert.equal(r.imagePath, '/a.png');
    assert.equal(r.folderId, null);
    assert.equal(typeof r.createdAt, 'number');
});

test('listRefs returns empty array by default', async () => {
    const arr = await listRefs();
    assert.deepEqual(arr, []);
});

test('listRefs returns created refs', async () => {
    await createRef({ name: 'A', imagePath: '/a.png' });
    await createRef({ name: 'B', imagePath: '/b.png' });
    const arr = await listRefs();
    assert.equal(arr.length, 2);
});

test('createRef default name when empty', async () => {
    const r = await createRef({ name: '', imagePath: '/x.png' });
    assert.equal(r.name, 'Без названия');
});

test('getRef returns ref by id or null', async () => {
    const r = await createRef({ name: 'Aria', imagePath: '/a.png' });
    const found = await getRef(r.id);
    assert.equal(found.name, 'Aria');
    assert.equal(await getRef('nonexistent'), null);
});

test('updateRef patches fields', async () => {
    const r = await createRef({ name: 'Aria', imagePath: '/a.png' });
    const updated = await updateRef(r.id, { name: 'Aria Rose', keywords: 'x,y' });
    assert.equal(updated.name, 'Aria Rose');
    assert.deepEqual(updated.keywords, ['x', 'y']);
    assert.equal(updated.imagePath, '/a.png');  // не тронут
});

test('updateRef folderId null clears', async () => {
    const r = await createRef({ name: 'A', imagePath: '/a.png', folderId: 'f1' });
    const updated = await updateRef(r.id, { folderId: null });
    assert.equal(updated.folderId, null);
});

test('deleteRef removes ref', async () => {
    const r = await createRef({ name: 'A', imagePath: '/a.png' });
    await deleteRef(r.id);
    assert.equal(await getRef(r.id), null);
    assert.equal((await listRefs()).length, 0);
});
```

- [ ] **Step 3: Run test — verify FAIL (module not found)**

Run: `node --test tests/refs-library.test.js`
Expected: FAIL — `Cannot find module .../src/refs-library.js`.

- [ ] **Step 4: Создать refs-library.js с Pool CRUD + импортами + кэшем**

Создать `src/refs-library.js`. Код — точно по спеке §2.1 (Pool CRUD) + §2.6 (кэш). Полное содержимое (заголовок модуля + pool + кэш):

```js
// @ts-check
/**
 * Библиотека референсов: глобальный пул + папки + привязка по чату.
 * Заменяет references-profiles.js (v3-redesign).
 * Спека: docs/plans/2026-07-14-references-chat-scoped-pool.md §2.
 */
import {
    LF_REFS_POOL, LF_REFS_FOLDERS, LF_REFERENCES_PROFILES, META_KEY,
    uid, log, getCtx,
} from './core.js';
import { getCharacterAvatarDataUrl, getUserAvatarDataUrl, imageToDataUrl } from './references.js';

function lf() { return SillyTavern.libs.localforage; }

const MAX_REFS = 4;

// ── Pool CRUD ──

export async function listRefs() {
    const arr = await lf().getItem(LF_REFS_POOL);
    return Array.isArray(arr) ? arr : [];
}
async function _setRefs(arr) { await lf().setItem(LF_REFS_POOL, arr); }

export async function getRef(id) {
    const arr = await listRefs();
    return arr.find(r => r.id === id) || null;
}

export async function createRef(data = {}) {
    const arr = await listRefs();
    const item = {
        id: uid(),
        name: String(data.name || '').trim() || 'Без названия',
        keywords: Array.isArray(data.keywords)
            ? data.keywords.map(s => String(s).trim()).filter(Boolean)
            : String(data.keywords || '').split(/[,;|]/).map(s => s.trim()).filter(Boolean),
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

export async function updateRef(id, patch) {
    const arr = await listRefs();
    const i = arr.findIndex(r => r.id === id);
    if (i === -1) return null;
    if (patch.name != null) arr[i].name = String(patch.name).trim() || 'Без названия';
    if (patch.keywords != null)
        arr[i].keywords = String(patch.keywords).split(/[,;|]/).map(s => s.trim()).filter(Boolean);
    if (patch.imagePath != null) arr[i].imagePath = patch.imagePath;
    if (patch.folderId !== undefined) arr[i].folderId = patch.folderId || null;
    await _setRefs(arr);
    await refreshPoolCache();
    return arr[i];
}

export async function deleteRef(id) {
    const arr = await listRefs();
    await _setRefs(arr.filter(r => r.id !== id));
    await refreshPoolCache();
    log('Удалён референс', id);
}

// Кэш пула (§2.6) — определения refreshPoolCache/getRefSync ниже в этом файле.
```

> **Важно:** функции Folders CRUD, chat binding, smart-matching, collect, кэш, wipe будут добавлены в последующих задачах. Сейчас в файле только Pool CRUD + заголовок + импорты. `refreshPoolCache` будет определён в Task 5, но вызывается в createRef/updateRef/deleteRef — поэтому **сейчас код не запустится** (ReferenceError). Это ожидаемо: мы добавим заглушку кэша в Step 5.

- [ ] **Step 5: Добавить заглушку кэша, чтобы код запустился**

В конец `src/refs-library.js` добавить (полная версия кэша будет в Task 5, пока stub):

```js
// ── Pool cache (stub — full impl in Task 5) ──
let _poolCache = null;
export async function refreshPoolCache() { _poolCache = await listRefs(); }
```

- [ ] **Step 6: Run test — verify PASS**

Run: `node --test tests/refs-library.test.js`
Expected: PASS (8 тестов Pool CRUD).

- [ ] **Step 7: Commit**

```bash
git add src/refs-library.js tests/refs-library.test.js
git commit -m "feat(refs): add refs-library module with pool CRUD (TDD)"
```

---

## Task 3: refs-library.js — Folders CRUD (TDD)

**Files:**
- Modify: `src/refs-library.js` (добавить Folders CRUD после Pool CRUD)
- Modify: `tests/refs-library.test.js` (добавить тесты)

**Спека:** §2.2 (Folders CRUD).

- [ ] **Step 1: Написать failing-тесты на Folders CRUD**

Добавить в `tests/refs-library.test.js` (перед строкой импорта из следующей задачи, или в конец):

```js
import { listFolders, createFolder, renameFolder, deleteFolder } from '../src/refs-library.js';

test('createFolder creates folder with order', async () => {
    const f1 = await createFolder('NPC');
    assert.ok(f1.id);
    assert.equal(f1.name, 'NPC');
    assert.equal(f1.order, 0);
    const f2 = await createFolder('Locations');
    assert.equal(f2.order, 1);
});

test('createFolder default name when empty', async () => {
    const f = await createFolder('');
    assert.equal(f.name, 'Папка');
});

test('listFolders returns created folders', async () => {
    await createFolder('NPC');
    await createFolder('Locations');
    const arr = await listFolders();
    assert.equal(arr.length, 2);
});

test('renameFolder updates name', async () => {
    const f = await createFolder('Old');
    const renamed = await renameFolder(f.id, 'New');
    assert.equal(renamed.name, 'New');
});

test('deleteFolder removes folder', async () => {
    const f = await createFolder('NPC');
    await deleteFolder(f.id);
    assert.equal((await listFolders()).length, 0);
});

test('deleteFolder moves refs in it to folderId=null', async () => {
    const f = await createFolder('NPC');
    const r = await createRef({ name: 'Aria', imagePath: '/a.png', folderId: f.id });
    await deleteFolder(f.id);
    const after = await getRef(r.id);
    assert.equal(after.folderId, null);
});
```

- [ ] **Step 2: Run test — verify FAIL**

Run: `node --test tests/refs-library.test.js`
Expected: FAIL — `listFolders is not a function` / named export not found.

- [ ] **Step 3: Добавить Folders CRUD**

В `src/refs-library.js`, после Pool CRUD (после `deleteRef`), добавить точно по спеке §2.2:

```js
// ── Folders CRUD ──

export async function listFolders() {
    const arr = await lf().getItem(LF_REFS_FOLDERS);
    return Array.isArray(arr) ? arr : [];
}
async function _setFolders(arr) { await lf().setItem(LF_REFS_FOLDERS, arr); }

export async function createFolder(name) {
    const arr = await listFolders();
    const item = { id: uid(), name: String(name || 'Папка').trim() || 'Папка', order: arr.length };
    arr.push(item);
    await _setFolders(arr);
    return item;
}

export async function renameFolder(id, name) {
    const arr = await listFolders();
    const f = arr.find(x => x.id === id);
    if (!f) return null;
    f.name = String(name || 'Папка').trim() || 'Папка';
    await _setFolders(arr);
    return f;
}

// Удаление папки: референсы в ней → folderId=null («без папки»).
export async function deleteFolder(id) {
    const folders = await listFolders();
    await _setFolders(folders.filter(f => f.id !== id));
    const refs = await listRefs();
    let changed = false;
    for (const r of refs) if (r.folderId === id) { r.folderId = null; changed = true; }
    if (changed) await _setRefs(refs);
    await refreshPoolCache();
    log('Удалена папка', id);
}
```

- [ ] **Step 4: Run test — verify PASS**

Run: `node --test tests/refs-library.test.js`
Expected: PASS (все Pool + Folders тесты).

- [ ] **Step 5: Commit**

```bash
git add src/refs-library.js tests/refs-library.test.js
git commit -m "feat(refs): add folders CRUD to refs-library (TDD)"
```

---

## Task 4: refs-library.js — Chat binding read/write (TDD)

**Files:**
- Modify: `src/refs-library.js`
- Modify: `tests/refs-library.test.js`

**Спека:** §2.3 (Chat binding).

- [ ] **Step 1: Написать failing-тесты на chat binding**

Добавить в `tests/refs-library.test.js`:

```js
import { getChatRefs, saveChatRefs, defaultChatRefs } from '../src/refs-library.js';

test('defaultChatRefs returns smart mode with auto slots', () => {
    assert.deepEqual(defaultChatRefs(), {
        mode: 'smart', charSlot: { type: 'auto' }, userSlot: { type: 'auto' }, extraRefIds: [],
    });
});

test('getChatRefs returns default for chat without binding', () => {
    assert.deepEqual(getChatRefs(), defaultChatRefs());
});

test('saveChatRefs persists merge-patch to chatMetadata', async () => {
    await saveChatRefs({ mode: 'always' });
    const meta = SillyTavern.getContext().chatMetadata[META_KEY];
    assert.equal(meta.refs.mode, 'always');
    assert.equal(meta.refs.charSlot.type, 'auto');  // default сохранился
});

test('saveChatRefs charSlot pinned reads back', async () => {
    const ref = await createRef({ name: 'Aria', imagePath: '/a.png' });
    await saveChatRefs({ charSlot: { type: 'pinned', refId: ref.id } });
    const r = getChatRefs();
    assert.equal(r.charSlot.type, 'pinned');
    assert.equal(r.charSlot.refId, ref.id);
});

test('getChatRefs normalizes invalid slot to auto', async () => {
    SillyTavern.getContext().chatMetadata[META_KEY] = { refs: { charSlot: { type: 'pinned' } } };  // нет refId
    assert.equal(getChatRefs().charSlot.type, 'auto');
});

test('getChatRefs normalizes invalid mode to smart', () => {
    SillyTavern.getContext().chatMetadata[META_KEY] = { refs: { mode: 'bogus' } };
    assert.equal(getChatRefs().mode, 'smart');
});

test('saveChatRefs extraRefIds stored as strings', async () => {
    await saveChatRefs({ extraRefIds: [123, 'abc'] });
    assert.deepEqual(getChatRefs().extraRefIds, ['123', 'abc']);
});

test('saveChatRefs preserves existing bundleId/overrides in binding', async () => {
    SillyTavern.getContext().chatMetadata[META_KEY] = { bundleId: 'b1', overrides: { imageProfileId: 'x' } };
    await saveChatRefs({ mode: 'always' });
    const meta = SillyTavern.getContext().chatMetadata[META_KEY];
    assert.equal(meta.bundleId, 'b1');  // не затёрт
    assert.equal(meta.overrides.imageProfileId, 'x');
    assert.equal(meta.refs.mode, 'always');
});
```

- [ ] **Step 2: Run test — verify FAIL**

Run: `node --test tests/refs-library.test.js`
Expected: FAIL — `getChatRefs is not a function`.

- [ ] **Step 3: Добавить chat binding функции**

В `src/refs-library.js`, после Folders CRUD, добавить точно по спеке §2.3 (`defaultChatRefs`, `_rawBinding`, `getChatRefs`, `_normalizeSlot`, `saveChatRefs`):

```js
// ── Chat binding (chatMetadata.uris_binding.refs) ──

/**
 * Дефолтная структура refs для нового чата.
 * charSlot/userSlot — auto (из ST). mode — 'smart'.
 */
export function defaultChatRefs() {
    return {
        mode: 'smart',
        charSlot: { type: 'auto' },
        userSlot: { type: 'auto' },
        extraRefIds: [],
    };
}

function _rawBinding() {
    const ctx = getCtx();
    const meta = ctx.chatMetadata?.[META_KEY];
    return meta && typeof meta === 'object' ? meta : null;
}

/** Читать refs текущего чата. Если нет — default (НЕ пишет назад). */
export function getChatRefs() {
    const binding = _rawBinding();
    if (!binding?.refs || typeof binding.refs !== 'object') return defaultChatRefs();
    const r = binding.refs;
    return {
        mode: ['always', 'smart', 'never'].includes(r.mode) ? r.mode : 'smart',
        charSlot: _normalizeSlot(r.charSlot),
        userSlot: _normalizeSlot(r.userSlot),
        extraRefIds: Array.isArray(r.extraRefIds) ? r.extraRefIds.map(String) : [],
    };
}

function _normalizeSlot(s) {
    if (s && s.type === 'pinned' && s.refId) return { type: 'pinned', refId: String(s.refId) };
    return { type: 'auto' };
}

/** Merge-patch refs текущего чата в chatMetadata + saveMetadata. */
export function saveChatRefs(patch) {
    const ctx = getCtx();
    if (!ctx.chatMetadata) ctx.chatMetadata = {};
    if (!ctx.chatMetadata[META_KEY]) ctx.chatMetadata[META_KEY] = {};
    const binding = ctx.chatMetadata[META_KEY];
    binding.refs = { ...(getChatRefs()), ...patch };
    try { ctx.saveMetadata?.(); } catch { /* non-critical */ }
    log('Chat refs обновлены', binding.refs);
    return binding.refs;
}
```

- [ ] **Step 4: Run test — verify PASS**

Run: `node --test tests/refs-library.test.js`
Expected: PASS (все Pool + Folders + chat-binding тесты).

- [ ] **Step 5: Commit**

```bash
git add src/refs-library.js tests/refs-library.test.js
git commit -m "feat(refs): add chat binding read/write to refs-library (TDD)"
```

---

## Task 5: refs-library.js — Smart-matching + кэш + collect (TDD)

**Files:**
- Modify: `src/refs-library.js`
- Modify: `tests/refs-library.test.js`

**Спека:** §2.4 (smart-matching), §2.6 (кэш), §2.7 (collect).

- [ ] **Step 1: Написать failing-тесты на smart-matching + кэш**

Добавить в `tests/refs-library.test.js`:

```js
import { isNameInText, getRefSync, refreshPoolCache } from '../src/refs-library.js';

test('isNameInText matches whole word only', () => {
    assert.ok(isNameInText('Aria', 'Aria walked in'));
    assert.ok(!isNameInText('Aria', 'Arianna walked in'));
    assert.ok(isNameInText('Aria Rose', 'Rose was there'));
    assert.ok(!isNameInText('Cat', 'category'));
});

test('isNameInText ignores single-character tokens', () => {
    assert.ok(!isNameInText('A', 'A walked in'));
    assert.ok(!isNameInText('A', 'Some A text'));
});

test('getRefSync returns null before refreshPoolCache', async () => {
    // После beforeEach пул пуст и кэш мог остаться от прошлого теста.
    // refreshPoolCache в createRef обновляет, но прямой тест:
    assert.equal(getRefSync('nonexistent'), null);
});

test('getRefSync returns ref after refreshPoolCache', async () => {
    const r = await createRef({ name: 'Aria', imagePath: '/a.png' });
    await refreshPoolCache();
    const sync = getRefSync(r.id);
    assert.equal(sync?.name, 'Aria');
});
```

- [ ] **Step 2: Run test — verify FAIL**

Run: `node --test tests/refs-library.test.js`
Expected: FAIL — `isNameInText is not a function`.

- [ ] **Step 3: Добавить smart-matching + обновить кэш (заменить stub)**

В `src/refs-library.js` **заменить** stub-блок кэша (из Task 2 Step 5) на полный:

```js
// ── Smart-matching (§2.4) ──

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function isNameInText(name, text) {
    const tokens = String(name || '').split(/[\s,;|/]+/).map(t => t.trim()).filter(t => t.length >= 2);
    if (!tokens.length) return false;
    const pattern = tokens.map(escapeRegex).join('|');
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(${pattern})(?![\\p{L}\\p{N}])`, 'iu');
    return re.test(String(text || ''));
}

function refMatchesKeywords(ref, text) {
    const tokens = [ref.name, ...(ref.keywords || [])];
    return tokens.some(t => isNameInText(t, text));
}

// ── Pool cache (§2.6) ──

let _poolCache = null;

export async function refreshPoolCache() {
    _poolCache = await listRefs();
}

/** Синхронный доступ к референсу пула по id (из кэша). null если кэш пуст/id нет. */
export function getRefSync(id) {
    if (!_poolCache) return null;
    return _poolCache.find(r => r.id === id) || null;
}
```

- [ ] **Step 4: Run test — verify PASS**

Run: `node --test tests/refs-library.test.js`
Expected: PASS.

- [ ] **Step 5: Написать failing-тесты на collect**

Добавить в `tests/refs-library.test.js`:

```js
import { collectRefsForCurrentChat, previewRefsForCurrentChat } from '../src/refs-library.js';

test('collect auto char + auto user = 2 refs', withFetchBlob(async () => {
    const refs = await collectRefsForCurrentChat({ charName: 'Aria', userName: 'Alex' });
    assert.equal(refs.length, 2);
    assert.equal(refs[0].role, 'char');
    assert.equal(refs[1].role, 'user');
}));

test('collect pinned char + smart extra mentioned', withFetchBlob(async () => {
    const ariaRef = await createRef({ name: 'Aria-pin', imagePath: '/a.png', keywords: 'Aria-pin' });
    const bobRef = await createRef({ name: 'Bob', imagePath: '/b.png' });
    await saveChatRefs({ charSlot: { type: 'pinned', refId: ariaRef.id }, extraRefIds: [bobRef.id] });
    const refs = await collectRefsForCurrentChat({ chatText: 'Bob enters', charName: 'Aria', userName: 'Alex' });
    assert.equal(refs.length, 3);  // pinned char + auto user + Bob
    assert.ok(refs.some(r => r.name === 'Aria-pin'));
    assert.ok(refs.some(r => r.name === 'Bob'));
}));

test('collect pinned char + smart extra unmentioned (extra filtered)', withFetchBlob(async () => {
    const ariaRef = await createRef({ name: 'Aria-pin', imagePath: '/a.png' });
    const bobRef = await createRef({ name: 'Bob', imagePath: '/b.png' });
    await saveChatRefs({ charSlot: { type: 'pinned', refId: ariaRef.id }, extraRefIds: [bobRef.id] });
    const refs = await collectRefsForCurrentChat({ chatText: 'no mention', charName: 'Aria', userName: 'Alex' });
    assert.equal(refs.length, 2);  // pinned char + auto user; Bob filtered by smart
    assert.ok(!refs.some(r => r.name === 'Bob'));
}));

test('collect mode never returns empty', withFetchBlob(async () => {
    await saveChatRefs({ mode: 'never' });
    const refs = await collectRefsForCurrentChat({ charName: 'Aria' });
    assert.equal(refs.length, 0);
}));

test('collect override enabled=false returns empty', withFetchBlob(async () => {
    const refs = await collectRefsForCurrentChat({ charName: 'Aria' }, { enabled: false });
    assert.equal(refs.length, 0);
}));

test('collect override includeChar=false removes char slot', withFetchBlob(async () => {
    const refs = await collectRefsForCurrentChat({ charName: 'Aria', userName: 'Alex' }, { includeChar: false });
    assert.ok(!refs.some(r => r.role === 'char'));
    assert.ok(refs.some(r => r.role === 'user'));
}));

test('collect override includeUser=false removes user slot', withFetchBlob(async () => {
    const refs = await collectRefsForCurrentChat({ charName: 'Aria', userName: 'Alex' }, { includeUser: false });
    assert.ok(refs.some(r => r.role === 'char'));
    assert.ok(!refs.some(r => r.role === 'user'));
}));

test('collect override extraEnabled toggles individual extra', withFetchBlob(async () => {
    const r1 = await createRef({ name: 'A', imagePath: '/a.png' });
    const r2 = await createRef({ name: 'B', imagePath: '/b.png' });
    await saveChatRefs({ extraRefIds: [r1.id, r2.id], mode: 'always' });
    const refs = await collectRefsForCurrentChat({}, { includeChar: false, includeUser: false, extraEnabled: { [r1.id]: false } });
    assert.equal(refs.length, 1);
    assert.equal(refs[0].name, 'B');
}));

test('collect MAX_REFS=4 cap with extras', withFetchBlob(async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) {
        const r = await createRef({ name: `N${i}`, imagePath: `/${i}.png` });
        ids.push(r.id);
    }
    await saveChatRefs({ extraRefIds: ids });  // +char +user = 6 → cap 4
    const refs = await collectRefsForCurrentChat({ chatText: 'N0 N1 N2 N3', charName: 'A', userName: 'B' });
    assert.equal(refs.length, 4);
}));

test('collect deleted ref in extras skipped (no error)', withFetchBlob(async () => {
    await saveChatRefs({ extraRefIds: ['nonexistent'] });
    const refs = await collectRefsForCurrentChat({}, { includeChar: false, includeUser: false });
    assert.equal(refs.length, 0);
}));

test('collect ref without imagePath skipped', withFetchBlob(async () => {
    const r = await createRef({ name: 'NoImg', imagePath: '' });
    await saveChatRefs({ extraRefIds: [r.id], mode: 'always' });
    const refs = await collectRefsForCurrentChat({}, { includeChar: false, includeUser: false });
    assert.equal(refs.length, 0);
}));

test('preview returns descriptors synchronously', async () => {
    const r = await createRef({ name: 'Aria-pin', imagePath: '/a.png' });
    await saveChatRefs({ charSlot: { type: 'pinned', refId: r.id } });
    const descriptors = previewRefsForCurrentChat({ charName: 'A', userName: 'B' });
    assert.ok(Array.isArray(descriptors));
    assert.equal(descriptors[0].role, 'char');
    assert.equal(descriptors[0].kind, 'pinned');
});
```

- [ ] **Step 6: Run test — verify FAIL**

Run: `node --test tests/refs-library.test.js`
Expected: FAIL — `collectRefsForCurrentChat is not a function`.

- [ ] **Step 7: Добавить collect функции (§2.5 + §2.7)**

В `src/refs-library.js`, после кэша, добавить `_resolveRefs`, `getUserAvatarDataUrlForCurrent`, `collectRefsForCurrentChat`, `previewRefsForCurrentChat`. Код точно по спеке §2.5 (`_resolveRefs`) и §2.7 (collect + preview + user-avatar helper):

```js
// ── Collect: какие референсы отправить ──

/**
 * Override per-генерации (эфемерный, state.refsOverride).
 * @typedef {Object} RefsOverride
 * @property {boolean} [enabled]       - false = не отправлять рефы вовсе.
 * @property {'always'|'smart'|'never'} [mode]
 * @property {boolean} [includeChar]   - false = выключить char-слот.
 * @property {boolean} [includeUser]   - false = выключить user-слот.
 * @property {Record<string, boolean>} [extraEnabled] - {refId: bool} toggle extras.
 */

/**
 * Дескриптор референса для отправки (без fetch).
 * @typedef {Object} RefDescriptor
 * @property {'char'|'user'|'npc'} role
 * @property {string} name
 * @property {'auto'|'pinned'} [kind]
 * @property {string} [refId]
 * @property {string} [imagePath]
 */

/**
 * Решить, какие референсы включаются для текущего чата. Синхронно, без fetch.
 */
function _resolveRefs(context, override) {
    const chatRefs = getChatRefs();
    let mode = chatRefs.mode || 'smart';
    if (override) {
        if (override.enabled === false) return [];
        if (override.mode != null) mode = override.mode;
    }
    if (mode === 'never') return [];

    const { chatText = '', instructionText = '', charName = '', userName = '' } = context;
    const combinedText = `${chatText} ${instructionText}`;
    const smart = mode === 'smart';
    const out = [];

    // 1. char-слот — НЕ фильтруется smart.
    const charOff = override && override.includeChar === false;
    if (!charOff) {
        const slot = chatRefs.charSlot;
        if (slot.type === 'pinned' && slot.refId) {
            const ref = getRefSync(slot.refId);
            if (ref?.imagePath) {
                out.push({ role: 'char', name: ref.name, kind: 'pinned', refId: ref.id, imagePath: ref.imagePath });
            }
        } else {
            out.push({ role: 'char', name: charName, kind: 'auto' });
        }
    }

    // 2. user-слот — НЕ фильтруется smart.
    if (out.length < MAX_REFS) {
        const userOff = override && override.includeUser === false;
        if (!userOff) {
            const slot = chatRefs.userSlot;
            if (slot.type === 'pinned' && slot.refId) {
                const ref = getRefSync(slot.refId);
                if (ref?.imagePath) {
                    out.push({ role: 'user', name: ref.name, kind: 'pinned', refId: ref.id, imagePath: ref.imagePath });
                }
            } else {
                out.push({ role: 'user', name: userName, kind: 'auto' });
            }
        }
    }

    // 3. extras — по порядку, с smart-фильтром.
    for (const refId of chatRefs.extraRefIds) {
        if (out.length >= MAX_REFS) break;
        const overrideEnabled = override?.extraEnabled && typeof override.extraEnabled[refId] === 'boolean'
            ? override.extraEnabled[refId] : true;
        if (!overrideEnabled) continue;
        const ref = getRefSync(refId);
        if (!ref?.imagePath) continue;
        if (smart && !refMatchesKeywords(ref, combinedText)) continue;
        out.push({ role: 'npc', name: ref.name, refId: ref.id, imagePath: ref.imagePath });
    }
    return out.slice(0, MAX_REFS);
}

// user-avatar для auto-режима: ST хранит user-аватары в /User Avatars/<filename>.
// Эвристика: имя файла = persona name. Уточнить при реализации, если ST даёт прямой API.
async function getUserAvatarDataUrlForCurrent() {
    const ctx = getCtx();
    const persona = ctx.name1 || '';
    const file = ctx.userAvatarFile || (persona ? persona : '');
    return file ? getUserAvatarDataUrl(file) : null;
}

/**
 * Собрать референсы для текущего чата (с fetch dataUrl) — для pipeline.
 */
export async function collectRefsForCurrentChat(context = {}, override = null) {
    const descriptors = _resolveRefs(context, override);
    if (!descriptors.length) { log('Собрано референсов: 0'); return []; }
    const refs = [];
    for (const d of descriptors) {
        let dataUrl = null;
        try {
            if (d.role === 'char') {
                dataUrl = d.kind === 'pinned' ? await imageToDataUrl(d.imagePath) : await getCharacterAvatarDataUrl();
            } else if (d.role === 'user') {
                dataUrl = d.kind === 'pinned' ? await imageToDataUrl(d.imagePath) : await getUserAvatarDataUrlForCurrent();
            } else {
                dataUrl = await imageToDataUrl(d.imagePath);
            }
        } catch { /* ignore individual failures */ }
        if (dataUrl) refs.push({ image: dataUrl, role: d.role, name: d.name });
    }
    log(`Собрано референсов: ${refs.length}`);
    return refs.slice(0, MAX_REFS);
}

export function previewRefsForCurrentChat(context = {}, override = null) {
    return _resolveRefs(context, override);
}
```

- [ ] **Step 8: Run test — verify PASS**

Run: `node --test tests/refs-library.test.js`
Expected: PASS (все тесты Pool + Folders + chat-binding + smart + collect).

- [ ] **Step 9: Commit**

```bash
git add src/refs-library.js tests/refs-library.test.js
git commit -m "feat(refs): add smart-matching, pool cache, collect/preview to refs-library (TDD)"
```

---

## Task 6: refs-library.js — Migration wipe (TDD)

**Files:**
- Modify: `src/refs-library.js`
- Modify: `tests/refs-library.test.js`

**Спека:** §2.8 (Миграция-wipe).

- [ ] **Step 1: Написать failing-тест на wipe**

Добавить в `tests/refs-library.test.js`:

```js
import { migrateWipeLegacyProfiles } from '../src/refs-library.js';

test('migrateWipeLegacyProfiles removes LF_REFERENCES_PROFILES', async () => {
    memoryStore.set(LF_REFERENCES_PROFILES, [{ id: 'old', npcReferences: [] }]);
    await migrateWipeLegacyProfiles();
    assert.equal(memoryStore.has(LF_REFERENCES_PROFILES), false);
});

test('migrateWipeLegacyProfiles idempotent (safe to call twice)', async () => {
    memoryStore.set(LF_REFERENCES_PROFILES, [{ id: 'old' }]);
    await migrateWipeLegacyProfiles();
    await migrateWipeLegacyProfiles();  // second call - no throw
    assert.equal(memoryStore.has(LF_REFERENCES_PROFILES), false);
});

test('migrateWipeLegacyProfiles does not touch LF_REFS_POOL', async () => {
    memoryStore.set(LF_REFERENCES_PROFILES, [{ id: 'old' }]);
    memoryStore.set(LF_REFS_POOL, [{ id: 'newpool' }]);
    await migrateWipeLegacyProfiles();
    assert.equal(memoryStore.has(LF_REFERENCES_PROFILES), false);
    assert.deepEqual(memoryStore.get(LF_REFS_POOL), [{ id: 'newpool' }]);
});
```

- [ ] **Step 2: Run test — verify FAIL**

Run: `node --test tests/refs-library.test.js`
Expected: FAIL — `migrateWipeLegacyProfiles is not a function`.

- [ ] **Step 3: Добавить wipe-функцию**

В конец `src/refs-library.js`, добавить точно по спеке §2.8:

```js
// ── Migration wipe (§2.8) ──

let _migrated = false;

/**
 * Одноразовая миграция: стереть старые профили референсов (LF_REFERENCES_PROFILES).
 * Решение пользователя — чистый старт пула. Идемпотентно: флаг _migrated в памяти.
 * Перезапуск окна = повторный wipe (безопасно: пул отдельный ключ).
 */
export async function migrateWipeLegacyProfiles() {
    if (_migrated) return;
    _migrated = true;
    try {
        await lf().removeItem(LF_REFERENCES_PROFILES);
        log('Миграция: стёрты старые профили референсов (LF_REFERENCES_PROFILES)');
    } catch (e) {
        log('Миграция wipe: ошибка', e.message);
    }
}
```

- [ ] **Step 4: Run full test suite — verify ALL PASS**

Run: `node --test tests/refs-library.test.js`
Expected: PASS (все тесты модуля).

- [ ] **Step 5: Verify other tests still pass (no regression yet)**

Run: `node --test tests/`
Expected: PASS. На этом этапе `references-profiles.js` ещё существует, старые тесты тоже — регрессий быть не должно.

- [ ] **Step 6: Commit**

```bash
git add src/refs-library.js tests/refs-library.test.js
git commit -m "feat(refs): add legacy profiles wipe migration to refs-library (TDD)"
```

---

## Task 7: bundles.js + chat-binding.js — deprecate referencesProfileId

**Files:**
- Modify: `src/bundles.js:79-111` (persistBundleFields), `src/bundles.js:159-174` (applyBundleToState), `src/bundles.js:179-198` (snapshotCurrentStateToBundle)
- Modify: `src/chat-binding.js:20-43` (applyBindingForCurrentChat)

**Спека:** §3 (bundles.js + chat-binding.js).

- [ ] **Step 1: bundles.js — applyBundleToState: убрать refs-применение**

В `src/bundles.js`, в `applyBundleToState` (строка 164), заменить строку:

```js
    state.activeReferencesProfileId = bundle.referencesProfileId;
```

на:

```js
    // referencesProfileId deprecated (v3-redesign): refs теперь по чату, не по профилю.
    state.activeReferencesProfileId = null;
```

- [ ] **Step 2: bundles.js — persistBundleFields: игнорировать referencesProfileId**

В `src/bundles.js`, в `persistBundleFields` (строки 99-110), заменить блок:

```js
    if (Object.hasOwn(patch, 'imageProfileId')) state.activeImageProfileId = patch.imageProfileId;
    if (Object.hasOwn(patch, 'referencesProfileId')) state.activeReferencesProfileId = patch.referencesProfileId;
    if (Object.hasOwn(patch, 'templatesIds')) state.activeTemplateId = (patch.templatesIds && patch.templatesIds[0]) || null;
```

на:

```js
    if (Object.hasOwn(patch, 'imageProfileId')) state.activeImageProfileId = patch.imageProfileId;
    // referencesProfileId deprecated (v3-redesign): игнорируем.
    if (Object.hasOwn(patch, 'templatesIds')) state.activeTemplateId = (patch.templatesIds && patch.templatesIds[0]) || null;
```

- [ ] **Step 3: bundles.js — snapshotCurrentStateToBundle: убрать refs**

В `src/bundles.js`, в `snapshotCurrentStateToBundle` (строка 190), убрать строку `referencesProfileId: state.activeReferencesProfileId,` из объекта createBundle-вызова.

- [ ] **Step 4: chat-binding.js — убрать override refsProfileId**

В `src/chat-binding.js`, в `applyBindingForCurrentChat` (строки 36-39), заменить:

```js
    // Применяем overrides (точечные переопределения — v2)
    if (binding.overrides) {
        if (binding.overrides.imageProfileId) state.activeImageProfileId = binding.overrides.imageProfileId;
        if (binding.overrides.referencesProfileId) state.activeReferencesProfileId = binding.overrides.referencesProfileId;
    }
```

на:

```js
    // Применяем overrides (точечные переопределения — v2).
    // referencesProfileId override убран (v3-redesign): refs теперь по чату.
    if (binding.overrides) {
        if (binding.overrides.imageProfileId) state.activeImageProfileId = binding.overrides.imageProfileId;
    }
```

- [ ] **Step 5: chat-binding.js — добавить refreshPoolCache после applyBundle**

В `src/chat-binding.js`, добавить импорт `refreshPoolCache`:

Изменить строку импорта (строки 9-11):
```js
import {
    getBinding, setBinding, applyBundleToCurrentChat, defaultBundle,
} from './bundles.js';
```
на:
```js
import {
    getBinding, setBinding, applyBundleToCurrentChat, defaultBundle,
} from './bundles.js';
import { refreshPoolCache } from './refs-library.js';
```

В конце `applyBindingForCurrentChat` (перед `return bundle;` на строке 42), добавить:

```js
    // v3-redesign: обновить кэш пула для нового чата (для синхронного preview).
    await refreshPoolCache();

    log('Применена привязка через бандл:', bundle.id, bundle.name);
    return bundle;
```

- [ ] **Step 6: Verify syntax**

Run: `node --check src/bundles.js && node --check src/chat-binding.js`
Expected: нет вывода.

- [ ] **Step 7: Commit**

```bash
git add src/bundles.js src/chat-binding.js
git commit -m "refactor(refs): deprecate referencesProfileId in bundles/chat-binding, add refreshPoolCache"
```

---

## Task 8: pipeline.js — swap collect call

**Files:**
- Modify: `src/pipeline.js:17` (импорт), `src/pipeline.js:165` (JSDoc), `src/pipeline.js:205-210` (collect call)

**Спека:** §4 (pipeline.js).

- [ ] **Step 1: Заменить импорт**

В `src/pipeline.js` строка 17, заменить:

```js
import { collectReferencesFromActiveProfile } from './references-profiles.js';
```

на:

```js
import { collectRefsForCurrentChat } from './refs-library.js';
```

- [ ] **Step 2: Обновить JSDoc**

В `src/pipeline.js` строка 165, заменить:

```js
 * @param {import('./references-profiles.js').RefsOverride} [opts.override] - per-gen override активного профиля.
```

на:

```js
 * @param {import('./refs-library.js').RefsOverride} [opts.override] - per-gen override референсов текущего чата.
```

- [ ] **Step 3: Заменить collect-вызов**

В `src/pipeline.js` строки 204-210, заменить:

```js
        } else {
            refs = await collectReferencesFromActiveProfile({
                chatText: msg?.mes || '',
                instructionText: `${instruction.prompt || ''} ${instruction.style || ''}`,
                charName,
                userName,
            }, opts.override || null);
        }
```

на:

```js
        } else {
            refs = await collectRefsForCurrentChat({
                chatText: msg?.mes || '',
                instructionText: `${instruction.prompt || ''} ${instruction.style || ''}`,
                charName,
                userName,
            }, opts.override || null);
        }
```

- [ ] **Step 4: Verify syntax**

Run: `node --check src/pipeline.js`
Expected: нет вывода.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline.js
git commit -m "refactor(refs): pipeline uses collectRefsForCurrentChat"
```

---

## Task 9: index.js — убрать createReferencesProfile, добавить wipe + refreshPoolCache

**Files:**
- Modify: `index.js:38` (импорт), `index.js:79-80` (init), `index.js:167-213` (migrateV1Settings)

**Спека:** §9 (index.js).

- [ ] **Step 1: Убрать импорт createReferencesProfile**

В `index.js` строка 38, удалить строку:

```js
import { createReferencesProfile } from './src/references-profiles.js';
```

Добавить новый импорт (после строки импорта `createBundle, saveBundle` ~строка 37):

```js
import { migrateWipeLegacyProfiles, refreshPoolCache } from './src/refs-library.js';
```

- [ ] **Step 2: migrateV1Settings — убрать создание refs-профиля**

В `index.js`, в `migrateV1Settings` (строки 191-204), заменить блок создания refs-профиля:

```js
            // Создаём references-profile из image-preset'а если были галки референсов.
            // param-presets.js удалён в v2 — читаем legacy-массив LF_IMAGE_PARAMS напрямую.
            const images = (await SillyTavern.libs.localforage.getItem(LF_IMAGE_PARAMS)) || [];
            const ip = images.find(im => im.id === meta.imageParamId);
            if (ip && (ip.sendCharAvatar || ip.userAvatarFile)) {
                const refs = await createReferencesProfile({
                    name: 'Импорт из v1',
                    charAvatar: !!ip.sendCharAvatar,
                    userAvatarFile: ip.userAvatarFile || '',
                    mode: ip.referenceMode || 'never',
                });
                b.referencesProfileId = refs.id;
                await saveBundle(b);
            }
```

на (refs-профилей больше нет; char/user аватары теперь auto из chat binding по умолчанию):

```js
            // v3-redesign: references-профилей больше нет. v1-галки sendCharAvatar/
            // userAvatarFile не мигрируем — char/user аватары по умолчанию auto
            // (берутся из ST). Пользователь при желании pin-ит из пула.
```

- [ ] **Step 3: init — добавить wipe + refreshPoolCache**

В `index.js`, в `init()` после `await ensureBuiltinCharacterSlots();` (строка 81), добавить:

```js
    await ensureBuiltinCharacterSlots();

    // v3-redesign: wipe старых профилей референсов + прогрев кэша пула.
    await migrateWipeLegacyProfiles();
    await refreshPoolCache();
```

- [ ] **Step 4: Verify syntax**

Run: `node --check index.js`
Expected: нет вывода.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "refactor(refs): index.js wipes legacy profiles, removes createReferencesProfile import"
```

---

## Task 10: tab-generate.js — rewrite refs status + override

**Files:**
- Modify: `src/ui/tab-generate.js:25` (импорт), `src/ui/tab-generate.js:548-558` (initOverrideFromProfile), `src/ui/tab-generate.js:571-705` (renderRefsStatus), `src/ui/tab-generate.js:707-725` (refDescriptorChip), `src/ui/tab-generate.js:732-765` (buildOverrideControls), `src/ui/tab-generate.js:772-815` (bindOverrideControls)

**Спека:** §5 (tab-generate.js). Внимательно: этот файл большой, изменения точечные.

- [ ] **Step 1: Заменить импорт**

В `src/ui/tab-generate.js` строка 25, заменить:

```js
import { getActiveReferencesProfile, collectReferencesPreview } from '../references-profiles.js';
```

на:

```js
import { previewRefsForCurrentChat, getChatRefs, getRefSync } from '../refs-library.js';
```

- [ ] **Step 2: initOverrideFromProfile → initOverride**

В `src/ui/tab-generate.js`, заменить функцию `initOverrideFromProfile` (строки 548-558) целиком:

```js
/**
 * Инициализировать пустой override. Стартует «всё включено» — пользователь
 * отключает нужное (явный выбор, без наследия из профиля — профилей больше нет).
 * @returns {object}
 */
function initOverride() {
    return { enabled: true, mode: null, includeChar: null, includeUser: null, extraEnabled: {} };
}
```

- [ ] **Step 3: renderRefsStatus — переписать под chat-refs**

В `src/ui/tab-generate.js`, заменить тело `renderRefsStatus` (строки 571-705). Прочитай спеку §5 (renderRefsStatus). Ключевые изменения:
- Убрать `await getActiveReferencesProfile()` → читать `getChatRefs()` синхронно.
- Бейдж mode — из `getChatRefs().mode`.
- `profileName` элемент — скрыть или заменить на «Чат: {{char}}».
- `descriptors = previewRefsForCurrentChat(genContext, overrideForPreview)` (вместо `collectReferencesPreview(profile, ...)`).
- Cap-расчёт: char(1 если slot есть) + user(1 если slot есть) + extras; smart-фильтр extras учитывается в preview length.
- Override-контролы показывать когда `isOverrideOn`.

Полный код функции (по спеке §5):

```js
async function renderRefsStatus(root) {
    const badge = root.querySelector('#urisRefsModeBadge');
    const profileName = root.querySelector('#urisRefsProfileName');
    const body = root.querySelector('#urisRefsStatusBody');
    const cap = root.querySelector('#urisRefsCap');
    if (!badge || !body) return;

    const chatRefs = getChatRefs();
    const mode = chatRefs.mode || 'smart';
    badge.textContent = refsModeLabel(mode);
    badge.className = 'uris-refs-status-badge' + (mode === 'never' ? ' uris-badge-warning' : '');
    if (profileName) profileName.textContent = mode === 'never' ? '' : 'по чату';

    const isOverrideOn = !!(state.refsOverride && state.refsOverride.enabled);
    const overrideForPreview = isOverrideOn ? state.refsOverride : null;

    const cb = root.querySelector('#urisRefsOverrideEnabled');
    if (cb && cb.checked !== isOverrideOn) cb.checked = isOverrideOn;
    const resetBtn = root.querySelector('#urisRefsReset');
    if (resetBtn) resetBtn.style.display = isOverrideOn ? '' : 'none';

    const ctx = getCtx();
    const msgId = state.currentMsgId;
    const msg = ctx.chat?.[msgId];
    const charName = ctx.name2 || ctx.characters?.[ctx.characterId]?.name || '';
    const userName = ctx.name1 || '';
    const instr = collectInstruction();
    const genContext = {
        chatText: msg?.mes || '',
        instructionText: `${instr.prompt || ''} ${instr.style || ''}`,
        charName, userName,
    };

    const descriptors = previewRefsForCurrentChat(genContext, overrideForPreview);
    if (!descriptors.length) {
        body.innerHTML = '<small class="uris-refs-empty">Референсы не отправятся: ' +
            (mode === 'never' ? 'режим «Никогда».' : (isOverrideOn ? 'override отключил все.' : 'нет совпадений.')) +
            '</small>';
        if (cap) cap.hidden = true;
    } else {
        body.innerHTML = descriptors.map(d => refDescriptorChip(d)).join('');
    }

    // Cap: char+user слоты + extras. MAX_REFS=4.
    if (cap) {
        const slotCount = descriptors.filter(d => d.role === 'char' || d.role === 'user').length;
        const extrasTotal = chatRefs.extraRefIds.length;
        if (slotCount + extrasTotal > 4 && descriptors.length === 4) {
            cap.hidden = false;
            cap.textContent = '⚠️ Лимит 4 референса. Останутся первые, остальные будут отброшены.';
        } else {
            cap.hidden = true;
        }
    }

    if (isOverrideOn) {
        const overrideControlsHost = body.querySelector('#urisOverrideControls') || (() => {
            const div = document.createElement('div');
            div.id = 'urisOverrideControls';
            div.className = 'uris-override-controls';
            body.appendChild(div);
            return div;
        })();
        overrideControlsHost.innerHTML = buildOverrideControls();
        bindOverrideControls(root);
    } else {
        const oc = body.querySelector('#urisOverrideControls');
        if (oc) oc.remove();
    }

    // Предупреждение о несовместимости image-провайдера.
    if (descriptors.length) {
        const activeConnId = state.activeImageProfileId;
        if (activeConnId) {
            try {
                const conn = await getConnection(activeConnId);
                if (conn) {
                    const apiType = conn.apiType === 'auto' ? resolveApiType(conn.endpoint, conn.model) : conn.apiType;
                    const provider = apiType === 'openai' ? 'openai-like' : apiType;
                    const capObj = REF_CAPABILITIES[provider];
                    const strategy = capObj ? capObj.strategies.find(s => capObj.supportsStrategy(s, conn.model)) : null;
                    if (!strategy) {
                        cap.hidden = false;
                        cap.textContent = `⚠️ Активный image-провайдер (${apiType} / ${conn.model || ''}) не поддерживает референсы — они не будут отправлены.`;
                    }
                }
            } catch { /* ignore */ }
        }
    }
}
```

- [ ] **Step 4: refDescriptorChip — добавить preview для pinned/npc**

Заменить функцию `refDescriptorChip` (строки 707-725) на версию, показывающую миниатюру для pinned/ref с imagePath:

```js
function refDescriptorChip(d) {
    const label = d.role === 'char' ? '{{char}}' : (d.role === 'user' ? '{{user}}' : escapeHtml(d.name || 'NPC'));
    let thumb = '';
    if (d.imagePath) {
        // pinned char/user или npc — есть imagePath.
        thumb = `<img src="${escapeHtml(d.imagePath)}" alt="${escapeHtml(d.name || '')}">`;
    } else if (d.role === 'char') {
        thumb = `<span class="uris-ref-chip-icon"><i class="fa-solid fa-user-astronaut"></i></span>`;
    } else if (d.role === 'user') {
        thumb = `<span class="uris-ref-chip-icon"><i class="fa-solid fa-user"></i></span>`;
    }
    return `<div class="uris-ref-chip-preview" title="${escapeHtml(label)}">
        ${thumb}
        <span class="uris-ref-role">${d.role}</span>
    </div>`;
}
```

- [ ] **Step 5: buildOverrideControls — переписать без charAvatarIds**

Заменить `buildOverrideControls` (строки 732-765) на версию из спеки §5 (без аргумента profile, читает getChatRefs + getRefSync):

```js
function buildOverrideControls() {
    const o = state.refsOverride || {};
    const chatRefs = getChatRefs();
    const parts = [];
    // char toggle
    if (!(o.includeChar === false)) {
        const on = o.includeChar !== false;
        parts.push(`<label class="checkbox_label uris-ov-char"><input type="checkbox" data-ref="char" ${on ? 'checked' : ''}><span>{{char}}</span></label>`);
    }
    // user toggle
    if (!(o.includeUser === false)) {
        const on = o.includeUser !== false;
        parts.push(`<label class="checkbox_label uris-ov-user"><input type="checkbox" data-ref="user" ${on ? 'checked' : ''}><span>{{user}}</span></label>`);
    }
    // extras чипы
    for (const refId of chatRefs.extraRefIds) {
        const ref = getRefSync(refId);
        if (!ref) continue;
        const on = o.extraEnabled && typeof o.extraEnabled[refId] === 'boolean' ? o.extraEnabled[refId] : true;
        parts.push(`<span class="uris-ov-npc-chip ${on ? 'uris-npc-chip-on' : ''}" data-ref-id="${escapeHtml(refId)}" role="button" tabindex="0" title="${escapeHtml(ref.name)}">${escapeHtml(ref.name)}</span>`);
    }
    return parts.join('');
}
```

- [ ] **Step 6: bindOverrideControls — переписать под новые контролы**

Заменить `bindOverrideControls` (строки 772-815):

```js
function bindOverrideControls(root) {
    const host = root.querySelector('#urisOverrideControls');
    if (!host || !state.refsOverride) return;
    const reRender = () => renderRefsStatus(root);

    // char toggle
    host.querySelector('[data-ref="char"]')?.addEventListener('change', (e) => {
        state.refsOverride.includeChar = !!e.target.checked;
        reRender();
    });
    // user toggle
    host.querySelector('[data-ref="user"]')?.addEventListener('change', (e) => {
        state.refsOverride.includeUser = !!e.target.checked;
        reRender();
    });
    // extras чипы
    host.querySelectorAll('.uris-ov-npc-chip').forEach(chip => {
        const refId = chip.dataset.refId;
        const toggle = () => {
            if (!state.refsOverride.extraEnabled) state.refsOverride.extraEnabled = {};
            state.refsOverride.extraEnabled[refId] = !state.refsOverride.extraEnabled[refId];
            reRender();
        };
        chip.addEventListener('click', toggle);
        chip.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
    });
}
```

- [ ] **Step 7: bindRefsStatus — initOverride вместо initOverrideFromProfile**

В `bindRefsStatus` (строки 822-848), заменить строку:

```js
                const profile = await getActiveReferencesProfile();
                state.refsOverride = initOverrideFromProfile(profile);
```

на:

```js
                state.refsOverride = initOverride();
```

(убрать fetch профиля и аргумент).

- [ ] **Step 8: Verify syntax**

Run: `node --check src/ui/tab-generate.js`
Expected: нет вывода.

- [ ] **Step 9: Commit**

```bash
git add src/ui/tab-generate.js
git commit -m "refactor(refs): rewrite tab-generate refs status/override for chat-scoped model"
```

---

## Task 11: tab-gallery.js — saveRef → pool, rebuildRefs → pool

**Files:**
- Modify: `src/ui/tab-gallery.js:13` (импорт), `src/ui/tab-gallery.js:166-204` (saveRef), `src/ui/tab-gallery.js:254-280` (rebuildRefsFromSnapshot)

**Спека:** §7 (tab-gallery.js).

- [ ] **Step 1: Заменить импорт**

В `src/ui/tab-gallery.js` строка 13, заменить:

```js
import { getActiveReferencesProfile, addNpcReference, updateNpcReference } from '../references-profiles.js';
```

на:

```js
import { createRef, listRefs, updateRef } from '../refs-library.js';
```

- [ ] **Step 2: saveRef — переписать под пул**

В `src/ui/tab-gallery.js`, заменить обработчик `[data-act="saveRef"]` (строки 166-204). Новая логика: галерея-картинка → upload → выбор «новый/заменить» → createRef или updateRef в пул. Прочитай спеку §7.

```js
        // v3-redesign: сохранить картинку галереи в общий пул референсов.
        cardEl.querySelector('[data-act="saveRef"]')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            const it = items.find(x => x.id === id);
            if (!it) return;
            try {
                const createNew = await showConfirmModal(
                    'Сохранить картинку в пул референсов?\n\n' +
                    '«OK» — создать новый референс.\n' +
                    '«Отмена» — заменить изображение в существующем.'
                );
                if (createNew) {
                    const name = await showInputModal('Имя референса:', 'Из галереи');
                    if (!name) return;
                    const imagePath = await uploadEntryAsRef(it);
                    await createRef({ name, imagePath, keywords: name });
                    toastr?.success('Референс создан: ' + name);
                } else {
                    const refs = await listRefs();
                    if (!refs.length) {
                        toastr?.info('Пул пуст. Создайте через «OK».');
                        return;
                    }
                    const chosen = await showRefPicker('Выберите референс для замены изображения:', refs);
                    if (!chosen) return;
                    const imagePath = await uploadEntryAsRef(it);
                    await updateRef(chosen, { imagePath });
                    toastr?.success('Изображение обновлено');
                }
                refreshActive();
            } catch (err) {
                log('saveRef error:', err.message);
                toastr?.error('Не удалось сохранить: ' + err.message);
            }
        });
```

- [ ] **Step 3: showRefPicker — заменить showNpcPicker**

Заменить функцию `showNpcPicker` (строки ~208-225) на `showRefPicker` (тот же popup-паттерн, но по пулу):

```js
async function showRefPicker(title, refs) {
    const ctx = getCtx();
    if (!ctx.callGenericPopup || !ctx.POPUP_TYPE) return null;
    const customButtons = refs.map(r => ({ text: r.name || '?' }));
    const res = await ctx.callGenericPopup(
        title,
        ctx.POPUP_TYPE.TEXT,
        '',
        { okButton: 'Отмена', cancelButton: 'Отмена', customButtons },
    );
    if (res == null || res === ctx.POPUP_RESULT?.NEGATIVE || res === ctx.POPUP_RESULT?.CANCELLED) return null;
    const c1 = ctx.POPUP_RESULT?.CUSTOM1;
    if (c1 != null && typeof res === 'number' && res >= c1 && res <= ctx.POPUP_RESULT.CUSTOM9) {
        return refs[res - c1]?.id || null;
    }
    return null;
}
```

- [ ] **Step 4: rebuildRefsFromSnapshot — искать в пуле**

Заменить `rebuildRefsFromSnapshot` (строки 254-280):

```js
/**
 * Восстановить массив {image, role, name} из снапшота {role, name}.
 * Для npc: найти imagePath в пуле по имени. Для char/user: live-fetch.
 */
async function rebuildRefsFromSnapshot(snapshot) {
    const poolRefs = await listRefs();
    const out = [];
    for (const d of snapshot) {
        let dataUrl = null;
        try {
            if (d.role === 'char') {
                dataUrl = await getCharacterAvatarDataUrl();
            } else if (d.role === 'user') {
                // user-avatar: эвристика persona name (как в refs-library).
                const uav = getCtx().name1 || '';
                if (uav) dataUrl = await getUserAvatarDataUrl(uav);
            } else {
                // npc: поиск в пуле по имени.
                const ref = poolRefs.find(r => r.name === d.name && r.imagePath);
                if (ref) dataUrl = await imageToDataUrl(ref.imagePath);
            }
        } catch { /* ignore */ }
        if (dataUrl) out.push({ image: dataUrl, role: d.role, name: d.name || '' });
    }
    return out;
}
```

- [ ] **Step 5: Verify syntax**

Run: `node --check src/ui/tab-gallery.js`
Expected: нет вывода.

- [ ] **Step 6: Commit**

```bash
git add src/ui/tab-gallery.js
git commit -m "refactor(refs): tab-gallery saveRef creates pool ref, rebuildRefs searches pool"
```

---

## Task 12: tab-profiles.js — убрать refs-лейбл бандла

**Files:**
- Modify: `src/ui/tab-profiles.js:12` (импорт), `src/ui/tab-profiles.js:60` (refsName), `src/ui/tab-profiles.js:75-88` (bundleCard)

**Спека:** §8 (tab-profiles.js).

- [ ] **Step 1: Убрать импорт getReferencesProfile**

В `src/ui/tab-profiles.js` строка 12, удалить:

```js
import { getReferencesProfile } from '../references-profiles.js';
```

- [ ] **Step 2: Убрать refsName из цикла**

В `src/ui/tab-profiles.js` строки 58-62, заменить:

```js
    for (const b of arr) {
        const imgName = b.imageProfileId ? (await getConnection(b.imageProfileId))?.name : null;
        const refsName = b.referencesProfileId ? (await getReferencesProfile(b.referencesProfileId))?.name : null;
        cards.push(bundleCard(b, imgName, refsName));
    }
```

на:

```js
    for (const b of arr) {
        const imgName = b.imageProfileId ? (await getConnection(b.imageProfileId))?.name : null;
        cards.push(bundleCard(b, imgName));
    }
```

- [ ] **Step 3: bundleCard — убрать refsName параметр и строку**

В `src/ui/tab-profiles.js`, заменить сигнатуру `function bundleCard(b, imgName, refsName)` и строку Refs-лейбла:

```js
function bundleCard(b, imgName) {
    const active = b.id === state.activeBundleId;
    const label = (name) => name ? escapeHtml(name) : '—';
    return `<div class="uris-preset-card ${active ? 'uris-card-active' : ''}" data-id="${b.id}">
        <div class="uris-row"><label>Имя</label><input class="text_pole uris-name" value="${escapeHtml(b.name)}" placeholder="Название бандла"></div>
        <div class="uris-row"><label>Image</label><span class="uris-readonly">${label(imgName)}</span></div>
        <div class="uris-row"><label>Refs</label><span class="uris-readonly">по чату</span></div>
        <div class="uris-row"><label>Stage1</label><span class="uris-readonly">${b.stage1Mode || 'manual'}</span></div>
        <div class="uris-row"><label>Stage2</label><span class="uris-readonly">${b.stage2Mode || 'manual'}</span></div>
        <div class="uris-row">
            <button class="menu_button uris-apply" title="Применить к этому чату"><i class="fa-solid fa-check"></i> Применить</button>
            <button class="menu_button uris-del"><i class="fa-solid fa-trash"></i> Удалить</button>
        </div>
    </div>`;
}
```

- [ ] **Step 4: Verify syntax**

Run: `node --check src/ui/tab-profiles.js`
Expected: нет вывода.

- [ ] **Step 5: Commit**

```bash
git add src/ui/tab-profiles.js
git commit -m "refactor(refs): tab-profiles drops refs-profile label from bundle card"
```

---

## Task 13: events.js — refreshPoolCache в CHAT_CHANGED

**Files:**
- Modify: `src/events.js:11` (импорт), `src/events.js:70-80` (CHAT_CHANGED handler)

- [ ] **Step 1: Добавить импорт refreshPoolCache**

В `src/events.js` строка 11 (после импорта applyBindingForCurrentChat), добавить:

```js
import { applyBindingForCurrentChat } from './chat-binding.js';
import { refreshPoolCache } from './refs-library.js';
```

- [ ] **Step 2: CHAT_CHANGED — refreshPoolCache после applyBinding**

В `src/events.js`, в обработчике `_onChatChanged` (строки 72-80), обновить строку с applyBindingForCurrentChat, добавив refreshPoolCache. Текущая строка ~80:

```js
        applyBindingForCurrentChat().catch(e => error('CHAT_CHANGED: applyBindingForCurrentChat:', e.message));
```

заменить на:

```js
        applyBindingForCurrentChat()
            .then(() => refreshPoolCache())
            .catch(e => error('CHAT_CHANGED: applyBindingForCurrentChat:', e.message));
```

> Примечание: `applyBindingForCurrentChat` уже вызывает `refreshPoolCache` внутри (Task 7 Step 5), но здесь добавляем safety-net для случая, когда CHAT_CHANGED срабатывает без full apply. Если `applyBindingForCurrentChat` всегда отрабатывает — этот дублирующий вызов безвреден (idempotent).

- [ ] **Step 3: Verify syntax**

Run: `node --check src/events.js`
Expected: нет вывода.

- [ ] **Step 4: Commit**

```bash
git add src/events.js
git commit -m "refactor(refs): refresh pool cache on CHAT_CHANGED"
```

---

## Task 14: tab-references.js — полная переделка

**Files:**
- Rewrite: `src/ui/tab-references.js` (полностью новый контент)

**Спека:** §6 (tab-references.js) — полностью. Это самая большая задача. Прочитай спеку §6 целиком перед началом.

- [ ] **Step 1: Переписать tab-references.js целиком**

Заменить всё содержимое `src/ui/tab-references.js` новым модулем. Структура (по спеке §6): `render` (две секции), `renderChatSection` (слоты {{char}}/{{user}}, mode, extras), `renderPoolSection` (папки + сетка), `showPoolPicker` (overlay), обработчики.

Полный код ниже. Это ~350 строк — прочитай спеку §6 для концепции, здесь — рабочая реализация:

```js
// @ts-check
/**
 * Вкладка «Референсы»: привязка по чату (слоты {{char}}/{{user}}, extras)
 * + глобальная библиотека референсов с папками.
 * v3-redesign: заменяет профиль-модель на пул + chat-binding.
 */
import { state, getCtx, escapeHtml, showConfirmModal, showInputModal, log } from '../core.js';
import {
    listRefs, getRef, createRef, updateRef, deleteRef,
    listFolders, createFolder, renameFolder, deleteFolder,
    getChatRefs, saveChatRefs, refreshPoolCache, getRefSync,
} from '../refs-library.js';
import { compressDataUrl, uploadReferenceImage } from '../references.js';
import { refreshActive } from './tabs.js';

let _activeFolderFilter = 'all'; // 'all' | 'none' | folderId

export function render(root) {
    root.innerHTML = `
        <div class="uris-references">
            <div class="uris-refs-chat" id="urisRefsChat"></div>
            <div class="uris-refs-pool" id="urisRefsPool"></div>
        </div>`;
    renderChatSection(root);
    renderPoolSection(root);
}

// ── Секция «Текущий чат» ──

async function renderChatSection(root) {
    const host = root.querySelector('#urisRefsChat');
    if (!host) return;
    const chatRefs = getChatRefs();
    const charSlot = chatRefs.charSlot;
    const userSlot = chatRefs.userSlot;

    host.innerHTML = `
        <h4>Текущий чат</h4>
        <div class="uris-slot-row">
            <span class="uris-slot-label">{{char}}</span>
            ${slotSelect('char', charSlot)}
            <span class="uris-slot-preview" id="urisCharPreview">${slotPreview(charSlot)}</span>
            <button class="menu_button uris-slot-pick" data-slot="char">Из пула</button>
        </div>
        <div class="uris-slot-row">
            <span class="uris-slot-label">{{user}}</span>
            ${slotSelect('user', userSlot)}
            <span class="uris-slot-preview" id="urisUserPreview">${slotPreview(userSlot)}</span>
            <button class="menu_button uris-slot-pick" data-slot="user">Из пула</button>
        </div>
        <div class="uris-row"><label>Режим</label>
            <select class="text_pole uris-chat-mode">
                <option value="never" ${chatRefs.mode === 'never' ? 'selected' : ''}>Никогда</option>
                <option value="smart" ${chatRefs.mode === 'smart' ? 'selected' : ''}>Умный (extras по упоминанию)</option>
                <option value="always" ${chatRefs.mode === 'always' ? 'selected' : ''}>Всегда</option>
            </select></div>
        <div class="uris-chat-extras">
            <label>Закреплённые рефы (extras)</label>
            <button class="menu_button uris-add-extra"><i class="fa-solid fa-plus"></i> Добавить из пула</button>
            <div class="uris-extras-list" id="urisExtrasList">${extrasHtml(chatRefs.extraRefIds)}</div>
        </div>`;

    // mode change
    host.querySelector('.uris-chat-mode')?.addEventListener('change', (e) => {
        saveChatRefs({ mode: e.target.value });
        refreshActive();
    });

    // slot select change (auto/pinned toggle — без выбора конкретного ref)
    host.querySelectorAll('.uris-slot-select').forEach(sel => {
        sel.addEventListener('change', async (e) => {
            const slot = e.target.dataset.slot;
            const val = e.target.value; // 'auto' | 'pinned'
            if (val === 'auto') {
                saveChatRefs({ [slot === 'char' ? 'charSlot' : 'userSlot']: { type: 'auto' } });
                refreshActive();
            }
            // 'pinned' обрабатывается кнопкой «Из пула» (с выбором ref)
        });
    });

    // «Из пула» — открыть picker, выбрать ref, установить pinned
    host.querySelectorAll('.uris-slot-pick').forEach(btn => {
        btn.addEventListener('click', async () => {
            const slot = btn.dataset.slot;
            const refId = await showPoolPicker({
                title: `Выберите референс для {{${slot}}}`,
                multi: false,
                excludeIds: [],
            });
            if (!refId) return;
            const slotKey = slot === 'char' ? 'charSlot' : 'userSlot';
            saveChatRefs({ [slotKey]: { type: 'pinned', refId } });
            refreshActive();
        });
    });

    // extras: add
    host.querySelector('.uris-add-extra')?.addEventListener('click', async () => {
        const current = getChatRefs().extraRefIds;
        const chosen = await showPoolPicker({
            title: 'Добавить закреплённые рефы',
            multi: true,
            excludeIds: current,
        });
        if (chosen && chosen.length) {
            saveChatRefs({ extraRefIds: [...current, ...chosen] });
            refreshActive();
        }
    });

    // extras: remove / reorder
    bindExtrasList(host);
}

function slotSelect(slot, slotState) {
    const isPinned = slotState.type === 'pinned';
    const refName = isPinned ? (getRefSync(slotState.refId)?.name || '?') : '';
    return `<select class="text_pole uris-slot-select" data-slot="${slot}">
        <option value="auto" ${!isPinned ? 'selected' : ''}>Auto (из ST)</option>
        <option value="pinned" ${isPinned ? 'selected' : ''}>${isPinned ? escapeHtml(refName) : 'Из пула'}</option>
    </select>`;
}

function slotPreview(slotState) {
    if (slotState.type === 'pinned') {
        const ref = getRefSync(slotState.refId);
        if (ref?.imagePath) return `<img src="${escapeHtml(ref.imagePath)}" alt="">`;
        return '<span class="uris-slot-preview-empty">?</span>';
    }
    return '<span class="uris-slot-preview-empty"><i class="fa-solid fa-robot"></i></span>';
}

function extrasHtml(extraRefIds) {
    if (!extraRefIds.length) return '<small class="uris-refs-empty">Нет закреплённых рефов</small>';
    return extraRefIds.map(id => {
        const ref = getRefSync(id);
        if (!ref) return '';
        return `<div class="uris-extra-chip" data-ref-id="${escapeHtml(id)}">
            <img src="${escapeHtml(ref.imagePath)}" alt="${escapeHtml(ref.name)}">
            <span class="uris-extra-name">${escapeHtml(ref.name)}</span>
            <button class="uris-extra-del" title="Убрать"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
    }).join('');
}

function bindExtrasList(host) {
    host.querySelectorAll('.uris-extra-chip').forEach(chip => {
        const refId = chip.dataset.refId;
        chip.querySelector('.uris-extra-del')?.addEventListener('click', () => {
            const current = getChatRefs().extraRefIds;
            saveChatRefs({ extraRefIds: current.filter(id => id !== refId) });
            refreshActive();
        });
    });
}

// ── Секция «Библиотека» (пул) ──

async function renderPoolSection(root) {
    const host = root.querySelector('#urisRefsPool');
    if (!host) return;
    const folders = await listFolders();
    const refs = await listRefs();
    const folderChips = folderChipsHtml(folders);
    const grid = poolGridHtml(refs);
    host.innerHTML = `
        <h4>Библиотека референсов</h4>
        <div class="uris-folder-chips">
            ${folderChips}
            <button class="menu_button uris-add-folder" title="Новая папка"><i class="fa-solid fa-folder-plus"></i></button>
            <button class="menu_button uris-add-ref" title="Добавить референс"><i class="fa-solid fa-plus"></i> Референс</button>
            <input type="file" class="uris-ref-file" accept="image/*" style="display:none">
        </div>
        <div class="uris-pool-grid">${grid}</div>`;

    // folder filter
    host.querySelectorAll('.uris-folder-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            _activeFolderFilter = chip.dataset.folder;
            renderPoolSection(root);
        });
    });

    // add folder
    host.querySelector('.uris-add-folder')?.addEventListener('click', async () => {
        const name = await showInputModal('Имя папки:', 'Новая папка');
        if (!name) return;
        await createFolder(name);
        refreshActive();
    });

    // add ref
    host.querySelector('.uris-add-ref')?.addEventListener('click', () => {
        host.querySelector('.uris-ref-file')?.click();
    });
    host.querySelector('.uris-ref-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const dataUrl = await readFileAsDataUrl(file);
            const compressed = await compressDataUrl(dataUrl);
            const path = await uploadReferenceImage(compressed.dataUrl, `ref_${Date.now()}`);
            const name = await showInputModal('Имя референса:', file.name.replace(/\.[^.]+$/, ''));
            if (!name) return;
            const folderId = _activeFolderFilter !== 'all' && _activeFolderFilter !== 'none' ? _activeFolderFilter : null;
            await createRef({ name, imagePath: path, keywords: name, folderId });
            refreshActive();
        } catch (err) {
            log('Ошибка добавления референса:', err.message);
            toastr?.error?.('Не удалось добавить референс');
        }
        e.target.value = '';
    });

    // tile click = edit
    bindPoolTiles(host, root);
}

function folderChipsHtml(folders) {
    const chip = (folder, label) =>
        `<span class="uris-folder-chip ${_activeFolderFilter === folder ? 'uris-folder-chip-on' : ''}" data-folder="${folder}">${escapeHtml(label)}</span>`;
    let html = chip('all', 'Все') + chip('none', 'Без папки');
    for (const f of folders) {
        html += chip(f.id, f.name);
    }
    return html;
}

function poolGridHtml(refs) {
    const filtered = refs.filter(r => {
        if (_activeFolderFilter === 'all') return true;
        if (_activeFolderFilter === 'none') return !r.folderId;
        return r.folderId === _activeFolderFilter;
    });
    if (!filtered.length) return '<small class="uris-refs-empty">Пусто. Добавьте референс кнопкой «+».</small>';
    return filtered.map(r => `
        <div class="uris-pool-tile" data-ref-id="${escapeHtml(r.id)}">
            <img src="${escapeHtml(r.imagePath)}" alt="${escapeHtml(r.name)}">
            <div class="uris-pool-tile-name">${escapeHtml(r.name)}</div>
        </div>`).join('');
}

function bindPoolTiles(host, root) {
    host.querySelectorAll('.uris-pool-tile').forEach(tile => {
        tile.addEventListener('click', async () => {
            const refId = tile.dataset.refId;
            await openRefEditor(refId, root);
        });
    });
}

async function openRefEditor(refId, root) {
    const ref = await getRef(refId);
    if (!ref) return;
    const folders = await listFolders();
    const folderOptions = '<option value="" ' + (!ref.folderId ? 'selected' : '') + '>Без папки</option>' +
        folders.map(f => `<option value="${f.id}" ${ref.folderId === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('');
    const keywordsStr = (ref.keywords || []).join(', ');

    const overlay = document.createElement('div');
    overlay.className = 'uris-picker-overlay';
    overlay.innerHTML = `
        <div class="uris-picker-dialog uris-ref-editor">
            <h4>${escapeHtml(ref.name)}</h4>
            <img src="${escapeHtml(ref.imagePath)}" class="uris-editor-preview" alt="">
            <div class="uris-row"><label>Имя</label><input class="text_pole uris-ed-name" value="${escapeHtml(ref.name)}"></div>
            <div class="uris-row"><label>Keywords</label><input class="text_pole uris-ed-keywords" value="${escapeHtml(keywordsStr)}" placeholder="через запятую"></div>
            <div class="uris-row"><label>Папка</label><select class="text_pole uris-ed-folder">${folderOptions}</select></div>
            <div class="uris-editor-actions">
                <button class="menu_button uris-ed-replace"><i class="fa-solid fa-image"></i> Заменить картинку</button>
                <input type="file" class="uris-ed-file" accept="image/*" style="display:none">
                <button class="menu_button redText uris-ed-del"><i class="fa-solid fa-trash"></i> Удалить</button>
                <button class="menu_button uris-ed-close">Закрыть</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const nameInput = overlay.querySelector('.uris-ed-name');
    const kwInput = overlay.querySelector('.uris-ed-keywords');
    const folderSel = overlay.querySelector('.uris-ed-folder');
    const save = async () => {
        await updateRef(refId, {
            name: nameInput.value,
            keywords: kwInput.value,
            folderId: folderSel.value || null,
        });
    };
    nameInput.addEventListener('change', save);
    kwInput.addEventListener('change', save);
    folderSel.addEventListener('change', save);

    // replace image
    overlay.querySelector('.uris-ed-replace')?.addEventListener('click', () => {
        overlay.querySelector('.uris-ed-file')?.click();
    });
    overlay.querySelector('.uris-ed-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const dataUrl = await readFileAsDataUrl(file);
            const compressed = await compressDataUrl(dataUrl);
            const path = await uploadReferenceImage(compressed.dataUrl, `ref_${refId}`);
            await updateRef(refId, { imagePath: path });
            const img = overlay.querySelector('.uris-editor-preview');
            if (img) img.src = path + '?t=' + Date.now();
        } catch (err) {
            toastr?.error?.('Не удалось заменить: ' + err.message);
        }
        e.target.value = '';
    });

    // delete
    overlay.querySelector('.uris-ed-del')?.addEventListener('click', async () => {
        if (await showConfirmModal('Удалить референс из пула?')) {
            await deleteRef(refId);
            overlay.remove();
            refreshActive();
        }
    });

    // close
    overlay.querySelector('.uris-ed-close')?.addEventListener('click', () => {
        overlay.remove();
        renderPoolSection(root);
    });
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { overlay.remove(); renderPoolSection(root); }
    });
}

// ── Pool picker overlay (multi/single) ──

async function showPoolPicker({ title = 'Выберите референсы', multi = true, excludeIds = [] } = {}) {
    const refs = (await listRefs()).filter(r => r.imagePath && !excludeIds.includes(r.id));
    if (!refs.length) {
        toastr?.info('Пул пуст. Добавьте референсы в библиотеку.');
        return multi ? [] : null;
    }
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'uris-picker-overlay';
        const selected = new Set();
        overlay.innerHTML = `
            <div class="uris-picker-dialog">
                <h4>${escapeHtml(title)}</h4>
                <div class="uris-pool-grid uris-picker-grid">
                    ${refs.map(r => `<div class="uris-pool-tile uris-pick-tile" data-ref-id="${escapeHtml(r.id)}">
                        <img src="${escapeHtml(r.imagePath)}" alt="${escapeHtml(r.name)}">
                        <div class="uris-pool-tile-name">${escapeHtml(r.name)}</div>
                    </div>`).join('')}
                </div>
                <div class="uris-picker-actions">
                    <button class="menu_button uris-pick-cancel">Отмена</button>
                    <button class="menu_button uris-pick-ok">Готово</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        overlay.querySelectorAll('.uris-pick-tile').forEach(tile => {
            tile.addEventListener('click', () => {
                const id = tile.dataset.refId;
                if (multi) {
                    if (selected.has(id)) { selected.delete(id); tile.classList.remove('uris-pick-selected'); }
                    else { selected.add(id); tile.classList.add('uris-pick-selected'); }
                } else {
                    // single: сразу закрываем
                    overlay.remove();
                    resolve(id);
                }
            });
        });
        overlay.querySelector('.uris-pick-cancel')?.addEventListener('click', () => { overlay.remove(); resolve(multi ? [] : null); });
        overlay.querySelector('.uris-pick-ok')?.addEventListener('click', () => { overlay.remove(); resolve([...selected]); });
    });
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(file);
    });
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check src/ui/tab-references.js`
Expected: нет вывода.

- [ ] **Step 3: Commit**

```bash
git add src/ui/tab-references.js
git commit -m "feat(refs): rewrite tab-references for chat slots + pool library with folders"
```

---

## Task 15: style.css — удалить V3, добавить новые классы

**Files:**
- Modify: `style.css`

**Спека:** §CSS.

- [ ] **Step 1: Удалить устаревшие V3-классы**

В `style.css`, найти и удалить правила для классов (если они есть — добавлены в Phase 3):
- `.uris-char-section`, `.uris-char-chips`, `.uris-char-chip`, `.uris-char-chip-on`
- `.uris-ov-char-section`, `.uris-ov-char-chips`, `.uris-ov-char-chip`
- `.uris-npc-bound-badge`, `.uris-npc-bind`, `.uris-npc-sync`
- `.uris-refs-mode-warning`
- `button[data-act="saveRef"]` (правило цвета V3.3)

Поиск через grep в файле, удалить каждый блок целиком (от селектора до закрывающей `}`).

- [ ] **Step 2: Добавить новые классы**

В конец `style.css`, добавить точно по спеке §CSS:

```css
/* ── v3-redesign: референсы по чату + пул ── */

/* Секция «Текущий чат» */
.uris-refs-chat {
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 8px;
    padding: 10px;
    margin-bottom: 12px;
}
.uris-slot-row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 0; flex-wrap: wrap;
}
.uris-slot-label {
    font-weight: 600; min-width: 60px;
}
.uris-slot-preview {
    width: 40px; height: 40px; border-radius: 6px;
    object-fit: cover; background: rgba(255,255,255,.08);
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
}
.uris-slot-preview img { width: 100%; height: 100%; object-fit: cover; }
.uris-slot-preview-empty {
    display: flex; align-items: center; justify-content: center;
    width: 100%; height: 100%; opacity: .5;
}

/* Extras chips */
.uris-extras-list {
    display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;
}
.uris-extra-chip {
    position: relative; border-radius: 6px; overflow: hidden;
    border: 1px solid var(--SmartThemeBorderColor);
}
.uris-extra-chip img { width: 56px; height: 56px; object-fit: cover; display: block; }
.uris-extra-name {
    font-size: 10px; padding: 2px; text-align: center;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.uris-extra-del {
    position: absolute; top: 2px; right: 2px;
    background: rgba(0,0,0,.6); border: none; color: #fff;
    width: 18px; height: 18px; border-radius: 50%; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 10px;
}

/* Секция «Библиотека» */
.uris-folder-chips {
    display: flex; flex-wrap: wrap; gap: 6px;
    margin-bottom: 10px; align-items: center;
}
.uris-folder-chip {
    padding: 4px 10px; border-radius: 12px;
    background: rgba(255,255,255,.08); cursor: pointer;
    font-size: 12px; user-select: none; border: 1px solid transparent;
}
.uris-folder-chip.uris-folder-chip-on {
    background: var(--SmartThemeQuoteColor, #4a5); color: #fff;
}
.uris-pool-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
    gap: 8px;
}
.uris-pool-tile {
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 8px; overflow: hidden; cursor: pointer;
    background: rgba(0,0,0,.2);
}
.uris-pool-tile:hover { border-color: var(--SmartThemeQuoteColor, #4a5); }
.uris-pool-tile img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
.uris-pool-tile-name {
    font-size: 11px; padding: 4px; text-align: center;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.uris-pick-selected {
    outline: 3px solid var(--SmartThemeQuoteColor, #4a5);
    outline-offset: -3px;
}

/* Picker overlay */
.uris-picker-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.6);
    display: flex; align-items: center; justify-content: center;
    z-index: 100000;
}
.uris-picker-dialog {
    background: var(--SmartThemeBlurTintColor, #1a1a2e);
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 10px; padding: 16px;
    max-width: 720px; width: 90%; max-height: 80vh; overflow: auto;
}
.uris-picker-dialog h4 { margin-top: 0; }
.uris-pool-grid.uris-picker-grid {
    max-height: 55vh; overflow-y: auto; margin-bottom: 12px;
}
.uris-picker-actions {
    display: flex; gap: 8px; justify-content: flex-end;
}
.uris-editor-preview {
    max-width: 200px; max-height: 200px; border-radius: 8px;
    margin-bottom: 12px;
}
.uris-editor-actions {
    display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px;
}
```

- [ ] **Step 3: Commit**

```bash
git add style.css
git commit -m "style(refs): remove V3 classes, add chat-slots + pool + picker styles"
```

---

## Task 16: Удалить старый модуль и тесты, обновить шапку references.js

**Files:**
- Delete: `src/references-profiles.js`
- Delete: `tests/references-profiles.test.js`
- Modify: `src/references.js:5-7` (комментарий)

- [ ] **Step 1: Удалить references-profiles.js**

```bash
git rm src/references-profiles.js
```

- [ ] **Step 2: Удалить tests/references-profiles.test.js**

```bash
git rm tests/references-profiles.test.js
```

- [ ] **Step 3: Обновить комментарий в references.js**

В `src/references.js` строки 4-7, заменить:

```js
/**
 * Сбор аватаров {{char}}/{{user}} как dataUrl для image-to-image.
 * v2: упрощён — только общие утилиты.
 * collectReferences и buildReferenceInstruction переехали:
 *   - collectReferences → references-profiles.js
 *   - buildReferenceInstruction → providers/base.js
 */
```

на:

```js
/**
 * Утилиты изображений: аватары {{char}}/{{user}}, сжатие, загрузка на сервер.
 * collect-логика референсов — в refs-library.js (v3-redesign).
 * buildReferenceInstruction — в providers/base.js.
 */
```

- [ ] **Step 4: Verify — нет dangling imports на старый модуль**

Run: `grep -rn "references-profiles" src/ index.js`
Expected: нет вывода (все импорты перенесены).

Если есть остатки — исправить перед продолжением.

- [ ] **Step 5: Verify syntax всех изменённых файлов**

Run: `node --check src/references.js && node --check src/refs-library.js`
Expected: нет вывода.

- [ ] **Step 6: Commit**

```bash
git add src/references.js
git commit -m "refactor(refs): delete references-profiles module + tests, update references.js header"
```

---

## Task 17: Verify — полный прогон тестов и мысленная проверка

**Files:** none (verification only)

- [ ] **Step 1: Полный прогон тестов**

Run: `node --test tests/`
Expected: ВСЕ тесты PASS. Особо проверить:
- `tests/refs-library.test.js` — новый модуль, все тесты зелёные.
- `tests/references.test.js` — утилиты references.js не сломаны.
- Остальные тесты — без регрессий.

Если FAIL — отладить (использовать superpowers:systematic-debugging).

- [ ] **Step 2: node --check всех изменённых JS-файлов**

Run:
```bash
node --check src/core.js && \
node --check src/refs-library.js && \
node --check src/references.js && \
node --check src/bundles.js && \
node --check src/chat-binding.js && \
node --check src/pipeline.js && \
node --check src/events.js && \
node --check src/ui/tab-references.js && \
node --check src/ui/tab-generate.js && \
node --check src/ui/tab-gallery.js && \
node --check src/ui/tab-profiles.js && \
node --check index.js
```
Expected: нет вывода (все OK).

- [ ] **Step 3: Проверить отсутствие dangling-ссылок**

Run: `grep -rn "references-profiles\|collectReferencesFromActiveProfile\|collectReferencesFromProfile\|collectReferencesPreview\|getActiveReferencesProfile\|charAvatarIds\|addNpcReference\|updateNpcReference\|removeNpcReference\|moveNpcReference" src/ index.js`
Expected: нет вывода (все старые API заменены).

> Примечание: `charAvatar` (без Ids) может встречаться в тестах/комментариях — это ок. Проверяем именно активные call sites.

- [ ] **Step 4: Мысленный прогон сценариев**

Проработать (на бумаге/в голове):

**Сценарий 1 — новый чат, auto {{char}}:**
1. Пользователь открывает чат с Aria.
2. `applyBindingForCurrentChat` → `chatMetadata.uris_binding` без refs → `getChatRefs()` возвращает default (mode smart, charSlot/userSlot auto).
3. Генерация → `collectRefsForCurrentChat` → charSlot auto → `getCharacterAvatarDataUrl()` (Aria avatar), userSlot auto → user-avatar.
4. Результат: 2 рефа (Aria + user), без утечки рефов из других чатов. ✓

**Сценарий 2 — добавить NPC в пул и pin в чат:**
1. Вкладка Референсы → «+ Референс» → upload картинки → имя «Eva» → `createRef`.
2. В секции «Текущий чат» → «Добавить из пула» → picker → выбрать Eva → `saveChatRefs({extraRefIds:[evaId]})`.
3. Генерация (smart, пост упоминает Eva) → Eva проходит smart-фильтр → 3 рефа (Aria + user + Eva).
4. Другой чат с тем же пулом → Eva НЕ в его extras → не отправляется. ✓

**Сценарий 3 — pinned {{char}} из пула:**
1. {{char}} slot → «Из пула» → выбрать «Aria-pin» → `saveChatRefs({charSlot:{type:'pinned', refId}})`.
2. Генерация → charSlot pinned → `imageToDataUrl(ref.imagePath)`, name = «Aria-pin».
3. Не зависит от ST-аватара. ✓

**Сценарий 4 — миграция wipe:**
1. Старая установка с профилями в `LF_REFERENCES_PROFILES`.
2. Обновление extension → `init()` → `migrateWipeLegacyProfiles()` → `LF_REFERENCES_PROFILES` удалён.
3. Пул (`LF_REFS_POOL`) пуст → пользователь добавляет рефы заново. ✓

**Сценарий 5 — override per-gen:**
1. Generate-вкладка → включить Override → `initOverride()` (всё вкл).
2. Снять галку {{char}} → `state.refsOverride.includeChar = false`.
3. Генерация → char-слот пропущен. ✓

Если сценарий не сходится — отладить соответствующую функцию.

- [ ] **Step 5: Финальный commit (если были правки в отладке)**

Если в шагах 1-4 найдены и исправлены баги:

```bash
git add -A
git commit -m "fix(refs): verification fixes from scenario run"
```

Если правок не было — этот шаг пропустить.

---

## Self-Review (выполнен автором плана)

**1. Spec coverage:**
- §2.1 Pool CRUD → Task 2 ✓
- §2.2 Folders CRUD → Task 3 ✓
- §2.3 Chat binding → Task 4 ✓
- §2.4 Smart-matching → Task 5 ✓
- §2.5 _resolveRefs → Task 5 ✓
- §2.6 Кэш → Task 5 (полная версия заменяет stub из Task 2) ✓
- §2.7 Collect → Task 5 ✓
- §2.8 Wipe-миграция → Task 6 ✓
- §3 bundles/chat-binding deprecate → Task 7 ✓
- §4 pipeline → Task 8 ✓
- §5 tab-generate → Task 10 ✓
- §6 tab-references → Task 14 ✓
- §7 tab-gallery → Task 11 ✓
- §8 tab-profiles → Task 12 ✓
- §9 index.js → Task 9 ✓
- §CSS → Task 15 ✓
- events.js refreshPoolCache → Task 13 ✓ (доп. к спеке, нужен для смены чата)
- Удаление старого модуля → Task 16 ✓

**2. Placeholder scan:** Все шаги содержат конкретный код или конкретные grep/команды. Нет «TODO»/«implement later». UI-задача (Task 14) содержит полный ~350-строчный модуль.

**3. Type consistency:**
- `getRefSync` — экспортирован в Task 5 (Step 3), используется в Task 10 (tab-generate) и Task 14 (tab-references) ✓
- `collectRefsForCurrentChat` — Task 5 экспорт, Task 8 (pipeline) импорт ✓
- `previewRefsForCurrentChat` — Task 5 экспорт, Task 10 импорт ✓
- `migrateWipeLegacyProfiles` — Task 6 экспорт, Task 9 (index.js) импорт ✓
- `refreshPoolCache` — Task 5 экспорт, Tasks 7/9/13 импорт ✓
- Override struct: `{enabled, mode, includeChar, includeUser, extraEnabled}` — консистентно в refs-library (Task 5), tab-generate (Task 10) ✓ (заменил старое `charAvatarIds`/`npcEnabled`)
- Chat refs struct: `{mode, charSlot:{type,refId?}, userSlot, extraRefIds}` — консистентно в Task 4 (определение) и Tasks 10/14 (использование) ✓

**Gap found & fixed:** events.js не был в спеке, но нуждается в `refreshPoolCache` при CHAT_CHANGED (Task 13 добавлен). Без него кэш пула не обновляется при смене чата без applyBinding.
