// @ts-check
// Stage 2 submit-time snapshots (opts.submission): ручной fire-and-forget
// отправляет промпт/параметры, зафиксированные в момент сабмита. Более новый
// драфт (перестроенный промпт) не протекает в платный запрос, не затирается
// прогоном и не роняет его через revision re-check.
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

let lfMock;
let coreState;
let extensionSettings;

const connId = 'submission-conn';
const route = {
    source: 'openai-models',
    modelId: 'gpt-image-1',
    generationContract: 'openai-images',
    contractVersion: 1,
    capabilities: { generate: 'supported', references: 'supported', edit: 'unknown', maxReferences: 5 },
    transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
};

beforeEach(async () => {
    lfMock = makeInMemoryLFA();
    installStGlobals();
    globalThis.SillyTavern.libs.localforage = lfMock;
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
    const { createConnection } = await import('../src/connection-store.js');
    await createConnection({ id: connId, kind: 'image', name: `Test ${connId}`, endpoint: 'https://api.openai.test/v1', selectedRoute: route });
    await lfMock.setItem(`uris_api_key:${connId}`, 'test-key');

    const proxy = await import('../src/proxy.js');
    proxy._resetCache();
    proxy.clearHostStrategy();
    coreState.queue = [];
    coreState.queueRunning = false;
    coreState.queueAbort = null;
    coreState.stage2Chains = new Map();
});

test('submission prompt wins over a newer draft prompt; the draft is never rewritten', async () => {
    const { updateGenerationDraft, getGenerationDraft } = await import('../src/generation-drafts.js');
    // Драфт уже хранит СЛЕДУЮЩУЮ итерацию: пользователь перестроил промпт уже
    // после сабмита. Прогон должен уйти с «SUBMITTED», драфт — не пострадать.
    await updateGenerationDraft('test-chat', 20, 'A cat.', d => ({
        ...d, prompt: 'EDITED-LATER', aspectRatio: '16:9', imageSize: '1K', quality: 'auto',
    }));

    const bodies = [];
    const restore = mockFetch((url, options) => {
        if (String(url).endsWith('/images/generations')) {
            bodies.push(String(options?.body || ''));
            return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'b3JkZXI=' }] }) };
        }
        if (String(url) === '/api/images/upload') {
            return { ok: true, status: 200, json: async () => ({ path: 'user/images/UR%20Image%20Studio/submission.png' }) };
        }
        throw new Error(`unexpected ${url}`);
    });
    try {
        const { runStage2ForDraft } = await import('../src/pipeline-stage2.js');
        const entry = await runStage2ForDraft(
            { chatId: 'test-chat', msgId: 20, messageText: 'A cat.', templateId: null,
              chatConfig: { imageProfileId: connId, templateId: null, imageRoute: route } },
            undefined,
            undefined,
            { submission: { prompt: 'SUBMITTED', aspectRatio: '1:1', imageSize: '2K', quality: 'high',
                            references: { includedIds: [], excludedIds: [], revision: 0 } } },
        );
        assert.ok(entry, 'run completes despite the draft having moved on');
        assert.equal(entry.prompt, 'SUBMITTED');
        assert.equal(entry.aspectRatio, '1:1', 'snapshot params win over the draft (16:9)');
        assert.equal(entry.imageSize, '2K', 'snapshot params win over the draft (1K)');
        assert.equal(entry.quality, 'high');
        assert.equal(bodies.length, 1);
        assert.match(bodies[0], /SUBMITTED/);
        assert.doesNotMatch(bodies[0], /EDITED-LATER/);
        const draft = await getGenerationDraft('test-chat', 20, 'A cat.');
        assert.equal(draft.prompt, 'EDITED-LATER', 'editor state survives the run');
        assert.equal(draft.aspectRatio, '16:9');
        assert.equal(draft.stage2.status, 'ready');
    } finally {
        restore();
    }
});
