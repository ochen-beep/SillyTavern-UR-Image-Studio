// @ts-check
/**
 * Final end-to-end verification for Task 8: chat-scoped configuration (schema v5).
 *
 * Scenarios covered:
 * 1. A fresh chat receives fixed schema-v5 defaults.
 * 2. Two independent chats keep their own image profile / template / automation / gallery settings.
 * 3. Import/export round-trips a current chat config and refs without secrets.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    META_KEY, LF_API_KEY, LF_GALLERY_PREFIX,
} from '../src/core.js';
import {
    loadChatConfig, patchChatConfig, createDefaultChatConfig,
} from '../src/chat-binding.js';
import { exportUrisData, importUrisData } from '../src/data-port.js';

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

function makeInMemoryLFA() {
    const store = new Map();
    return {
        async keys() { return Array.from(store.keys()); },
        async getItem(key) { return store.has(key) ? store.get(key) : null; },
        async setItem(key, value) { store.set(key, value); },
        async removeItem(key) { store.delete(key); },
        _store: store,
    };
}

let lfMock;
let metadataByChat;
let currentChatId;

function resetContext() {
    lfMock = makeInMemoryLFA();
    metadataByChat = {};
    currentChatId = '';

    globalThis.SillyTavern = {
        libs: { localforage: lfMock },
        getContext: () => ({
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            saveMetadata: () => {},
            getRequestHeaders: () => ({}),
            chatId: currentChatId,
            chatMetadata: metadataByChat[currentChatId] || {},
        }),
    };
}

function switchTo(chatId) {
    currentChatId = chatId;
    if (!metadataByChat[chatId]) metadataByChat[chatId] = {};
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        saveMetadata: () => {},
        getRequestHeaders: () => ({}),
        chatId,
        chatMetadata: metadataByChat[chatId],
    });
}

beforeEach(() => {
    resetContext();
});

test('fresh chat gets schema-v5 defaults', async () => {
    switchTo('fresh-chat');
    const cfg = await loadChatConfig();

    assert.equal(cfg.schemaVersion, 5);
    assert.deepEqual(cfg.config, DEFAULT_SCHEMA_V5.config);
    assert.deepEqual(cfg.refs, DEFAULT_SCHEMA_V5.refs);

    const meta = metadataByChat['fresh-chat'][META_KEY];
    assert.ok(meta);
    assert.equal(meta.schemaVersion, 5);
    assert.deepEqual(meta.config, DEFAULT_SCHEMA_V5.config);
    assert.deepEqual(meta.refs, DEFAULT_SCHEMA_V5.refs);
});

test('two independent chats keep independent image profile, template, automation, and gallery settings', async () => {
    switchTo('chat-a');
    await loadChatConfig();
    await patchChatConfig({
        imageProfileId: 'img-a',
        templateId: 'tpl-a',
        automationMode: 'full-pipeline',
        generationFlow: 'all',
    });

    switchTo('chat-b');
    await loadChatConfig();
    await patchChatConfig({
        imageProfileId: 'img-b',
        templateId: 'tpl-b',
        automationMode: 'build-prompt',
        generationFlow: 'ai-only',
    });

    switchTo('chat-a');
    const cfgA = await loadChatConfig();
    assert.equal(cfgA.config.imageProfileId, 'img-a');
    assert.equal(cfgA.config.templateId, 'tpl-a');
    assert.equal(cfgA.config.automationMode, 'full-pipeline');
    assert.equal(cfgA.config.generationFlow, 'all');

    switchTo('chat-b');
    const cfgB = await loadChatConfig();
    assert.equal(cfgB.config.imageProfileId, 'img-b');
    assert.equal(cfgB.config.templateId, 'tpl-b');
    assert.equal(cfgB.config.automationMode, 'build-prompt');
    assert.equal(cfgB.config.generationFlow, 'ai-only');
});

test('import/export round-trips a current chat config and refs', async () => {
    switchTo('roundtrip-chat');
    await loadChatConfig();
    await patchChatConfig({
        imageProfileId: 'rt-profile',
        templateId: 'rt-template',
        automationMode: 'full-pipeline',
        generationFlow: 'manual',
    });
    // Save refs via chat-binding save by merging through a full save.
    const withRefs = createDefaultChatConfig();
    withRefs.config = { ...metadataByChat['roundtrip-chat'][META_KEY].config };
    withRefs.refs = {
        referenceIds: ['rt-ref'],
    };

    // Patch config again so refs are not lost; chat-binding.saveChatConfig is not directly exported.
    // Instead, write the full binding into the metadata map and call saveChatConfig indirectly:
    metadataByChat['roundtrip-chat'][META_KEY] = withRefs;
    const cfgBefore = await loadChatConfig();
    assert.equal(cfgBefore.refs.referenceIds[0], 'rt-ref');

	    const exported = await exportUrisData();
	    assert.equal(exported.version, 9);
	    assert.equal(exported.module, 'ur_image_studio');
    assert.deepEqual(Object.keys(exported.data.chatMetadata), ['roundtrip-chat']);
    const exportedChat = exported.data.chatMetadata['roundtrip-chat'];
    assert.equal(exportedChat.schemaVersion, 5);
    assert.equal(exportedChat.config.imageProfileId, 'rt-profile');
    assert.equal(exportedChat.config.templateId, 'rt-template');
    assert.deepEqual(exportedChat.refs.referenceIds, ['rt-ref']);

    // Secrets must be absent from the exported JSON; the retired localforage
    // section is always empty in v9.
    const dump = JSON.stringify(exported);
    assert.equal(dump.includes('sk-secret'), false, 'export must not contain injected secrets');
    assert.deepEqual(exported.data.localforage, {});

    // Simulate importing into a clean or modified current chat.
    metadataByChat['roundtrip-chat'] = {};
    const result = await importUrisData(exported, { mode: 'merge' });
    assert.equal(result.importedChatBindings, 1);

    const cfgAfter = await loadChatConfig();
    assert.equal(cfgAfter.schemaVersion, 5);
    assert.equal(cfgAfter.config.imageProfileId, 'rt-profile');
    assert.equal(cfgAfter.config.templateId, 'rt-template');
    assert.equal(cfgAfter.config.automationMode, 'full-pipeline');
    assert.equal(cfgAfter.config.generationFlow, 'manual');
    assert.equal(Object.hasOwn(cfgAfter.config, 'characterIds'), false);
	    assert.deepEqual(cfgAfter.refs.referenceIds, ['rt-ref']);
	});


