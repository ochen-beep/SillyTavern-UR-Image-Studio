// @ts-check
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const localforageCalls = [];
const extensionSettings = {};
const keyStore = new Map();
let settingsSaveCalls = 0;

globalThis.SillyTavern = {
    getContext: () => ({
        extensionSettings,
        saveSettingsDebounced: () => { settingsSaveCalls += 1; },
    }),
    libs: { localforage: {
        getItem: async key => { localforageCalls.push(['getItem', key]); return keyStore.get(key) ?? null; },
        setItem: async (key, value) => { localforageCalls.push(['setItem', key, value]); keyStore.set(key, value); },
        removeItem: async key => { localforageCalls.push(['removeItem', key]); keyStore.delete(key); },
    } },
};

const connections = await import('../src/connections.js');

beforeEach(() => {
    for (const key of Object.keys(extensionSettings)) delete extensionSettings[key];
    localforageCalls.length = 0;
    keyStore.clear();
    settingsSaveCalls = 0;
});

function route(apiFamily = 'openai-images') {
    return {
        id: 'route-1', source: 'manual', modelId: 'image-model', apiFamily,
        capabilities: { generate: 'supported', references: 'supported', edit: 'unknown' },
    };
}

test('normalizes shared image connections into a browser-owned projection', () => {
    const projection = connections.normalizeServerProjection({
        id: 'connection-1', kind: 'image', name: 'Primary', selectedRoute: route(),
        apiKey: 'must-not-leak', referenceOptions: { mode: 'custom', protocol: 'inline-data', maxRefs: 99 },
    });

    assert.equal(projection.executionOwner, 'legacy-browser');
    assert.equal(projection.apiType, 'openai-images');
    assert.deepEqual(projection.model, { id: 'image-model', source: 'list' }, 'legacy route modelId projects to the v2 object shape');
    assert.equal(projection.apiKey, 'must-not-leak', 'the normalizer is a compatibility projection only');
    assert.deepEqual(projection.referenceOptions, { mode: 'custom', protocol: 'inline-data', maxRefs: 64 });
    assert.equal(connections.isServerOwnedConnection(projection), false);
});

test('an explicit v2 model object wins over a stale legacy route', () => {
    const projection = connections.normalizeServerProjection({
        id: 'connection-1', kind: 'image',
        selectedRoute: route(), // stale legacy route says image-model
        model: { id: 'gpt-image-2', source: 'list' },
    });
    assert.deepEqual(projection.model, { id: 'gpt-image-2', source: 'list' });
});

test('a bare model string (oldest records) projects to the v2 object shape', () => {
    const projection = connections.normalizeServerProjection({
        id: 'connection-1', kind: 'image', model: 'gemini-3.1-flash-image',
    });
    assert.deepEqual(projection.model, { id: 'gemini-3.1-flash-image', source: 'list' });
});

test('shared image connection CRUD persists safe metadata without server requests', async () => {
    const created = await connections.createConnection({
        id: 'primary', name: 'Created', endpoint: 'https://created.test/', modelRoute: route(), apiKey: 'browser-only',
    });

    assert.equal(created.executionOwner, 'legacy-browser');
    assert.deepEqual((await connections.listImageConnections()).map(item => item.id), ['primary']);
    assert.equal(extensionSettings.ur_image_studio.imageConnections.connections[0].apiKey, undefined);
    assert.equal(extensionSettings.ur_image_studio.imageConnections.connections[0].modelRoute.id, 'route-1');

    const updated = await connections.saveConnection({ id: created.id, name: 'Updated', apiKey: 'still-not-shared' });
    assert.equal(updated.name, 'Updated');
    assert.equal(extensionSettings.ur_image_studio.imageConnections.connections[0].apiKey, undefined);

    assert.equal(await connections.deleteConnection(created.id), true);
    assert.deepEqual(await connections.listConnections(), []);
    assert.equal(settingsSaveCalls, 3);
});

test('resolveConnection reads only the current browser API key', async () => {
    await connections.createConnection({ id: 'primary', name: 'Primary' });
    keyStore.set('uris_api_key:primary', 'browser-key');

    const resolved = await connections.resolveConnection('primary');

    assert.equal(resolved.conn.id, 'primary');
    assert.equal(resolved.apiKey, 'browser-key');
    assert.equal(resolved.conn.apiKey, undefined);
    assert.deepEqual(localforageCalls, [['getItem', 'uris_api_key:primary']]);
});
