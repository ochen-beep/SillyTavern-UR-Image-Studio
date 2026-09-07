// @ts-check
// Тесты сериализации Stage2: per-msgId FIFO, auto-bypass, cleanup, abort isolation.
import { test, beforeEach } from 'node:test';
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

function makeDeferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function pngBytes() {
    return new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
}

let lfMock;
let coreState;
let extensionSettings;

async function setupConnection() {
    const connId = 'test-conn';
    await lfMock.setItem('uris_connections', [{
        id: connId,
        name: 'Test Pollinations',
        apiType: 'pollinations',
        endpoint: 'https://image.pollinations.ai',
        model: 'flux',
    }]);
    await lfMock.setItem('uris_conn_key_' + connId, '');
    coreState.activeImageProfileId = connId;
}

beforeEach(async () => {
    lfMock = makeInMemoryLFA();
    installStGlobals();
    globalThis.SillyTavern.libs.localforage = lfMock;
    // Browser connections live in shared extension settings; keep one stable
    // object so writes survive across getContext() calls.
    extensionSettings = { ur_image_studio: { imageConnections: { schemaVersion: 1, connections: [], catalogs: {}, galleryIndex: [], templates: [], presets: [], refs: [], folders: [], selectedRouteId: null } } };
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings,
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
        chat: [],
        chatId: 'test-chat',
    });
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
    await setupConnection();

    const proxy = await import('../src/proxy.js');
    proxy._resetCache();
    proxy.clearHostStrategy();
});

const instr = { prompt: 'a cat', style: 'anime', aspectRatio: '1:1', imageSize: '1K' };


test('browser generation persists a pending request before POST and materializes the ready result', async () => {
    const events = [];
    let pendingSnapshot = null;
    const connId = 'browser-pending-1';
    const route = {
        source: 'openai-models',
        modelId: 'gpt-image-1',
        generationContract: 'openai-images',
        contractVersion: 1,
        capabilities: { generate: 'supported', references: 'supported', edit: 'unknown', maxReferences: 5 },
        transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
    };
    const { createConnection } = await import('../src/connection-store.js');
    await createConnection({
        id: connId,
        kind: 'image',
        name: `Test ${connId}`,
        endpoint: 'https://api.openai.test/v1',
        selectedRoute: route,
    });
    await lfMock.setItem(`uris_api_key:${connId}`, 'test-key');
    const originalSetItem = lfMock.setItem;
    lfMock.setItem = async (key, value) => {
        if (key === 'uris_pending_images' && Array.isArray(value) && value.some(item => item.kind === 'browserRequest')) {
            events.push('pending');
            // Capture the initial notStarted record; later updates advance to
            // dispatchingUnknown -> resultReceived -> ready.
            if (!pendingSnapshot) {
                pendingSnapshot = value.find(item => item.kind === 'browserRequest' && item.status === 'notStarted');
            }
        }
        return originalSetItem(key, value);
    };
    const restore = mockFetch((url) => {
        if (String(url).endsWith('/images/generations')) {
            events.push('network');
            return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'b3JkZXI=' }] }) };
        }
        if (String(url) === '/api/images/upload') return { ok: true, status: 200, json: async () => ({ path: 'user/images/UR%20Image%20Studio/browser-ready.png' }) };
        throw new Error(`unexpected ${url}`);
    });
    try {
        const { runStage2ForDraft } = await import('../src/pipeline-stage2.js');
        const { getGenerationDraft } = await import('../src/generation-drafts.js');
        const result = await runStage2ForDraft(
            { chatId: 'test-chat', msgId: 20, messageText: 'A cat.', templateId: null, chatConfig: { imageProfileId: connId, templateId: null, imageRoute: route } },
            undefined,
            undefined,
            {
                instruction: instr,
            },
        );
        // A browser pending record (notStarted) is persisted before the provider
        // POST fires, then advanced through dispatchingUnknown -> resultReceived
        // -> ready as the result is materialized into native storage.
        const networkIndex = events.indexOf('network');
        assert.ok(networkIndex > 0, 'provider POST must fire after the pending record is persisted');
        assert.ok(events.slice(0, networkIndex).includes('pending'), 'pending record must precede the POST');
        assert.ok(result);
        assert.equal(pendingSnapshot.kind, 'browserRequest');
        assert.equal(pendingSnapshot.status, 'notStarted');
        assert.equal(pendingSnapshot.connId, connId);
        assert.equal(pendingSnapshot.modelId, 'gpt-image-1');
        const draft = await getGenerationDraft('test-chat', 20, 'A cat.');
        assert.equal(draft.stage2.status, 'ready');
    } finally { restore(); }
});

// Capture the diagnostic capability line. The observer persists nothing, so the
// log is the whole observable surface — asserting on it is asserting the feature.
function captureCapabilityLog() {
    const original = console.log;
    const lines = [];
    console.log = (...args) => {
        lines.push(args.map(String).join(' '));
        original(...args);
    };
    return {
        restore: () => { console.log = original; },
        find: () => lines.find(l => l.includes('capability: route')) || null,
    };
}

test('browser generation logs a confirmed capability line on success', async () => {
    const connId = 'browser-cap-obs';
    const route = {
        source: 'openai-models',
        modelId: 'gpt-image-1',
        generationContract: 'openai-images',
        contractVersion: 1,
        capabilities: { generate: 'supported', references: 'supported', edit: 'unknown', maxReferences: 5 },
        transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
    };
    const { createConnection } = await import('../src/connection-store.js');
    await createConnection({
        id: connId,
        kind: 'image',
        name: `Test ${connId}`,
        endpoint: 'https://api.openai.test/v1',
        selectedRoute: route,
    });
    await lfMock.setItem(`uris_api_key:${connId}`, 'test-key');
    const restore = mockFetch((url) => {
        if (String(url).endsWith('/images/generations')) {
            return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'b3JkZXI=' }] }) };
        }
        if (String(url) === '/api/images/upload') return { ok: true, status: 200, json: async () => ({ path: 'user/images/UR%20Image%20Studio/cap-obs.png' }) };
        throw new Error(`unexpected ${url}`);
    });
    const cap = captureCapabilityLog();
    try {
        const { runStage2ForDraft } = await import('../src/pipeline-stage2.js');
        await runStage2ForDraft(
            { chatId: 'test-chat', msgId: 22, messageText: 'A cat.', templateId: null, chatConfig: { imageProfileId: connId, templateId: null, imageRoute: route } },
            undefined, undefined, { instruction: instr },
        );
        const line = cap.find();
        assert.ok(line, 'expected a capability log line after a successful generation');
        assert.match(line, /gpt-image-1 \/ openai-images \/ generate \/ direct -> confirmed/);
    } finally { cap.restore(); restore(); }
});

test('browser generation logs network-unknown (never unsupported) on a CORS failure and does not resubmit', async () => {
    const connId = 'browser-cap-cors';
    const route = {
        source: 'openai-models',
        modelId: 'gpt-image-1',
        generationContract: 'openai-images',
        contractVersion: 1,
        capabilities: { generate: 'supported', references: 'supported', edit: 'unknown', maxReferences: 5 },
        transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
    };
    const { createConnection } = await import('../src/connection-store.js');
    await createConnection({
        id: connId,
        kind: 'image',
        name: `Test ${connId}`,
        endpoint: 'https://api.openai.test/v1',
        selectedRoute: route,
    });
    await lfMock.setItem(`uris_api_key:${connId}`, 'test-key');
    let postCount = 0;
    const restore = mockFetch(() => {
        postCount += 1;
        throw new TypeError('Failed to fetch');
    });
    const cap = captureCapabilityLog();
    try {
        const { runStage2ForDraft } = await import('../src/pipeline-stage2.js');
        await assert.rejects(runStage2ForDraft(
            { chatId: 'test-chat', msgId: 23, messageText: 'A cat.', templateId: null, chatConfig: { imageProfileId: connId, templateId: null, imageRoute: route } },
            undefined, undefined, { instruction: instr },
        ));
        assert.equal(postCount, 1, 'a paid POST must not be auto-resubmitted after a CORS failure');
        const line = cap.find();
        assert.ok(line, 'expected a capability log line even on a network-unknown failure');
        assert.match(line, /-> network-unknown/);
        // A CORS/network failure proves nothing about provider support.
        assert.doesNotMatch(line, /-> unsupported/);
        assert.match(line, /not reported as unsupported/);
    } finally { cap.restore(); restore(); }
});

test('browser generation rejects references exceeding the route maximum before POST', async () => {
    const connId = 'browser-ref-cap';
    const route = {
        source: 'openai-models',
        modelId: 'gpt-image-1',
        generationContract: 'openai-images',
        contractVersion: 1,
        capabilities: { generate: 'supported', references: 'supported', edit: 'unknown', maxReferences: 2 },
        transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
    };
    const { createConnection } = await import('../src/connection-store.js');
    await createConnection({
        id: connId,
        kind: 'image',
        name: `Test ${connId}`,
        endpoint: 'https://api.openai.test/v1',
        selectedRoute: route,
    });
    await lfMock.setItem(`uris_api_key:${connId}`, 'test-key');

    let posted = false;
    const restore = mockFetch((url) => {
        if (String(url).endsWith('/images/generations')) {
            posted = true;
            return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'b3JkZXI=' }] }) };
        }
        if (String(url) === '/api/images/upload') return { ok: true, status: 200, json: async () => ({ path: 'user/images/UR%20Image%20Studio/browser-cap.png' }) };
        throw new Error(`unexpected ${url}`);
    });
    try {
        const { runStage2ForDraft } = await import('../src/pipeline-stage2.js');
        await assert.rejects(
            runStage2ForDraft(
                { chatId: 'test-chat', msgId: 21, messageText: 'A cat.', templateId: null, chatConfig: { imageProfileId: connId, templateId: null, imageRoute: route } },
                undefined,
                undefined,
                {
                    instruction: instr,
                    refs: [
                        { id: 'first', name: 'First', image: 'data:image/png;base64,Zmlyc3Q=' },
                        { id: 'second', name: 'Second', image: 'data:image/png;base64,c2Vjb25k' },
                        { id: 'third', name: 'Third', image: 'data:image/png;base64,dGhpcmQ=' },
                    ],
                },
            ),
            (err) => err.code === 'TOO_MANY_REFERENCES',
        );
        assert.equal(posted, false, 'no provider POST when references exceed the route maximum');
    } finally { restore(); }
});

test('browser ambiguous delivery codes are never auto-resubmitted', async () => {
    const fs = await import('node:fs/promises');
    const transport = await fs.readFile(new URL('../src/image-transport.js', import.meta.url), 'utf8');
    const recovery = await fs.readFile(new URL('../src/browser-image-recovery.js', import.meta.url), 'utf8');
    // The two browser-owned ambiguous delivery codes replace the former server
    // REQUEST_AMBIGUOUS / GENERATION_FAILED_AMBIGUOUS / UPSTREAM_RESULT_UNKNOWN.
    for (const code of ['IMAGE_DELIVERY_AMBIGUOUS', 'MULTIPART_CORS_REQUIRED']) {
        assert.match(transport, new RegExp(`code = '${code}'`), `${code} must be declared by the browser transport`);
    }
    // Browser pending records are review/discard only; the recovery store must
    // never expose a resubmit path.
    assert.match(recovery, /never trigger a provider resend|review\/discard|Browser records never/);
    assert.ok(!/autoResubmit|resendPending/i.test(recovery), 'browser recovery must not auto-resend');
});

test('old guard string is gone', async () => {
    const fs = await import('node:fs');
    const content = fs.readFileSync(new URL('../src/pipeline.js', import.meta.url), 'utf8');
    assert.ok(!content.includes('stage2RunningMsgId'), 'не должно остаться stage2RunningMsgId');
    assert.ok(!content.includes('пропуск дубля'), 'не должно остаться пропуск дубля');
});

/**
 * Helper: mock fetch that hangs on /images/generations until the abort signal
 * fires, then rejects with an AbortError.  Simulates a long-running generation.
 */
function hangingFetch() {
    return mockFetch((url, options) => {
        if (String(url).endsWith('/images/generations')) {
            return new Promise((_, reject) => {
                const sig = options?.signal;
                if (sig?.aborted) {
                    reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
                    return;
                }
                sig?.addEventListener('abort', () => {
                    reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
                }, { once: true });
            });
        }
        throw new Error(`unexpected ${url}`);
    });
}

test('internal abort controller is registered in activeGenerations and cleaned up after cancellation', async () => {
    const connId = 'browser-abort-internal';
    const route = {
        source: 'openai-models',
        modelId: 'gpt-image-1',
        generationContract: 'openai-images',
        contractVersion: 1,
        capabilities: { generate: 'supported', references: 'supported', edit: 'unknown', maxReferences: 5 },
        transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
    };
    const { createConnection } = await import('../src/connection-store.js');
    await createConnection({
        id: connId,
        kind: 'image',
        name: `Test ${connId}`,
        endpoint: 'https://api.openai.test/v1',
        selectedRoute: route,
    });
    await lfMock.setItem(`uris_api_key:${connId}`, 'test-key');

    const restore = hangingFetch();
    try {
        const { runStage2ForDraft } = await import('../src/pipeline-stage2.js');
        const { getGenerationDraft } = await import('../src/generation-drafts.js');
        const { abortGeneration } = await import('../src/core.js');

        // No external signal: the pipeline creates its own AbortController and
        // registers it in state.activeGenerations by requestId.
        const promise = runStage2ForDraft(
            { chatId: 'test-chat', msgId: 31, messageText: 'A cat.', templateId: null, chatConfig: { imageProfileId: connId, templateId: null, imageRoute: route } },
            undefined,
            undefined,
            { instruction: instr },
        );

        // Poll the draft until stage2 is 'running' with a requestId.
        let requestId = null;
        for (let i = 0; i < 100; i++) {
            const d = await getGenerationDraft('test-chat', 31, 'A cat.');
            if (d?.stage2?.status === 'running' && d?.stage2?.requestId) {
                requestId = d.stage2.requestId;
                break;
            }
            await new Promise(r => setTimeout(r, 5));
        }
        assert.ok(requestId, 'draft must expose a requestId while stage2 is running');
        assert.ok(coreState.activeGenerations.has(requestId), 'controller must be registered in activeGenerations');

        // Cancel via the public API (same path the UI Cancel button uses).
        assert.equal(abortGeneration(requestId), true);

        await assert.rejects(promise);

        const draft = await getGenerationDraft('test-chat', 31, 'A cat.');
        assert.equal(draft.stage2.status, 'cancelled', 'draft status must be cancelled, not error');
        assert.equal(draft.stage2.error, null, 'cancelled drafts must not carry an error message');
        assert.ok(!coreState.activeGenerations.has(requestId), 'controller must be removed from activeGenerations after cancellation');
    } finally { restore(); }
});

test('external signal abort sets draft status to cancelled (not error)', async () => {
    const connId = 'browser-abort-external';
    const route = {
        source: 'openai-models',
        modelId: 'gpt-image-1',
        generationContract: 'openai-images',
        contractVersion: 1,
        capabilities: { generate: 'supported', references: 'supported', edit: 'unknown', maxReferences: 5 },
        transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
    };
    const { createConnection } = await import('../src/connection-store.js');
    await createConnection({
        id: connId,
        kind: 'image',
        name: `Test ${connId}`,
        endpoint: 'https://api.openai.test/v1',
        selectedRoute: route,
    });
    await lfMock.setItem(`uris_api_key:${connId}`, 'test-key');

    const restore = hangingFetch();
    try {
        const { runStage2ForDraft } = await import('../src/pipeline-stage2.js');
        const { getGenerationDraft } = await import('../src/generation-drafts.js');

        const controller = new AbortController();
        const promise = runStage2ForDraft(
            { chatId: 'test-chat', msgId: 32, messageText: 'A cat.', templateId: null, chatConfig: { imageProfileId: connId, templateId: null, imageRoute: route } },
            undefined,
            controller.signal,
            { instruction: instr },
        );

        // Abort after the fetch has started.
        setTimeout(() => controller.abort(), 20);

        await assert.rejects(promise);

        const draft = await getGenerationDraft('test-chat', 32, 'A cat.');
        assert.equal(draft.stage2.status, 'cancelled', 'draft status must be cancelled, not error');
        assert.equal(draft.stage2.error, null, 'cancelled drafts must not carry an error message');
    } finally { restore(); }
});

test('external-signal (queue) Stage 2 also registers in activeGenerations and is individually cancellable', async () => {
    const connId = 'browser-abort-queue-unify';
    const route = {
        source: 'openai-models',
        modelId: 'gpt-image-1',
        generationContract: 'openai-images',
        contractVersion: 1,
        capabilities: { generate: 'supported', references: 'supported', edit: 'unknown', maxReferences: 5 },
        transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
    };
    const { createConnection } = await import('../src/connection-store.js');
    await createConnection({
        id: connId,
        kind: 'image',
        name: `Test ${connId}`,
        endpoint: 'https://api.openai.test/v1',
        selectedRoute: route,
    });
    await lfMock.setItem(`uris_api_key:${connId}`, 'test-key');

    const restore = hangingFetch();
    try {
        const { runStage2ForDraft } = await import('../src/pipeline-stage2.js');
        const { getGenerationDraft } = await import('../src/generation-drafts.js');
        const { abortGeneration } = await import('../src/core.js');

        // An external controller standing in for the queue controller. Before
        // unification a signal-bearing Stage 2 did NOT register its own
        // controller, so it was not individually cancellable.
        const queueController = new AbortController();
        const promise = runStage2ForDraft(
            { chatId: 'test-chat', msgId: 33, messageText: 'A cat.', templateId: null, chatConfig: { imageProfileId: connId, templateId: null, imageRoute: route } },
            undefined,
            queueController.signal,
            { instruction: instr },
        );

        let requestId = null;
        for (let i = 0; i < 100; i++) {
            const d = await getGenerationDraft('test-chat', 33, 'A cat.');
            if (d?.stage2?.status === 'running' && d?.stage2?.requestId) {
                requestId = d.stage2.requestId;
                break;
            }
            await new Promise(r => setTimeout(r, 5));
        }
        assert.ok(requestId, 'queue-signal Stage 2 must expose a requestId while running');
        assert.ok(coreState.activeGenerations.has(requestId), 'queue-signal Stage 2 must register in activeGenerations');

        // Cancel just this item via the public API - the external (queue)
        // controller must NOT be aborted, so a queue could continue with the next item.
        assert.equal(abortGeneration(requestId), true);
        assert.equal(queueController.signal.aborted, false, 'per-item cancel must not abort the queue controller');

        await assert.rejects(promise);

        const draft = await getGenerationDraft('test-chat', 33, 'A cat.');
        assert.equal(draft.stage2.status, 'cancelled', 'draft status must be cancelled, not error');
        assert.equal(draft.stage2.error, null);
        assert.ok(!coreState.activeGenerations.has(requestId), 'controller removed from activeGenerations after cancellation');
    } finally { restore(); }
});
