// @ts-check
/**
 * Sharded server-file store: manifest + fixed-size shard files. The harness
 * mirrors tests/file-store.test.js (global fetch stub + serverFiles Map) so
 * both layers see the same server shape.
 */
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

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
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
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

// node --test runs each file in its own process, but a restored global keeps
// the harness honest if this file ever merges into a shared runner.
after(() => {
    globalThis.SillyTavern = originalSt;
    globalThis.fetch = originalFetch;
    globalThis.toastr = originalToastr;
});

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
        assert.equal(toastErrors.length, 1);
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

    it('a corrupt manifest makes the store readonly and a mutation writes nothing', async () => {
        const store = makeStore();
        serverFiles.set(manifestName(store), '{ not json');
        serverFiles.set(shardName(store, 's0000'), JSON.stringify({
            v: 1, kind: 'shard', store: 'x', id: 's0000', records: [card(0)],
        }));
        assert.equal(await store.ready(), 'readonly');
        await store.mutate(list => { list.unshift(card(9)); });
        await store.flush();
        assert.equal(uploads.length, 0, 'an unreadable manifest must not be clobbered by an empty-mirror write');
        assert.match(toastErrors[0], /оглавление/);
    });
});

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
        // flush() is a Task 9 stub; the count below holds only because mutate awaits its write.
        await store.flush();
        const before = uploads.length;
        await store.mutate(list => {
            const item = list.find(r => r.id === 'c0000');
            item.prompt = 'changed';
        });
        // flush() is a Task 9 stub; the assert below holds only because mutate awaits its write.
        await store.flush();
        assert.equal(uploads.length - before, 2, 'shard + manifest (rows are cheap and always refreshed)');
        const shard = JSON.parse(serverFiles.get(shardName(store, 's0000')));
        assert.equal(shard.records[0].prompt, 'changed');
    });

    it('a deletion removes the record from its shard file and refreshes the manifest row', async () => {
        const store = makeStore();
        await store.ready();
        await store.mutate(list => { list.unshift(card(1)); list.unshift(card(0)); });
        let manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(manifest.shards.map(s => s.count), [2]);
        await store.mutate(list => {
            const idx = list.findIndex(r => r.id === 'c0000');
            list.splice(idx, 1);
        });
        const shard = JSON.parse(serverFiles.get(shardName(store, 's0000')));
        assert.deepEqual(shard.records.map(r => r.id), ['c0001'], 'the deleted record is gone from the shard');
        manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(manifest.shards.map(s => s.count), [1], 'the manifest row shrank');
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
            ['c0007', 'c0006', 'c0005', 'c0004', 'c0003', 'c0002', 'c0001', 'c0000', 'c00-1']);
        // 9 records / target 4 → three shards; s0000 holds the OLDEST chunk.
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(manifest.shards.map(s => s.id), ['s0000', 's0001', 's0002']);
        assert.deepEqual(manifest.shards.map(s => s.count), [4, 4, 1]);
        const first = JSON.parse(serverFiles.get(shardName(store, 's0000')));
        assert.deepEqual(first.records.map(r => r.id), ['c0002', 'c0001', 'c0000', 'c00-1'],
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

    it('an empty monolith migrates to an empty manifest and a tombstone', async () => {
        const store = makeStore();
        serverFiles.set(`t${labelCounter}_old.json`, JSON.stringify({ v: 1, cards: [] }));
        assert.equal(await store.ready(), 'file');
        assert.deepEqual(store.snapshot(), []);
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(manifest.shards, [], 'zero records → zero shard rows');
        assert.equal(uploads.length, 2, 'manifest + tombstone');
        assert.equal(uploads.some(u => u.name === shardName(store, 's0000')), false, 'no shard files');
        const tomb = JSON.parse(serverFiles.get(`t${labelCounter}_old.json`));
        assert.equal(tomb.kind, 'migrated');
    });

    it('a refs-shaped store migrates its sharded collection out of the monolith object', async () => {
        const store = makeStore({
            shardedKey: 'refs', append: 'back', placeByStamp: false,
            empty: () => ({ refs: [], folders: [] }),
            countEntries: v => (Array.isArray(v?.refs) ? v.refs.length : null),
            monolithKey: 'data',
        });
        serverFiles.set(`t${labelCounter}_old.json`, JSON.stringify({ v: 1, data: { refs: [card(1), card(0)] } }));
        assert.equal(await store.ready(), 'file');
        assert.deepEqual(store.snapshot().refs.map(r => r.id), ['c0001', 'c0000']);
    });
});
