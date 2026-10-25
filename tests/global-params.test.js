// @ts-check
// «Использовать параметры генерации для всех чатов»: запись параметра при
// включённом режиме. До фикса глобальные значения было некем задать —
// settings.globalGenerationDefaults оставался вечным null. Контракт:
//   - chat-значение ключа отсутствует → запись идёт в глобальный дефолт;
//   - chat-значение есть → обычный chat-оверрайд (patchChatConfig);
//   - режим выключен → всегда chat-конфиг.
// Чтение (chat ?? global) и проекция на переключении чатов — applyChatConfigToState.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeUserFileServer } from './_helpers.js';

const fileServer = makeUserFileServer({
    fallback(url, options) {
        return globalThis.__realFetch ? globalThis.__realFetch(url, options) : { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    },
});
globalThis.fetch = fileServer.fetch;

globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage: () => {} }) }) };
globalThis.window = { location: { origin: 'http://localhost:8000' }, dispatchEvent: () => {} };

let chatMetadata;
let saveSettingsCalls;

beforeEach(() => {
    chatMetadata = {};
    saveSettingsCalls = 0;
    globalThis.SillyTavern = {
        libs: { localforage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } },
        getContext: () => ({
            extensionSettings: {},
            chatMetadata,
            chatId: 'chat-1',
            saveMetadata: () => {},
            saveSettingsDebounced: () => { saveSettingsCalls++; },
            getRequestHeaders: () => ({}),
        }),
    };
});

async function setup() {
    const core = await import('../src/core.js');
    core.state.settings = {
        useParametersForAllChats: false,
        globalGenerationDefaults: { modelId: null, aspectRatio: null, imageSize: null, quality: null },
    };
    core.state.activeImageProfileId = null;
    core.state.activeTemplateId = null;
    core.state.generationDefaults = {};
    const tabGenerate = await import('../src/ui/tab-generate.js');
    const chatBinding = await import('../src/chat-binding.js');
    return { core, tabGenerate, loadChatConfig: chatBinding.loadChatConfig, applyChatConfigToState: chatBinding.applyChatConfigToState };
}

const META_KEY = 'uris_binding';

function putChatDefaults(defaults) {
    chatMetadata[META_KEY] = {
        schemaVersion: 5,
        config: {
            imageProfileId: null,
            templateId: null,
            generationDefaults: { modelId: null, aspectRatio: null, imageSize: null, quality: null, ...defaults },
            automationMode: 'manual',
            generationFlow: 'ai-only',
        },
        refs: { referenceIds: [], folderIds: [] },
    };
}

test('глобальный режим + пустой chat-ключ: запись уходит в globalGenerationDefaults, chat не трогается', async () => {
    const { core, tabGenerate, loadChatConfig } = await setup();
    core.state.settings.useParametersForAllChats = true;
    putChatDefaults({});

    await tabGenerate.saveGenerationDefaultByKey('aspectRatio', '16:9');

    assert.equal(core.state.settings.globalGenerationDefaults.aspectRatio, '16:9');
    assert.ok(saveSettingsCalls > 0, 'глобальная запись сохраняется в настройки');
    const binding = await loadChatConfig();
    assert.equal(binding.config.generationDefaults.aspectRatio, null, 'chat-конфиг остался пустым');
    assert.equal(core.state.generationDefaults.aspectRatio, '16:9', 'runtime-проекция обновлена');
});

test('глобальный режим + существующий chat-ключ: обычный chat-оверрайд', async () => {
    const { core, tabGenerate, loadChatConfig } = await setup();
    core.state.settings.useParametersForAllChats = true;
    core.state.settings.globalGenerationDefaults.aspectRatio = '1:1';
    putChatDefaults({ aspectRatio: '9:16' });

    await tabGenerate.saveGenerationDefaultByKey('aspectRatio', '3:4');

    const binding = await loadChatConfig();
    assert.equal(binding.config.generationDefaults.aspectRatio, '3:4', 'перезаписано в чате');
    assert.equal(core.state.settings.globalGenerationDefaults.aspectRatio, '1:1', 'глобал не тронут');
});

test('режим выключен: запись всегда в chat-конфиг', async () => {
    const { core, tabGenerate, loadChatConfig } = await setup();
    core.state.settings.useParametersForAllChats = false;
    putChatDefaults({});

    await tabGenerate.saveGenerationDefaultByKey('quality', 'high');

    const binding = await loadChatConfig();
    assert.equal(binding.config.generationDefaults.quality, 'high');
    assert.equal(core.state.settings.globalGenerationDefaults.quality, null, 'глобал не тронут');
});

test('переключение чатов: applyChatConfigToState подставляет глобальные значения, где chat пуст', async () => {
    const { core, applyChatConfigToState, loadChatConfig } = await setup();
    core.state.settings.useParametersForAllChats = true;
    core.state.settings.globalGenerationDefaults = { modelId: null, aspectRatio: '21:9', imageSize: '2K', quality: 'high' };
    putChatDefaults({ aspectRatio: '1:1' }); // chat имеет только aspectRatio

    const binding = await loadChatConfig();
    applyChatConfigToState(binding);

    assert.equal(core.state.generationDefaults.aspectRatio, '1:1', 'chat-значение приоритетно');
    assert.equal(core.state.generationDefaults.imageSize, '2K', 'глобал подставлен');
    assert.equal(core.state.generationDefaults.quality, 'high', 'глобал подставлен');
    assert.equal(core.state.generationDefaults.modelId, null);
});
