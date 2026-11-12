// @ts-check
// force (2026-11-13): явное действие пользователя всегда рисует новую картинку —
// обе проверки отпечатка (done-fp до Stage 1 и между стадиями) и
// autoPromptFp-пропуск Stage 1 обходятся, но autoDoneFp после успеха пишется
// как раньше (автоматика не заплатит второй раз).
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

const INPUT = { chatId: 'chat-force', msgId: 4, messageText: 'Aria waits in the garden.', templateId: null };

let lfMock;
let coreState;
let llmCalls;
let imageCalls;

beforeEach(async () => {
    lfMock = makeInMemoryLFA();
    installStGlobals();
    llmCalls = 0;
    imageCalls = 0;
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
    const restore = mockFetch((url) => {
        imageCalls += 1;
        throw new Error(`unexpected image dispatch: ${url}`);
    });
    globalThis.__restoreImageMock = restore;
});

test('без force: done-fingerprint возвращает {applied:false} без Stage 1', async () => {
    const { runStage1ForDraft, runFullPipelineForDraft } = await import('../src/pipeline-stage1.js');
    const { getGenerationDraft, updateGenerationDraft } = await import('../src/generation-drafts.js');

    await runStage1ForDraft(INPUT, undefined, undefined, { isAuto: true });
    const draft = await getGenerationDraft(INPUT.chatId, INPUT.msgId, INPUT.messageText);
    await updateGenerationDraft(INPUT.chatId, INPUT.msgId, INPUT.messageText, d => ({ ...d, autoDoneFp: draft.autoPromptFp }));

    const result = await runFullPipelineForDraft(INPUT);
    assert.equal(result?.applied, false);
    assert.equal(result?.reason, 'auto-fingerprint-match');
    assert.equal(llmCalls, 1, 'ни одного нового LLM-вызова');
});

test('force:true обходит done-fingerprint — Stage 1 и Stage 2 выполняются', async () => {
    const { runStage1ForDraft, runFullPipelineForDraft } = await import('../src/pipeline-stage1.js');
    const { getGenerationDraft, updateGenerationDraft } = await import('../src/generation-drafts.js');

    await runStage1ForDraft(INPUT, undefined, undefined, { isAuto: true });
    const draft = await getGenerationDraft(INPUT.chatId, INPUT.msgId, INPUT.messageText);
    await updateGenerationDraft(INPUT.chatId, INPUT.msgId, INPUT.messageText, d => ({ ...d, autoDoneFp: draft.autoPromptFp }));

    await assert.rejects(
        runFullPipelineForDraft(INPUT, undefined, undefined, { force: true }),
        (e) => e?.name !== 'AbortError',
        'Stage 2 доходит до dispatch (нет провайдера — падает), значит done-fp обойдён',
    );
    assert.equal(llmCalls, 2, 'Stage 1 выполнился заново под force');
});

test('force:true обходит autoPromptFp-пропуск Stage 1', async () => {
    const { runStage1ForDraft, runFullPipelineForDraft } = await import('../src/pipeline-stage1.js');

    // Draft с autoPromptFp: обычный полный пайплайн переиспользует промпт
    // (Stage 1 LLM не вызывается), force — вызывает.
    await runStage1ForDraft(INPUT, undefined, undefined, { isAuto: true });
    assert.equal(llmCalls, 1);

    await assert.rejects(runFullPipelineForDraft(INPUT), (e) => e?.name !== 'AbortError');
    assert.equal(llmCalls, 1, 'промпт переиспользован — нового Stage 1 LLM нет');

    await assert.rejects(
        runFullPipelineForDraft(INPUT, undefined, undefined, { force: true }),
        (e) => e?.name !== 'AbortError',
    );
    assert.equal(llmCalls, 2, 'под force Stage 1 строит промпт заново');
});

test('force не роняет авто-семантику: обычный запуск без force не ломается', async () => {
    const { runFullPipelineForDraft } = await import('../src/pipeline-stage1.js');
    await assert.rejects(runFullPipelineForDraft(INPUT), (e) => e?.name !== 'AbortError');
    assert.equal(llmCalls, 1);
});
