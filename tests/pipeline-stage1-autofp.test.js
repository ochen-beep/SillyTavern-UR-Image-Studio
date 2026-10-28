// @ts-check
// Auto-run fingerprint: events-driven automation with identical scene content
// and generation settings must not spend a second LLM call; a settings change
// or a manual run bypasses the fingerprint entirely.
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

const INPUT = { chatId: 'chat-1', msgId: 4, messageText: 'Aria waits in the garden.', templateId: null };

let lfMock;
let coreState;
let llmCalls;

beforeEach(async () => {
    lfMock = makeInMemoryLFA();
    installStGlobals();
    llmCalls = 0;
    globalThis.SillyTavern.libs.localforage = lfMock;
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings: {
            connectionManager: { profiles: [{ id: 'text-conn', name: 'Test Text' }] },
        },
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
        ConnectionManagerRequestService: {
            sendRequest: async () => {
                llmCalls += 1;
                return { choices: [{ message: { content: 'llm response' } }] };
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

test('auto Stage 1 with identical content+settings is skipped by fingerprint', async () => {
    const { runStage1ForDraft } = await import('../src/pipeline-stage1.js');
    const first = await runStage1ForDraft(INPUT, undefined, undefined, { isAuto: true });
    assert.equal(first.applied, true, 'first auto run builds the prompt');
    assert.equal(llmCalls, 1);

    const second = await runStage1ForDraft(INPUT, undefined, undefined, { isAuto: true });
    assert.equal(second.applied, false);
    assert.equal(second.reason, 'auto-fingerprint-match');
    assert.equal(llmCalls, 1, 'no second LLM call for unchanged content+settings');
});

test('auto Stage 1 reruns when generation settings changed', async () => {
    const { runStage1ForDraft } = await import('../src/pipeline-stage1.js');
    await runStage1ForDraft(INPUT, undefined, undefined, { isAuto: true });
    assert.equal(llmCalls, 1);

    coreState.generationDefaults = { aspectRatio: '16:9' };
    const third = await runStage1ForDraft(INPUT, undefined, undefined, { isAuto: true });
    assert.equal(third.applied, true, 'settings change invalidates the fingerprint');
    assert.equal(llmCalls, 2);
});

test('manual Stage 1 never matches the auto fingerprint', async () => {
    const { runStage1ForDraft } = await import('../src/pipeline-stage1.js');
    await runStage1ForDraft(INPUT, undefined, undefined, { isAuto: true });
    const manual = await runStage1ForDraft(INPUT);
    assert.equal(manual.applied, true, 'manual run proceeds even with a matching fingerprint');
    assert.equal(llmCalls, 2);
});
