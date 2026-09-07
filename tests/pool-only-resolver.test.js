// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSceneContextSnapshot,
    normalizeSceneEntity,
    resolvePromptReferenceContext,
} from '../src/scene-context.js';

function entity(id, name, aliases) {
    return normalizeSceneEntity({ id, name, aliases, imagePath: `/${id}.png`, description: `${id} desc` });
}

test('pool-only resolver matches aliases and never the display name', async () => {
    const candidate = entity('rada', 'Пипа', ['Rada', 'Рада']);
    const byName = await resolvePromptReferenceContext({
        prompt: 'Пипа sits by the window',
        candidates: [candidate],
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });
    const byAlias = await resolvePromptReferenceContext({
        prompt: 'Rada sits by the window',
        candidates: [candidate],
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });

    assert.deepEqual(byName.stage2Refs, []);
    assert.deepEqual(byAlias.stage2Refs.map(ref => ref.id), ['rada']);
});

test('pool-only resolver keeps records without aliases manual-only', async () => {
    const candidate = entity('rada', 'Rada', []);
    const automatic = await resolvePromptReferenceContext({
        prompt: 'Rada sits by the window',
        candidates: [candidate],
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });
    const manual = await resolvePromptReferenceContext({
        prompt: '',
        candidates: [candidate],
        corrections: { includedIds: ['rada'], excludedIds: [], revision: 1 },
    });

    assert.deepEqual(automatic.stage2Refs, []);
    assert.deepEqual(manual.stage2Refs.map(ref => ref.id), ['rada']);
});

test('Stage 1 scene snapshot does not always include char or user roles', async () => {
    const snapshot = await buildSceneContextSnapshot({
        chatId: 'chat',
        msgId: 1,
        messageText: 'No aliases here',
        contextRevision: 0,
        candidates: [entity('rada', 'Rada', ['Рада'])],
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });

    assert.deepEqual(snapshot.entities, []);
    assert.deepEqual(snapshot.stage1Descriptions, []);
    assert.deepEqual(snapshot.stage2Refs, []);
});

test('Unicode case-fold-equivalent aliases fail closed as one ambiguity', async () => {
    const result = await resolvePromptReferenceContext({
        prompt: 's entered',
        candidates: [
            entity('latin-s', 'Latin S', ['s']),
            entity('long-s', 'Long S', ['ſ']),
        ],
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });

    assert.deepEqual(result.entities, []);
    assert.deepEqual(result.stage2Refs, []);
    assert.deepEqual(result.ambiguities, [{ mention: 's', candidateIds: ['latin-s', 'long-s'] }]);
});

test('duplicate aliases remain ambiguous regardless of display names or roles', async () => {
    const result = await resolvePromptReferenceContext({
        prompt: 'Mouse entered',
        candidates: [
            entity('one', 'Пипа', ['Mouse']),
            entity('two', 'Серая', ['Mouse']),
        ],
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });

    assert.deepEqual(result.stage2Refs, []);
    assert.deepEqual(result.ambiguities, [{ mention: 'mouse', candidateIds: ['one', 'two'] }]);
});
