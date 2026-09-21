// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SillyTavern = {
    getContext: () => ({ extensionSettings: {}, saveSettingsDebounced: () => {} }),
};

const { executeStage1 } = await import('../src/template-runtime.js');

test('stage 1 smoke: base template produces a plain prompt', async () => {
    const result = await executeStage1({
        template: null,
        messageText: 'Aria enters the room.',
        snapshot: {
            msgId: 1,
            contextRevision: 1,
            stage1Descriptions: [],
        },
        generateText: async () => 'A cinematic image prompt.',
    });
    assert.equal(result.templateType, 'base');
    assert.equal(result.prompt, 'A cinematic image prompt.');
    assert.equal(result.structuredDraft, null);
});

