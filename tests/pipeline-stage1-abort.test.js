// @ts-check
// Unit-тесты отмены Stage 1: регистрация контроллера в activeGenerations,
// per-request отмена через abortGeneration, каскад от внешнего (queue) сигнала
// и теги источника в uris:stage1-start/end.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals } from './_helpers.js';

globalThis.CustomEvent ||= class CustomEvent extends Event {
    #detail;
    get detail() { return this.#detail; }
    constructor(type, options = {}) {
        super(type);
        this.#detail = options.detail;
    }
};

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

const INPUT = { chatId: 'chat-1', msgId: 4, messageText: 'Aria waits in the garden.', templateId: null };

let lfMock;
let coreState;
let textResponse;
let onSendRequest = null;          // вызывается при старте sendRequest
let dispatchedEvents = [];
const sendControl = { hold: false, release: null };

beforeEach(async () => {
    lfMock = makeInMemoryLFA();
    installStGlobals();
    textResponse = 'llm response';
    onSendRequest = null;
    dispatchedEvents = [];
    sendControl.hold = false;
    sendControl.release = null;
    globalThis.window.dispatchEvent = (ev) => { dispatchedEvents.push(ev); return true; };
    globalThis.SillyTavern.libs.localforage = lfMock;
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings: {
            connectionManager: { profiles: [{ id: 'text-conn', name: 'Test Text' }] },
        },
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
        ConnectionManagerRequestService: {
            sendRequest: async () => {
                onSendRequest?.();
                if (sendControl.hold) {
                    return await new Promise((resolve) => { sendControl.release = resolve; });
                }
                return { choices: [{ message: { content: textResponse } }] };
            },
        },
        chat: [],
        chatId: 'test-chat',
    });
    const core = await import('../src/core.js');
    coreState = core.state;
    core.loadSettings();
    coreState.settings.apiSource = 'profile';
    coreState.settings.profileId = 'text-conn';
    coreState.activeGenerations.clear();
});

function startEvents() {
    return dispatchedEvents.filter(e => e.type === 'uris:stage1-start');
}

function endEvents() {
    return dispatchedEvents.filter(e => e.type === 'uris:stage1-end');
}

test('runStage1ForDraft registers an activeGenerations controller for the whole run', async () => {
    const { runStage1ForDraft } = await import('../src/pipeline-stage1.js');
    const runPromise = runStage1ForDraft(INPUT);
    await Promise.resolve();
    const requestIds = [...coreState.activeGenerations.keys()];
    assert.equal(requestIds.length, 1, 'exactly one Stage 1 controller is registered');
    await runPromise;
    assert.equal(coreState.activeGenerations.size, 0, 'controller is removed after the run');
});

test('abortGeneration cancels an in-flight Stage 1: AbortError, draft cancelled, cleanup, events', async () => {
    const { runStage1ForDraft } = await import('../src/pipeline-stage1.js');
    const { getGenerationDraft } = await import('../src/generation-drafts.js');
    const { abortGeneration } = await import('../src/core.js');

    sendControl.hold = true;
    const started = makeDeferred();
    onSendRequest = () => started.resolve();
    const runPromise = runStage1ForDraft(INPUT);
    await started.promise;
    const requestId = [...coreState.activeGenerations.keys()][0];

    assert.equal(abortGeneration(requestId), true);
    sendControl.release({ choices: [{ message: { content: 'late response' } }] });
    await assert.rejects(runPromise, (e) => e?.name === 'AbortError');

    const draft = await getGenerationDraft(INPUT.chatId, INPUT.msgId, INPUT.messageText);
    assert.equal(draft.stage1.status, 'cancelled', 'draft must be marked cancelled, not error');
    assert.equal(coreState.activeGenerations.has(requestId), false, 'registry entry removed in finally');

    assert.equal(startEvents().length, 1);
    assert.equal(endEvents().length, 1);
    assert.equal(endEvents()[0].detail.requestId, requestId);
});

test('an external (queue) signal abort cascades into Stage 1', async () => {
    const { runStage1ForDraft } = await import('../src/pipeline-stage1.js');
    const { getGenerationDraft } = await import('../src/generation-drafts.js');

    sendControl.hold = true;
    const external = new AbortController();
    const runPromise = runStage1ForDraft(INPUT, () => {}, external.signal);
    const started = makeDeferred();
    onSendRequest = () => started.resolve();
    await started.promise;

    external.abort();
    sendControl.release({ choices: [{ message: { content: 'late response' } }] });
    await assert.rejects(runPromise, (e) => e?.name === 'AbortError');

    const draft = await getGenerationDraft(INPUT.chatId, INPUT.msgId, INPUT.messageText);
    assert.equal(draft.stage1.status, 'cancelled');
    assert.equal(startEvents()[0].detail.source, 'queue', 'a run with an external signal is tagged as queue');
});

test('stage1-start tags the source: auto with opts.isAuto, queue with a signal, manual otherwise', async () => {
    const { runStage1ForDraft } = await import('../src/pipeline-stage1.js');
    await runStage1ForDraft(INPUT, () => {}, null, { isAuto: true });
    await runStage1ForDraft(INPUT, () => {}, new AbortController().signal);
    await runStage1ForDraft(INPUT);
    assert.deepEqual(startEvents().map(e => e.detail.source), ['auto', 'queue', 'manual']);
    assert.equal(endEvents().length, 3, 'every run emits a matching stage1-end');
    assert.equal(coreState.activeGenerations.size, 0);
});
