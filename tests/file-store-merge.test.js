// @ts-check
/**
 * Cross-writer safety of `mergeWithServer` stores. Regression for the
 * 2026-09-14 incident: two SillyTavern instances (Syncthing-mirrored data)
 * each write the WHOLE pool document from their in-memory mirror, so a
 * reference image replaced on one machine silently reappeared old after the
 * other machine's next write. The store now re-reads the server file before
 * every upload and three-way merges it with the mirror.
 *
 * Harness mirrors tests/file-store.test.js: one shared `serverFiles` Map plays
 * the server, a second Map stands for the other machine's writes (applied by
 * mutating serverFiles behind the store's back — exactly what Syncthing does).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

const moduleSettings = {};
const serverFiles = new Map();
const uploads = [];

const originalSt = globalThis.SillyTavern;
const originalFetch = globalThis.fetch;
const originalToastr = globalThis.toastr;

function installStubs() {
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: { ur_image_studio: moduleSettings },
            saveSettingsDebounced: () => {},
            getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
        }),
        libs: { localforage: { async getItem() { return null; }, async setItem() {}, async removeItem() {} } },
    };
    globalThis.toastr = { error: () => {} };
    globalThis.fetch = fetchStub;
}

const fetchStub = async (url, options = {}) => {
    if (url === '/api/files/verify') {
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    if (url === '/api/files/upload' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        uploads.push(body);
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
function makeStore(overrides = {}) {
    const label = `merge-test-${++labelCounter}`;
    return createFileStore({
        label,
        name: `uris_merge_${label}.json`,
        key: 'data',
        empty: () => ({ refs: [] }),
        countEntries: value => (Array.isArray(value?.refs) ? value.refs.length : null),
        mergeWithServer: true,
        ...overrides,
    });
}

/** The other writer: apply a whole-document change straight to the server file. */
function externalWrite(store, docValue) {
    serverFiles.set(store.name, JSON.stringify({ v: 1, data: docValue }));
}
function serverRefs(store) {
    const doc = JSON.parse(serverFiles.get(store.name));
    return doc.data.refs;
}

beforeEach(() => { installStubs(); uploads.length = 0; serverFiles.clear(); });
afterEach(() => {
    globalThis.SillyTavern = originalSt;
    globalThis.fetch = originalFetch;
    globalThis.toastr = originalToastr;
    resetFileStoresForTests();
});

describe('mergeWithServer: cross-machine safety', () => {
    it('keeps the local replace when the remote side changed other records', async () => {
        const store = makeStore();
        externalWrite(store, { refs: [
            { id: 'a', imagePath: 'old-a.png' },
            { id: 'b', imagePath: 'old-b.png' },
        ] });
        await store.ready();
        // The other machine renamed b BEFORE this session's write started —
        // the incident: the mirror still holds old-b, the file has renamed-b.
        externalWrite(store, { refs: [
            { id: 'a', imagePath: 'old-a.png' },
            { id: 'b', imagePath: 'renamed-b.png' },
        ] });
        await store.mutate(d => { d.refs[0] = { id: 'a', imagePath: 'new-a.png', updatedAt: 100 }; });
        await store.flush();
        const refs = serverRefs(store);
        assert.deepEqual(refs.find(r => r.id === 'a'), { id: 'a', imagePath: 'new-a.png', updatedAt: 100 },
            'local replacement must survive the remote write');
        assert.equal(refs.find(r => r.id === 'b').imagePath, 'renamed-b.png',
            'remote edit of an untouched record must survive the local write');
    });

    it('resolves a same-record conflict by newest updatedAt', async () => {
        const store = makeStore();
        externalWrite(store, { refs: [{ id: 'a', imagePath: 'v1.png', updatedAt: 1 }] });
        await store.ready();
        externalWrite(store, { refs: [{ id: 'a', imagePath: 'remote-v9.png', updatedAt: 9 }] });
        await store.mutate(d => { d.refs[0] = { id: 'a', imagePath: 'local-v2.png', updatedAt: 5 }; });
        await store.flush();
        assert.deepEqual(serverRefs(store), [{ id: 'a', imagePath: 'remote-v9.png', updatedAt: 9 }]);
    });

    it('honors remote additions and deletions the local mirror never saw', async () => {
        const store = makeStore();
        externalWrite(store, { refs: [{ id: 'a', imagePath: 'a.png' }, { id: 'b', imagePath: 'b.png' }] });
        await store.ready();
        // Remote adds c and deletes a; local edits b and adds x.
        externalWrite(store, { refs: [{ id: 'b', imagePath: 'b.png' }, { id: 'c', imagePath: 'c.png' }] });
        await store.mutate(d => {
            d.refs.find(r => r.id === 'b').imagePath = 'b2.png';
            d.refs.push({ id: 'x', imagePath: 'x.png' });
        });
        await store.flush();
        const ids = serverRefs(store).map(r => r.id).sort();
        assert.deepEqual(ids, ['b', 'c', 'x'], 'additions both sides survive; untouched remote-deleted record is dropped');
        assert.equal(serverRefs(store).find(r => r.id === 'b').imagePath, 'b2.png');
    });

    it('preserves a local edit of a record that was deleted remotely (edit wins over deletion)', async () => {
        const store = makeStore();
        externalWrite(store, { refs: [{ id: 'a', imagePath: 'a.png' }] });
        await store.ready();
        externalWrite(store, { refs: [] });
        await store.mutate(d => { d.refs[0] = { id: 'a', imagePath: 'new-a.png', updatedAt: 42 }; });
        await store.flush();
        assert.deepEqual(serverRefs(store), [{ id: 'a', imagePath: 'new-a.png', updatedAt: 42 }]);
    });

    it('ignores a remote rollback to an older stamped version of an untouched record', async () => {
        // Syncthing propagating a stale whole-document copy presents remote
        // "changes" whose updatedAt predates ours. They must not pull the pool
        // backwards: a record untouched locally keeps its current content.
        const store = makeStore();
        externalWrite(store, { refs: [{ id: 'a', imagePath: 'v1.png', updatedAt: 1 }] });
        await store.ready();
        await store.mutate(d => { d.refs.push({ id: 'b', imagePath: 'b.png', updatedAt: 2 }); });
        await store.flush();
        externalWrite(store, { refs: [{ id: 'a', imagePath: 'v0.png', updatedAt: 0 }] });
        await store.mutate(d => { d.refs.push({ id: 'c', imagePath: 'c.png' }); });
        await store.flush();
        const refs = serverRefs(store);
        assert.equal(refs.find(r => r.id === 'a').imagePath, 'v1.png',
            'older remote stamp is a rollback, not an edit');
        assert.deepEqual(refs.map(r => r.id).sort(), ['a', 'b', 'c']);
    });

    it('replace() clobbers without merging (backup restore contract)', async () => {
        const store = makeStore();
        externalWrite(store, { refs: [{ id: 'a', imagePath: 'a.png' }] });
        await store.ready();
        await store.replace({ refs: [{ id: 'only', imagePath: 'only.png' }] });
        await store.flush();
        assert.deepEqual(serverRefs(store), [{ id: 'only', imagePath: 'only.png' }]);
        assert.equal(uploads.length, 1, 'restore must not pay for a merge read');
    });

    it('degrades to a plain overwrite when the merge read fails', async () => {
        const store = makeStore();
        externalWrite(store, { refs: [{ id: 'a', imagePath: 'a.png' }] });
        await store.ready();
        await store.mutate(d => { d.refs.push({ id: 'b', imagePath: 'b.png' }); });
        // The server read fails mid-write: the mirror write must still land.
        const goodFetch = globalThis.fetch;
        globalThis.fetch = async (url, options) => {
            if (url.startsWith('/user/files/')) throw new Error('network blip');
            return goodFetch(url, options);
        };
        await store.flush();
        globalThis.fetch = goodFetch;
        assert.deepEqual(serverRefs(store).map(r => r.id), ['a', 'b']);
    });

    it('a merge-enabled store stays correct when nothing raced', async () => {
        const store = makeStore();
        await store.ready();
        await store.mutate(d => { d.refs.push({ id: 'a', imagePath: 'a.png' }); });
        await store.flush();
        assert.equal(uploads.length, 1, 'one mutation, one upload (the merge read rides in it)');
        assert.deepEqual(serverRefs(store), [{ id: 'a', imagePath: 'a.png' }]);
    });
});

describe('mergeWithServer: disabled stores behave as before', () => {
    it('without the flag, the next local write clobbers a remote edit (legacy contract)', async () => {
        const store = makeStore({ mergeWithServer: false });
        externalWrite(store, { refs: [{ id: 'a', imagePath: 'a.png' }] });
        await store.ready();
        await store.mutate(d => { d.refs.push({ id: 'b', imagePath: 'b.png' }); });
        await store.flush();
        // Remote machine edits a; the local mirror knows nothing about it.
        externalWrite(store, { refs: [{ id: 'a', imagePath: 'remote-edited.png' }] });
        await store.mutate(d => { d.refs.push({ id: 'c', imagePath: 'c.png' }); });
        await store.flush();
        assert.deepEqual(serverRefs(store).map(r => r.id), ['a', 'b', 'c']);
        assert.equal(serverRefs(store).find(r => r.id === 'a').imagePath, 'a.png',
            'legacy stores overwrite the server from the mirror — the merge-enabled refs store does not');
    });
});
