// @ts-check
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    LF_API_KEY, LF_GALLERY_PREFIX,
    LF_GENERATION_DRAFT_PREFIX, LF_HISTORY_PREFIX, LF_IMAGE_PARAMS,
    LF_REFS_FOLDERS, LF_REFS_POOL, LF_TEMPLATES,
    LF_TEXT_PARAMS, META_KEY, MODULE_NAME, IMAGE_CONNECTION_KEY_PREFIX,
} from '../src/core.js';

const memoryStore = new Map();
let chatId = null;
let chatMetadata = {};
let extensionSettings = {};
let settingsContainer = {};

const localforage = {
    async keys() { return [...memoryStore.keys()]; },
    async getItem(key) { return memoryStore.has(key) ? memoryStore.get(key) : null; },
    async setItem(key, value) { memoryStore.set(key, value); },
    async removeItem(key) { memoryStore.delete(key); },
};

globalThis.SillyTavern = {
    getContext: () => ({
        extensionSettings: settingsContainer,
        saveSettingsDebounced: () => {},
        saveMetadata: () => {},
        chatId,
        chatMetadata,
    }),
    libs: { localforage },
};

const {
    collectUrisKeys, exportUrisData, importUrisData, isExportableLfKey,
    isSecretLfKey, normalizeBackup, sanitizeBackupValue, summarizeBackup,
} = await import('../src/data-port.js');

function seed() {
    memoryStore.clear();
    chatId = null;
    chatMetadata = {};
    extensionSettings = { enabled: true };
    settingsContainer = { [MODULE_NAME]: extensionSettings };
    memoryStore.set(LF_API_KEY, 'custom-secret');
    memoryStore.set(IMAGE_CONNECTION_KEY_PREFIX + 'connection-1', 'image-connection-secret');
    memoryStore.set(LF_GALLERY_PREFIX + 'chat-1', [{ id: 'gallery-image' }]);
    memoryStore.set(LF_IMAGE_PARAMS, [{ ratio: '1:1' }]);
    memoryStore.set(LF_TEXT_PARAMS, [{ temperature: 0.5 }]);
    memoryStore.set(LF_TEMPLATES, [{ id: 'template-1' }]);
    memoryStore.set(LF_REFS_POOL, [{ id: 'ref-1' }]);
    memoryStore.set(LF_REFS_FOLDERS, [{ id: 'folder-1' }]);
    memoryStore.set(LF_HISTORY_PREFIX + 'chat-1', [{ prompt: 'history' }]);
    memoryStore.set('uris_instruction_chat-1', { draft: 'existing instruction' });
    memoryStore.set(LF_GENERATION_DRAFT_PREFIX + 'chat-1:1', { prompt: 'draft' });
    memoryStore.set('uris_unknown_runtime_key', { ignored: true });
}

beforeEach(seed);

test('v8 exports only allowlisted browser-owned client records', async () => {
    const backup = await exportUrisData();

    assert.equal(backup.version, 8);
    assert.deepEqual(backup.secrets, { excluded: true, excludedKeys: [LF_API_KEY] });
    assert.equal(Object.hasOwn(backup, 'imageConnections'), false);
    assert.equal(Object.hasOwn(backup.data.localforage, 'uris_connections'), false);
    assert.equal(Object.hasOwn(backup.data.localforage, 'uris_conn_key_legacy-image'), false);
    assert.equal(Object.hasOwn(backup.data.localforage, LF_API_KEY), false);
    assert.equal(Object.hasOwn(backup.data.localforage, IMAGE_CONNECTION_KEY_PREFIX + 'connection-1'), false);
    assert.equal(Object.hasOwn(backup.data.localforage, LF_GALLERY_PREFIX + 'chat-1'), false);
    assert.deepEqual(Object.keys(backup.data.localforage).sort(), [
        LF_IMAGE_PARAMS, LF_REFS_FOLDERS, LF_REFS_POOL, LF_TEMPLATES, LF_TEXT_PARAMS,
    ].sort());
});

test('only allowlisted client records are exportable and local API-key namespaces are secret', async () => {
    assert.equal(isSecretLfKey(LF_API_KEY), true);
    assert.equal(isSecretLfKey(IMAGE_CONNECTION_KEY_PREFIX + 'connection-1'), true);
    assert.equal(isSecretLfKey(LF_TEMPLATES), false);
    assert.equal(isExportableLfKey(LF_GALLERY_PREFIX + 'chat'), false);
    assert.equal(isExportableLfKey(LF_REFS_POOL), true);
    assert.deepEqual(await collectUrisKeys(), [
        LF_IMAGE_PARAMS, LF_TEXT_PARAMS, LF_TEMPLATES,
        LF_REFS_POOL, LF_REFS_FOLDERS,
    ]);
});

test('v8 normalization retains only supported client data and drops server templates', () => {
    const normalized = normalizeBackup({
        version: 7,
        module: MODULE_NAME,
        data: {
            localforage: {
                [LF_IMAGE_PARAMS]: [{ ratio: '2:3' }],
                unknown: [{ id: 'ignored' }],
            },
        },
        imageConnections: {
            server: [{ id: 'server-1', apiKey: 'must-not-leak' }],
        },
    });

    assert.equal(normalized.version, 8);
    assert.deepEqual(normalized.data.localforage, { [LF_IMAGE_PARAMS]: [{ ratio: '2:3' }] });
    assert.equal(Object.hasOwn(normalized, 'imageConnections'), false);
});

test('normalization rejects retired v2 through v5 backup formats', () => {
    for (const version of [2, 3, 4, 5]) {
        assert.throws(() => normalizeBackup({
            version,
            module: MODULE_NAME,
            keys: { [LF_IMAGE_PARAMS]: [{ ratio: '2:3' }] },
            data: { localforage: { [LF_IMAGE_PARAMS]: [{ ratio: '2:3' }] } },
        }), /Unsupported backup version: /);
    }
});

test('normalization migrates a v6 backup (two releases behind) forward to v8', () => {
    const normalized = normalizeBackup({
        version: 6,
        module: MODULE_NAME,
        data: { localforage: {}, chatMetadata: {} },
    });
    assert.equal(normalized.version, 8);
    assert.equal(normalized.module, MODULE_NAME);
});

test('normalization rejects a backup from a newer version', () => {
    assert.throws(() => normalizeBackup({
        version: 9, module: MODULE_NAME, data: { localforage: {} },
    }), /newer version/);
});

test('normalization rejects a v6 backup without the current data envelope', () => {
    assert.throws(() => normalizeBackup({
        version: 7,
        module: MODULE_NAME,
        keys: { [LF_IMAGE_PARAMS]: [{ ratio: '2:3' }] },
    }), /Invalid data section/);
});

test('normalization retains only schema-v4 chat metadata in a v6 backup', () => {
    const normalized = normalizeBackup({
        version: 7,
        module: MODULE_NAME,
        data: {
            localforage: {},
            chatMetadata: {
                valid: { schemaVersion: 4, config: { imageProfileId: 'server-1' }, refs: {} },
                legacy: { schemaVersion: 3, config: { imageProfileId: 'old-server' }, refs: {} },
                malformed: 'not-a-binding',
            },
        },
    });

    assert.deepEqual(normalized.data.chatMetadata, {
        valid: { schemaVersion: 4, config: { imageProfileId: 'server-1' }, refs: {} },
    });
});

test('import ignores invalid chat metadata without writing it', async () => {
    chatId = 'chat-1';
    chatMetadata = { [META_KEY]: { schemaVersion: 4, config: { imageProfileId: 'existing' }, refs: {} } };

    const result = await importUrisData({
        version: 7,
        module: MODULE_NAME,
        data: {
            localforage: {},
            chatMetadata: { 'chat-1': { schemaVersion: 3, config: {}, refs: {} } },
        },
        imageConnections: { server: [] },
    });

    assert.deepEqual(chatMetadata[META_KEY], { schemaVersion: 4, config: { imageProfileId: 'existing' }, refs: {} });
    assert.equal(result.importedChatBindings, 0);
});
test('import writes only allowlisted client records and excludes secrets', async () => {
    chatId = 'chat-1';
    const forgedImageKey = IMAGE_CONNECTION_KEY_PREFIX + 'forged';
    const backup = {
        version: 7,
        module: MODULE_NAME,
        data: {
            localforage: {
                [LF_TEXT_PARAMS]: [{ temperature: 0.2 }],
                'uris_instruction_chat-1': { draft: 'legacy instruction' },
                unknown: [{ id: 'ignored' }],
                [LF_API_KEY]: 'injected-custom-secret',
                [forgedImageKey]: 'injected-image-connection-secret',
            },
            chatMetadata: {
                'chat-1': { schemaVersion: 4, config: { imageProfileId: 'old-server' }, refs: {} },
            },
        },
        imageConnections: { server: [] },
    };

    const normalized = normalizeBackup(backup);
    const result = await importUrisData(backup);

    assert.equal(Object.hasOwn(normalized.data.localforage, LF_API_KEY), false);
    assert.equal(Object.hasOwn(normalized.data.localforage, forgedImageKey), false);
    assert.deepEqual(await localforage.getItem(LF_TEXT_PARAMS), [{ temperature: 0.2 }]);
    assert.deepEqual(await localforage.getItem('uris_instruction_chat-1'), { draft: 'existing instruction' });
    assert.equal(memoryStore.has('unknown'), false);
    assert.equal(await localforage.getItem(LF_API_KEY), 'custom-secret');
    assert.equal(await localforage.getItem(forgedImageKey), null);
    assert.equal(result.importedKeys, 1);
});

test('replace removes only currently exportable localforage records', async () => {
    await importUrisData({
        version: 7,
        module: MODULE_NAME,
        data: { localforage: { [LF_IMAGE_PARAMS]: [{ ratio: '16:9' }] } },
        imageConnections: { server: [] },
    }, { mode: 'replace' });

    assert.deepEqual(await localforage.getItem(LF_IMAGE_PARAMS), [{ ratio: '16:9' }]);
    assert.equal(await localforage.getItem(LF_TEXT_PARAMS), null);
});

test('sanitizeBackupValue removes schema-normalized credential fields without changing input', () => {
    const source = {
        apiKey: 'secret',
        Authorization: 'Bearer secret',
        'credential-id': 'credential',
        access_token: 'access',
        refreshToken: 'refresh',
        PRIVATE_KEY: 'private',
        bearer_token: 'bearer',
        clientSecret: 'client',
        nested: [{ token: 'secret', value: 1 }],
        safe: true,
    };
    const sanitized = sanitizeBackupValue(source);
    assert.deepEqual(sanitized, { nested: [{ value: 1 }], safe: true });
    assert.equal(source.apiKey, 'secret');
    assert.equal(source.Authorization, 'Bearer secret');
});

test('summary ignores legacy server connection templates', () => {
    const summary = summarizeBackup({
        data: { localforage: { [LF_REFS_POOL]: [{ id: 'r1' }], [LF_REFS_FOLDERS]: [{ id: 'f1' }] } },
        imageConnections: { server: [{ id: 's1' }, { id: 's2' }] },
    });
    assert.equal(Object.hasOwn(summary, 'serverConnections'), false);
    assert.equal(Object.hasOwn(summary, 'connections'), false);
    assert.equal(summary.refs, 1);
    assert.equal(summary.folders, 1);
    assert.equal(summary.secretsIncluded, false);
});

// Регрессия v0.9.4: summarizeBackup читал только legacy localforage-ключи,
// хотя актуальные бэкапы несут коллекции в `shared` — диалог импорта показывал
// «Референсы: 0» для бэкапа, который их содержит.
test('summary counts shared collections and falls back to legacy localforage keys', () => {
    const modern = summarizeBackup({
        shared: {
            refs: [{ id: 'r1' }, { id: 'r2' }],
            folders: [{ id: 'f1' }],
            templates: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
            presets: [{ id: 'p1' }],
        },
        data: { localforage: {}, chatMetadata: {} },
    });
    assert.deepEqual(
        { refs: modern.refs, folders: modern.folders, templates: modern.templates },
        { refs: 2, folders: 1, templates: 3 },
    );

    const legacy = summarizeBackup({
        shared: {},
        data: {
            localforage: { [LF_REFS_POOL]: [{ id: 'r1' }], [LF_REFS_FOLDERS]: [{ id: 'f1' }], [LF_TEMPLATES]: [{ id: 't1' }] },
            chatMetadata: {},
        },
    });
    assert.deepEqual(
        { refs: legacy.refs, folders: legacy.folders, templates: legacy.templates },
        { refs: 1, folders: 1, templates: 1 },
    );
});

test('export includes the active chat binding only', async () => {
    chatId = 'chat-1';
    chatMetadata = {
        [META_KEY]: { schemaVersion: 4, config: { imageProfileId: 'server-1' }, refs: {} },
        unrelated: { ignored: true },
    };
    const backup = await exportUrisData();
    assert.deepEqual(backup.data.chatMetadata, {
        'chat-1': { schemaVersion: 4, config: { imageProfileId: 'server-1' }, refs: {} },
    });
});

test('v8 exports portable shared records without image bytes, recovery state, or secrets', async () => {
    extensionSettings = {
        imageConnections: {
            connections: [{ id: 'conn-1', apiKey: 'browser-secret', selectedRoute: { id: 'r1', apiFamily: 'openai' } }],
            templates: [{ id: 'template-1' }], presets: [{ id: 'preset-1' }],
            refs: [{ id: 'ref-1', dataUrl: 'data:image/png;base64,raw', imagePath: 'user/images/ref.png' }],
            folders: [{ id: 'folder-1' }], galleryIndex: [{ id: 'card-1', imageUrl: 'data:image/png;base64,raw', prompt: 'keep' }],
            pendingOperation: { id: 'pending' }, recovery: { id: 'recover' }, selectedRouteId: 'r1',
        },
        apiKey: 'custom-secret', recoveryState: { unsafe: true }, enabled: true,
    };
    settingsContainer[MODULE_NAME] = extensionSettings;

    const backup = await exportUrisData();

    assert.equal(backup.version, 8);
    assert.deepEqual(backup.shared.connections, [{ id: 'conn-1', selectedRoute: { id: 'r1', resolutionState: 'unresolved', unresolved: true }, selectedRouteId: 'r1' }]);
    assert.equal(backup.shared.galleryCards, undefined);
    assert.deepEqual(backup.shared.refs, [{ id: 'ref-1', imagePath: 'user/images/ref.png' }]);
    assert.equal(Object.hasOwn(backup.data.localforage, LF_GENERATION_DRAFT_PREFIX + 'chat-1:1'), false);
    assert.equal(Object.hasOwn(backup.data.localforage, LF_HISTORY_PREFIX + 'chat-1'), false);
    assert.equal(Object.hasOwn(backup.data.extensionSettings, 'imageConnections'), false);
    assert.equal(Object.hasOwn(backup.data.extensionSettings, 'recoveryState'), false);
});

test('v7 backup migrates connections to the derived-dialect read model (v8)', () => {
    const normalized = normalizeBackup({
        version: 7,
        module: MODULE_NAME,
        data: { localforage: {}, chatMetadata: {} },
        shared: {
            connections: [{
                id: 'legacy',
                name: 'Relay',
                endpoint: 'https://relay.example/v1',
                apiFamilyOverride: 'gemini-native',
                useCorsProxy: true,
                editProtocol: 'json',
                manualModelId: '',
                selectedRoute: { id: 'r1', modelId: 'gemini-3.1-flash-image', generationContract: 'gemini-native' },
                routes: [
                    { id: 'r1', modelId: 'gemini-3.1-flash-image' },
                    { id: 'r2', modelId: 'text-model' },
                ],
                apiKey: 'never-import',
            }],
            pluginSecrets: [{ secretId: 'blocked' }], recovery: { id: 'blocked' },
        },
    });

    assert.equal(normalized.version, 8);
    const [connection] = normalized.shared.connections;
    assert.deepEqual(connection.model, { id: 'gemini-3.1-flash-image', source: 'list' });
    assert.deepEqual(connection.detected, {
        apiShape: 'unknown', auth: 'unknown', delivery: 'proxy',
        modelIds: ['gemini-3.1-flash-image', 'text-model'], checkedAt: null,
    });
    assert.deepEqual(connection.overrides, { dialect: 'gemini-native', editProtocol: 'json', delivery: 'proxy' });
    assert.equal(connection.routes, undefined, 'discovered route catalogs are dropped');
    assert.equal(connection.selectedRoute, undefined, 'persisted route objects are dropped');
    assert.equal(connection.apiKey, undefined, 'secrets never survive the migration');
    assert.equal(Object.hasOwn(normalized.shared, 'pluginSecrets'), false);
    assert.equal(Object.hasOwn(normalized.shared, 'recovery'), false);
});

test('v7 backup migration prefers a hand-typed model id over the selected route', () => {
    const normalized = normalizeBackup({
        version: 7,
        module: MODULE_NAME,
        data: { localforage: {}, chatMetadata: {} },
        shared: { connections: [{ id: 'c', manualModelId: 'seedream-4-0', selectedRoute: { id: 'r1', modelId: 'other' } }] },
    });
    assert.deepEqual(normalized.shared.connections[0].model, { id: 'seedream-4-0', source: 'manual' });
});

test('backup normalization retains the first canonical-equivalent route descriptor', () => {
    const normalized = normalizeBackup({
        version: 8, module: MODULE_NAME,
        data: { localforage: {}, chatMetadata: {} },
        shared: { connections: [{
            id: 'one', selectedRouteId: 'backup-route', routes: [
                { id: 'first-route', generationContract: 'openai-images', source: ' catalog ', modelId: ' model ', label: 'Primary label' },
                { id: 'backup-route', generationContract: 'openai-images', source: 'catalog', modelId: 'model', label: 'Backup label' },
            ],
        }] },
    });

    const [connection] = normalized.shared.connections;
    assert.equal(connection.routes.length, 1);
    assert.equal(connection.routes[0].label, 'Primary label');
    assert.equal(connection.selectedRouteId, connection.routes[0].id);
    assert.equal(normalized.shared.selectedRouteId, undefined);
});

test('backup normalization rejects duplicate connection ids but deduplicates canonical route collisions', () => {
    const base = {
        version: 8, module: MODULE_NAME,
        data: { localforage: {}, chatMetadata: {} },
    };
    assert.throws(() => normalizeBackup({
        ...base,
        shared: { connections: [{ id: 'same' }, { id: 'same' }] },
    }), /duplicate connection id/i);
    assert.deepEqual(normalizeBackup({
        ...base,
        shared: { connections: [{ id: 'one', routes: [
            { generationContract: 'openai-images', source: 'catalog', modelId: 'model' },
            { id: 'forged', generationContract: 'openai-images', source: ' catalog ', modelId: ' model ' },
        ] }] },
    }).shared.connections[0].routes.length, 1);
});

test('backup normalization reconciles a legacy selected route id to its canonical route identity', () => {
    const normalized = normalizeBackup({
        version: 8, module: MODULE_NAME,
        data: { localforage: {}, chatMetadata: {} },
        shared: { selectedRouteId: 'legacy-id', connections: [{
            id: 'one', selectedRouteId: 'legacy-id', routes: [{
                id: 'legacy-id', generationContract: 'openai-images', source: 'catalog', modelId: 'model',
            }],
        }] },
    });
    const routeId = normalized.shared.connections[0].routes[0].id;
    assert.match(routeId, /^route_[a-f0-9]{24}$/);
    assert.equal(normalized.shared.connections[0].selectedRouteId, routeId);
    assert.equal(normalized.shared.selectedRouteId, routeId);
});

test('normalization produces runtime-valid route contracts or explicit unresolved routes', () => {
    const normalized = normalizeBackup({
        version: 8, module: MODULE_NAME,
        data: { localforage: {}, chatMetadata: {} },
        shared: { connections: [{ id: 'c', routes: [
            { id: 'valid-openrouter', generationContract: 'openrouter-images', apiFamily: 'openrouter-images', modelId: 'dall-e', source: 'openrouter' },
            { id: 'valid-chat', generationContract: 'chat-completions', model: 'gpt-image' },
            { id: 'invalid', generationContract: 'not-a-contract' },
            { id: 'conflict', generationContract: 'openai-images', apiFamily: 'gemini-native' },
            { id: 'missing' },
        ] }] },
    });
    const routes = normalized.shared.connections[0].routes;
    assert.equal(routes[0].generationContract, 'openrouter-images');
    assert.equal(routes[0].modelId, 'dall-e');
    assert.deepEqual(routes[0].transport, { bodyKind: 'json', proxyEligible: false, directCors: 'preferred' });
    assert.equal(routes[1].generationContract, 'chat-completions');
    assert.equal(routes[1].modelId, 'gpt-image');
    assert.equal(routes[2].resolutionState, 'unresolved');
    assert.equal(routes[3].resolutionState, 'unresolved');
    assert.equal(routes[4].resolutionState, 'unresolved');
});

test('normalization accepts contract and contractId route aliases', () => {
    const normalized = normalizeBackup({
        version: 8, module: MODULE_NAME,
        data: { localforage: {}, chatMetadata: {} },
        shared: { connections: [{ id: 'c', routes: [
            { id: 'contract-alias', contract: 'openai', modelId: 'dall-e' },
            { id: 'contract-id-alias', contractId: 'gemini-native', modelId: 'imagen-3' },
        ] }] },
    });
    const routes = normalized.shared.connections[0].routes;
    assert.equal(routes[0].generationContract, 'openai-images');
    assert.equal(routes[0].apiFamily, 'openai-images');
    assert.equal(Object.hasOwn(routes[0], 'contract'), false);
    assert.equal(routes[1].generationContract, 'gemini-native');
    assert.equal(routes[1].apiFamily, 'gemini-native');
    assert.equal(Object.hasOwn(routes[1], 'contractId'), false);
});

test('normalization accepts canonical-equivalent route aliases and a sole apiFamily alias', () => {
    const normalized = normalizeBackup({
        version: 8, module: MODULE_NAME,
        data: { localforage: {}, chatMetadata: {} },
        shared: { connections: [{ id: 'c', routes: [
            { id: 'equivalent-aliases', generationContract: 'openai-images', apiFamily: 'openai', contractId: 'openai-images', modelId: 'dall-e' },
            { id: 'api-family-only', apiFamily: 'gemini', modelId: 'imagen-3' },
            { id: 'invalid-contract-id', contractId: 'not-a-contract', modelId: 'dall-e' },
        ] }] },
    });
    const routes = normalized.shared.connections[0].routes;
    assert.equal(routes[0].generationContract, 'openai-images');
    assert.equal(routes[0].apiFamily, 'openai-images');
    assert.equal(routes[1].generationContract, 'gemini-native');
    assert.equal(routes[1].apiFamily, 'gemini-native');
    assert.equal(routes[2].resolutionState, 'unresolved');
    assert.equal(routes[2].unresolved, true);
});

test('normalization filters schema-normalized credentials from every portable input path', () => {
    const normalized = normalizeBackup({
        version: 8, module: MODULE_NAME,
        data: {
            localforage: { [LF_IMAGE_PARAMS]: { Authorization: 'Bearer local', safe: true } },
            extensionSettings: { 'client-secret': 'settings', safe: true },
            chatMetadata: { chat: { schemaVersion: 4, accessToken: 'chat', safe: true } },
        },
        shared: {
            connections: [{ id: 'c', refresh_token: 'shared', selectedRoute: { id: 'r', generationContract: 'openai-images', modelId: 'dall-e', privateKey: 'route', safe: true } }],
        },
        imageConnections: { server: [{ id: 'server', bearerToken: 'server', safe: true }] },
    });

    assert.deepEqual(normalized.data.localforage[LF_IMAGE_PARAMS], { safe: true });
    assert.deepEqual(normalized.data.extensionSettings, { safe: true });
    assert.deepEqual(normalized.data.chatMetadata.chat, { schemaVersion: 4, safe: true });
    assert.deepEqual(normalized.shared.connections, [{ id: 'c', selectedRoute: {
        id: 'route_b85ee038faf331a99ab04c2e', generationContract: 'openai-images', modelId: 'dall-e', source: 'unknown', contractVersion: 1,
        apiFamily: 'openai-images', capabilities: { generate: 'unknown', references: 'unknown', edit: 'unknown' },
        transport: { bodyKind: 'json', proxyEligible: false, directCors: 'preferred' }, safe: true,
    }, selectedRouteId: 'route_b85ee038faf331a99ab04c2e' }]);
    assert.equal(Object.hasOwn(normalized, 'imageConnections'), false);
});

test('import rollback removes a newly-created allowlisted record when a later write fails', async () => {
    chatId = 'chat-1';
    memoryStore.delete(LF_REFS_POOL);
    chatMetadata = { [META_KEY]: { schemaVersion: 4, config: { imageProfileId: 'before' }, refs: {} } };
    const previousBinding = chatMetadata[META_KEY];
    const originalContext = globalThis.SillyTavern.getContext;
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings: settingsContainer,
        saveSettingsDebounced: () => {},
        saveMetadata: () => { throw new Error('metadata save failed'); },
        chatId,
        chatMetadata,
    });

    try {
        await assert.rejects(() => importUrisData({
            version: 7, module: MODULE_NAME,
            data: {
                localforage: { [LF_REFS_POOL]: [{ id: 'incoming-ref' }] },
                chatMetadata: { 'chat-1': { schemaVersion: 4, config: { imageProfileId: 'after' }, refs: {} } },
            },
            imageConnections: { server: [] },
        }), /metadata save failed/);
    } finally {
        globalThis.SillyTavern.getContext = originalContext;
    }

    assert.equal(memoryStore.has(LF_REFS_POOL), false);
    assert.deepEqual(chatMetadata[META_KEY], previousBinding);
});

test('import rollback restores a preexisting LF record overwritten by merge', async () => {
    const beforeRefs = await localforage.getItem(LF_REFS_POOL);
    const originalSetItem = localforage.setItem;
    localforage.setItem = async (key, value) => {
        await originalSetItem(key, value);
        if (key === LF_REFS_POOL) throw new Error('later LF write failed');
    };
    try {
        await assert.rejects(() => importUrisData({
            version: 7, module: MODULE_NAME,
            data: { localforage: { [LF_REFS_POOL]: [{ id: 'incoming-ref' }] }, chatMetadata: {} },
            imageConnections: { server: [] },
        }), /later LF write failed/);
    } finally {
        localforage.setItem = originalSetItem;
    }
    assert.deepEqual(await localforage.getItem(LF_REFS_POOL), beforeRefs);
});

test('import rollback restores all records removed by replace before a later write failure', async () => {
    const originalSetItem = localforage.setItem;
    const beforeText = await localforage.getItem(LF_TEXT_PARAMS);
    const beforeTemplates = await localforage.getItem(LF_TEMPLATES);
    localforage.setItem = async (key, value) => {
        await originalSetItem(key, value);
        if (key === LF_REFS_POOL) throw new Error('later LF write failed');
    };
    try {
        await assert.rejects(() => importUrisData({
            version: 7, module: MODULE_NAME,
            data: { localforage: { [LF_REFS_POOL]: [{ id: 'incoming-ref' }] }, chatMetadata: {} },
            imageConnections: { server: [] },
        }, { mode: 'replace' }), /later LF write failed/);
    } finally {
        localforage.setItem = originalSetItem;
    }
    assert.deepEqual(await localforage.getItem(LF_TEXT_PARAMS), beforeText);
    assert.deepEqual(await localforage.getItem(LF_TEMPLATES), beforeTemplates);
});

test('import rollback restores exact detached extension settings after a later failure', async () => {
    const originalSettings = {
        enabled: true,
        apiKey: 'must-stay-local',
        recoveryState: { requestId: 'r1' },
        imageConnections: { pendingOperation: { id: 'p1' }, templates: [{ id: 'before' }] },
    };
    settingsContainer[MODULE_NAME] = originalSettings;
    const originalSetItem = localforage.setItem;
    localforage.setItem = async (key, value) => {
        await originalSetItem(key, value);
        if (key === LF_REFS_POOL) throw new Error('later LF write failed');
    };
    try {
        await assert.rejects(() => importUrisData({
            version: 7, module: MODULE_NAME,
            data: {
                localforage: { [LF_REFS_POOL]: [{ id: 'incoming-ref' }] },
                extensionSettings: { enabled: false },
                chatMetadata: {},
            },
            shared: { templates: [{ id: 'incoming-template' }] },
            imageConnections: { server: [] },
        }), /later LF write failed/);
    } finally {
        localforage.setItem = originalSetItem;
    }
    assert.deepEqual(settingsContainer[MODULE_NAME], originalSettings);
    assert.notStrictEqual(settingsContainer[MODULE_NAME], originalSettings);
});

test('import surfaces a rollback failure with the original import error as cause', async () => {
    const originalSetItem = localforage.setItem;
    localforage.setItem = async (key, value) => {
        if (key === LF_REFS_POOL && Array.isArray(value) && value[0]?.id === 'incoming-ref') {
            throw new Error('import write failed');
        }
        if (key === LF_IMAGE_PARAMS) throw new Error('rollback set failed');
        await originalSetItem(key, value);
    };
    try {
        await assert.rejects(
            () => importUrisData({
                version: 7, module: MODULE_NAME,
                data: { localforage: { [LF_REFS_POOL]: [{ id: 'incoming-ref' }] }, chatMetadata: {} },
                imageConnections: { server: [] },
            }),
            error => error.name === 'ImportRollbackError'
                && /Rollback failed/.test(error.message)
                && error.cause?.message === 'import write failed'
                && error.rollbackErrors?.some(entry => entry.key === LF_IMAGE_PARAMS && entry.operation === 'setItem')
        );
    } finally {
        localforage.setItem = originalSetItem;
    }
});

test('normalization sanitizes extension settings, chat metadata, and server inputs', () => {
    const normalized = normalizeBackup({
        version: 7, module: MODULE_NAME,
        data: {
            localforage: {},
            extensionSettings: { draft: { payload: { rawBytes: [1], dataUrl: 'data:image/png;base64,x' } } },
            chatMetadata: { chat: { schemaVersion: 4, requestJournal: [{ payload: { imageBytes: [2] } }], safe: true } },
        },
        imageConnections: { server: [{ id: 's', requestPayload: { base64: 'secret' }, rawBytes: [3], safe: true }] },
    });
    assert.deepEqual(normalized.data.extensionSettings, { draft: { payload: {} } });
    assert.deepEqual(normalized.data.chatMetadata.chat, { schemaVersion: 4, safe: true });
    assert.equal(Object.hasOwn(normalized, 'imageConnections'), false);
});

test('imports shared data without extension settings, including settings-free snapshots', async () => {
    settingsContainer = {};
    await importUrisData({
        version: 7, module: MODULE_NAME,
        data: { localforage: {}, extensionSettings: null, chatMetadata: {} },
        shared: { templates: [{ id: 'portable-template' }] },
        imageConnections: { server: [] },
    });
    assert.deepEqual(settingsContainer[MODULE_NAME]?.imageConnections, { templates: [{ id: 'portable-template' }] });
});

test('merge mode unions refs/folders/templates/presets/connections by id instead of replacing', async () => {
    seed();
    extensionSettings.imageConnections = {
        refs: [{ id: 'ref-existing', name: 'Existing' }],
        folders: [{ id: 'folder-existing', name: 'Existing folder', color: '#4a90d9', order: 0 }],
        templates: [{ id: 'tpl-existing', name: 'Existing tpl', type: 'instruction', instruction: 'a' }],
        presets: [{ id: 'preset-existing', name: 'Existing preset' }],
        connections: [{ id: 'conn-existing', name: 'Existing conn' }],
        catalogs: { keep: true },
    };

    await importUrisData({
        version: 7, module: MODULE_NAME,
        data: { localforage: {}, extensionSettings: null, chatMetadata: {} },
        shared: {
            refs: [{ id: 'ref-new', name: 'New' }, { id: 'ref-existing', name: 'Override' }],
            folders: [{ id: 'folder-new', name: 'New folder', color: '#d97f3a', order: 0 }],
            templates: [{ id: 'tpl-new', name: 'New tpl', type: 'instruction', instruction: 'b' }],
            presets: [{ id: 'preset-new', name: 'New preset' }],
            connections: [{ id: 'conn-new', name: 'New conn' }],
        },
    }, { mode: 'merge' });

    const ic = settingsContainer[MODULE_NAME].imageConnections;
    assert.deepEqual(ic.refs.map(r => r.id).sort(), ['ref-existing', 'ref-new']);
    assert.equal(ic.refs.find(r => r.id === 'ref-existing').name, 'Override', 'incoming overrides same id');
    assert.deepEqual(ic.folders.map(f => f.id).sort(), ['folder-existing', 'folder-new']);
    assert.deepEqual(ic.templates.map(t => t.id).sort(), ['tpl-existing', 'tpl-new']);
    assert.deepEqual(ic.presets.map(p => p.id).sort(), ['preset-existing', 'preset-new']);
    assert.deepEqual(ic.connections.map(c => c.id).sort(), ['conn-existing', 'conn-new']);
    assert.deepEqual(ic.catalogs, { keep: true }, 'non-collection fields preserved');
});

test('snapshot is completed before server import is attempted', async () => {
    let serverImportAttempted = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { serverImportAttempted = true; throw new Error('server should not be called'); };
    const originalGetItem = localforage.getItem;
    localforage.getItem = async () => { throw new Error('snapshot failed'); };
    try {
        await assert.rejects(() => importUrisData({
            version: 7, module: MODULE_NAME,
            data: { localforage: {}, extensionSettings: null, chatMetadata: {} },
            imageConnections: { server: [{ id: 's' }] },
        }), /snapshot failed/);
    } finally {
        localforage.getItem = originalGetItem;
        globalThis.fetch = originalFetch;
    }
    assert.equal(serverImportAttempted, false);
});

test('replace removes the current chat binding when the backup has no binding', async () => {
    chatId = 'chat-1';
    chatMetadata = { [META_KEY]: { schemaVersion: 4, config: { imageProfileId: 'existing' }, refs: {} } };

    await importUrisData({
        version: 7, module: MODULE_NAME,
        data: { localforage: {}, chatMetadata: {} },
        imageConnections: { server: [] },
    }, { mode: 'replace' });

    assert.equal(Object.hasOwn(chatMetadata, META_KEY), false);
});

test('replace rollback restores the deleted current chat binding when metadata persistence fails', async () => {
    chatId = 'chat-1';
    chatMetadata = { [META_KEY]: { schemaVersion: 4, config: { imageProfileId: 'existing' }, refs: {} } };
    const originalBinding = chatMetadata[META_KEY];
    const originalContext = globalThis.SillyTavern.getContext;
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings: settingsContainer,
        saveSettingsDebounced: () => {},
        saveMetadata: () => { throw new Error('metadata save failed'); },
        chatId,
        chatMetadata,
    });
    try {
        await assert.rejects(() => importUrisData({
            version: 7, module: MODULE_NAME,
            data: { localforage: {}, chatMetadata: {} },
            imageConnections: { server: [] },
        }, { mode: 'replace' }), /metadata save failed/);
    } finally {
        globalThis.SillyTavern.getContext = originalContext;
    }
    assert.deepEqual(chatMetadata[META_KEY], originalBinding);
});

test('rollback restores a detached chat binding after the live binding mutates', async () => {
    chatId = 'chat-1';
    chatMetadata = { [META_KEY]: { schemaVersion: 4, config: { imageProfileId: 'before' }, refs: {} } };
    const originalSetItem = localforage.setItem;
    localforage.setItem = async (key, value) => {
        await originalSetItem(key, value);
        if (key === LF_REFS_POOL) throw new Error('later LF write failed');
    };
    try {
        await assert.rejects(() => importUrisData({
            version: 7, module: MODULE_NAME,
            data: {
                localforage: { [LF_REFS_POOL]: [{ id: 'incoming-ref' }] },
                chatMetadata: { 'chat-1': { schemaVersion: 4, config: { imageProfileId: 'after' }, refs: {} } },
            },
            imageConnections: { server: [] },
        }), /later LF write failed/);
    } finally {
        localforage.setItem = originalSetItem;
    }
    assert.deepEqual(chatMetadata[META_KEY], { schemaVersion: 4, config: { imageProfileId: 'before' }, refs: {} });
});

test('rollback removes dynamically-created exportable localforage keys absent from snapshot', async () => {
    const dynamicKey = LF_TEXT_PARAMS;
    memoryStore.delete(dynamicKey);
    const originalSetItem = localforage.setItem;
    localforage.setItem = async (key, value) => {
        await originalSetItem(key, value);
        if (key === LF_REFS_POOL) {
            await originalSetItem(dynamicKey, { id: 'created-during-import' });
            throw new Error('later LF write failed');
        }
    };
    try {
        await assert.rejects(() => importUrisData({
            version: 7, module: MODULE_NAME,
            data: { localforage: { [LF_REFS_POOL]: [{ id: 'incoming-ref' }] }, chatMetadata: {} },
            imageConnections: { server: [] },
        }), /later LF write failed/);
    } finally {
        localforage.setItem = originalSetItem;
    }
    assert.equal(memoryStore.has(dynamicKey), false);
});

test('rollback aggregates browser-local storage, settings, and chat metadata failures', async () => {
    const originalSetItem = localforage.setItem;
    localforage.setItem = async (key, value) => {
        if (key === LF_IMAGE_PARAMS) throw new Error('rollback localforage failed');
        if (key === LF_REFS_POOL && Array.isArray(value) && value[0]?.id === 'incoming-ref') {
            throw new Error('import write failed');
        }
        await originalSetItem(key, value);
    };
    const originalContext = globalThis.SillyTavern.getContext;
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings: settingsContainer,
        saveSettingsDebounced: () => { throw new Error('rollback settings failed'); },
        saveMetadata: () => { throw new Error('rollback chat metadata failed'); },
        chatId: 'chat-1',
        chatMetadata: { [META_KEY]: { schemaVersion: 4, config: { imageProfileId: 'before' }, refs: {} } },
    });
    try {
        await assert.rejects(
            () => importUrisData({
                version: 7, module: MODULE_NAME,
                data: { localforage: { [LF_REFS_POOL]: [{ id: 'incoming-ref' }] }, chatMetadata: {} },
            }),
            error => error.name === 'ImportRollbackError'
                && error.cause?.message === 'import write failed'
                && error.rollbackErrors?.some(entry => entry.source === 'localforage' && entry.cause?.message === 'rollback localforage failed')
                && error.rollbackErrors?.some(entry => entry.source === 'settings' && entry.cause?.message === 'rollback settings failed')
                && error.rollbackErrors?.some(entry => entry.source === 'chatMetadata' && entry.cause?.message === 'rollback chat metadata failed')
                && !error.rollbackErrors?.some(entry => entry.source === 'server')
        );
    } finally {
        localforage.setItem = originalSetItem;
        globalThis.SillyTavern.getContext = originalContext;
    }
});
