// @ts-check
/**
 * Generic server-file store: probe / load / write / flush. The surrounding
 * stubs mirror tests/template-file-store.test.js so both layers see the same
 * server shape.
 */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

const moduleSettings = {};       // stands in for extensionSettings.ur_image_studio
const serverFiles = new Map();   // name → file text (what the server would store)
const uploads = [];              // { name, data, keepalive }
let verifyAvailable = true;
let failUploads = false;
let probeThrows = false;
let gateUploads = null;          // optional deferred gating of upload responses

const originalSt = globalThis.SillyTavern;
const originalFetch = globalThis.fetch;
const originalToastr = globalThis.toastr;

const toastErrors = [];

/**
 * Stubs are (re)installed per test: `createFileStore` resolves the context
 * lazily on every call, so a torn-down global would silently push later tests
 * into legacy mode.
 */
function installStubs() {
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: { ur_image_studio: moduleSettings },
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
    globalThis.toastr = { error: msg => toastErrors.push(msg) };
    globalThis.fetch = fetchStub;
}

const fetchStub = async (url, options = {}) => {
    if (url === '/api/files/verify') {
        if (probeThrows) throw new Error('offline');
        if (!verifyAvailable) return { ok: false, status: 404, text: async () => '' };
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    if (url === '/api/files/upload' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        uploads.push({ ...body, keepalive: options.keepalive === true });
        if (gateUploads) await gateUploads;
        if (failUploads) return { ok: false, status: 500, text: async () => 'boom' };
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

const { createFileStore, listFileStores, resetFileStoresForTests } = await import('../src/file-store.js');

let labelCounter = 0;
/** A store wired to `moduleSettings[key]` the way the real callers are. */
function makeStore(overrides = {}) {
    const key = overrides.key || 'items';
    const label = `test-${++labelCounter}`;
    return createFileStore({
        label,
        name: `uris_test_${label}.json`,
        key,
        version: 1,
        empty: () => [],
        probeRetryMs: 10,
        ...overrides,
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function serverDoc(store, key = 'items') {
    return JSON.parse(serverFiles.get(store.name))[key];
}

beforeEach(() => {
    installStubs();
    for (const k of Object.keys(moduleSettings)) delete moduleSettings[k];
    serverFiles.clear();
    uploads.length = 0;
    verifyAvailable = true;
    failUploads = false;
    probeThrows = false;
    gateUploads = null;
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

// ── Mode selection ──

describe('file-store: mode selection', () => {
    it('probe ok → file mode', async () => {
        const store = makeStore();
        assert.equal(await store.ready(), 'file');
        assert.equal(store.isFileMode(), true);
    });

    it('probe HTTP failure (no user-files API) → readonly, writes refused, no uploads', async () => {
        verifyAvailable = false;
        const store = makeStore();
        assert.equal(await store.ready(), 'readonly');
        await store.mutate(items => items.push({ id: 'b' }));
        await store.flush();
        assert.equal(serverFiles.size, 0);
        assert.equal(store.diagnostics().lastWriteOk, false);
        assert.equal(store.diagnostics().lastError, 'no-user-files');
    });

    it('probe throwing → ready() stays pending and resolves once the surface answers', async () => {
        probeThrows = true;
        const store = makeStore();
        const pending = store.ready();
        const winner = await Promise.race([pending.then(() => 'resolved'), sleep(50).then(() => 'pending')]);
        assert.equal(winner, 'pending', 'нет данных, на которых можно честно работать — ждём');
        probeThrows = false;
        assert.equal(await pending, 'file');
    });
});

// ── Load ──

describe('file-store: load', () => {
    it('corrupt file is repaired with the empty mirror', async () => {
        const store = makeStore();
        serverFiles.set(store.name, '{ not json');
        await store.ready();
        await store.flush();
        assert.equal(store.diagnostics().readResult, 'corrupt');
        assert.deepEqual(serverDoc(store), [], 'пустой документ-ремонт записан');
    });

    it('a document from a newer build is read-only, not repaired away', async () => {
        const store = makeStore();
        serverFiles.set(store.name, JSON.stringify({ v: 99, items: [{ id: 'old' }] }));
        await store.ready();
        assert.equal(store.mode(), 'readonly');
        assert.equal(store.diagnostics().readResult, 'newer');
        await store.mutate(list => list.push({ id: 'local' }));
        await store.flush();
        assert.equal(uploads.length, 0, 'an older build must never overwrite a newer document');
        assert.deepEqual(serverDoc(store), [{ id: 'old' }]);
    });

    it('a document from an older build is adopted (lazy migration), not wiped', async () => {
        const store = makeStore({ version: 2 });
        serverFiles.set(store.name, JSON.stringify({ v: 1, items: [{ id: 'old' }] }));
        await store.ready();
        assert.equal(store.diagnostics().readResult, 'older');
        assert.deepEqual(store.snapshot(), [{ id: 'old' }], 'данные старой версии загружены');
        await store.flush();
        const doc = JSON.parse(serverFiles.get(store.name));
        assert.equal(doc.v, 2, 'документ переписан с текущей версией');
        assert.deepEqual(doc.items, [{ id: 'old' }], 'содержимое пережило миграцию');
    });

    it('document missing the value key is treated as corrupt', async () => {
        const store = makeStore();
        serverFiles.set(store.name, JSON.stringify({ v: 1, other: [] }));
        await store.ready();
        assert.equal(store.diagnostics().readResult, 'corrupt');
    });

    it('nothing anywhere → empty value, no write', async () => {
        const store = makeStore();
        await store.ready();
        await store.flush();
        assert.deepEqual(store.snapshot(), []);
        assert.equal(uploads.length, 0, 'an empty store is not written');
    });
});

// ── Writes ──

describe('file-store: writes', () => {
    it('mutate persists and flush awaits durability', async () => {
        const store = makeStore();
        await store.ready();
        await store.mutate(items => items.push({ id: 'a' }));
        assert.equal(await store.flush(), true);
        assert.deepEqual(serverDoc(store).map(i => i.id), ['a']);
    });

    it('coalesces mutations issued while a write is in flight', async () => {
        // Gate the first upload so the later mutations land while it is pending.
        let release = null;
        const gate = new Promise(resolve => { release = resolve; });
        gateUploads = gate;
        const store = makeStore();
        await store.ready();

        const first = store.mutate(items => items.push({ id: 'a' }));
        const second = store.mutate(items => items.push({ id: 'b' }));
        const third = store.mutate(items => items.push({ id: 'c' }));
        release();
        gateUploads = null;
        await Promise.all([first, second, third]);
        await store.flush();

        // One in-flight upload plus one settle for everything queued behind it.
        assert.equal(uploads.length, 2, `expected 2 uploads, got ${uploads.length}`);
        assert.deepEqual(serverDoc(store).map(i => i.id), ['a', 'b', 'c']);
    });

    it('replace swaps the whole value', async () => {
        const store = makeStore();
        await store.ready();
        await store.replace([{ id: 'z' }]);
        await store.flush();
        assert.deepEqual(serverDoc(store).map(i => i.id), ['z']);
    });

    it('retries a failed payload on the next unload flush', async () => {
        const store = makeStore();
        await store.ready();
        failUploads = true;
        await store.mutate(items => items.push({ id: 'a' }));
        await store.flush();
        assert.equal(store.diagnostics().lastWriteOk, false);

        failUploads = false;
        store.flushOnUnload();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(uploads.at(-1).keepalive, true);
        assert.deepEqual(JSON.parse(Buffer.from(uploads.at(-1).data, 'base64').toString('utf8')).items.map(i => i.id), ['a']);
    });

    it('records a write failure and raises exactly one toast per interval', async () => {
        const store = makeStore();
        await store.ready();
        failUploads = true;
        await store.mutate(items => items.push({ id: 'a' }));
        await store.flush();
        assert.equal(toastErrors.length, 1);
    });
});

// ── Unload flush ──

describe('file-store: unload flush', () => {
    it('sends the pending payload with keepalive', async () => {
        const store = makeStore();
        await store.ready();
        await store.mutate(items => items.push({ id: 'a' }));
        await store.flush();
        assert.equal(uploads.at(-1).keepalive, false, 'normal write is not keepalive');

        failUploads = true;
        await store.mutate(items => items.push({ id: 'b' }));
        await store.flush();
        failUploads = false;
        store.flushOnUnload();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(uploads.at(-1).keepalive, true);
    });

    it('skips a payload above the keepalive cap instead of dropping it silently', async () => {
        const store = makeStore({ keepaliveLimit: 32 });
        await store.ready();
        failUploads = true;
        await store.mutate(items => items.push({ id: 'x'.repeat(100) }));
        await store.flush();
        const before = uploads.length;
        store.flushOnUnload();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(uploads.length, before, 'no keepalive attempt above the cap');
    });

    it('is a no-op when every write already landed', async () => {
        const store = makeStore();
        await store.ready();
        await store.mutate(items => items.push({ id: 'a' }));
        await store.flush();
        const before = uploads.length;
        store.flushOnUnload();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(uploads.length, before);
    });
});

// ── Reporting ──

describe('file-store: reporting', () => {
    it('footprint and diagnostics describe the store', async () => {
        const store = makeStore();
        serverFiles.set(store.name, JSON.stringify({ v: 1, items: [{ id: 'a' }, { id: 'b' }] }));
        await store.ready();
        const fp = store.footprint();
        assert.equal(fp.mode, 'file');
        assert.equal(fp.entries, 2);
        assert.equal(fp.file, store.name);
    });

    it('registers itself for the settings panel and unload sweep', async () => {
        const store = makeStore();
        await store.ready();
        const listed = listFileStores();
        assert.equal(listed.some(entry => entry.label === store.label), true);
    });

    it('snapshot is a clone — mutating it cannot corrupt the mirror', async () => {
        const store = makeStore();
        serverFiles.set(store.name, JSON.stringify({ v: 1, items: [{ id: 'a' }] }));
        await store.ready();
        const snap = store.snapshot();
        snap.push({ id: 'injected' });
        assert.equal(store.snapshot().length, 1);
    });
});
