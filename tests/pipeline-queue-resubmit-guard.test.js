// @ts-check
// Queue row retry: the same duplicate-run guard as the manual submit. A
// double click or a retry while the auto-retry copy is still queued must not
// put a second paid task into the queue without the user's confirmation.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, installStGlobals } from './_helpers.js';
import { state } from '../src/core.js';

function stateQueueLength() {
    return state.queue.length;
}

/** enqueue happens a few microtasks into resubmitQueueRow — let it land. */
function tick() {
    return new Promise(resolve => setImmediate(resolve));
}

async function guardConfirm(item, confirms, decision) {
    confirms.push(item);
    return decision;
}

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

const connId = 'resubmit-guard-conn';
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
    delete globalThis.fetch;
});

/** First fetch call holds until released — the queue stays "running". */
function gateFirstFetch() {
    let releaseFirst;
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    let entered = 0;
    let resolveFirstEntered;
    const firstEntered = new Promise(resolve => { resolveFirstEntered = resolve; });
    const restore = mockFetch((url) => {
        if (String(url).endsWith('/images/generations')) {
            entered += 1;
            const isFirst = entered === 1;
            if (isFirst) resolveFirstEntered();
            return (async () => {
                if (isFirst) await gate;
                return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'b3JkZXI=' }] }) };
            })();
        }
        if (String(url) === '/api/images/upload') {
            return { ok: true, status: 200, json: async () => ({ path: 'user/images/UR%20Image%20Studio/q-resubmit-guard.png' }) };
        }
        throw new Error(`unexpected ${url}`);
    });
    return { restore, releaseFirst, firstEntered };
}

test('resubmitQueueRow guard: retry while the original is running asks for confirmation', async () => {
    const { restore, releaseFirst, firstEntered } = gateFirstFetch();
    try {
        const { createQueueItem, enqueueGeneration, resubmitQueueRow } = await import('../src/pipeline-queue.js');
        const { listQueueLog, clearQueueLog } = await import('../src/ui/queue-log.js');
        clearQueueLog({ all: true });
        const item = await createQueueItem({
            chatId: 'test-chat', msgId: 0, messageText: 'A cat.',
            requestedAction: 'current-prompt-stage2', templateId: null,
            submission: { prompt: 'PR', aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
                references: { includedIds: [], excludedIds: [], revision: 0 } },
        });
        const p1 = enqueueGeneration(item);
        await firstEntered;

        const retry = { chatId: 'test-chat', msgId: 0, messageText: '', templateId: null, submission: item.submission };
        const confirms = [];
        const declined = await resubmitQueueRow(retry, {
            guard: (guarded) => guardConfirm(guarded, confirms, false),
        });
        assert.equal(declined, null, 'отказ в подтверждении — задача не поставлена');
        assert.equal(confirms.length, 1, 'гвард нашёл дубликат и спросил');
        assert.equal(stateQueueLength(), 0, 'в очереди одна задача');

        const acceptedPromise = resubmitQueueRow(retry, {
            guard: (guarded) => guardConfirm(guarded, confirms, true),
        });
        await tick();
        assert.equal(stateQueueLength(), 1, 'после подтверждения — ровно одна копия');
        releaseFirst();
        await p1;
        const accepted = await acceptedPromise;
        assert.ok(accepted, 'явный обход остаётся за пользователем');
    } finally {
        restore();
        releaseFirst?.();
    }
});

test('resubmitQueueRow without a guard keeps the direct enqueue behavior', async () => {
    const { restore, releaseFirst, firstEntered } = gateFirstFetch();
    try {
        const { createQueueItem, enqueueGeneration, resubmitQueueRow } = await import('../src/pipeline-queue.js');
        const { clearQueueLog } = await import('../src/ui/queue-log.js');
        clearQueueLog({ all: true });
        const item = await createQueueItem({
            chatId: 'test-chat', msgId: 0, messageText: 'A cat.',
            requestedAction: 'current-prompt-stage2', templateId: null,
            submission: { prompt: 'PR2', aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
                references: { includedIds: [], excludedIds: [], revision: 0 } },
        });
        const p1 = enqueueGeneration(item);
        await firstEntered;
        const retry = { chatId: 'test-chat', msgId: 0, messageText: '', templateId: null, submission: item.submission };
        const second = resubmitQueueRow(retry);
        await tick();
        assert.equal(stateQueueLength(), 1, 'без гварда — прежнее поведение (в очереди копия)');
        releaseFirst();
        await p1;
        await second;
    } finally {
        restore();
        releaseFirst?.();
    }
});

// helpers -------------------------------------------------------------------
