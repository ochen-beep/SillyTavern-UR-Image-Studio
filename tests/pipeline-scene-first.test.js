// @ts-check
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals, makeReferenceStore, mockFetch } from './_helpers.js';
import {
    createRef, resetRefStoreForTests, saveChatRefs, setRefStoreForTests,
} from '../src/refs-library.js';
import { resolvePromptReferenceContext } from '../src/scene-context.js';
import { resolveConnectionReferencePolicy } from '../src/ui/tab-generate.js';

function makeInMemoryLFA() {
    const store = new Map();
    return {
        getItem: async (k) => (store.has(k) ? store.get(k) : null),
        setItem: async (k, v) => { store.set(k, v); },
        removeItem: async (k) => { store.delete(k); },
        _store: store,
        _clear() { store.clear(); },
    };
}

let lfMock;
let coreState;
let textResponse = 'llm response';
let textResponseQueue = [];
let onSendRequest = null;
let _chatMetadata = {};
let extensionSettings;
let restoreServerImageMock = null;

const SERVER_REQUEST_ID = '9e8bd96d-dab7-4ac8-9ef8-46b746f9f7e7';

const SERVER_IMAGE_CONNECTIONS = ['img-conn', 'img-a', 'img-b'].map(id => ({
    id,
    kind: 'image',
    name: `Test ${id}`,
    selectedRoute: {
        id: 'route-1',
        modelId: 'flux',
        apiFamily: 'pollinations',
        capabilities: { references: 'supported', maxReferences: 5 },
    },
}));

function serverResponse(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function mockServerImageApi(handler = () => undefined) {
    return mockFetch(async (url, options, viaProxy) => {
        if (String(url).endsWith('/images/generations')) {
            const body = JSON.parse(options.body);
            const request = {
                requestId: body.requestId || SERVER_REQUEST_ID,
                prompt: body.prompt,
                references: [],
            };
            const response = await handler(request, url, options, viaProxy);
            if (response?.json) return serverResponse({ data: [{ b64_json: 'mock' }] });
            return response ?? serverResponse({ data: [{ b64_json: 'mock' }] });
        }
        if (String(url).endsWith('/images/edits')) {
            const request = { requestId: SERVER_REQUEST_ID, prompt: '', references: [] };
            const response = await handler(request, url, options, viaProxy);
            if (response?.json) return serverResponse({ data: [{ b64_json: 'mock' }] });
            return response ?? serverResponse({ data: [{ b64_json: 'mock' }] });
        }
        if (String(url).endsWith('/status')) {
            return serverResponse({
                apiVersion: 1,
                features: { connections: true, discovery: true, generation: true, requestRecovery: true },
            });
        }
        if (String(url).endsWith('/connections')) return serverResponse({ connections: SERVER_IMAGE_CONNECTIONS });
        if (String(url).endsWith('/generate')) {
            const request = JSON.parse(options.body);
            return await handler(request, url, options, viaProxy) ?? serverResponse({
                requestId: request.requestId,
                state: 'ready',
                result: { kind: 'dataUrl', value: 'data:image/png;base64,mock', mimeType: 'image/png' },
            });
        }
        if (String(url) === '/api/images/upload') {
            return serverResponse({ path: 'user/images/UR%20Image%20Studio/mock.png' });
        }
        return { ok: true };
    });
}

function makeDeferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function pngBytes() {
    return new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
}

beforeEach(async () => {
    if (restoreServerImageMock) restoreServerImageMock();
    restoreServerImageMock = null;
    lfMock = makeInMemoryLFA();
    resetRefStoreForTests();
    setRefStoreForTests(makeReferenceStore());
    installStGlobals();
    textResponse = 'llm response';
    textResponseQueue = [];
    onSendRequest = null;
    _chatMetadata = {};
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: () => SERVER_REQUEST_ID,
    });
    globalThis.SillyTavern.libs.localforage = lfMock;
    extensionSettings = { ur_image_studio: { imageConnections: { schemaVersion: 1, connections: [], catalogs: {}, galleryIndex: [], templates: [], presets: [], refs: [], folders: [], selectedRouteId: null } }, connectionManager: { profiles: [{ id: 'text-conn', name: 'Test Text' }] } };
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings,
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
        ConnectionManagerRequestService: {
            sendRequest: async () => {
                onSendRequest?.();
                const content = textResponseQueue.length ? await textResponseQueue.shift() : textResponse;
                return { choices: [{ message: { content } }] };
            },
        },
        chat: [],
        chatId: 'test-chat',
        name1: 'Alex',
        name2: 'Aria',
        characters: [{ name: 'Aria', description: 'blonde prince', avatar: 'aria.png' }],
        characterId: 0,
        get chatMetadata() { return _chatMetadata; },
    });

    const core = await import('../src/core.js');
    const templateStore = await import('../src/prompt-templates.js');
    templateStore.resetTemplateStoreForTests();
    templateStore.setTemplateStoreForTests({
        available: async () => true,
        async list() { return (await lfMock.getItem(core.LF_TEMPLATES)) ?? []; },
        async create(record) {
            const records = (await lfMock.getItem(core.LF_TEMPLATES)) ?? [];
            records.push(record);
            await lfMock.setItem(core.LF_TEMPLATES, records);
            return record;
        },
        async update(id, record) {
            const records = (await lfMock.getItem(core.LF_TEMPLATES)) ?? [];
            const index = records.findIndex(item => item.id === id);
            records[index] = { ...record, id };
            await lfMock.setItem(core.LF_TEMPLATES, records);
            return records[index];
        },
        async delete(id) {
            const records = (await lfMock.getItem(core.LF_TEMPLATES)) ?? [];
            await lfMock.setItem(core.LF_TEMPLATES, records.filter(item => item.id !== id));
        },
    });
    coreState = core.state;
    core.loadSettings();
    coreState.queue = [];
    coreState.queueRunning = false;
    coreState.queueAbort = null;
});

async function setupTextApi() {
    await lfMock.setItem('uris_connections', [{
        id: 'text-conn',
        name: 'Test Text',
        apiType: 'openai',
        endpoint: 'https://api.test.com',
        model: 'gpt-4o',
    }]);
    await lfMock.setItem('uris_conn_key_text-conn', 'test-key');
    coreState.settings.apiSource = 'profile';
    coreState.settings.profileId = 'text-conn';
}

async function setupImageApi(imageProfileId = 'img-conn') {
    const source = imageProfileId === 'image-1' ? 'openai-models' : 'openai-models';
    const connection = {
        id: imageProfileId,
        kind: 'image',
        name: `Test ${imageProfileId}`,
        endpoint: 'https://api.openai.test/v1',
        selectedRoute: {
            source,
            modelId: 'gpt-image-1',
            generationContract: 'openai-images',
            capabilities: { generate: 'supported', references: 'supported', edit: 'unknown', maxReferences: 5 },
            transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
        },
    };
    const { createConnection } = await import('../src/connection-store.js');
    await createConnection({ ...connection, id: imageProfileId });
    await lfMock.setItem(`uris_api_key:${imageProfileId}`, 'test-key');
    coreState.activeImageProfileId = imageProfileId;
    const binding = await (await import('../src/chat-binding.js')).loadChatConfig();
    await (await import('../src/chat-binding.js')).saveChatConfig({
        ...binding,
        config: { ...binding.config, imageProfileId },
    });
    const proxy = await import('../src/proxy.js');
    proxy._resetCache();
    proxy.clearHostStrategy();
}

test('runStage1ForDraft returns snapshot and updates draft', async () => {
    await setupTextApi();
    textResponse = 'A prince stands in a garden.';
    const { runStage1ForDraft } = await import('../src/pipeline.js');
    const run = await runStage1ForDraft({
        chatId: 'chat-1',
        msgId: 4,
        messageText: 'Aria waits in the garden.',
        templateId: null,
    });
    assert.equal(run.applied, true);
    assert.equal(run.reason, null);
    assert.equal(run.result.sourceMsgId, 4);
    assert.strictEqual(run.snapshot, run.draft.stage1.contextSnapshot);
    assert.equal(run.draft.promptOrigin, 'stage1');
    assert.equal(run.draft.prompt, 'A prince stands in a garden.');
});

test('late Stage 1 result does not overwrite manual prompt', async () => {
    await setupTextApi();
    const { runStage1ForDraft } = await import('../src/pipeline.js');
    const { updateGenerationDraft } = await import('../src/generation-drafts.js');

    let resolveText;
    const textPromise = new Promise(r => { resolveText = r; });
    textResponseQueue.push(textPromise.then(t => t));

    const requestStarted = makeDeferred();
    onSendRequest = () => requestStarted.resolve();

    const runPromise = runStage1ForDraft({
        chatId: 'chat-1',
        msgId: 4,
        messageText: 'Aria waits.',
        templateId: null,
    });

    // Wait until the text request is actually in flight, then edit.
    await requestStarted.promise;
    await updateGenerationDraft('chat-1', 4, 'Aria waits.', (d) => ({
        ...d,
        prompt: 'manual prompt',
        promptOrigin: 'manual',
    }));

    resolveText('prompt from llm');
    const run = await runPromise;

    assert.equal(run.applied, false);
    assert.equal(run.reason, 'prompt-edited');
    assert.equal(run.draft.prompt, 'manual prompt');
    assert.equal(run.draft.promptOrigin, 'manual');
});


test('superseded run is discarded when newer run finishes first', async () => {
    await setupTextApi();
    const { runStage1ForDraft } = await import('../src/pipeline.js');

    let resolveFirst;
    const firstPromise = new Promise(r => { resolveFirst = r; });
    let resolveSecond;
    const secondPromise = new Promise(r => { resolveSecond = r; });

    textResponseQueue.push(firstPromise.then(t => t));
    textResponseQueue.push(secondPromise.then(t => t));

    const bothStarted = makeDeferred();
    let startedCount = 0;
    onSendRequest = () => {
        startedCount += 1;
        if (startedCount === 2) bothStarted.resolve();
    };

    const run1Promise = runStage1ForDraft({
        chatId: 'chat-1',
        msgId: 4,
        messageText: 'Aria waits.',
        templateId: null,
    });
    const run2Promise = runStage1ForDraft({
        chatId: 'chat-1',
        msgId: 4,
        messageText: 'Aria waits.',
        templateId: null,
    });

    await bothStarted.promise;
    resolveSecond('second result');
    resolveFirst('first result');

    const run1 = await run1Promise;
    const run2 = await run2Promise;

    assert.equal(run2.applied, true);
    assert.equal(run1.applied, false);
    assert.equal(run1.reason, 'superseded');
    assert.equal(run2.draft.prompt, 'second result');
});

test('runStage1ForDraft keeps source identity regardless of currentMsgId', async () => {
    await setupTextApi();
    textResponse = 'prompt for message 4';
    const { runStage1ForDraft } = await import('../src/pipeline.js');
    coreState.currentMsgId = 12;
    const run = await runStage1ForDraft({
        chatId: 'chat-1',
        msgId: 4,
        messageText: 'Aria waits.',
        templateId: null,
    });
    assert.equal(run.draft.msgId, 4);
    assert.equal(run.draft.chatId, 'chat-1');
    assert.equal(run.result.sourceMsgId, 4);
});

async function setupInstructionTemplate(name, instruction) {
    const { createInstructionTemplate, saveTemplate } = await import('../src/prompt-templates.js');
    const tpl = await createInstructionTemplate({ name });
    return saveTemplate({ ...tpl, instruction });
}

async function persistDraft(chatId, msgId, messageText, { templateSelection, templateId }) {
    const { hashMessage, generationDraftKey } = await import('../src/generation-drafts.js');
    await lfMock.setItem(generationDraftKey(chatId, msgId), {
        chatId,
        msgId,
        messageHash: hashMessage(messageText),
        templateSelection,
        templateId,
        prompt: '',
        promptOrigin: 'empty',
        promptRevision: 0,
        aspectRatio: '1:1',
        imageSize: '1K',
        quality: 'auto',
        references: { includedIds: [], excludedIds: [], revision: 0 },
        stage1: {
            status: 'idle',
            structuredDraft: null,
            contextSnapshot: null,
            builtAt: null,
            error: null,
            runToken: 0,
            runPromptRevision: 0,
        },
        stage2: {
            status: 'idle',
            lastSubmittedSnapshot: null,
            error: null,
        },
    });
}

function captureSendRequest() {
    const baseCtx = globalThis.SillyTavern.getContext;
    const systems = [];
    globalThis.SillyTavern.getContext = () => {
        const ctx = baseCtx();
        return {
            ...ctx,
            ConnectionManagerRequestService: {
                sendRequest: async (profileId, messages, _1, options) => {
                    const system = messages.find(m => m.role === 'system')?.content || null;
                    systems.push(system);
                    return { choices: [{ message: { content: 'prompt from template' } }] };
                },
            },
        };
    };
    return {
        getSystem() { return systems[systems.length - 1] ?? null; },
        hasSystem(substr) { return systems.some(s => s?.includes(substr)); },
        restore() { globalThis.SillyTavern.getContext = baseCtx; },
    };
}

test('runStage1ForDraft resolves the active template for a default draft', async () => {
    await setupTextApi();
    const activeTpl = await setupInstructionTemplate('Active', 'ACTIVE TEMPLATE INSTRUCTION');
    coreState.activeTemplateId = activeTpl.id;
    await persistDraft('chat-1', 4, 'Aria waits.', { templateSelection: 'default', templateId: null });

    const { runStage1ForDraft } = await import('../src/pipeline.js');
    const capture = captureSendRequest();
    try {
        const run = await runStage1ForDraft({
            chatId: 'chat-1',
            msgId: 4,
            messageText: 'Aria waits.',
            templateId: null,
        });
        assert.equal(run.applied, true);
        assert.equal(run.draft.templateSelection, 'default');
        assert.equal(run.draft.templateId, null);
        assert.ok(capture.getSystem()?.includes('ACTIVE TEMPLATE INSTRUCTION'), 'active template instruction must reach Stage 1');
    } finally {
        capture.restore();
    }
});

test('runStage1ForDraft preserves a local template override', async () => {
    await setupTextApi();
    const activeTpl = await setupInstructionTemplate('Active', 'ACTIVE TEMPLATE INSTRUCTION');
    const localTpl = await setupInstructionTemplate('Local', 'LOCAL TEMPLATE INSTRUCTION');
    coreState.activeTemplateId = activeTpl.id;
    await persistDraft('chat-1', 4, 'Aria waits.', { templateSelection: 'override', templateId: localTpl.id });

    const { runStage1ForDraft } = await import('../src/pipeline.js');
    const capture = captureSendRequest();
    try {
        const run = await runStage1ForDraft({
            chatId: 'chat-1',
            msgId: 4,
            messageText: 'Aria waits.',
            templateId: null,
        });
        assert.equal(run.applied, true);
        assert.equal(run.draft.templateSelection, 'override');
        assert.equal(run.draft.templateId, localTpl.id);
        assert.ok(capture.getSystem()?.includes('LOCAL TEMPLATE INSTRUCTION'), 'local override instruction must reach Stage 1');
        assert.ok(!capture.getSystem()?.includes('ACTIVE TEMPLATE INSTRUCTION'), 'active template instruction must not leak');
    } finally {
        capture.restore();
    }
});

test('active template change affects only default draft, not override draft', async () => {
    await setupTextApi();
    const tplA = await setupInstructionTemplate('A', 'TEMPLATE A INSTRUCTION');
    const tplB = await setupInstructionTemplate('B', 'TEMPLATE B INSTRUCTION');
    const localTpl = await setupInstructionTemplate('Local', 'LOCAL TEMPLATE INSTRUCTION');
    await persistDraft('chat-1', 4, 'Aria waits.', { templateSelection: 'default', templateId: null });
    await persistDraft('chat-1', 5, 'Aria waits.', { templateSelection: 'override', templateId: localTpl.id });

    const { runStage1ForDraft } = await import('../src/pipeline.js');

    coreState.activeTemplateId = tplA.id;
    const captureA = captureSendRequest();
    try {
        await runStage1ForDraft({ chatId: 'chat-1', msgId: 4, messageText: 'Aria waits.', templateId: null });
        await runStage1ForDraft({ chatId: 'chat-1', msgId: 5, messageText: 'Aria waits.', templateId: null });
    } finally {
        captureA.restore();
    }
    assert.ok(captureA.hasSystem('TEMPLATE A INSTRUCTION'), 'default draft must use active template A');
    assert.ok(captureA.hasSystem('LOCAL TEMPLATE INSTRUCTION'), 'override draft must use its local template');

    coreState.activeTemplateId = tplB.id;
    const captureB = captureSendRequest();
    let runDefaultB;
    let runOverrideB;
    try {
        runDefaultB = await runStage1ForDraft({ chatId: 'chat-1', msgId: 4, messageText: 'Aria waits.', templateId: null });
        runOverrideB = await runStage1ForDraft({ chatId: 'chat-1', msgId: 5, messageText: 'Aria waits.', templateId: null });
    } finally {
        captureB.restore();
    }
    assert.ok(captureB.hasSystem('TEMPLATE B INSTRUCTION'), 'default draft must follow active template change to B');
    assert.ok(captureB.hasSystem('LOCAL TEMPLATE INSTRUCTION'), 'override draft must keep local template after active change');
    assert.equal(runDefaultB.draft.templateSelection, 'default');
    assert.equal(runDefaultB.draft.templateId, null);
    assert.equal(runOverrideB.draft.templateSelection, 'override');
    assert.equal(runOverrideB.draft.templateId, localTpl.id);
});

test('createStage2Snapshot builds frozen submission snapshot', async () => {
    const { createStage2Snapshot, hashMessage } = await import('../src/generation-drafts.js');
    const draft = {
        msgId: 4,
        messageHash: hashMessage('Aria waits.'),
        prompt: 'edited prompt',
        aspectRatio: '9:16',
        imageSize: '2K',
        quality: 'high',
        templateId: null,
        references: { includedIds: [], excludedIds: [], revision: 3 },
    };
    const contextSnapshot = {
        chatId: 'chat-1',
        msgId: 4,
        messageHash: draft.messageHash,
        contextRevision: 3,
        entities: [],
        stage1Descriptions: [],
        stage2Refs: [],
        ambiguities: [],
    };
    const refs = [{ id: 'char', name: 'Aria', dataUrl: 'data:image/png;base64,abc' }];
    const snapshot = createStage2Snapshot({ draft, contextSnapshot, refs, now: () => '2026-07-15T10:00:00.000Z' });

    assert.deepEqual(snapshot, {
        sourceMsgId: 4,
        messageHash: draft.messageHash,
        prompt: 'edited prompt',
        aspectRatio: '9:16',
        imageSize: '2K',
        quality: 'high',
        refs: [{ id: 'char', name: 'Aria', dataUrl: 'data:image/png;base64,abc' }],
        templateId: null,
        contextRevision: 3,
        submittedAt: '2026-07-15T10:00:00.000Z',
    });
    assert.throws(() => { snapshot.prompt = 'later edit'; }, TypeError);
    assert.throws(() => { snapshot.refs[0].name = 'changed'; }, TypeError);
});

test('runStage2ForDraft rejects empty prompt without provider call', async () => {
    await setupImageApi();
    const { runStage2ForDraft } = await import('../src/pipeline.js');
    let fetchCalls = 0;
    const restore = mockServerImageApi(() => { fetchCalls += 1; return { ok: true }; });
    try {
        await assert.rejects(
            runStage2ForDraft({ chatId: 'chat-1', msgId: 4, messageText: 'Aria waits.', templateId: null }),
            /Prompt is empty/,
        );
        assert.equal(fetchCalls, 0);
    } finally {
        restore();
    }
});

test('runStage2ForDraft rejects stale message hash without provider call', async () => {
    await setupImageApi();
    const { updateGenerationDraft } = await import('../src/generation-drafts.js');
    const { runStage2ForDraft } = await import('../src/pipeline.js');

    await updateGenerationDraft('chat-1', 4, 'old text', d => ({ ...d, prompt: 'prompt for old text', promptOrigin: 'manual' }));

    let fetchCalls = 0;
    const restore = mockServerImageApi(() => { fetchCalls += 1; return { ok: true }; });
    try {
        await assert.rejects(
            runStage2ForDraft({ chatId: 'chat-1', msgId: 4, messageText: 'new text', templateId: null }),
            /Source message changed/,
        );
        assert.equal(fetchCalls, 0);
    } finally {
        restore();
    }
});

test('runStage2ForDraft submits immutable snapshot even if draft is mutated', async () => {
    await setupImageApi();
    const { runStage2ForDraft } = await import('../src/pipeline.js');
    const { updateGenerationDraft, getGenerationDraft } = await import('../src/generation-drafts.js');

    await updateGenerationDraft('chat-1', 4, 'Aria waits.', d => ({
        ...d,
        prompt: 'original prompt',
        aspectRatio: '9:16',
        imageSize: '2K',
        quality: 'high',
        promptOrigin: 'manual',
    }));

    const requestStarted = makeDeferred();
    const releaseRequest = makeDeferred();
    let submittedRequest = null;
    let fetchCalls = 0;

    const restore = mockServerImageApi((request) => {
        fetchCalls += 1;
        submittedRequest = request;
        requestStarted.resolve();
        return releaseRequest.promise.then(() => serverResponse({
            requestId: request.requestId,
            state: 'ready',
            result: { kind: 'dataUrl', value: 'data:image/png;base64,mock', mimeType: 'image/png' },
        }));
    });

    try {
        const runPromise = runStage2ForDraft({ chatId: 'chat-1', msgId: 4, messageText: 'Aria waits.', templateId: null });

        await requestStarted.promise;
        // Mutate the live draft while the provider request is in flight.
        await updateGenerationDraft('chat-1', 4, 'Aria waits.', d => ({ ...d, prompt: 'mutated prompt' }));
        releaseRequest.resolve();

        const entry = await runPromise;
        assert.ok(entry, 'gallery entry should be returned');
        assert.equal(fetchCalls, 1);
        assert.equal(submittedRequest.prompt, 'original prompt', 'server must receive original snapshot prompt');
        assert.notEqual(submittedRequest.prompt, 'mutated prompt', 'server must not receive mutated prompt');

        const draft = await getGenerationDraft('chat-1', 4, 'Aria waits.');
        assert.equal(draft.stage2.lastSubmittedSnapshot.prompt, 'original prompt');
        assert.equal(draft.stage2.lastSubmittedSnapshot.aspectRatio, '9:16');
        assert.equal(draft.stage2.lastSubmittedSnapshot.imageSize, '2K');
        assert.equal(draft.stage2.lastSubmittedSnapshot.quality, 'high');
        assert.throws(() => { draft.stage2.lastSubmittedSnapshot.prompt = 'x'; }, TypeError);
    } finally {
        restore();
    }
});

test('createQueueItem captures identity and validates action', async () => {
    const { createQueueItem } = await import('../src/pipeline.js');
    const { hashMessage } = await import('../src/generation-drafts.js');
    const item = await createQueueItem({
        chatId: 'chat-1',
        msgId: 7,
        messageText: 'scene text',
        requestedAction: 'full-pipeline',
        templateId: 'tpl-1',
        now: () => '2026-07-15T11:00:00.000Z',
    });
    assert.equal(item.chatId, 'chat-1');
    assert.equal(item.msgId, 7);
    assert.equal(item.messageHash, hashMessage('scene text'));
    assert.equal(item.requestedAction, 'full-pipeline');
    assert.equal(item.templateId, 'tpl-1');
    assert.equal(item.enqueuedAt, '2026-07-15T11:00:00.000Z');
    await assert.rejects(() => createQueueItem({ requestedAction: 'bad-action' }), /Unknown requestedAction/);
});

test('createQueueItem captures the schema-v4 config and selected route at enqueue time', async () => {
    const { createQueueItem } = await import('../src/pipeline.js');
    const route = {
        id: 'route-enqueued', contractVersion: 1, generationContract: 'openai-images', modelId: 'gpt-image-1',
        capabilities: { generate: 'supported', references: 'unknown', edit: 'unknown' },
        transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
    };
    const binding = await (await import('../src/chat-binding.js')).loadChatConfig();
    await (await import('../src/chat-binding.js')).saveChatConfig({
        ...binding,
        config: { ...binding.config, imageProfileId: 'image-1', templateId: 'tpl-1' },
    });
    const { createConnection } = await import('../src/connection-store.js');
    await createConnection({
        id: 'image-1', kind: 'image', endpoint: 'https://api.openai.test/v1',
        selectedRoute: route,
    });
    const item = await createQueueItem({
        chatId: 'chat-1', msgId: 7, messageText: 'scene text', requestedAction: 'full-pipeline', templateId: null,
    });

    route.modelId = 'mutated-after-enqueue';
    assert.equal(item.chatConfig.imageProfileId, 'image-1');
    assert.equal(item.chatConfig.imageRoute.modelId, 'gpt-image-1');
    assert.equal(item.chatConfig.imageConnection, undefined);
    assert.equal(item.chatConfig.imageRoute.generationContract, 'openai-images');
    assert.throws(() => { item.chatConfig.imageRoute.modelId = 'mutated-item'; }, TypeError);
    assert.throws(() => { item.chatConfig.imageConnection.id = 'mutated-item'; }, TypeError);
});

test('queued browser generation refuses to dispatch after its connection is removed', async () => {
    await setupImageApi('image-1');
    const { createQueueItem, enqueueGeneration, stopQueue } = await import('../src/pipeline.js');
    const { deleteConnection } = await import('../src/connections.js');
    const item = await createQueueItem({
        chatId: 'chat-1', msgId: 4, messageText: 'Aria waits.',
        requestedAction: 'current-prompt-stage2', templateId: null,
    });
    const baseCtx = globalThis.SillyTavern.getContext;
    globalThis.SillyTavern.getContext = () => ({
        ...baseCtx(), chat: [,,,, { mes: 'Aria waits.' }], chatId: 'chat-1',
    });
    await (await import('../src/generation-drafts.js')).updateGenerationDraft('chat-1', 4, 'Aria waits.', draft => ({
        ...draft, prompt: 'queued server prompt', promptOrigin: 'manual',
    }));
    await deleteConnection('image-1');
    let submitted = null;
    const restore = mockServerImageApi(request => { submitted = request; });
    try {
        // The browser dispatch resolves the live connection by ID at execution
        // time, so a removed connection must fail explicitly. The queue item
        // still retains its captured route snapshot; no provider POST may fire.
        await assert.rejects(
            enqueueGeneration(item),
            /Image connection was not found/,
        );
        assert.equal(submitted, null, 'no provider POST after connection removal');
        assert.equal(item.chatConfig.imageRoute.modelId, 'gpt-image-1');
    } finally {
        restore();
        globalThis.SillyTavern.getContext = baseCtx;
        stopQueue();
    }
});

test('queue item captures effective template id without mutating draft mode', async () => {
    await setupTextApi();
    const activeTpl = await setupInstructionTemplate('Active', 'ACTIVE TEMPLATE INSTRUCTION');
    await persistDraft('chat-1', 4, 'Aria waits.', { templateSelection: 'default', templateId: null });

    const { createQueueItem } = await import('../src/pipeline.js');
    const { getGenerationDraft, resolveDraftTemplateId, generationDraftKey } = await import('../src/generation-drafts.js');

    coreState.activeTemplateId = activeTpl.id;
    const currentDraft = await getGenerationDraft('chat-1', 4, 'Aria waits.');
    const templateId = resolveDraftTemplateId(currentDraft, coreState.activeTemplateId);
    const item = await createQueueItem({
        chatId: 'chat-1',
        msgId: 4,
        messageText: 'Aria waits.',
        requestedAction: 'full-pipeline',
        templateId,
        now: () => '2026-07-15T11:00:00.000Z',
    });

    assert.equal(item.templateId, activeTpl.id);

    // Stored draft must remain default; the queue snapshot is operational only.
    const stored = await lfMock.getItem(generationDraftKey('chat-1', 4));
    assert.equal(stored.templateSelection, 'default');
    assert.equal(stored.templateId, null);
});

test('enqueue full-pipeline keeps captured identity after navigation', async () => {
    await setupTextApi();
    await setupImageApi();
    textResponse = 'queued prompt';
    const { enqueueGeneration, createQueueItem, stopQueue } = await import('../src/pipeline.js');

    const restore = mockServerImageApi();
    try {
        const item = await createQueueItem({
            chatId: 'chat-1', msgId: 4, messageText: 'Aria waits.',
            requestedAction: 'full-pipeline', templateId: null,
        });

        // Navigate to a different message before the queue drains.
        coreState.currentMsgId = 99;
        globalThis.SillyTavern.getContext = () => ({
            extensionSettings,
            saveSettingsDebounced: () => {},
            getRequestHeaders: () => ({}),
            ConnectionManagerRequestService: { sendRequest: async () => ({ choices: [{ message: { content: textResponse } }] }) },
            chat: [,,,, { mes: 'Aria waits.' }],
            chatId: 'other-chat',
            name1: 'Alex',
            name2: 'Aria',
            characters: [{ name: 'Aria', description: 'blonde prince', avatar: 'aria.png' }],
            characterId: 0,
        });

        const entry = await enqueueGeneration(item);
        assert.ok(entry, 'queue should process the captured message');

        const { getGenerationDraft } = await import('../src/generation-drafts.js');
        const draft = await getGenerationDraft('chat-1', 4, 'Aria waits.');
        assert.equal(draft.prompt, 'queued prompt');
        assert.equal(draft.msgId, 4);
    } finally {
        restore();
        stopQueue();
    }
});

test('enqueue rejects item when source message changes before drain', async () => {
    await setupTextApi();
    await setupImageApi();
    const { enqueueGeneration, createQueueItem, stopQueue } = await import('../src/pipeline.js');

    const restore = mockServerImageApi();
    try {
        const item = await createQueueItem({
            chatId: 'chat-1', msgId: 4, messageText: 'Aria waits.',
            requestedAction: 'full-pipeline', templateId: null,
        });

        // Change the source text before draining.
        globalThis.SillyTavern.getContext = () => ({
            extensionSettings,
            saveSettingsDebounced: () => {},
            getRequestHeaders: () => ({}),
            ConnectionManagerRequestService: { sendRequest: async () => ({ choices: [{ message: { content: 'x' } }] }) },
            chat: [,,,, { mes: 'Aria changed her mind.' }],
            chatId: 'chat-1',
            name1: 'Alex',
            name2: 'Aria',
            characters: [{ name: 'Aria', description: 'blonde prince', avatar: 'aria.png' }],
            characterId: 0,
        });

        await assert.rejects(enqueueGeneration(item), /Queued source message changed/);
    } finally {
        restore();
        stopQueue();
    }
});

test('enqueue current-prompt-stage2 skips Stage 1 and uses saved prompt', async () => {
    await setupImageApi();
    const { enqueueGeneration, createQueueItem, stopQueue } = await import('../src/pipeline.js');
    const { updateGenerationDraft } = await import('../src/generation-drafts.js');

    await updateGenerationDraft('chat-1', 4, 'Aria waits.', d => ({
        ...d,
        prompt: 'manual queued prompt',
        aspectRatio: '16:9',
        imageSize: '4K',
        quality: 'standard',
        promptOrigin: 'manual',
    }));

    // Ensure the queued message still exists in context when the queue drains.
    const baseCtx = globalThis.SillyTavern.getContext;
    globalThis.SillyTavern.getContext = () => {
        const ctx = baseCtx();
        return {
            ...ctx,
            chat: [,,,, { mes: 'Aria waits.' }],
            chatId: 'chat-1',
        };
    };

    let fetchCalls = 0;
    let submittedRequest = null;
    const restore = mockServerImageApi((request) => {
        fetchCalls += 1;
        submittedRequest = request;
    });

    try {
        const item = await createQueueItem({
            chatId: 'chat-1', msgId: 4, messageText: 'Aria waits.',
            requestedAction: 'current-prompt-stage2', templateId: null,
        });

        const entry = await enqueueGeneration(item);
        assert.ok(entry);
        assert.equal(fetchCalls, 1);
        assert.equal(submittedRequest.prompt, 'manual queued prompt');
    } finally {
        restore();
        stopQueue();
    }
});

// ── Prompt-driven Stage 2 reference resolution ──

test('manual Stage 2 sends refs matched by prompt instead of source message', async () => {
    await setupImageApi();
    const aaron = await createRef({
        name: 'Aaron', aliases: ['Aaron'], description: 'red coat',
        imagePath: 'data:image/png;base64,iVBORw0KGgo=', keywords: [],
    });
    const beth = await createRef({
        name: 'Beth', aliases: ['Beth'], description: 'blue dress',
        imagePath: 'data:image/png;base64,iVBORw0KGgo=', keywords: [],
    });
    saveChatRefs({ referenceIds: [aaron.id, beth.id] });

    const { runStage2ForDraft } = await import('../src/pipeline.js');
    const { updateGenerationDraft } = await import('../src/generation-drafts.js');

    await updateGenerationDraft('chat-1', 4, 'Aaron enters.', draft => ({
        ...draft,
        prompt: 'Beth stands alone.',
        promptOrigin: 'manual',
    }));

    const restore = mockServerImageApi();

    try {
        let sentRefs = null;
        await runStage2ForDraft(
            { chatId: 'chat-1', msgId: 4, messageText: 'Aaron enters.', templateId: null },
            () => {}, undefined,
            { onRefsSent: refs => { sentRefs = refs; } },
        );

        assert.deepEqual(sentRefs.map(ref => ref.id), [beth.id]);
    } finally {
        restore();
    }
});

test('manual Stage 2 applies prompt-derived refs and corrections', async () => {
    await setupImageApi();
    const aaron = await createRef({
        name: 'Aaron', aliases: ['Aaron'], description: 'red coat',
        imagePath: 'data:image/png;base64,iVBORw0KGgo=', keywords: [],
    });
    const beth = await createRef({
        name: 'Beth', aliases: ['Beth'], description: 'blue dress',
        imagePath: 'data:image/png;base64,iVBORw0KGgo=', keywords: [],
    });
    const claire = await createRef({
        name: 'Claire', aliases: ['Claire'], description: 'green cloak',
        imagePath: 'data:image/png;base64,iVBORw0KGgo=', keywords: [],
    });
    saveChatRefs({ referenceIds: [aaron.id, beth.id, claire.id] });

    const { runStage2ForDraft } = await import('../src/pipeline.js');
    const { updateGenerationDraft } = await import('../src/generation-drafts.js');

    await updateGenerationDraft('chat-1', 4, 'Aaron and Beth stand together.', draft => ({
        ...draft,
        prompt: 'Aaron and Beth stand together.',
        promptOrigin: 'manual',
        references: { includedIds: [claire.id], excludedIds: [aaron.id], revision: 1 },
    }));

    const restore = mockServerImageApi();

    try {
        let sentRefs = null;
        await runStage2ForDraft(
            { chatId: 'chat-1', msgId: 4, messageText: 'Aaron and Beth stand together.', templateId: null },
            () => {}, undefined,
            { onRefsSent: refs => { sentRefs = refs; } },
        );

        assert.deepEqual(sentRefs.map(ref => ref.id), [claire.id, beth.id]);
    } finally {
        restore();
    }
});

test('prompt edit updates auto refs while corrections persist', async () => {
    await setupImageApi();
    const aaron = await createRef({
        name: 'Aaron', aliases: ['Aaron'], description: 'red coat',
        imagePath: 'data:image/png;base64,iVBORw0KGgo=', keywords: [],
    });
    const beth = await createRef({
        name: 'Beth', aliases: ['Beth'], description: 'blue dress',
        imagePath: 'data:image/png;base64,iVBORw0KGgo=', keywords: [],
    });
    saveChatRefs({ referenceIds: [aaron.id, beth.id] });

    const { runStage2ForDraft } = await import('../src/pipeline.js');
    const { updateGenerationDraft, getGenerationDraft } = await import('../src/generation-drafts.js');

    await updateGenerationDraft('chat-1', 4, 'Aaron and Beth stand together.', draft => ({
        ...draft,
        prompt: 'Aaron and Beth stand together.',
        promptOrigin: 'manual',
        references: { includedIds: [], excludedIds: [aaron.id], revision: 1 },
    }));

    const restore = mockServerImageApi();

    try {
        let firstRefs = null;
        await runStage2ForDraft(
            { chatId: 'chat-1', msgId: 4, messageText: 'Aaron and Beth stand together.', templateId: null },
            () => {}, undefined,
            { onRefsSent: refs => { firstRefs = refs; } },
        );
        assert.deepEqual(firstRefs.map(ref => ref.id), [beth.id]);

        await updateGenerationDraft('chat-1', 4, 'Aaron and Beth stand together.', draft => ({
            ...draft,
            prompt: 'Aaron stands alone.',
        }));

        let secondRefs = null;
        await runStage2ForDraft(
            { chatId: 'chat-1', msgId: 4, messageText: 'Aaron and Beth stand together.', templateId: null },
            () => {}, undefined,
            { onRefsSent: refs => { secondRefs = refs; } },
        );
        assert.deepEqual(secondRefs.map(ref => ref.id), []);

        const draft = await getGenerationDraft('chat-1', 4, 'Aaron and Beth stand together.');
        assert.ok(draft.references.excludedIds.includes(aaron.id));
    } finally {
        restore();
    }
});

test('auto Stage 2 resolves refs from the Stage 1 result prompt', async () => {
    await setupTextApi();
    await setupImageApi();
    const aaron = await createRef({
        name: 'Aaron', aliases: ['Aaron'], description: 'red coat',
        imagePath: 'data:image/png;base64,iVBORw0KGgo=', keywords: [],
    });
    const beth = await createRef({
        name: 'Beth', aliases: ['Beth'], description: 'blue dress',
        imagePath: 'data:image/png;base64,iVBORw0KGgo=', keywords: [],
    });
    saveChatRefs({ referenceIds: [aaron.id, beth.id] });
    textResponse = 'Beth stands alone.';

    const { runFullPipelineForDraft } = await import('../src/pipeline.js');
    const { getGenerationDraft } = await import('../src/generation-drafts.js');

    const restore = mockServerImageApi();

    try {
        const entry = await runFullPipelineForDraft({
            chatId: 'chat-1', msgId: 4, messageText: 'Aaron enters.', templateId: null,
        });
        assert.ok(entry);

        const draft = await getGenerationDraft('chat-1', 4, 'Aaron enters.');
        assert.deepEqual(draft.stage2.lastSubmittedSnapshot.refs.map(ref => ref.id), [beth.id]);
        assert.deepEqual(draft.stage1.contextSnapshot.stage2Refs.map(ref => ref.id), [aaron.id]);
    } finally {
        restore();
    }
});

test('Stage 2 rejects references exceeding the route limit before any provider POST', async () => {
    await setupImageApi();
    const { updateConnection } = await import('../src/connection-store.js');
    await updateConnection('img-conn', {
        model: { id: 'gpt-image-1', source: 'list' },
        overrides: { maxRefs: 4 },
    });
    const ids = [];
    for (let i = 0; i < 5; i++) {
        const ref = await createRef({
            name: `Ref${i}`, aliases: [`Ref${i}`], description: `ref ${i}`,
            imagePath: 'data:image/png;base64,iVBORw0KGgo=',
        });
        ids.push(ref.id);
    }
    saveChatRefs({ referenceIds: ids });

    const { runStage2ForDraft } = await import('../src/pipeline.js');
    const { updateGenerationDraft, getGenerationDraft } = await import('../src/generation-drafts.js');

    await updateGenerationDraft('chat-1', 4, 'scene', draft => ({
        ...draft,
        prompt: ids.map(id => `Ref${ids.indexOf(id)}`).join(', ') + ' stand together.',
        promptOrigin: 'manual',
    }));

    let submitted = null;
    const restore = mockServerImageApi(request => { submitted = request; });

    try {
        // The central reference policy rejects excess references before the
        // provider is dispatched, so no paid POST is ever issued.
        await assert.rejects(
            runStage2ForDraft(
                { chatId: 'chat-1', msgId: 4, messageText: 'scene', templateId: null },
                () => {}, undefined,
            ),
            (err) => err.code === 'TOO_MANY_REFERENCES',
        );
        assert.equal(submitted, null, 'no provider POST when references exceed the route limit');
        const draft = await getGenerationDraft('chat-1', 4, 'scene');
        assert.equal(draft.stage2.status, 'error');
        assert.equal(draft.stage2.error, 'Too many reference images for the selected image route.');
    } finally {
        restore();
    }
});

test('prompt-first corrections do not mutate chat-scoped referenceIds', async () => {
    await setupImageApi();
    const aaron = await createRef({
        name: 'Aaron', aliases: ['Aaron'], description: 'red coat',
        imagePath: 'data:image/png;base64,iVBORw0KGgo=', keywords: [],
    });

    const { runStage2ForDraft } = await import('../src/pipeline.js');
    const { updateGenerationDraft } = await import('../src/generation-drafts.js');
    const { getChatRefs, saveChatRefs } = await import('../src/refs-library.js');

    // chatMetadata is now shared across getContext() calls via _chatMetadata, so
    // saveChatRefs/read-back already survive. Keep saveMetadata override for safety.
    const baseCtx = globalThis.SillyTavern.getContext;
    globalThis.SillyTavern.getContext = () => {
        const ctx = baseCtx();
        ctx.saveMetadata = () => {};
        return ctx;
    };

    saveChatRefs({ referenceIds: ['legacy-extra', aaron.id] });
    const before = getChatRefs();
    assert.deepEqual(before.referenceIds, ['legacy-extra', aaron.id]);

    await updateGenerationDraft('chat-1', 4, 'scene', draft => ({
        ...draft,
        prompt: 'Aaron stands alone.',
        promptOrigin: 'manual',
        references: { includedIds: [aaron.id], excludedIds: [], revision: 1 },
    }));

    const restore = mockServerImageApi();

    try {
        await runStage2ForDraft(
            { chatId: 'chat-1', msgId: 4, messageText: 'scene', templateId: null },
            () => {}, undefined,
        );
        const after = getChatRefs();
        assert.deepEqual(after.referenceIds, ['legacy-extra', aaron.id]);
    } finally {
        restore();
        globalThis.SillyTavern.getContext = baseCtx;
    }
});

test('reference delivery policy does not mutate Stage 2 logical references', async () => {
    const resolution = await resolvePromptReferenceContext({
        prompt: 'Aria and Borin',
        candidates: [
            { id: 'a', name: 'Aria', aliases: ['Aria'], imagePath: '/a.png' },
            { id: 'b', name: 'Borin', aliases: ['Borin'], imagePath: '/b.png' },
        ],
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });
    const before = structuredClone(resolution.stage2Refs);
    const policy = resolveConnectionReferencePolicy({
        selectedRoute: { capabilities: { references: 'supported', maxReferences: 1 } },
    });
    assert.equal(policy.maxRefs, 1);
    assert.deepEqual(resolution.stage2Refs, before);
    assert.equal(resolution.stage2Refs.length, 2);
});

test('resolveActivePresets uses the explicit image-profile snapshot instead of current state', async () => {
    await setupImageApi();
    coreState.activeImageProfileId = 'img-b';

    const { resolveActivePresets } = await import('../src/pipeline.js');
    const result = await resolveActivePresets({
        imageProfileId: 'img-a',
        templateId: null,
    });
    assert.equal(result.imageConnId, 'img-a');
    assert.equal(Object.hasOwn(result, 'activeChars'), false);
});

test('queue item keeps captured chat config after switching to another chat', async () => {
    await setupTextApi();
    await setupImageApi('img-a');

    const activeTpl = await setupInstructionTemplate('A', 'TEMPLATE A INSTRUCTION');
    const tplB = await setupInstructionTemplate('B', 'TEMPLATE B INSTRUCTION');

    coreState.activeImageProfileId = 'img-a';
    coreState.activeTemplateId = activeTpl.id;

    const { createQueueItem, enqueueGeneration, stopQueue } = await import('../src/pipeline.js');
    const binding = await (await import('../src/chat-binding.js')).loadChatConfig();
    await (await import('../src/chat-binding.js')).saveChatConfig({
        ...binding,
        config: { ...binding.config, imageProfileId: 'img-a', templateId: activeTpl.id },
    });
    const item = await createQueueItem({
        chatId: 'chat-a', msgId: 4, messageText: 'Aria waits.',
        requestedAction: 'full-pipeline', templateId: null,
    });
    assert.equal(item.chatConfig.imageProfileId, 'img-a', 'queue item must capture chat-a image profile');
    assert.equal(item.chatConfig.templateId, activeTpl.id, 'queue item must capture chat-a template');

    // Switch runtime to chat-b profile before the queue drains.
    coreState.activeImageProfileId = 'img-b';
    coreState.activeTemplateId = tplB.id;

    let submittedRequest = null;
    let systemPrompt = '';
    const baseCtx = globalThis.SillyTavern.getContext;
    globalThis.SillyTavern.getContext = () => {
        const ctx = baseCtx();
        return {
            ...ctx,
            extensionSettings: {
                ...ctx.extensionSettings,
                ur_image_studio: {
                    ...(ctx.extensionSettings?.ur_image_studio || {}),
                    uris: {
                        schemaVersion: 4,
                        config: { imageProfileId: 'img-a', templateId: activeTpl.id, automationMode: 'manual', generationFlow: 'ai-only' },
                        refs: { referenceIds: [] },
                    },
                },
            },
            chat: [,,,, { mes: 'Aria waits.', is_user: false }],
            chatId: 'chat-a',
            ConnectionManagerRequestService: {
                sendRequest: async (_profileId, messages) => {
                    systemPrompt = messages.find(m => m.role === 'system')?.content || '';
                    return { choices: [{ message: { content: 'prompt from A' } }] };
                },
            },
        };
    };

    const restore = mockServerImageApi((request) => {
        submittedRequest = request;
    });

    try {
        const entry = await enqueueGeneration(item);
        assert.ok(entry, 'queue should produce a gallery entry');
        assert.ok(submittedRequest, 'must submit through the captured chat-a image connection');
        assert.ok(systemPrompt.includes('TEMPLATE A INSTRUCTION'), 'must use chat-a template');
        assert.ok(!systemPrompt.includes('TEMPLATE B INSTRUCTION'), 'must not use chat-b template');
    } finally {
        restore();
        globalThis.SillyTavern.getContext = baseCtx;
        stopQueue();
    }
});

test('runStage1ForDraft records cancelled status (not error) when aborted mid-flight', async () => {
    await setupTextApi();
    const { runStage1ForDraft } = await import('../src/pipeline.js');
    const { getGenerationDraft } = await import('../src/generation-drafts.js');

    const controller = new AbortController();
    const baseCtx = globalThis.SillyTavern.getContext;
    globalThis.SillyTavern.getContext = () => ({
        ...baseCtx(),
        ConnectionManagerRequestService: {
            sendRequest: () => new Promise((_resolve, reject) => {
                const sig = controller.signal;
                if (sig.aborted) {
                    reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
                    return;
                }
                sig.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
            }),
        },
    });
    try {
        const promise = runStage1ForDraft({
            chatId: 'test-chat', msgId: 7, messageText: 'Aria waits.', templateId: null,
        }, undefined, controller.signal);
        setTimeout(() => controller.abort(), 20);
        await assert.rejects(promise, /Aborted/);
        const draft = await getGenerationDraft('test-chat', 7, 'Aria waits.');
        assert.equal(draft.stage1.status, 'cancelled', 'stage1 status must be cancelled, not error');
        assert.equal(draft.stage1.error, null, 'cancelled stage1 must not carry an error message');
    } finally {
        globalThis.SillyTavern.getContext = baseCtx;
    }
});

test('cancelling a single queue item continues the queue with the next item', async () => {
    await setupImageApi();
    const { enqueueGeneration, createQueueItem, stopQueue } = await import('../src/pipeline.js');
    const { abortGeneration } = await import('../src/core.js');
    const { updateGenerationDraft } = await import('../src/generation-drafts.js');

    await updateGenerationDraft('chat-q', 10, 'first post', d => ({ ...d, prompt: 'first prompt', promptOrigin: 'manual' }));
    await updateGenerationDraft('chat-q', 11, 'second post', d => ({ ...d, prompt: 'second prompt', promptOrigin: 'manual' }));

    const baseCtx = globalThis.SillyTavern.getContext;
    const chatArr = [];
    chatArr[10] = { mes: 'first post' };
    chatArr[11] = { mes: 'second post' };
    globalThis.SillyTavern.getContext = () => ({ ...baseCtx(), chat: chatArr, chatId: 'chat-q' });

    let imageCallCount = 0;
    const restore = mockServerImageApi((_request, _url, options) => {
        imageCallCount += 1;
        if (imageCallCount === 1) {
            // First item: hang until its ownController aborts (per-item cancel).
            return new Promise((_, reject) => {
                const sig = options?.signal;
                if (sig?.aborted) { reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); return; }
                sig?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
            });
        }
        // Second item: resolve normally.
        return undefined;
    });
    try {
        const item1 = await createQueueItem({ chatId: 'chat-q', msgId: 10, messageText: 'first post', requestedAction: 'current-prompt-stage2', templateId: null });
        const item2 = await createQueueItem({ chatId: 'chat-q', msgId: 11, messageText: 'second post', requestedAction: 'current-prompt-stage2', templateId: null });

        const p1 = enqueueGeneration(item1);
        const p2 = enqueueGeneration(item2);

        // Wait for the first item to actually reach the provider POST. Since the
        // Stop-all fix the per-request controller is registered BEFORE the chain
        // wait, so map size alone no longer means "started" — poll the image API
        // call instead, then take the (single) registered controller.
        let firstRequestId = null;
        for (let i = 0; i < 200; i++) {
            if (imageCallCount === 1 && coreState.activeGenerations.size > 0) {
                firstRequestId = coreState.activeGenerations.keys().next().value;
                break;
            }
            await new Promise(r => setTimeout(r, 5));
        }
        assert.ok(firstRequestId, 'first queue item must register a controller');
        assert.equal(imageCallCount, 1, 'only the first item has started');

        // Cancel just the first item; the shared queue controller stays intact.
        abortGeneration(firstRequestId);
        assert.equal(coreState.queueAbort?.signal?.aborted, false, 'queue controller not aborted by per-item cancel');

        const results = await Promise.allSettled([p1, p2]);
        assert.equal(results[0].status, 'rejected', 'first item rejected (cancelled)');
        assert.equal(results[1].status, 'fulfilled', 'second item still processed after single-item cancel');
        assert.equal(imageCallCount, 2, 'second item reached the image API');
    } finally {
        restore();
        globalThis.SillyTavern.getContext = baseCtx;
        stopQueue();
    }
});
