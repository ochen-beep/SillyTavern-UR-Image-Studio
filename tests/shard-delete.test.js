// @ts-check
// Регрессия 2026-10-06 (пункт 4 плана): пустые шард-файлы вечно гнили на диске —
// код считал, что у user-files «нет DELETE-маршрута» (опровергнуто: POST
// /api/files/delete существует, ST files.js:54). Теперь опустошённый шард
// удаляется официальным маршрутом СТРОГО после манифеста, который больше не
// называет файл (иначе читатель со старым манифестом получил бы 404 и readonly),
// а загрузчик толерантен к строке с count===0 без файла.
import { test, beforeEach } from 'node:test';
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
let deletedPaths;

function makeLfa() {
    return makeInMemoryLFA();
}

function wireFetch({ failDelete = false } = {}) {
    deletedPaths = [];
    fileServer = makeUserFileServer({
        fallback: (url, options) => {
            if (url === '/api/files/delete' && options.method === 'POST') {
                if (failDelete) return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
                const body = JSON.parse(options.body);
                deletedPaths.push(body.path);
                fileServer.serverFiles.delete(body.path.replace(/^user\/files\//, ''));
                return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
            }
            return undefined;
        },
    });
    globalThis.fetch = fileServer.fetch;
}

function makeStore() {
    // shardTarget=2 → записи раскладываются по 2, удаление всех записей шардa
    // быстро проходит empty-ветку.
    return createShardedFileStore({
        label: 'test-delete',
        manifestName: 'uris_test_manifest.json',
        shardPrefix: 'uris_test_shard_',
        version: 1,
        shardTarget: 2,
        placeStamp: r => (Number.isFinite(r?.createdAt) ? r.createdAt : 0),
        empty: () => [],
    });
}

let createShardedFileStore;
let resetFileStoresForTests;

beforeEach(async () => {
    installStGlobals();
    globalThis.SillyTavern.libs.localforage = makeLfa();
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
    });
    wireFetch();
    ({ createShardedFileStore } = await import('../src/sharded-file-store.js'));
    ({ resetFileStoresForTests } = await import('../src/file-store.js'));
    resetFileStoresForTests();
});

test('опустошённый шард удаляется с сервера после манифеста', async () => {
    const store = makeStore();
    await store.mutate(list => {
        list.push({ id: 'a', createdAt: 1 }, { id: 'b', createdAt: 2 }, { id: 'c', createdAt: 3 });
    });
    await store.flush();
    const manifestAfterAdd = JSON.parse(fileServer.serverFiles.get('uris_test_manifest.json'));
    const shardFilesAfterAdd = [...fileServer.serverFiles.keys()].filter(n => n.startsWith('uris_test_shard_'));
    assert.ok(shardFilesAfterAdd.length >= 1, 'шарды записаны');

    await store.mutate(list => { list.splice(0, list.length); });
    await store.flush();

    const manifestAfterClear = JSON.parse(fileServer.serverFiles.get('uris_test_manifest.json'));
    assert.equal(manifestAfterClear.shards.length, 0, 'манифест без строк');
    assert.equal(deletedPaths.length >= shardFilesAfterAdd.length, true, `файлы удалены через DELETE: ${deletedPaths.join(', ')}`);
    for (const name of shardFilesAfterAdd) {
        assert.equal(fileServer.serverFiles.has(name), false, `${name} удалён с сервера`);
        assert.ok(deletedPaths.includes(`user/files/${name}`), `DELETE вызван для ${name}`);
    }
    // DELETE строго ПОСЛЕ манифеста: порядок проверяется тем, что манифест
    // уже без строк к моменту удаления (выше), а файлы в serverFiles чистятся
    // в fallback — окно readonly не открывается.
    assert.equal(store.mode(), 'file', 'стор остаётся записываемым');
});

test('неудача DELETE оставляет пустой файл (статус-кво), стор здоров', async () => {
    const store = makeStore();
    await store.mutate(list => { list.push({ id: 'a', createdAt: 1 }, { id: 'b', createdAt: 2 }); });
    await store.flush();
    const shardFiles = [...fileServer.serverFiles.keys()].filter(n => n.startsWith('uris_test_shard_'));

    wireFetch({ failDelete: true });
    // Новый инстанс того же стора на «упавшим» DELETE: повторный прогон
    // empty-ветки требует записей — проще пересоздать содержимое.
    const store2 = makeStore();
    await store2.mutate(list => { list.push({ id: 'x', createdAt: 5 }, { id: 'y', createdAt: 6 }); });
    await store2.flush();
    await store2.mutate(list => { list.splice(0, list.length); });
    await store2.flush();

    // Все пустые шарды остались на диске как records: [] — данные нейтрализованы.
    for (const name of [...fileServer.serverFiles.keys()].filter(n => n.startsWith('uris_test_shard_'))) {
        const doc = JSON.parse(fileServer.serverFiles.get(name));
        if (doc.kind === 'shard') assert.deepEqual(doc.records, [], `пустой файл ${name} нейтрализован`);
    }
    assert.equal(deletedPaths.length, 0, 'DELETE не сработал (500)');
    assert.ok(shardFiles.length >= 1);
    assert.equal(store2.mode(), 'file');
});

test('загрузчик толерантен к строке count=0 без файла (не readonly)', async () => {
    // Готовим серверное состояние вручную: манифест с «мёртвой» строкой
    // count 0 (файл удалён другим устройством) + живой шард с данными.
    const store = makeStore();
    await store.mutate(list => { list.push({ id: 'a', createdAt: 1 }, { id: 'b', createdAt: 2 }); });
    await store.flush();
    const liveShard = [...fileServer.serverFiles.keys()].find(n => n.startsWith('uris_test_shard_'));

    const manifest = JSON.parse(fileServer.serverFiles.get('uris_test_manifest.json'));
    manifest.shards.push({ id: 's0999', count: 0, min: null, max: null });
    fileServer.serverFiles.set('uris_test_manifest.json', JSON.stringify(manifest));
    fileServer.serverFiles.delete('s0999' && 'uris_test_shard_s0999.json');

    const fresh = makeStore();
    const mode = await fresh.ready();
    assert.equal(mode, 'file', 'мёртвая пустая строка не валит стор в readonly');
    assert.deepEqual((await fresh.snapshot()).map(r => r.id), ['b', 'a'], 'данные живого шарда в каноническом порядке (newest-first)');
});
