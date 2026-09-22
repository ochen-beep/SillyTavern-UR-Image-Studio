// @ts-check
// Очередь + submit-time снапшот: item несёт промпт/параметры на момент клика,
// выполняется FIFO, и по-прежнему отвергает изменённый исходник ДО платного
// запроса (контракт docs/plans/deferred-queue-and-chat-insertion.md).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, installStGlobals } from './_helpers.js';

function makeInMemoryLFA() {
    const store = new Map();
    return {
        getItem: async (k) => (store.has(k) ? store.get(k) : null),
        setItem: async (k, v) => { store.set(k, v); },
        removeItem: async (k) => { store.delete(k); },
    };
}

let lfMock;
let coreState;
let extensionSettings;
let chatMetadata = {};
let chat = [{ mes: 'A cat.' }];

const connId = 'queue-conn';
const route = {
    source: 'openai-models',
    modelId: 'gpt-image-1',
    generationContract: 'openai-images',
    contractVersion: 1,
    capabilities: { generate: 'supported', references: 'supported', edit: 'unknown', maxReferences: 5 },
    transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
};

function makeCtx() {
    return {
        extensionSettings,
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
        get chatMetadata() { return chatMetadata; },
        get chat() { return chat; },
        chatId: 'test-chat',
    };
}

beforeEach(async () => {
    chatMetadata = {};
    chat = [{ mes: 'A cat.' }];
    lfMock = makeInMemoryLFA();
    installStGlobals();
    globalThis.SillyTavern.libs.localforage = lfMock;
    extensionSettings = { ur_image_studio: { imageConnections: { schemaVersion: 1, connections: [], catalogs: {}, galleryIndex: [], templates: [], presets: [], refs: [], folders: [], selectedRouteId: null } } };
    globalThis.SillyTavern.getContext = makeCtx;
    globalThis.window.dispatchEvent = () => {};
    globalThis.CustomEvent ||= class CustomEvent extends Event {
        constructor(type, init) {
            super(type, init);
            this.detail = init?.detail;
        }
    };

    const core = await import('../src/core.js');
    coreState = core.state;
    core.loadSettings();
    coreState.currentChatId = 'test-chat';
    const { createConnection } = await import('../src/connection-store.js');
    await createConnection({ id: connId, kind: 'image', name: `Test ${connId}`, endpoint: 'https://api.openai.test/v1', selectedRoute: route });
    await lfMock.setItem(`uris_api_key:${connId}`, 'test-key');
    const chatBinding = await import('../src/chat-binding.js');
    const binding = await chatBinding.loadChatConfig();
    await chatBinding.saveChatConfig({ ...binding, config: { ...binding.config, imageProfileId: connId } });

    const proxy = await import('../src/proxy.js');
    proxy._resetCache();
    proxy.clearHostStrategy();
    coreState.queue = [];
    coreState.queueRunning = false;
    coreState.queueAbort = null;
    coreState.stage2Chains = new Map();
});

afterEach(() => {
    coreState.queue = [];
    coreState.queueRunning = false;
    coreState.queueAbort = null;
    coreState.stage2Chains = new Map();
    coreState.currentChatId = null;
});

test('createQueueItem validates and deep-freezes the submission snapshot', async () => {
    const { createQueueItem } = await import('../src/pipeline-queue.js');
    const submission = {
        prompt: 'P1', aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
        references: { includedIds: ['ref-a'], excludedIds: [], revision: 1 },
    };
    const item = await createQueueItem({
        chatId: 'test-chat', msgId: 0, messageText: 'A cat.',
        requestedAction: 'current-prompt-stage2', templateId: null, submission,
    });
    submission.prompt = 'MUTATED';
    submission.references.includedIds.push('ref-b');
    assert.equal(item.submission.prompt, 'P1');
    assert.deepEqual(item.submission.references.includedIds, ['ref-a']);
    assert.ok(Object.isFrozen(item.submission));
    assert.ok(Object.isFrozen(item.submission.references));
    assert.ok(Object.isFrozen(item.submission.references.includedIds));
});

test('createQueueItem rejects malformed submissions and legacy actions', async () => {
    const { createQueueItem } = await import('../src/pipeline-queue.js');
    const base = { chatId: 'test-chat', msgId: 0, messageText: 'A cat.', templateId: null };
    await assert.rejects(
        () => createQueueItem({ ...base, requestedAction: 'current-prompt-stage2', submission: { prompt: '   ' } }),
        /submission\.prompt/,
    );
    // The queue carries submission snapshots only: the auto full-pipeline
    // lives in the autolane, and the old full-pipeline queue action is gone.
    await assert.rejects(
        () => createQueueItem({ ...base, requestedAction: 'full-pipeline', submission: { prompt: 'P' } }),
        /Unknown requestedAction/,
    );
    await assert.rejects(
        () => createQueueItem({ ...base, requestedAction: 'current-prompt-stage2' }),
        /submission\.prompt/,
    );
});

test('queued submissions run FIFO, each with its submit-time prompt', async () => {
    const bodies = [];
    const restore = mockFetch((url, options) => {
        if (String(url).endsWith('/images/generations')) {
            bodies.push(String(options?.body || ''));
            return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'b3JkZXI=' }] }) };
        }
        if (String(url) === '/api/images/upload') {
            return { ok: true, status: 200, json: async () => ({ path: 'user/images/UR%20Image%20Studio/q.png' }) };
        }
        throw new Error(`unexpected ${url}`);
    });
    try {
        const { createQueueItem, enqueueGeneration } = await import('../src/pipeline-queue.js');
        // Разные quality у item'ов: пин того, что очередь передаёт ВЕСЬ снапшот,
        // а не только промпт ('auto' в тело провайдера не попадает, low/high — да).
        const mk = (prompt, quality) => createQueueItem({
            chatId: 'test-chat', msgId: 0, messageText: 'A cat.',
            requestedAction: 'current-prompt-stage2', templateId: null,
            submission: { prompt, aspectRatio: '1:1', imageSize: '1K', quality,
                references: { includedIds: [], excludedIds: [], revision: 0 } },
        });
        const p1 = enqueueGeneration(await mk('P1', 'low'));
        const p2 = enqueueGeneration(await mk('P2', 'high'));
        const [e1, e2] = await Promise.all([p1, p2]);
        assert.ok(e1 && e2, 'both items complete with gallery entries');
        assert.equal(bodies.length, 2);
        assert.match(bodies[0], /P1/);
        assert.doesNotMatch(bodies[0], /P2/);
        assert.match(bodies[0], /"quality":"low"/);
        assert.match(bodies[1], /P2/, 'FIFO order, each with its submit-time prompt');
        assert.match(bodies[1], /"quality":"high"/, 'the whole snapshot is forwarded, not just the prompt');
    } finally {
        restore();
    }
});

// Контрактный пин (зелёный и до, и после правок): устаревший исходник
// отвергается до платного запроса даже у item'а со снапшотом.
test('a submission item still rejects when the source message changed before its turn', async () => {
    let releaseFirst;
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    const bodies = [];
    const restore = mockFetch((url, options) => {
        if (String(url).endsWith('/images/generations')) {
            bodies.push(String(options?.body || ''));
            return (async () => {
                if (bodies.length === 1) await gate; // держим item 1 в полёте
                return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'b3JkZXI=' }] }) };
            })();
        }
        if (String(url) === '/api/images/upload') {
            return { ok: true, status: 200, json: async () => ({ path: 'user/images/UR%20Image%20Studio/q-stale.png' }) };
        }
        throw new Error(`unexpected ${url}`);
    });
    try {
        const { createQueueItem, enqueueGeneration } = await import('../src/pipeline-queue.js');
        const mk = () => createQueueItem({
            chatId: 'test-chat', msgId: 0, messageText: 'A cat.',
            requestedAction: 'current-prompt-stage2', templateId: null,
            submission: { prompt: 'PX', aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
                references: { includedIds: [], excludedIds: [], revision: 0 } },
        });
        const p1 = enqueueGeneration(await mk()); // стартует сразу: чек прошёл синхронно
        const p2 = enqueueGeneration(await mk()); // ждёт за item 1
        chat[0] = { mes: 'A cat. (edited)' };     // исходник изменился, пока item 2 ждёт
        releaseFirst();                           // item 1 доходит до конца
        await p1;
        await assert.rejects(async () => p2, /source message changed/i);
        assert.equal(bodies.length, 1, 'the stale item never reaches the provider');
    } finally {
        restore();
        releaseFirst?.();
    }
});

// Контрактный пин: stale-chat гвард — sibling проверки message-changed —
// распространяется и на submission item'ы.
test('a submission item still rejects when the chat switched before its turn', async () => {
    let releaseFirst;
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    const bodies = [];
    const restore = mockFetch((url, options) => {
        if (String(url).endsWith('/images/generations')) {
            bodies.push(String(options?.body || ''));
            return (async () => {
                if (bodies.length === 1) await gate; // держим item 1 в полёте
                return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'b3JkZXI=' }] }) };
            })();
        }
        if (String(url) === '/api/images/upload') {
            return { ok: true, status: 200, json: async () => ({ path: 'user/images/UR%20Image%20Studio/q-stale-chat.png' }) };
        }
        throw new Error(`unexpected ${url}`);
    });
    try {
        const { createQueueItem, enqueueGeneration } = await import('../src/pipeline-queue.js');
        const mk = () => createQueueItem({
            chatId: 'test-chat', msgId: 0, messageText: 'A cat.',
            requestedAction: 'current-prompt-stage2', templateId: null,
            submission: { prompt: 'PX', aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
                references: { includedIds: [], excludedIds: [], revision: 0 } },
        });
        const p1 = enqueueGeneration(await mk()); // стартует сразу: чек прошёл синхронно
        const p2 = enqueueGeneration(await mk()); // ждёт за item 1
        coreState.currentChatId = 'other-chat';   // чат переключён, пока item 2 ждёт
        releaseFirst();                           // item 1 доходит до конца
        await p1;
        await assert.rejects(async () => p2, /another chat/i);
        assert.equal(bodies.length, 1, 'the stale-chat item never reaches the provider');
    } finally {
        restore();
        releaseFirst?.();
    }
});
