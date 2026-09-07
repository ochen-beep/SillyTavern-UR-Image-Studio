# Референсы: глобальный пул + привязка по чату (redesign)

- **Дата**: 2026-07-14
- **Статус**: спроектирован, ожидает реализации
- **Заменяет**: `2026-07-14-phase3-references-character-binding.md` (V3.1/V3.2/V3.3) — тот план решал не ту задачу (привязка NPC к ST-карте + мульти-чар-аватары внутри глобального профиля). Корневая проблема — **утечка рефов между чатами** — осталась.
- **Объём**: breaking change модели данных; wipe старых профилей (решение пользователя).

## Контекст и проблема

В SillyTavern у каждого чата есть свой {{char}}. Пользователь хочет:
1. За каждым чатом закрепить **аватар {{char}}** (авто из ST-карты + ручная замена).
2. За каждым чатом закрепить **аватар {{user}}** (выбор).
3. Добавлять **референсы чего угодно** (NPC, локации, одежда, животные) в **общий пул** с возможностью задать имя, и при-pinить их к конкретному чату.

**Что не так сейчас.** Профили референсов (`LF_REFERENCES_PROFILES`) — глобальный массив. Внутри профиля лежат `charAvatarIds[]` (мульти-чипы ST-персонажей), `userAvatarFile`, `npcReferences[]`. Чат привязан к бандлу → бандл указывает на один профиль. Если один профиль используется в нескольких чатах с разными персонажами — в каждом чате «выезжают» рефы всех персонажей, чьи чипы когда-то включили. Phase 3 усугубил это `charAvatarIds[]` (мультивыбор глобально) и `npc.characterId`. Это и есть утечка «рефы всех {{char}} из всех чатов».

## Решения (из brainstorming-сессии)

1. **Модель**: глобальный пул + pin по чату (профили как сущность исчезают).
2. **Организация пула**: плоские папки одного уровня (реф → одна папка или «без папки»).
3. **Group-chat**: один {{char}} на чат. Каждый персонаж group-chat'а pin-ится как обычный реф из пула.
4. **{{char}}-аватар**: авто из ST (live-fetch аватара текущего ST-чара при генерации), с возможностью ручной замены на реф из пула.
5. **Smart-matching**: остаётся по keywords (как сейчас) — для доп. закреплённых рефов (NPC, локации). Pinned-слоты {{char}}/{{user}} отправляются всегда.
6. **Миграция**: стереть старые профили (`LF_REFERENCES_PROFILES`) — чистый старт пула.

## Архитектура

### Три хранилища вместо одного профиля

| Хранилище | LF-ключ / носитель | Что внутри |
|---|---|---|
| **Библиотека (пул)** | `LF_REFS_POOL = 'uris_refs_pool'` (новый) | `[{id, name, keywords[], imagePath, folderId\|null, createdAt}]` — все референсы |
| **Папки** | `LF_REFS_FOLDERS = 'uris_refs_folders'` (новый) | `[{id, name, order}]` — плоские, один уровень |
| **Привязка чата** | `chatMetadata.uris_binding.refs` (новое поле) | слоты {{char}}/{{user}} + extras для конкретного чата |

Старое `LF_REFERENCES_PROFILES` стирается при первом запуске (миграция-wipe). Бандлы поле `referencesProfileId` сохраняют в объекте, но **игнорируют** при чтении (deprecated).

### Слоты привязки чата

```
chatMetadata.uris_binding = {
  bundleId,            // (как раньше)
  overrides,           // (как раньше)
  refs: {              // НОВОЕ
    mode: 'always' | 'smart' | 'never',
    charSlot: { type: 'auto' } | { type: 'pinned', refId: string },
    userSlot: { type: 'auto' } | { type: 'pinned', refId: string },
    extraRefIds: [refId, ...]   // доп. закреплённые (NPC, локации, одежда...)
  }
}
```

- **`charSlot.type:'auto'`** → live-fetch аватара текущего ST-чара (`getCharacterAvatarDataUrl()` из `references.js`). Не плодит файлы, авто-обновляется при смене ST-аватара. Не требует кнопки «синхронизировать».
- **`charSlot.type:'pinned'`** → конкретный реф из пула.
- Симметрично для `userSlot`: `auto` = ST user-avatar, `pinned` = реф из пула.
- `extraRefIds` проходят smart-фильтр по keywords (как раньше NPC).

### Что отправляется при генерации (порядок, cap MAX_REFS=4)

1. **charSlot** (1 шт, role `char`): если `type:'auto'` → `getCharacterAvatarDataUrl()`; если `pinned` → `imageToDataUrl(ref.imagePath)`. Отправляется всегда (mode/smart не фильтруют слоты).
2. **userSlot** (1 шт, role `user`): аналогично (`getUserAvatarDataUrl` для auto).
3. **extraRefIds** по порядку (role `npc`, name = `ref.name`), с smart-фильтром по keywords, до заполнения `MAX_REFS=4`.

Pinned-слоты не фильтруются smart-режимом (они явно закреплены). Smart применяется только к `extraRefIds`.

## Сводка изменений

| Файл | Действие |
|------|----------|
| `src/refs-library.js` | **Новый**. CRUD пула + папок; smart-matching (`isNameInText` переезжает сюда); `collectRefsForCurrentChat` / `previewRefsForCurrentChat`; chat-binding读写 (`getChatRefs`/`saveChatRefs`); миграция-wipe. |
| `src/references-profiles.js` | **Удалить.** Все импорты переносятся на `refs-library.js`. |
| `src/references.js` | Без изменений (утилиты: `imageToDataUrl`, `getCharacterAvatarDataUrl`, `getUserAvatarDataUrl`, `compressDataUrl`, `uploadReferenceImage`). Только комментарий в шапке обновить. |
| `src/core.js` | Добавить `LF_REFS_POOL`, `LF_REFS_FOLDERS`. Deprecated: `state.activeReferencesProfileId` (оставить поле, не читать). Обновить комментарий refsOverride (refs.js:6). |
| `src/bundles.js` | `bundle.referencesProfileId` → deprecated (не читать, не применять в `applyBundleToState`). `persistBundleFields` игнорирует `referencesProfileId`. |
| `src/chat-binding.js` | `applyBindingForCurrentChat`: убрать override `referencesProfileId`. Chat-refs читаются напрямую из `chatMetadata` (без state-зеркала). |
| `src/pipeline.js` | `collectReferencesFromActiveProfile` → `collectRefsForCurrentChat`. `RefsOverride` typedef обновить. |
| `src/ui/tab-references.js` | **Полная переделка.** Секции «Текущий чат» (слоты) + «Библиотека» (пул с папками). |
| `src/ui/tab-generate.js` | `getActiveReferencesProfile`/`collectReferencesPreview` → новые функции; override упрощается (убрать `charAvatarIds`). |
| `src/ui/tab-gallery.js` | `saveRef` → добавить в **пул** (не в профиль). `rebuildRefsFromSnapshot` → искать imagePath в пуле по имени. |
| `src/ui/tab-profiles.js` | Убрать показ имени refs-профиля у бандла (мёртвое поле). |
| `style.css` | Новые классы: `.uris-refs-chat`, `.uris-pool-*`, `.uris-folder-chips`, `.uris-slot-*`. Удалить устаревшие V3-классы. |
| `tests/references-profiles.test.js` | **Удалить** (модуль ушёл). |
| `tests/refs-library.test.js` | **Новый.** Pool/folder CRUD, chat-refs, collect, smart-matching, wipe-миграция. |

---

## 1. `src/core.js` — новые ключи и deprecated-поля

```js
export const LF_REFS_POOL = 'uris_refs_pool';          // массив референсов (новый)
export const LF_REFS_FOLDERS = 'uris_refs_folders';    // массив папок (новый)
// LF_REFERENCES_PROFILES остаётся как константа, НО помечена deprecated и
// используется ТОЛЬКО для wipe при миграции (см. refs-library.js::migrateWipeLegacyProfiles).
```

`state.activeReferencesProfileId` — поле оставить (не ломать существующие чтения в bundles.js), но нигде не читать как источник рефов. Комментарий в шапке `references.js:6` обновить: «collect → refs-library.js».

`state.refsOverride` — структура меняется (см. §5).

---

## 2. `src/refs-library.js` — новый модуль (замена references-profiles.js)

### 2.1. Pool CRUD

```js
import { LF_REFS_POOL, LF_REFS_FOLDERS, LF_REFERENCES_PROFILES, uid, log, getCtx, state } from './core.js';
import { getCharacterAvatarDataUrl, getUserAvatarDataUrl, imageToDataUrl } from './references.js';

function lf() { return SillyTavern.libs.localforage; }

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
    return arr[i];
}

export async function deleteRef(id) {
    const arr = await listRefs();
    await _setRefs(arr.filter(r => r.id !== id));
    // Также убрать из extras всех чатов? Нет — chat binding лежит в chatMetadata
    // каждого чата, до остальных не дотянуться. Мёртвые refId фильтруются при collect.
    log('Удалён референс', id);
}
```

### 2.2. Folders CRUD

```js
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
    log('Удалена папка', id);
}
```

### 2.3. Chat binding (чтение/запись `chatMetadata.uris_binding.refs`)

```js
import { META_KEY } from './core.js';

/**
 * Дефолтная структура refs для нового чата.
 * charSlot/userSlot — auto (из ST). extras пустой. mode — 'smart' по умолчанию
 * (чтобы не заливать все extras всегда; pinned-слоты всегда идут).
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

/** Читать refs текущего чата. Если нет — default (НЕ пишет назад; ленивая запись). */
export function getChatRefs() {
    const binding = _rawBinding();
    if (!binding?.refs || typeof binding.refs !== 'object') return defaultChatRefs();
    // Нормализация/миграция полей (на случай старых/неполных структур):
    const r = binding.refs;
    return {
        mode: ['always','smart','never'].includes(r.mode) ? r.mode : 'smart',
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

### 2.4. Smart-matching (переезжает из references-profiles.js без изменений)

```js
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
```

### 2.5. Collect: какие референсы отправить (ядро, без fetch)

```js
const MAX_REFS = 4;

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
 * @property {'auto'|'pinned'} [kind]   - способ ресолва для char/user
 * @property {string} [refId]           - для pinned (id в пуле)
 * @property {string} [imagePath]       - для pinned/npc (server path)
 * @property {string} [userAvatarFile]  - зарезервировано (пока не используется)
 */

/**
 * Решить, какие референсы включаются для текущего чата. Синхронно, без fetch.
 * Читает getChatRefs() + getRef() для extras.
 *
 * @param {object} context - { chatText, instructionText, charName, userName }
 * @param {RefsOverride} [override]
 * @returns {RefDescriptor[]}
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

    // 1. char-слот (1 шт) — НЕ фильтруется smart (pinned/auto закреплены).
    const charOff = override && override.includeChar === false;
    if (!charOff) {
        const slot = chatRefs.charSlot;
        if (slot.type === 'pinned' && slot.refId) {
            const ref = poolRefSync(slot.refId);
            if (ref?.imagePath) {
                out.push({ role: 'char', name: ref.name, kind: 'pinned', refId: ref.id, imagePath: ref.imagePath });
            }
        } else {
            // auto: name = текущий ST-char (для label); imagePath нет (live-fetch).
            out.push({ role: 'char', name: charName, kind: 'auto' });
        }
    }

    // 2. user-слот (1 шт) — НЕ фильтруется smart.
    if (out.length < MAX_REFS) {
        const userOff = override && override.includeUser === false;
        if (!userOff) {
            const slot = chatRefs.userSlot;
            if (slot.type === 'pinned' && slot.refId) {
                const ref = poolRefSync(slot.refId);
                if (ref?.imagePath) {
                    out.push({ role: 'user', name: ref.name, kind: 'pinned', refId: ref.id, imagePath: ref.imagePath });
                }
            } else {
                out.push({ role: 'user', name: userName, kind: 'auto' });
            }
        }
    }

    // 3. extras — по порядку extraRefIds, с smart-фильтром.
    for (const refId of chatRefs.extraRefIds) {
        if (out.length >= MAX_REFS) break;
        const overrideEnabled = override?.extraEnabled && typeof override.extraEnabled[refId] === 'boolean'
            ? override.extraEnabled[refId] : true;
        if (!overrideEnabled) continue;
        const ref = getRefSync(refId);
        if (!ref?.imagePath) continue; // реф удалён из пула — skip
        if (smart && !refMatchesKeywords(ref, combinedText)) continue;
        out.push({ role: 'npc', name: ref.name, refId: ref.id, imagePath: ref.imagePath });
    }
    return out.slice(0, MAX_REFS);
}
```

**Важно:** `poolRefSync(id)` нужен синхронный доступ к пулу, т.к. `_resolveRefs` синхронна (для preview). Решение: **кэш пула в памяти** (`state._refsPoolCache`), обновляемый при каждом CRUD и при смене чата. См. §2.6.

### 2.6. Пул-кэш для синхронного доступа

```js
// Кэш пула в памяти: список референсов. Обновляется при CRUD и при applyBinding.
// Нужен, чтобы _resolveRefs/preview работали синхронно (без await) — как
// collectReferencesPreview раньше работал с уже загруженным профилем.
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

Каждая CRUD-функция пула (`createRef`/`updateRef`/`deleteRef`) и `deleteFolder` (меняет refs) вызывает `refreshPoolCache()` после записи. `applyBindingForCurrentChat` (chat-binding.js) тоже вызывает `refreshPoolCache()` при смене чата, чтобы кэш соответствовал текущему состоянию.

> Альтернатива без кэша: сделать `_resolveRefs` асинхронной. Но preview в Generate-вкладке сейчас синхронный по дизайну (мгновенный превью чипов), и pipeline уже async — проще сохранить синхронный preview через кэш.

### 2.7. Collect с fetch (для pipeline)

```js
/**
 * Собрать референсы для текущего чата (с fetch dataUrl) — для pipeline.
 * @param {object} context
 * @param {RefsOverride} [override]
 * @returns {Promise<Array<{image: string, role: string, name: string}>>}
 */
export async function collectRefsForCurrentChat(context = {}, override = null) {
    const descriptors = _resolveRefs(context, override);
    if (!descriptors.length) { log('Собрано референсов: 0'); return []; }
    const refs = [];
    for (const d of descriptors) {
        let dataUrl = null;
        if (d.role === 'char') {
            dataUrl = d.kind === 'pinned' ? await imageToDataUrl(d.imagePath) : await getCharacterAvatarDataUrl();
        } else if (d.role === 'user') {
            dataUrl = d.kind === 'pinned' ? await imageToDataUrl(d.imagePath) : await getUserAvatarDataUrlForCurrent();
        } else {
            dataUrl = await imageToDataUrl(d.imagePath);
        }
        if (dataUrl) refs.push({ image: dataUrl, role: d.role, name: d.name });
    }
    log(`Собрано референсов: ${refs.length}`);
    return refs.slice(0, MAX_REFS);
}

// user-avatar для auto-режима: ST хранит аватар пользователя глобально.
// getUserAvatarDataUrl(file) требует имя файла; для auto берём активный user-аватар ST.
async function getUserAvatarDataUrlForCurrent() {
    const ctx = getCtx();
    // ST: аватар текущего user-персонажа доступен через persona.
    const persona = ctx.name1 || '';
    // ST хранит user-аватары в /User Avatars/<filename>; имя файла = persona name
    // в стандартной установке. Если есть avatarFile в контексте — используем.
    const file = ctx.userAvatarFile || (persona ? persona : '');
    return file ? getUserAvatarDataUrl(file) : null;
}

export function previewRefsForCurrentChat(context = {}, override = null) {
    return _resolveRefs(context, override);
}
```

> **Примечание про user-avatar auto:** `getUserAvatarDataUrlForCurrent` — эвристика (имя файла = persona). Если ST даёт API получить активный user-avatar напрямую, использовать его. На старте проверить, что `ctx` несёт `userAvatarFile`-подобное поле; если нет — уточнить при реализации.

### 2.8. Миграция-wipe

```js
let _migrated = false;

/**
 * Одноразовая миграция: стереть старые профили референсов (LF_REFERENCES_PROFILES).
 * Решение пользователя — чистый старт пула. Идемпотентно: флаг _migrated в памяти.
 * Перезапуск окна = повторный wipe (безопасно: пул отдельный ключ, не трогаем).
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

Вызывается из `index.js` init (после `loadSettings`, до первого рендера вкладок).

---

## 3. `src/bundles.js` + `src/chat-binding.js` — deprecated referencesProfileId

### bundles.js

- `applyBundleToState`: убрать строку `state.activeReferencesProfileId = bundle.referencesProfileId;`. (Поле в бандле не читаем.)
- `persistBundleFields`: убрать обработку `referencesProfileId` (mirror + save). Если патч приходит с этим ключом — игнорировать.
- `createBundle`: поле `referencesProfileId` оставить в схеме (для существующих бандлов), но не использовать. Комментарий `// deprecated`.
- `snapshotCurrentStateToBundle`: убрать `referencesProfileId: state.activeReferencesProfileId`.

### chat-binding.js

- `applyBindingForCurrentChat`: убрать `if (binding.overrides.referencesProfileId) state.activeReferencesProfileId = ...;`. Overrides.imageProfileId остаётся.
- После применения бандла — `await refreshPoolCache()` (чтобы `_resolveRefs` имел актуальный пул для нового чата).

---

## 4. `src/pipeline.js` — collect → новый модуль

```js
// Было:
import { collectReferencesFromActiveProfile } from './references-profiles.js';
// Стало:
import { collectRefsForCurrentChat } from './refs-library.js';
```

В `runStage2`:
```js
// Было: refs = await collectReferencesFromActiveProfile({...}, opts.override || null);
refs = await collectRefsForCurrentChat({
    chatText: msg?.mes || '',
    instructionText: `${instruction.prompt || ''} ${instruction.style || ''}`,
    charName, userName,
}, opts.override || null);
```

JSDoc `@param {import('./references-profiles.js').RefsOverride}` → `@param {import('./refs-library.js').RefsOverride}`.

`refsSnapshot`/`refsSig` — без изменений (role/name сохраняются; для регена rebuildRefs ищет imagePath в пуле).

---

## 5. `src/ui/tab-generate.js` — override упрощается

```js
// Было:
import { getActiveReferencesProfile, collectReferencesPreview } from '../references-profiles.js';
// Стало:
import { previewRefsForCurrentChat, getChatRefs, refreshPoolCache, getRefSync } from '../refs-library.js';
```

### `renderRefsStatus`

Больше НЕ fetch'ит профиль. Читает `getChatRefs()` (синхронно) + `previewRefsForCurrentChat()`.

- Бейдж mode — из `getChatRefs().mode`.
- Имя профиля (`profileName`) → убрать (профилей нет). Заменить на «Чат: {{char}}/auto» или просто убрать элемент.
- Секции профиля (`profile.npcReferences`, `profile.charAvatarIds`) → читаются из chat-refs: charSlot/userSlot + extras (по `extraRefIds` из кэша пула).
- Cap-расчёт: char(1) + user(1) + extras. Smart-фильтр extras учитывается в preview.

### `buildOverrideControls`

Убрать блок чипов ST-чаров (`uris-ov-char-chips`, `charAvatarIds`). Override-контролы:
- Чекбокс `{{char}}` (toggle `includeChar`).
- Чекбокс `{{user}}` (toggle `includeUser`).
- Чипы extras (по `extraRefIds` из кэша пула), toggle в `extraEnabled`.

```js
function buildOverrideControls() {
    const o = state.refsOverride || {};
    const chatRefs = getChatRefs();
    const parts = [];
    if (chatRefs.charSlot && !(o.includeChar === false)) {
        // char slot есть — показываем toggle
        const on = o.includeChar !== false;
        parts.push(`<label class="checkbox_label uris-ov-char"><input type="checkbox" data-ref="char" ${on ? 'checked' : ''}><span>{{char}}</span></label>`);
    }
    if (chatRefs.userSlot && !(o.includeUser === false)) {
        const on = o.includeUser !== false;
        parts.push(`<label class="checkbox_label uris-ov-user"><input type="checkbox" data-ref="user" ${on ? 'checked' : ''}><span>{{user}}</span></label>`);
    }
    for (const refId of chatRefs.extraRefIds) {
        const ref = getRefSync(refId);
        if (!ref) continue;
        const on = o.extraEnabled && typeof o.extraEnabled[refId] === 'boolean' ? o.extraEnabled[refId] : true;
        parts.push(`<span class="uris-ov-npc-chip ${on ? 'uris-npc-chip-on' : ''}" data-ref-id="${escapeHtml(refId)}" role="button" tabindex="0" title="${escapeHtml(ref.name)}">${escapeHtml(ref.name)}</span>`);
    }
    return parts.join('');
}
```

### `initOverrideFromProfile` → `initOverride`

```js
function initOverride() {
    return { enabled: true, mode: null, includeChar: null, includeUser: null, extraEnabled: {} };
}
```

`state.refsOverride` больше не наследует из профиля (профиля нет) — стартует с «всё включено», пользователь отключает нужное.

---

## 6. `src/ui/tab-references.js` — полная переделка

### Структура (две секции)

```js
import {
    listRefs, getRef, createRef, updateRef, deleteRef,
    listFolders, createFolder, renameFolder, deleteFolder,
    getChatRefs, saveChatRefs, refreshPoolCache,
} from '../refs-library.js';
import { showInputModal, showConfirmModal, escapeHtml, debounceSave, getCtx, log } from '../core.js';
import { fetchUserAvatars, compressDataUrl, uploadReferenceImage, imageToDataUrl } from '../references.js';

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

### 6.1. Секция «Текущий чат» (`renderChatSection`)

```
┌─ ТЕКУЩИЙ ЧАТ ────────────────────────────────────┐
│ {{char}}:  [● Auto из ST ▾]  [превью]            │
│ {{user}}:  [○ Auto из ST ▾]  [превью]            │
│ Режим:     [always ▾ / smart / never]            │
│ Закреплённые рефы: [+ Добавить из пула]          │
│   [thumb] [thumb] [thumb]                        │
└───────────────────────────────────────────────────┘
```

- `{{char}}`/`{{user}}`: селектор «Auto из ST / Выбрать из пула». При выборе «из пула» — popup-пикер по пулу (с фильтром папок). Запись в `saveChatRefs({ charSlot: { type, refId? } })`.
- Превью слота: auto → иконка/текст; pinned → `<img src=ref.imagePath>`.
- Режим: `<select>` → `saveChatRefs({ mode })`.
- Закреплённые (extras): кнопка `[+]` → popup-пикер пул (multi-select) → `saveChatRefs({ extraRefIds: [...] })`. Список thumbnails с кнопкой `[×]` для удаления из extras и `[≡]` для drag-сортировки (опц. MVP — кнопки ↑/↓ как раньше).

### 6.2. Секция «Библиотека» (`renderPoolSection`)

```
┌─ БИБЛИОТЕКА РЕФЕРЕНСОВ ──────────────────────────┐
│ [Все] [Без папки] [NPC] [Локации]  [+ 📁] [+ ➕] │  ← папки-чипы + действия
│ ┌─────┐ ┌─────┐ ┌─────┐                          │
│ │ ref │ │ ref │ │ ref │  клик = редактировать    │  ← сетка
│ │ img │ │ img │ │ img │                          │
│ │name │ │name │ │name │                          │
│ └─────┘ └─────┘ └─────┘                          │
└───────────────────────────────────────────────────┘
```

- Чипы папок: `[Все]` (все рефы), `[Без папки]` (folderId=null), затем по `listFolders()`. Клик — фильтр сетки. Активный чип подсвечен.
- `[+ 📁]` → `showInputModal('Имя папки')` → `createFolder(name)` → refresh.
- `[+ ➕]` (добавить реф) → скрытый file input → `compressDataUrl` → `uploadReferenceImage` → `showInputModal` имя → `createRef({name, imagePath, folderId: activeFolder})`.
- Сетка рефов: tile с миниатюрой (`<img src=imagePath>`) + name + бейдж папки. Клик tile → inline-редактор: имя (input), keywords (input), папка (select из folders), кнопка «Заменить картинку» (file input), «Удалить».
- Drag рефа в чип папки → `updateRef(id, {folderId})` (nice-to-have MVP; если сложно — select папки в редакторе достаточно).

### 6.3. Popup-пикер пула (для слотов и extras)

```js
/**
 * Показать пикер референсов из пула (с фильтром по папкам). Multi или single.
 * @param {object} opts - { title, multi, excludeIds:[] }
 * @returns {Promise<string[]|string|null>} - id выбранных референсов (или null/[])
 */
async function showPoolPicker({ title = 'Выберите референсы', multi = true, excludeIds = [] } = {}) {
    const ctx = getCtx();
    const refs = await listRefs();
    // Фильтр excludeIds (напр. уже закреплённые).
    const avail = refs.filter(r => r.imagePath && !excludeIds.includes(r.id));
    if (!avail.length) { toastr?.info('Пул пуст. Добавьте референсы в библиотеку.'); return multi ? [] : null; }
    // ST callGenericPopup с customButtons по референсам — но их может быть много.
    // Альтернатива: встроенный модальный список с thumbnails внутри вкладки
    // (toggle-чипы). Реализация: временный <div class="uris-picker"> с сеткой.
    // ... (см. реализацию — встроенный overlay, не ST popup, чтобы thumbnails)
}
```

> **Решение по пикеру:** ST `callGenericPopup` не показывает thumbnails удобно (только текстовые кнопки). Реализовать **собственный overlay-пикер** внутри вкладки: `<div class="uris-picker-overlay">` с сеткой tiles, multi-select чекбоксами, кнопкой «Готово». Это даёт визуальный выбор по картинкам.

---

## 7. `src/ui/tab-gallery.js` — saveRef → в пул

```js
// Было:
import { getActiveReferencesProfile, addNpcReference, updateNpcReference } from '../references-profiles.js';
// Стало:
import { createRef, listRefs, updateRef } from '../refs-library.js';
```

`saveRef` обработчик упрощается: картинка из галереи → `uploadReferenceImage` → `showInputModal` имя + keywords → `createRef({name, keywords, imagePath, folderId: null})`. Опции «новый/заменить» оставить: «заменить» = выбрать существующий реф из пула → `updateRef(id, {imagePath})`.

`rebuildRefsFromSnapshot` (реген «те же рефы»):
```js
// npc: искать imagePath в пуле по имени (как раньше по профилю).
// Было: profile.npcReferences.find(n => n.name === d.name)
// Стало: listRefs().find(r => r.name === d.name)
const refs = await listRefs();
const npc = refs.find(r => r.name === d.name && r.imagePath);
```
char/user — live-fetch как раньше (`getCharacterAvatarDataUrl()` / user-avatar).

---

## 8. `src/ui/tab-profiles.js` — убрать refs-профиль у бандла

Строка `tab-profiles.js:60`:
```js
// Было:
const refsName = b.referencesProfileId ? (await getReferencesProfile(b.referencesProfileId))?.name : null;
// Убрать (refs-профилей больше нет). Бандл refs-профиль не показывает.
```
Убрать `import { getReferencesProfile }`. Если в UI бандла была строка «Референсы: <имя>» — заменить на «Референсы: по чату» (информационно) или убрать.

---

## 9. `src/index.js` — init-миграция

```js
// После loadSettings(), до первого рендера:
import { migrateWipeLegacyProfiles, refreshPoolCache } from './refs-library.js';
// ...
await migrateWipeLegacyProfiles();
await refreshPoolCache();
```

---

## CSS (`style.css`)

Удалить устаревшие V3-классы (`.uris-char-section`, `.uris-char-chip*`, `.uris-ov-char-*`, `.uris-npc-bound-badge`, `.uris-npc-bind`, `.uris-npc-sync`, `.uris-refs-mode-warning`). Добавить:

```css
/* Секция «Текущий чат» */
.uris-refs-chat {
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 8px;
    padding: 10px;
    margin-bottom: 12px;
}
.uris-slot-row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 0;
}
.uris-slot-preview {
    width: 40px; height: 40px; border-radius: 6px;
    object-fit: cover; background: rgba(255,255,255,.08);
    display: flex; align-items: center; justify-content: center;
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
.uris-pool-tile img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
.uris-pool-tile-name {
    font-size: 11px; padding: 4px; text-align: center;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
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
    max-width: 720px; max-height: 80vh; overflow: auto;
}
```

---

## Тесты (`tests/refs-library.test.js`, новый)

Заменяет `tests/references-profiles.test.js` (удалить). Mock ST-контекст (как в старом тесте) + добавляем `chatMetadata` mock.

```js
globalThis.SillyTavern = {
    getContext: () => ({
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        saveMetadata: () => {},
        getRequestHeaders: () => ({}),
        characters: [{ name: 'Aria', avatar: 'aria.png' }],
        characterId: 0,
        name1: 'Alex', name2: 'Aria',
        chatMetadata: {},   // ← uris_binding будет писать сюда
    }),
    libs: { localforage: makeLocalforage() },
};

// Pool CRUD
test('createRef/listRefs/updateRef/deleteRef roundtrip', async () => { ... });
test('createRef normalizes keywords (string → array)', async () => { ... });

// Folders CRUD
test('createFolder/listFolders/renameFolder', async () => { ... });
test('deleteFolder moves refs to folderId=null', async () => { ... });

// Chat binding
test('getChatRefs returns default for new chat', async () => {
    assert.deepEqual(getChatRefs(), { mode:'smart', charSlot:{type:'auto'}, userSlot:{type:'auto'}, extraRefIds:[] });
});
test('saveChatRefs merge-patch persists to chatMetadata', async () => {
    await saveChatRefs({ mode: 'always' });
    assert.equal(getCtx().chatMetadata.uris_binding.refs.mode, 'always');
    assert.equal(getChatRefs().charSlot.type, 'auto');  // default сохранился
});
test('saveChatRefs charSlot pinned → читается обратно', async () => {
    const ref = await createRef({ name:'Aria', imagePath:'/a.png' });
    await saveChatRefs({ charSlot: { type:'pinned', refId: ref.id } });
    assert.equal(getChatRefs().charSlot.type, 'pinned');
});

// Collect (с mock fetch для imageToDataUrl)
test('collectRefsForCurrentChat: auto char + auto user + 0 extras = 2 refs', withFetchBlob(async () => {
    const refs = await collectRefsForCurrentChat({ charName:'Aria', userName:'Alex' });
    assert.equal(refs.length, 2);
    assert.equal(refs[0].role, 'char'); assert.equal(refs[1].role, 'user');
}));

test('collectRefsForCurrentChat: pinned char + smart extra (упомянут)', withFetchBlob(async () => {
    const ariaRef = await createRef({ name:'Aria-pin', imagePath:'/a.png', keywords:'Aria-pin' });
    const bobRef = await createRef({ name:'Bob', imagePath:'/b.png', keywords:'Bob' });
    await refreshPoolCache();
    await saveChatRefs({ charSlot:{type:'pinned',refId:ariaRef.id}, extraRefIds:[bobRef.id] });
    const refs = await collectRefsForCurrentChat({ chatText:'Bob enters', charName:'Aria' });
    assert.equal(refs.length, 2);  // pinned char + Bob (упомянут)
    assert.equal(refs[0].name, 'Aria-pin');
    assert.equal(refs[1].name, 'Bob');
}));

test('smart filters unmentioned extra (char/user slots disabled via override)', withFetchBlob(async () => {
    const ref = await createRef({ name:'Eva', imagePath:'/e.png' });
    await refreshPoolCache();
    await saveChatRefs({ extraRefIds:[ref.id] });  // mode default smart
    const refs = await collectRefsForCurrentChat({ chatText:'no mention' },
        { includeChar:false, includeUser:false });
    assert.equal(refs.length, 0);  // extras отфильтрованы smart, слои выключены override
}));

test('MAX_REFS=4 cap: char+user+4 extras = 4', withFetchBlob(async () => {
    const ids = [];
    for (let i=0;i<4;i++){ const r=await createRef({name:`N${i}`,imagePath:`/${i}.png`}); ids.push(r.id); }
    await refreshPoolCache();
    await saveChatRefs({ extraRefIds: ids });  // +char +user = 6 → cap 4
    const refs = await collectRefsForCurrentChat({ chatText:'N0 N1 N2 N3' });
    assert.equal(refs.length, 4);
}));

test('override.includeChar=false removes char slot', withFetchBlob(async () => {
    const refs = await collectRefsForCurrentChat({charName:'Aria'}, {includeChar:false});
    assert.ok(!refs.some(r=>r.role==='char'));
}));

test('override.extraEnabled toggles individual extra', withFetchBlob(async () => {
    const r1 = await createRef({name:'A',imagePath:'/a.png'});
    const r2 = await createRef({name:'B',imagePath:'/b.png'});
    await refreshPoolCache();
    await saveChatRefs({ extraRefIds:[r1.id,r2.id], mode:'always' });
    const refs = await collectRefsForCurrentChat({}, { includeChar:false, includeUser:false, extraEnabled:{[r1.id]:false} });
    assert.equal(refs.length, 1); assert.equal(refs[0].name,'B');
}));

test('deleted ref in extras skipped (no error)', withFetchBlob(async () => {
    await saveChatRefs({ extraRefIds:['nonexistent'] });
    const refs = await collectRefsForCurrentChat({},{includeChar:false,includeUser:false});
    assert.equal(refs.length, 0);
}));

// Migration wipe
test('migrateWipeLegacyProfiles removes LF_REFERENCES_PROFILES', async () => {
    memoryStore.set(LF_REFERENCES_PROFILES, [{id:'old',npcReferences:[]}]);
    await migrateWipeLegacyProfiles();
    assert.equal(memoryStore.has(LF_REFERENCES_PROFILES), false);
});

// Smart-matching (переехало из references-profiles, без изменений)
test('isNameInText: basic + short-token ignore', () => { ... });
```

> **Тестовый mock:** `withFetchBlob` — хелпер из старого теста (mock `fetch` для `imageToDataUrl`). Переиспользуем. `refreshPoolCache()` обязателен перед каждым collect-тестом (кэш синхронный).

---

## Порядок исполнения

1. **core.js**: добавить `LF_REFS_POOL`, `LF_REFS_FOLDERS`; комментарии deprecated.
2. **refs-library.js**: создать модуль (pool CRUD, folders CRUD, chat binding, smart-matching, collect, кэш, wipe-миграция).
3. **bundles.js + chat-binding.js**: убрать `referencesProfileId` применение; `refreshPoolCache()` в applyBinding.
4. **pipeline.js**: импорт `collectRefsForCurrentChat`; JSDoc.
5. **tab-generate.js**: renderRefsStatus/buildOverrideControls/initOverride под новую модель; убрать profile fetch.
6. **tab-gallery.js**: saveRef → `createRef`; rebuildRefsFromSnapshot → `listRefs()`.
7. **tab-profiles.js**: убрать refs-профиль бандла.
8. **tab-references.js**: полная переделка (chat-секция + pool-секция + picker overlay).
9. **index.js**: `migrateWipeLegacyProfiles()` + `refreshPoolCache()` в init.
10. **style.css**: удалить V3-классы, добавить новые.
11. **Удалить**: `src/references-profiles.js`, `tests/references-profiles.test.js`.
12. **Создать**: `tests/refs-library.test.js`.
13. **Verify**: `node --check` всех изменённых файлов; `node --test tests/*.test.js`; мысленный прогон: новый чат → auto {{char}} → добавить NPC в пул → pin в чат → генерация.

---

## Риски / подходы

### Chat binding в chatMetadata — перзистентность
- `chatMetadata` хранится ST и переживает reload. `saveChatRefs` вызывает `ctx.saveMetadata()`. На чатах с большим объёмом metadata это дёшево (refs-объект маленький).
- **Риск:** если ST не успел сохранить metadata перед сменой чата — потеря. Mitigation: `saveMetadata` синхронный (debounced internally в ST). При быстрых переключениях возможна гонка — приемлемо (как и для bundleId сегодня).

### Пул-кэш рассинхрон с localforage
- `_poolCache` обновляется при CRUD и смене чата. **Риск:** если пул меняется в другой вкладке/окне ST (два окна одного extension) — кэш устаревает. Mitigation: `refreshPoolCache()` при каждом `render` вкладки референсов и при `CHAT_CHANGED`. Двух-оконный сценарий редок; при рендере кэш свежий.

### user-avatar auto — эвристика имени файла
- `getUserAvatarDataUrl(file)` требует имя файла; auto-режим угадывает его из `ctx.name1`. Если ST даёт прямой API активного user-avatar — использовать. **Риск:** неверное имя → null → user-слот тихо пропускается. Mitigation: лог предупреждения; при реализации проверить доступные `ctx`-поля.

### Стирание старых профилей — безвозвратно
- Пользователь выбрал wipe. `LF_REFERENCES_PROFILES` удаляется при первом запуске. NPC-картинки (файлы в `URIS_Refs/`) остаются на сервере — при желании можно перезалить в пул вручную. **Mitigation:** миграция логирует wipe; пул стартует пустым.

### Override без профиля-наследия
- Раньше override наследовал `npcEnabled` из профиля. Теперь extras стартуют «всё вкл», пользователь отключает. Это **меньше** surprising (явный выбор) и соответствует «override = временное отключение».

### Picker overlay vs ST popup
- Собственный overlay (не ST popup) даёт thumbnails, но живёт вне ST-стилей. Mitigation: переиспользовать ST CSS-переменные (`--SmartTheme*`), z-index поверх.

---

## Что НЕ входит (future work)

1. **`buildReferenceInstruction` обобщение под тип референса.** Сейчас extras получают label `NPC "<name>"` (role `'npc'`). Но референсом может быть локация, одежда, стиль, животное — метка «NPC» вводит модель в заблуждение. Future: добавить опциональное поле `ref.kind` в пул (`'character' | 'location' | 'outfit' | 'style' | 'object' | 'other'`) и в `buildReferenceInstruction` строить label по kind:
   - `'character'` → `Character "<name>"` (как сейчас для npc)
   - `'location'` → `Location "<name>"` — «use for the scene/setting appearance»
   - `'outfit'` → `Outfit "<name>"` — «use for clothing/attire»
   - `'style'` → `Style reference "<name>"` — «use as overall aesthetic/visual style»
   - `'object'` → `Object "<name>"`
   - И соответствующие `target`-формулировки в инструкции.
   Это отдельная задача — помечено для следующей итерации. Задел: пул уже хранит произвольные поля, добавить `kind` — малый change.

2. **Drag-and-drop рефов в папки / сортировка extras.** MVP — кнопки ↑/↓ и select папки в редакторе. Drag — позже.

3. **Multi-char group-chat.** Один {{char}} на чат сейчас. Если понадобится — pin каждого group-чара как ordinary ref (без спец-роли), что уже работает через extras. Спец. UI multi-char — future.

4. **Live auto-refresh при смене ST-аватара.** charSlot auto уже live-fetch'ит — авто-обновление работает без явной «синхронизации». Доп. proactive-refresh (перечитывать при `CHARACTER_MESSAGE_RENDERED`) — не нужен.

5. **Обратный lookup «какие чаты используют реф».** При удалении рефа из пула — мёртвые `refId` в extras тихо skip. Показать «используется в N чатах» — future (требует обхода всех чатов).

6. **Импорт/экспорт пула** (data-port). Старый `tests/data-port.test.js` не покрывал профили (grep подтвердил — нет упоминаний). Добавить экспорт пула/папок в data-port — отдельная задача.

---

## Связанные документы

- Заменяемый план: `docs/plans/2026-07-14-phase3-references-character-binding.md` (V3.1/V3.2/V3.3 — НЕ реализовывать).
- Brainstorming-сессия (этот диалог): решения зафиксированы в разделах «Решения».
- Phase 1 план (refs override + read-back): реализован, см. `src/ui/tab-generate.js::renderRefsStatus` — override-механика переиспользуется.
- Phase 2 план (NPC tile-превью + drag): tile-паттерн переиспользуется в пуле.
- Утилиты без изменений: `src/references.js` (`imageToDataUrl`, `getCharacterAvatarDataUrl`, `compressDataUrl`, `uploadReferenceImage`).
