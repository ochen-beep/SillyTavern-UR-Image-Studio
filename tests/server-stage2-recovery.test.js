// @ts-check
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defaultSettings, state } from '../src/core.js';

const records = new Map();
let calls = [];
const extensionSettings = {};
const originalFetch = globalThis.fetch;

globalThis.SillyTavern = {
    getContext: () => ({ extensionSettings, saveSettingsDebounced() {}, getRequestHeaders: () => ({}) }),
    libs: { localforage: {
        getItem: async key => records.get(key) ?? null,
        setItem: async (key, value) => { records.set(key, value); },
        removeItem: async key => { records.delete(key); },
    } },
};
globalThis.window = { dispatchEvent() {} };

globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const id = decodeURIComponent(String(url).split('/').pop());
    if (String(url) === '/api/images/upload') return response({ path: 'user/images/UR%20Image%20Studio/recovered.png' });
    if (String(url) === '/api/images/list') return response(['recovered.png']);
    if (String(url).endsWith('/generate')) return response({ requestId: id, state: 'ready', result: { kind: 'dataUrl', value: 'data:image/png;base64,ready' } });
    if (String(url).includes('/requests/')) return response({ requestId: id, state: 'ready', result: { kind: 'dataUrl', value: 'data:image/png;base64,ready' } });
    throw new Error(`unexpected ${url}`);
};

const recovery = await import('../src/image-recovery.js');
const storage = await import('../src/storage.js');
const KEY = 'uris_pending_images';
const UUID = '9e8bd96d-dab7-4ac8-9ef8-46b746f9f7e7';
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, async json() { return body; } }; }
function snapshot() { return { prompt: 'immutable', references: [{ id: 'r1', dataUrl: 'data:image/png;base64,ref' }], gallery: { mode: 'anchor' } }; }

beforeEach(() => {
    records.clear();
    for (const key of Object.keys(extensionSettings)) delete extensionSettings[key];
    calls = [];
    state.settings = { ...defaultSettings };
});
after(() => { globalThis.fetch = originalFetch; });

test('legacy server recovery stays out of normal extension startup', async () => {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /resumePendingServerRequests/);
    assert.doesNotMatch(source, /resumeServerRequest\(|\/generate/);
});

test('server request records are submitted, frozen, and retain server metadata', async () => {
    const input = snapshot();
    const id = await recovery.savePendingServerRequest({ requestId: UUID, connId: 'server-1', chatId: 'chat', sourceMsgId: 4, snapshot: input });
    input.prompt = 'mutated';
    const item = (await recovery.getPendingImages()).find(x => x.kind === 'serverRequest');
    assert.equal(id, UUID);
    assert.equal(item.status, 'submitted');
    assert.equal(item.snapshot.prompt, 'immutable');
    assert.throws(() => { item.snapshot.prompt = 'x'; }, TypeError);
});

test('pending server snapshot retains complete gallery connection metadata', async () => {
    const pending = await recovery.savePendingServerRequest({
        requestId: UUID,
        connId: 'server-1',
        chatId: 'chat',
        snapshot: {
            ...snapshot(),
            connectionId: 'server-1',
            routeId: 'route-1',
            modelId: 'model-1',
            generationContract: 'openai-images',
        },
    });
    const item = (await recovery.getPendingImages()).find(x => x.id === pending);
    assert.equal(item.snapshot.connectionId, 'server-1');
    assert.equal(item.snapshot.routeId, 'route-1');
    assert.equal(item.snapshot.modelId, 'model-1');
    assert.equal(item.snapshot.generationContract, 'openai-images');
});

test('savePendingServerRequest upserts the same requestId without duplicates', async () => {
    await recovery.savePendingServerRequest({ requestId: UUID, connId: 'server-1', chatId: 'chat', snapshot: snapshot() });
    await recovery.savePendingServerRequest({ requestId: UUID, connId: 'server-2', chatId: 'chat-2', snapshot: { ...snapshot(), prompt: 'replacement' } });
    const items = (await recovery.getPendingImages()).filter(x => x.requestId === UUID);
    assert.equal(items.length, 1);
    assert.equal(items[0].connId, 'server-2');
    assert.equal(items[0].snapshot.prompt, 'replacement');
});

test('persisted server snapshot is re-cloned and frozen after reload', async () => {
    const input = snapshot();
    await recovery.savePendingServerRequest({ requestId: UUID, connId: 'server-1', chatId: 'chat', snapshot: input });
    const persisted = records.get(KEY);
    persisted[0].snapshot = JSON.parse(JSON.stringify(persisted[0].snapshot));
    persisted[0].snapshot.references[0].id = 'persisted-mutation';
    const item = (await recovery.getPendingImages()).find(x => x.requestId === UUID);
    assert.equal(item.snapshot.references[0].id, 'persisted-mutation');
    assert.throws(() => { item.snapshot.references[0].id = 'exposed-mutation'; }, TypeError);
    const reloaded = (await recovery.getPendingImages()).find(x => x.requestId === UUID);
    assert.equal(reloaded.snapshot.references[0].id, 'persisted-mutation');
});

test('startup resumes server requests with GET only and stores a ready server result', async () => {
    const original = {
        prompt: 'immutable', aspectRatio: '16:9', imageSize: '2K', quality: 'high',
        references: [{ id: 'r1', name: 'Aria', dataUrl: 'data:image/png;base64,ref' }],
        refsSig: 'sig-1', instruction: {
            prompt: 'instruction prompt', negativePrompt: 'avoid blur', style: 'cinematic',
            aspectRatio: '16:9', imageSize: '2K', quality: 'high',
        },
        connectionId: 'conn-1', routeId: 'route-1', modelId: 'model-1', generationContract: 'openai-images',
        stage2Snapshot: { draft: { prompt: 'draft prompt' } },
    };
    await records.set(KEY, [{ id: UUID, kind: 'serverRequest', requestId: UUID, connId: 'server-1', chatId: 'chat', sourceMsgId: 4, snapshot: original, galleryMetadata: { source: 'scene' }, status: 'submitted', createdAt: new Date().toISOString() }]);
    await recovery.resumePendingServerRequests();
    const posts = calls.filter(c => c.options.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, '/api/images/upload');
    assert.equal(calls.filter(c => c.options.method === 'GET').length, 1);
    assert.deepEqual(await recovery.getPendingImages(), []);
    const [entry] = await storage.getGallery('chat');
    assert.equal(entry.prompt, original.instruction.prompt);
    assert.equal(entry.src, 'user/images/UR%20Image%20Studio/recovered.png');
    assert.equal(entry.imagePath, 'user/images/UR%20Image%20Studio/recovered.png');
    assert.equal(entry.negativePrompt, original.instruction.negativePrompt);
    assert.equal(entry.connectionId, original.connectionId);
    assert.equal(entry.routeId, original.routeId);
    assert.equal(entry.modelId, original.modelId);
    assert.equal(entry.generationContract, original.generationContract);
    assert.equal(entry.quality, original.instruction.quality);
    assert.deepEqual(entry.refs, [{ id: 'r1', name: 'Aria' }]);
    assert.deepEqual(entry.stage2Snapshot, original.stage2Snapshot);
});

test('startup retains definitive and ambiguous failures, while unavailable stays submitted', async () => {
    const entries = [
        ['failed', 'failed'], ['ambiguous', 'failed-ambiguous'], ['unavailable', 'submitted'], ['missing', 'notSubmitted'],
    ];
    const originalFetchForTest = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const id = decodeURIComponent(String(url).split('/').pop());
        const state = entries.find(([suffix]) => id.endsWith(suffix))?.[1] || 'failed';
        if (id.endsWith('unavailable')) return Promise.reject(new Error('offline'));
        if (id.endsWith('missing')) return response({ error: { code: 'REQUEST_NOT_FOUND', message: 'missing' } }, 404);
        return response({ requestId: id, state });
    };
    const stored = entries.map(([suffix]) => ({ id: `${UUID}-${suffix}`, requestId: `${UUID}-${suffix}`, kind: 'serverRequest', connId: 'c', chatId: 'chat', snapshot: snapshot(), status: 'submitted', createdAt: new Date().toISOString() }));
    await records.set(KEY, stored);
    await recovery.resumePendingServerRequests();
    globalThis.fetch = originalFetchForTest;
    const ids = (await recovery.getPendingImages()).map(x => x.id);
    assert.deepEqual(ids.sort(), entries.map(([suffix]) => `${UUID}-${suffix}`).sort());
    assert.equal((await recovery.getPendingImages()).find(x => x.id.endsWith('failed')).status, 'failed');
    assert.equal((await recovery.getPendingImages()).find(x => x.id.endsWith('ambiguous')).status, 'failed-ambiguous');
    assert.equal((await recovery.getPendingImages()).find(x => x.id.endsWith('unavailable')).status, 'submitted');
    assert.equal((await recovery.getPendingImages()).find(x => x.id.endsWith('missing')).status, 'notSubmitted');
});

test('server request recovery retains unresolved statuses beyond TTL', async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const statuses = ['submitted', 'notSubmitted', 'failed', 'failed-ambiguous'];
    await records.set(KEY, statuses.map(status => ({
        id: `${UUID}-${status}`, requestId: `${UUID}-${status}`, kind: 'serverRequest',
        connId: 'c', chatId: 'chat', snapshot: snapshot(), status, createdAt: old,
    })));

    await recovery.resumePendingServerRequests();

    assert.deepEqual(
        (await recovery.getPendingImages()).map(item => item.status).sort(),
        ['notSubmitted', 'failed', 'failed-ambiguous'].sort(),
    );
    assert.equal((await storage.getGallery('chat')).length, 1);
});

test('ready records without a durable result remain recoverable beyond TTL', async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await records.set(KEY, [
        { id: `${UUID}-ready`, requestId: `${UUID}-ready`, kind: 'serverRequest', connId: 'c', chatId: 'chat', snapshot: snapshot(), status: 'ready', createdAt: old },
        { id: `${UUID}-done`, requestId: `${UUID}-done`, kind: 'serverRequest', connId: 'c', chatId: 'chat', snapshot: snapshot(), status: 'done', createdAt: old },
    ]);

    await recovery.resumePendingServerRequests();

    const pending = await recovery.getPendingImages();
    assert.deepEqual(pending.map(item => item.id), [`${UUID}-ready`]);
    assert.equal(pending[0].status, 'ready');
});

test('not-dispatched server state maps to resumable notSubmitted', async () => {
    const originalFetchForTest = globalThis.fetch;
    globalThis.fetch = async () => response({ requestId: UUID, state: 'not-dispatched' });
    await records.set(KEY, [{ id: UUID, requestId: UUID, kind: 'serverRequest', connId: 'c', chatId: 'chat', snapshot: snapshot(), status: 'submitted', createdAt: new Date().toISOString() }]);

    await recovery.resumePendingServerRequests();
    globalThis.fetch = originalFetchForTest;

    assert.equal((await recovery.getPendingImages()).find(x => x.id === UUID).status, 'notSubmitted');
});

test('explicit resume posts the immutable snapshot with the same ID', async () => {
    await records.set(KEY, [{ id: UUID, kind: 'serverRequest', requestId: UUID, connId: 'server-1', chatId: 'chat', snapshot: snapshot(), status: 'notSubmitted', createdAt: new Date().toISOString() }]);
    await recovery.resumeServerRequest(UUID);
    const post = calls.find(c => c.options.method === 'POST');
    assert.ok(post);
    const body = JSON.parse(post.options.body);
    assert.equal(body.requestId, UUID);
    assert.equal(body.prompt, 'immutable');
});

test('discardPending removes server records', async () => {
    await recovery.savePendingServerRequest({ requestId: UUID, connId: 'server-1', chatId: 'chat', snapshot: snapshot() });
    assert.equal(await recovery.discardPending(UUID), true);
    assert.equal((await recovery.getPendingImages()).length, 0);
});
