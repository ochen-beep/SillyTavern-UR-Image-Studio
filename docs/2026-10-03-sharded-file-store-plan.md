# Sharded File Store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Разложить галерейный и референс-индексы по шардам фиксированного размера за манифестом, чтобы мутация писала только затронутый шард (~250 записей), а не весь файл.

**Architecture:** Новый `src/sharded-file-store.js` повторяет публичный контракт `createFileStore` (ready/mode/snapshot/mutate/replace/persist/flush/flushOnUnload/footprint), но внутри держит манифест (`uris_*_manifest.json`) + шарды (`uris_*_shard_sNNNN.json`). Зеркало целиком в памяти; после `mutate` дифф по id записей помечает «грязные» шарды, serialized loop пишет их с merge-per-shard (переиспользует `mergeServerValue`). Миграция из монолита идемпотентна, точка коммита — запись манифеста. Спека: `docs/2026-10-03-sharded-file-store-design.md`.

**Tech Stack:** Vanilla ES module JS (`// @ts-check`), node:test + assert/strict. HTTP-поверхность ST: `/api/files/verify`, `/api/files/upload`, `GET /user/files/<name>`. Листинга директории нет — последовательность шардов восстанавливается probe'ом.

**Соглашения репозитория:** коммиты conventional (тип(scope): описание по-русски), тесты — `npm test` (= `node --test --test-force-exit "tests/*.test.js"`). docs/ в .gitignore — планы и спеки локально, НЕ коммитятся.

**Инвариант «не сломать»:** существующие тесты `file-store*`, `gallery-index`, `refs-library`, `data-port` — регресс-щит. Правки их ожиданий (имена файлов после переезда) — только осознанным отдельным коммитом `test(...)` с формулировкой причины.

---

## File Structure

- **Create `src/sharded-file-store.js`** — весь механизм: транспорт, парсинг, размещение, дифф-грязности, write loop, merge-per-shard, миграция, восстановление. Единственный новый файл логики.
- **Modify `src/file-store.js`** — только экспорты: `textToBase64`, `stHeaders`, `mergeServerValue` (существующие внутренности), новый `parseVersionedDoc`, новый `registerFileStoreForDiagnostics`. Ноль изменений поведения.
- **Modify `src/gallery-index.js`** — swap конструктора стора. Остальной код не трогается.
- **Modify `src/refs-library.js`** — swap конструктора + meta-файл для `folders`.
- **Test `tests/sharded-file-store.test.js`** — контрактные тесты (harness копирует `tests/file-store.test.js`: глобальный fetch-стаб + `serverFiles` Map).
- **Test `tests/gallery-index.test.js`, `tests/refs-library.test.js`, `tests/file-store*.test.js`** — существующие, без правок (регресс-щит).

Модуль собирается кумулятивно: задачи 2–9 добавляют функции в `src/sharded-file-store.js`, каждая показывает полные тела и точку вставки. Заглушки помечены задачей, которая их заменяет.

---

### Task 1: Экспорт общих внутренностей из file-store.js

**Files:**
- Modify: `src/file-store.js`
- Test: существующие `tests/file-store*.test.js` (запуск без правок)

- [ ] **Step 1: Добавить экспорты в `src/file-store.js`**

Четыре правки, все — чистые добавления/обёртки, поведение не меняется:

1. `textToBase64` (строка 76) — добавить `export`:

```js
/** UTF-8-safe base64 (stored values are user text, not Latin1). */
export function textToBase64(text) {
```

2. `stHeaders` (строка 70) — добавить `export`:

```js
export function stHeaders() {
```

3. `mergeServerValue` (строка 213) — добавить `export` к объявлению:

```js
/** Merge a whole document value; see `mergeRecordArray`. Null = nothing to change. */
export function mergeServerValue(baseValue, serverValue, localValue) {
```

4. В конце файла (перед `resetFileStoresForTests`) — добавки:

```js
/**
 * Version-contract parse for the sharded sibling: same refusal rules as
 * `parseDoc` (corrupt / newer / older / found) without the `[key]` extraction —
 * sharded docs carry `kind`/`store`/`id` alongside `v`, and the manifest value
 * is the whole body. `value` of `newer`/`found`/`older` is the whole doc.
 */
export function parseVersionedDoc(text, { version }) {
    let doc;
    try { doc = JSON.parse(text); } catch { return { reason: 'corrupt' }; }
    if (!doc || typeof doc !== 'object') return { reason: 'corrupt' };
    if (typeof doc.v === 'number' && doc.v > version) return { reason: 'newer', value: doc };
    if (doc.v === version) return { reason: 'found', value: doc };
    if (typeof doc.v === 'number' && doc.v < version) return { reason: 'older', value: doc };
    return { reason: 'corrupt' };
}

/** Diagnostics registry lives in file-store; the sharded store registers here too. */
export function registerFileStoreForDiagnostics(store) {
    STORES.set(store.label, store);
}
```

Внутри `createFileStore` заменить `STORES.set(label, store);` (строка 805) на:

```js
    registerFileStoreForDiagnostics(store);
```

- [ ] **Step 2: Прогнать регресс**

Run: `npm test 2>&1 | tail -8`
Expected: `fail 0` — поведение file-store не изменилось.

- [ ] **Step 3: Commit**

```bash
git add src/file-store.js
git commit -m "refactor(file-store): экспорт общих внутренностей для шардированного брата"
```

---

### Task 2: Каркас sharded-file-store.js — транспорт, документы, парсинг

**Files:**
- Create: `src/sharded-file-store.js`
- Test: `tests/sharded-file-store.test.js`

- [ ] **Step 1: Падающий тест**

Создать `tests/sharded-file-store.test.js` (harness используется всеми следующими задачами):

```js
// @ts-check
/**
 * Sharded server-file store: manifest + fixed-size shard files. The harness
 * mirrors tests/file-store.test.js (global fetch stub + serverFiles Map) so
 * both layers see the same server shape.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const serverFiles = new Map();   // name → file text (what the server would store)
const uploads = [];              // { name, data, keepalive }
let verifyAvailable = true;
let failUploads = false;
let missingNames = new Set();    // names answering 404 even if present in serverFiles

const originalSt = globalThis.SillyTavern;
const originalFetch = globalThis.fetch;
const originalToastr = globalThis.toastr;
const toastErrors = [];

function installStubs() {
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: { ur_image_studio: {} },
            saveSettingsDebounced: () => {},
            getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
        }),
        libs: { localforage: { async getItem() { return null; }, async setItem() {}, async removeItem() {} } },
    };
    globalThis.toastr = { error: msg => toastErrors.push(msg) };
    globalThis.fetch = fetchStub;
}

const fetchStub = async (url, options = {}) => {
    if (url === '/api/files/verify') {
        if (!verifyAvailable) return { ok: false, status: 404, text: async () => '' };
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    if (url === '/api/files/upload' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        uploads.push({ ...body, keepalive: options.keepalive === true });
        if (failUploads) return { ok: false, status: 500, text: async () => 'boom' };
        serverFiles.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    if (url.startsWith('/user/files/')) {
        const name = decodeURIComponent(url.slice('/user/files/'.length));
        if (!serverFiles.has(name) || missingNames.has(name)) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
        return { ok: true, status: 200, text: async () => serverFiles.get(name), json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => ({}) };
};

const { createShardedFileStore } = await import('../src/sharded-file-store.js');
const { resetFileStoresForTests } = await import('../src/file-store.js');

/** Gallery-shaped test record. */
function card(i, at = 1_700_000_000_000 + i * 1000) {
    return { id: `c${String(i).padStart(4, '0')}`, imagePath: `a/b/img${i}.png`, prompt: `p${i}`,
        createdAt: at, updatedAt: at };
}

let labelCounter = 0;
/** Gallery-flavoured store over a fresh file namespace. */
function makeStore(overrides = {}) {
    const n = ++labelCounter;
    return createShardedFileStore({
        label: `shard-test-${n}`,
        manifestName: `t${n}_manifest.json`,
        shardPrefix: `t${n}_shard_`,
        monolithName: `t${n}_old.json`,
        monolithKey: 'cards',
        shardTarget: 4,
        append: 'front',
        placeByStamp: true,
        placeStamp: r => (Number.isFinite(r?.createdAt) ? r.createdAt : 0),
        empty: () => [],
        countEntries: value => (Array.isArray(value) ? value.length : null),
        mergeWithServer: true,
        ...overrides,
    });
}

const shardName = (store, id) => `${store.shardPrefix}${id}.json`;
const manifestName = store => store.manifestName;

beforeEach(() => {
    serverFiles.clear();
    uploads.length = 0;
    missingNames = new Set();
    verifyAvailable = true;
    failUploads = false;
    toastErrors.length = 0;
    installStubs();
    resetFileStoresForTests();
});

describe('skeleton', () => {
    it('fresh store: ready() answers file mode with an empty mirror and writes nothing', async () => {
        const store = makeStore();
        assert.equal(await store.ready(), 'file');
        assert.deepEqual(store.snapshot(), []);
        assert.equal(store.mode(), 'file');
        assert.equal(uploads.length, 0, 'a fresh store creates no files until the first mutation');
    });
});
```

- [ ] **Step 2: Прогнать — ожидаем падение (модуля нет)**

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: FAIL — `Cannot find module ... src/sharded-file-store.js`.

- [ ] **Step 3: Реализовать каркас**

Создать `src/sharded-file-store.js`:

```js
// @ts-check
/**
 * Sharded sibling of `file-store`: the same public contract (ready / mode /
 * snapshot / mutate / replace / persist / flush / flushOnUnload / footprint),
 * but the record collection lives in fixed-size shard files behind a tiny
 * manifest, so a mutation uploads only the shards its records actually touched
 * — a cost bounded by SHARD_TARGET records no matter how large the collection
 * grows. Files (`data/<user>/user/files/<name>`):
 *
 *   <manifestName>            { v, kind:'manifest', store, shards: [{id,count,min,max}] }
 *   <shardPrefix>sNNNN.json   { v, kind:'shard', store, id, records: [...] }
 *
 * Shard rows are ordered by id ASC = logical collection order (oldest first).
 * A gallery shard (`append: 'front'`, mirror is newest-first) stores its
 * records newest-first; refs shards (`append: 'back'`) keep insertion order.
 * A record never moves between shards after placement — new records go to the
 * newest shard, opening the next one at target size. Records arriving out of
 * range (via merge from another device) are placed by `placeStamp` into the
 * shard holding their stamp, overflowing it rather than splitting.
 *
 * The mirror handed to mutators is byte-compatible with `createFileStore`:
 * the full logical value. Writes diff the mirror against per-shard state by
 * record id and mark dirty shards; the serialized write loop re-reads each
 * dirty shard, three-way merges it (the shared `mergeServerValue`), and
 * uploads it — the same concurrent-writer safety as `mergeWithServer`, at
 * shard size. Manifest rows are derived data, merged with the server copy the
 * same way; a foreign shard unknown to this session is adopted, never clobbered.
 *
 * Modes follow file-store: 'unknown' → 'file' | 'readonly'. Extra refusal
 * reason: 'shard-unreadable' — the manifest names a shard the server cannot
 * deliver (404/corrupt/newer): the merge base is incomplete, so writes are
 * refused for the session instead of silently clobbering the missing part.
 */

import { log, warn } from './core.js';
import { recordDiagnosticEvent } from './diagnostic-events.js';
import {
    KEEPALIVE_BODY_LIMIT, textToBase64, stHeaders, mergeServerValue,
    parseVersionedDoc, registerFileStoreForDiagnostics,
} from './file-store.js';

const UPLOAD_URL = '/api/files/upload';
const FAILURE_TOAST_INTERVAL = 5000;
const PROBE_RETRY_MS = 10 * 1000;

function clone(value) {
    if (value === null || value === undefined) return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function defaultCountEntries(value) {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === 'object') return Object.keys(value).length;
    return null;
}

// ── HTTP ──

async function readFile(name) {
    const res = await fetch(`/user/files/${encodeURIComponent(name)}`, { method: 'GET', cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`read failed: ${res.status}`);
    const text = await res.text();
    return text || null;
}

/** Full-file atomic upload of one document; returns its JSON length in bytes. */
async function uploadDoc(name, doc) {
    const json = JSON.stringify(doc);
    const res = await fetch(UPLOAD_URL, {
        method: 'POST',
        headers: stHeaders(),
        body: JSON.stringify({ name, data: textToBase64(json) }),
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text().catch(() => '')}`);
    return json.length;
}

// ── Document shapes ──

function shardDoc(store, version, id, records) {
    return { v: version, kind: 'shard', store, id, records };
}

function manifestDoc(store, version, shards) {
    return { v: version, kind: 'manifest', store, shards };
}

function tombstoneDoc(store, version) {
    return { v: version, kind: 'migrated', store };
}

function parseShard(text, version) {
    const parsed = parseVersionedDoc(text, { version });
    if (parsed.reason === 'corrupt') return parsed;
    const doc = parsed.value;
    if (!doc || doc.kind !== 'shard' || !Array.isArray(doc.records)) return { reason: 'corrupt' };
    return { reason: parsed.reason, value: doc.records };
}

function parseManifest(text, version) {
    const parsed = parseVersionedDoc(text, { version });
    if (parsed.reason === 'corrupt') return parsed;
    const doc = parsed.value;
    if (!doc || doc.kind !== 'manifest' || !Array.isArray(doc.shards)) return { reason: 'corrupt' };
    return { reason: parsed.reason, value: doc };
}

/** Monolith parse for migration: `kind:'migrated'` means "already moved". */
function parseMonolith(text, version, key) {
    const parsed = parseVersionedDoc(text, { version });
    if (parsed.reason === 'corrupt') return parsed;
    if (parsed.value?.kind === 'migrated') return { reason: 'migrated' };
    const records = parsed.value?.[key];
    if (!Array.isArray(records)) return { reason: 'corrupt' };
    return { reason: parsed.reason, value: records };
}

// ── Store factory ── (capabilities accumulate in Tasks 3–9)

export function createShardedFileStore(config) {
    const {
        label,
        manifestName,
        shardPrefix,
        monolithName = null,
        monolithKey = 'data',
        shardTarget = 250,
        append = 'front',
        placeByStamp = false,
        placeStamp = r => (Number.isFinite(r?.createdAt) ? r.createdAt : 0),
        empty = () => [],
        shardedKey = null,
        countEntries = defaultCountEntries,
        mergeWithServer = true,
        keepaliveLimit = KEEPALIVE_BODY_LIMIT,
        onWriteFailure = null,
    } = config;

    const shardFileName = id => `${shardPrefix}${id}.json`;

    let mode = 'unknown';
    let readyPromise = null;
    let mirror = null;             // logical value; same shape as a file-store mirror
    let shards = [];               // manifest rows [{id, count, min, max}], id ASC
    let shardState = new Map();    // id → { records: [...], base: [...] | null }
    let recordShard = new Map();   // record id → shard id (placement, frozen)
    let dirtyShards = new Set();
    let emptyShards = new Set();   // shards to overwrite as `records: []` and drop
    let manifestDirty = false;
    let suppressMergeOnce = false; // migration / replace clobber the server, no merge
    let writeJob = null;
    let lastWriteOk = true;
    let lastFailureToastAt = 0;
    let totalBytes = null;
    let lastError = null;
    const refusedNotified = new Set();

    function emit(event, fields = {}) {
        try {
            recordDiagnosticEvent({
                event,
                stage: 'storage',
                level: fields.level,
                outcome: fields.result || null,
                durationMs: fields.ms,
                details: { store: label, ...fields },
            });
        } catch { /* diagnostics must never break storage */ }
    }

    function notifyFailure(cause) {
        warn(`sharded-store[${label}]:`, cause?.message || cause);
        const now = Date.now();
        if (now - lastFailureToastAt < FAILURE_TOAST_INTERVAL) return;
        lastFailureToastAt = now;
        try {
            if (onWriteFailure) onWriteFailure(cause);
            else globalThis.toastr?.error?.(`Не удалось сохранить «${label}» на сервер.`);
        } catch { /* no toastr in tests */ }
    }

    function refusePersist(reason) {
        lastWriteOk = false;
        lastError = reason;
        if (refusedNotified.has(reason)) return;
        refusedNotified.add(reason);
        emit('store-write-skipped', { store: label, reason, level: 'warn' });
        warn(`sharded-store[${label}]: writes refused (${reason})`);
        try {
            const messages = {
                'newer-version': `«${label}»: данные записаны более новой версией расширения — обновите UR Image Studio; запись отключена.`,
                'no-user-files': `«${label}»: SillyTavern не поддерживает файловое хранилище (обновите SillyTavern); запись отключена.`,
                'shard-unreadable': `«${label}»: не удалось прочитать часть данных при запуске — запись заблокирована, чтобы не потерять остальное. Перезагрузите страницу.`,
            };
            const message = messages[reason] || `«${label}»: запись отключена (${reason}).`;
            if (onWriteFailure) onWriteFailure(new Error(reason));
            else globalThis.toastr?.error?.(message);
        } catch { /* no toastr in tests */ }
    }

    // ── Placement state helpers ── (filled in Task 3)

    const store = {
        label,
        name: manifestName,
        manifestName,
        shardPrefix,

        ready: () => readyPromise || (readyPromise = Promise.resolve('file')),   // Task 3
        mode: () => mode,
        isFileMode: () => mode === 'file',
        snapshot() { return mirror === null ? null : clone(mirror); },
        async mutate(mutator, { persist: shouldPersist = true } = {}) {   // Task 4
            if (mirror === null) mirror = empty();
            return mutator(mirror);
        },
        async replace(value) { mirror = value; },                          // Task 7
        persist() { return Promise.resolve(true); },                       // Task 4
        async flush() { return lastWriteOk; },                             // Task 9
        flushOnUnload() {},                                                // Task 9
        footprint() {
            return {
                label,
                file: manifestName,
                mode,
                entries: mirror === null ? null : countEntries(mirror),
                bytes: totalBytes,
                lastWriteOk,
                lastError,
            };
        },
        diagnostics: () => ({ mode, shards: shards.length, entries: mirror === null ? null : countEntries(mirror) }),
        reset() {
            mode = 'unknown';
            readyPromise = null;
            mirror = null;
            shards = [];
            shardState = new Map();
            recordShard = new Map();
            dirtyShards = new Set();
            emptyShards = new Set();
            manifestDirty = false;
            suppressMergeOnce = false;
            writeJob = null;
            lastWriteOk = true;
            lastFailureToastAt = 0;
            totalBytes = null;
            lastError = null;
            refusedNotified.clear();
        },
    };

    registerFileStoreForDiagnostics(store);
    return store;
}
```

- [ ] **Step 4: Прогнать — тест каркаса зелёный**

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: PASS (1 тест).

- [ ] **Step 5: Commit**

```bash
git add src/sharded-file-store.js tests/sharded-file-store.test.js
git commit -m "feat(storage): каркас sharded-file-store — транспорт, формы документов, парсинг"
```

---

### Task 3: ready() — загрузка по манифесту, fresh-ветка, неполный шард

**Files:**
- Modify: `src/sharded-file-store.js`
- Test: `tests/sharded-file-store.test.js` (новый describe)

- [ ] **Step 1: Падающие тесты**

```js
describe('load from manifest', () => {
    it('assembles the mirror newest-first across shards (gallery order)', async () => {
        const store = makeStore();
        serverFiles.set(manifestName(store), JSON.stringify({
            v: 1, kind: 'manifest', store: 'x',
            shards: [
                { id: 's0000', count: 2, min: 1000, max: 2000 },
                { id: 's0001', count: 2, min: 3000, max: 4000 },
            ],
        }));
        // s0000 = the OLDEST two, stored newest-first inside the shard.
        serverFiles.set(shardName(store, 's0000'), JSON.stringify({
            v: 1, kind: 'shard', store: 'x', id: 's0000',
            records: [card(1, 2000), card(0, 1000)],
        }));
        serverFiles.set(shardName(store, 's0001'), JSON.stringify({
            v: 1, kind: 'shard', store: 'x', id: 's0001',
            records: [card(3, 4000), card(2, 3000)],
        }));
        assert.equal(await store.ready(), 'file');
        assert.deepEqual(store.snapshot().map(r => r.id), ['c0003', 'c0002', 'c0001', 'c0000']);
        assert.equal(uploads.length, 0, 'a clean load writes nothing');
    });

    it('a newer-version manifest makes the store readonly', async () => {
        const store = makeStore();
        serverFiles.set(manifestName(store), JSON.stringify({ v: 99, kind: 'manifest', store: 'x', shards: [] }));
        assert.equal(await store.ready(), 'readonly');
        assert.lengthOf(toastErrors, 1);
    });

    it('a shard the manifest names but the server cannot deliver → readonly + toast', async () => {
        const store = makeStore();
        serverFiles.set(manifestName(store), JSON.stringify({
            v: 1, kind: 'manifest', store: 'x',
            shards: [{ id: 's0000', count: 1, min: 1, max: 1 }],
        }));
        missingNames.add(shardName(store, 's0000'));
        assert.equal(await store.ready(), 'readonly');
        assert.match(toastErrors[0], /часть данных/);
    });
});
```

- [ ] **Step 2: Прогнать — падение**

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: FAIL — ready() пока заглушка.

- [ ] **Step 3: Реализовать ready() и helpers**

Внутрь `createShardedFileStore` (после `refusePersist`) добавить; затем заменить заглушку `ready` в store-объекте на `ready,`:

```js
    // ── Placement state helpers ──

    function rowFor(id) { return shards.find(row => row.id === id); }

    function recomputeRow(id) {
        const state = shardState.get(id);
        const row = rowFor(id);
        let min = null, max = null;
        for (const record of state.records) {
            const stamp = placeStamp(record);
            if (min === null || stamp < min) min = stamp;
            if (max === null || stamp > max) max = stamp;
        }
        row.count = state.records.length;
        row.min = min;
        row.max = max;
    }

    function nextShardId() {
        const last = shards.length ? shards[shards.length - 1].id : null;
        const n = last ? parseInt(last.slice(1), 10) + 1 : 0;
        return 's' + String(n).padStart(4, '0');
    }

    /** Register a shard's records as the local state for `id` (no dirt). */
    function adoptShard(id, records) {
        shardState.set(id, { records, base: clone(records) });
        for (const record of records) recordShard.set(String(record.id), id);
        shards.push({ id, count: records.length, min: null, max: null });
        recomputeRow(id);
    }

    /** The logical collection in mirror order, per `shardedKey`. */
    function recordList() {
        if (shardedKey) return Array.isArray(mirror?.[shardedKey]) ? mirror[shardedKey] : [];
        return Array.isArray(mirror) ? mirror : [];
    }

    /**
     * Rebuild the mirror from shard state. Rows are kept sorted by id ASC
     * (oldest first). Gallery shards store newest-first, so the newest-first
     * mirror (`append: 'front'`) concatenates shards in REVERSE id order; refs
     * shards keep insertion order (`append: 'back'`) and concatenate ASC.
     */
    function rebuildMirrorFromShards() {
        shards.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const ordered = append === 'front' ? [...shards].reverse() : shards;
        const list = ordered.flatMap(row => shardState.get(row.id).records);
        if (shardedKey) { mirror[shardedKey] = list; return; }
        mirror = list;
    }

    // ── Load ──

    /**
     * Load every shard the manifest names, in parallel. Any undeliverable
     * shard (404/corrupt/newer) makes the whole store readonly: the merge base
     * would be incomplete and a write could silently clobber the missing part.
     */
    async function loadShards(rows) {
        const results = await Promise.all(rows.map(async row => {
            try {
                const text = await readFile(shardFileName(row.id));
                if (text === null) return { id: row.id, reason: 'missing' };
                const parsed = parseShard(text, version);
                if (parsed.reason === 'found' || parsed.reason === 'older') {
                    return { id: row.id, reason: 'ok', records: parsed.value };
                }
                return { id: row.id, reason: parsed.reason };
            } catch {
                return { id: row.id, reason: 'missing' };
            }
        }));
        const bad = results.find(result => result.reason !== 'ok');
        if (bad) {
            mode = 'readonly';
            emit('store-mode', { store: label, result: 'readonly', reason: 'shard-unreadable', shard: bad.id });
            log(`sharded-store[${label}]: mode=readonly (shard ${bad.id} ${bad.reason})`);
            refusePersist('shard-unreadable');
            return false;
        }
        for (const result of results) adoptShard(result.id, result.records);
        return true;
    }

    async function detectAndLoadOnce() {
        const started = Date.now();
        let probe;
        try {
            probe = await fetch('/api/files/verify', { method: 'POST', headers: stHeaders(), body: JSON.stringify({ urls: [] }) });
        } catch {
            return null;   // surface unreachable — ready() keeps retrying
        }
        if (!probe.ok) {
            mode = 'readonly';
            mirror = empty();
            emit('store-mode', { store: label, result: 'readonly', reason: 'no-user-files' });
            refusePersist('no-user-files');
            return mode;
        }
        mode = 'file';

        let text = null;
        try { text = await readFile(manifestName); } catch { text = undefined; }
        if (text === undefined) return null;   // non-404 read failure — retry via ready()

        if (text === null) {
            // No manifest: fresh store or migration candidate. Task 4 wires
            // attemptMigration() here; until then treat as fresh.
            mirror = empty();
            emit('store-mode', { store: label, result: 'file', reason: 'missing' });
            emit('store-load', { store: label, result: 'missing', entries: countEntries(mirror), bytes: 0, ms: Date.now() - started });
            return mode;
        }

        const parsed = parseManifest(text, version);
        if (parsed.reason === 'newer') {
            mode = 'readonly';
            emit('store-mode', { store: label, result: 'readonly', reason: 'newer-version' });
            refusePersist('newer-version');
            return mode;
        }
        if (parsed.reason === 'corrupt') {
            // Task 8 wires rebuildFromScan() here. Until then: empty mirror.
            mirror = empty();
            emit('store-mode', { store: label, result: 'file', reason: 'corrupt-manifest' });
            return mode;
        }

        mirror = empty();
        const ok = await loadShards(parsed.value.shards || []);
        if (!ok) return mode;
        rebuildMirrorFromShards();
        totalBytes = text.length;
        emit('store-mode', { store: label, result: 'file', reason: parsed.reason });
        emit('store-load', {
            store: label, result: parsed.reason, entries: countEntries(mirror),
            bytes: totalBytes, ms: Date.now() - started,
        });
        log(`sharded-store[${label}]: mode=file, ${shards.length} shard(s), ${countEntries(mirror)} entr(ies)`);
        return mode;
    }
```

В store-объекте заменить `ready: () => readyPromise || (readyPromise = Promise.resolve('file')),` на:

```js
        ready() {
            if (!readyPromise) {
                readyPromise = (async () => {
                    for (;;) {
                        const result = await detectAndLoadOnce();
                        if (result !== null) return result;
                        await new Promise(resolve => setTimeout(resolve, PROBE_RETRY_MS));
                    }
                })();
            }
            return readyPromise;
        },
```

- [ ] **Step 4: Прогнать — все тесты зелёные**

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: PASS (4 теста).

- [ ] **Step 5: Commit**

```bash
git add src/sharded-file-store.js tests/sharded-file-store.test.js
git commit -m "feat(storage): загрузка шардированного стора по манифесту + контракт неполного шарда"
```

---

### Task 4: mutate → размещение и запись; миграция из монолита

**Files:**
- Modify: `src/sharded-file-store.js`
- Test: `tests/sharded-file-store.test.js` (новые describe)

- [ ] **Step 1: Падающие тесты**

```js
describe('mutation and documents', () => {
    it('a mutation writes the shard doc (kind/store/id) and the manifest row', async () => {
        const store = makeStore();
        await store.ready();
        await store.mutate(list => { list.unshift(card(0)); });
        assert.equal(uploads.length, 2, 'one shard + one manifest write');
        const shard = JSON.parse(serverFiles.get(shardName(store, 's0000')));
        assert.equal(shard.kind, 'shard');
        assert.equal(shard.store, store.label);
        assert.equal(shard.id, 's0000');
        assert.deepEqual(shard.records.map(r => r.id), ['c0000']);
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.equal(manifest.kind, 'manifest');
        assert.deepEqual(manifest.shards,
            [{ id: 's0000', count: 1, min: 1_700_000_000_000, max: 1_700_000_000_000 }]);
    });

    it('an update-in-place rewrites only its shard', async () => {
        const store = makeStore();
        await store.ready();
        await store.mutate(list => { list.unshift(card(0)); });
        await store.flush();
        const before = uploads.length;
        await store.mutate(list => {
            const item = list.find(r => r.id === 'c0000');
            item.prompt = 'changed';
        });
        await store.flush();
        assert.equal(uploads.length - before, 2, 'shard + manifest (rows are cheap and always refreshed)');
        const shard = JSON.parse(serverFiles.get(shardName(store, 's0000')));
        assert.equal(shard.records[0].prompt, 'changed');
    });
});

describe('migration from monolith', () => {
    it('chunks the monolith by position, commits with the manifest, tombstones the monolith', async () => {
        const store = makeStore();   // shardTarget 4
        serverFiles.set(`t${labelCounter}_old.json`, JSON.stringify({
            v: 1, cards: [card(7), card(6), card(5), card(4), card(3), card(2), card(1), card(0), card(-1)],
        }));
        assert.equal(await store.ready(), 'file');
        assert.deepEqual(store.snapshot().map(r => r.id),
            ['c0007', 'c0006', 'c0005', 'c0004', 'c0003', 'c0002', 'c0001', 'c0000', 'c-001']);
        // 9 records / target 4 → three shards; s0000 holds the OLDEST chunk.
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(manifest.shards.map(s => s.id), ['s0000', 's0001', 's0002']);
        assert.deepEqual(manifest.shards.map(s => s.count), [4, 4, 1]);
        const first = JSON.parse(serverFiles.get(shardName(store, 's0000')));
        assert.deepEqual(first.records.map(r => r.id), ['c0002', 'c0001', 'c0000', 'c-001'],
            'the oldest chunk, stored newest-first');
        const tomb = JSON.parse(serverFiles.get(`t${labelCounter}_old.json`));
        assert.equal(tomb.kind, 'migrated');
    });

    it('an interrupted migration (shards written, manifest missing) repeats cleanly', async () => {
        const store = makeStore();
        serverFiles.set(`t${labelCounter}_old.json`, JSON.stringify({ v: 1, cards: [card(1), card(0)] }));
        serverFiles.set(shardName(store, 's0000'), JSON.stringify({
            v: 1, kind: 'shard', store: 'x', id: 's0000', records: [card(1)],
        }));
        assert.equal(await store.ready(), 'file');
        assert.deepEqual(store.snapshot().map(r => r.id), ['c0001', 'c0000']);
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(manifest.shards.map(s => s.count), [2], 'the half-written shard was overwritten');
    });

    it('a tombstoned monolith is ignored (already migrated)', async () => {
        const store = makeStore();
        serverFiles.set(`t${labelCounter}_old.json`, JSON.stringify({ v: 1, kind: 'migrated', store: 'x' }));
        assert.equal(await store.ready(), 'file');
        assert.deepEqual(store.snapshot(), []);
        assert.equal(uploads.length, 0, 'nothing to migrate — no writes');
    });

    it('a monolith from a newer build makes the store readonly', async () => {
        const store = makeStore();
        serverFiles.set(`t${labelCounter}_old.json`, JSON.stringify({ v: 99, cards: [card(0)] }));
        assert.equal(await store.ready(), 'readonly');
    });
});
```

- [ ] **Step 2: Прогнать — падение**

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: FAIL — mutate пока не пишет, миграции нет.

- [ ] **Step 3: Реализовать mutate, дифф, размещение, write loop, миграцию**

В `src/sharded-file-store.js` добавить внутрь `createShardedFileStore` (после helpers из Task 3):

```js
    // ── Mutation diff ──

    /** Chunk helper: the logical list oldest-first, regardless of append side. */
    function oldestFirst(list) {
        return append === 'front' ? [...list].reverse() : list;
    }

    /**
     * Place one new record into the newest shard (opening the next one at
     * target size). Task 5 adds the out-of-range branch.
     */
    function placeRecord(record) {
        if (!shards.length || shards[shards.length - 1].count >= shardTarget) {
            adoptShard(nextShardId(), []);
            manifestDirty = true;
        }
        const row = shards[shards.length - 1];
        const state = shardState.get(row.id);
        if (append === 'front') state.records.unshift(record);
        else state.records.push(record);
        recordShard.set(String(record.id), row.id);
        recomputeRow(row.id);
        dirtyShards.add(row.id);
    }

    /**
     * Diff the mirror against the pre-mutate snapshot. New records are placed
     * (frozen assignment), updated records mark their shard, removed records
     * shrink theirs. Existing records never move between shards. Any real
     * change dirties the manifest too — rows are cheap and derived.
     */
    function syncFromMirror(before) {
        const list = recordList();
        const seen = new Set();
        let changed = false;
        for (const record of list) {
            const id = String(record.id);
            seen.add(id);
            const sid = recordShard.get(id);
            if (sid === undefined) {
                placeRecord(record);
                changed = true;
                continue;
            }
            if (before.get(id) !== record) {
                const state = shardState.get(sid);
                const idx = state.records.findIndex(r => String(r.id) === id);
                if (idx !== -1) state.records[idx] = record;
                recomputeRow(sid);
                dirtyShards.add(sid);
                changed = true;
            }
        }
        for (const [id, sid] of recordShard) {
            if (seen.has(id)) continue;
            recordShard.delete(id);
            const state = shardState.get(sid);
            const idx = state.records.findIndex(r => String(r.id) === id);
            if (idx !== -1) state.records.splice(idx, 1);
            recomputeRow(sid);
            dirtyShards.add(sid);
            changed = true;
        }
        if (changed) manifestDirty = true;
        return changed;
    }

    // ── Persist (minimal core; Task 6 replaces with the merge loop) ──

    function schedulePersist() {
        if (mirror === null) return Promise.resolve(false);
        if (mode === 'readonly') return refusePersist('newer-version');
        if (mode !== 'file') return Promise.resolve(false);
        if (!writeJob) writeJob = runWriteLoop();
        return writeJob;
    }

    /** Upload every dirty shard, then the manifest. true = everything landed. */
    async function runWriteLoop() {
        let ok = true;
        try {
            while (dirtyShards.size || manifestDirty) {
                const id = dirtyShards.values().next().value;
                if (id !== undefined) {
                    dirtyShards.delete(id);
                    const state = shardState.get(id);
                    try {
                        totalBytes = await uploadDoc(shardFileName(id), shardDoc(label, version, id, state.records));
                        state.base = clone(state.records);
                    } catch (cause) {
                        dirtyShards.add(id);
                        lastWriteOk = false;
                        lastError = String(cause?.message || cause);
                        emit('store-write', { store: label, result: 'error', shard: id, level: 'error', reason: lastError });
                        notifyFailure(cause);
                        ok = false;
                        break;
                    }
                    continue;
                }
                manifestDirty = false;
                try {
                    totalBytes = await uploadDoc(manifestName, manifestDoc(label, version, shards.map(row => ({ ...row }))));
                } catch (cause) {
                    manifestDirty = true;
                    lastWriteOk = false;
                    lastError = String(cause?.message || cause);
                    emit('store-write', { store: label, result: 'error', shard: 'manifest', level: 'error', reason: lastError });
                    notifyFailure(cause);
                    ok = false;
                    break;
                }
            }
        } finally {
            writeJob = null;
        }
        if (ok) { lastWriteOk = true; lastError = null; }
        return ok;
    }

    // ── Migration ──

    /**
     * Manifest missing + monolith configured → migrate. Chunks the monolith by
     * position (its array already IS the logical order), writes the shards
     * WITHOUT merge (the monolith is the authority until the manifest commit;
     * two simultaneous migrations produce identical content and converge),
     * commits with the manifest, then tombstones the monolith. An interruption
     * before the manifest write repeats cleanly on the next ready().
     * @returns {Promise<'migrated'|'fresh'|'refused'|'unresolved'>}
     */
    async function attemptMigration() {
        let text;
        try { text = await readFile(monolithName); } catch { return 'unresolved'; }
        if (text === null) return 'fresh';
        const parsed = parseMonolith(text, version, monolithKey);
        if (parsed.reason === 'newer') {
            mode = 'readonly';
            emit('store-mode', { store: label, result: 'readonly', reason: 'newer-version' });
            refusePersist('newer-version');
            return 'refused';
        }
        const body = parsed.reason === 'found' || parsed.reason === 'older' ? parsed.value : null;
        // Monolith values differ by store: the gallery is a bare array, refs is
        // `{ refs, folders }` — the sharded collection rides `shardedKey`.
        const records = body === null ? []
            : (shardedKey ? (Array.isArray(body[shardedKey]) ? body[shardedKey] : []) : body);
        const ordered = oldestFirst(records);
        for (let i = 0; i < ordered.length; i += shardTarget) {
            const chunk = ordered.slice(i, i + shardTarget).map(record => record);
            if (append === 'front') chunk.reverse();   // shard-internal newest-first
            const id = nextShardId();
            adoptShard(id, chunk);
            dirtyShards.add(id);
        }
        manifestDirty = true;
        const outcome = await runWriteLoop();
        if (!outcome) return 'unresolved';
        await uploadDoc(monolithName, tombstoneDoc(label, version));
        emit('store-migrated', { store: label, result: 'ok', shards: shards.length, entries: records.length });
        log(`sharded-store[${label}]: migrated ${records.length} record(s) into ${shards.length} shard(s)`);
        return 'migrated';
    }
```

Заменить заглушку `async mutate(...)` в store-объекте на:

```js
        async mutate(mutator, { persist: shouldPersist = true } = {}) {
            await ready();
            if (mirror === null) mirror = empty();
            const before = new Map(recordList().map(record => [String(record.id), record]));
            const result = mutator(mirror);
            const changed = syncFromMirror(before);
            if (changed && shouldPersist) schedulePersist();
            return result;
        },
```

Заменить заглушку `persist() { return Promise.resolve(true); }` на:

```js
        persist() { return schedulePersist(); },
```

Заменить в `detectAndLoadOnce` ветку `if (text === null) { ... }` на:

```js
        if (text === null) {
            if (!monolithName) {
                mirror = empty();
                emit('store-mode', { store: label, result: 'file', reason: 'missing' });
                emit('store-load', { store: label, result: 'missing', entries: countEntries(mirror), bytes: 0, ms: Date.now() - started });
                return mode;
            }
            const verdict = await attemptMigration();
            if (verdict === 'unresolved') return null;   // monolith unreadable right now — retry
            if (verdict === 'refused') return mode;
            if (verdict === 'fresh') {
                mirror = empty();
                emit('store-mode', { store: label, result: 'file', reason: 'missing' });
                emit('store-load', { store: label, result: 'missing', entries: countEntries(mirror), bytes: 0, ms: Date.now() - started });
            }
            return mode;   // 'migrated': mirror is built, diagnostics emitted inside
        }
```

- [ ] **Step 4: Прогнать — все тесты зелёные**

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: PASS (10 тестов).

- [ ] **Step 5: Commit**

```bash
git add src/sharded-file-store.js tests/sharded-file-store.test.js
git commit -m "feat(storage): mutate→шард-дифф→запись и идемпотентная миграция монолита с tombstone"
```

---

### Task 5: Размещение вне диапазона и overflow

**Files:**
- Modify: `src/sharded-file-store.js`
- Test: `tests/sharded-file-store.test.js` (новый describe)

- [ ] **Step 1: Падающие тесты**

```js
describe('placement', () => {
    it('a full newest shard opens the next one; the record goes to the new shard', async () => {
        const store = makeStore();   // shardTarget 4
        await store.ready();
        for (let i = 0; i < 5; i++) await store.mutate(list => { list.unshift(card(i)); });
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(manifest.shards.map(s => s.id), ['s0000', 's0001']);
        assert.deepEqual(manifest.shards.map(s => s.count), [4, 1]);
        assert.deepEqual(store.snapshot().map(r => r.id),
            ['c0004', 'c0003', 'c0002', 'c0001', 'c0000']);
    });

    it('an out-of-range record (older than the newest shard) lands in the shard holding its stamp', async () => {
        const store = makeStore();
        await store.ready();
        for (let i = 0; i < 4; i++) await store.mutate(list => { list.unshift(card(i)); });
        // createdAt far in the past: placeByStamp must find s0000, not the newest shard.
        await store.mutate(list => { list.unshift(card(99, 1)); });
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(manifest.shards.map(s => s.count), [5], 'overflow allowed, no split');
        const old = JSON.parse(serverFiles.get(shardName(store, 's0000')));
        assert.equal(old.records.at(-1).id, 'c0099', 'stored at the oldest edge of the shard');
        assert.deepEqual(store.snapshot().map(r => r.id),
            ['c0003', 'c0002', 'c0001', 'c0000', 'c0099'],
            'the mirror is rebuilt into canonical newest-first order');
    });
});
```

- [ ] **Step 2: Прогнать — падение**

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: FAIL — out-of-range тест: placeRecord кладёт запись в новый шард и не восстанавливает порядок зеркала.

- [ ] **Step 3: Полный placeRecord с бинпоиском и rebuild**

Заменить `placeRecord` (версия Task 4) на:

```js
    /**
     * Place one new record. In-range adds go to the newest shard (opening the
     * next one at target size). A record older than the newest shard's range
     * (arrived via merge/import) is placed by `placeStamp` into the shard that
     * holds its stamp — overflowing it rather than splitting, so placement
     * stays deterministic across devices without B-tree machinery.
     * @returns {boolean} true when the record landed OUT of the newest shard
     *          (the mirror then needs a canonical-order rebuild)
     */
    function placeRecord(record) {
        const stamp = placeStamp(record);
        if (placeByStamp && shards.length && stamp < shards[shards.length - 1].min) {
            let target = shards[0];   // older than everything → the oldest shard
            for (const row of shards) {
                if (stamp <= row.max) { target = row; break; }
            }
            const state = shardState.get(target.id);
            let idx = state.records.length;   // default: the oldest edge
            if (append === 'front') {
                idx = state.records.findIndex(r => placeStamp(r) < stamp);
                if (idx === -1) idx = state.records.length;
            } else {
                idx = state.records.findIndex(r => placeStamp(r) > stamp);
                if (idx === -1) idx = state.records.length;
            }
            state.records.splice(idx, 0, record);
            recordShard.set(String(record.id), target.id);
            recomputeRow(target.id);
            dirtyShards.add(target.id);
            return true;
        }
        if (!shards.length || shards[shards.length - 1].count >= shardTarget) {
            adoptShard(nextShardId(), []);
            manifestDirty = true;
        }
        const row = shards[shards.length - 1];
        const state = shardState.get(row.id);
        if (append === 'front') state.records.unshift(record);
        else state.records.push(record);
        recordShard.set(String(record.id), row.id);
        recomputeRow(row.id);
        dirtyShards.add(row.id);
        return false;
    }
```

В `syncFromMirror` заменить блок размещения на фиксацию out-of-range:

```js
        let outOfRange = false;
        for (const record of list) {
            const id = String(record.id);
            seen.add(id);
            const sid = recordShard.get(id);
            if (sid === undefined) {
                if (placeRecord(record)) outOfRange = true;
                changed = true;
                continue;
            }
            // ... без изменений
        }
        if (outOfRange) rebuildMirrorFromShards();   // canonical newest-first order
```

- [ ] **Step 4: Прогнать — все тесты зелёные**

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: PASS (12 тестов).

- [ ] **Step 5: Commit**

```bash
git add src/sharded-file-store.js tests/sharded-file-store.test.js
git commit -m "feat(storage): размещение вне диапазона бинпоиском по стампам, overflow вместо расщепления"
```

---

### Task 6: Merge-per-shard, adoption чужих шардов, пустые шарды

**Files:**
- Modify: `src/sharded-file-store.js`
- Test: `tests/sharded-file-store.test.js` (новый describe)

- [ ] **Step 1: Падающие тесты**

```js
describe('merge per shard', () => {
    it('a record another tab added to a shard survives our write, sorted by stamp', async () => {
        const store = makeStore();
        await store.ready();
        await store.mutate(list => { list.unshift(card(0)); });
        // Another tab (same base) added its own newer card directly on the server.
        const shard = JSON.parse(serverFiles.get(shardName(store, 's0000')));
        shard.records.unshift(card(50, 1_700_000_050_000));
        serverFiles.set(shardName(store, 's0000'), JSON.stringify(shard));
        await store.mutate(list => { list.unshift(card(1)); });
        await store.flush();
        const written = JSON.parse(serverFiles.get(shardName(store, 's0000')));
        assert.deepEqual(written.records.map(r => r.id), ['c0050', 'c0001', 'c0000'],
            'merged content sorted newest-first within the shard');
        assert.ok(store.snapshot().some(r => r.id === 'c0050'), 'the mirror adopted it');
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.equal(manifest.shards[0].count, 3, 'manifest row reflects the merged shard');
    });

    it('a shard another tab created (unknown to our manifest) is adopted, not clobbered', async () => {
        const store = makeStore();
        await store.ready();
        await store.mutate(list => { list.unshift(card(0)); });
        // Foreign tab: new shard s0001 + updated manifest.
        serverFiles.set(shardName(store, 's0001'), JSON.stringify({
            v: 1, kind: 'shard', store: 'x', id: 's0001',
            records: [card(100, 1_700_100_000_000)],
        }));
        serverFiles.set(manifestName(store), JSON.stringify({
            v: 1, kind: 'manifest', store: 'x',
            shards: [
                { id: 's0000', count: 1, min: 1_700_000_000_000, max: 1_700_000_000_000 },
                { id: 's0001', count: 1, min: 1_700_100_000_000, max: 1_700_100_000_000 },
            ],
        }));
        await store.mutate(list => { list.unshift(card(1)); });
        await store.flush();
        assert.ok(store.snapshot().some(r => r.id === 'c0100'), 'foreign shard records adopted');
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(manifest.shards.map(s => s.id), ['s0000', 's0001'],
            'the foreign shard is kept in the manifest');
        assert.ok(serverFiles.get(shardName(store, 's0001')), 'the foreign shard file survives');
    });

    it('a shard emptied by deletions is written empty and dropped from the manifest', async () => {
        const store = makeStore();
        await store.ready();
        for (let i = 0; i < 5; i++) await store.mutate(list => { list.unshift(card(i)); });
        // counts [4,1]: s0001 holds only c0004.
        await store.mutate(list => {
            const i = list.findIndex(r => r.id === 'c0004');
            list.splice(i, 1);
        });
        await store.flush();
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(manifest.shards.map(s => s.id), ['s0000'], 'the emptied shard left the manifest');
        const emptied = JSON.parse(serverFiles.get(shardName(store, 's0001')));
        assert.deepEqual(emptied.records, [], 'the file is overwritten empty, not deleted');
        assert.deepEqual(store.snapshot().map(r => r.id), ['c0003', 'c0002', 'c0001', 'c0000']);
    });

    it('migration writes clobber (no merge): an interrupted migration converges', async () => {
        const store = makeStore();
        serverFiles.set(`t${labelCounter}_old.json`, JSON.stringify({ v: 1, cards: [card(1), card(0)] }));
        serverFiles.set(shardName(store, 's0000'), JSON.stringify({
            v: 1, kind: 'shard', store: 'x', id: 's0000', records: [card(0)],
        }));
        assert.equal(await store.ready(), 'file');
        assert.deepEqual(store.snapshot().map(r => r.id), ['c0001', 'c0000'],
            'the monolith is the migration authority — the partial shard does not eat its records');
    });
});
```

- [ ] **Step 2: Прогнать — падение**

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: FAIL — write loop пишет без merge, adoption нет, пустые шарды не убираются.

- [ ] **Step 3: Финальный write loop с merge, adoption, suppressMergeOnce, пустыми шардами**

Заменить `runWriteLoop` (версия Task 4) и добавить новые функции. Полные тела:

```js
    // ── Persist: serialized loop — dirty shards first (merge per shard), manifest last ──

    function schedulePersist() {
        if (mirror === null) return Promise.resolve(false);
        if (mode === 'readonly') return refusePersist('newer-version');
        if (mode !== 'file') return Promise.resolve(false);
        if (!writeJob) writeJob = runWriteLoop();
        return writeJob;
    }

    /**
     * Merge the server copy of one shard into the local records. Returns the
     * records to upload (local when there is nothing to blend). A `newer`
     * shard refuses the write for the session.
     */
    async function mergeShardWithServer(id, local) {
        if (!mergeWithServer || suppressMergeOnce) return { records: local };
        const text = await readFile(shardFileName(id));
        if (text === null) return { records: local };   // 404: nothing on server
        const parsed = parseShard(text, version);
        if (parsed.reason === 'newer') { refusePersist('newer-version'); return { records: null, refused: true }; }
        if (parsed.reason !== 'found' && parsed.reason !== 'older') return { records: local };
        const state = shardState.get(id);
        const merged = mergeServerValue(state.base || [], parsed.value, local);
        if (merged === null) return { records: local };
        return { records: merged };
    }

    /**
     * Splice merged records back: the shard state becomes the merged array,
     * `append: 'front'` shards are re-sorted newest-first (merge appends
     * foreign additions at the end; the stamp order is the shard contract),
     * and the mirror is rebuilt so reads see the true state.
     */
    function applyMergedRecords(id, records) {
        const state = shardState.get(id);
        if (append === 'front') {
            records.sort((a, b) => placeStamp(b) - placeStamp(a));
        }
        state.records = records;
        recomputeRow(id);
        rebuildMirrorFromShards();
    }

    /** Load and merge a shard this session has never seen (another tab made it). */
    async function adoptForeignShard(row) {
        try {
            const text = await readFile(shardFileName(row.id));
            if (text === null) return false;
            const parsed = parseShard(text, version);
            if (parsed.reason !== 'found' && parsed.reason !== 'older') return false;
            adoptShard(row.id, parsed.value);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Upload one dirty shard with a pre-write merge. The merged content (if
     * any) becomes the mirror's version of those records before the upload.
     */
    async function writeShard(id) {
        const started = Date.now();
        const state = shardState.get(id);
        const { records, refused } = await mergeShardWithServer(id, state.records);
        if (refused) return false;
        if (records !== state.records) applyMergedRecords(id, records);
        const bytes = await uploadDoc(shardFileName(id), shardDoc(label, version, id, records));
        state.base = clone(records);
        totalBytes = bytes;
        emit('store-write', { store: label, result: 'success', shard: id, entries: records.length, bytes, ms: Date.now() - started });
        return true;
    }

    /**
     * Upload the manifest. Foreign shard rows unknown to this session are
     * adopted first (their records fetched and merged into the mirror), then
     * the row set is three-way merged (base = our last committed manifest) so
     * foreign deletions of untouched shards are honored. Rows without local
     * shard state (undeliverable adoption) are skipped, never invented.
     */
    async function writeManifest(manifestBase) {
        const started = Date.now();
        let serverRows = null;
        if (mergeWithServer && !suppressMergeOnce) {
            const text = await readFile(manifestName);
            if (text !== null) {
                const parsed = parseManifest(text, version);
                if (parsed.reason === 'newer') { refusePersist('newer-version'); return false; }
                if (parsed.reason === 'found' || parsed.reason === 'older') serverRows = parsed.value.shards;
                // corrupt → our rows are the only source: the write rebuilds
            }
        }
        if (serverRows) {
            for (const row of serverRows) {
                if (rowFor(row.id)) continue;
                await adoptForeignShard(row);
            }
            if (shards.some(row => !manifestBase.some(baseRow => baseRow.id === row.id))) {
                rebuildMirrorFromShards();   // adopted records must reach the mirror
            }
        }
        const ourRows = shards.map(row => ({ ...row }));
        let rows = ourRows;
        if (serverRows) {
            const merged = mergeServerValue(manifestBase, serverRows, ourRows);
            if (merged) rows = merged.filter(row => shardState.has(row.id) || emptyShards.has(row.id));
        }
        shards = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const bytes = await uploadDoc(manifestName, manifestDoc(label, version, shards.map(row => ({ ...row }))));
        totalBytes = bytes;
        emit('store-write', { store: label, result: 'success', shard: 'manifest', entries: countEntries(mirror), bytes, ms: Date.now() - started });
        return true;
    }

    async function runWriteLoop() {
        let ok = true;
        let failed = null;
        const manifestBase = shards.map(row => ({ ...row }));
        try {
            while (true) {
                const id = dirtyShards.values().next().value;
                if (id === undefined) break;
                dirtyShards.delete(id);
                if (emptyShards.has(id)) {
                    // The shard lost every record: overwrite it empty (no
                    // DELETE route) and drop it from the manifest.
                    emptyShards.delete(id);
                    try {
                        await uploadDoc(shardFileName(id), shardDoc(label, version, id, []));
                    } catch (cause) {
                        dirtyShards.add(id);
                        emptyShards.add(id);
                        failed = { cause, shard: id };
                        break;
                    }
                    shardState.delete(id);
                    shards = shards.filter(row => row.id !== id);
                    for (const [rid, sid] of recordShard) if (sid === id) recordShard.delete(rid);
                    manifestDirty = true;
                    continue;
                }
                try {
                    if (!(await writeShard(id))) { ok = false; break; }
                } catch (cause) {
                    dirtyShards.add(id);   // stays pending: next mutation or flush retries
                    failed = { cause, shard: id };
                    break;
                }
            }
            if (ok && manifestDirty) {
                manifestDirty = false;
                try {
                    if (!(await writeManifest(manifestBase))) ok = false;
                } catch (cause) {
                    manifestDirty = true;
                    failed = { cause, shard: 'manifest' };
                }
            }
        } finally {
            writeJob = null;
            suppressMergeOnce = false;   // consumed: the next settle merges again
        }
        if (failed) {
            ok = false;
            lastWriteOk = false;
            lastError = String(failed.cause?.message || failed.cause);
            emit('store-write', { store: label, result: 'error', shard: failed.shard, level: 'error', reason: lastError });
            notifyFailure(failed.cause);
        } else if (ok) {
            lastWriteOk = true;
            lastError = null;
        }
        return ok;
    }
```

И в `attemptMigration` перед `const outcome = await runWriteLoop();` добавить:

```js
        suppressMergeOnce = true;   // the monolith is the migration authority
```

И в `syncFromMirror` — ветку пустых шардов (в цикле удалений после `recomputeRow(sid);`):

```js
            if (shardState.get(sid).records.length === 0 && shards.length > 1) emptyShards.add(sid);
```

- [ ] **Step 4: Прогнать — все тесты зелёные**

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: PASS (16 тестов), включая миграционные из Task 4.

- [ ] **Step 5: Commit**

```bash
git add src/sharded-file-store.js tests/sharded-file-store.test.js
git commit -m "feat(storage): merge-per-shard, adoption чужих шардов, пустые шарды, suppressMerge для миграции"
```

---

### Task 7: replace() и meta-файл (спутники малого размера)

**Files:**
- Modify: `src/sharded-file-store.js`
- Test: `tests/sharded-file-store.test.js` (новый describe)

- [ ] **Step 1: Падающие тесты**

```js
describe('replace and meta', () => {
    it('replace() re-chunks the value by position and clobbers the server (no merge)', async () => {
        const store = makeStore();
        await store.ready();
        await store.mutate(list => { list.unshift(card(0)); });
        await store.flush();
        // A foreign record lands on the server between our writes:
        const shard = JSON.parse(serverFiles.get(shardName(store, 's0000')));
        shard.records.unshift(card(50));
        serverFiles.set(shardName(store, 's0000'), JSON.stringify(shard));
        await store.replace([card(9), card(8), card(7), card(6), card(5)]);
        const written = JSON.parse(serverFiles.get(shardName(store, 's0000')));
        assert.deepEqual(written.records.map(r => r.id), ['c0005', 'c0006', 'c0007', 'c0008'],
            'restore clobbers: the foreign record is NOT merged back');
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(manifest.shards.map(s => s.count), [4, 1]);
        assert.deepEqual(store.snapshot().map(r => r.id), ['c0009', 'c0008', 'c0007', 'c0006', 'c0005']);
    });

    it('meta carries a satellite array in its own file; mutate syncs it', async () => {
        const store = makeStore({
            shardedKey: 'refs',
            append: 'back',
            placeByStamp: false,
            empty: () => ({ refs: [], folders: [] }),
            countEntries: value => (Array.isArray(value?.refs) ? value.refs.length : null),
            meta: { name: `t${labelCounter}_meta.json`, keys: ['folders'], empty: () => ({ folders: [] }) },
        });
        await store.ready();
        await store.mutate(data => {
            data.refs.push(card(0));
            data.folders.push({ id: 'f1', name: 'Пейзажи' });
        });
        await store.flush();
        const metaFile = JSON.parse(serverFiles.get(`t${labelCounter}_meta.json`));
        assert.deepEqual(metaFile.data.folders.map(f => f.id), ['f1']);
        assert.deepEqual(store.snapshot().folders.map(f => f.id), ['f1']);
        assert.deepEqual(store.snapshot().refs.map(r => r.id), ['c0000']);
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.equal(manifest.shards.length, 1, 'folders never touch the manifest');
    });
});
```

- [ ] **Step 2: Прогнать — падение**

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: FAIL.

- [ ] **Step 3: replace + meta composite**

1. Импорт в `src/sharded-file-store.js` дополнить `createFileStore`:

```js
import {
    KEEPALIVE_BODY_LIMIT, createFileStore, textToBase64, stHeaders, mergeServerValue,
    parseVersionedDoc, registerFileStoreForDiagnostics,
} from './file-store.js';
```

2. В деструктуризацию config добавить `meta = null,`; после деструктуризации создать meta-стор:

```js
    // Small satellite arrays (refs folders) that must not ride the manifest:
    // the manifest has to be rebuildable from a shard scan alone, so anything
    // not derivable from the shards lives in its own plain file-store.
    const metaStore = meta ? createFileStore({
        label: `${label}-meta`,
        name: meta.name,
        version,
        key: 'data',
        empty: meta.empty || (() => ({})),
        mergeWithServer: true,
        onWriteFailure,
    }) : null;
```

3. Реализовать `syncMeta` (после `applyMergedRecords`) и гидрацию зеркала. Полные тела:

```js
    // ── Meta satellite ──

    /** Hydrate the mirror's satellite keys from the meta store. */
    async function hydrateMeta() {
        if (!metaStore || !meta?.keys?.length) return;
        await metaStore.ready();
        const satellite = metaStore.snapshot() || meta.empty();
        for (const key of meta.keys) mirror[key] = clone(satellite[key]);
    }

    /** Push the mirror's satellite keys into the meta store when they differ. */
    async function syncMeta(force = false) {
        if (!metaStore || !meta?.keys?.length) return;
        const satellite = {};
        for (const key of meta.keys) satellite[key] = clone(mirror[key]);
        const current = metaStore.snapshot();
        if (!force && JSON.stringify(current) === JSON.stringify(satellite)) return;
        await metaStore.mutate(m => {
            for (const k of Object.keys(m)) delete m[k];
            Object.assign(m, satellite);
        });
        await metaStore.flush();
    }
```

4. Вызвать `await hydrateMeta();` в `detectAndLoadOnce` в ДВУХ местах: перед `return mode;` успешной загрузки манифеста (после `rebuildMirrorFromShards();`) и перед `return mode;` ветки `'migrated'`.

5. В `mutate` после `syncFromMirror(before)` добавить:

```js
            if (metaStore) await syncMeta();
```

6. Заменить заглушку `async replace(value) { mirror = value; }` на:

```js
        /**
         * Replace the whole value and await durability (backup restore). The
         * server is clobbered, not merged (suppressMergeOnce): shards are
         * re-chunked by position from the value.
         */
        async replace(value) {
            await ready();
            mirror = value === undefined ? empty() : value;
            shards = [];
            shardState = new Map();
            recordShard = new Map();
            dirtyShards = new Set();
            emptyShards = new Set();
            const ordered = oldestFirst(recordList());
            for (let i = 0; i < ordered.length; i += shardTarget) {
                const chunk = ordered.slice(i, i + shardTarget).map(record => record);
                if (append === 'front') chunk.reverse();
                const id = nextShardId();
                adoptShard(id, chunk);
                dirtyShards.add(id);
            }
            manifestDirty = true;
            suppressMergeOnce = true;
            if (metaStore) await syncMeta(true);
            const job = schedulePersist();
            if (job) await job;
            return lastWriteOk;
        },
```

7. В `reset()` добавить `if (metaStore) metaStore.reset();` (после `refusedNotified.clear();`).

- [ ] **Step 4: Прогнать — все тесты зелёные**

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: PASS (18 тестов).

- [ ] **Step 5: Commit**

```bash
git add src/sharded-file-store.js tests/sharded-file-store.test.js
git commit -m "feat(storage): replace() с переразбивкой и meta-файл для спутников малого размера"
```

---

### Task 8: Восстановление манифеста и ретрай упавшей записи

**Files:**
- Modify: `src/sharded-file-store.js`
- Test: `tests/sharded-file-store.test.js` (новый describe)

- [ ] **Step 1: Падающие тесты**

```js
describe('manifest recovery', () => {
    it('a corrupt manifest is rebuilt by probing the shard sequence and re-written', async () => {
        const store = makeStore();
        serverFiles.set(manifestName(store), '{ not json');
        serverFiles.set(shardName(store, 's0000'), JSON.stringify({
            v: 1, kind: 'shard', store: 'x', id: 's0000', records: [card(1), card(0)],
        }));
        serverFiles.set(shardName(store, 's0001'), JSON.stringify({
            v: 1, kind: 'shard', store: 'x', id: 's0001', records: [card(2)],
        }));
        assert.equal(await store.ready(), 'file');
        assert.deepEqual(store.snapshot().map(r => r.id), ['c0002', 'c0001', 'c0000']);
        const rebuilt = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(rebuilt.shards.map(s => s.id), ['s0000', 's0001']);
        assert.deepEqual(rebuilt.shards.map(s => s.count), [2, 1]);
    });

    it('a failed upload keeps the shard dirty; the next mutation re-sends it', async () => {
        const store = makeStore();
        await store.ready();
        failUploads = true;
        await store.mutate(list => { list.unshift(card(0)); });
        assert.equal(await store.flush(), false);
        failUploads = false;
        await store.mutate(list => { list.unshift(card(1)); });
        assert.equal(await store.flush(), true);
        const shard = JSON.parse(serverFiles.get(shardName(store, 's0000')));
        assert.deepEqual(shard.records.map(r => r.id), ['c0001', 'c0000']);
    });
});
```

- [ ] **Step 2: Прогнать — падение**

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: FAIL.

- [ ] **Step 3: rebuildFromScan + ветка corrupt**

В `src/sharded-file-store.js` добавить после `loadShards`:

```js
    /**
     * The manifest is corrupt or lost, but shard files may exist. Shard ids
     * are gapless s0000…sNNNN by construction, so the sequence is recoverable
     * by probing GETs until the first 404 (user-files has no directory
     * listing). Every readable shard is adopted; the rebuilt manifest is
     * written immediately so the next session does not re-probe.
     */
    async function rebuildFromScan() {
        shards = [];
        shardState = new Map();
        recordShard = new Map();
        for (let n = 0; n < 10_000; n++) {
            const id = 's' + String(n).padStart(4, '0');
            let text;
            try { text = await readFile(shardFileName(id)); } catch { break; }
            if (text === null) break;
            const parsed = parseShard(text, version);
            if (parsed.reason !== 'found' && parsed.reason !== 'older') break;
            adoptShard(id, parsed.value);
        }
        rebuildMirrorFromShards();
        if (shards.length) {
            manifestDirty = true;
            await writeManifest([]);
            emit('store-recovered', { store: label, result: 'ok', shards: shards.length, entries: countEntries(mirror) });
            log(`sharded-store[${label}]: manifest rebuilt from ${shards.length} shard(s)`);
        }
    }
```

Заменить в `detectAndLoadOnce` ветку `if (parsed.reason === 'corrupt') { ... }` на:

```js
        if (parsed.reason === 'corrupt') {
            mirror = empty();
            await rebuildFromScan();
            emit('store-mode', { store: label, result: 'file', reason: 'corrupt-manifest' });
            return mode;
        }
```

- [ ] **Step 4: Прогнать — все тесты зелёные**

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: PASS (20 тестов).

- [ ] **Step 5: Commit**

```bash
git add src/sharded-file-store.js tests/sharded-file-store.test.js
git commit -m "feat(storage): восстановление манифеста probe'ом последовательности шардов, ретрай упавшей записи"
```

---

### Task 9: flush/flushOnUnload — финал публичного контракта

**Files:**
- Modify: `src/sharded-file-store.js`
- Test: `tests/sharded-file-store.test.js` (новый describe)

- [ ] **Step 1: Падающие тесты**

```js
describe('flush surface', () => {
    it('flushOnUnload sends small dirty shards with keepalive and skips big ones', async () => {
        const small = makeStore();
        await small.ready();
        await small.mutate(list => { list.unshift(card(0)); });
        small.flushOnUnload();
        assert.ok(uploads.some(u => u.keepalive), 'a small dirty shard rides the keepalive');
        const big = makeStore({ keepaliveLimit: 10 });
        await big.ready();
        await big.mutate(list => { list.unshift(card(0)); });
        const before = uploads.filter(u => u.keepalive).length;
        big.flushOnUnload();   // payload way over 10 bytes → skipped honestly
        assert.equal(uploads.filter(u => u.keepalive).length, before, 'over-limit flush is skipped');
    });

    it('footprint reports manifest file, total entries and last write bytes', async () => {
        const store = makeStore();
        await store.ready();
        await store.mutate(list => { list.unshift(card(0)); });
        const fp = store.footprint();
        assert.equal(fp.file, manifestName(store));
        assert.equal(fp.entries, 1);
        assert.equal(fp.mode, 'file');
        assert.equal(fp.lastWriteOk, true);
        assert.ok(fp.bytes > 0);
    });
});
```

- [ ] **Step 2: Прогнать — падение**

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: FAIL (flushOnUnload заглушка ничего не шлёт).

- [ ] **Step 3: Реализовать flush/flushOnUnload**

Заменить заглушки в store-объекте:

```js
        /** Await quiescence: every mutation issued so far has reached the server. */
        async flush() {
            let guard = 0;
            while (writeJob && guard++ < 1000) await writeJob;
            if (metaStore) await metaStore.flush();
            return lastWriteOk;
        },

        /**
         * Last-chance durability on page unload: dirty shards whose payloads
         * fit the keepalive cap fly with `keepalive: true` (idempotent
         * full-file writes). Over-limit shards are skipped with one aggregated
         * event — the same honest behavior as file-store, at shard size.
         * Dirty flags are NOT cleared: the write loop re-sending identical
         * content later is harmless.
         */
        flushOnUnload() {
            if (mode !== 'file' || (!dirtyShards.size && !manifestDirty)) return;
            let sent = 0, skipped = 0, bytes = 0;
            for (const id of [...dirtyShards]) {
                const state = shardState.get(id);
                if (!state) continue;
                const json = JSON.stringify(shardDoc(label, version, id, state.records));
                if (json.length > keepaliveLimit) { skipped++; continue; }
                try {
                    void fetch(UPLOAD_URL, {
                        method: 'POST',
                        headers: stHeaders(),
                        body: JSON.stringify({ name: shardFileName(id), data: textToBase64(json) }),
                        keepalive: true,
                    });
                    sent++;
                    bytes += json.length;
                } catch { /* nothing else can be done during teardown */ }
            }
            if (manifestDirty) {
                const json = JSON.stringify(manifestDoc(label, version, shards.map(row => ({ ...row }))));
                if (json.length <= keepaliveLimit) {
                    try {
                        void fetch(UPLOAD_URL, {
                            method: 'POST',
                            headers: stHeaders(),
                            body: JSON.stringify({ name: manifestName, data: textToBase64(json) }),
                            keepalive: true,
                        });
                        sent++;
                        bytes += json.length;
                    } catch { /* teardown */ }
                } else skipped++;
            }
            if (sent || skipped) {
                emit('store-unload-flush', { store: label, result: sent ? 'sent' : 'skipped', shards: sent, skipped, bytes });
            }
        },
```

- [ ] **Step 4: Прогнать — все тесты зелёные**

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: PASS (22 теста).

- [ ] **Step 5: Commit**

```bash
git add src/sharded-file-store.js tests/sharded-file-store.test.js
git commit -m "feat(storage): flush/flushOnUnload шардированного стора — keepalive только для мелких грязных шардов"
```

---

### Task 10: Подключение галереи

**Files:**
- Modify: `src/gallery-index.js:25,55-70` (импорт и конструкция стора)
- Test: `tests/sharded-file-store.test.js` (интеграционный) + существующие галерейные тесты

- [ ] **Step 1: Падающий интеграционный тест**

Добавить в `tests/sharded-file-store.test.js`:

```js
describe('gallery-index integration', () => {
    it('addCard writes a shard + manifest, never the monolith', async () => {
        const { addCard, listCards, resetGalleryStoreForTests } = await import('../src/gallery-index.js');
        resetGalleryStoreForTests();
        await addCard({ imagePath: 'default/uris_test.png', prompt: 'x', provenance: { chatId: 'c1' } });
        await listCards({ reconcile: false });
        const names = [...serverFiles.keys()];
        assert.ok(names.some(n => n.startsWith('uris_gallery_manifest')), 'manifest written');
        assert.ok(names.some(n => n.startsWith('uris_gallery_shard_')), 'shard written');
        assert.equal(names.includes('uris_gallery.json'), false, 'monolith not touched by a fresh store');
        resetGalleryStoreForTests();
    });
});
```

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: FAIL — галерея ещё на createFileStore (пишет `uris_gallery.json`).

- [ ] **Step 2: Переключить gallery-index.js**

В `src/gallery-index.js`:

1. Импорт (строка 25):

```js
import { createShardedFileStore } from './sharded-file-store.js';
```

2. Заменить конструкцию `galleryStore` (строки 55–70):

```js
const galleryStore = createShardedFileStore({
    label: 'gallery',
    manifestName: 'uris_gallery_manifest.json',
    shardPrefix: 'uris_gallery_shard_',
    monolithName: GALLERY_FILE_NAME,
    monolithKey: GALLERY_STORE_KEY,
    version: GALLERY_STORE_VERSION,
    shardTarget: 250,
    append: 'front',
    placeByStamp: true,
    placeStamp: r => (Number.isFinite(r?.createdAt) ? r.createdAt : 0),
    empty: () => [],
    countEntries: value => (Array.isArray(value) ? value.length : null),
    // The card index is edited by every device and every tab this user's data
    // syncs to — merge-per-shard carries the same concurrent-writer safety the
    // whole-document merge used to (2026-09-14 incident class), at shard size.
    mergeWithServer: true,
});
```

`GALLERY_FILE_NAME` остаётся экспортом — это теперь имя монолита-источника миграции.

- [ ] **Step 3: Прогнать галерейные тесты**

Run: `node --test tests/gallery-index.test.js tests/gallery-file-store.test.js tests/sharded-file-store.test.js 2>&1 | tail -8`
Expected: PASS. Если тесты с ожиданием имени `uris_gallery.json` в uploads падают — заменить ожидания на манифест/шарды ОТДЕЛЬНЫМ коммитом:

```bash
git add tests/gallery-index.test.js tests/gallery-file-store.test.js
git commit -m "test(gallery): ожидания монолита → манифест+шарды (индекс переехал на шардированный стор)"
```

- [ ] **Step 4: Commit**

```bash
git add src/gallery-index.js tests/sharded-file-store.test.js
git commit -m "feat(gallery): индекс карточек переезжает на шардированный стор — мутации пишут один шард"
```

---

### Task 11: Подключение референсов (meta-файл папок)

**Files:**
- Modify: `src/refs-library.js:29-30,53-64`
- Test: `tests/refs-library.test.js` + `tests/sharded-file-store.test.js`

- [ ] **Step 1: Падающий тест миграции референсов**

Добавить в `tests/sharded-file-store.test.js` (в describe 'replace and meta'):

```js
    it('refs monolith migration: refs go to shards, folders go to the meta file', async () => {
        const store = makeStore({
            shardedKey: 'refs',
            append: 'back',
            placeByStamp: false,
            empty: () => ({ refs: [], folders: [] }),
            countEntries: value => (Array.isArray(value?.refs) ? value.refs.length : null),
            meta: { name: `t${labelCounter}_meta.json`, keys: ['folders'], empty: () => ({ folders: [] }) },
        });
        serverFiles.set(`t${labelCounter}_old.json`, JSON.stringify({
            v: 1, data: { refs: [card(1), card(0)], folders: [{ id: 'f1', name: 'x' }] },
        }));
        assert.equal(await store.ready(), 'file');
        assert.deepEqual(store.snapshot().refs.map(r => r.id), ['c0000', 'c0001']);
        assert.deepEqual(store.snapshot().folders.map(f => f.id), ['f1']);
        const metaFile = JSON.parse(serverFiles.get(`t${labelCounter}_meta.json`));
        assert.deepEqual(metaFile.data.folders.map(f => f.id), ['f1']);
        const tomb = JSON.parse(serverFiles.get(`t${labelCounter}_old.json`));
        assert.equal(tomb.kind, 'migrated');
    });
```

Run: `node --test tests/sharded-file-store.test.js 2>&1 | tail -6`
Expected: FAIL — `attemptMigration` пока не переносит folders в meta.

- [ ] **Step 2: Реализовать перенос папок при миграции**

В `attemptMigration` после извлечения `records` добавить:

```js
        if (shardedKey && body && metaStore) {
            // Satellite arrays (refs folders) ride the meta store, never shards.
            await metaStore.ready();
            await metaStore.mutate(m => {
                for (const key of meta.keys) {
                    delete m[key];
                    if (Array.isArray(body[key])) m[key] = clone(body[key]);
                }
            });
            await metaStore.flush();
        }
```

- [ ] **Step 3: Переключить refs-library.js**

В `src/refs-library.js`:

1. Импорт: `import { createFileStore } from './file-store.js';` →

```js
import { createShardedFileStore } from './sharded-file-store.js';
```

2. Константы (строки 29–30) дополнить:

```js
export const REFS_FILE_NAME = 'uris_refs.json';
export const REFS_MANIFEST_NAME = 'uris_refs_manifest.json';
export const REFS_META_NAME = 'uris_refs_meta.json';
export const REFS_STORE_VERSION = 1;
```

3. Заменить `refsStore` (строки 53–64):

```js
const refsStore = createShardedFileStore({
    label: 'references',
    manifestName: REFS_MANIFEST_NAME,
    shardPrefix: 'uris_refs_shard_',
    monolithName: REFS_FILE_NAME,
    monolithKey: 'data',
    version: REFS_STORE_VERSION,
    shardTarget: 250,
    append: 'back',
    placeByStamp: false,
    shardedKey: 'refs',
    // refs: insertion-ordered array; folders are a small satellite array that
    // must not ride the manifest (the manifest has to be rebuildable from a
    // shard scan alone — user-files has no directory listing).
    meta: { name: REFS_META_NAME, keys: ['folders'], empty: () => ({ folders: [] }) },
    empty: () => ({ refs: [], folders: [] }),
    countEntries: value => (Array.isArray(value?.refs) ? value.refs.length : null),
    // The pool file is edited by every device this user's data syncs to
    // (Syncthing mirror, second browser): merge-per-shard keeps the
    // concurrent-writer safety of the whole-document merge.
    mergeWithServer: true,
});
```

- [ ] **Step 4: Прогнать референс-тесты**

Run: `node --test tests/refs-library.test.js tests/sharded-file-store.test.js 2>&1 | tail -8`
Expected: PASS. Падения ожиданий с именем `uris_refs.json` — отдельным коммитом:

```bash
git add tests/refs-library.test.js
git commit -m "test(refs): ожидания монолита → манифест+шарды+meta (пул переехал на шардированный стор)"
```

- [ ] **Step 5: Commit**

```bash
git add src/refs-library.js tests/sharded-file-store.test.js
git commit -m "feat(refs): пул референсов на шардированном стор, папки — в meta-файле"
```

---

### Task 12: Полный прогон, панель хранилища, шапка file-store

**Files:**
- Modify: `src/file-store.js` (шапка-комментарий), опционально `src/ui/tab-settings.js`

- [ ] **Step 1: Полный прогон**

Run: `npm test 2>&1 | tail -8`
Expected: `fail 0`.

- [ ] **Step 2: Проверить панель хранилища**

Run: `grep -n "footprint\|listFileStores" src/ui/tab-settings.js | head`
Expected: панель читает `label/file/mode/entries/bytes/lastWriteOk` — форма не изменилась (`file` теперь покажет `uris_gallery_manifest.json` — честно). Опционально: добавить показ `diagnostics().shards`.

- [ ] **Step 3: Обновить шапку file-store.js**

После абзаца про mergeWithServer в шапке `src/file-store.js` добавить:

```
 * Large collections (gallery index, reference pool) use the sharded sibling
 * `createShardedFileStore` — same contract, shard-sized writes; see
 * docs/2026-10-03-sharded-file-store-design.md.
```

- [ ] **Step 4: Финальный коммит**

```bash
git add -A
git commit -m "feat(storage): шардирование галереи и референсов — стоимость записи ограничена размером шарда"
```

---

## Self-review плана (выполнено при написании)

1. **Spec coverage:** bounded writes (Tasks 4–6), параллельная загрузка (Task 3), неизменный API (Tasks 10–11), миграция с tombstone и точкой коммита (Task 4, 11), отказы: неполный шард → readonly (Task 3), rebuild манифеста probe'ом (Task 8), ретрай записи (Task 8), пустые шарды (Task 6), merge-per-shard + adoption (Task 6), meta (Task 7), flush (Task 9), панель (Task 12). Ленивое чтение — фаза 2 (спека), в план не входит сознательно.
2. **Плейсхолдеры:** запрещены; каждая заглушка помечена задачей-заменой.
3. **Типы:** `manifestRow = {id, count, min, max}`; `shardDoc = {v, kind:'shard', store, id, records}`; `placeStamp` (createdAt, размещение) отделён от merge-стампа (updatedAt внутри `mergeRecordArray`); `meta.keys` (массив, НЕ `meta.key`); `writeManifest(manifestBase)`; `placeRecord → boolean` (out-of-range).
4. **Порядковые ловушки, закрытые в коде:** merge добавляет чужие записи в конец → `applyMergedRecords` сортирует front-шарды по стампу; миграция/replace пишутся с `suppressMergeOnce` (монолит и бэкап — авторитеты); out-of-range вставка требует rebuild зеркала; `manifestDirty` ставится на любое изменение (строки дёшевы).

## Известные сознательные упрощения (зафиксированы в спеке)

- KNOWN LIMITATION `mergeRecordArray` (воскрешение чужих удалений) наследуется per-shard — то же поведение, что сегодня на всём документе, не хуже.
- Ленивое чтение — фаза 2 (отдельный цикл после мобильного UX-прохода).
- Пустой шард перезаписывается пустым `records: []`; DELETE-роут не используется. После rebuild-скана пустой файл даёт строку с `count: 0` — безвредно, само-сходится при следующей записи манифеста.
- Строки манифеста — производные данные: расхождение счётчиков между табами само-сходится при следующей записи шарда.
