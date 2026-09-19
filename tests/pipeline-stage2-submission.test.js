// @ts-check
// Stage 2 submit-time snapshots (opts.submission): ручной fire-and-forget
// отправляет промпт/параметры, зафиксированные в момент сабмита. Более новый
// драфт (перестроенный промпт) не протекает в платный запрос, не затирается
// прогоном и не роняет его через revision re-check.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, installStGlobals, makeReferenceStore } from './_helpers.js';
import { createRef, saveChatRefs } from '../src/refs-library.js';

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
let _chatMetadata;

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
    _chatMetadata = {};
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings,
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
        chat: [],
        chatId: 'test-chat',
        get chatMetadata() { return _chatMetadata; },
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
    const refsLibrary = await import('../src/refs-library.js');
    refsLibrary.resetRefStoreForTests();
    refsLibrary.setRefStoreForTests(makeReferenceStore());
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

// The submission prompt mentions Mira, so without a correction she WOULD be
// auto-matched — only the snapshot's excludedIds can keep her out. The draft
// holds empty corrections on purpose: a ternary regression back to
// draft.references must make this test fail (the ref would get fetched).

test('submission corrections win over empty draft corrections: excluded reference is never fetched or sent', async () => {
    const mira = await createRef({
        name: 'Mira', aliases: ['Mira'], description: 'scarfed detective',
        imagePath: 'https://cdn.example.test/mira-excluded.png',
    });
    saveChatRefs({ referenceIds: [mira.id] });

    const { updateGenerationDraft, getGenerationDraft } = await import('../src/generation-drafts.js');
    await updateGenerationDraft('test-chat', 21, 'A cat.', d => ({
        ...d, prompt: 'EDITED-LATER', aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
    }));

    const refFetches = [];
    const bodies = [];
    let sentRefs = null;
    const restore = mockFetch((url, options) => {
        const u = String(url);
        if (u.includes('cdn.example.test/mira-excluded.png')) {
            refFetches.push(u);
            return { ok: true, status: 200, json: async () => ({}) };
        }
        if (u.endsWith('/images/generations')) {
            bodies.push(String(options?.body || ''));
            return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'b3JkZXI=' }] }) };
        }
        if (u === '/api/images/upload') {
            return { ok: true, status: 200, json: async () => ({ path: 'user/images/UR%20Image%20Studio/submission-excluded.png' }) };
        }
        throw new Error(`unexpected ${url}`);
    });
    try {
        const { runStage2ForDraft } = await import('../src/pipeline-stage2.js');
        const entry = await runStage2ForDraft(
            { chatId: 'test-chat', msgId: 21, messageText: 'A cat.', templateId: null,
              chatConfig: { imageProfileId: connId, templateId: null, imageRoute: route } },
            undefined,
            undefined,
            { onRefsSent: refs => { sentRefs = refs; },
              submission: { prompt: 'SUBMITTED: Mira waves.', aspectRatio: '1:1', imageSize: '2K', quality: 'high',
                            references: { includedIds: [], excludedIds: [mira.id], revision: 1 } } },
        );
        assert.ok(entry, 'run completes');
        assert.deepEqual(sentRefs, [], 'excluded reference must not be materialized or sent');
        assert.deepEqual(refFetches, [], 'excluded reference image must never be fetched');
        assert.equal(bodies.length, 1);
        assert.match(bodies[0], /Mira waves/, 'the snapshot prompt still goes out; the correction only drops the image');
        const draft = await getGenerationDraft('test-chat', 21, 'A cat.');
        assert.equal(draft.stage2.status, 'ready');
    } finally {
        restore();
    }
});

test('submission corrections win over empty draft corrections: included reference is materialized and sent', async () => {
    const mira = await createRef({
        name: 'Mira', aliases: ['Mira'], description: 'scarfed detective',
        imagePath: 'https://cdn.example.test/mira-included.png',
    });
    saveChatRefs({ referenceIds: [mira.id] });

    const { updateGenerationDraft, getGenerationDraft } = await import('../src/generation-drafts.js');
    await updateGenerationDraft('test-chat', 22, 'A cat.', d => ({
        ...d, prompt: 'EDITED-LATER', aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
    }));

    const refFetches = [];
    let sentRefs = null;
    let editsImages = -1;
    let editsPrompt = '';
    const restore = mockFetch((url, options) => {
        const u = String(url);
        if (u.includes('cdn.example.test/mira-included.png')) {
            refFetches.push(u);
            return { ok: true, status: 200, json: async () => ({}) };
        }
        if (u.endsWith('/images/edits')) {
            const body = options?.body;
            editsPrompt = typeof body?.get === 'function' ? String(body.get('prompt') || '') : String(body || '');
            editsImages = typeof body?.getAll === 'function' ? body.getAll('image').length : -1;
            return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'b3JkZXI=' }] }) };
        }
        if (u === '/api/images/upload') {
            return { ok: true, status: 200, json: async () => ({ path: 'user/images/UR%20Image%20Studio/submission-included.png' }) };
        }
        throw new Error(`unexpected ${url}`);
    });
    try {
        const { runStage2ForDraft } = await import('../src/pipeline-stage2.js');
        const entry = await runStage2ForDraft(
            { chatId: 'test-chat', msgId: 22, messageText: 'A cat.', templateId: null,
              chatConfig: { imageProfileId: connId, templateId: null, imageRoute: route } },
            undefined,
            undefined,
            { onRefsSent: refs => { sentRefs = refs; },
              submission: { prompt: 'SUBMITTED portrait scene', aspectRatio: '1:1', imageSize: '2K', quality: 'high',
                            references: { includedIds: [mira.id], excludedIds: [], revision: 1 } } },
        );
        assert.ok(entry, 'run completes');
        // Neither the submission prompt nor the draft prompt mentions Mira:
        // only the snapshot's includedIds can pull her in.
        assert.deepEqual(sentRefs.map(ref => ref.id), [mira.id], 'snapshot include rescues the reference despite empty draft corrections');
        assert.equal(refFetches.length, 1, 'the included reference image is fetched exactly once');
        assert.equal(editsImages, 1, 'the reference reaches the paid request as an image');
        assert.match(editsPrompt, /SUBMITTED portrait scene/);
        const draft = await getGenerationDraft('test-chat', 22, 'A cat.');
        assert.equal(draft.stage2.status, 'ready');
    } finally {
        restore();
    }
});

test('a mid-run draft edit neither leaks into a submission run nor trips the revision guard', async () => {
    const mira = await createRef({
        name: 'Mira', aliases: ['Mira'], description: 'scarfed detective',
        imagePath: 'https://cdn.example.test/mira-midrun.png',
    });
    saveChatRefs({ referenceIds: [mira.id] });

    const { updateGenerationDraft, getGenerationDraft } = await import('../src/generation-drafts.js');
    await updateGenerationDraft('test-chat', 23, 'A cat.', d => ({
        ...d, prompt: 'EDITED-LATER', aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
    }));

    let releaseRefFetch;
    const refFetchGate = new Promise(resolve => { releaseRefFetch = resolve; });
    let refFetchSeen;
    const refFetchStarted = new Promise(resolve => { refFetchSeen = resolve; });

    const editsPrompts = [];
    const restore = mockFetch((url, options) => {
        const u = String(url);
        if (u.includes('cdn.example.test/mira-midrun.png')) {
            refFetchSeen();
            // Hold the materialize window open so the draft can be edited
            // exactly between input capture and snapshot creation.
            return refFetchGate.then(() => ({ ok: true, status: 200, json: async () => ({}) }));
        }
        if (u.endsWith('/images/edits')) {
            const body = options?.body;
            editsPrompts.push(typeof body?.get === 'function' ? String(body.get('prompt') || '') : String(body || ''));
            return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'b3JkZXI=' }] }) };
        }
        if (u === '/api/images/upload') {
            return { ok: true, status: 200, json: async () => ({ path: 'user/images/UR%20Image%20Studio/submission-midrun.png' }) };
        }
        throw new Error(`unexpected ${url}`);
    });
    try {
        const { runStage2ForDraft } = await import('../src/pipeline-stage2.js');
        const runPromise = runStage2ForDraft(
            { chatId: 'test-chat', msgId: 23, messageText: 'A cat.', templateId: null,
              chatConfig: { imageProfileId: connId, templateId: null, imageRoute: route } },
            undefined,
            undefined,
            { submission: { prompt: 'SUBMITTED scene', aspectRatio: '1:1', imageSize: '2K', quality: 'high',
                            references: { includedIds: [mira.id], excludedIds: [], revision: 1 } } },
        );

        // Pause inside reference materialization, then edit the live draft:
        // a reading run would either throw "Generation inputs changed" or pick
        // the edit up on re-read; a submission run must do neither.
        await refFetchStarted;
        await updateGenerationDraft('test-chat', 23, 'A cat.', d => ({ ...d, prompt: 'MUTATED-MIDRUN' }));
        releaseRefFetch();

        const entry = await runPromise;
        assert.ok(entry, 'run completes — submission runs never trip the revision re-check');
        // The entry carries the effective (binding-composed) prompt; the base
        // must be the submitted one, never the mid-run edit.
        assert.match(String(entry.prompt), /^SUBMITTED scene/, 'the mid-run edit must not leak into the paid request');
        assert.doesNotMatch(String(entry.prompt), /MUTATED-MIDRUN/);
        assert.equal(editsPrompts.length, 1);
        assert.match(editsPrompts[0], /SUBMITTED scene/);
        assert.doesNotMatch(editsPrompts[0], /MUTATED-MIDRUN/);

        const draft = await getGenerationDraft('test-chat', 23, 'A cat.');
        assert.equal(draft.prompt, 'MUTATED-MIDRUN', 'the editor edit survives the run for the next iteration');
        assert.equal(draft.stage2.status, 'ready');
    } finally {
        restore();
    }
});

test('malformed submission fails closed instead of degrading to the reading path', async () => {
    let providerPosts = 0;
    const restore = mockFetch((url) => {
        if (String(url).endsWith('/images/generations')) {
            providerPosts += 1;
            return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'b3JkZXI=' }] }) };
        }
        if (String(url) === '/api/images/upload') {
            return { ok: true, status: 200, json: async () => ({ path: 'user/images/UR%20Image%20Studio/submission-invalid.png' }) };
        }
        throw new Error(`unexpected ${url}`);
    });
    try {
        const { runStage2ForDraft } = await import('../src/pipeline-stage2.js');
        const input = { chatId: 'test-chat', msgId: 24, messageText: 'A cat.', templateId: null,
                        chatConfig: { imageProfileId: connId, templateId: null, imageRoute: route } };
        // A blank snapshot prompt must throw, never silently re-read the draft
        // and double-generate against inputs the submitter never saw.
        await assert.rejects(
            runStage2ForDraft(input, undefined, undefined, { submission: { prompt: '   ' } }),
            /prompt must be a non-empty string/,
        );
        await assert.rejects(
            runStage2ForDraft(input, undefined, undefined, { submission: { prompt: 42 } }),
            /prompt must be a non-empty string/,
        );
        // The two override modes are mutually exclusive.
        await assert.rejects(
            runStage2ForDraft(input, undefined, undefined, { submission: { prompt: 'ok' }, instruction: { prompt: 'also ok' } }),
            /mutually exclusive/,
        );
        assert.equal(providerPosts, 0, 'no paid request on malformed input');
        const { getGenerationDraft } = await import('../src/generation-drafts.js');
        const draft = await getGenerationDraft('test-chat', 24, 'A cat.');
        assert.equal(draft.stage2.status, 'error');
        assert.match(draft.stage2.error, /prompt must be a non-empty string/);
    } finally {
        restore();
    }
});
