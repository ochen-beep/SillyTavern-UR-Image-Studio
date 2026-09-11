# URIS Inline Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Инлайн-генерация в основном чате: URIS распознаёт маркеры `[[тип: описание]]` и ключевые слова в сообщениях, генерирует картинки через существующее платное ядро и рисует оболочки прямо в сообщениях — отдельным движком, не смешанным с двухстадийным пайплайном.

**Architecture:** Один инлайн-движок в `src/inline/*` для основного чата (скан `mes` → идемпотентные задачи в `chatMetadata.uris_inline` → DOM-оболочки с реконсиляцией). Общие примитивы с остальным URIS: `generateImageRequest`, резолвер референсов, галерея, диагностика, звуки. Мост получает `URIS.parseInline(text)` и параметр `trigger` у `generate` — хосты (Offstage) используют те же trigger-профили. LLM в тракте инлайна не вызывается: промпт = обёртка профиля + описание, макросы разворачивает `resolveSTMacros`.

**Tech Stack:** Vanilla ES-модули (как весь URIS), Node built-in test runner, fake-dom для DOM-тестов, localforage/chatMetadata через `SillyTavern.getContext()` (mock в тестах).

**Зафиксированные решения (обсуждены с заказчиком):** режимы «авто и ручное» одновременно; дневного лимита НЕТ; реролл = замена; ключевые слова юзера выключены по умолчанию; никакого обучения LLM (инжекты запрещены) и гардероба; оболочка M1 фиксированная (темы — M2); реролл-варианты — M2; `extra.image`-гибрид — M2.

**Терминология:** маркер = `[[тип: описание]]`; триггер/профиль = `{id, aliases, aspect, prefix, suffix, refsPolicy}`; item = запись результата в `chatMetadata.uris_inline`; оболочка = DOM-узел в сообщении.

---

## File Structure

```
src/inline/grammar.js      — чистый парсер маркеров (без зависимостей от ST)
src/inline/triggers.js     — реестр профилей: дефолты, нормализация, алиас-индекс
src/inline/store.js        — слоты результатов в chatMetadata.uris_inline (+ per-chat cfg)
src/autolane.js            — общая сериальная цепочка (мост + инлайн)
src/inline/runner.js       — оркестрация задачи: промпт → рефы → generateImageRequest → галерея → store
src/inline/scanner.js      — подписки на события ST, дедуп, решение «что делать с маркером»
src/inline/render.js       — DOM-оболочки, реконсиляция, ручная 📷-кнопка, PhotoSwipe
src/ui/tab-media.js        — вкладка «Медиа»: тумблеры, редактор триггеров, стенд, лента
src/bridge.js              — +parseInline на поверхности, +trigger у generate (через autolane)
src/core.js                — дефолты настроек (inlineEnabled, listenUserMessages, inlineTriggers)
index.js                   — инициализация сканера, регистрация вкладки
tests/inline-*.test.js     — тесты каждого чистого модуля
```

---

### Task 1: Грамматика маркеров — `src/inline/grammar.js`

**Files:**
- Create: `src/inline/grammar.js`
- Test: `tests/inline-grammar.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/inline-grammar.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline } from '../src/inline/grammar.js';

test('grammar: parses type and description', () => {
    const m = parseInline('го смотри [[img: чашка кофе, пепел от сигаретки]] ща скину');
    assert.equal(m.length, 1);
    assert.equal(m[0].type, 'img');
    assert.equal(m[0].desc, 'чашка кофе, пепел от сигаретки');
    assert.equal(m[0].raw, '[[img: чашка кофе, пепел от сигаретки]]');
    assert.ok(m[0].start < m[0].end);
});

test('grammar: fast-path returns empty array without [[', () => {
    assert.deepEqual(parseInline('обычный текст без маркеров'), []);
    assert.deepEqual(parseInline(''), []);
    assert.deepEqual(parseInline(null), []);
});

test('grammar: multiple markers with offsets', () => {
    const m = parseInline('[[selfie: beach at sunset]] и [[scene: rainy neon city]]');
    assert.equal(m.length, 2);
    assert.equal(m[0].type, 'selfie');
    assert.equal(m[1].type, 'scene');
    assert.ok(m[0].end <= m[1].start);
});

test('grammar: cyrillic and digits in type, case-insensitive', () => {
    const m = parseInline('[[СЕЛФИ: портрет]]');
    assert.equal(m[0].type, 'селфи');
});

test('grammar: negative cases produce no markers', () => {
    assert.deepEqual(parseInline('[[img нет двоеточия]]'), []);
    assert.deepEqual(parseInline('[[img:]]'), []);                    // пустое описание
    assert.deepEqual(parseInline('[[тип с пробелом: описание]]'), []);
    assert.deepEqual(parseInline('[[img: не закрыта'), []);
    assert.equal(parseInline('[[img:]][[scene: ok]]').length, 1);   // пустое описание пропущено
});

test('grammar: markers inside code fences are ignored', () => {
    const text = 'текст\n```\n[[img: в коде]]\n```\n[[scene: настоящий]]';
    const m = parseInline(text);
    assert.equal(m.length, 1);
    assert.equal(m[0].type, 'scene');
});

test('grammar: description length guard (600 chars)', () => {
    const long = 'x'.repeat(601);
    assert.deepEqual(parseInline(`[[img: ${long}]]`), []);
    assert.equal(parseInline(`[[img: ${'x'.repeat(600)}]]`).length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/inline-grammar.test.js`
Expected: FAIL — «Cannot find module '../src/inline/grammar.js'»

- [ ] **Step 3: Write implementation**

```js
// src/inline/grammar.js
// @ts-check
/**
 * Грамматика инлайн-маркеров: `[[тип: описание]]`.
 * Чистый модуль без зависимостей от SillyTavern — используется движком чата,
 * мостом (URIS.parseInline) и тестами. Тип — [a-zа-яё0-9_-]{1,24} (case-insensitive,
 * ё→е), описание — 1..600 символов без `[`/`]`. Маркеры внутри code-fence (```)
 * игнорируются.
 */

const MARKER_RE = /\[\[\s*([a-zа-яё0-9_-]{1,24})\s*:\s*([^\[\]]{1,600}?)\s*\]\]/gi;
const MAX_DESC = 600;

function normalizeType(rawType) {
    return String(rawType || '').toLowerCase().replaceAll('ё', 'е');
}

/** Диапазоны code-fence ``` … ``` в тексте. */
function codeFenceRanges(text) {
    const ranges = [];
    const re = /```[\s\S]*?(?:```|$)/g;
    let m;
    while ((m = re.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
    return ranges;
}

function inRanges(pos, ranges) {
    return ranges.some(([a, b]) => pos >= a && pos < b);
}

/**
 * @param {string} text
 * @returns {Array<{type:string, desc:string, raw:string, start:number, end:number}>}
 */
export function parseInline(text) {
    if (typeof text !== 'string' || text.length === 0 || !text.includes('[[')) return [];
    const fences = codeFenceRanges(text);
    /** @type {Array<{type:string, desc:string, raw:string, start:number, end:number}>} */
    const out = [];
    MARKER_RE.lastIndex = 0;
    let m;
    while ((m = MARKER_RE.exec(text)) !== null) {
        if (inRanges(m.index, fences)) continue;
        const desc = m[2].trim();
        if (!desc) continue;
        out.push({
            type: normalizeType(m[1]),
            desc,
            raw: m[0],
            start: m.index,
            end: m.index + m[0].length,
        });
    }
    return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/inline-grammar.test.js`
Expected: PASS (все кейсы)

- [ ] **Step 5: Commit**

```bash
git add src/inline/grammar.js tests/inline-grammar.test.js
git commit -m "feat(inline): marker grammar parser [[type: description]]"
```

---

### Task 2: Реестр триггер-профилей — `src/inline/triggers.js`

**Files:**
- Create: `src/inline/triggers.js`
- Modify: `src/core.js` (дефолты — в конце Task 9, здесь модуль самодостаточен)
- Test: `tests/inline-triggers.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/inline-triggers.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_TRIGGERS, normalizeTrigger, buildAliasIndex, resolveProfile,
    buildInlinePrompt, sanitizeTriggerList,
} from '../src/inline/triggers.js';

test('triggers: defaults include img/selfie/scene with correct shape', () => {
    const ids = DEFAULT_TRIGGERS.map(t => t.id);
    assert.deepEqual(ids, ['img', 'selfie', 'scene']);
    const selfie = DEFAULT_TRIGGERS.find(t => t.id === 'selfie');
    assert.equal(selfie.aspect, '9:16');
    assert.equal(selfie.refsPolicy, 'auto');
    assert.ok(selfie.prefix.includes('{{char}}'));
});

test('triggers: normalizeTrigger clamps and defaults', () => {
    const t = normalizeTrigger({ id: ' X ', name: 'Тест', aliases: ['Алиас', '', 'алиас2'],
        aspect: '9:16', prefix: 'p ', suffix: ' s', refsPolicy: 'weird' });
    assert.equal(t.id, 'x');                       // id нормализуется в lower/trim
    assert.deepEqual(t.aliases, ['алиас', 'алиас2']);
    assert.equal(t.refsPolicy, 'auto');            // невалидная политика → auto
    assert.equal(t.prefix, 'p');
    assert.equal(t.suffix, 's');
    assert.throws(() => normalizeTrigger({ aliases: [] }), /aliases/);
});

test('triggers: alias index resolves type→profile, ё/регистр', () => {
    const idx = buildAliasIndex(DEFAULT_TRIGGERS);
    assert.equal(resolveProfile(idx, 'СЕЛФИ').id, 'selfie');
    assert.equal(resolveProfile(idx, 'img').id, 'img');
    assert.equal(resolveProfile(idx, 'неизвестный'), null);
});

test('triggers: buildInlinePrompt = prefix + macros(desc) + suffix', () => {
    const selfie = DEFAULT_TRIGGERS.find(t => t.id === 'selfie');
    const prompt = buildInlinePrompt(selfie, 'на пляже', { charName: 'Илюха' });
    assert.ok(prompt.startsWith('candid phone selfie of Илюха'));
    assert.ok(prompt.includes('на пляже'));
});

test('triggers: sanitizeTriggerList dedups ids/aliases, keeps at least img', () => {
    const list = sanitizeTriggerList([
        { id: 'img', name: 'Картинка', aliases: ['img'], aspect: '1:1', prefix: '', suffix: '', refsPolicy: 'auto' },
        { id: 'IMG', name: 'Дубль', aliases: ['img'], aspect: '2:3', prefix: '', suffix: '', refsPolicy: 'off' },
        { id: 'ok', name: 'Ок', aliases: ['ок'], aspect: '3:4', prefix: '', suffix: '', refsPolicy: 'auto' },
    ]);
    assert.equal(list.length, 2);
    assert.equal(list[0].aspect, '1:1');           // первый wins по id
    assert.ok(list.some(t => t.id === 'ok'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/inline-triggers.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```js
// src/inline/triggers.js
// @ts-check
/**
 * Реестр триггер-профилей инлайна. Профили глобальные (общие для чат-движка
 * и моста: bridge `generate({trigger})` резолвится сюда). Хранение списка —
 * в state.settings.inlineTriggers (Task 9); здесь — чистые операции.
 */

export const REFS_POLICIES = ['auto', 'off'];

export const DEFAULT_TRIGGERS = Object.freeze([
    Object.freeze({
        id: 'img', name: 'Картинка',
        aliases: ['img', 'image', 'картинка', 'фото'],
        aspect: '1:1', prefix: '', suffix: '',
        refsPolicy: 'auto',
    }),
    Object.freeze({
        id: 'selfie', name: 'Селфи',
        aliases: ['selfie', 'селфи'],
        aspect: '9:16',
        prefix: 'candid phone selfie of {{char}}, ',
        suffix: ', natural lighting, authentic phone camera look',
        refsPolicy: 'auto',
    }),
    Object.freeze({
        id: 'scene', name: 'Сцена',
        aliases: ['scene', 'сцена', 'фон'],
        aspect: '16:9',
        prefix: 'cinematic establishing shot, ',
        suffix: '',
        refsPolicy: 'off',
    }),
]);

const ID_RE = /^[a-zа-яё0-9_-]{1,24}$/;

/** Нормализация одной записи; бросает при отсутствии алиасов/невалидном id. */
export function normalizeTrigger(data = {}) {
    const id = String(data.id || '').trim().toLowerCase().replaceAll('ё', 'е');
    if (!ID_RE.test(id)) throw new Error('trigger id invalid');
    const aliases = [...new Set((Array.isArray(data.aliases) ? data.aliases : [])
        .map(a => String(a || '').trim().toLowerCase())
        .filter(Boolean))];
    if (!aliases.length) throw new Error('trigger aliases required');
    const policy = REFS_POLICIES.includes(data.refsPolicy) ? data.refsPolicy : 'auto';
    return {
        id, name: String(data.name || '').trim() || id, aliases,
        aspect: String(data.aspect || '1:1').trim(),
        prefix: String(data.prefix || '').trim(),
        suffix: String(data.suffix || '').trim(),
        refsPolicy: policy,
    };
}

/** Список: нормализация, дедуп по id (первый wins), id `img` гарантированно есть. */
export function sanitizeTriggerList(list) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
        let t;
        try { t = normalizeTrigger(raw); } catch { continue; }
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        out.push(t);
    }
    if (!seen.has('img')) out.unshift(normalizeTrigger(DEFAULT_TRIGGERS[0]));
    return out;
}

/** Алиас (lower, ё→е) → профиль. */
export function buildAliasIndex(triggers) {
    const idx = new Map();
    for (const t of triggers) for (const a of t.aliases) if (!idx.has(a)) idx.set(a, t);
    return idx;
}

export function resolveProfile(aliasIndex, type) {
    return aliasIndex.get(String(type || '').toLowerCase().replaceAll('ё', 'е')) || null;
}

/**
 * Промпт инлайна: prefix + описание + suffix, макросы ST разворачиваются.
 * @param {{prefix:string, suffix:string}} trigger
 * @param {string} desc
 * @param {{charName?: string, userName?: string}} [macroFallback]
 */
export function buildInlinePrompt(trigger, desc, macroFallback = {}) {
    const expand = (s) => {
        let out = String(s || '');
        const charName = macroFallback.charName || '{{char}}';
        const userName = macroFallback.userName || '{{user}}';
        out = out.replaceAll('{{char}}', charName).replaceAll('{{user}}', userName);
        return out;
    };
    return `${expand(trigger.prefix)}${String(desc || '').trim()}${expand(trigger.suffix)}`.trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/inline-triggers.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/inline/triggers.js tests/inline-triggers.test.js
git commit -m "feat(inline): trigger profile registry with defaults img/selfie/scene"
```

---

### Task 3: Хранение результатов — `src/inline/store.js`

**Files:**
- Create: `src/inline/store.js`
- Test: `tests/inline-store.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/inline-store.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Мок SillyTavern/chatMetadata до импорта модуля (паттерн settings-tab.test.js)
let metadata = {};
let saved = 0;
globalThis.SillyTavern = {
    getContext: () => ({
        chatMetadata: metadata,
        saveMetadataDebounced: () => { saved++; },
    }),
};

const { getSlot, upsertItem, getConfig, setConfig, dropMessage } = await import('../src/inline/store.js');

beforeEach(() => { metadata = {}; saved = 0; });

test('store: empty metadata → empty slot', () => {
    assert.deepEqual(getSlot(5), { messageHash: null, items: [] });
});

test('store: upsertItem creates slot and updates item by (idx,type,descHash)', () => {
    upsertItem(5, { idx: 0, type: 'selfie', descHash: 'aa', status: 'pending' });
    upsertItem(5, { idx: 0, type: 'selfie', descHash: 'aa', status: 'ready', imagePath: 'p.png' });
    const slot = getSlot(5);
    assert.equal(slot.items.length, 1);
    assert.equal(slot.items[0].status, 'ready');
    assert.ok(saved > 0, 'saveMetadataDebounced вызван');
});

test('store: messageHash stored alongside items', () => {
    upsertItem(7, { idx: 0, type: 'img', descHash: 'bb', status: 'pending' }, { messageHash: 'h1' });
    assert.equal(getSlot(7).messageHash, 'h1');
});

test('store: config per chat', () => {
    assert.deepEqual(getConfig(), { enabled: false, listenUser: false });
    setConfig({ enabled: true, listenUser: true });
    assert.deepEqual(getConfig(), { enabled: true, listenUser: true });
});

test('store: dropMessage removes slot', () => {
    upsertItem(9, { idx: 0, type: 'img', descHash: 'cc', status: 'ready' });
    dropMessage(9);
    assert.deepEqual(getSlot(9).items, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/inline-store.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```js
// src/inline/store.js
// @ts-check
/**
 * Слоты инлайн-результатов в chatMetadata текущего чата:
 *   chatMetadata.uris_inline = { v: 1, cfg: {enabled, listenUser}, msgs: { [msgId]: {messageHash, items[]} } }
 * Идемпотентность: перезагрузка находит item по (idx,type,descHash) и не
 * перегенерирует. chatMetadata уезжает с экспортом чата; на машине без файлов
 * картинок оболочка покажет «файл недоступен — перегенерировать?» (рендер).
 */

const KEY = 'uris_inline';
const SCHEMA_V = 1;

function meta() {
    const ctx = globalThis.SillyTavern?.getContext?.() || {};
    const md = ctx.chatMetadata;
    if (!md || typeof md !== 'object') return null;
    if (!md[KEY] || typeof md[KEY] !== 'object') md[KEY] = { v: SCHEMA_V, cfg: { enabled: false, listenUser: false }, msgs: {} };
    const store = md[KEY];
    if (!store.msgs || typeof store.msgs !== 'object') store.msgs = {};
    if (!store.cfg || typeof store.cfg !== 'object') store.cfg = { enabled: false, listenUser: false };
    return store;
}

function persist() {
    try { globalThis.SillyTavern?.getContext?.()?.saveMetadataDebounced?.(); } catch { /* тесты */ }
}

/** Слот сообщения (или пустой). msgId приводится к строке-ключу. */
export function getSlot(msgId) {
    const store = meta();
    const slot = store?.msgs?.[String(msgId)];
    if (!slot) return { messageHash: null, items: [] };
    return {
        messageHash: slot.messageHash ?? null,
        items: Array.isArray(slot.items) ? slot.items : [],
    };
}

/**
 * Вставить/обновить item по ключу (idx,type,descHash); опционально обновить
 * messageHash слота. Возвращает сохранённый item.
 */
export function upsertItem(msgId, item, { messageHash } = {}) {
    const store = meta();
    if (!store) return null;
    const key = String(msgId);
    const slot = store.msgs[key] || (store.msgs[key] = { messageHash: messageHash ?? null, items: [] });
    if (messageHash != null) slot.messageHash = messageHash;
    const k = itemKey(item);
    const existing = slot.items.find(i => itemKey(i) === k);
    if (existing) Object.assign(existing, item);
    else slot.items.push({ ...item });
    persist();
    return existing || slot.items[slot.items.length - 1];
}

/** Ключ сопоставления item'ов. */
export function itemKey(item) {
    return `${item.idx}|${item.type}|${item.descHash}`;
}

export function getConfig() {
    const store = meta();
    return { enabled: false, listenUser: false, ...(store?.cfg || {}) };
}

export function setConfig(patch) {
    const store = meta();
    if (!store) return getConfig();
    store.cfg = { ...store.cfg, ...patch };
    persist();
    return { ...store.cfg };
}

/** Удалить слот сообщения (MESSAGE_DELETED). */
export function dropMessage(msgId) {
    const store = meta();
    if (!store?.msgs) return;
    delete store.msgs[String(msgId)];
    persist();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/inline-store.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/inline/store.js tests/inline-store.test.js
git commit -m "feat(inline): chatMetadata-backed result store with per-chat config"
```

---

### Task 4: Автолейн — `src/autolane.js` + перевод моста на него

**Files:**
- Create: `src/autolane.js`
- Modify: `src/bridge.js` (локальная `_chain` → autolane)
- Test: `tests/autolane.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/autolane.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueAutoLane } from '../src/autolane.js';

test('autolane: serializes tasks in enqueue order', async () => {
    const order = [];
    const p1 = enqueueAutoLane(async () => { await new Promise(r => setTimeout(r, 30)); order.push(1); return 'a'; });
    const p2 = enqueueAutoLane(async () => { order.push(2); return 'b'; });
    assert.deepEqual(order, []);                    // ничего не стартовало синхронно? (стартало p1)
    assert.equal(await p1, 'a');
    assert.equal(await p2, 'b');
    assert.deepEqual(order, [1, 2]);
});

test('autolane: rejection does not poison the lane', async () => {
    await assert.rejects(enqueueAutoLane(async () => { throw Object.assign(new Error('x'), { code: 'E' }); }),
        e => e.code === 'E');
    const r = await enqueueAutoLane(async () => 'after');
    assert.equal(r, 'after');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/autolane.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```js
// src/autolane.js
// @ts-check
/**
 * Автолейн — общая серийная цепочка для АВТОМАТИЧЕСКОЙ генерации:
 * инлайн-задачи чата + все мостовые вызовы. Один платный POST автоматики
 * за раз; ручная генерация и пачечная очередь живут в своих лейнах как раньше.
 */

let _chain = Promise.resolve();

/**
 * Поставить задачу в автолейн. Задача стартует по завершении предыдущей
 * (независимо от её успеха). Возвращает промис самой задачи.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function enqueueAutoLane(fn) {
    const pending = _chain.then(fn, fn);
    _chain = pending.catch(() => {});
    return pending;
}
```

- [ ] **Step 4: Rewire bridge.js to the shared lane**

В `src/bridge.js` заменить локальную цепочку на autolane:

```js
// было (bridge.js, модульный уровень):
// let _chain = Promise.resolve();
// ... в generate():
// const pending = _chain.then(run, run);
// _chain = pending.catch(() => {});
// return pending;
```

```js
// стало:
import { enqueueAutoLane } from './autolane.js';
// ... в generate() (хвост функции):
return enqueueAutoLane(run);
```

Удалить объявления `_chain` и комментарий «Serial by default…» заменить на
«Serial via shared autolane (bridge + inline)».

- [ ] **Step 5: Run tests**

Run: `node --test tests/autolane.test.js tests/bridge.test.js`
Expected: PASS (обе группы)

- [ ] **Step 6: Commit**

```bash
git add src/autolane.js src/bridge.js tests/autolane.test.js
git commit -m "feat(core): shared autolane; bridge queue moves onto it"
```

---

### Task 5: Мост — `URIS.parseInline` и параметр `trigger` у `generate`

**Files:**
- Modify: `src/bridge.js`
- Modify: `tests/bridge.test.js` (дополнить)
- Test: `tests/bridge.test.js` (новые кейсы)

- [ ] **Step 1: Write the failing tests** (добавить в конец `tests/bridge.test.js`)

```js
test('bridge: parseInline resolves profiles via trigger registry', async () => {
    const bridge = activateBridge();
    try {
        const markers = bridge.parseInline('смотри [[селфи: на пляже]] и [[img: чашка]]');
        assert.equal(markers.length, 2);
        assert.equal(markers[0].type, 'селфи');
        assert.equal(markers[0].profile?.id, 'selfie');
        assert.equal(markers[0].profile?.aspect, '9:16');
        assert.equal(markers[1].profile?.id, 'img');
        // неизвестный тип → profile null (хост решает: img-fallback или скрыть)
        const unknown = bridge.parseInline('[[бред: x]]');
        assert.equal(unknown[0].profile, null);
    } finally { deactivateBridge(); }
});

test('bridge: generate with unknown trigger → TRIGGER_NOT_FOUND', async () => {
    const bridge = activateBridge();
    try {
        await assert.rejects(
            () => bridge.generate({ trigger: 'несуществует', prompt: 'x' }, { caller: 'lab' }),
            e => e instanceof UrisBridgeError && e.code === 'TRIGGER_NOT_FOUND',
        );
    } finally {
        deactivateBridge();
        assert.equal(globalThis.URIS, undefined);
    }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bridge.test.js`
Expected: FAIL — `bridge.parseInline is not a function`

- [ ] **Step 3: Implement в `src/bridge.js`**

Импорты:

```js
import { parseInline } from './inline/grammar.js';
import { buildAliasIndex, resolveProfile, sanitizeTriggerList, buildInlinePrompt } from './inline/triggers.js';
import { DEFAULT_TRIGGERS } from './inline/triggers.js';
```

Резолв профиля и применение trigger в `generateOnce` (до блока «Reference pipeline»,
после `dispatchOpts`):

```js
        // Trigger-профиль (опционально): приносит aspect/shell/refsPolicy из реестра.
        let aspect = norm.aspect;
        let basePromptSource = norm.prompt;
        let refsPolicyOverride = null;           // 'off' форсит отказ от авторефов
        if (norm.trigger) {
            const registry = sanitizeTriggerList(state.settings?.inlineTriggers || DEFAULT_TRIGGERS);
            const profile = registry.find(t => t.id === norm.trigger);
            if (!profile) throw bridgeError('TRIGGER_NOT_FOUND',
                `Unknown trigger "${norm.trigger}". Known: ${registry.map(t => t.id).join(', ')}`);
            aspect = profile.aspect || aspect;
            basePromptSource = buildInlinePrompt(profile, norm.prompt);
            if (profile.refsPolicy === 'off') refsPolicyOverride = 'off';
        }
```

Дальше по тексту `generateOnce` заменить использование `norm.prompt` на
`basePromptSource` (строка `let basePrompt = norm.expandMacros === false ? norm.prompt : resolveSTMacros(norm.prompt);`
→ `let basePrompt = norm.expandMacros === false ? basePromptSource : resolveSTMacros(basePromptSource);`)
и `aspectRatio: norm.aspect` → `aspectRatio: aspect`. В блоке `useSceneRefs`
учесть форс: `if (norm.useSceneRefs && refsPolicyOverride !== 'off') {…}`
(если `refsPolicy === 'off'` у профиля и юзер не просил useSceneRefs явно —
совпадение: при `norm.useSceneRefs===true && refsPolicyOverride==='off'`
профиль побеждает — документируем в коде комментарием «профиль строже»).

В `normalizeBridgeRequest` добавить:

```js
    const trigger = typeof req.trigger === 'string' && req.trigger.trim() ? req.trigger.trim() : null;
    // ... вернуть trigger в результате
```

На поверхность (`activateBridge`, в freeze-объект) добавить:

```js
        parseInline: (text) => {
            const registry = sanitizeTriggerList(state.settings?.inlineTriggers || DEFAULT_TRIGGERS);
            const idx = buildAliasIndex(registry);
            return parseInline(text).map(m => ({ ...m, profile: resolveProfile(idx, m.type) }));
        },
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/bridge.test.js`
Expected: PASS (все, включая старые)

- [ ] **Step 5: Commit**

```bash
git add src/bridge.js tests/bridge.test.js
git commit -m "feat(bridge): parseInline surface + trigger profiles in generate"
```

---

### Task 6: Движок — решение сканера и промпт (чистое ядро) — `src/inline/runner.js` (часть 1)

**Files:**
- Create: `src/inline/runner.js` (только чистые функции; оркестрация — Task 7)
- Test: `tests/inline-runner.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/inline-runner.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planScan, buildJobPlan } from '../src/inline/runner.js';
import { parseInline } from '../src/inline/grammar.js';

const MODE = { auto: true };

test('planScan: new marker in auto mode → queue', () => {
    const markers = parseInline('ответ [[img: чашка кофе]]');
    const actions = planScan({ msgId: 5, messageHash: 'h1', markers, stored: { messageHash: null, items: [] }, auto: true });
    assert.deepEqual(actions.map(a => a.action), ['store-pending', 'queue']);
});

test('planScan: same marker+hash ready → render only (перезагрузка бесплатна)', () => {
    const markers = parseInline('ответ [[img: чашка кофе]]');
    const stored = { messageHash: 'h1', items: [{ idx: 0, type: 'img', descHash: 'h2', status: 'ready', imagePath: 'p.png' }] };
    // descHash = hash('чашка кофе') — считается внутри planScan; здесь подменяем согласованно:
    const actions = planScan({ msgId: 5, messageHash: 'h1', markers, stored, auto: true, hashFn: (s) => s });
    assert.deepEqual(actions.map(a => a.action), ['render-ready']);
});

test('planScan: desc changed → render-changed, no auto generation', () => {
    const markers = parseInline('ответ [[img: новое описание]]');
    const stored = { messageHash: 'h1', items: [{ idx: 0, type: 'img', descHash: 'old', status: 'ready', imagePath: 'p.png' }] };
    const actions = planScan({ msgId: 5, messageHash: 'h1', markers, stored, auto: true, hashFn: (s) => s });
    assert.deepEqual(actions.map(a => a.action), ['render-changed']);
});

test('planScan: manual mode → render-button for new markers', () => {
    const markers = parseInline('ответ [[img: чашка]]');
    const actions = planScan({ msgId: 5, messageHash: 'h1', markers, stored: { messageHash: null, items: [] }, auto: false, hashFn: (s) => s });
    assert.deepEqual(actions.map(a => a.action), ['render-button']);
});

test('planScan: cap markers per message (default 3)', () => {
    const markers = parseInline('[[img: a]] [[img: b]] [[img: c]] [[img: d]]');
    const actions = planScan({ msgId: 1, messageHash: 'h', markers, stored: { messageHash: null, items: [] }, auto: true, hashFn: (s) => s, cap: 3 });
    assert.equal(actions.filter(a => a.action === 'queue').length, 3);
    assert.equal(actions.filter(a => a.action === 'render-button').length, 1); // сверх лимита — кнопки
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/inline-runner.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation (чистая часть)**

```js
// src/inline/runner.js — верх файла
// @ts-check
/**
 * Оркестрация инлайн-задач. Чистые функции (planScan, buildJobPlan) покрыты
 * тестами; побочные эффекты (generateImageRequest, store, DOM) — в
 * processJob/dispatchScan (Task 7) с инъекцией зависимостей.
 */
import { parseInline } from './grammar.js';

function stableHash(str) {
    // FNV-1a 32-bit, hex — достаточно для descHash (дедуп, не криптография)
    let h = 0x811c9dc5;
    const bytes = new TextEncoder().encode(String(str || ''));
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return (h >>> 0).toString(16);
}

/**
 * Решение по одному сообщению.
 * @param {{msgId:number|string, messageHash:string, markers:Array, stored:{messageHash:string|null, items:Array}, auto:boolean, hashFn?:Function, cap?:number}} input
 * @returns {Array<{action:'store-pending'|'queue'|'render-ready'|'render-changed'|'render-button'|'render-error', marker:object, item:object}>}
 */
export function planScan({ msgId, messageHash, markers, stored, auto, hashFn = stableHash, cap = 3 }) {
    const actions = [];
    const items = stored.items || [];
    markers.forEach((marker, idx) => {
        if (idx >= cap) { actions.push({ action: 'render-button', marker, item: null }); return; }
        const descHash = hashFn(`${marker.type}|${marker.desc}`);
        const key = `${idx}|${marker.type}|${descHash}`;
        const item = items.find(i => `${i.idx}|${i.type}|${i.descHash}` === key);
        if (item && item.status === 'ready') { actions.push({ action: 'render-ready', marker, item }); return; }
        if (item && item.status === 'error') { actions.push({ action: 'render-error', marker, item }); return; }
        if (item && item.status === 'pending') { actions.push({ action: 'render-ready', marker, item }); return; } // уже в работе (другой проход)
        // item нет, либо desc изменился → changed поверх старой картинки
        const changed = items.some(i => `${i.idx}|${i.type}` === `${idx}|${marker.type}` && i.descHash !== descHash);
        if (changed) { actions.push({ action: 'render-changed', marker, item: items.find(i => `${i.idx}|${i.type}` === `${idx}|${marker.type}`) }); return; }
        if (!auto) { actions.push({ action: 'render-button', marker, item: null }); return; }
        const pendingItem = { idx, type: marker.type, descHash, status: 'pending', imagePath: null, cardId: null, requestId: null, error: null, createdAt: Date.now() };
        actions.push({ action: 'store-pending', marker, item: pendingItem });
        actions.push({ action: 'queue', marker, item: pendingItem });
    });
    return actions;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/inline-runner.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/inline/runner.js tests/inline-runner.test.js
git commit -m "feat(inline): scan planner — idempotent marker decisions"
```

---

### Task 7: Движок — оркестрация и интеграции — `src/inline/runner.js` (часть 2) + `scanner.js`

**Files:**
- Modify: `src/inline/runner.js` (дописать `processJob`, `dispatchScan`)
- Create: `src/inline/scanner.js`
- Modify: `src/inline/triggers.js` (+`triggerAliases` экспорт)
- Test: `tests/inline-runner.test.js` (дополнить чистым `buildJobPlan`)

- [ ] **Step 1: Write the failing test (чистая часть: сборка промпта и рефов)**

```js
// дополнить tests/inline-runner.test.js
import { buildJobPlan } from '../src/inline/runner.js';
import { normalizeTrigger } from '../src/inline/triggers.js';

test('buildJobPlan: prompt = shell + macros, refs policy off → без резолвера', () => {
    const trigger = normalizeTrigger({ id: 'scene', name: 'Сцена', aliases: ['scene'],
        aspect: '16:9', prefix: 'cinematic shot, ', suffix: '', refsPolicy: 'off' });
    const plan = buildJobPlan({ trigger, desc: 'ночной город', macros: { charName: 'Илюха' } });
    assert.equal(plan.prompt, 'cinematic shot, ночной город');
    assert.equal(plan.aspect, '16:9');
    assert.equal(plan.refs, null);                 // refsPolicy off → авторефов нет
});

test('buildJobPlan: refs auto → флаг авто-референсов', () => {
    const trigger = normalizeTrigger({ id: 'img', name: 'К', aliases: ['img'], aspect: '1:1',
        prefix: '', suffix: '', refsPolicy: 'auto' });
    const plan = buildJobPlan({ trigger, desc: 'чашка кофе' });
    assert.equal(plan.refs, 'auto');
});
```

- [ ] **Step 2: Run to verify FAIL, затем дописать в `src/inline/runner.js`:**

```js
// src/inline/runner.js — продолжение
import { state, getCtx, abortGeneration } from '../core.js';
import { resolveChatConfigSnapshot, buildCandidates } from '../pipeline-config.js';
import { resolvePromptReferenceContext } from '../scene-context.js';
import { imageToDataUrl, summarizeReference } from '../references.js';
import { composeReferencePrompt } from '../reference-binding.js';
import { generateImageRequest } from '../image-api.js';
import { addCard } from '../gallery-index.js';
import { recordDiagnosticEvent } from '../diagnostic-events.js';
import { resolveSTMacros } from '../template-runtime.js';
import { enqueueAutoLane } from '../autolane.js';
import { upsertItem, getSlot } from './store.js';
import { parseInline } from './grammar.js';
import { sanitizeTriggerList, buildAliasIndex, resolveProfile, buildInlinePrompt } from './triggers.js';

/** Чистое: собрать план задачи (промпт/аспект/политика рефов). */
export function buildJobPlan({ trigger, desc, macros = {} }) {
    const prompt = buildInlinePrompt(trigger, desc, macros);
    return {
        prompt,
        aspect: trigger.aspect || '1:1',
        refs: trigger.refsPolicy === 'off' ? null : 'auto',
    };
}

function triggerRegistry() {
    return sanitizeTriggerList(state.settings?.inlineTriggers || []);
}

/**
 * Платная задача инлайна. Сериализация — автолейн; контроллер регистрируется
 * в state.activeGenerations (Stop таверны накрывает), requestId `inl_<uuid>`.
 */
export async function processJob({ msgId, idx, type, desc }) {
    const trigger = resolveProfile(buildAliasIndex(triggerRegistry()), type);
    if (!trigger) throw Object.assign(new Error(`Unknown inline trigger "${type}"`), { code: 'TRIGGER_NOT_FOUND' });
    const requestId = `inl_${crypto.randomUUID()}`;
    const controller = new AbortController();
    state.activeGenerations.set(requestId, controller);
    recordDiagnosticEvent({ event: 'inline-start', requestId, details: { msgId, idx, type } });

    const macroFallback = (() => {
        try {
            const ctx = getCtx();
            return { charName: ctx?.characters?.[ctx.characterId]?.name, userName: ctx?.name1 };
        } catch { return {}; }
    })();
    const plan = buildJobPlan({ trigger, desc, macros: macroFallback });

    try {
        const snapshot = await resolveChatConfigSnapshot();
        const connId = snapshot.imageProfileId;
        if (!connId) throw Object.assign(new Error('No image connection'), { code: 'NO_CONNECTION' });

        // Референсы по политике профиля (зеркало bridge.generateOnce, M1-урезанное)
        let references = [];
        let referenceBindings = [];
        if (plan.refs === 'auto') {
            const candidates = await buildCandidates(state.currentChatId || 'current');
            const resolution = await resolvePromptReferenceContext({
                prompt: plan.prompt, candidates,
                corrections: { includedIds: [], excludedIds: [], revision: 0 },
            });
            for (const r of resolution.stage2Refs || []) {
                if (r.bindingMode === 'description') {
                    referenceBindings.push({ name: r.name, description: r.description, bindingMode: 'description' });
                    continue;
                }
                const dataUrl = await imageToDataUrl(r.imagePath);
                if (dataUrl && !references.some(x => x.id === r.id)) references.push({ id: r.id, name: r.name, dataUrl });
            }
        }

        const result = await generateImageRequest(connId, {
            requestId,
            prompt: plan.prompt,
            aspectRatio: plan.aspect,
            references,
            referenceBindings,
            chatId: state.currentChatId ?? null,
            sourceMsgId: msgId,
        }, () => {}, controller.signal, {});

        const entry = result?.galleryEntry || {};
        upsertItem(msgId, {
            idx, type, descHash: stableHash(`${type}|${desc}`),
            status: 'ready', imagePath: entry.imagePath ?? null,
            cardId: entry.id ?? null, requestId, error: null, createdAt: Date.now(),
        });
        recordDiagnosticEvent({ event: 'inline-end', requestId, outcome: 'ready', details: { msgId, type, cardId: entry.id ?? null } });
        try { window.dispatchEvent(new CustomEvent('uris:inline-end', { detail: { requestId, msgId, idx, type, imagePath: entry.imagePath } })); } catch { /* node */ }
        return { requestId, imagePath: entry.imagePath ?? null, cardId: entry.id ?? null };
    } catch (e) {
        const cancelled = controller.signal.aborted || e?.name === 'AbortError';
        upsertItem(msgId, {
            idx, type, descHash: stableHash(`${type}|${desc}`),
            status: cancelled ? 'error' : 'error', imagePath: null, cardId: null, requestId,
            error: cancelled ? 'aborted' : (e?.code || e?.message || String(e)), createdAt: Date.now(),
        });
        recordDiagnosticEvent({ event: 'inline-end', requestId, outcome: cancelled ? 'cancelled' : 'error',
            details: { msgId, type, code: e?.code || null } });
        if (cancelled && e?.code == null) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
        throw e;
    } finally {
        state.activeGenerations.delete(requestId);
        try { window.dispatchEvent(new CustomEvent('uris:inline-end', { detail: { requestId, msgId, idx, type } })); } catch { /* node */ }
    }
}

/** Задача через автолейн (сериально с мостом). */
export function queueInlineJob(job) {
    return enqueueAutoLane(() => processJob(job));
}

/**
 * Ручной перезапуск (реролл/retry): старая картинка остаётся в галерее,
 * item перезаписывается новой генерацией.
 */
export function rerollInline(job) {
    return queueInlineJob(job);
}

export { parseInline, getSlot, abortGeneration, stableHash };
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/inline-runner.test.js`
Expected: PASS (чистые кейсы; импорты боковых модулей node-safe — как у bridge.test.js)

- [ ] **Step 4: Create `src/inline/scanner.js`**

```js
// src/inline/scanner.js
// @ts-check
/**
 * Сканер: подписки на события ST, дедуп (запущенный скан сообщения не
 * перезапускается), вызов planScan → store/queue/render-колбэки.
 * DOM не трогает — рендер подписан на uris:inline-* события и сам реконсилит.
 */
import { state, getCtx } from '../core.js';
import { hashMessage } from '../generation-drafts.js';
import { parseInline } from './grammar.js';
import { buildAliasIndex, sanitizeTriggerList, triggerAliases } from './triggers.js';
import { getSlot, upsertItem, getConfig, dropMessage } from './store.js';
import { planScan, queueInlineJob } from './runner.js';

let _handlers = null;
const _inFlight = new Set();

function inlineActive() {
    return state.settings?.inlineEnabled === true && getConfig().enabled === true;
}

/** Скан одного сообщения: решение planScan → store/queue. Рендер — событиями. */
export async function scanMessage(msgId) {
    if (!inlineActive()) return;
    const ctx = getCtx();
    const mes = ctx.chat?.[msgId]?.mes;
    if (typeof mes !== 'string') return;
    const key = String(msgId);
    if (_inFlight.has(key)) return;
    _inFlight.add(key);
    try {
        const markers = parseInline(mes);
        if (!markers.length) return;
        const messageHash = hashMessage(mes);
        const stored = getSlot(msgId);
        const cfg = getConfig();
        const actions = planScan({ msgId, messageHash, markers, stored, auto: true });
        for (const a of actions) {
            if (a.action === 'store-pending') {
                upsertItem(msgId, { ...a.item }, { messageHash });
                try { window.dispatchEvent(new CustomEvent('uris:inline-update', { detail: { msgId: Number(msgId) } })); } catch { /* node */ }
            } else if (a.action === 'queue') {
                queueInlineJob({ msgId: Number(msgId), idx: a.item.idx, type: a.marker.type, desc: a.marker.desc })
                    .catch(() => { /* статус уже в store; рендер подхватит */ });
            }
        }
        try { window.dispatchEvent(new CustomEvent('uris:inline-update', { detail: { msgId: Number(msgId) } })); } catch { /* node */ }
    } finally {
        _inFlight.delete(key);
    }
}

export function scannerActive() { return _handlers != null; }

/** Подписки. Идемпотентно; обработчики хранятся по ссылкам (removeListener). */
export function bindScanner() {
    if (_handlers) return;
    const ctx = getCtx();
    if (!ctx?.eventSource || !ctx?.event_types) return;
    const et = ctx.event_types;
    _handlers = {
        ended: () => { const i = ctx.chat?.length ? ctx.chat.length - 1 : null; if (i != null) scanMessage(i); },
        swiped: (i) => scanMessage(typeof i === 'number' ? i : ctx.chat?.length - 1),
        edited: (i) => scanMessage(typeof i === 'number' ? i : null),
        deleted: () => { /* слот чистится по событию MESSAGE_DELETED ниже */ },
        chatChanged: () => { /* рендер реконсилит сам по uris:inline-update */ },
        deleted: (i) => dropMessage(typeof i === 'number' ? i : null),
        userSent: (i) => {
            if (!getConfig().listenUser) return;
            const text = String(ctx.chat?.[i]?.mes || '');
            const idx = buildAliasIndex(sanitizeTriggerList(state.settings?.inlineTriggers || []));
            const hit = triggerAliases(idx, text);
            if (hit) scanUserMessage(i, hit);
        },
    };
    ctx.eventSource.makeLast(et.GENERATION_ENDED, _handlers.ended);
    ctx.eventSource.on(et.MESSAGE_SWIPED, _handlers.swiped);
    ctx.eventSource.on(et.MESSAGE_EDITED, _handlers.edited);
    ctx.eventSource.on(et.MESSAGE_SENT, _handlers.userSent);
    ctx.eventSource.on(et.MESSAGE_DELETED, _handlers.deleted);
}

export function unbindScanner() {
    const ctx = getCtx();
    if (_handlers && ctx?.eventSource) {
        const et = ctx.event_types;
        try { ctx.eventSource.removeListener(et.GENERATION_ENDED, _handlers.ended); } catch {}
        try { ctx.eventSource.removeListener(et.MESSAGE_SWIPED, _handlers.swiped); } catch {}
        try { ctx.eventSource.removeListener(et.MESSAGE_EDITED, _handlers.edited); } catch {}
        try { ctx.eventSource.removeListener(et.MESSAGE_SENT, _handlers.userSent); } catch {}
        try { ctx.eventSource.removeListener(et.MESSAGE_DELETED, _handlers.deleted); } catch {}
    }
    _handlers = null;
}

/** Скан сообщения юзера: алиас найден → описание = текст без слова-триггера. */
async function scanUserMessage(msgId, hit) {
    const ctx = getCtx();
    const text = String(ctx.chat?.[msgId]?.mes || '');
    const desc = text.replace(new RegExp(hit.alias, 'iu'), '').replace(/\s+/g, ' ').trim()
        || `{{char}} photo`;
    queueInlineJob({ msgId: Number(msgId), idx: 0, type: hit.profile.id, desc })
        .catch(() => {});
}
```

Дополнить `src/inline/triggers.js` экспортом, который использует сканер:

```js
/** Первый алиас, встреченный в тексте (для key-word триггера юзера). */
export function triggerAliases(aliasIndex, text) {
    const t = String(text || '');
    for (const [alias, profile] of aliasIndex) {
        if (!alias) continue;
        const re = new RegExp(`(^|[^\\p{L}])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'iu');
        if (re.test(t)) return { alias, profile };
    }
    return null;
}
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/inline-runner.test.js tests/inline-triggers.test.js tests/inline-store.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/inline/runner.js src/inline/scanner.js src/inline/triggers.js tests/inline-runner.test.js
git commit -m "feat(inline): runner orchestration + ST event scanner"
```

---

### Task 8: Рендер оболочек и 📷-кнопка — `src/inline/render.js`

**Files:**
- Create: `src/inline/render.js`
- Test: `tests/inline-render.test.js` (fake-dom, по образцу `accordion-state.test.js`)

- [ ] **Step 1: Write the failing test (чистая реконсиляция)**

```js
// tests/inline-render.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

let doc;
beforeEach(() => { doc = makeFakeDocument().document; globalThis.document = doc; });

const { computeShellPlan } = await import('../src/inline/render.js');

test('render: computeShellPlan — какие оболочки нужны сообщению', () => {
    const existing = [
        { key: '0|img|aa', status: 'ready' },
    ];
    const plan = computeShellPlan({
        msgId: 5,
        markers: [{ start: 0, end: 10, raw: '[[img: a]]', type: 'img', desc: 'a' }],
        items: [{ idx: 0, type: 'img', descHash: 'aa', status: 'ready', imagePath: 'p.png' }],
        hashFn: (s) => s,
        existingKeys: existing.map(e => e.key),
    });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].key, '0|img|aa');
    assert.equal(plan[0].domAction, 'keep');
});
```

- [ ] **Step 2: Run to verify FAIL, затем реализовать `src/inline/render.js`:**

```js
// src/inline/render.js
// @ts-check
/**
 * DOM-слой инлайна: оболочки в сообщениях (реконсиляция по data-uris-inl),
 * ручная 📷-кнопка в .mes_buttons, клик → showSingleImage (PhotoSwipe),
 * реролл = замена (старая остаётся в галерее). Стили — инлайн + 2 класса
 * в style.css (uris-inl-shell, uris-inl-badge).
 */
import { getCtx } from '../core.js';
import { parseInline } from './grammar.js';
import { getSlot } from './store.js';
import { sanitizeTriggerList, buildAliasIndex, resolveProfile } from './triggers.js';
import { stableHash } from './runner.js';
import { showSingleImage } from '../ui/lightbox.js';

const SHELL_ATTR = 'data-uris-inl';
let _observer = null;
let _reroll = null; // инъекция зависимости (runner.processJob), ставится initRender

export function initRender({ reroll }) {
    _reroll = reroll;
    if (_observer) return;
    _observer = new MutationObserver(debounce(() => reconcileVisible(), 250));
    const chat = document.getElementById('chat');
    if (chat) _observer.observe(chat, { childList: true, subtree: true });
    reconcileVisible();
}

export function shutdownRender() {
    _observer?.disconnect();
    _observer = null;
}

function debounce(fn, ms) {
    let t = null;
    return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}

/**
 * Чистое: план оболочек для сообщения (idempotent keys).
 * @returns {Array<{key:string, status:string, domAction:'keep'|'mount', imagePath?:string|null}>}
 */
export function computeShellPlan({ markers, items, hashFn = stableHash, existingKeys = [] }) {
    const existing = new Set(existingKeys);
    const plan = [];
    markers.forEach((marker, idx) => {
        const descHash = hashFn(`${marker.type}|${marker.desc}`);
        const key = `${idx}|${marker.type}|${descHash}`;
        const item = (items || []).find(i => `${i.idx}|${i.type}|${i.descHash}` === key);
        const status = item?.status === 'ready' ? 'ready'
            : item?.status === 'pending' ? 'pending'
            : item ? 'changed' : 'button';
        plan.push({
            key, status,
            domAction: existing.has(key) ? 'keep' : 'mount',
            marker, item: item || null,
        });
    });
    return plan;
}

function profileFor(type) {
    return resolveProfile(buildAliasIndex(sanitizeTriggerList(globalThis.state?.settings?.inlineTriggers || [])), type);
}

function shellFor(msgId, entry) {
    const { key, status, marker, item } = entry;
    const profile = profileFor(marker.type);
    const wrap = document.createElement('span');
    wrap.className = 'uris-inl-shell';
    wrap.setAttribute(SHELL_ATTR, key);
    wrap.dataset.msgId = String(msgId);
    if (status === 'ready' && item?.imagePath) {
        const img = document.createElement('img');
        img.src = '/' + item.imagePath;
        img.loading = 'lazy';
        img.style.cssText = 'display:block;max-width:260px;width:100%;border-radius:10px;cursor:zoom-in;border:1px solid var(--SmartThemeBorderColor,#444)';
        img.title = `${profile?.name || marker.type} — клик: просмотр, ⟳ в меню: реролл`;
        img.addEventListener('click', () => {
            try {
                showSingleImage({ src: '/' + item.imagePath });
            } catch { window.open('/' + item.imagePath, '_blank'); }
        });
        img.addEventListener('dblclick', () => reroll(msgId, entry));
        wrap.append(img);
        const badge = document.createElement('span');
        badge.className = 'uris-inl-badge';
        badge.textContent = profile?.name || marker.type;
        badge.style.cssText = 'font-size:10px;opacity:.6';
        wrap.append(badge);
    } else if (status === 'pending') {
        wrap.style.cssText = 'display:flex;gap:8px;align-items:center;padding:8px;border:1px dashed var(--SmartThemeBorderColor,#666);border-radius:10px;min-height:60px;max-width:260px';
        const spin = document.createElement('i');
        spin.className = 'fa-solid fa-spinner fa-spin';
        const label = document.createElement('small');
        label.textContent = `Генерирую ${profile?.name || marker.type}…`;
        const cancel = document.createElement('span');
        cancel.textContent = '✕';
        cancel.style.cssText = 'cursor:pointer;margin-left:auto;opacity:.7';
        cancel.title = 'Отменить';
        cancel.addEventListener('click', () => {
            const rid = item?.requestId;
            if (rid && globalThis.state?.activeGenerations?.has(rid)) {
                globalThis.state.activeGenerations.get(rid).abort();
            } else {
                wrap.remove(); // в очереди: просто снять оболочку
            }
        });
        wrap.append(spin, label, cancel);
        wrap.style.aspectRatio = aspectRatioCss(profile?.aspect);
    } else if (status === 'button' || status === 'changed') {
        wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--SmartThemeBorderColor,#666);border-radius:10px;cursor:pointer';
        const label = document.createElement('small');
        label.textContent = status === 'changed' ? 'Описание изменилось' : '📷 Нарисовать';
        wrap.append(label);
        wrap.addEventListener('click', () => reroll(msgId, { ...entry, item: entry.item || { idx: idxOf(key), type: marker.type, descHash: hashPart(key) } }));
    } else { // error
        wrap.style.cssText = 'display:inline-flex;gap:6px;align-items:center;padding:6px 10px;border:1px solid #a33;border-radius:10px;cursor:pointer';
        const label = document.createElement('small');
        label.textContent = `Ошибка: ${item?.error || 'неизвестно'} — клик: retry`;
        wrap.append(label);
        wrap.addEventListener('click', () => reroll(msgId, entry));
    }
    return wrap;
}

function idxOf(key) { return Number(key.split('|')[0]); }
function hashPart(key) { return key.split('|')[2]; }
function aspectRatioCss(aspect) {
    const [a, b] = String(aspect || '1:1').split(':').map(Number);
    return a && b ? `${a} / ${b}` : '1 / 1';
}

/** Реконсиляция видимых сообщений. */
export function reconcileVisible() {
    if (globalThis.state?.settings?.inlineEnabled !== true) return;
    const ctx = getCtx();
    const chatEl = document.getElementById('chat');
    if (!chatEl || !ctx?.chat) return;
    for (const mesEl of chatEl.querySelectorAll('.mes[mesid]')) {
        const msgId = mesEl.getAttribute('mesid');
        const mes = ctx.chat?.[Number(msgId)];
        if (!mes || typeof mes.mes !== 'string') continue;
        const markers = parseInline(mes.mes);
        const items = getSlot(msgId).items;
        // ручные (без маркеров) оболочки живут по key `-1|manual|…` и реконсилятся
        // по существующим data-attr (не пересоздаются)
        const manualShells = [...mesEl.querySelectorAll(`[${SHELL_ATTR}][data-manual="1"]`)];
        if (!markers.length && !manualShells.length) continue;
        const textEl = mesEl.querySelector('.mes_text');
        if (!textEl) continue;
        const plan = computeShellPlan({
            markers,
            items,
            existingKeys: [...mesEl.querySelectorAll(`[${SHELL_ATTR}]:not([data-manual])`)].map(e => e.getAttribute(SHELL_ATTR)),
        });
        for (const entry of plan) {
            if (entry.domAction === 'keep') continue;
            // скрыть сырой маркер в тексте (первое вхождение raw), вставить оболочку рядом
            hideMarkerText(textEl, entry.marker?.raw);
            const old = mesEl.querySelector(`[${SHELL_ATTR}="${CSS.escape(entry.key)}"]`);
            if (old) old.replaceWith(shellFor(msgId, entry));
            else textEl.append(shellFor(msgId, entry));
        }
    }
}

/** Спрятать raw-маркер в текстовых узлах (обёртка display:none). Идемпотентно. */
function hideMarkerText(textEl, raw) {
    if (!raw) return;
    const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
    const targets = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeValue.includes(raw)) targets.push(n);
    }
    for (const node of targets) {
        const idx = node.nodeValue.indexOf(raw);
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + raw.length);
        const span = document.createElement('span');
        span.style.display = 'none';
        span.textContent = raw;
        range.deleteContents();
        range.insertNode(span);
    }
}

/** 📷-кнопка в .mes_buttons каждого AI-сообщения (ручной режим). */
export function ensureManualButtons({ onManual }) {
    const ctx = getCtx();
    for (const mesEl of document.querySelectorAll('#chat .mes[mesid]')) {
        const msgId = Number(mesEl.getAttribute('mesid'));
        if (ctx.chat?.[msgId]?.is_user) continue;
        const buttons = mesEl.querySelector('.mes_buttons');
        if (!buttons || buttons.querySelector('[data-uris-manual]')) continue;
        const btn = document.createElement('div');
        btn.className = 'mes_button fa-solid fa-camera interactable';
        btn.setAttribute('data-uris-manual', String(msgId));
        btn.title = 'URIS: нарисовать по сообщению';
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            onManual?.({ msgId, mesEl });
        });
        buttons.append(btn);
    }
}
```

`manual`-оболочки (кнопка 📷 → диалог с textarea → `reroll({msgId, idx:-1,
type:'img', desc})`) рендерятся тем же `shellFor` c `data-manual="1"` и
добавляются в конец `.mes_text`; состояние держится в памяти модуля (не в
chatMetadata) — сознательное допущение M1.

- [ ] **Step 3: Run tests**

Run: `node --test tests/inline-render.test.js`
Expected: PASS (computeShellPlan)

- [ ] **Step 4: Commit**

```bash
git add src/inline/render.js tests/inline-render.test.js
git commit -m "feat(inline): DOM shells with reconciliation + manual camera button"
```

---

### Task 9: Настройки, вкладка «Медиа», проводка в `index.js`

**Files:**
- Modify: `src/core.js` (defaultSettings: `inlineEnabled:false`, `inlineListenUser:false`, `inlineTriggers: null` → normalize в loadSettings через `sanitizeTriggerList(DEFAULT_TRIGGERS)`)
- Create: `src/ui/tab-media.js`
- Modify: `index.js` (import + `registerTab({id:'media', label:'Медиа', render: renderMedia, visible: () => state.settings?.inlineEnabled === true})` + init сканера/рендера)
- Modify: `src/ui/tab-settings.js` (галка «Инлайн-генерация в чате» = `inlineEnabled`)
- Test: `tests/inline-tab-media.test.js` (рендер вкладки, тумблер сохраняется)

- [ ] **Step 1: core.js дефолты**

В `defaultSettings` добавить:

```js
    inlineEnabled: false,      // инлайн-генерация в чате (маркеры/ключевые слова/кнопка)
    inlineListenUser: false,   // реагировать на ключевые слова в сообщениях юзера
    inlineTriggers: null,      // профили; null → sanitizeTriggerList(DEFAULT_TRIGGERS)
```

В `loadSettings` после мержа: `state.settings.inlineTriggers = sanitizeTriggerList(state.settings.inlineTriggers);`

- [ ] **Step 2: `src/ui/tab-media.js`** — четыре блока (тумблеры чата / карточки триггеров / тестовый стенд / лента). Каркас:

```js
// @ts-check
import { state, saveSettings, escapeHtml } from '../core.js';
import { getConfig, setConfig } from '../inline/store.js';
import { sanitizeTriggerList, DEFAULT_TRIGGERS } from '../inline/triggers.js';
import { getSlot } from '../inline/store.js';

export function render(root) {
    if (!state.settings) { root.innerHTML = '<small class="uris-hint">Настройки не загружены.</small>'; return; }
    const cfg = getConfig();
    const triggers = sanitizeTriggerList(state.settings.inlineTriggers);
    root.innerHTML = `
        <div class="uris-settings">
            <small class="uris-hint">Инлайн: URIS распознаёт [[тип: описание]] в ответах персонажа
            и кнопку 📷 у сообщений. Профили триггеров общие с мостом (generate({trigger})).</small>
            <section class="uris-settings-section">
                <h3>Инлайн в этом чате</h3>
                <label class="checkbox_label"><input type="checkbox" id="urisMediaEnabled" ${state.settings.inlineEnabled ? 'checked' : ''}><span>Включить инлайн-генерацию</span></label>
                <label class="checkbox_label"><input type="checkbox" id="urisMediaListen" ${cfg.listenUser ? 'checked' : ''}><span>Реагировать на мои сообщения (слова-триггеры)</span></label>
                <small class="uris-hint">Слова-триггеры: ${triggers.flatMap(t => t.aliases).slice(0, 8).map(escapeHtml).join(', ')}…</small>
            </section>
            <section class="uris-settings-section">
                <h3>Триггеры</h3>
                <div id="urisMediaTriggers"></div>
                <div class="uris-settings-actions">
                    <button type="button" class="uris-btn uris-btn-ghost" id="urisMediaTriggerAdd"><i class="fa-solid fa-plus"></i> Свой тип</button>
                </div>
            </section>
            <section class="uris-settings-section">
                <h3>Тестовый стенд</h3>
                <div class="uris-field">
                    <label for="urisMediaBenchType">Триггер</label>
                    <select class="text_pole" id="urisMediaBenchType">${triggers.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('')}</select>
                    <label for="urisMediaBenchDesc">Описание</label>
                    <textarea class="text_pole" id="urisMediaBenchDesc" rows="2">на пляже на закате</textarea>
                </div>
                <div class="uris-settings-actions">
                    <button type="button" class="uris-btn uris-btn-outline" id="urisMediaBenchRun"><i class="fa-solid fa-image"></i> Сгенерировать</button>
                </div>
                <div id="urisMediaBenchOut"><small class="uris-hint">Ровно та оболочка, что появится в чате.</small></div>
            </section>
            <section class="uris-settings-section">
                <h3>Лента чата</h3>
                <div id="urisMediaFeed"></div>
            </section>
        </div>`;
    bindMedia(root);
    renderFeed(root);
}
```

`bindMedia(root)` (реализовать полностью):
- `#urisMediaEnabled` change → `state.settings.inlineEnabled`; `saveSettings()`; вызвать
  `import('../inline/scanner.js')` → `bindScanner()`/`unbindScanner()` и
  `renderTabs()` (видимость вкладки), `initRender({reroll})`/`shutdownRender()`.
- `#urisMediaListen` change → `setConfig({ listenUser })`.
- Редактор триггеров: для каждого профиля — сворачиваемая карточка (details/summary)
  с полями `name, aliases (через запятую), aspect (select из VALID_ASPECT_RATIOS),
  prefix, suffix, refsPolicy (select auto/off)`; change → обновить запись в
  `state.settings.inlineTriggers` через `sanitizeTriggerList`, `saveSettings()`.
- `#urisMediaTriggerAdd` → добавить копию профиля `img` с id `custom-<n>`.
- Стенд: `#urisMediaBenchRun` → `queueInlineJob({msgId:-1, idx:0, type, desc})`,
  вывод оболочкой (использовать `render.js` вспомогательный `shellFor` —
  экспортировать его из render.js для стенда), результат — превью в `#urisMediaBenchOut`.
- Лента: `getSlot` по последним 20 msgId (итерация `Object.entries` slots),
  миниатюры `img.src='/'+imagePath`, клик → `showSingleImage`.

`renderFeed(root)` — реализовать по описанию выше (итерация slots из chatMetadata
через `getSlot`, фильтр status==='ready').

- [ ] **Step 3: index.js проводка**

```js
import { render as renderMedia } from './src/ui/tab-media.js';
import { bindScanner, unbindScanner } from './src/inline/scanner.js';
import { initRender, shutdownRender } from './src/inline/render.js';
import { queueInlineJob } from './src/inline/runner.js';
```

В `init()` после регистрации вкладок:

```js
    registerTab({ id: 'media', label: 'Медиа', render: renderMedia,
        visible: () => state.settings?.inlineEnabled === true });
```

В конце `init()`:

```js
    if (state.settings.inlineEnabled) {
        bindScanner();
        initRender({ reroll: queueInlineJob });
    }
```

В `cleanup()`:

```js
    unbindScanner();
    shutdownRender();
```

- [ ] **Step 4: tab-settings.js — галка**

В секцию «Поведение» добавить:

```html
<label class="checkbox_label"><input type="checkbox" id="uris_inline_enabled" ${state.settings.inlineEnabled ? 'checked' : ''}><span>Инлайн-генерация в чате (Медиа)</span></label>
```

bind: change → `state.settings.inlineEnabled = checked; saveSettings(); renderTabs();`
(+ включить/выключить сканер так же, как tab-media).

- [ ] **Step 5: Run tests**

Run: `node --test tests/inline-tab-media.test.js`
Expected: PASS (рендер + тумблер, паттерн settings-tab.test.js)

- [ ] **Step 6: Commit**

```bash
git add src/ui/tab-media.js src/ui/tab-settings.js src/core.js index.js tests/inline-tab-media.test.js
git commit -m "feat(inline): Media tab, settings defaults, app wiring"
```

---

### Task 10: Полный прогон, CHANGELOG, деплой

- [ ] **Step 1: Полный suite**

Run: `node --test`
Expected: все зелёные (базлайн 1059+ новые)

- [ ] **Step 2: CHANGELOG**

Новая запись сверху `docs/CHANGELOG.md` (дата, «inline engine M1»): перечислить
модули, грамматику `[[тип: …]]`, chatMetadata-хранение, автолейн, вкладку
«Медиа», мостовые `parseInline`/`trigger`, M2-бэклог (темы оболочек, варианты
реролла, extra.image-гибрид, бюджеты).

- [ ] **Step 3: Ручная проверка на таверне** (по runbook-стилю)

1. Включить «Инлайн-генерацию в чате» → вкладка «Медиа» появилась.
2. В ответ персонажа руками добавить маркер `[[img: тестовая чашка кофе]]`
   (MESSAGE_EDITED) → оболочка pending → картинка → галерея.
3. F5 → оболочка восстановилась без новой генерации (идемпотентность).
4. Изменить описание → changed-оболочка; ⟳ → регенерация по клику.
5. Stop таверны во время pending → отмена, статус error/aborted.
6. 📷-кнопка на сообщении → ручная генерация.
7. Мост: `URIS.parseInline('[[selfie: x]]')` → профиль; `generate({trigger:'selfie'})` → аспект 9:16.

- [ ] **Step 4: Деплой в установленную копию**

```bash
cp -r src/inline "D:\SillyTavern\data\default-user\extensions\UR Image Studio\src\"
cp src/bridge.js src/core.js src/autolane.js "D:\SillyTavern\data\default-user\extensions\UR Image Studio\src\"
cp src/ui/tab-media.js src/ui/tab-settings.js "D:\SillyTavern\data\default-user\extensions\UR Image Studio\src\ui\"
cp index.js "D:\SillyTavern\data\default-user\extensions\UR Image Studio\"
node --check "D:\SillyTavern\data\default-user\extensions\UR Image Studio\index.js"
```

- [ ] **Step 5: Финальный commit**

```bash
git add docs/CHANGELOG.md docs/plans/2026-09-11-inline-engine-plan.md
git commit -m "docs: inline engine M1 changelog + plan"
```

---

## M2-бэклог (зафиксировано, не в этом плане)

Темы оболочек (рендерер уже принимает объект темы — константа сейчас) ·
мини-варианты реролла со стрелками · `extra.image`-гибрид и image-swipes ·
групповые чаты · budgets/автопилот · `/uris:*` слеш-команды · фильтр галереи
по provenance/caller · англоязычная полировка промпта-описания (опция).
