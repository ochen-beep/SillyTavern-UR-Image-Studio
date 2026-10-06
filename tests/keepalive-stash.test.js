// @ts-check
// Регрессия 2026-10-06 (пункт 6 плана): при выгрузке страницы payload >keepalive
// молча выбрасывался (flushOnUnload: skip + warn) — мутация терялась. Теперь
// полный payload stash'ится в localStorage и дореплейтируется следующей сессией
// штатной записью (трёхстороннее слияние, удаление ключа только после
// подтверждённой записи).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals, makeUserFileServer } from './_helpers.js';

function makeInMemoryLFA() {
    const store = new Map();
    return {
        getItem: async k => (store.has(k) ? store.get(k) : null),
        setItem: async (k, v) => { store.set(k, v); },
        removeItem: async k => { store.delete(k); },
    };
}

let fileServer;
let localStorageMock;
let failUploads;

const STORE_NAME = 'uris_stash_test.json';

function makeStore() {
    // keepaliveLimit: 10 — любой payload не влезает в keepalive-запрос.
    return createFileStore({
        label: 'stash-test',
        name: STORE_NAME,
        version: 1,
        key: 'items',
        empty: () => [],
        keepaliveLimit: 10,
    });
}

let createFileStore;
let resetFileStoresForTests;

function wireFetch() {
    fileServer = makeUserFileServer();
    const inner = fileServer.fetch;
    // failUploads: 500 на upload ДО записи на сервер (helper пишет serverFiles
    // до хука — сбои симулируем обёрткой, не меняя общий helper).
    globalThis.fetch = (url, options) => {
        if (failUploads && String(url) === '/api/files/upload') {
            return Promise.resolve({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) });
        }
        return inner(url, options);
    };
}

beforeEach(async () => {
    installStGlobals();
    globalThis.toastr = { error: () => {}, success: () => {} };
    globalThis.SillyTavern.libs.localforage = makeInMemoryLFA();
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
    });
    failUploads = false;
    wireFetch();
    localStorageMock = new Map();
    globalThis.localStorage = {
        getItem: k => (localStorageMock.has(k) ? localStorageMock.get(k) : null),
        setItem: (k, v) => { localStorageMock.set(k, String(v)); },
        removeItem: k => { localStorageMock.delete(k); },
    };
    ({ createFileStore, resetFileStoresForTests } = await import('../src/file-store.js'));
    resetFileStoresForTests();
});

afterEach(() => {
    delete globalThis.localStorage;
});

test('over-keepalive payload при unload уезжает в localStorage-сташ', async () => {
    // Сервер недоступен: write-цикл не может доставить payload, он остаётся
    // pending к моменту выгрузки — ровно тот случай, ради которого существует
    // keepalive-флаш.
    failUploads = true;
    const store = makeStore();
    await store.ready();
    await store.mutate(list => { list.push({ id: 'a', name: 'запись' }); });
    await store.flush();
    await store.flushOnUnload();

    assert.equal(fileServer.serverFiles.has(STORE_NAME), false, 'сервер так и не получил файл');
    const raw = localStorageMock.get('uris_pending_write:stash-test');
    assert.ok(raw, 'stash записан');
    const stashed = JSON.parse(raw);
    assert.equal(stashed.name, STORE_NAME);
    const doc = JSON.parse(Buffer.from(stashed.data, 'base64').toString('utf8'));
    assert.deepEqual(doc.items.map(r => r.id), ['a'], 'в сташе — полное зеркало с мутацией');
});

test('следующая сессия дореплейтивает stash и чистит ключ после доставки', async () => {
    // Сессия 1: сервер падает, мутация не доставлена, выгрузка со сташем.
    failUploads = true;
    const store1 = makeStore();
    await store1.ready();
    await store1.mutate(list => { list.push({ id: 'a' }); });
    await store1.flush();
    await store1.flushOnUnload();
    assert.equal(fileServer.serverFiles.has(STORE_NAME), false);

    // Сессия 2: сервер здоров — реплей должен доставить stash.
    resetFileStoresForTests();
    failUploads = false;
    wireFetch();
    const store2 = makeStore();
    await store2.ready();
    await store2.flush();   // реплей уже поставил pendingPayload в ready()

    assert.ok(fileServer.uploads.length >= 1, 'stash доставлен штатной записью');
    const onServer = JSON.parse(fileServer.serverFiles.get(STORE_NAME));
    assert.deepEqual(onServer.items.map(r => r.id), ['a'], 'данные мёртвой сессии на сервере');
    assert.equal(localStorageMock.has('uris_pending_write:stash-test'), false, 'ключ снят после доставки');
    assert.deepEqual(store2.snapshot().map(r => r.id), ['a']);
});

test('битый stash отбрасывается без падения загрузки', async () => {
    localStorageMock.set('uris_pending_write:stash-test', '{not json');
    const store = makeStore();
    const mode = await store.ready();
    assert.equal(mode, 'file');
    assert.equal(localStorageMock.has('uris_pending_write:stash-test'), false, 'битый ключ снят');
});
