// @ts-check
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function makeInMemoryLFA() {
    const store = new Map();
    return {
        getItem: async (k) => (store.has(k) ? store.get(k) : null),
        setItem: async (k, v) => { store.set(k, v); },
        removeItem: async (k) => { store.delete(k); },
        keys: async () => Array.from(store.keys()),
        _store: store,
    };
}

let lfMock;
let chatMetadata;
let core;
let chatBinding;

beforeEach(async () => {
    lfMock = makeInMemoryLFA();
    chatMetadata = {};
    globalThis.SillyTavern = {
        libs: { localforage: lfMock },
        getContext: () => ({
            extensionSettings: {},
            chatMetadata,
            chatId: 'chat-1',
            saveMetadata: () => {},
            saveSettingsDebounced: () => {},
            getRequestHeaders: () => ({}),
        }),
    };
    core = await import('../src/core.js');
    core.state.settings = {};
    core.state.activeImageProfileId = null;
    core.state.activeTemplateId = null;
    chatBinding = await import('../src/chat-binding.js');
});

const META_KEY = 'uris_binding';

const DEFAULT_SCHEMA_V5 = Object.freeze({
    schemaVersion: 5,
    config: Object.freeze({
        imageProfileId: null,
        templateId: null,
        generationDefaults: { modelId: null, aspectRatio: null, imageSize: null, quality: null },
        automationMode: 'manual',
        generationFlow: 'ai-only',
    }),
    refs: Object.freeze({
        referenceIds: [],
        folderIds: [],
    }),
});

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

test('createDefaultChatConfig returns schema-v5 fixed defaults', () => {
    assert.ok(chatBinding.createDefaultChatConfig, 'createDefaultChatConfig is exported');
    const def = chatBinding.createDefaultChatConfig();
    assert.deepEqual(def, DEFAULT_SCHEMA_V5);
    assert.deepEqual(def.config, DEFAULT_SCHEMA_V5.config);
    assert.deepEqual(def.refs, DEFAULT_SCHEMA_V5.refs);
});

test('normalizeChatBinding returns schema-v5 for a missing binding', () => {
    assert.ok(chatBinding.normalizeChatBinding, 'normalizeChatBinding is exported');
    const normalized = chatBinding.normalizeChatBinding(null);
    assert.equal(normalized.schemaVersion, 5);
    assert.deepEqual(normalized.config, DEFAULT_SCHEMA_V5.config);
    assert.deepEqual(normalized.refs, DEFAULT_SCHEMA_V5.refs);
});

test('normalizeChatBinding drops retired fields while preserving valid config and refs', () => {
    const input = {
        schemaVersion: 4,
        config: {
            imageProfileId: 'img-1',
            templateId: 'tpl-1',
            automationMode: 'full-pipeline',
            generationFlow: 'user-only',
            characterIds: ['retired-character'],
            galleryMode: 'st-only',
            copyToStGallery: true,
        },
        refs: {
            referenceIds: ['ref-1', 'ref-2'],
        },
    };
    const normalized = chatBinding.normalizeChatBinding(deepClone(input));
    assert.equal(normalized.schemaVersion, 5);
    assert.equal(normalized.config.imageProfileId, 'img-1');
    assert.equal(normalized.config.templateId, 'tpl-1');
    assert.equal(normalized.config.automationMode, 'full-pipeline');
    assert.equal(normalized.config.generationFlow, 'user-only');
    assert.equal(Object.hasOwn(normalized.config, 'characterIds'), false);
    assert.equal(Object.hasOwn(normalized.config, 'galleryMode'), false);
    assert.equal(Object.hasOwn(normalized.config, 'copyToStGallery'), false);
    assert.deepEqual(normalized.refs, { ...input.refs, folderIds: [] });
});

test('loadChatConfig creates schema-v5 defaults for a new chat and persists to chat only', async () => {
    assert.ok(chatBinding.loadChatConfig, 'loadChatConfig is exported');
    const cfg = await chatBinding.loadChatConfig();
    assert.equal(cfg.schemaVersion, 5);
    assert.deepEqual(cfg.config, DEFAULT_SCHEMA_V5.config);
    assert.deepEqual(cfg.refs, DEFAULT_SCHEMA_V5.refs);

    const meta = chatMetadata[META_KEY];
    assert.equal(meta.schemaVersion, 5);
    assert.deepEqual(meta.config, cfg.config);
    assert.deepEqual(meta.refs, cfg.refs);

});

test('saveChatConfig writes full schema-v5 binding to current chat metadata only', async () => {
    assert.ok(chatBinding.saveChatConfig, 'saveChatConfig is exported');
    const binding = deepClone(DEFAULT_SCHEMA_V5);
    binding.config.imageProfileId = 'img-1';
    binding.config.templateId = 'tpl-1';
    await chatBinding.saveChatConfig(binding);

    const meta = chatMetadata[META_KEY];
    assert.equal(meta.schemaVersion, 5);
    assert.equal(meta.config.imageProfileId, 'img-1');
    assert.equal(meta.config.templateId, 'tpl-1');
    assert.deepEqual(meta.refs, DEFAULT_SCHEMA_V5.refs);
});

test('loadChatConfig ignores obsolete bundle metadata without reading or writing storage', async () => {
    chatMetadata[META_KEY] = {
        bundleId: 'retired-bundle',
        overrides: { imageProfileId: 'image-from-retired-bundle' },
        refs: { referenceIds: ['retired-ref'] },
    };
    const originalMetadata = deepClone(chatMetadata[META_KEY]);
    const reads = [];
    const writes = [];
    const getItem = lfMock.getItem;
    const setItem = lfMock.setItem;
    lfMock.getItem = async key => { reads.push(key); return getItem(key); };
    lfMock.setItem = async (key, value) => { writes.push(key); return setItem(key, value); };

    const cfg = await chatBinding.loadChatConfig();

    assert.deepEqual(cfg, DEFAULT_SCHEMA_V5);
    assert.deepEqual(reads, []);
    assert.deepEqual(writes, []);
    assert.deepEqual(chatMetadata[META_KEY], originalMetadata);
});

test('patchChatConfig merges only requested config fields and preserves refs', async () => {
    assert.ok(chatBinding.patchChatConfig, 'patchChatConfig is exported');
    await chatBinding.saveChatConfig({
        schemaVersion: 5,
        config: {
            imageProfileId: 'img-1',
            templateId: 'tpl-1',
            automationMode: 'build-prompt',
            generationFlow: 'user-only',
        },
        refs: {
            referenceIds: ['ref-1'],
        },
    });

    await chatBinding.patchChatConfig({ automationMode: 'full-pipeline', generationFlow: 'ai-only' });

    const meta = chatMetadata[META_KEY];
    assert.equal(meta.config.automationMode, 'full-pipeline');
    assert.equal(meta.config.generationFlow, 'ai-only');
    assert.equal(meta.config.imageProfileId, 'img-1');
    assert.equal(meta.config.templateId, 'tpl-1');
    assert.equal(Object.hasOwn(meta.config, 'characterIds'), false);
    assert.deepEqual(meta.refs, {
        referenceIds: ['ref-1'],
        folderIds: [],
    });
});

test('generationDefaults persist and remain isolated per chat', async () => {
    const metadataByChat = { 'chat-a': {}, 'chat-b': {} };
    function switchTo(chatId) {
        globalThis.SillyTavern.getContext = () => ({
            extensionSettings: {},
            chatMetadata: metadataByChat[chatId],
            chatId,
            saveMetadata: () => {},
            saveSettingsDebounced: () => {},
        });
    }
    switchTo('chat-a');
    await chatBinding.patchChatConfig({ generationDefaults: {
        modelId: 'gpt-image-2', aspectRatio: '16:9', imageSize: '4K', quality: 'high',
    }});
    switchTo('chat-b');
    const b = await chatBinding.loadChatConfig();
    assert.deepEqual(b.config.generationDefaults, { modelId: null, aspectRatio: null, imageSize: null, quality: null });
    switchTo('chat-a');
    const a = await chatBinding.loadChatConfig();
    assert.deepEqual(a.config.generationDefaults, { modelId: 'gpt-image-2', aspectRatio: '16:9', imageSize: '4K', quality: 'high' });
});

test('loadChatConfig keeps chats independent', async () => {
    const metadataByChat = { 'chat-a': {}, 'chat-b': {} };
    function switchTo(chatId) {
        globalThis.SillyTavern.getContext = () => ({
            extensionSettings: {},
            chatMetadata: metadataByChat[chatId],
            chatId,
            saveMetadata: () => {},
            saveSettingsDebounced: () => {},
            getRequestHeaders: () => ({}),
        });
        core.state.settings = {};
        core.state.activeImageProfileId = null;
        core.state.activeTemplateId = null;
    }

    switchTo('chat-a');
    await chatBinding.loadChatConfig();
    await chatBinding.patchChatConfig({
        imageProfileId: 'img-a',
        templateId: 'tpl-a',
        automationMode: 'build-prompt',
        generationFlow: 'user-only',
    });

    switchTo('chat-b');
    const cfgB = await chatBinding.loadChatConfig();
    assert.equal(cfgB.config.imageProfileId, null);
    assert.equal(cfgB.config.templateId, null);
    assert.equal(cfgB.config.automationMode, 'manual');
    assert.equal(cfgB.config.generationFlow, 'ai-only');
    await chatBinding.patchChatConfig({
        imageProfileId: 'img-b',
        templateId: 'tpl-b',
        automationMode: 'full-pipeline',
    });

    switchTo('chat-a');
    const cfgA = await chatBinding.loadChatConfig();
    assert.equal(cfgA.config.imageProfileId, 'img-a');
    assert.equal(cfgA.config.templateId, 'tpl-a');
    assert.equal(cfgA.config.automationMode, 'build-prompt');
    assert.equal(cfgA.config.generationFlow, 'user-only');

    switchTo('chat-b');
    const cfgB2 = await chatBinding.loadChatConfig();
    assert.equal(cfgB2.config.imageProfileId, 'img-b');
    assert.equal(cfgB2.config.templateId, 'tpl-b');
    assert.equal(cfgB2.config.automationMode, 'full-pipeline');
});

test('applyChatConfigToState projects schema-v5 config onto runtime state', async () => {
    assert.ok(chatBinding.applyChatConfigToState, 'applyChatConfigToState is exported');
    const cfg = {
        schemaVersion: 5,
        config: {
            imageProfileId: 'img-1',
            templateId: 'tpl-1',
            automationMode: 'full-pipeline',
            generationFlow: 'user-only',
        },
        refs: {},
    };
    chatBinding.applyChatConfigToState(cfg);
    assert.equal(core.state.activeImageProfileId, 'img-1');
    assert.equal(core.state.activeTemplateId, 'tpl-1');
    assert.equal(Object.hasOwn(core.state, 'activeCharacterIds'), false);
    // Runtime projection lives on dedicated chat-scoped fields: state.settings
    // is persisted globally and must not absorb the last visited chat's mode.
    assert.equal(core.state.chatAutomationMode, 'full-pipeline');
    assert.equal(core.state.chatGenerationFlow, 'user-only');
    assert.equal(Object.hasOwn(core.state.settings, 'automationMode'), false);
    assert.equal(Object.hasOwn(core.state.settings, 'generationFlow'), false);
});

test('applyChatConfigToState ignores pre-v4 input', () => {
    core.state.activeImageProfileId = 'previous';
    chatBinding.applyChatConfigToState({ schemaVersion: 3, config: {}, refs: {} });
    assert.equal(core.state.activeImageProfileId, 'previous');
});

test('schema-v5 migration drops copyToStGallery and galleryMode from loaded configs', async () => {
    const { normalizeChatBinding } = await import('../src/chat-binding.js');
    const legacy = {
        schemaVersion: 4,
        config: { imageProfileId: 'p1', templateId: 't1', automationMode: 'manual', generationFlow: 'ai-only', galleryMode: 'st-only', copyToStGallery: true },
        refs: { referenceIds: [] },
    };
    const normalized = normalizeChatBinding(legacy);
    assert.equal(normalized.schemaVersion, 5);
    assert.equal(Object.hasOwn(normalized.config, 'copyToStGallery'), false);
    assert.equal(Object.hasOwn(normalized.config, 'galleryMode'), false);
});

test('retired bundle runtime projection helper is removed', () => {
    assert.equal('applyBindingForCurrentChat' in chatBinding, false, 'applyBindingForCurrentChat should not be exported');
});
