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
let failUploadsOnce = false;     // one-shot: only the next upload fails, then writes recover
let failReads = new Set();       // names answering 500 on read even if present in serverFiles
let parkedUploadName = null;     // uploads of this name park in flight until released
let releaseParkedUpload = null;  // resolver set while an upload is parked
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
        if (body.name === parkedUploadName && releaseParkedUpload === null) {
            await new Promise(resolve => { releaseParkedUpload = resolve; });
        }
        if (failUploads) return { ok: false, status: 500, text: async () => 'boom' };
        if (failUploadsOnce) { failUploadsOnce = false; return { ok: false, status: 500, text: async () => 'boom' }; }
        serverFiles.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    if (url.startsWith('/user/files/')) {
        const name = decodeURIComponent(url.slice('/user/files/'.length));
        if (!serverFiles.has(name) || missingNames.has(name)) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
        if (failReads.has(name)) return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
        return { ok: true, status: 200, text: async () => serverFiles.get(name), json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

const { createShardedFileStore } = await import('../src/sharded-file-store.js');
const { resetFileStoresForTests } = await import('../src/file-store.js');
const journal = await import('../src/diagnostic-events.js');

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
    failUploadsOnce = false;
    failReads = new Set();
    parkedUploadName = null;
    releaseParkedUpload = null;
    toastErrors.length = 0;
    installStubs();
    resetFileStoresForTests();
    journal.resetDiagnosticEventsForTests();
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

    it('a corrupt manifest is rebuilt; the next mutation writes only its own shard', async () => {
        const store = makeStore();
        serverFiles.set(manifestName(store), '{ not json');
        serverFiles.set(shardName(store, 's0000'), JSON.stringify({
            v: 1, kind: 'shard', store: 'x', id: 's0000', records: [card(0)],
        }));
        assert.equal(await store.ready(), 'file', 'the rebuild un-blocks writes: no readonly, no refusal toast');
        assert.deepEqual(store.snapshot().map(r => r.id), ['c0000'],
            'the pre-existing shard is adopted, its records are the mirror');
        assert.match(serverFiles.get(manifestName(store)), /s0000/, 'the manifest was re-written from the scan');
        const afterLoad = uploads.length;
        await store.mutate(list => { list.unshift(card(9)); });
        await store.flush();
        const written = uploads.slice(afterLoad).map(u => u.name).sort();
        assert.deepEqual(written, [shardName(store, 's0000'), manifestName(store)].sort(),
            'the mutation writes only its own shard + the manifest — no second scan, no orphan shards');
        const shard = JSON.parse(serverFiles.get(shardName(store, 's0000')));
        assert.deepEqual(shard.records.map(r => r.id), ['c0009', 'c0000']);
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

describe('flush surface', () => {
    it('flush() awaits quiescence of the write loop and the meta store', async () => {
        const store = makeStore();
        await store.ready();
        await store.mutate(list => { list.unshift(card(0)); });
        assert.equal(await store.flush(), true);
        assert.equal(uploads.filter(u => u.keepalive).length, 0);
    });

    it('flushOnUnload sends small dirty shards with keepalive and skips big ones', async () => {
        // mutate() awaits its write, so a dirty shard only exists at unload
        // time when the write FAILED (the loop re-queued it) — the same
        // "payload stays pending, unload flush retries it" state as file-store.
        const small = makeStore();
        await small.ready();
        failUploads = true;
        await small.mutate(list => { list.unshift(card(0)); });
        failUploads = false;
        small.flushOnUnload();
        assert.ok(uploads.some(u => u.keepalive), 'a small dirty shard rides the keepalive');
        const big = makeStore({ keepaliveLimit: 10 });
        await big.ready();
        failUploads = true;
        await big.mutate(list => { list.unshift(card(0)); });
        failUploads = false;
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
        // flush() awaits the write loop; the count below holds only because mutate awaits its write.
        await store.flush();
        const before = uploads.length;
        await store.mutate(list => {
            const item = list.find(r => r.id === 'c0000');
            item.prompt = 'changed';
        });
        // flush() awaits the write loop; the assert below holds only because mutate awaits its write.
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

    it('an update to a record loaded from the server rewrites its shard file', async () => {
        const store = makeStore();
        serverFiles.set(manifestName(store), JSON.stringify({
            v: 1, kind: 'manifest', store: 'x',
            shards: [{ id: 's0000', count: 1, min: 1_700_000_000_000, max: 1_700_000_000_000 }],
        }));
        serverFiles.set(shardName(store, 's0000'), JSON.stringify({
            v: 1, kind: 'shard', store: 'x', id: 's0000', records: [card(0)],
        }));
        assert.equal(await store.ready(), 'file');
        // c0000 arrived via adoptShard, not via an in-session placement.
        await store.mutate(list => {
            const item = list.find(r => r.id === 'c0000');
            item.prompt = 'changed';
        });
        const shard = JSON.parse(serverFiles.get(shardName(store, 's0000')));
        assert.equal(shard.records[0].prompt, 'changed', 'the server shard holds the edit');
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

    it('a migration whose write failed re-adopts from scratch on the ready() retry (no duplicate rows)', async t => {
        // ready() parks on PROBE_RETRY_MS (10 s) between attempts — fake the clock.
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const store = makeStore();
        failUploadsOnce = true;   // the first migration write (the shard) fails…
        serverFiles.set(`t${labelCounter}_old.json`, JSON.stringify({ v: 1, cards: [card(1), card(0)] }));
        let settled = false;
        const ready = store.ready().then(result => { settled = true; return result; });
        const turn = () => new Promise(resolve => setImmediate(resolve));
        for (let i = 0; i < 5 && !settled; i++) {
            await turn();   // let the in-flight attempt settle (fetch stubs are microtask-based)
            t.mock.timers.tick(10_000);   // fire the retry sleep once attempt 1 scheduled it
        }
        assert.equal(await ready, 'file');
        assert.deepEqual(store.snapshot().map(r => r.id), ['c0001', 'c0000']);
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(manifest.shards.map(s => s.id), ['s0000'], 'the retry rewrote the same shard id instead of opening new ones');
        assert.deepEqual(manifest.shards.map(s => s.count), [2]);
        const writtenShards = [...new Set(uploads.map(u => u.name).filter(n => n.startsWith(store.shardPrefix)))].sort();
        assert.deepEqual(writtenShards, [shardName(store, 's0000')], 'no shard file under a second id');
        assert.equal(serverFiles.has(shardName(store, 's0001')), false);
    });

    it('a gallery monolith whose collection is not an array comes up empty, preserving the file', async () => {
        const store = makeStore();
        const monolith = `t${labelCounter}_old.json`;
        serverFiles.set(monolith, JSON.stringify({ v: 1, cards: { foo: 1 } }));
        assert.equal(await store.ready(), 'file');
        assert.deepEqual(store.snapshot(), []);
        assert.equal(uploads.length, 0, 'a misshapen monolith is never migrated nor written over');
        assert.equal(JSON.parse(serverFiles.get(monolith)).cards.foo, 1,
            'the monolith is not tombstoned — a hand-fix can migrate later');
    });

    it('a refs monolith whose sharded collection is not an array comes up empty, preserving the companion data', async () => {
        const store = makeStore({
            shardedKey: 'refs', append: 'back', placeByStamp: false,
            empty: () => ({ refs: [], folders: [] }),
            countEntries: v => (Array.isArray(v?.refs) ? v.refs.length : null),
            monolithKey: 'data',
        });
        const monolith = `t${labelCounter}_old.json`;
        serverFiles.set(monolith, JSON.stringify({
            v: 1, data: { refs: { broken: true }, folders: [{ id: 'f1', name: 'Пейзажи' }] },
        }));
        assert.equal(await store.ready(), 'file');
        assert.deepEqual(store.snapshot().refs, []);
        assert.equal(uploads.length, 0, 'a misshapen refs monolith is never migrated nor written over');
        const preserved = JSON.parse(serverFiles.get(monolith));
        assert.equal(preserved.data.refs.broken, true, 'the monolith is not tombstoned');
        assert.equal(preserved.data.folders[0].id, 'f1',
            'the meta-file companion data is not destroyed by an empty migration');
        const migrated = journal.listDiagnosticEvents().find(e => e.event === 'store-migrated');
        assert.ok(migrated, 'the shape guard is loud in the journal');
        assert.equal(migrated.outcome, 'error');
        assert.equal(migrated.details.reason, 'monolith-shape');
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

    it('a record adopted by a merge is never re-placed by a later settle (no duplicates)', async () => {
        const store = makeStore();
        await store.ready();
        await store.mutate(list => { list.unshift(card(0)); });
        const shard = JSON.parse(serverFiles.get(shardName(store, 's0000')));
        shard.records.unshift(card(50, 1_700_000_050_000));
        serverFiles.set(shardName(store, 's0000'), JSON.stringify(shard));
        await store.mutate(list => { list.unshift(card(1)); });   // merge-adopts c0050
        await store.mutate(list => { list.unshift(card(2)); });   // the settle that used to re-place it
        const placed = [];
        for (const [name, text] of serverFiles) {
            if (!name.startsWith(store.shardPrefix)) continue;
            for (const record of JSON.parse(text).records) placed.push(record.id);
        }
        assert.equal(placed.filter(id => id === 'c0050').length, 1,
            'c0050 lives in exactly one shard, exactly once');
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.equal(manifest.shards.reduce((sum, s) => sum + s.count, 0), store.snapshot().length,
            'manifest counts sum to the mirror size');
        const ids = store.snapshot().map(r => r.id);
        assert.equal(new Set(ids).size, ids.length, 'no duplicate ids in the mirror');
    });

    it('an edit of a merge-adopted record updates it in place, without duplicating it', async () => {
        const store = makeStore();
        await store.ready();
        await store.mutate(list => { list.unshift(card(0)); });
        const shard = JSON.parse(serverFiles.get(shardName(store, 's0000')));
        shard.records.unshift(card(50, 1_700_000_050_000));
        serverFiles.set(shardName(store, 's0000'), JSON.stringify(shard));
        await store.mutate(list => { list.unshift(card(1)); });   // merge-adopts c0050
        await store.mutate(list => {
            const item = list.find(r => r.id === 'c0050');
            item.prompt = 'edited';
        });
        const written = JSON.parse(serverFiles.get(shardName(store, 's0000')));
        const copies = written.records.filter(r => r.id === 'c0050');
        assert.equal(copies.length, 1, 'c0050 appears in its shard exactly once');
        assert.equal(copies[0].prompt, 'edited', 'the edit landed');
    });

    it('an undeliverable foreign shard aborts the manifest write; the row survives once it reads', async () => {
        const store = makeStore();
        await store.ready();
        await store.mutate(list => { list.unshift(card(0)); });
        serverFiles.set(shardName(store, 's0001'), JSON.stringify({
            v: 1, kind: 'shard', store: 'x', id: 's0001', records: [card(100, 1_700_100_000_000)],
        }));
        serverFiles.set(manifestName(store), JSON.stringify({
            v: 1, kind: 'manifest', store: 'x',
            shards: [
                { id: 's0000', count: 1, min: 1_700_000_000_000, max: 1_700_000_000_000 },
                { id: 's0001', count: 1, min: 1_700_100_000_000, max: 1_700_100_000_000 },
            ],
        }));
        failReads.add(shardName(store, 's0001'));
        await store.mutate(list => { list.unshift(card(1)); });   // shard uploads, manifest write aborts
        assert.equal(await store.flush(), false, 'the aborted manifest write is reported as unfinished');
        const abort = journal.listDiagnosticEvents().find(e => e.event === 'store-write-skipped');
        assert.ok(abort, 'the silent-looking abort is observable in the journal');
        assert.equal(abort.level, 'warn');
        assert.equal(abort.details.reason, 'adopt-error');
        assert.equal(abort.details.shard, 's0001');
        const untouched = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(untouched.shards.map(s => s.id), ['s0000', 's0001'],
            'the server manifest was not clobbered by the aborted write');
        assert.deepEqual(store.snapshot().map(r => r.id), ['c0001', 'c0000'],
            'the mirror is untouched by the abort');
        failReads.delete(shardName(store, 's0001'));
        await store.mutate(list => { list.unshift(card(2)); });   // retry: the adoption succeeds now
        assert.equal(await store.flush(), true);
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(manifest.shards.map(s => s.id), ['s0000', 's0001'], 'the foreign row is preserved');
        assert.ok(store.snapshot().some(r => r.id === 'c0100'), 'the adopted records reached the mirror');
    });

    it('a 404 foreign shard may drop its manifest row (nothing to orphan)', async () => {
        const store = makeStore();
        await store.ready();
        await store.mutate(list => { list.unshift(card(0)); });
        serverFiles.set(manifestName(store), JSON.stringify({
            v: 1, kind: 'manifest', store: 'x',
            shards: [
                { id: 's0000', count: 1, min: 1_700_000_000_000, max: 1_700_000_000_000 },
                { id: 's0001', count: 1, min: 1_700_100_000_000, max: 1_700_100_000_000 },
            ],
        }));
        missingNames.add(shardName(store, 's0001'));
        await store.mutate(list => { list.unshift(card(1)); });
        assert.equal(await store.flush(), true, 'a 404 row is droppable, the write proceeds');
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(manifest.shards.map(s => s.id), ['s0000'], 'the row-less shard left the manifest');
    });
});

describe('write-loop races', () => {
    it('a mutation coalesced into an in-flight empty-shard overwrite keeps the shard alive', async () => {
        const store = makeStore();
        await store.ready();
        for (let i = 0; i < 5; i++) await store.mutate(list => { list.unshift(card(i)); });
        // counts [4,1]: deleting c0004 empties s0001 → the loop parks on its empty overwrite…
        parkedUploadName = shardName(store, 's0001');
        const deleting = store.mutate(list => {
            const i = list.findIndex(r => r.id === 'c0004');
            list.splice(i, 1);
        });
        const turn = () => new Promise(resolve => setImmediate(resolve));
        for (let i = 0; i < 10 && releaseParkedUpload === null; i++) await turn();
        assert.ok(releaseParkedUpload, 'the empty overwrite is parked in flight');
        // …and this mutation lands while it is parked: c0009 is placed into the dying s0001.
        const late = store.mutate(list => { list.unshift(card(9, 1_700_000_009_000)); });
        for (let i = 0; i < 5; i++) await turn();
        releaseParkedUpload();
        await Promise.all([deleting, late]);
        const written = JSON.parse(serverFiles.get(shardName(store, 's0001')));
        assert.deepEqual(written.records.map(r => r.id), ['c0009'],
            'the shard survives with the coalesced record, not deleted-by-drop');
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(manifest.shards.map(s => s.count), [4, 1]);
        assert.ok(store.snapshot().some(r => r.id === 'c0009'));
        assert.equal(await store.flush(), true);
    });
});

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
        assert.deepEqual(written.records.map(r => r.id), ['c0008', 'c0007', 'c0006', 'c0005'],
            'restore clobbers: the foreign record is NOT merged back (shard-internal newest-first)');
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.deepEqual(manifest.shards.map(s => s.count), [4, 1]);
        assert.deepEqual(store.snapshot().map(r => r.id), ['c0009', 'c0008', 'c0007', 'c0006', 'c0005']);
    });

    it('meta carries a satellite array in its own file; mutate syncs it', async () => {
        // makeStore increments labelCounter, but the overrides object is
        // evaluated at the call site — pre-compute the label for meta.name.
        const n = labelCounter + 1;
        const store = makeStore({
            shardedKey: 'refs',
            append: 'back',
            placeByStamp: false,
            empty: () => ({ refs: [], folders: [] }),
            countEntries: value => (Array.isArray(value?.refs) ? value.refs.length : null),
            meta: { name: `t${n}_meta.json`, keys: ['folders'], empty: () => ({ folders: [] }) },
        });
        await store.ready();
        await store.mutate(data => {
            data.refs.push(card(0));
            data.folders.push({ id: 'f1', name: 'Пейзажи' });
        });
        await store.flush();
        const metaFile = JSON.parse(serverFiles.get(`t${n}_meta.json`));
        assert.deepEqual(metaFile.data.folders.map(f => f.id), ['f1']);
        assert.deepEqual(store.snapshot().folders.map(f => f.id), ['f1']);
        assert.deepEqual(store.snapshot().refs.map(r => r.id), ['c0000']);
        const manifest = JSON.parse(serverFiles.get(manifestName(store)));
        assert.equal(manifest.shards.length, 1, 'folders never touch the manifest');
    });
});
