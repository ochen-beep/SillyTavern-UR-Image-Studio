# Вкладка «Референсы» — редизайн под макет Figma Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Полный передел вкладки «Референсы» под визуальную систему Figma-макета: сайдбар папок + сетка карточек 3:4 + overlay-панель редактора, мульти-папки с авто-миграцией при чтении, цветные папки (dot в сайдбаре + dots на карточках), плюс лёгкий cosmetic-проход по остальным вкладкам (токены, отступы, без структурных изменений).

**Architecture:**
- **Слой данных** (`src/refs-library.js`) расширяется минимально: `folderId: string|null` → `folders: string[]` с обратной совместимостью на чтении (legacy-запись `folderId` автоматически апгрейдится в `normalizePoolReference`). Папка получает поле `color` из палитры.
- **UI вкладки** (`src/ui/tab-references.js`) переписывается: чипы-фильтры → вертикальный сайдбар папок слева; модальный редактор → overlay-панель справа, выезжающая поверх сетки; папки в редакторе — multi-toggle grid.
- **Picker overlay** (`showPoolPicker`) остаётся модалкой (используется вкладкой Генерация), но фильтрация переходит на `folders` массив. Чипы в нём визуально подтягиваются к сайдбару на широком пикере, остаются чипами на узком.
- **Адаптив** — через `ResizeObserver` на ширине вкладки (как в Figma-коде), а не `window.innerWidth`. Точка: `<480` — мобильный стек (сайдбар сворачивается в экран-список), `≥480` — сайдбар постоянный.
- **Стиль** (`style.css`) — новые классы для сайдбара/карточек/панели/дотов; косметический проход токенами по остальным вкладкам.

**Tech Stack:** Vanilla ESM JS, `node:test` + `node:assert/strict`, SillyTavern extension API, CSS в `style.css`, jsdom через `tests/fake-dom.js`.

---

## Design Summary (утверждённые решения)

1. **Мульти-папки с авто-миграцией при чтении.** Карточка состоит в нескольких папках. Модель: `folders: string[]`. Старые записи с `folderId` автоматически апгрейдятся в `normalizePoolReference` — миграция идемпотентна, без скриптов, без потери данных.
2. **Overlay-панель редактора** на десктопе. Сайдбар папок слева постоянный (148px), сетка в центре, редактор — правая панель, выезжающая поверх сетки (overlay) на любой ширине окна.
3. **Цвета папок.** Поле `color` в модели папки, палитра из 10 цветов (взята из Figma-кода `FOLDER_PALETTE`), назначается циклически по индексу при создании. Dot цвета в сайдбаре, dots папок (5px) внизу карточки.
4. **Скоуп:** полный передел вкладки Референсы + косметический проход по остальным вкладкам (замена хардкод-цветов на токены, унификация отступов; структура и логика — не трогаются).

### Модель данных (финальная)

```js
// Папка
{ id: string, name: string, color: string /* hex из палитры */, order: number }

// Референс (после апгрейда)
{
  id: string,
  name: string,
  aliases: string[],
  description: string,
  imagePath: string,
  folders: string[],  // ← ранее folderId: string|null
  role?: 'char'|'user'|'npc',
  createdAt: number,
}
```

### Layout вкладки (десктоп, ширина вкладки ≥ 480px)

```
┌────────────┬─────────────────────────┐
│  Сайдбар   │      Сетка карточек     │
│  148px     │   (auto-fill, 3:4)      │
│            │                         │
│ ◈ Все (N)  │   ┌──┐ ┌──┐ ┌──┐ ┌──┐  │
│            │   │  │ │  │ │  │ │  │  │
│ ПАПКИ      │   └──┘ └──┘ └──┘ └──┘  │
│ ● НРС (3)  │                         │
│ ● Юзер (2) │   ┌──┐ ┌──┐ ...         │
│            │   │  │                 │
│ ──────     │   └──┘                  │
│ [+ Папка]  │                  ┌─────┐│
│            │                  │реда-││ ← overlay при клике
└────────────┴──────────────────┤ктор │┘   на карточку
                                 └─────┘
```

### Layout (мобильный, ширина вкладки < 480px)

```
┌─────────────────────────┐
│ Библиотека  [+Папка][+К]│ ← toolbar
├─────────────────────────┤
│ ◈ Все карточки       ›  │
│ ● НРС  ●●●         3 ›  │
│ ● Юзер ●●           2 ›  │ ← список папок
│                         │
└─────────────────────────┘
   → клик → экран сетки → клик → экран редактора
```

---

## File Structure

- `src/refs-library.js` — расширение модели: `folders: string[]`, цвет папки, авто-миграция при чтении, multi-folder CRUD, фильтрация helper `filterRefsByFolder(refs, folderId|'all'|'none')`.
- `src/ui/tab-references.js` — **полный передел разметки**: layout (sidebar + grid + overlay-panel), mobile-стек, multi-folder toggle в редакторе.
- `src/ui/tab-gallery.js` — косметика (без структурных изменений; `createRef` уже без папок — корректно).
- `src/ui/tab-generate.js` — косметика стилей refs panel (без структурных изменений).
- `src/ui/tab-api.js`, `src/ui/tab-templates.js` — косметика токенов.
- `style.css` — новые классы (`uris-refs-sidebar`, `uris-refs-grid-wrap`, `uris-refs-overlay-panel`, `uris-folder-dot`, `uris-folder-tile`, `uris-multifolder-toggle`), косметика токенами.
- `tests/refs-library.test.js` — обновить тесты под `folders: string[]` + добавить тесты multi-folder, цвета, авто-миграции.
- `tests/tab-references.test.js` — **новый файл**: DOM-тесты layout (sidebar, grid, overlay-panel, multi-toggle).
- `tests/smoke.test.js` — обновить assertion (если проверяет refs структуру).

---

## Task 1: Расширить модель данных — `folders: string[]` с авто-миграцией

**Files:**
- Modify: `src/refs-library.js:36-94` (`normalizePoolReference`, `updateRef`)
- Modify: `src/refs-library.js:128-138` (`deleteFolder` — отвязка по массиву)
- Test: `tests/refs-library.test.js:90-105, 146-152`

- [ ] **Step 1: Написать падающий тест для авто-миграции `folderId → folders`**

Открыть `tests/refs-library.test.js`. Найти строку ~98 (`test('updateRef folderId null clears'...)`). Заменить весь блок строк 98-105 на три новых теста:

```js
test('normalizePoolReference апгрейдит legacy folderId в folders[]', async () => {
    const { createRef, listRefs } = await import('../src/refs-library.js');
    // Создаём запись напрямую с legacy-полем через createRef (он прогоняет normalize)
    const r = await createRef({ name: 'A', imagePath: '/a.png', folderId: 'f1' });
    assert.deepEqual(r.folders, ['f1'], 'folderId должен стать массивом folders');
    assert.equal(r.folderId, undefined, 'поле folderId не сохраняется');
});

test('normalizePoolReference сохраняет массив folders', async () => {
    const { createRef } = await import('../src/refs-library.js');
    const r = await createRef({ name: 'B', imagePath: '/b.png', folders: ['f1', 'f2'] });
    assert.deepEqual(r.folders, ['f1', 'f2']);
});

test('updateRef ставит folders через patch.folders (массив)', async () => {
    const { createRef, updateRef } = await import('../src/refs-library.js');
    const r = await createRef({ name: 'C', imagePath: '/c.png', folders: ['f1'] });
    const updated = await updateRef(r.id, { folders: ['f1', 'f2'] });
    assert.deepEqual(updated.folders, ['f1', 'f2']);
});

test('updateRef folders=[] очищает папки', async () => {
    const { createRef, updateRef } = await import('../src/refs-library.js');
    const r = await createRef({ name: 'D', imagePath: '/d.png', folders: ['f1'] });
    const updated = await updateRef(r.id, { folders: [] });
    assert.deepEqual(updated.folders, []);
});

test('legacy-запись с folderId читается listRefs как folders[]', async () => {
    // Прямой инъекцией в localforage — эмулируем старую персистентную запись.
    const ctx = globalThis.SillyTavern.getContext();
    const lf = globalThis.SillyTavern.libs.localforage;
    const existing = (await lf.getItem('uris_refs_pool')) || [];
    existing.push({ id: 'legacy-1', name: 'Old', imagePath: '/o.png', folderId: 'fold-x', createdAt: 1 });
    await lf.setItem('uris_refs_pool', existing);
    const { listRefs } = await import('../src/refs-library.js');
    const refs = await listRefs();
    const old = refs.find(r => r.id === 'legacy-1');
    assert.deepEqual(old.folders, ['fold-x']);
    assert.equal(old.folderId, undefined);
});
```

(Использовать реальный ключ пула — проверить через `grep -n "LF_REFS_POOL" src/core.js` и подставить. Если ключ — `'uris_refs_pool'`, оставить как есть; иначе заменить в тесте.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/refs-library.test.js`
Expected: FAIL — текущий `normalizePoolReference` возвращает `folderId`, не `folders`.

- [ ] **Step 3: Modify `normalizePoolReference` в `src/refs-library.js:36-54`**

Найти функцию (строки 36-54). Заменить поле `folderId` на `folders`:

Было:
```js
export function normalizePoolReference(data = {}, { migrateKeywords = true } = {}) {
    const aliases = normalizeAliases(data.aliases);
    const legacyKeywords = migrateKeywords
        ? (Array.isArray(data.keywords) ? data.keywords : String(data.keywords || '').split(/[,;|]/))
        : [];
    const item = {
        id: data.id ? String(data.id) : uid(),
        name: String(data.name || '').trim() || 'Без названия',
        aliases: uniqueStrings([...aliases, ...legacyKeywords]),
        description: String(data.description || ''),
        imagePath: data.imagePath || '',
        folderId: data.folderId || null,
        createdAt: Number.isFinite(data.createdAt) ? data.createdAt : Date.now(),
    };
    const role = normalizeRole(data.role);
    if (role) item.role = role;
    return item;
}
```

Стало:
```js
export function normalizePoolReference(data = {}, { migrateKeywords = true } = {}) {
    const aliases = normalizeAliases(data.aliases);
    const legacyKeywords = migrateKeywords
        ? (Array.isArray(data.keywords) ? data.keywords : String(data.keywords || '').split(/[,;|]/))
        : [];
    // Авто-миграция: legacy folderId (string|null) → folders: string[].
    // Идемпотентна: если уже массив — берём как есть; если folderId — заворачиваем.
    const rawFolders = Array.isArray(data.folders)
        ? data.folders
        : (data.folderId ? [data.folderId] : []);
    const item = {
        id: data.id ? String(data.id) : uid(),
        name: String(data.name || '').trim() || 'Без названия',
        aliases: uniqueStrings([...aliases, ...legacyKeywords]),
        description: String(data.description || ''),
        imagePath: data.imagePath || '',
        folders: uniqueStrings(rawFolders.map(String)),
        createdAt: Number.isFinite(data.createdAt) ? data.createdAt : Date.now(),
    };
    const role = normalizeRole(data.role);
    if (role) item.role = role;
    return item;
}
```

- [ ] **Step 4: Modify `updateRef` в `src/refs-library.js:79-94`**

Найти строку 88 (`if (patch.folderId !== undefined) next.folderId = patch.folderId || null;`). Заменить на обработку `folders`:

Было (одна строка 88):
```js
    if (patch.folderId !== undefined) next.folderId = patch.folderId || null;
```

Стало:
```js
    if (patch.folders !== undefined) {
        next.folders = uniqueStrings((Array.isArray(patch.folders) ? patch.folders : [])
            .map(String));
    } else if (patch.folderId !== undefined) {
        // Legacy-patch: конвертируем старый single-folder patch в массив.
        next.folders = patch.folderId ? [String(patch.folderId)] : [];
    }
```

- [ ] **Step 5: Modify `deleteFolder` в `src/refs-library.js:128-138` — отвязка по массиву**

Найти функцию. Заменить тело отвязки:

Было (строки 133-135):
```js
    let changed = false;
    for (const r of refs) if (r.folderId === id) { r.folderId = null; changed = true; }
    if (changed) await _setRefs(refs);
```

Стало:
```js
    let changed = false;
    for (const r of refs) {
        if (Array.isArray(r.folders) && r.folders.includes(id)) {
            r.folders = r.folders.filter(f => f !== id);
            changed = true;
        } else if (r.folderId === id) {
            // На случай, если кэш/запись ещё не нормализована (defense-in-depth).
            r.folders = [];
            delete r.folderId;
            changed = true;
        }
    }
    if (changed) await _setRefs(refs);
```

- [ ] **Step 6: Run tests**

Run: `node --test tests/refs-library.test.js`
Expected: 5 новых тестов PASS. Остальные тесты, проверяющие `folderId` напрямую (см. Step 7), могут падать — это ожидаемо.

- [ ] **Step 7: Обновить устаревшие assertions на `folderId`**

Найти и исправить оставшиеся тесты, которые читают `folderId`:

Запуск: `grep -n "\.folderId" tests/refs-library.test.js`

Для каждой найденной строки — заменить на эквивалент с `folders`. Типовые замены:
- `assert.equal(after.folderId, null)` → `assert.deepEqual(after.folders, [])` (после `deleteFolder`)
- `assert.equal(updated.folderId, null)` → `assert.deepEqual(updated.folders, [])` (после `updateRef ... folderId: null`)

Если в файле есть тест, который явно проверяет, что `createRef({ folderId })` сохраняет именно `folderId` — удалить этот assertion, заменить на проверку `folders` (см. новые тесты в Step 1).

- [ ] **Step 8: Run full regression**

Run: `node --test tests/refs-library.test.js tests/pool-only-references.test.js tests/pool-only-resolver.test.js tests/data-port.test.js`
Expected: PASS. Если `data-port.test.js` падает на `summary.folders` — это счётчик папок (не карточек), его не трогаем; падение маловероятно. Если падает на структуре карточки — обновить fixture (массив `folders`).

- [ ] **Step 9: Node --check**

Run: `node --check src/refs-library.js`
Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add src/refs-library.js tests/refs-library.test.js
git commit -m "feat(refs): folderId → folders[] with read-time auto-migration

Single folderId:string|null replaced by folders:string[]. Legacy records
auto-upgrade in normalizePoolReference (idempotent, no migration script).
updateRef accepts both folders[] and legacy folderId patches. deleteFolder
now strips the deleted folder from each card's folders[] array."
```

---

## Task 2: Цвет папки в модели + палитра

**Files:**
- Modify: `src/refs-library.js:111-117` (`createFolder`)
- Test: `tests/refs-library.test.js:111-145`

- [ ] **Step 1: Написать падающий тест**

В `tests/refs-library.test.js`, после строки 145 (`deleteFolder moves refs...` блок), добавить:

```js
test('createFolder присваивает color из палитры по порядку', async () => {
    const { createFolder, listFolders } = await import('../src/refs-library.js');
    const f0 = await createFolder('Zero');
    const f1 = await createFolder('One');
    const f2 = await createFolder('Two');
    assert.ok(f0.color && /^#[0-9a-f]{6}$/i.test(f0.color), 'color hex');
    assert.equal(f0.color, f1.color === f0.color ? null : f1.color, 'colors differ');
    // Палитра deterministic: 0-я и 3-я папки могут совпадать (цикл), но 0/1/2 — разные
    const colors = [f0.color, f1.color, f2.color];
    assert.equal(new Set(colors).size, 3, 'первые 3 цвета уникальны');
    const folders = await listFolders();
    assert.ok(folders.every(f => typeof f.color === 'string' && f.color.startsWith('#')));
});

test('createFolder сохраняет кастомный color если передан', async () => {
    const { createFolder } = await import('../src/refs-library.js');
    const f = await createFolder('Custom', { color: '#abcdef' });
    assert.equal(f.color, '#abcdef');
});

test('normalizeFolder возвращает color для legacy-записи без color', async () => {
    // Эмулируем старую папку через прямую запись в localforage.
    const lf = globalThis.SillyTavern.libs.localforage;
    const key = 'uris_refs_folders';
    await lf.setItem(key, [{ id: 'old-f', name: 'Old', order: 0 }]); // без color
    const { listFolders } = await import('../src/refs-library.js');
    const folders = await listFolders();
    const old = folders.find(f => f.id === 'old-f');
    assert.ok(old.color, 'legacy folder gets default color on read');
});
```

(Если ключ `LF_REFS_FOLDERS` в `src/core.js` отличается от `'uris_refs_folders'` — заменить. Проверить: `grep -n "LF_REFS_FOLDERS" src/core.js`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/refs-library.test.js`
Expected: FAIL — `createFolder` не принимает второго аргумента и не выставляет `color`; `listFolders` не нормализует.

- [ ] **Step 3: Modify `src/refs-library.js` — палитра + `normalizeFolder`**

Найти строку 105-117 (блок Folders CRUD). Перед `listFolders` (строка ~105) добавить палитру и нормализатор:

```js
// Палитра цветов папок (взята из Figma-макета). Назначается циклически по
// индексу при создании. 10 цветов — достаточно для визуальной различимости.
const FOLDER_COLOR_PALETTE = [
    '#4a90d9', '#d97f3a', '#3ab09e', '#c94040', '#c9a030',
    '#7a5cc9', '#c94090', '#40a060', '#a04040', '#4a70b9',
];

/** Нормализовать запись папки: гарантирует поля id/name/color/order. */
function normalizeFolder(data = {}, fallbackIndex = 0) {
    return {
        id: data.id ? String(data.id) : uid(),
        name: String(data.name || 'Папка').trim() || 'Папка',
        color: typeof data.color === 'string' && /^#[0-9a-f]{6}$/i.test(data.color)
            ? data.color
            : FOLDER_COLOR_PALETTE[fallbackIndex % FOLDER_COLOR_PALETTE.length],
        order: Number.isFinite(data.order) ? data.order : 0,
    };
}
```

- [ ] **Step 4: Modify `listFolders` для нормализации (строка ~105-108)**

Было:
```js
export async function listFolders() {
    const arr = await lf().getItem(LF_REFS_FOLDERS);
    return Array.isArray(arr) ? arr : [];
}
```

Стало:
```js
export async function listFolders() {
    const arr = await lf().getItem(LF_REFS_FOLDERS);
    if (!Array.isArray(arr)) return [];
    // Нормализуем на чтении — legacy-папки без color получают дефолт из палитры
    // по своему порядку. Идемпотентно (color не перезаписывается, если задан).
    return arr.map((f, i) => normalizeFolder(f, i));
}
```

- [ ] **Step 5: Modify `createFolder` (строка ~111-117)**

Было:
```js
export async function createFolder(name) {
    const arr = await listFolders();
    const item = { id: uid(), name: String(name || 'Папка').trim() || 'Папка', order: arr.length };
    arr.push(item);
    await _setFolders(arr);
    return item;
}
```

Стало:
```js
export async function createFolder(name, opts = {}) {
    const arr = await listFolders();
    const item = normalizeFolder({
        name: String(name || 'Папка').trim() || 'Папка',
        color: typeof opts.color === 'string' ? opts.color : undefined,
        order: arr.length,
    }, arr.length);
    arr.push(item);
    await _setFolders(arr);
    return item;
}
```

- [ ] **Step 6: Modify `renameFolder` (строка ~119-126)**

Найти и обернуть возврат через `normalizeFolder`:

Было:
```js
export async function renameFolder(id, name) {
    const arr = await listFolders();
    const f = arr.find(x => x.id === id);
    if (!f) return null;
    f.name = String(name || 'Папка').trim() || 'Папка';
    await _setFolders(arr);
    return f;
}
```

Стало:
```js
export async function renameFolder(id, name) {
    const arr = await listFolders();
    const i = arr.findIndex(x => x.id === id);
    if (i === -1) return null;
    arr[i] = normalizeFolder({ ...arr[i], name: String(name || 'Папка').trim() || 'Папка' }, i);
    await _setFolders(arr);
    return arr[i];
}
```

- [ ] **Step 7: Run tests**

Run: `node --test tests/refs-library.test.js`
Expected: PASS для всех новых тестов; остальные тесты папок (createFolder default name, listFolders, deleteFolder) — PASS, т.к. доп. поле не ломает существующие assertions.

- [ ] **Step 8: Node --check**

Run: `node --check src/refs-library.js`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add src/refs-library.js tests/refs-library.test.js
git commit -m "feat(refs): folder color field + palette assignment

Folders gain hex color field from 10-color palette (Figma), assigned
cyclically by creation order. Legacy folders without color normalized on
read. createFolder accepts optional {color} override. Used for sidebar
dots and card folder-dots in the redesigned tab."
```

---

## Task 3: Helper `filterRefsByFolder` для multi-folder фильтрации

**Files:**
- Modify: `src/refs-library.js` (добавить экспорт)
- Test: `tests/refs-library.test.js`

- [ ] **Step 1: Написать падающий тест**

Добавить в конец `tests/refs-library.test.js`:

```js
test('filterRefsByFolder: all возвращает всё', () => {
    const { filterRefsByFolder } = require('../src/refs-library.js');
    const refs = [{ folders: ['a'] }, { folders: [] }, { folders: ['a', 'b'] }];
    assert.equal(filterRefsByFolder(refs, 'all').length, 3);
});

test('filterRefsByFolder: none — только без папок', () => {
    const { filterRefsByFolder } = require('../src/refs-library.js');
    const refs = [{ folders: ['a'] }, { folders: [] }, { folders: ['a', 'b'] }];
    const out = filterRefsByFolder(refs, 'none');
    assert.deepEqual(out, [{ folders: [] }]);
});

test('filterRefsByFolder: folderId — карточки во многопапке', () => {
    const { filterRefsByFolder } = require('../src/refs-library.js');
    const refs = [
        { id: '1', folders: ['a'] },
        { id: '2', folders: [] },
        { id: '3', folders: ['a', 'b'] },
        { id: '4', folders: ['b'] },
    ];
    const out = filterRefsByFolder(refs, 'b');
    assert.deepEqual(out.map(r => r.id), ['3', '4']);
});

test('filterRefsByFolder: defensive — folders может быть undefined (legacy)', () => {
    const { filterRefsByFolder } = require('../src/refs-library.js');
    const refs = [{ id: '1' /* без folders */ }, { id: '2', folders: ['x'] }];
    assert.equal(filterRefsByFolder(refs, 'all').length, 2);
    assert.deepEqual(filterRefsByFolder(refs, 'none').map(r => r.id), ['1']);
    assert.deepEqual(filterRefsByFolder(refs, 'x').map(r => r.id), ['2']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/refs-library.test.js`
Expected: FAIL — `filterRefsByFolder` не экспортируется.

- [ ] **Step 3: Добавить helper в `src/refs-library.js`**

После блока Pool CRUD (после `deleteRef`, строка ~101), добавить:

```js
/**
 * Фильтрация списка референсов по активной папке.
 * @param {Array} refs — массив записей референсов (с полем folders: string[])
 * @param {'all'|'none'|string} folderFilter — 'all' | 'none' | folderId
 * @returns {Array} отфильтрованный массив
 */
export function filterRefsByFolder(refs, folderFilter) {
    if (folderFilter === 'all') return refs.slice();
    if (folderFilter === 'none') return refs.filter(r => !Array.isArray(r.folders) || r.folders.length === 0);
    return refs.filter(r => Array.isArray(r.folders) && r.folders.includes(folderFilter));
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/refs-library.test.js`
Expected: PASS.

- [ ] **Step 5: Node --check**

Run: `node --check src/refs-library.js`

- [ ] **Step 6: Commit**

```bash
git add src/refs-library.js tests/refs-library.test.js
git commit -m "feat(refs): filterRefsByFolder helper for multi-folder filtering

Pure function over refs array: 'all' | 'none' | folderId. Defensive against
missing folders field (legacy unnormalized). Used by tab-references and
showPoolPicker to share the same filtering logic."
```

---

## Task 4: Полный передел разметки `tab-references.js` — layout (sidebar + grid + overlay)

**Files:**
- Modify: `src/ui/tab-references.js` (весь файл, кроме `showPoolPicker`)
- Test: `tests/tab-references.test.js` (создать)
- Reference: `Пример дизайна от фигма НЕ КОПИРОВАТЬ КОД, ПРОСТО СМОТРЕТЬ/src/App.tsx:214-683` (визуальный референс)

> ⚠️ Не копировать дословно React-код. Переписать на vanilla ESM с тем же layout, привязкой к нашему `refs-library.js` API и ST-токенам.

- [ ] **Step 1: Проверить доступность fake-dom для тестов**

Run: `head -30 tests/fake-dom.js && head -30 tests/_helpers.js`
Ожидается: `fake-dom.js` поднимает `globalThis.document`, `globalThis.window`. `_helpers.js` — общий stub `SillyTavern` для UI-тестов. Если их уже используют UI-тесты (например, `tests/tab-templates.test.js`) — переиспользовать тот же паттерн.

- [ ] **Step 2: Создать `tests/tab-references.test.js` — базовый layout-тест**

Новый файл:

```js
// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './fake-dom.js';
import { setupSillyTavernStub, clearLocalforage } from './_helpers.js';

setupSillyTavernStub();

test('render: рендерит sidebar + grid + overlay-host для desktop-ширины', async () => {
    clearLocalforage();
    const { render } = await import('../src/ui/tab-references.js');
    const root = document.createElement('div');
    // Симулируем десктоп-ширину: 600px. tab-references меряет через ResizeObserver
    // на root; в jsdom ResizeObserver нет — fallback на cw=600 (см. код).
    Object.defineProperty(root, 'clientWidth', { value: 600, configurable: true });
    document.body.appendChild(root);
    await render(root);
    assert.ok(root.querySelector('.uris-refs-sidebar'), 'sidebar присутствует');
    assert.ok(root.querySelector('.uris-refs-grid-wrap'), 'grid wrapper присутствует');
    assert.ok(root.querySelector('.uris-refs-overlay-host'), 'overlay host для редактора');
    document.body.removeChild(root);
});

test('render: sidebar содержит «Все», «Без папки» и существующие папки', async () => {
    clearLocalforage();
    const { createFolder } = await import('../src/refs-library.js');
    await createFolder('НРС');
    await createFolder('Юзер');
    const { render } = await import('../src/ui/tab-references.js');
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { value: 600, configurable: true });
    document.body.appendChild(root);
    await render(root);
    const items = [...root.querySelectorAll('.uris-folder-item')].map(el => el.dataset.folder);
    assert.ok(items.includes('all'));
    assert.ok(items.includes('none'));
    assert.equal(items.filter(f => f !== 'all' && f !== 'none').length, 2, 'две пользовательские папки');
    document.body.removeChild(root);
});
```

(Если `setupSillyTavernStub` / `clearLocalforage` не существуют в `_helpers.js` — посмотреть как это сделано в `tests/tab-templates.test.js` и скопировать паттерн.)

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/tab-references.test.js`
Expected: FAIL — текущий `render` строит `.uris-refs-pool`, не sidebar+grid+overlay.

- [ ] **Step 4: Переписать `render` и `renderPoolSection` в `src/ui/tab-references.js`**

Заменить весь блок строк 16-89 (переменная `_activeFolderFilter`, `render`, `renderPoolSection`, `folderChipsHtml`, `poolGridHtml`) на новую реализацию. Каркас:

```js
// @ts-check
/**
 * Вкладка «Референсы»: глобальный пул записей с папками.
 * v4-redesign (Figma): sidebar папок слева + сетка карточек 3:4 +
 * overlay-панель редактора справа. Multi-folder через folders[].
 */
import { state, getCtx, escapeHtml, showConfirmModal, showInputModal, log } from '../core.js';
import {
    listRefs, getRef, createRef, updateRef, deleteRef,
    listFolders, createFolder, renameFolder, deleteFolder,
    filterRefsByFolder, refreshPoolCache, getRefSync,
} from '../refs-library.js';
import { compressDataUrl, uploadReferenceImage } from '../references.js';
import { refreshActive } from './tabs.js';

// Layout state
let _activeFolderFilter = 'all';        // 'all' | 'none' | folderId
let _editingRefId = null;               // id редактируемой карточки или null
let _cw = 600;                          // измеренная ширина вкладки (ResizeObserver fallback)
let _ro = null;                         // ResizeObserver instance

export function render(root) {
    root.classList.add('uris-body-flush');
    root.innerHTML = `
        <div class="uris-references">
            <div class="uris-refs-sidebar" id="urisRefsSidebar"></div>
            <div class="uris-refs-main">
                <div class="uris-refs-toolbar" id="urisRefsToolbar"></div>
                <div class="uris-refs-grid-wrap">
                    <div class="uris-pool-grid" id="urisRefsGrid"></div>
                </div>
            </div>
            <div class="uris-refs-overlay-host" id="urisRefsOverlay"></div>
        </div>`;
    // Измеряем ширину — определяет desktop/mobile layout.
    _cw = root.clientWidth || 600;
    root.classList.toggle('uris-refs-mobile', _cw < 480);
    _setupResize(root);
    return _renderAll(root);
}

function _setupResize(root) {
    if (_ro) _ro.disconnect();
    if (typeof ResizeObserver === 'undefined') return;
    _ro = new ResizeObserver(entries => {
        const w = entries[0]?.contentRect.width ?? root.clientWidth ?? 600;
        if (Math.abs(w - _cw) < 8) return; // игнор мелких дрожаний
        _cw = w;
        root.classList.toggle('uris-refs-mobile', _cw < 480);
        _renderAll(root);
    });
    _ro.observe(root);
}

async function _renderAll(root) {
    const [folders, refs] = await Promise.all([listFolders(), listRefs()]);
    _renderSidebar(root, folders, refs);
    _renderToolbar(root, folders);
    _renderGrid(root, folders, refs);
    _renderOverlay(root, folders);
}

// ── Sidebar ──
function _renderSidebar(root, folders, refs) {
    const host = root.querySelector('#urisRefsSidebar');
    if (!host) return;
    const countAll = refs.length;
    const countNone = filterRefsByFolder(refs, 'none').length;
    const itemHtml = (folderId, label, count, dotColor) => `
        <button class="uris-folder-item ${_activeFolderFilter === folderId ? 'uris-folder-item-on' : ''}"
                data-folder="${escapeHtml(folderId)}">
            ${dotColor ? `<span class="uris-folder-dot" style="background:${dotColor}"></span>` : `<span class="uris-folder-dot uris-folder-dot-mute"></span>`}
            <span class="uris-folder-name">${escapeHtml(label)}</span>
            <span class="uris-folder-count">${count}</span>
        </button>`;
    const folderRows = folders.map(f =>
        itemHtml(f.id, f.name, filterRefsByFolder(refs, f.id).length, f.color)
    ).join('');
    host.innerHTML = `
        <div class="uris-folder-list">
            ${itemHtml('all', 'Все', countAll, null)}
            <div class="uris-folder-divider">Папки</div>
            ${itemHtml('none', 'Без папки', countNone, null)}
            ${folderRows}
        </div>
        <div class="uris-folder-add" id="urisRefsAddFolderBtn">+ Папка</div>`;
    host.querySelectorAll('.uris-folder-item').forEach(btn => {
        btn.addEventListener('click', () => {
            _activeFolderFilter = btn.dataset.folder;
            _renderAll(root);
        });
    });
    host.querySelector('#urisRefsAddFolderBtn')?.addEventListener('click', async () => {
        const name = await showInputModal('Имя папки:', 'Новая папка');
        if (!name) return;
        await createFolder(name);
        refreshActive();
    });
}

// ── Toolbar (search + add ref) ──
function _renderToolbar(root, folders) {
    const host = root.querySelector('#urisRefsToolbar');
    if (!host) return;
    host.innerHTML = `
        <div class="uris-refs-search">
            <input type="text" id="urisRefsSearch" placeholder="Поиск..." autocomplete="off">
        </div>
        <button class="uris-refs-add" id="urisRefsAddBtn" title="Добавить референс">
            <i class="fa-solid fa-plus"></i> Референс
        </button>
        <input type="file" class="uris-ref-file" accept="image/*" hidden>`;
    const fileInput = host.querySelector('.uris-ref-file');
    host.querySelector('#urisRefsAddBtn')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const dataUrl = await readFileAsDataUrl(file);
            const compressed = await compressDataUrl(dataUrl);
            const path = await uploadReferenceImage(compressed.dataUrl, `ref_${Date.now()}`);
            const name = await showInputModal('Имя референса:', file.name.replace(/\.[^.]+$/, ''));
            if (!name) return;
            const folderIds = _activeFolderFilter !== 'all' && _activeFolderFilter !== 'none'
                ? [_activeFolderFilter] : [];
            const ref = await createRef({ name, imagePath: path, folders: folderIds });
            _editingRefId = ref.id;
            refreshActive();
        } catch (err) {
            log('Ошибка добавления референса:', err.message);
            toastr?.error?.('Не удалось добавить референс');
        }
        e.target.value = '';
    });
    host.querySelector('#urisRefsSearch')?.addEventListener('input', (e) => {
        _renderGrid(root, folders, null, e.target.value);
    });
}

// ── Grid ──
async function _renderGrid(root, folders, refsOverride, searchQuery = '') {
    const host = root.querySelector('#urisRefsGrid');
    if (!host) return;
    const refs = refsOverride ?? await listRefs();
    const filtered = filterRefsByFolder(refs, _activeFolderFilter);
    const q = (searchQuery || '').toLowerCase().trim();
    const searched = q
        ? filtered.filter(r => (r.name || '').toLowerCase().includes(q)
            || (r.aliases || []).some(a => a.toLowerCase().includes(q)))
        : filtered;
    if (!searched.length) {
        host.innerHTML = `<div class="uris-refs-empty">${q ? 'Не найдено' : 'Пусто. Добавьте референс кнопкой «+».'}</div>`;
        return;
    }
    const foldersById = new Map(folders.map(f => [f.id, f]));
    host.innerHTML = searched.map(r => {
        const role = r.role ? `<span class="uris-pool-tile-role">${escapeHtml(r.role)}</span>` : '';
        const cardFolders = (r.folders || []).map(fid => foldersById.get(fid)).filter(Boolean);
        const dots = cardFolders.slice(0, 4).map(f =>
            `<span class="uris-pool-tile-dot" style="background:${escapeHtml(f.color)}"></span>`
        ).join('');
        return `
        <div class="uris-pool-tile ${_editingRefId === r.id ? 'uris-pool-tile-selected' : ''}"
             data-ref-id="${escapeHtml(r.id)}">
            <img src="${escapeHtml(r.imagePath)}" alt="${escapeHtml(r.name)}" loading="lazy">
            ${role}
            ${dots ? `<div class="uris-pool-tile-dots">${dots}</div>` : ''}
            <div class="uris-pool-tile-name">${escapeHtml(r.name)}</div>
        </div>`;
    }).join('');
    host.querySelectorAll('.uris-pool-tile').forEach(tile => {
        tile.addEventListener('click', () => {
            _editingRefId = tile.dataset.refId;
            _renderOverlay(root, folders);
            _renderGrid(root, folders); // подсветить выбранную
        });
    });
}

// ── Overlay panel (editor) ──
async function _renderOverlay(root, folders) {
    const host = root.querySelector('#urisRefsOverlay');
    if (!host) return;
    if (!_editingRefId) { host.innerHTML = ''; host.classList.remove('uris-refs-overlay-open'); return; }
    const ref = await getRef(_editingRefId);
    if (!ref) { _editingRefId = null; host.innerHTML = ''; return; }
    host.classList.add('uris-refs-overlay-open');
    const aliasesStr = (ref.aliases || []).join(', ');
    const roleOptions = [['', 'Без роли'], ['char', 'char'], ['user', 'user'], ['npc', 'npc']]
        .map(([v, lbl]) => `<option value="${v}" ${ref.role === v || (!ref.role && !v) ? 'selected' : ''}>${lbl}</option>`).join('');
    const folderToggles = folders.map(f => {
        const active = (ref.folders || []).includes(f.id);
        return `<button class="uris-multifolder-toggle ${active ? 'on' : ''}" data-folder-id="${escapeHtml(f.id)}">
            <span class="uris-folder-dot" style="background:${escapeHtml(f.color)}"></span>
            <span class="uris-multifolder-name">${escapeHtml(f.name)}</span>
            ${active ? '<span class="uris-multifolder-check">✓</span>' : ''}
        </button>`;
    }).join('');
    host.innerHTML = `
        <div class="uris-refs-overlay-panel">
            <div class="uris-refs-overlay-head">
                <span class="uris-refs-overlay-title">${escapeHtml(ref.name || 'Без названия')}</span>
                <button class="uris-refs-overlay-close" title="Закрыть">✕</button>
            </div>
            <div class="uris-refs-overlay-body">
                <img src="${escapeHtml(ref.imagePath)}" class="uris-editor-preview" alt="">
                <button class="menu_button uris-ed-replace"><i class="fa-solid fa-image"></i> Заменить картинку</button>
                <input type="file" class="uris-ed-file" accept="image/*" hidden>
                <label class="uris-ed-label">Имя</label>
                <input class="text_pole uris-ed-name" value="${escapeHtml(ref.name || '')}">
                <label class="uris-ed-label">Aliases</label>
                <input class="text_pole uris-ed-aliases" value="${escapeHtml(aliasesStr)}" placeholder="через запятую — единственный источник распознавания">
                <small class="uris-hint">Имя — только подпись. Распознавание исключительно по aliases.</small>
                <label class="uris-ed-label">Роль</label>
                <select class="text_pole uris-ed-role">${roleOptions}</select>
                <label class="uris-ed-label">Описание</label>
                <textarea class="text_pole uris-ed-desc" rows="3" placeholder="Текст для Stage1 (внешность/детали)">${escapeHtml(ref.description || '')}</textarea>
                <label class="uris-ed-label">Папки</label>
                <div class="uris-multifolder-grid">${folderToggles || '<small class="uris-hint">Нет папок</small>'}</div>
                <button class="menu_button redText uris-ed-del"><i class="fa-solid fa-trash"></i> Удалить карточку</button>
            </div>
        </div>`;
    _bindOverlay(root, host, ref, folders);
}

function _bindOverlay(root, host, ref, folders) {
    const nameInput = host.querySelector('.uris-ed-name');
    const aliasesInput = host.querySelector('.uris-ed-aliases');
    const roleInput = host.querySelector('.uris-ed-role');
    const descInput = host.querySelector('.uris-ed-desc');

    const saveBasic = async () => {
        await updateRef(ref.id, {
            name: nameInput.value,
            aliases: aliasesInput.value,
            role: roleInput.value || null,
            description: descInput.value,
        });
    };
    nameInput.addEventListener('change', saveBasic);
    aliasesInput.addEventListener('change', saveBasic);
    roleInput.addEventListener('change', saveBasic);
    descInput.addEventListener('change', saveBasic);

    // Multi-folder toggles
    host.querySelectorAll('.uris-multifolder-toggle').forEach(btn => {
        btn.addEventListener('click', async () => {
            const fid = btn.dataset.folderId;
            const current = await getRef(ref.id);
            const set = new Set(current.folders || []);
            if (set.has(fid)) set.delete(fid); else set.add(fid);
            await updateRef(ref.id, { folders: [...set] });
            _renderOverlay(root, folders);
            _renderSidebar(root, folders, null);
            _renderGrid(root, folders);
        });
    });

    // Replace image
    host.querySelector('.uris-ed-replace')?.addEventListener('click', () => {
        host.querySelector('.uris-ed-file')?.click();
    });
    host.querySelector('.uris-ed-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const dataUrl = await readFileAsDataUrl(file);
            const compressed = await compressDataUrl(dataUrl);
            const path = await uploadReferenceImage(compressed.dataUrl, `ref_${ref.id}`);
            await updateRef(ref.id, { imagePath: path });
            const img = host.querySelector('.uris-editor-preview');
            if (img) img.src = path + '?t=' + Date.now();
        } catch (err) {
            toastr?.error?.('Не удалось заменить: ' + err.message);
        }
        e.target.value = '';
    });

    // Delete
    host.querySelector('.uris-ed-del')?.addEventListener('click', async () => {
        if (await showConfirmModal('Удалить референс из пула?')) {
            await deleteRef(ref.id);
            _editingRefId = null;
            refreshActive();
        }
    });

    // Close
    host.querySelector('.uris-refs-overlay-close')?.addEventListener('click', async () => {
        _editingRefId = null;
        await _renderAll(root);
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

Внимание: функция `showPoolPicker` (строки 222-298 в текущем файле) **остаётся без изменений** в этом шаге — её правим в Task 6.

- [ ] **Step 5: Run layout-тест**

Run: `node --test tests/tab-references.test.js`
Expected: PASS для двух тестов (sidebar присутствует, папки рендерятся).

- [ ] **Step 6: Node --check**

Run: `node --check src/ui/tab-references.js`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/ui/tab-references.js tests/tab-references.test.js
git commit -m "feat(ui): refs tab redesign — sidebar + grid + overlay panel

Layout rebuilt per Figma: vertical folder sidebar (148px) with colored
dots + counts, dense 3:4 grid with folder-dots, right overlay panel for
editor (opens on tile click, stays open while browsing). Multi-folder
toggle grid in editor. ResizeObserver-driven desktop/mobile switch at
480px. showPoolPicker unchanged (still modal)."
```

---

## Task 5: Мобильный стек вкладки (экраны «список папок → сетка → редактор»)

**Files:**
- Modify: `src/ui/tab-references.js` (мобильная ветка в `render` + функции `_renderMobile*`)
- Test: `tests/tab-references.test.js`

- [ ] **Step 1: Написать падающий тест на мобильный layout**

Добавить в `tests/tab-references.test.js`:

```js
test('render: mobile-ширина < 480 → mobile-класс + экран-список папок', async () => {
    clearLocalforage();
    const { render } = await import('../src/ui/tab-references.js');
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { value: 380, configurable: true });
    document.body.appendChild(root);
    await render(root);
    assert.ok(root.classList.contains('uris-refs-mobile'), 'mobile-класс проставлен');
    assert.ok(root.querySelector('.uris-mobile-screen'), 'хоть один mobile-экран');
    document.body.removeChild(root);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tab-references.test.js`
Expected: FAIL — мобильной ветки ещё нет (или есть, но не отрисовывает экран).

- [ ] **Step 3: Расширить `render` мобильной веткой в `src/ui/tab-references.js`**

В функции `render` (см. Task 4 Step 4), после `_setupResize(root)`:

Найти:
```js
    return _renderAll(root);
```
Заменить на:
```js
    if (_cw < 480) return _renderMobileAll(root);
    return _renderAll(root);
```

И в `_setupResize` внутри колбэка `ResizeObserver` обновить редирект на мобильную ветку:
```js
    _ro = new ResizeObserver(entries => {
        const w = entries[0]?.contentRect.width ?? root.clientWidth ?? 600;
        if (Math.abs(w - _cw) < 8) return;
        const wasMobile = _cw < 480;
        _cw = w;
        const isMobile = _cw < 480;
        root.classList.toggle('uris-refs-mobile', isMobile);
        if (wasMobile !== isMobile) {
            // Переход desktop↔mobile: полный re-render с пересборкой layout.
            _mobileScreen = isMobile ? 'folders' : null;
            render(root);
        } else if (isMobile) {
            _renderMobileAll(root);
        } else {
            _renderAll(root);
        }
    });
```

Добавить переменную состояния и функции мобильной ветки (после `_renderOverlay`, перед `showPoolPicker`):

```js
// ── Mobile stack ──
let _mobileScreen = 'folders';  // 'folders' | 'grid' | 'card'

async function _renderMobileAll(root) {
    root.innerHTML = `
        <div class="uris-references uris-refs-mobile-stack">
            <div class="uris-mobile-screen" id="urisMobileScreen"></div>
        </div>`;
    if (_mobileScreen === 'folders') return _renderMobileFolders(root);
    if (_mobileScreen === 'grid')   return _renderMobileGrid(root);
    if (_mobileScreen === 'card')   return _renderMobileCard(root);
}

async function _renderMobileFolders(root) {
    const host = root.querySelector('#urisMobileScreen');
    if (!host) return;
    const [folders, refs] = await Promise.all([listFolders(), listRefs()]);
    const previewDots = (rs) => rs.slice(0, 3).map(r =>
        `<span class="uris-mobile-folder-thumb" style="background-image:url('${escapeHtml(r.imagePath)}')"></span>`
    ).join('');
    host.innerHTML = `
        <div class="uris-mobile-toolbar">
            <span class="uris-mobile-toolbar-title">Библиотека</span>
            <button class="menu_button uris-mobile-add-folder">+ Папка</button>
            <button class="menu_button uris-mobile-add-ref"><i class="fa-solid fa-plus"></i></button>
            <input type="file" class="uris-ref-file" accept="image/*" hidden>
        </div>
        <div class="uris-mobile-list">
            <button class="uris-mobile-folder-item" data-folder="all">
                <span class="uris-mobile-folder-icon">◈</span>
                <span class="uris-mobile-folder-name">Все карточки</span>
                <span class="uris-mobile-folder-count">${refs.length}</span>
                <span class="uris-mobile-folder-previews">${previewDots(refs)}</span>
                <span class="uris-mobile-folder-arrow">›</span>
            </button>
            ${folders.map(f => {
                const inFolder = filterRefsByFolder(refs, f.id);
                return `<button class="uris-mobile-folder-item" data-folder="${escapeHtml(f.id)}">
                    <span class="uris-folder-dot" style="background:${escapeHtml(f.color)}"></span>
                    <span class="uris-mobile-folder-name">${escapeHtml(f.name)}</span>
                    <span class="uris-mobile-folder-count">${inFolder.length}</span>
                    <span class="uris-mobile-folder-previews">${previewDots(inFolder)}</span>
                    <span class="uris-mobile-folder-arrow">›</span>
                </button>`;
            }).join('')}
        </div>`;
    host.querySelectorAll('.uris-mobile-folder-item').forEach(btn => {
        btn.addEventListener('click', () => {
            _activeFolderFilter = btn.dataset.folder;
            _mobileScreen = 'grid';
            _renderMobileAll(root);
        });
    });
    host.querySelector('.uris-mobile-add-folder')?.addEventListener('click', async () => {
        const name = await showInputModal('Имя папки:', 'Новая папка');
        if (!name) return;
        await createFolder(name);
        _renderMobileAll(root);
    });
    _bindMobileAddRef(host, root);
}

async function _renderMobileGrid(root) {
    const host = root.querySelector('#urisMobileScreen');
    if (!host) return;
    const [folders, refs] = await Promise.all([listFolders(), listRefs()]);
    const foldersById = new Map(folders.map(f => [f.id, f]));
    const filtered = filterRefsByFolder(refs, _activeFolderFilter);
    const activeFolder = folders.find(f => f.id === _activeFolderFilter);
    const title = _activeFolderFilter === 'all' ? 'Все карточки'
        : _activeFolderFilter === 'none' ? 'Без папки'
        : (activeFolder?.name || 'Папка');
    host.innerHTML = `
        <div class="uris-mobile-toolbar">
            <button class="uris-mobile-back" title="Назад">‹</button>
            ${activeFolder ? `<span class="uris-folder-dot" style="background:${escapeHtml(activeFolder.color)}"></span>` : ''}
            <span class="uris-mobile-toolbar-title">${escapeHtml(title)}</span>
            <span class="uris-mobile-folder-count">${filtered.length}</span>
            <button class="menu_button uris-mobile-add-ref"><i class="fa-solid fa-plus"></i></button>
            <input type="file" class="uris-ref-file" accept="image/*" hidden>
        </div>
        <div class="uris-pool-grid uris-mobile-grid" id="urisMobileGrid"></div>`;
    const grid = host.querySelector('#urisMobileGrid');
    if (!filtered.length) {
        grid.innerHTML = `<div class="uris-refs-empty">Нет карточек</div>`;
    } else {
        grid.innerHTML = filtered.map(r => {
            const role = r.role ? `<span class="uris-pool-tile-role">${escapeHtml(r.role)}</span>` : '';
            const dots = (r.folders || []).map(fid => foldersById.get(fid)).filter(Boolean)
                .slice(0, 3).map(f => `<span class="uris-pool-tile-dot" style="background:${escapeHtml(f.color)}"></span>`).join('');
            return `<div class="uris-pool-tile" data-ref-id="${escapeHtml(r.id)}">
                <img src="${escapeHtml(r.imagePath)}" alt="${escapeHtml(r.name)}" loading="lazy">
                ${role}
                ${dots ? `<div class="uris-pool-tile-dots">${dots}</div>` : ''}
                <div class="uris-pool-tile-name">${escapeHtml(r.name)}</div>
            </div>`;
        }).join('');
        grid.querySelectorAll('.uris-pool-tile').forEach(tile => {
            tile.addEventListener('click', () => {
                _editingRefId = tile.dataset.refId;
                _mobileScreen = 'card';
                _renderMobileAll(root);
            });
        });
    }
    host.querySelector('.uris-mobile-back')?.addEventListener('click', () => {
        _mobileScreen = 'folders';
        _renderMobileAll(root);
    });
    _bindMobileAddRef(host, root);
}

async function _renderMobileCard(root) {
    const host = root.querySelector('#urisMobileScreen');
    if (!host || !_editingRefId) return;
    const ref = await getRef(_editingRefId);
    if (!ref) { _editingRefId = null; _mobileScreen = 'grid'; return _renderMobileAll(root); }
    const folders = await listFolders();
    // Переиспользуем overlay-panel разметку редактора, но как full-screen.
    host.innerHTML = `
        <div class="uris-mobile-toolbar">
            <button class="uris-mobile-back" title="Назад">‹</button>
            <span class="uris-mobile-toolbar-title">${escapeHtml(ref.name || 'Без названия')}</span>
        </div>
        <div class="uris-mobile-card-scroll" id="urisMobileCardBody"></div>`;
    // Подставляем тот же editor-body, что в overlay. Чтобы не дублировать —
    // вызываем _renderOverlay на временный скрытый host и переносим innerHTML.
    // Проще: рендерим inline (минимальная дельта от _renderOverlay).
    const body = host.querySelector('#urisMobileCardBody');
    const aliasesStr = (ref.aliases || []).join(', ');
    const roleOptions = [['', 'Без роли'], ['char', 'char'], ['user', 'user'], ['npc', 'npc']]
        .map(([v, lbl]) => `<option value="${v}" ${ref.role === v || (!ref.role && !v) ? 'selected' : ''}>${lbl}</option>`).join('');
    const folderToggles = folders.map(f => {
        const active = (ref.folders || []).includes(f.id);
        return `<button class="uris-multifolder-toggle ${active ? 'on' : ''}" data-folder-id="${escapeHtml(f.id)}">
            <span class="uris-folder-dot" style="background:${escapeHtml(f.color)}"></span>
            <span class="uris-multifolder-name">${escapeHtml(f.name)}</span>
            ${active ? '<span class="uris-multifolder-check">✓</span>' : ''}
        </button>`;
    }).join('');
    body.innerHTML = `
        <img src="${escapeHtml(ref.imagePath)}" class="uris-editor-preview" alt="">
        <button class="menu_button uris-ed-replace"><i class="fa-solid fa-image"></i> Заменить картинку</button>
        <input type="file" class="uris-ed-file" accept="image/*" hidden>
        <label class="uris-ed-label">Имя</label>
        <input class="text_pole uris-ed-name" value="${escapeHtml(ref.name || '')}">
        <label class="uris-ed-label">Aliases</label>
        <input class="text_pole uris-ed-aliases" value="${escapeHtml(aliasesStr)}">
        <label class="uris-ed-label">Роль</label>
        <select class="text_pole uris-ed-role">${roleOptions}</select>
        <label class="uris-ed-label">Описание</label>
        <textarea class="text_pole uris-ed-desc" rows="3">${escapeHtml(ref.description || '')}</textarea>
        <label class="uris-ed-label">Папки</label>
        <div class="uris-multifolder-grid">${folderToggles || '<small class="uris-hint">Нет папок</small>'}</div>
        <button class="menu_button redText uris-ed-del"><i class="fa-solid fa-trash"></i> Удалить</button>`;
    // Биндим аналогично overlay (полная реализация ниже).
    _bindEditorBody(root, body, ref, folders, { onFolderChange: () => _renderMobileCard(root) });
    host.querySelector('.uris-mobile-back')?.addEventListener('click', () => {
        _mobileScreen = 'grid';
        _renderMobileAll(root);
    });
}

/** Биндит поля/кнопки редактора — общий для overlay-panel и mobile-card.
 *  host — элемент, содержащий .uris-ed-* поля.
 *  opts.onFolderChange — колбэк после смены папок (для re-render). */
function _bindEditorBody(root, host, ref, folders, opts = {}) {
    const nameInput = host.querySelector('.uris-ed-name');
    const aliasesInput = host.querySelector('.uris-ed-aliases');
    const roleInput = host.querySelector('.uris-ed-role');
    const descInput = host.querySelector('.uris-ed-desc');
    const saveBasic = async () => updateRef(ref.id, {
        name: nameInput.value,
        aliases: aliasesInput.value,
        role: roleInput.value || null,
        description: descInput.value,
    });
    nameInput.addEventListener('change', saveBasic);
    aliasesInput.addEventListener('change', saveBasic);
    roleInput.addEventListener('change', saveBasic);
    descInput.addEventListener('change', saveBasic);

    host.querySelectorAll('.uris-multifolder-toggle').forEach(btn => {
        btn.addEventListener('click', async () => {
            const fid = btn.dataset.folderId;
            const current = await getRef(ref.id);
            const set = new Set(current.folders || []);
            if (set.has(fid)) set.delete(fid); else set.add(fid);
            await updateRef(ref.id, { folders: [...set] });
            opts.onFolderChange?.();
        });
    });

    host.querySelector('.uris-ed-replace')?.addEventListener('click', () =>
        host.querySelector('.uris-ed-file')?.click());
    host.querySelector('.uris-ed-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const dataUrl = await readFileAsDataUrl(file);
            const compressed = await compressDataUrl(dataUrl);
            const path = await uploadReferenceImage(compressed.dataUrl, `ref_${ref.id}`);
            await updateRef(ref.id, { imagePath: path });
            const img = host.querySelector('.uris-editor-preview');
            if (img) img.src = path + '?t=' + Date.now();
        } catch (err) {
            toastr?.error?.('Не удалось заменить: ' + err.message);
        }
        e.target.value = '';
    });

    host.querySelector('.uris-ed-del')?.addEventListener('click', async () => {
        if (await showConfirmModal('Удалить референс из пула?')) {
            await deleteRef(ref.id);
            _editingRefId = null;
            _mobileScreen = 'grid';
            refreshActive();
        }
    });
}

function _bindMobileAddRef(host, root) {
    const fileInput = host.querySelector('.uris-ref-file');
    host.querySelector('.uris-mobile-add-ref')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const dataUrl = await readFileAsDataUrl(file);
            const compressed = await compressDataUrl(dataUrl);
            const path = await uploadReferenceImage(compressed.dataUrl, `ref_${Date.now()}`);
            const name = await showInputModal('Имя референса:', file.name.replace(/\.[^.]+$/, ''));
            if (!name) return;
            const folderIds = _activeFolderFilter !== 'all' && _activeFolderFilter !== 'none'
                ? [_activeFolderFilter] : [];
            const ref = await createRef({ name, imagePath: path, folders: folderIds });
            _editingRefId = ref.id;
            _mobileScreen = 'card';
            _renderMobileAll(root);
        } catch (err) {
            toastr?.error?.('Не удалось добавить референс');
        }
        e.target.value = '';
    });
}
```

- [ ] **Step 4: Рефакторинг `_bindOverlay` для переиспользования `_bindEditorBody`**

В `_bindOverlay` (Task 4 Step 4) заменить тело функции на делегирование общему биндеру:

```js
function _bindOverlay(root, host, ref, folders) {
    _bindEditorBody(root, host.querySelector('.uris-refs-overlay-body'), ref, folders, {
        onFolderChange: async () => {
            // Перерисовать overlay (обновить toggle-состояния) + sidebar + grid.
            await _renderOverlay(root, folders);
            _renderSidebar(root, folders, await listRefs());
            _renderGrid(root, folders);
        },
    });
    host.querySelector('.uris-refs-overlay-close')?.addEventListener('click', async () => {
        _editingRefId = null;
        await _renderAll(root);
    });
}
```

(Это устраняет дублирование между overlay и mobile-card.)

- [ ] **Step 5: Run mobile-тест**

Run: `node --test tests/tab-references.test.js`
Expected: PASS для всех 3 тестов.

- [ ] **Step 6: Node --check**

Run: `node --check src/ui/tab-references.js`

- [ ] **Step 7: Commit**

```bash
git add src/ui/tab-references.js tests/tab-references.test.js
git commit -m "feat(ui): refs mobile stack — folders/grid/card screens

Mobile layout (<480px) renders 3-screen stack: folder list → filtered
grid → card editor. Back navigation via ‹-button. Add-ref from any
screen creates card in active folder and jumps to card editor. Editor
body extracted to _bindEditorBody, shared with desktop overlay panel."
```

---

## Task 6: Обновить `showPoolPicker` под `folders[]` + `filterRefsByFolder`

**Files:**
- Modify: `src/ui/tab-references.js:222-298` (`showPoolPicker`)
- Test: `tests/tab-references.test.js`

- [ ] **Step 1: Написать падающий тест на picker с multi-folder**

Добавить в `tests/tab-references.test.js`:

```js
test('showPoolPicker: карточка в двух папках показывается в обеих', async () => {
    clearLocalforage();
    const { createFolder, createRef } = await import('../src/refs-library.js');
    const f1 = await createFolder('One');
    const f2 = await createFolder('Two');
    await createRef({ name: 'Multi', imagePath: '/m.png', folders: [f1.id, f2.id] });
    await createRef({ name: 'Only1', imagePath: '/o.png', folders: [f1.id] });

    const { showPoolPicker } = await import('../src/ui/tab-references.js');
    // Picker — Promise; резолвится по клику на "Готово". Симулируем DOM.
    const p = showPoolPicker({ title: 'T', multi: true });
    // Переключить фильтр на f1.id (первый пользовательский чип после all/none).
    const chips = [...document.querySelectorAll('.uris-folder-chip')];
    const f1Chip = chips.find(c => c.dataset.folder === f1.id);
    f1Chip?.click();
    let tiles1 = [...document.querySelectorAll('.uris-pool-tile')].map(t => t.dataset.refId);
    // f2 чип
    const f2Chip = chips.find(c => c.dataset.folder === f2.id);
    f2Chip?.click();
    let tiles2 = [...document.querySelectorAll('.uris-pool-tile')].map(t => t.dataset.refId);
    // Очистка: закрыть picker.
    document.querySelector('.uris-pick-cancel')?.click();
    await p;
    assert.ok(tiles1.length >= 1, 'в f1 есть карточки');
    assert.ok(tiles2.length >= 1, 'в f2 есть карточки');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tab-references.test.js`
Expected: FAIL или PASS в зависимости от того, успел ли старый picker отфильтровать по `folderId`. Скорее всего FAIL — старый код использует `r.folderId === pickerFilter`, а карточки теперь хранят `folders`.

- [ ] **Step 3: Обновить `showPoolPicker` в `src/ui/tab-references.js`**

Найти функцию `showPoolPicker` (оставшуюся из старого файла). Заменить логику фильтрации через `filterRefsByFolder`. Тело:

Было (строки ~224-298 в оригинальном файле):
```js
export async function showPoolPicker({ title = 'Выберите референсы', multi = true, excludeIds = [] } = {}) {
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
        // ... (остальное: renderGrid, renderFolders, click handlers)
    });
}
```

Стало (только изменения в `filteredRefs`):
```js
export async function showPoolPicker({ title = 'Выберите референсы', multi = true, excludeIds = [] } = {}) {
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
        const filteredRefs = () => filterRefsByFolder(allRefs, pickerFilter);
        // ... остальная разметка и хендлеры без изменений
    });
}
```

Остальное тело `showPoolPicker` (рендер сетки, кнопки OK/Cancel, чипы фильтра через `folderChipsHtml` — см. ниже) оставить как есть, **кроме**: функция `folderChipsHtml`, которая использовалась в picker, в новом `tab-references.js` (Task 4) уже удалена. Нужно либо вернуть её как helper, либо инлайнить чипы в picker. Самое чистое — добавить helper обратно:

В начало файла (после `let _editingRefId = null;`) добавить:
```js
/** HTML-строка чипов фильтра для picker-overlay. Используется только picker'ом. */
function _pickerFolderChips(folders, activeFilter) {
    const chip = (folderId, label) =>
        `<span class="uris-folder-chip ${activeFilter === folderId ? 'uris-folder-chip-on' : ''}" data-folder="${escapeHtml(folderId)}">${escapeHtml(label)}</span>`;
    return chip('all', 'Все') + chip('none', 'Без папки')
        + folders.map(f => chip(f.id, f.name)).join('');
}
```

В `showPoolPicker` заменить вызов `folderChipsHtml(...)` на `_pickerFolderChips(...)` (внутри `renderFolders`).

- [ ] **Step 4: Run тесты picker**

Run: `node --test tests/tab-references.test.js`
Expected: PASS для picker-теста.

- [ ] **Step 5: Regression: проверить, что вкладка Генерация не сломалась**

Run: `node --test tests/tab-generate.test.js tests/smoke.test.js`
Expected: PASS. `tab-generate.js` вызывает `showPoolPicker({ title, multi, excludeIds })` — сигнатура не менялась.

- [ ] **Step 6: Node --check**

Run: `node --check src/ui/tab-references.js`

- [ ] **Step 7: Commit**

```bash
git add src/ui/tab-references.js tests/tab-references.test.js
git commit -m "fix(ui): pool picker filters by multi-folder via filterRefsByFolder

showPoolPicker now uses filterRefsByFolder(allRefs, pickerFilter) instead
of direct r.folderId access; cards in multiple folders appear under each.
Inline picker chip helper _pickerFolderChips replaces removed folderChipsHtml.
Picker signature unchanged — tab-generate unaffected."
```

---

## Task 7: CSS — новые классы layout (sidebar / grid / overlay / mobile)

**Files:**
- Modify: `style.css:740-951` (старый блок refs)
- Reference: `Пример дизайна от фигма НЕ КОПИРОВАТЬ КОД, ПРОСТО СМОТРЕТЬ/src/App.tsx` + `src/index.css`

> Не копировать Tailwind-классы из Figma-референса напрямую. Перевести на наши токены `--uris-*` и классы `uris-*`.

- [ ] **Step 1: Заменить блок `.uris-references` / `.uris-refs-pool` на новый layout**

Найти строки 740-841 (от `Плотная сетка карточек 3:4...` до `.uris-pick-selected`). Заменить весь этот блок на:

```css
/* ── Вкладка «Референсы» — layout v4 (Figma) ──
   Десктоп: sidebar (148px) + main (toolbar + grid) + overlay-host.
   Мобайл: 3-экранный стек (см. .uris-refs-mobile). */
.uris-references { display: flex; flex: 1; min-height: 0; height: 100%; overflow: hidden; }
.uris-references.uris-refs-mobile-stack { flex-direction: column; }

/* ── Sidebar (десктоп) ── */
.uris-refs-sidebar {
    flex: 0 0 148px; width: 148px;
    display: flex; flex-direction: column;
    background: var(--uris-surface-tabs);
    border-right: 1px solid var(--uris-border-soft);
    overflow: hidden;
}
.uris-folder-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.uris-folder-item {
    display: flex; align-items: center; gap: 8px;
    width: 100%; padding: 6px 10px; background: none; border: none;
    color: var(--uris-text-mut); cursor: pointer; text-align: left;
    font-size: var(--uris-font-sm); transition: background .12s, color .12s;
}
.uris-folder-item:hover { color: var(--uris-text-strong); background: rgba(255,255,255,.03); }
.uris-folder-item.uris-folder-item-on {
    background: var(--uris-surface-btn); color: var(--uris-text-strong);
}
.uris-folder-dot {
    flex: 0 0 8px; width: 8px; height: 8px; border-radius: 50%;
    background: var(--uris-text-dim);
}
.uris-folder-dot-mute { background: var(--uris-text-dim); opacity: .5; }
.uris-folder-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uris-folder-count { font-size: var(--uris-font-xs); color: var(--uris-text-dim); }
.uris-folder-divider {
    padding: 8px 10px 4px; font-size: 9px; text-transform: uppercase;
    letter-spacing: .15em; color: var(--uris-text-dim);
}
.uris-folder-add {
    flex-shrink: 0; padding: 8px 10px; margin: 4px; border-radius: var(--uris-radius);
    border: 1px dashed var(--uris-border); color: var(--uris-text-dim);
    cursor: pointer; font-size: var(--uris-font-xs); text-align: center;
    transition: color .12s, border-color .12s;
}
.uris-folder-add:hover { color: var(--uris-text-strong); border-color: var(--uris-border); }

/* ── Main (toolbar + grid) ── */
.uris-refs-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.uris-refs-toolbar {
    display: flex; align-items: center; gap: 6px;
    padding: 6px var(--uris-pad); flex-shrink: 0;
    border-bottom: 1px solid var(--uris-border-soft);
}
.uris-refs-search { flex: 1; min-width: 0; }
.uris-refs-search input {
    width: 100%; padding: 4px 8px; font-size: var(--uris-font-sm);
    background: var(--uris-surface-btn); border: 1px solid var(--uris-border);
    border-radius: var(--uris-radius); color: var(--uris-text-strong);
    outline: none;
}
.uris-refs-search input:focus { border-color: var(--uris-accent); }
.uris-refs-add {
    flex: 0 0 auto; padding: 4px 12px; border-radius: var(--uris-radius-pill);
    background: transparent; color: var(--uris-accent);
    border: 1px solid var(--uris-accent); cursor: pointer;
    font-size: var(--uris-font-sm); white-space: nowrap;
}
.uris-refs-add:hover { background: var(--uris-accent-soft); }
.uris-refs-grid-wrap { flex: 1; min-height: 0; overflow: hidden; }

/* ── Карточки 3:4 (без изменений в правилах, но переезд в .uris-refs-grid-wrap) ── */
.uris-pool-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
    grid-auto-rows: min-content; align-items: start;
    gap: var(--uris-gap); padding: var(--uris-pad);
    overflow-y: auto; flex: 1; min-height: 0;
    -webkit-overflow-scrolling: touch;
}
.uris-refs-empty {
    grid-column: 1 / -1; text-align: center;
    color: var(--uris-text-dim); padding: 32px 8px; font-size: var(--uris-font-sm);
}
.uris-pool-tile {
    position: relative; border-radius: var(--uris-radius-card);
    overflow: hidden; cursor: pointer;
    background: var(--uris-surface-card); border: 1px solid transparent;
    transition: border-color .12s; display: block; isolation: isolate;
    aspect-ratio: 3 / 4; align-self: start;
}
.uris-pool-tile:hover { border-color: var(--uris-accent); }
.uris-pool-tile-selected { border-color: var(--uris-accent); }
.uris-pool-tile:focus, .uris-pool-tile:focus-visible { outline: none; }
.uris-pool-tile img {
    position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; display: block; background: var(--uris-surface-card);
}
.uris-pool-tile-name {
    position: absolute !important; left: 0; right: 0; bottom: 0; z-index: 2;
    font-size: 9px; line-height: 1.2; padding: 16px 4px 4px;
    text-align: center; color: #fff; font-weight: 500;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    background: linear-gradient(to top, rgba(0,0,0,.82) 30%, rgba(0,0,0,0));
    pointer-events: none;
}
.uris-pool-tile-role {
    position: absolute; top: 3px; left: 3px; z-index: 2;
    font-size: 8px; line-height: 1; padding: 2px 4px;
    border-radius: var(--uris-radius); background: rgba(0,0,0,.65);
    color: #fff; text-transform: lowercase; pointer-events: none;
}
.uris-pool-tile-dots {
    position: absolute; left: 3px; bottom: 18px; z-index: 2;
    display: flex; gap: 2px; pointer-events: none;
}
.uris-pool-tile-dot { width: 5px; height: 5px; border-radius: 50%; }
.uris-pick-selected { outline: 2px solid var(--uris-accent); outline-offset: -2px; }

/* ── Overlay panel (редактор) ── */
.uris-refs-overlay-host { flex: 0 0 0; }
.uris-refs-overlay-host.uris-refs-overlay-open {
    flex: 0 0 260px; width: 260px;
    border-left: 1px solid var(--uris-border-soft);
    background: var(--uris-surface-card); overflow: hidden;
    display: flex; flex-direction: column;
}
.uris-refs-overlay-panel { display: flex; flex-direction: column; height: 100%; }
.uris-refs-overlay-head {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; border-bottom: 1px solid var(--uris-border-soft);
    flex-shrink: 0;
}
.uris-refs-overlay-title {
    flex: 1; font-size: var(--uris-font-sm); color: var(--uris-text-strong);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.uris-refs-overlay-close {
    background: none; border: none; color: var(--uris-text-dim);
    cursor: pointer; font-size: 14px; padding: 2px 6px;
}
.uris-refs-overlay-close:hover { color: var(--uris-text-strong); }
.uris-refs-overlay-body {
    flex: 1; overflow-y: auto; padding: 10px;
    display: flex; flex-direction: column; gap: 4px;
}
.uris-editor-preview {
    width: 100%; max-height: 220px; object-fit: cover;
    border-radius: var(--uris-radius-card); margin-bottom: 8px;
}
.uris-ed-label {
    font-size: 9px; text-transform: uppercase; letter-spacing: .15em;
    color: var(--uris-text-dim); margin-top: 4px;
}
.uris-hint { font-size: var(--uris-font-xs); color: var(--uris-text-dim); }

/* Multi-folder toggle grid */
.uris-multifolder-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 4px;
    margin-bottom: 8px;
}
.uris-multifolder-toggle {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 8px; border-radius: var(--uris-radius);
    background: var(--uris-surface-btn); border: 1px solid var(--uris-border-soft);
    color: var(--uris-text-mut); cursor: pointer; text-align: left;
    font-size: var(--uris-font-sm); transition: all .12s;
}
.uris-multifolder-toggle.on {
    background: var(--uris-surface-card); color: var(--uris-text-strong);
    border-color: var(--uris-border);
}
.uris-multifolder-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uris-multifolder-check { font-size: var(--uris-font-xs); color: var(--uris-accent); }

/* ── Чипы фильтра (используются только в picker-overlay) ── */
.uris-refs-chips { display: flex; gap: 6px; flex: 1; min-width: 0; flex-wrap: wrap; }
.uris-folder-chip {
    flex: 0 0 auto; padding: 4px 12px; border-radius: var(--uris-radius-pill);
    background: var(--uris-surface-btn); color: var(--uris-text-mut);
    cursor: pointer; font-size: var(--uris-font-sm); user-select: none;
    border: 1px solid transparent; white-space: nowrap;
    transition: background .12s, color .12s;
}
.uris-folder-chip:hover { color: var(--uris-text-strong); }
.uris-folder-chip.uris-folder-chip-on { background: var(--uris-accent); color: #fff; }
```

- [ ] **Step 2: Добавить мобильный CSS**

После блока (перед существующим `@media (max-width: 768px)` для picker на ~880) добавить:

```css
/* ── Mobile stack ── */
.uris-refs-mobile-stack { display: flex; flex-direction: column; height: 100%; }
.uris-mobile-screen { display: flex; flex-direction: column; height: 100%; }
.uris-mobile-toolbar {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border-bottom: 1px solid var(--uris-border-soft);
    flex-shrink: 0;
}
.uris-mobile-toolbar-title {
    flex: 1; font-size: var(--uris-font); color: var(--uris-text-strong);
    font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.uris-mobile-back {
    background: none; border: none; color: var(--uris-text-mut);
    cursor: pointer; font-size: 18px; padding: 2px 6px;
}
.uris-mobile-back:hover { color: var(--uris-text-strong); }
.uris-mobile-list {
    flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px;
}
.uris-mobile-folder-item {
    display: flex; align-items: center; gap: 10px; width: 100%;
    padding: 10px; border-radius: var(--uris-radius-card);
    background: var(--uris-surface-card); border: 1px solid var(--uris-border-soft);
    color: var(--uris-text-strong); cursor: pointer; text-align: left;
}
.uris-mobile-folder-item:active { background: var(--uris-surface-btn); }
.uris-mobile-folder-icon { color: var(--uris-text-dim); }
.uris-mobile-folder-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uris-mobile-folder-count { font-size: var(--uris-font-xs); color: var(--uris-text-dim); }
.uris-mobile-folder-previews { display: flex; gap: 2px; }
.uris-mobile-folder-thumb {
    width: 28px; height: 36px; border-radius: 3px;
    background-size: cover; background-position: center;
    background-color: var(--uris-surface-btn);
}
.uris-mobile-folder-arrow { color: var(--uris-text-dim); }
.uris-mobile-grid { flex: 1; }
.uris-mobile-card-scroll { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 4px; }
```

- [ ] **Step 3: Обновить picker-overlay CSS — чипы picker'а на сайдбар-стиль (опционально, cosmetic)**

В существующих правилах `.uris-picker-dialog .uris-refs-filterbar` ничего не менять — picker остаётся модалкой с чипами (визуально согласованно с тем, что picker отдельный сценарий).

- [ ] **Step 4: Проверить, что нет orphan-классов**

Run: `grep -n "uris-refs-pool\b\|uris-refs-add-folder\b" style.css src/`
Ожидается: 0 совпадений (старые классы удалены).

- [ ] **Step 5: Node --check на JS (на всякий случай — CSS не влияет, но проверим, что таб не упал)**

Run: `node --check src/ui/tab-references.js`

- [ ] **Step 6: Commit**

```bash
git add style.css
git commit -m "style(refs): CSS for sidebar + grid + overlay + mobile stack

Replaces chip-filterbar layout with Figma-style 3-pane layout: 148px
sidebar (dots + counts), toolbar+grid main, 260px overlay panel for
editor. Mobile 3-screen stack CSS. Multi-folder toggle grid. Old
.uris-refs-pool / .uris-refs-add-folder classes removed."
```

---

## Task 8: Cosmetic-проход по остальным вкладкам (токены + отступы)

**Files:**
- Modify: `style.css` — косметика `.uris-window`, `.uris-header`, `.uris-tabs`, `.uris-tab`, `.uris-row` (где есть хардкод-цвета)
- Modify: `src/ui/tab-api.js`, `src/ui/tab-generate.js`, `src/ui/tab-gallery.js`, `src/ui/tab-templates.js` — только inline-стили → токены (если есть)

> Структура полей, event-хендлеры, accordion-состояния — НЕ ТРОГАТЬ.

- [ ] **Step 1: Найти хардкод-цвета вне refs-блока**

Run:
```bash
grep -nE '#[0-9a-fA-F]{3,6}' style.css | grep -vE '^\s*[0-9]+:.*(refs|pool|folder|mobile|sidebar|overlay|multifolder)' | head -40
```
Также проверить inline-стили в JS:
```bash
grep -nE 'style="[^"]*#[0-9a-fA-F]{3,6}' src/ui/*.js | head -20
```

Ожидается: единичные хардкоды вроде `#fc6`, `#6cf` (source-bar в refs panel на generate), `rgba(0,0,0,.X)` для overlays — это OK;opaque-цвета элементов, которые должны быть в цвете ST-темы, заменить на токены.

- [ ] **Step 2: Заменить хардкод-поверхности на токены**

Для каждой находки типа `background: #1e1e1e` (вне refs-блока) заменить на `var(--uris-surface-card)`. Для `border-color: #3a3a3a` — `var(--uris-border)`. Для текстовых `#888` / `#666` / `#d4d4d4` — соответствующие текстовые токены.

Пример (если в `.uris-window` где-то стоял хардкод `background: #1c1c1c` — уже заменён в ранних правках; проверить, что нигде не осталось).

- [ ] **Step 3: Не трогать цветные source-bars в refs panel (generate)**

`#fc6` (char), `#6cf` (user), `#888` (npc) — это семантические цвета ролей, оставляем как есть (они не тема-зависимы).

- [ ] **Step 4: Regression — UI-тесты**

Run: `node --test tests/tab-api-reference-options.test.js tests/tab-generate.test.js tests/tab-templates.test.js tests/smoke.test.js tests/tab-interactive-css.test.js`
Expected: PASS. Если падает на assertions по цветам — это явный сигнал, что тест хардкодил цвет; обновить assertion под токен (или проверить, что fallback тот же).

- [ ] **Step 5: Визуальный smoke (заметки для ручной проверки)**

Открыть окно в ST, пройти по 5 вкладкам. Ожидания:
- Все вкладки — единый нейтрально-серый фон поверхностей.
- Акцент (зелёный в дефолтной теме) — там, где он и должен быть (активная вкладка, кнопки действия, фокус-бордеры).
- Переключить ST-тему с другим акцентом — подсветка следует за темой.
- Отступы/радиусы — единый ритм (`--uris-pad`, `--uris-gap`, `--uris-radius`).

- [ ] **Step 6: Commit**

```bash
git add style.css src/ui/tab-api.js src/ui/tab-generate.js src/ui/tab-gallery.js src/ui/tab-templates.js
git commit -m "style: cosmetic pass — hardcoded colors → tokens across tabs

Neutral surfaces/borders/text replaced by --uris-* tokens in window,
header, tabs, rows. Semantic role colors (char/user/npc source-bars)
kept. Structure and event handlers untouched."
```

---

## Task 9: Smoke + обновление CHANGELOG

**Files:**
- Modify: `tests/smoke.test.js` (если проверяет refs-структуру)
- Modify: `docs/changelog.md`

- [ ] **Step 1: Smoke-тест: refs tab отрисовывается без ошибок**

Если в `tests/smoke.test.js` есть assertions про refs (проверить: `grep -n "refs\|references" tests/smoke.test.js`):
- Обновить селекторы со старых классов (`.uris-refs-pool`) на новые (`.uris-refs-sidebar`, `.uris-refs-grid-wrap`).
- Добавить минимальный assertion:

```js
test('smoke: refs tab renders sidebar + grid', async () => {
    const { render } = await import('../src/ui/tab-references.js');
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { value: 600, configurable: true });
    document.body.appendChild(root);
    await render(root);
    assert.ok(root.querySelector('.uris-refs-sidebar'));
    assert.ok(root.querySelector('#urisRefsGrid'));
    document.body.removeChild(root);
});
```

- [ ] **Step 2: Полный прогон тестов**

Run: `node --test tests/*.test.js`
Expected: PASS (или легаси-упоминания `folderId` в `pool-only-*` тестах — проверить, не падают ли; если падают на чтении `ref.folderId` — обновить на `ref.folders`).

- [ ] **Step 3: Добавить CHANGELOG entry**

Найти `docs/changelog.md`. Добавить сверху:

```md
## 2026-07-19 — Редизайн вкладки «Референсы» под Figma

- **Layout**: сайдбар папок (148px, с цветными dot'ами и счётчиками) + плотная сетка карточек 3:4 + overlay-панель редактора справа (260px, открывается по клику на карточку, остаётся открытой при переборе).
- **Мульти-папки**: карточка теперь состоит в нескольких папках сразу (`folders: string[]`). Старые записи с моно-`folderId` авто-апгрейдятся при чтении — миграция не нужна, без потерь.
- **Цвета папок**: палитра из 10 цветов, назначается циклически при создании. Dot в сайдбаре, dots (5px) внизу карточек.
- **Мобильный стек** (<480px): 3-экранная навигация «список папок → сетка → редактор» с кнопкой ‹ назад.
- **Multi-folder toggle** в редакторе: grid 2×N с цветными dot'ами, чек-марки.
- **Picker overlay** (`showPoolPicker`): фильтрация переведена на `filterRefsByFolder`, карточки в нескольких папках показываются в каждой из них. Сигнатура не изменилась — вкладка Генерация не затронута.
- **Cosmetic-проход** по остальным вкладкам: хардкод-цвета заменены на `--uris-*` токены, сохранена адаптивность к ST-теме.
- **Адаптив**: `ResizeObserver` на ширине вкладки определяет desktop/mobile (точка 480px), а не `window.innerWidth`.
```

- [ ] **Step 4: Commit**

```bash
git add tests/smoke.test.js docs/changelog.md
git commit -m "test+docs: refs redesign smoke + changelog

Smoke test asserts new refs tab structure (sidebar + grid). Changelog
documents multi-folder migration, colored folders, overlay panel, mobile
stack, and cosmetic token pass."
```

---

## Self-Review

**1. Spec coverage** (4 утверждённых решения):

- ✅ **Мульти-папки с авто-миграцией при чтении** — Task 1 (`folderId → folders[]` в `normalizePoolReference`, идемпотентно, без скриптов). Подтверждено: legacy-запись с `folderId: 'abc'` читается как `folders: ['abc']`, существующие ID/aliases/описание/роль не теряются. Task 1 Step 5 — `deleteFolder` правильно чистит массив.
- ✅ **Overlay-панель редактора** — Task 4 Step 4 (`_renderOverlay`, `uris-refs-overlay-host`), CSS Task 7 Step 1 (`.uris-refs-overlay-host`, 260px, выезжает при `.uris-refs-overlay-open`). Открытие по клику на тайл, остаётся открытым при переборе.
- ✅ **Цвета папок (dot в сайдбаре + dots на карточках)** — Task 2 (модель: `color`, палитра, `normalizeFolder`); Task 4 Step 4 (`_renderSidebar` рендерит `.uris-folder-dot` с инлайн-цветом; `_renderGrid` рендерит `.uris-pool-tile-dots`); CSS Task 7 Step 1 (`.uris-folder-dot`, `.uris-pool-tile-dot`).
- ✅ **Cosmetic-проход по остальным вкладкам** — Task 8 (хардкод → токены, без структурных изменений, семантические цвета ролей сохранены).

Доп. покрытие:
- ✅ **Mobile-стек** — Task 5 (3 экрана, навигация ‹, add-ref с любого экрана). Решение «Overlay-панель редактора» относилось к десктопу; mobile из Figma-референса тоже реализован, как более чистая альтернатива bottom-sheet-модалке для нашей ширины.
- ✅ **Picker overlay** — Task 6 (`filterRefsByFolder`, helper `_pickerFolderChips`, сигнатура неизменна для tab-generate).
- ✅ **Адаптив через ResizeObserver** — Task 4 Step 4 (`_setupResize`, точка 480px).

**2. Placeholder scan:**
- Нет TODO/TBD/"implement later".
- Каждый шаг содержит код (либо grep-команду с ожидаемым результатом).
- Имена классов, функций, переменных консистентны между задачами:
  - `_renderAll` / `_renderSidebar` / `_renderToolbar` / `_renderGrid` / `_renderOverlay` — Task 4, переиспользуются в Task 5 (resize-обработчик).
  - `_bindEditorBody` — Task 5 Step 3 (определён), Task 5 Step 4 (используется в `_bindOverlay`).
  - `filterRefsByFolder(refs, filter)` — Task 3 (определён), Task 4/5/6 (используется).
  - `_pickerFolderChips(folders, filter)` — Task 6 Step 3 (определён и применён).
  - `_activeFolderFilter`, `_editingRefId`, `_cw`, `_mobileScreen` — определены в Task 4, переиспользуются в Task 5.
  - CSS-классы: `.uris-folder-dot`, `.uris-pool-tile-dots`, `.uris-multifolder-toggle` — определены в JS Task 4/5, стилизованы в CSS Task 7.

**3. Type consistency:**
- `createFolder(name, opts?)` — Task 2 Step 5; вызовы `createFolder(name)` без opts валидны (opts = {}).
- `updateRef(id, { folders })` — Task 1 Step 4; вызовы в Task 4/5 передают `{ folders: [...set] }` — массив, ОК.
- `filterRefsByFolder(refs, 'all'|'none'|string)` — Task 3; вызовы в Task 4 (`_renderSidebar` использует `filterRefsByFolder(refs, f.id)`), Task 6 (`filterRefsByFolder(allRefs, pickerFilter)`) — соответствуют.
- `getRef(id)` / `listRefs()` / `listFolders()` — без изменений сигнатур.
- `showPoolPicker({ title, multi, excludeIds })` — без изменений, tab-generate не ломается.

**4. Зоны риска** (отмечены в задачах):
- `LF_REFS_POOL` / `LF_REFS_FOLDERS` реальные ключи — Step 1 Task 1 и Task 2 предписывают проверить через `grep` и подставить. Если ключ другой — тесты будут падать; исполнитель должен поправить строку в тесте.
- `_helpers.js` API (`setupSillyTavernStub` / `clearLocalforage`) — Step 1 Task 4 предписывает проверить; если функции названы иначе — адаптировать по паттерну `tab-templates.test.js`.
- ResizeObserver в jsdom — fallback `_cw = root.clientWidth || 600` (Task 4 Step 4) + тесты выставляют `clientWidth` через `Object.defineProperty`.

---

## End-of-plan note

После Task 9 — полный прогон `node --test tests/*.test.js`, затем ручная визуальная проверка в ST по чек-листам из Task 8 Step 5 и Task 9. Если в ручной проверке всплывают мелочи (отступы, точные формулировки empty-state, цвета палитры) — отдельным косметическим коммитом, без новой задачи.
