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
