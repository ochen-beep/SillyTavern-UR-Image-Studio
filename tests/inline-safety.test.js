import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, abortAllGenerations } from '../src/core.js';
import { enqueueAutoLane } from '../src/autolane.js';
import { queueInlineJob } from '../src/inline/runner.js';
import { applyInlineRuntime } from '../src/ui/tab-media.js';
import { getConfig } from '../src/inline/store.js';

function context(id) { return { chatId: id, chatMetadata: {}, chat: [{ mes: 'test' }], saveMetadataDebounced() {} }; }

test('queued inline operation registers before dispatch and Stop cancels it', async () => {
    const oldST = globalThis.SillyTavern;
    const ctx = context('a');
    globalThis.SillyTavern = { getContext: () => ctx };
    let release;
    const blocker = enqueueAutoLane(() => new Promise(resolve => { release = resolve; }));
    await Promise.resolve();
    try {
        const pending = queueInlineJob({ msgId: 0, idx: 0, type: 'img', desc: 'test' });
        const result = assert.rejects(pending, e => e.code === 'ABORTED');
        assert.equal(state.activeGenerations.size, 1);
        abortAllGenerations();
        release();
        await blocker;
        await result;
        assert.equal(state.activeGenerations.size, 0);
    } finally { release?.(); globalThis.SillyTavern = oldST; }
});

test('queued inline operation cannot write into another chat', async () => {
    const oldST = globalThis.SillyTavern;
    let ctx = context('a');
    globalThis.SillyTavern = { getContext: () => ctx };
    let release;
    const blocker = enqueueAutoLane(() => new Promise(resolve => { release = resolve; }));
    await Promise.resolve();
    try {
        const pending = queueInlineJob({ msgId: 0, idx: 0, type: 'img', desc: 'test' });
        const result = assert.rejects(pending, e => e.code === 'ABORTED');
        ctx = context('b');
        release();
        await blocker;
        await result;
        assert.deepEqual(ctx.chatMetadata, {});
        assert.equal(state.activeGenerations.size, 0);
    } finally { release?.(); globalThis.SillyTavern = oldST; }
});

test('runtime master toggle opens and closes per-chat scanner gate', () => {
    const oldST = globalThis.SillyTavern;
    const settings = state.settings;
    const ctx = context('a');
    globalThis.SillyTavern = { getContext: () => ctx };
    try {
        state.settings = { inlineEnabled: true };
        applyInlineRuntime();
        assert.equal(getConfig().enabled, true);
        state.settings.inlineEnabled = false;
        applyInlineRuntime();
        assert.equal(getConfig().enabled, false);
    } finally { state.settings = settings; globalThis.SillyTavern = oldST; }
});
