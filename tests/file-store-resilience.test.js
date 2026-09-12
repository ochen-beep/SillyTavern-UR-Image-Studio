// @ts-check
/**
 * Resilience of the generic file store against the failure modes that can
 * destroy user data rather than just inconvenience it:
 *   - a failed initial read must never allow a blind full-file overwrite;
 *   - a document written by a NEWER extension version must never be repaired
 *     away by an older build (read-only instead);
 *   - a transient probe failure at startup must not pin the session to legacy
 *     settings mode forever (throttled retry, session work carried over);
 *   - the unload keepalive flush must not duplicate the same payload.
 * Harness mirrors tests/file-store.test.js with two additions: `failReads`
 * (GET /user/files → 500) and a keepalive-only upload counter.
 */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

const moduleSettings = {};
const serverFiles = new Map();
const uploads = [];            // every upload, keepalive or not
let keepaliveUploads = 0;
let verifyAvailable = true;
let probeThrows = false;
let failReads = false;

const originalSt = globalThis.SillyTavern;
const originalFetch = globalThis.fetch;
const originalToastr = globalThis.toastr;
const toastErrors = [];

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
        if (options.keepalive === true) keepaliveUploads += 1;
        serverFiles.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
        return { ok: true, status: 200, json: async () => ({}) };
    }
    if (url.startsWith('/user/files/')) {
        if (failReads) return { ok: false, status: 500, text: async () => 'boom' };
        const name = decodeURIComponent(url.slice('/user/files/'.length));
        if (!serverFiles.has(name)) return { ok: false, status: 404, text: async () => '' };
        return { ok: true, status: 200, text: async () => serverFiles.get(name) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
};

const { createFileStore, resetFileStoresForTests } = await import('../src/file-store.js');

let labelCounter = 0;
function makeStore(overrides = {}) {
    const key = overrides.key || 'items';
    const label = `resilience-${++labelCounter}`;
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
    keepaliveUploads = 0;
    verifyAvailable = true;
    probeThrows = false;
    failReads = false;
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

// ── F1: failed initial read must not enable a blind overwrite ──

describe('file-store resilience: unreadable file at load', () => {
    it('read 500 at load → session writes are blocked once the file is confirmed present', async () => {
        const store = makeStore({ stripLegacyOnLoad: true });
        serverFiles.set(store.name, JSON.stringify({ v: 1, items: [{ id: 'file' }] }));
        failReads = true;
        await store.ready();
        assert.equal(store.mode(), 'file', 'probe succeeded, only the read failed');
        failReads = false;

        await store.mutate(list => list.push({ id: 'session' }));
        await store.flush();

        assert.equal(uploads.length, 0, 'the server file must not be overwritten from an untrusted base');
        assert.deepEqual(serverDoc(store), [{ id: 'file' }], 'file content is intact');
        assert.equal(store.diagnostics().lastWriteOk, false);
        assert.ok(toastErrors.some(msg => String(msg).includes(store.label)), 'the user is told writes are blocked');

        // A later mutation stays blocked too — no retry can repair an untrusted mirror.
        await store.mutate(list => list.push({ id: 'session-2' }));
        await store.flush();
        assert.equal(uploads.length, 0);
        assert.deepEqual(serverDoc(store), [{ id: 'file' }]);
    });

    it('read 500 at load → write proceeds after the re-read confirms the file is absent (404)', async () => {
        const store = makeStore({ stripLegacyOnLoad: true });
        failReads = true;
        await store.ready();
        failReads = false;

        await store.mutate(list => list.push({ id: 'a' }));
        await store.flush();

        assert.equal(uploads.length, 1, 'a confirmed-absent file is safe to create');
        assert.deepEqual(serverDoc(store), [{ id: 'a' }]);
    });

    it('read still failing at write time → payload waits, nothing is sent', async () => {
        const store = makeStore({ stripLegacyOnLoad: true });
        failReads = true;
        await store.ready();

        await store.mutate(list => list.push({ id: 'a' }));
        await store.flush();

        assert.equal(uploads.length, 0);
        assert.equal(store.diagnostics().lastWriteOk, false);
    });

    it('the unload keepalive flush respects the block', async () => {
        const store = makeStore({ stripLegacyOnLoad: true });
        serverFiles.set(store.name, JSON.stringify({ v: 1, items: [{ id: 'file' }] }));
        failReads = true;
        await store.ready();
        await store.mutate(list => list.push({ id: 'session' }));
        await new Promise(resolve => setTimeout(resolve, 5));

        store.flushOnUnload();
        assert.equal(keepaliveUploads, 0, 'keepalive must not bypass the unreadable-file guard');
    });
});

// ── F2: a newer-version document is read-only, never repaired away ──

describe('file-store resilience: newer-version document', () => {
    it('doc.v > store version → readonly mode, no write, no strip, user told', async () => {
        const store = makeStore({ stripLegacyOnLoad: true });
        serverFiles.set(store.name, JSON.stringify({ v: 99, items: [{ id: 'newer' }] }));
        moduleSettings.items = [{ id: 'stale' }];

        await store.ready();
        assert.equal(store.mode(), 'readonly');
        assert.equal(store.diagnostics().readResult, 'newer');
        assert.deepEqual(store.snapshot(), [{ id: 'newer' }], 'the newer content is loaded best-effort');

        await store.mutate(list => list.push({ id: 'local' }));
        await store.flush();

        assert.equal(uploads.length, 0, 'an older build must never overwrite a newer document');
        assert.deepEqual(serverDoc(store), [{ id: 'newer' }]);
        assert.deepEqual(moduleSettings.items, [{ id: 'stale' }], 'the settings copy is not stripped while the file is unmanageable');
        assert.ok(toastErrors.length > 0, 'the user is told to update');
    });

    it('doc.v < store version → corrupt repair (existing forward-migration behavior)', async () => {
        const store = makeStore({ version: 2, stripLegacyOnLoad: true });
        serverFiles.set(store.name, JSON.stringify({ v: 1, items: [{ id: 'old' }] }));
        moduleSettings.items = [{ id: 'migrated' }];

        await store.ready();
        await store.flush();
        assert.equal(store.diagnostics().readResult, 'corrupt');
        assert.deepEqual(serverDoc(store), [{ id: 'migrated' }]);
    });
});

// ── F4: transient probe failure is retried, session work survives ──

describe('file-store resilience: legacy retry after transient probe failure', () => {
    it('probe blip → legacy session work is merged into the file once the probe recovers', async () => {
        const store = makeStore({ stripLegacyOnLoad: true, legacyRetryMs: 5 });
        moduleSettings.items = [{ id: 'base' }];

        probeThrows = true;
        await store.ready();
        assert.equal(store.mode(), 'legacy');

        await store.mutate(list => list.push({ id: 'session' }));
        assert.deepEqual(moduleSettings.items.map(i => i.id), ['base', 'session'], 'legacy mode writes settings');

        // The server file exists and holds its own content; the probe recovers.
        probeThrows = false;
        serverFiles.set(store.name, JSON.stringify({ v: 1, items: [{ id: 'file-1' }, { id: 'base' }] }));
        await new Promise(resolve => setTimeout(resolve, 10));

        await store.ready();
        assert.equal(store.mode(), 'file');
        assert.deepEqual(
            store.snapshot().map(i => i.id).sort(),
            ['base', 'file-1', 'session'],
            'session work survives the transition, file records win on id conflicts',
        );
        await store.flush();
        assert.equal(uploads.length, 1, 'the merged state is persisted');
        assert.equal(Object.hasOwn(moduleSettings, 'items'), false, 'settings copy stripped after durable merge');
    });

    it('probe 404 (no user-files endpoint) is permanent and never retried', async () => {
        const store = makeStore({ stripLegacyOnLoad: true, legacyRetryMs: 0 });
        verifyAvailable = false;
        await store.ready();
        assert.equal(store.mode(), 'legacy');

        verifyAvailable = true;
        await store.ready();
        assert.equal(store.mode(), 'legacy', 'a missing endpoint is a permanent condition, not a blip');
    });
});

// ── F5: small correctness details ──

describe('file-store resilience: flush and bookkeeping details', () => {
    it('flushOnUnload sends the same payload at most once', async () => {
        const store = makeStore();
        await store.ready();
        // Park a payload in flight so flushOnUnload has something to re-send.
        let release;
        const gatePromise = new Promise(resolve => { release = resolve; });
        globalThis.fetch = async (url, options = {}) => {
            if (url === '/api/files/upload' && options.method === 'POST' && options.keepalive !== true) {
                await gatePromise;
                return { ok: true, status: 200, json: async () => ({}) };
            }
            return fetchStub(url, options);
        };

        store.mutate(list => list.push({ id: 'a' }));   // schedules the write, upload is gated
        await new Promise(resolve => setTimeout(resolve, 10));
        store.flushOnUnload();
        store.flushOnUnload();
        release();
        await store.flush();

        assert.equal(keepaliveUploads, 1, 'visibilitychange + pagehide must not double-send');
    });

    it('diagnostics report entry counts without breaking writes', async () => {
        const store = makeStore();
        await store.ready();
        await store.mutate(list => list.push({ id: 'a' }));
        await store.flush();
        assert.equal(store.diagnostics().entries, 1);
        assert.equal(store.diagnostics().lastWriteOk, true);
    });
});
