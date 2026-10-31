// @ts-check
// Done-fingerprint re-read between the paid stages: a parallel trigger that
// completes the same run while this Stage 1 is in flight must not let this
// Stage 2 fire a second paid image request.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals, mockFetch } from './_helpers.js';

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

const INPUT = { chatId: 'chat-reread', msgId: 4, messageText: 'Aria waits in the garden.', templateId: null };

let lfMock;
let coreState;
let llmCalls;
let imageCalls;
let releaseLlm;
let llmGate;

beforeEach(async () => {
    lfMock = makeInMemoryLFA();
    installStGlobals();
    llmCalls = 0;
    imageCalls = 0;
    releaseLlm = null;
    llmGate = null;
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
                if (llmCalls > 1 && llmGate) await llmGate;
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
    const restore = mockFetch((url) => {
        imageCalls += 1;
        throw new Error(`unexpected image dispatch: ${url}`);
    });
    // The mock must survive into the test body (Stage 2 would hit it).
    globalThis.__restoreImageMock = restore;
});

test('sibling completion between the stages skips the second Stage 2', async () => {
    const { runStage1ForDraft, runFullPipelineForDraft } = await import('../src/pipeline-stage1.js');
    const { getGenerationDraft, updateGenerationDraft } = await import('../src/generation-drafts.js');

    // Stage 1 once: the draft now carries the auto fingerprint of this input.
    await runStage1ForDraft(INPUT, undefined, undefined, { isAuto: true });
    const draft = await getGenerationDraft(INPUT.chatId, INPUT.msgId, INPUT.messageText);
    const fp = draft.autoPromptFp;
    assert.ok(fp, 'auto fingerprint captured');

    // Make Stage 1 re-run for the same input (the fingerprint gate in Stage 1
    // no longer matches) and hold it inside the LLM call.
    await updateGenerationDraft(INPUT.chatId, INPUT.msgId, INPUT.messageText, d => ({ ...d, autoPromptFp: undefined }));
    llmGate = new Promise(resolve => { releaseLlm = resolve; });

    const pipelinePromise = runFullPipelineForDraft(INPUT);
    await new Promise(resolve => setImmediate(resolve));
    // "Sibling tab" completes the same run while this Stage 1 is in flight.
    await updateGenerationDraft(INPUT.chatId, INPUT.msgId, INPUT.messageText, d => ({ ...d, autoDoneFp: fp }));
    releaseLlm();

    const result = await pipelinePromise;
    assert.equal(result?.reason, 'auto-fingerprint-match', 'run reports the sibling already finished it');
    assert.equal(result?.result, null, 'no Stage 2 card of our own');
    assert.equal(imageCalls, 0, 'no second paid image dispatch');
});

test('without a sibling completion the full pipeline proceeds past the re-read', async () => {
    const { runFullPipelineForDraft } = await import('../src/pipeline-stage1.js');
    // No image provider configured: Stage 2 rejects — which is exactly the
    // proof that the pipeline did NOT stop at the between-stages check.
    await assert.rejects(runFullPipelineForDraft(INPUT), (e) => e?.name !== 'AbortError');
    assert.equal(llmCalls, 1, 'Stage 1 ran for real (not fingerprint-skipped)');
});
