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
import { makeUserFileServer } from './_helpers.js';

const moduleSettings = {};
const fileServer = makeUserFileServer();
const serverFiles = fileServer.serverFiles;
const uploads = fileServer.uploads;

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
    globalThis.fetch = fileServer.fetch;
}

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

describe('mergeWithServer: удаление, принятое мерджем, не даёт откатиться', () => {
    // Известное ограничение (не исправляется точечно — нужны надгробия или
    // серверные If-Match): merge, чей единственный эффект — принятие чужих
    // удалений, возвращает null («нечего менять»), и стор отправляет
    // неслитое зеркало, возвращая удалённые другим сеансом записи. Наивный
    // фикс `changed = true` хуже: чтение сервера может быть старше syncBase
    // (собственный upload ещё в полёте), и тогда локальная добавка выглядит
    // как «удалена на сервере» и уничтожается — проверено живьём 2026-10-03.
    it.skip('запись, удалённая сессией A, не воскресает при следующей записи сессии B', async () => {
        // Живая последовательность 2026-10-03 (две вкладки галереи):
        // A.add(x) → B.load → A.add(y) → B.add(z) → A.del(y) → A.del(x) → B.del(z).
        // Мердж B видит: x,y есть локально (не менялись с базы), нет на сервере.
        // Приём серверных удалений убирает их из out, но `changed` не ставился —
        // merge возвращал null, стор писал НЕСЛИТОЕ зеркало, и x/y воскресали.
        const mk = (label) => makeStore({
            label, key: 'items', empty: () => [],
            countEntries: v => (Array.isArray(v) ? v.length : null),
            // Живой сценарий: обе сессии пишут ОДИН файл галереи.
            name: 'uris_merge_del-shared.json',
        });
        const a = mk('del-a');
        const b = mk('del-b');
        await a.ready();
        await b.ready();

        const ids = storeName => {
            const doc = JSON.parse(serverFiles.get(storeName.name));
            return (doc.items || []).map(r => r.id);
        };

        await a.mutate(list => list.unshift({ id: 'x', v: 1, updatedAt: 1000 }));
        await a.flush();
        await a.mutate(list => list.unshift({ id: 'y', v: 1, updatedAt: 2000 }));
        await a.flush();

        await b.mutate(list => list.unshift({ id: 'z', v: 1, updatedAt: 3000 }));
        await b.flush();
        assert.deepEqual(ids(a).sort(), ['x', 'y', 'z']);

        await a.mutate(list => { const i = list.findIndex(r => r.id === 'y'); list.splice(i, 1); });
        await a.flush();
        await a.mutate(list => { const i = list.findIndex(r => r.id === 'x'); list.splice(i, 1); });
        await a.flush();
        assert.deepEqual(ids(a), ['z'], 'на сервере остались только z');

        // B пишет (удаляет свой z): его база всё ещё содержит x и y.
        await b.mutate(list => { const i = list.findIndex(r => r.id === 'z'); list.splice(i, 1); });
        await b.flush();

        assert.deepEqual(ids(b), [],
            'серверные удаления x и y должны быть приняты мерджем B, а не откачены его записью');
    });
});
