// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

const extensionSettings = {};
const keyStore = new Map();
let saveCalls = 0;

globalThis.SillyTavern = {
    getContext: () => ({
        extensionSettings,
        saveSettingsDebounced: () => { saveCalls += 1; },
    }),
    libs: {
        localforage: {
            async getItem(key) { return keyStore.get(key) ?? null; },
            async setItem(key, value) { keyStore.set(key, value); },
            async removeItem(key) { keyStore.delete(key); },
        },
    },
};

const store = await import('../src/connection-store.js');

function reset() {
    for (const key of Object.keys(extensionSettings)) delete extensionSettings[key];
    keyStore.clear();
    saveCalls = 0;
}

test('stores normalized connection metadata in shared settings without secrets', async () => {
    reset();

    const created = await store.createConnection({
        id: 'primary', name: 'Primary', endpoint: 'https://api.example.test/v1/',
        apiKey: 'must-not-persist', api_token: 'must-not-persist', refreshToken: 'must-not-persist', private_key: 'must-not-persist',
        nested: { token: 'also-not-persist', apiToken: 'also-not-persist', privateKey: 'also-not-persist' },
        selectedRoute: { source: 'manual', modelId: 'gpt-image-1', apiFamily: 'openai-images' },
    });

    assert.equal(created.endpoint, 'https://api.example.test/v1');
    assert.equal(created.timeoutMs, 120000);
    assert.equal(extensionSettings.ur_image_studio.imageConnections.connections[0].timeoutMs, 120000);
    assert.equal(created.apiKey, undefined);
    assert.equal(created.api_token, undefined);
    assert.equal(created.refreshToken, undefined);
    assert.equal(created.private_key, undefined);
    assert.equal(created.nested.token, undefined);
    assert.equal(created.nested.apiToken, undefined);
    assert.equal(created.nested.privateKey, undefined);
    assert.deepEqual(await store.listConnections(), [created]);
    assert.deepEqual(extensionSettings.ur_image_studio.imageConnections.connections, [created]);
    assert.equal(saveCalls, 1);
});

test('does not persist nested Google API key header aliases', async () => {
    reset();

    const created = await store.createConnection({
        id: 'google',
        headers: {
            'x-goog-api-key': 'must-not-persist',
            X_Goog_Api_Key: 'must-not-persist',
            xGoogApiKey: 'must-not-persist',
            accept: 'application/json',
        },
        nested: { request: { headers: { 'X Goog Api Key': 'must-not-persist', keep: 'safe' } } },
    });
    const persisted = extensionSettings.ur_image_studio.imageConnections.connections[0];

    assert.deepEqual(created.headers, { accept: 'application/json' });
    assert.deepEqual(created.nested, { request: { headers: { keep: 'safe' } } });
    assert.deepEqual(persisted.headers, { accept: 'application/json' });
    assert.deepEqual(persisted.nested, { request: { headers: { keep: 'safe' } } });
});

test('persists catalog-discovered connection metadata without header-style API secrets', async () => {
    reset();
    const catalog = await import('../src/catalog.js');
    const discovered = await catalog.discoverCatalog({
        endpoint: 'https://api.example.test',
        contract: 'openai-images',
        fetch: async () => ({ ok: true, async json() {
            return { data: [{ id: 'gpt-image-1', 'x-api-key': 'leak', X_Api_Token: 'leak', apiKeyInstructions: 'safe prose' }] };
        } }),
    });

    const created = await store.createConnection({
        id: 'primary', catalogs: { latest: discovered }, selectedRoute: discovered.routes[0],
    });
    const persisted = extensionSettings.ur_image_studio.imageConnections.connections[0];

    assert.equal(created.catalogs.latest.models[0]['x-api-key'], undefined);
    assert.equal(created.catalogs.latest.models[0].X_Api_Token, undefined);
    assert.equal(created.catalogs.latest.models[0].apiKeyInstructions, 'safe prose');
    assert.equal(persisted.catalogs.latest.models[0]['x-api-key'], undefined);
    assert.equal(persisted.catalogs.latest.models[0].X_Api_Token, undefined);
    assert.equal(persisted.catalogs.latest.routes[0]['x-api-key'], undefined);
    assert.equal(persisted.catalogs.latest.routes[0].X_Api_Token, undefined);
    assert.equal(persisted.catalogs.latest.models[0].apiKeyInstructions, 'safe prose');
});

test('updates and deletes shared connection metadata by id', async () => {
    reset();
    await store.createConnection({ id: 'primary', name: 'Before' });

    const updated = await store.updateConnection('primary', { name: 'After', apiKey: 'never-shared' });
    assert.equal(updated.name, 'After');
    assert.equal(updated.apiKey, undefined);
    assert.equal((await store.getConnection('primary')).name, 'After');

    assert.equal(await store.deleteConnection('primary'), true);
    assert.deepEqual(await store.listConnections(), []);
    assert.equal(saveCalls, 3);
});

test('normal browser connection APIs hide server-owned records', async () => {
    reset();
    await store.createConnection({ id: 'browser', name: 'Browser' });
    extensionSettings.ur_image_studio.imageConnections.connections.push({
        id: 'server', name: 'Old server', executionOwner: 'server', kind: 'server-image',
    });

    assert.deepEqual((await store.listConnections()).map(connection => connection.id), ['browser']);
    assert.equal(await store.getConnection('server'), null);
});

test('keeps connection API keys in browser-local storage and returns an empty value when absent', async () => {
    reset();

    assert.equal(await store.getConnectionApiKey('primary'), '');
    await store.setConnectionApiKey('primary', '  browser-key  ');
    assert.equal(await store.getConnectionApiKey('primary'), 'browser-key');
    assert.equal(extensionSettings.ur_image_studio, undefined);

    await store.clearConnectionApiKey('primary');
    assert.equal(await store.getConnectionApiKey('primary'), '');
});


test('propagates browser-local key storage failures', async () => {
    reset();
    const original = SillyTavern.libs.localforage.getItem;
    SillyTavern.libs.localforage.getItem = async () => { throw new Error('storage read failed'); };
    await assert.rejects(() => store.getConnectionApiKey('primary'), /storage read failed/);
    SillyTavern.libs.localforage.getItem = original;
});

test('propagates browser-local key write and removal failures', async () => {
    reset();
    const originalSet = SillyTavern.libs.localforage.setItem;
    const originalRemove = SillyTavern.libs.localforage.removeItem;
    SillyTavern.libs.localforage.setItem = async () => { throw new Error('storage write failed'); };
    await assert.rejects(() => store.setConnectionApiKey('primary', 'key'), /storage write failed/);
    SillyTavern.libs.localforage.setItem = originalSet;
    SillyTavern.libs.localforage.removeItem = async () => { throw new Error('storage remove failed'); };
    await assert.rejects(() => store.clearConnectionApiKey('primary'), /storage remove failed/);
    SillyTavern.libs.localforage.removeItem = originalRemove;
});
