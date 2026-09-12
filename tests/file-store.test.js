// @ts-check
/**
 * Generic server-file store: probe / load / migrate / strip / write / flush.
 * The surrounding stubs mirror tests/template-file-store.test.js so both layers
 * see the same server shape.
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
        legacyRead: () => moduleSettings[key],
        legacyWrite: value => { moduleSettings[key] = value; },
        legacyStrip: () => {
            const bytes = moduleSettings[key] ? JSON.stringify(moduleSettings[key]).length : 0;
            delete moduleSettings[key];
            return bytes;
        },
        ...overrides,
    });
}

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

    it('probe HTTP failure → legacy mode, no file writes', async () => {
        verifyAvailable = false;
        moduleSettings.items = [{ id: 'a' }];
        const store = makeStore();
        assert.equal(await store.ready(), 'legacy');
        await store.mutate(items => items.push({ id: 'b' }));
        assert.equal(serverFiles.size, 0);
        assert.deepEqual(moduleSettings.items.map(i => i.id), ['a', 'b']);
    });

    it('probe throwing → legacy mode', async () => {
        probeThrows = true;
        const store = makeStore();
        assert.equal(await store.ready(), 'legacy');
    });

    it('legacy mode without legacyWrite does not throw on mutate', async () => {
        verifyAvailable = false;
        const store = makeStore({ legacyWrite: null, legacyStrip: null });
        await store.ready();
        const result = await store.mutate(items => { items.push({ id: 'x' }); return 'ok'; });
        assert.equal(result, 'ok');
    });
});

// ── Load / migration / strip ──

describe('file-store: migration', () => {
    it('no file + settings copy → migrates, persists, then strips', async () => {
        moduleSettings.items = [{ id: 'a' }, { id: 'b' }];
        const store = makeStore({ stripLegacyOnLoad: true });
        await store.ready();
        await store.flush();
        assert.deepEqual(serverDoc(store).map(i => i.id), ['a', 'b']);
        assert.equal(Object.hasOwn(moduleSettings, 'items'), false, 'settings copy stripped');
        assert.equal(store.diagnostics().freedBytes > 0, true);
    });

    it('keeps the settings copy when stripLegacyOnLoad is false (template behaviour)', async () => {
        moduleSettings.items = [{ id: 'a' }];
        const store = makeStore({ stripLegacyOnLoad: false });
        await store.ready();
        await store.flush();
        assert.deepEqual(serverDoc(store).map(i => i.id), ['a']);
        assert.deepEqual(moduleSettings.items.map(i => i.id), ['a'], 'copy retained for downgrade');
    });

    it('failed migration upload does NOT strip the settings copy', async () => {
        moduleSettings.items = [{ id: 'a' }];
        failUploads = true;
        const store = makeStore({ stripLegacyOnLoad: true });
        await store.ready();
        await store.flush();
        assert.deepEqual(moduleSettings.items.map(i => i.id), ['a'], 'survives a failed write');
        assert.equal(store.diagnostics().lastWriteOk, false);
        assert.equal(serverFiles.size, 0);
    });

    it('existing file wins and the settings copy is stripped', async () => {
        const store = makeStore({ stripLegacyOnLoad: true });
        serverFiles.set(store.name, JSON.stringify({ v: 1, items: [{ id: 'from-file' }] }));
        moduleSettings.items = [{ id: 'stale' }];
        await store.ready();
        assert.deepEqual(store.snapshot().map(i => i.id), ['from-file']);
        // Union-by-id is not needed when the file is authoritative, but the
        // legacy copy must still go away once the file has been read.
        assert.equal(Object.hasOwn(moduleSettings, 'items'), false);
    });

    it('unions file and settings records by id', async () => {
        // A valid file wins outright — merging the settings copy back would
        // resurrect records the user already deleted.
        const store = makeStore({ stripLegacyOnLoad: true });
        serverFiles.set(store.name, JSON.stringify({ v: 1, items: [{ id: 'a' }] }));
        moduleSettings.items = [{ id: 'a' }, { id: 'b' }];
        await store.ready();
        await store.flush();
        assert.deepEqual(store.snapshot().map(i => i.id), ['a']);
        assert.deepEqual(serverDoc(store).map(i => i.id), ['a']);
        assert.equal(Object.hasOwn(moduleSettings, 'items'), false, 'stale copy is stripped');
    });

    it('corrupt file is treated as missing and re-migrated from settings', async () => {
        const store = makeStore({ stripLegacyOnLoad: true });
        serverFiles.set(store.name, '{ not json');
        moduleSettings.items = [{ id: 'a' }];
        await store.ready();
        await store.flush();
        assert.equal(store.diagnostics().readResult, 'corrupt');
        assert.deepEqual(serverDoc(store).map(i => i.id), ['a']);
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

    it('a document from an older build is treated as corrupt', async () => {
        const store = makeStore({ version: 2 });
        serverFiles.set(store.name, JSON.stringify({ v: 1, items: [{ id: 'old' }] }));
        await store.ready();
        assert.equal(store.diagnostics().readResult, 'corrupt');
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
