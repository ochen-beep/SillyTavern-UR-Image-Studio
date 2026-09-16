// @ts-check
/**
 * Studio scope: generation without an open chat (welcome screen).
 * Covers the scope resolver, the uris_studio.json config routing through
 * chat-binding/refs-library, the studio draft surviving scene-text edits, and
 * the queue item carrying its own messageText.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Server + browser stubs (mirrors tests/file-store-merge.test.js) ──

const serverFiles = new Map();
const moduleSettings = {};

const fetchStub = async (url, options = {}) => {
    if (url === '/api/files/verify') return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    if (url === '/api/files/upload' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        serverFiles.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    if (url.startsWith('/user/files/')) {
        const name = decodeURIComponent(url.slice('/user/files/'.length));
        if (!serverFiles.has(name)) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
        return { ok: true, status: 200, text: async () => serverFiles.get(name), json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

function makeLocalforage() {
    const store = new Map();
    return {
        getItem: async k => (store.has(k) ? store.get(k) : null),
        setItem: async (k, v) => { store.set(k, v); },
        removeItem: async k => { store.delete(k); },
        keys: async () => Array.from(store.keys()),
        _store: store,
    };
}

let chatMetadata;
let lfa;

/** Install a context with a chat open (null chatId = welcome screen). */
function installContext({ chatId } = {}) {
    chatMetadata = {};
    globalThis.SillyTavern = {
        getContext: () => ({
            chatId,
            extensionSettings: moduleSettings,
            saveSettingsDebounced: () => {},
            saveMetadata: () => {},
            getRequestHeaders: () => ({}),
            get chatMetadata() { return chatMetadata; },
        }),
        libs: { localforage: lfa },
    };
}

const originalSt = globalThis.SillyTavern;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
    serverFiles.clear();
    for (const key of Object.keys(moduleSettings)) delete moduleSettings[key];
    lfa = makeLocalforage();
    installContext({ chatId: null });
    globalThis.fetch = fetchStub;
    globalThis.toastr = undefined;
    const { resetStudioStoreForTests } = await import('../src/studio-scope.js');
    resetStudioStoreForTests();
});

// ── Scope resolution ──

test('isStudioActive is false and the resolver returns the real chatId when a chat is open', async () => {
    installContext({ chatId: 'Alice - 3' });
    const { isStudioActive, resolveActiveChatId, STUDIO_CHAT_ID } = await import('../src/studio-scope.js');
    assert.equal(isStudioActive(), false);
    assert.equal(resolveActiveChatId(), 'Alice - 3');
    assert.notEqual(resolveActiveChatId(), STUDIO_CHAT_ID);
});

test('isStudioActive is true and the resolver returns the studio id on the welcome screen', async () => {
    installContext({ chatId: null });
    const { isStudioActive, resolveActiveChatId, STUDIO_CHAT_ID } = await import('../src/studio-scope.js');
    assert.equal(isStudioActive(), true);
    assert.equal(resolveActiveChatId(), STUDIO_CHAT_ID);
});

test('isStudioActive degrades to false when the ST context is unavailable', async () => {
    delete globalThis.SillyTavern;
    const { isStudioActive } = await import('../src/studio-scope.js');
    assert.equal(isStudioActive(), false);
});

// ── Config routing (chat-binding → uris_studio.json) ──

test('loadChatConfig on the welcome screen returns the default v5 envelope', async () => {
    const { loadChatConfig } = await import('../src/chat-binding.js');
    const cfg = await loadChatConfig();
    assert.equal(cfg.schemaVersion, 5);
    assert.equal(cfg.config.templateId, null);
    assert.deepEqual(cfg.refs, { referenceIds: [], folderIds: [] });
});

test('patchChatConfig on the welcome screen persists into uris_studio.json and survives a reload', async () => {
    const chatBinding = await import('../src/chat-binding.js');
    const { STUDIO_FILE_NAME, ensureStudioStoreReady, flushStudioWrites, resetStudioStoreForTests } = await import('../src/studio-scope.js');

    await chatBinding.patchChatConfig({ templateId: 'tpl-1', generationDefaults: { aspectRatio: '16:9' } });
    await flushStudioWrites();
    assert.ok(serverFiles.has(STUDIO_FILE_NAME), 'studio file written to the server');

    // Simulate a session reload: fresh probe must see the persisted envelope.
    resetStudioStoreForTests();
    await ensureStudioStoreReady();
    const cfg = await chatBinding.loadChatConfig();
    assert.equal(cfg.config.templateId, 'tpl-1');
    assert.equal(cfg.config.generationDefaults.aspectRatio, '16:9');
});

test('patchChatConfig with a chat open does not touch the studio file', async () => {
    installContext({ chatId: 'Alice - 3' });
    const chatBinding = await import('../src/chat-binding.js');
    const { STUDIO_FILE_NAME, flushStudioWrites } = await import('../src/studio-scope.js');

    await chatBinding.patchChatConfig({ templateId: 'tpl-chat' });
    await flushStudioWrites();
    assert.equal(serverFiles.has(STUDIO_FILE_NAME), false, 'no studio file without studio usage');
    assert.equal(chatMetadata.uris_binding.config.templateId, 'tpl-chat', 'chat metadata got the patch');
});

// ── Reference binding routing (refs-library) ──

test('saveChatRefs/getChatRefs on the welcome screen roundtrip through the studio store', async () => {
    const refs = await import('../src/refs-library.js');
    const chatBinding = await import('../src/chat-binding.js');
    const { flushStudioWrites, resetStudioStoreForTests, ensureStudioStoreReady } = await import('../src/studio-scope.js');

    const saved = refs.saveChatRefs({ referenceIds: ['r2', 'r1', 'r1'], folderIds: ['f1'] });
    assert.deepEqual(saved.referenceIds, ['r2', 'r1'], 'ids are deduped');
    // saveChatRefs is a sync fire-and-forget API; let the scheduled write settle.
    await new Promise(resolve => setTimeout(resolve, 20));
    await flushStudioWrites();

    // getChatRefs is sync and must see the same data (fresh session probe first).
    resetStudioStoreForTests();
    await ensureStudioStoreReady();
    await chatBinding.loadChatConfig(); // probe-and-read entry point used by the UI
    assert.deepEqual(refs.getChatRefs(), { referenceIds: ['r2', 'r1'], folderIds: ['f1'] });
});

test('studio refs binding preserves the surrounding config envelope', async () => {
    const refs = await import('../src/refs-library.js');
    const chatBinding = await import('../src/chat-binding.js');
    const { flushStudioWrites } = await import('../src/studio-scope.js');

    await chatBinding.patchChatConfig({ templateId: 'tpl-keep' });
    refs.saveChatRefs({ referenceIds: ['r1'] });
    await new Promise(resolve => setTimeout(resolve, 20));
    await flushStudioWrites();

    const cfg = await chatBinding.loadChatConfig();
    assert.equal(cfg.config.templateId, 'tpl-keep', 'config survived the refs write');
    assert.deepEqual(cfg.refs.referenceIds, ['r1']);
});

// ── Drafts ──

test('the studio draft survives scene-text edits (prompt is not discarded)', async () => {
    const drafts = await import('../src/generation-drafts.js');
    const { STUDIO_CHAT_ID, STUDIO_MSG_ID } = await import('../src/studio-scope.js');

    const created = await drafts.getGenerationDraft(STUDIO_CHAT_ID, STUDIO_MSG_ID, '');
    const updated = await drafts.updateGenerationDraft(STUDIO_CHAT_ID, STUDIO_MSG_ID, '', d => ({
        ...d,
        prompt: 'портрет героини',
        sceneText: 'она стоит у окна',
    }));

    // The scene text changes — the chat contract would discard a hash-mismatched
    // draft; the studio draft must survive with its built prompt.
    const reloaded = await drafts.getGenerationDraft(STUDIO_CHAT_ID, STUDIO_MSG_ID, 'она стоит у окна, дождь за стеклом');
    assert.equal(reloaded.prompt, 'портрет героини');
    assert.equal(reloaded.sceneText, 'она стоит у окна');
    assert.equal(reloaded.msgId, updated.msgId);
    assert.equal(created.chatId, STUDIO_CHAT_ID);
});

test('a chat draft is still discarded when its source message changes', async () => {
    lfa = makeLocalforage();
    installContext({ chatId: 'Alice - 3' });
    const drafts = await import('../src/generation-drafts.js');

    await drafts.updateGenerationDraft('Alice - 3', 0, 'первый текст', d => ({ ...d, prompt: 'p1' }));
    const after = await drafts.getGenerationDraft('Alice - 3', 0, 'текст изменился');
    assert.equal(after.prompt, '', 'stale chat draft starts fresh');
});

// ── Queue ──

test('createQueueItem stores messageText for studio items and omits it for chat items', async () => {
    const queue = await import('../src/pipeline-queue.js');
    const { STUDIO_CHAT_ID, STUDIO_MSG_ID } = await import('../src/studio-scope.js');

    const studioItem = await queue.createQueueItem({
        chatId: STUDIO_CHAT_ID, msgId: STUDIO_MSG_ID, messageText: 'сцена из студии',
        requestedAction: 'full-pipeline', templateId: null,
    });
    assert.equal(studioItem.messageText, 'сцена из студии', 'studio item carries its scene text');

    const chatItem = await queue.createQueueItem({
        chatId: 'Alice - 3', msgId: 4, messageText: 'текст поста',
        requestedAction: 'full-pipeline', templateId: null,
    });
    assert.equal(chatItem.messageText, undefined, 'chat items re-read the message at execution');
});

// ── Gallery tab on the welcome screen ──

test('the gallery tab shows studio-scope cards and the «Студия» badge without a chat', async () => {
    const { makeFakeDocument } = await import('./fake-dom.js');
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.window = { location: { origin: 'http://localhost:8000' }, dispatchEvent: () => {} };
    globalThis.SillyTavern = {
        getContext: () => ({
            chatId: null,
            extensionSettings: {
                ur_image_studio: {
                    imageConnections: {
                        schemaVersion: 1,
                        galleryIndex: [
                            { id: 's1', imagePath: 'user/images/URIS Studio/a.png', prompt: 'студийная', provenance: { chatId: '__uris_studio__' }, status: 'ready', createdAt: 1 },
                            { id: 'c1', imagePath: 'user/images/Alice/b.png', prompt: 'чатовая', provenance: { chatId: 'Alice - 3' }, status: 'ready', createdAt: 2 },
                        ],
                    },
                },
            },
            saveSettingsDebounced: () => {},
            saveMetadata: () => {},
            getRequestHeaders: () => ({}),
        }),
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

    try {
        const gallery = await import('../src/ui/tab-gallery.js');
        root.__urisTabId = 'gallery';
        await gallery.render(root);
        const cards = root.querySelectorAll('.uris-card');
        assert.equal(cards.length, 1, 'only studio-scope cards are listed');
        assert.match(root.querySelector('.uris-gallery-toolbar').textContent, /Студия/, 'scope badge is shown');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
