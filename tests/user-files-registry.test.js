// @ts-check
/**
 * Data Maid shield: the character_attachments registry (user-files-storage.js)
 * and its integration points (file-store upload, sharded upload/delete,
 * data-care clean, init reconcile).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeUserFileServer } from './_helpers.js';

function stubST(extensionSettings = {}) {
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings,
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            saveSettingsDebounced: () => {},
        }),
    };
}

function withSt(fn) {
    return async () => {
        const savedST = globalThis.SillyTavern;
        const savedFetch = globalThis.fetch;
        try { await fn(); } finally {
            globalThis.fetch = savedFetch;
            if (savedST === undefined) delete globalThis.SillyTavern; else globalThis.SillyTavern = savedST;
        }
    };
}

test('user-files registry: protect/unprotect round-trip under the pseudo-character key', withSt(async () => {
    const extensionSettings = {};
    stubST(extensionSettings);
    const { protectUserFile, unprotectUserFile, listProtectedUserFiles } = await import('../src/user-files-storage.js');
    assert.deepEqual(listProtectedUserFiles(), []);
    assert.equal(protectUserFile('user/files/uris_ref_a.png'), true);
    assert.equal(protectUserFile('/user/files/uris_ref_a.png'), true); // дубликат не плодится
    assert.equal(protectUserFile('user/images/URIS_Refs/a.png'), false); // чужая форма не регистрируется
    assert.deepEqual(listProtectedUserFiles().map(e => e.url), ['user/files/uris_ref_a.png']);
    assert.equal(extensionSettings.character_attachments['URIS Storage'].length, 1);
    assert.equal(unprotectUserFile('user/files/uris_ref_a.png'), true);
    assert.deepEqual(listProtectedUserFiles(), []);
}));

test('syncProtectedRegistry: registers missing, idempotent, skips junk', withSt(async () => {
    stubST({});
    const { protectUserFile, syncProtectedRegistry, listProtectedUserFiles } = await import('../src/user-files-storage.js');
    protectUserFile('user/files/uris_templates.json');
    const added = syncProtectedRegistry(['uris_templates.json', 'uris_studio.json', '', null, 42]);
    assert.equal(added, 1);
    assert.deepEqual(listProtectedUserFiles().map(e => e.url).sort(), [
        'user/files/uris_studio.json',
        'user/files/uris_templates.json',
    ]);
    assert.equal(syncProtectedRegistry(['uris_studio.json']), 0); // повтор — без изменений
}));

test('clearProtectedRegistry drops the key entirely', withSt(async () => {
    const extensionSettings = {};
    stubST(extensionSettings);
    const { protectUserFile, clearProtectedRegistry, listProtectedUserFiles } = await import('../src/user-files-storage.js');
    protectUserFile('user/files/uris_refs.json');
    assert.equal(listProtectedUserFiles().length, 1);
    assert.equal(clearProtectedRegistry(), true);
    assert.equal(listProtectedUserFiles().length, 0);
    assert.equal(Object.hasOwn(extensionSettings.character_attachments, 'URIS Storage'), false);
    assert.equal(clearProtectedRegistry(), false); // второй раз — no-op
}));

test('deleteStoredServerFile routes by path shape and lifts protection', withSt(async () => {
    stubST({});
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200 };
    };
    const { deleteStoredServerFile, protectUserFile, listProtectedUserFiles } = await import('../src/user-files-storage.js');
    protectUserFile('user/files/uris_ref_a.png');
    assert.equal(await deleteStoredServerFile('user/files/uris_ref_a.png'), true);
    assert.equal(await deleteStoredServerFile('user/images/URIS_Refs/old.png'), true);
    assert.equal(await deleteStoredServerFile('etc/passwd'), false);
    assert.deepEqual(calls.map(c => c.url), ['/api/files/delete', '/api/images/delete']);
    assert.equal(calls[0].body.path, 'user/files/uris_ref_a.png');
    assert.equal(calls[1].body.path, 'user/images/URIS_Refs/old.png');
    // Защита снята вместе с файлом — иначе реестр превратится в свалку.
    assert.deepEqual(listProtectedUserFiles(), []);
}));

test('file-store upload registers the file in the shield registry', withSt(async () => {
    const extensionSettings = {};
    stubST(extensionSettings);
    const fileServer = makeUserFileServer();
    globalThis.fetch = fileServer.fetch;
    const { createFileStore, resetFileStoresForTests } = await import('../src/file-store.js');
    const { listProtectedUserFiles } = await import('../src/user-files-storage.js');
    try {
        const store = createFileStore({
            label: 'shield-test',
            name: 'uris_shield_test.json',
            key: 'items',
            version: 1,
            empty: () => [],
            probeRetryMs: 10,
        });
        await store.ready();
        await store.mutate(items => items.push({ id: 'a' }));
        await store.flush();
        assert.ok(fileServer.serverFiles.has('uris_shield_test.json'));
        assert.ok(listProtectedUserFiles().some(e => e.url === 'user/files/uris_shield_test.json'));
    } finally {
        resetFileStoresForTests();
    }
}));

test('sharded store registers manifest+shards on upload and lifts registration on shard GC', withSt(async () => {
    const extensionSettings = {};
    stubST(extensionSettings);
    const fileServer = makeUserFileServer({
        fallback: (url, options) => {
            if (url === '/api/files/delete' && options.method === 'POST') {
                // Фейковый сервер обязан реально удалить файл (см. shard-delete.test.js).
                const body = JSON.parse(options.body);
                fileServer.serverFiles.delete(String(body.path).replace(/^user\/files\//, ''));
                return { ok: true, status: 200, text: async () => '' };
            }
            return undefined;
        },
    });
    globalThis.fetch = fileServer.fetch;
    const { createShardedFileStore } = await import('../src/sharded-file-store.js');
    const { resetFileStoresForTests } = await import('../src/file-store.js');
    const { listProtectedUserFiles } = await import('../src/user-files-storage.js');
    try {
        const store = createShardedFileStore({
            label: 'shield-sharded',
            manifestName: 'uris_shield_manifest.json',
            shardPrefix: 'uris_shield_shard_',
            monolithName: 'uris_shield_old.json',
            monolithKey: 'records',
            shardTarget: 2,
            empty: () => [],
            probeRetryMs: 10,
        });
        await store.ready();
        for (let i = 0; i < 5; i++) await store.mutate(records => records.push({ id: `r${i}`, v: i }));
        await store.flush();
        const urls = listProtectedUserFiles().map(e => e.url);
        assert.ok(urls.includes('user/files/uris_shield_manifest.json'), urls.join(','));
        assert.ok(urls.some(u => u.startsWith('user/files/uris_shield_shard_s')), urls.join(','));

        // Шард-GC: все записи удалены → пустые шарды стираются с сервера и
        // снимаются с защиты (иначе реестр копит мёртвые имена).
        await store.mutate(records => { records.length = 0; });
        await store.flush();
        assert.ok(![...fileServer.serverFiles.keys()].some(n => n.startsWith('uris_shield_shard_')),
            [...fileServer.serverFiles.keys()].join(','));
        assert.ok(!listProtectedUserFiles().some(e => e.url.startsWith('user/files/uris_shield_shard_')),
            listProtectedUserFiles().map(e => e.url).join(','));
    } finally {
        resetFileStoresForTests();
    }
}));

test('sharded store registers manifest+shards on READ too (fresh browser profile)', withSt(async () => {
    stubST({});
    // Pre-seed the server: manifest + one shard, written by "another machine".
    const fileServer = makeUserFileServer();
    fileServer.serverFiles.set('uris_seed_manifest.json', JSON.stringify({
        v: 1, kind: 'manifest', store: 'seed',
        shards: [{ id: 's0000', count: 2, min: 1, max: 2 }],
    }));
    fileServer.serverFiles.set('uris_seed_shard_s0000.json', JSON.stringify({
        v: 1, kind: 'shard', store: 'seed', id: 's0000',
        records: [{ id: 'a', createdAt: 1 }, { id: 'b', createdAt: 2 }],
    }));
    globalThis.fetch = fileServer.fetch;
    const { createShardedFileStore } = await import('../src/sharded-file-store.js');
    const { resetFileStoresForTests } = await import('../src/file-store.js');
    const { listProtectedUserFiles } = await import('../src/user-files-storage.js');
    try {
        const store = createShardedFileStore({
            label: 'shield-seed',
            manifestName: 'uris_seed_manifest.json',
            shardPrefix: 'uris_seed_shard_',
            monolithName: 'uris_seed_old.json',
            monolithKey: 'records',
            shardTarget: 4,
            empty: () => [],
            probeRetryMs: 10,
        });
        assert.equal(await store.ready(), 'file');
        // No write happened (uploads журнал пуст), но реестр уже знает файлы.
        assert.equal(fileServer.uploads.length, 0);
        const urls = listProtectedUserFiles().map(e => e.url);
        assert.ok(urls.includes('user/files/uris_seed_manifest.json'), urls.join(','));
        assert.ok(urls.includes('user/files/uris_seed_shard_s0000.json'), urls.join(','));
    } finally {
        resetFileStoresForTests();
    }
}));

test('ensureOwnedFilesRegistered covers every owned store file name', withSt(async () => {
    stubST({});
    const { ensureOwnedFilesRegistered } = await import('../src/data-care.js');
    const { listProtectedUserFiles } = await import('../src/user-files-storage.js');
    const added = ensureOwnedFilesRegistered();
    const urls = listProtectedUserFiles().map(e => e.url);
    for (const must of [
        'user/files/uris_gallery_manifest.json',
        'user/files/uris_refs_manifest.json',
        'user/files/uris_templates.json',
        'user/files/uris_studio.json',
    ]) {
        assert.ok(urls.includes(must), `missing ${must}`);
    }
    assert.ok(added > 0);
    assert.equal(ensureOwnedFilesRegistered(), 0); // idempotent
}));

test('cleanAllData clears the shield registry', withSt(async () => {
    stubST({});
    const fileServer = makeUserFileServer({
        fallback: (url) => {
            if (url === '/api/files/delete') return { ok: true, status: 200, text: async () => '' };
            if (url.startsWith('/api/images/')) return { ok: true, status: 200, json: async () => [], text: async () => '' };
            return undefined;
        },
    });
    globalThis.fetch = fileServer.fetch;
    const { cleanAllData } = await import('../src/data-care.js');
    const { protectUserFile, listProtectedUserFiles } = await import('../src/user-files-storage.js');
    const { resetFileStoresForTests } = await import('../src/file-store.js');
    try {
        protectUserFile('user/files/uris_templates.json');
        protectUserFile('user/files/uris_gallery_shard_s0000.json');
        const result = await cleanAllData();
        assert.equal(typeof result.files, 'number');
        assert.deepEqual(listProtectedUserFiles(), []);
    } finally {
        resetFileStoresForTests();
    }
}));
