// @ts-check
// Tests generation-drafts: message identity, immutable records, and draft defaults.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Test harness: in-memory localforage + minimal SillyTavern stubs ──

function makeInMemoryLFA() {
    const store = new Map();
    const calls = [];
    return {
        getItem: async (k) => {
            calls.push({ method: 'getItem', key: k });
            return store.has(k) ? store.get(k) : null;
        },
        setItem: async (k, v) => {
            calls.push({ method: 'setItem', key: k });
            store.set(k, v);
        },
        removeItem: async (k) => {
            calls.push({ method: 'removeItem', key: k });
            store.delete(k);
        },
        keys: async () => Array.from(store.keys()),
        _store: store,
        _calls: calls,
        _clear() { store.clear(); calls.length = 0; },
    };
}

let lfMock;

function installGlobals() {
    lfMock = makeInMemoryLFA();
    globalThis.SillyTavern = {
        libs: { localforage: lfMock },
        getContext: () => ({
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getRequestHeaders: () => ({}),
        }),
    };
}

let drafts;

async function setup() {
    installGlobals();
    drafts = await import('../src/generation-drafts.js');
}

beforeEach(async () => {
    await setup();
});

// ── Tests ──

test('draft key and default are scoped by chatId plus msgId', async () => {
    const a = await drafts.getGenerationDraft('chat/a', 7, 'same message');
    const b = await drafts.getGenerationDraft('chat/a', 8, 'same message');
    assert.equal(drafts.generationDraftKey('chat/a', 7), 'uris_generation_draft:chat%2Fa:7');
    assert.equal(a.chatId, 'chat/a');
    assert.equal(a.msgId, 7);
    assert.equal(a.promptOrigin, 'empty');
    assert.equal(a.templateId, null);
    assert.deepEqual(a.references, { includedIds: [], excludedIds: [], revision: 0 });
    assert.notEqual(drafts.generationDraftKey(a.chatId, a.msgId), drafts.generationDraftKey(b.chatId, b.msgId));
});

test('deepFreezeSnapshot prevents nested mutation', () => {
    const frozen = drafts.deepFreezeSnapshot({ refs: [{ id: 'aria' }] });
    assert.throws(() => { frozen.refs[0].id = 'changed'; }, TypeError);
    assert.equal(frozen.refs[0].id, 'aria');
});

test('saveGenerationDraft omits reference data URLs while preserving stable fields and input', async () => {
    const draft = await drafts.getGenerationDraft('chat-1', 11, 'scene');
    const snapshot = {
        sourceMsgId: 11,
        refs: [{
            id: 'aria', name: 'Aria', imagePath: '/images/aria.png', url: 'https://example.test/aria.png',
            mime: 'image/png', width: 128, height: 256, revision: 3,
            dataUrl: 'data:image/png;base64,AAAA',
            nested: { dataUrl: 'data:image/png;base64,BBBB', keep: true },
        }],
    };
    const input = { ...draft, stage2: { ...draft.stage2, lastSubmittedSnapshot: snapshot } };

    await drafts.saveGenerationDraft(input);

    const saved = lfMock._store.get(drafts.generationDraftKey('chat-1', 11));
    assert.deepEqual(saved.stage2.lastSubmittedSnapshot.refs, [{
        id: 'aria', name: 'Aria', imagePath: '/images/aria.png', url: 'https://example.test/aria.png',
        mime: 'image/png', width: 128, height: 256, revision: 3,
        nested: { keep: true },
    }]);
    assert.equal(snapshot.refs[0].dataUrl, 'data:image/png;base64,AAAA');
    assert.equal(snapshot.refs[0].nested.dataUrl, 'data:image/png;base64,BBBB');
});

test('loading an old draft with reference data URLs remains compatible', async () => {
    const key = drafts.generationDraftKey('chat-legacy', 12);
    const old = drafts.createGenerationDraft('chat-legacy', 12, 'scene');
    old.stage2.lastSubmittedSnapshot = { refs: [{ id: 'legacy', dataUrl: 'data:image/png;base64,old' }] };
    lfMock._store.set(key, old);

    const loaded = await drafts.getGenerationDraft('chat-legacy', 12, 'scene');

    assert.equal(loaded.stage2.lastSubmittedSnapshot.refs[0].dataUrl, 'data:image/png;base64,old');
});

test('updateGenerationDraft validates identity', async () => {
    await drafts.getGenerationDraft('chat-1', 4, 'text');
    await assert.rejects(
        () => drafts.updateGenerationDraft('chat-1', 4, 'text', (d) => ({ ...d, chatId: 'other' })),
        /chatId cannot be changed/
    );
    await assert.rejects(
        () => drafts.updateGenerationDraft('chat-1', 4, 'text', (d) => ({ ...d, msgId: 99 })),
        /msgId cannot be changed/
    );
});

// ── Template selection mode and resolver ──

test('new drafts follow the active template by default', async () => {
    const draft = await drafts.getGenerationDraft('chat-1', 7, 'scene');
    assert.equal(draft.templateSelection, 'default');
    assert.equal(drafts.resolveDraftTemplateId(draft, 'tpl-active'), 'tpl-active');
});

test('override template wins over active template', () => {
    const draft = { templateSelection: 'override', templateId: 'tpl-local' };
    assert.equal(drafts.resolveDraftTemplateId(draft, 'tpl-active'), 'tpl-local');
});

test('explicit base override remains base', () => {
    const draft = { templateSelection: 'override', templateId: null };
    assert.equal(drafts.resolveDraftTemplateId(draft, 'tpl-active'), null);
});

test('obsolete per-chat instruction keys are ignored without localforage access', async () => {
    const chatId = 'chat-legacy';
    const msgId = 8;
    const messageText = 'scene';
    const legacyInstructionKey = `uris_instruction_${chatId}`;
    const draftKey = drafts.generationDraftKey(chatId, msgId);
    lfMock._store.set(legacyInstructionKey, { draft: 'legacy instruction' });

    const draft = await drafts.getGenerationDraft(chatId, msgId, messageText);

    assert.equal(draft.prompt, '');
    assert.deepEqual(lfMock._calls, [
        { method: 'getItem', key: draftKey },
        { method: 'setItem', key: draftKey },
    ]);
    assert.deepEqual(lfMock._store.get(legacyInstructionKey), { draft: 'legacy instruction' });
});

test('message-scoped corrections persist per chatId + msgId and do not leak', async () => {
    const corrected = await drafts.updateGenerationDraft('chat-1', 4, 'scene', d => ({
        ...d,
        references: { includedIds: ['aaron'], excludedIds: ['beth'], revision: 1 },
    }));
    assert.deepEqual(corrected.references, { includedIds: ['aaron'], excludedIds: ['beth'], revision: 1 });

    const reloaded = await drafts.getGenerationDraft('chat-1', 4, 'scene');
    assert.deepEqual(reloaded.references, { includedIds: ['aaron'], excludedIds: ['beth'], revision: 1 });

    const otherChat = await drafts.getGenerationDraft('chat-2', 4, 'scene');
    assert.deepEqual(otherChat.references, { includedIds: [], excludedIds: [], revision: 0 });

    const otherMsg = await drafts.getGenerationDraft('chat-1', 5, 'scene');
    assert.deepEqual(otherMsg.references, { includedIds: [], excludedIds: [], revision: 0 });
});

test('resolveDraftTemplateId follows active template only for default drafts', () => {
    const defaultDraft = { templateSelection: 'default', templateId: null };
    const overrideDraft = { templateSelection: 'override', templateId: 'tpl-override' };
    assert.equal(drafts.resolveDraftTemplateId(defaultDraft, 'tpl-a'), 'tpl-a');
    assert.equal(drafts.resolveDraftTemplateId(overrideDraft, 'tpl-a'), 'tpl-override');
    assert.equal(drafts.resolveDraftTemplateId(defaultDraft, 'tpl-b'), 'tpl-b');
    assert.equal(drafts.resolveDraftTemplateId(overrideDraft, 'tpl-b'), 'tpl-override');
});

test('applyStage1Result keeps default draft templateId as null even when result carries templateId', async () => {
    const draft = await drafts.getGenerationDraft('chat-1', 13, 'scene');
    assert.equal(draft.templateSelection, 'default');

    const result = await drafts.applyStage1Result(
        draft,
        0,
        0,
        { prompt: 'prompt from stage1', templateId: 'tpl-result' },
        'scene',
    );

    assert.equal(result.applied, true);
    assert.equal(result.draft.templateSelection, 'default');
    assert.equal(result.draft.templateId, null);
});

test('sweepStaleRunningDrafts folds running stages back to idle and leaves other statuses intact', async () => {
    const runningKey = drafts.generationDraftKey('chat-run', 1);
    const readyKey = drafts.generationDraftKey('chat-ready', 2);
    const cancelledKey = drafts.generationDraftKey('chat-cxl', 3);
    const otherKey = 'some_other_extension_key';

    lfMock._store.set(runningKey, {
        chatId: 'chat-run', msgId: 1,
        stage1: { status: 'running', error: null, runToken: 5 },
        stage2: { status: 'running', error: 'boom', lastSubmittedSnapshot: null },
        prompt: 'p', references: { includedIds: ['aria'], excludedIds: [], revision: 2 },
    });
    lfMock._store.set(readyKey, {
        chatId: 'chat-ready', msgId: 2,
        stage1: { status: 'ready', error: null },
        stage2: { status: 'idle', error: null, lastSubmittedSnapshot: null },
    });
    lfMock._store.set(cancelledKey, {
        chatId: 'chat-cxl', msgId: 3,
        stage1: { status: 'cancelled', error: null },
        stage2: { status: 'error', error: 'kept' },
    });
    lfMock._store.set(otherKey, { whatever: true });

    await drafts.sweepStaleRunningDrafts();

    const running = lfMock._store.get(runningKey);
    assert.equal(running.stage1.status, 'idle', 'running stage1 -> idle');
    assert.equal(running.stage1.error, null);
    assert.equal(running.stage1.runToken, 5, 'non-status fields preserved');
    assert.equal(running.stage2.status, 'idle', 'running stage2 -> idle');
    assert.equal(running.stage2.error, null);
    assert.deepEqual(running.references, { includedIds: ['aria'], excludedIds: [], revision: 2 }, 'refs untouched');

    const ready = lfMock._store.get(readyKey);
    assert.equal(ready.stage1.status, 'ready', 'ready left intact');
    assert.equal(ready.stage2.status, 'idle');

    const cancelled = lfMock._store.get(cancelledKey);
    assert.equal(cancelled.stage1.status, 'cancelled', 'cancelled left intact');
    assert.equal(cancelled.stage2.status, 'error', 'error left intact');
    assert.equal(cancelled.stage2.error, 'kept');

    assert.deepEqual(lfMock._store.get(otherKey), { whatever: true }, 'non-draft keys untouched');
});

test('sweepStaleRunningDrafts is a no-op when localforage has no keys()', async () => {
    globalThis.SillyTavern.libs.localforage = { getItem: async () => null, setItem: async () => {} };
    await assert.doesNotReject(drafts.sweepStaleRunningDrafts());
});
