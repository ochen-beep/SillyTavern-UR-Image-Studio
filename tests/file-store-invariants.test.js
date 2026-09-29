// @ts-check
/**
 * Инварианты файлового стора, которые обязаны пережить удаление
 * settings.json-мира (миграция + legacy-фолбэк). Тесты написаны ДО пореза и
 * сформулированы на уровне контракта стора, а не его внутренних режимов:
 *   1. 404 на пробе хранилища — перманентен: никаких записей в файлы, навсегда.
 *   2. Сетевая недоступность хранилища на старте не затирает существующий файл
 *      пустой базой (главная опасность full-file overwrite).
 *   3. Работа пользователя, сделанная в окне сбоя пробы, не теряется: после
 *      восстановления поверхности она доезжает до файла.
 * Мир-агностичны: проходят до и после удаления legacy-веток.
 */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

const serverFiles = new Map();   // name → file text (what the server would store)
const uploads = [];              // { name, data, keepalive }
let probeThrows = false;
let verifyAvailable = true;

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
        libs: {
            localforage: {
                async getItem() { return null; },
                async setItem() {},
                async removeItem() {},
            },
        },
    };
    globalThis.toastr = { error: msg => toastErrors.push(msg), warning: msg => toastErrors.push(msg) };
    globalThis.fetch = fetchStub;
}

let probeCalls = 0;
const fetchStub = async (url, options = {}) => {
    if (url === '/api/files/verify') {
        probeCalls += 1;
        if (probeThrows) throw new Error('offline');
        if (!verifyAvailable) return { ok: false, status: 404, text: async () => '' };
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    if (url === '/api/files/upload' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        uploads.push({ ...body, keepalive: options.keepalive === true });
        serverFiles.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    if (url.startsWith('/user/files/')) {
        const name = decodeURIComponent(url.slice('/user/files/'.length));
        if (!serverFiles.has(name)) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
        return { ok: true, status: 200, text: async () => serverFiles.get(name), json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

const { createFileStore, resetFileStoresForTests } = await import('../src/file-store.js');

let labelCounter = 0;
function makeStore() {
    const label = `inv-${++labelCounter}`;
    return createFileStore({
        label,
        name: `uris_inv_${label}.json`,
        key: 'items',
        version: 1,
        empty: () => [],
        stripLegacyOnLoad: true,
        legacyRead: () => null,
        legacyWrite: null,
        probeRetryMs: 10,
    });
}

function serverDoc(store) {
    return JSON.parse(serverFiles.get(store.name)).items;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Поллинг условия с дедлайном: результат важнее пути — зависший промис не должен вешать тест. */
async function waitFor(cond, ms = 4000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (cond()) return true;
        await sleep(20);
    }
    return cond();
}

beforeEach(() => {
    installStubs();
    serverFiles.clear();
    uploads.length = 0;
    probeThrows = false;
    verifyAvailable = true;
    toastErrors.length = 0;
});

afterEach(() => {
    resetFileStoresForTests();
    globalThis.fetch = originalFetch;
});

after(() => {
    globalThis.SillyTavern = originalSt;
    globalThis.toastr = originalToastr;
});

describe('file-store invariants: the settings.json world may go away, these may not', () => {

    it('probe 404 (no user-files API) is permanent: no file write is ever attempted', async () => {
        verifyAvailable = false;
        const store = makeStore();
        // Мутация обязана завершиться без броска в обоих мирах (сегодня —
        // legacy-режим, после пореза — readonly с отказом записи).
        await store.mutate(items => { items.push({ id: 'a' }); });
        await store.flush();
        await sleep(30);
        assert.equal(uploads.length, 0, 'ни одной попытки записи при отсутствующем API');
    });

    it('a probe outage never clobbers the existing file with a partial base', async () => {
        const store = makeStore();
        serverFiles.set(store.name, JSON.stringify({ v: 1, items: [{ id: 'existing-1' }] }));
        probeThrows = true;
        // Мутацию не ждём: в текущем мире ready() резолвится legacy-режимом,
        // в будущем — висит на ретраях пробы.
        const mutation = store.mutate(items => { items.push({ id: 'outage-work' }); }).catch(() => {});
        await sleep(30);
        assert.equal(uploads.length, 0, 'пока хранилище недоступно — ни одной записи');
        assert.equal(
            JSON.parse(serverFiles.get(store.name)).items.length, 1,
            'существующий файл не тронут пустой базой',
        );
        // Хранилище отвечает — работа доезжает до файла (поллим результат,
        // а не путь: зависший await здесь и есть тот класс зависания, который
        // инвариант ловит).
        probeThrows = false;
        const landed = await waitFor(() => {
            const doc = serverFiles.get(store.name);
            return !!doc && JSON.parse(doc).items.some(item => item.id === 'outage-work');
        });
        await store.flush();
        const ids = serverDoc(store).map(item => item.id).sort();
        assert.equal(landed, true, 'работа окна сбоя не потеряна (probeCalls=' + probeCalls + ')');
        assert.deepEqual(ids, ['existing-1', 'outage-work']);
    });
});
