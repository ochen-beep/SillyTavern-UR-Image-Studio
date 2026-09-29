// @ts-check
// Integration tests for Task 4: UI controls persist per-chat config via patchChatConfig.
// Each test verifies that changing a control in one chat does not affect another chat.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

const META_KEY = 'uris_binding';

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
let metadataByChat;
let currentChatId;
let fakeDoc;
let sharedExtensionSettings;

beforeEach(async () => {
    lfMock = makeInMemoryLFA();
    metadataByChat = {};
    currentChatId = 'chat-a';
    fakeDoc = makeFakeDocument();
    // Templates now live in shared extension settings, not in localforage.
    // Keep one stable object across getContext() calls so writes survive.
    sharedExtensionSettings = { ur_image_studio: { imageConnections: { schemaVersion: 1, templates: [] } } };
    const baseCtx = () => ({
        extensionSettings: sharedExtensionSettings,
        chatMetadata: metadataByChat[currentChatId] || (metadataByChat[currentChatId] = {}),
        chatId: currentChatId,
        saveMetadata: () => {},
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
        chat: [
            { mes: 'Aria waits.', is_user: false },
            { mes: 'Aria smiles.', is_user: true },
        ],
        name1: 'User', name2: 'Aria',
        characters: [{ name: 'Aria', description: 'elf', avatar: 'aria.png' }],
        characterId: 0,
    });

    globalThis.SillyTavern = {
        libs: { localforage: lfMock },
        getContext: () => baseCtx(),
    };
    globalThis.window = { location: { origin: 'http://localhost:8000' }, dispatchEvent: () => {}, addEventListener: () => {} };
    globalThis.document = fakeDoc.document;
    globalThis.toastr = { info: () => {}, success: () => {}, error: () => {}, warning: () => {} };
    // Blanket 200 for unrelated fetches; the user-files surface answers so the
    // file-backed template store is under test (the settings fallback is gone).
    const serverFiles = new Map();
    globalThis.fetch = async (url, options = {}) => {
        const u = String(url);
        if (u === '/api/files/verify') return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        if (u === '/api/files/upload' && options.method === 'POST') {
            const body = JSON.parse(options.body);
            serverFiles.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        }
        if (u.startsWith('/user/files/')) {
            const name = decodeURIComponent(u.slice('/user/files/'.length));
            if (!serverFiles.has(name)) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
            return { ok: true, status: 200, text: async () => serverFiles.get(name), json: async () => ({}) };
        }
        return { ok: true, status: 200, text: async () => '', headers: { get: () => '' } };
    };

    // Template store caches at module scope; reset so each test starts clean.
    const { resetTemplateStoreForTests } = await import('../src/prompt-templates.js');
    resetTemplateStoreForTests();
    const { resetTemplateFileStoreForTests } = await import('../src/template-file-store.js');
    resetTemplateFileStoreForTests();
});

function switchTo(chatId) {
    currentChatId = chatId;
    if (!metadataByChat[chatId]) metadataByChat[chatId] = {};
}

function makeRoot() {
    const root = globalThis.document.createElement('div');
    root.id = 'root';
    return root;
}

// Tab renders carry async guards keyed on the fields setActiveTab() writes
// before calling render (see src/ui/tabs.js). Bare test roots must set the
// tab id themselves or async render steps bail early and skip binding.
function makeTabRoot(tabId) {
    const root = makeRoot();
    root.__urisTabId = tabId;
    return root;
}

async function simulateChange(root, selector, value) {
    const el = root.querySelector(selector);
    if (!el) throw new Error(`Element ${selector} not found`);
    el.value = value;
    await el.change();
}

async function simulateClick(root, selector) {
    const el = root.querySelector(selector);
    if (!el) throw new Error(`Element ${selector} not found`);
    await el.click();
}

// ── tab-api: image profile selection ──

test('tab-api image profile selection persists via patchChatConfig', async () => {
    const { loadSettings } = await import('../src/core.js');
    await loadSettings();
    const tabApi = await import('../src/ui/tab-api.js');
    const { loadChatConfig, applyChatConfigToState } = await import('../src/chat-binding.js');
    const { createConnection } = await import('../src/connections.js');

    // The orphan "active connection" select that used to sit above the section
    // is gone: activation now happens by clicking the status dot in a card
    // header. Seed a real browser-owned connection so its card (and dot) render.
    await createConnection({ id: 'img-1', name: 'Test', endpoint: 'https://x/v1' });

    const cfg = await loadChatConfig();
    applyChatConfigToState(cfg);
    const root = makeRoot();
    await tabApi.render(root);
    await simulateClick(root, '.uris-server-status');
    const meta = metadataByChat[currentChatId][META_KEY];
    assert.equal(meta.config.imageProfileId, 'img-1');
});

// ── tab-generate: automation mode and generation flow ──

test('tab-generate automation mode and generation flow persist via patchChatConfig', async () => {
    const { state, loadSettings } = await import('../src/core.js');
    await loadSettings();
    const { loadChatConfig, applyChatConfigToState } = await import('../src/chat-binding.js');
    const tabGenerate = await import('../src/ui/tab-generate.js');
    const { setCurrentMsgId } = await import('../src/post-navigator.js');

    const cfg = await loadChatConfig();
    applyChatConfigToState(cfg);
    state.currentMsgId = 0;
    setCurrentMsgId(0);

    const root = makeTabRoot('generate');
    await tabGenerate.render(root);
    await simulateChange(root, '#urisAutomationMode', 'full-pipeline');
    await simulateChange(root, '#urisGenerationFlow', 'user-only');

    const meta = metadataByChat[currentChatId][META_KEY];
    assert.equal(meta.config.automationMode, 'full-pipeline');
    assert.equal(meta.config.generationFlow, 'user-only');
});

// ── tab-templates: default template activation ──

test('tab-templates default template activation persists via patchChatConfig', async () => {
    const { loadSettings } = await import('../src/core.js');
    await loadSettings();
    const { createInstructionTemplate } = await import('../src/prompt-templates.js');
    const created = await createInstructionTemplate({ name: 'Fantasy', instruction: '' });
    const { loadChatConfig, applyChatConfigToState } = await import('../src/chat-binding.js');
    const tabTemplates = await import('../src/ui/tab-templates.js');

    const cfg = await loadChatConfig();
    applyChatConfigToState(cfg);
    const root = makeTabRoot('templates');
    await tabTemplates.render(root);
    await simulateClick(root, '.uris-activate');

    const meta = metadataByChat[currentChatId][META_KEY];
    assert.equal(meta.config.templateId, created.id);
});

test('tab-templates header dot activation persists via patchChatConfig', async () => {
    const { loadSettings } = await import('../src/core.js');
    await loadSettings();
    const { createInstructionTemplate } = await import('../src/prompt-templates.js');
    const created = await createInstructionTemplate({ name: 'Dot', instruction: '' });
    const { loadChatConfig, applyChatConfigToState } = await import('../src/chat-binding.js');
    const tabTemplates = await import('../src/ui/tab-templates.js');

    const cfg = await loadChatConfig();
    applyChatConfigToState(cfg);
    const root = makeTabRoot('templates');
    await tabTemplates.render(root);
    // The header dot is the collapsed-state activation affordance (parallel to
    // the API tab's status dot); it must persist the same way as the body button.
    await simulateClick(root, '.uris-template-status');

    const meta = metadataByChat[currentChatId][META_KEY];
    assert.equal(meta.config.templateId, created.id);
});

// ── Chat independence: changing controls in one chat does not leak to another ──

test('tab-generate controls keep chats independent', async () => {
    const { state, loadSettings } = await import('../src/core.js');
    await loadSettings();
    const { loadChatConfig, applyChatConfigToState } = await import('../src/chat-binding.js');
    const tabGenerate = await import('../src/ui/tab-generate.js');
    const { setCurrentMsgId } = await import('../src/post-navigator.js');

    // Chat A: set automation to full-pipeline and flow to user-only
    switchTo('chat-a');
    let cfg = await loadChatConfig();
    applyChatConfigToState(cfg);
    state.currentMsgId = 0;
    setCurrentMsgId(0);
    let root = makeTabRoot('generate');
    await tabGenerate.render(root);
    await simulateChange(root, '#urisAutomationMode', 'full-pipeline');
    await simulateChange(root, '#urisGenerationFlow', 'user-only');

    // Chat B: set automation to build-prompt and flow to all
    switchTo('chat-b');
    cfg = await loadChatConfig();
    applyChatConfigToState(cfg);
    state.currentMsgId = 0;
    setCurrentMsgId(0);
    root = makeTabRoot('generate');
    await tabGenerate.render(root);
    await simulateChange(root, '#urisAutomationMode', 'build-prompt');
    await simulateChange(root, '#urisGenerationFlow', 'all');

    // Switch back to chat A and verify its own values
    switchTo('chat-a');
    cfg = await loadChatConfig();
    assert.equal(cfg.config.automationMode, 'full-pipeline');
    assert.equal(cfg.config.generationFlow, 'user-only');

    // Switch back to chat B and verify its own values
    switchTo('chat-b');
    cfg = await loadChatConfig();
    assert.equal(cfg.config.automationMode, 'build-prompt');
    assert.equal(cfg.config.generationFlow, 'all');
});

test('tab-templates active template keeps chats independent', async () => {
    const { loadSettings } = await import('../src/core.js');
    await loadSettings();
    const { createInstructionTemplate } = await import('../src/prompt-templates.js');
    const tplA = await createInstructionTemplate({ name: 'A', instruction: '' });
    const tplB = await createInstructionTemplate({ name: 'B', instruction: '' });
    const { loadChatConfig, applyChatConfigToState } = await import('../src/chat-binding.js');
    const tabTemplates = await import('../src/ui/tab-templates.js');

    switchTo('chat-a');
    let cfg = await loadChatConfig();
    applyChatConfigToState(cfg);
    let root = makeTabRoot('templates');
    await tabTemplates.render(root);
    const activateButtons = root.querySelectorAll('.uris-activate');
    assert.ok(activateButtons.length >= 2, 'expected two activate buttons');
    await activateButtons[0].click();

    switchTo('chat-b');
    cfg = await loadChatConfig();
    applyChatConfigToState(cfg);
    root = makeTabRoot('templates');
    await tabTemplates.render(root);
    const buttonsB = root.querySelectorAll('.uris-activate');
    assert.ok(buttonsB.length >= 2);
    await buttonsB[1].click();

    switchTo('chat-a');
    cfg = await loadChatConfig();
    assert.equal(cfg.config.templateId, tplA.id);

    switchTo('chat-b');
    cfg = await loadChatConfig();
    assert.equal(cfg.config.templateId, tplB.id);
});
