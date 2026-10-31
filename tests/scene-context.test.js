// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    matchesScenePhrase,
    normalizeSceneEntity,
    normalizeAliases,
    resolvePromptReferenceContext,
} from '../src/scene-context.js';
import { materializeStage2References } from '../src/references.js';

globalThis.FileReader ??= class FileReader {
    readAsDataURL(blob) {
        setTimeout(() => {
            this.result = 'data:image/png;base64,ZmFrZQ==';
            this.onloadend?.();
        }, 0);
    }
};

test('matchesScenePhrase matches whole name and alias only', () => {
    assert.equal(matchesScenePhrase('Aria Rose', 'Aria Rose entered.'), true);
    assert.equal(matchesScenePhrase('Aria Rose', 'Rose entered.'), false);
    assert.equal(matchesScenePhrase('Aria', 'Ariana entered.'), false);
    assert.equal(matchesScenePhrase('Ария', '«Ария» вошла.'), true);
    assert.equal(matchesScenePhrase('A.B', 'A.B waits'), true);
    assert.equal(matchesScenePhrase('Aria', 'category'), false);
    assert.equal(matchesScenePhrase('Aria', 'Aria'), true);
});

test('matchesScenePhrase is case-insensitive and Unicode-aware', () => {
    assert.equal(matchesScenePhrase('ария', 'Ария вошла'), true);
    assert.equal(matchesScenePhrase('Aria', 'ARIA yelled'), true);
});

test('normalizeSceneEntity deduplicates aliases and drops name match', () => {
    const entity = normalizeSceneEntity({
        id: 'aria',
        name: 'Aria Rose',
        aliases: [' Aria ', 'Ария', 'Aria'],
        keywords: ['red dress'],
        description: 'red dress',
        imagePath: '/aria.png',
    });
    assert.deepEqual(entity.aliases, ['Aria', 'Ария']);
    assert.equal(entity.id, 'aria');
    assert.equal(entity.name, 'Aria Rose');
    assert.equal(entity.description, 'red dress');
    assert.equal(entity.imagePath, '/aria.png');
});

test('normalizeAliases handles array, comma, newline, and empty', () => {
    assert.deepEqual(normalizeAliases([' Aria ', 'Ария', 'Aria']), ['Aria', 'Ария']);
    assert.deepEqual(normalizeAliases('Aria, Ария, Aria'), ['Aria', 'Ария']);
    assert.deepEqual(normalizeAliases('Aria\nАрия'), ['Aria', 'Ария']);
    assert.deepEqual(normalizeAliases(null), []);
    assert.deepEqual(normalizeAliases(''), []);
    assert.deepEqual(normalizeAliases([]), []);
});

import { buildSceneContextSnapshot } from '../src/scene-context.js';
import { hashMessage } from '../src/generation-drafts.js';

function makeEntity(id, name, aliases, description = '', imagePath = '') {
    return normalizeSceneEntity({ id, name, aliases, description, imagePath });
}

test('buildSceneContextSnapshot orders entities and builds shared descriptions/refs', async () => {
    const candidates = [
        makeEntity('char', 'Mira', ['Mira'], 'Main character', '/char.png'),
        makeEntity('user', 'Alex', ['Alex'], 'User persona', '/user.png'),
        makeEntity('aria', 'Aria Rose', ['Aria'], 'An NPC', '/aria.png'),
        makeEntity('borin', 'Borin', ['Borin'], 'Another NPC', '/borin.png'),
        makeEntity('manual', 'Manual', [], 'Manual include', '/manual.png'),
    ];

    const snapshot = await buildSceneContextSnapshot({
        chatId: 'chat-1',
        msgId: 9,
        messageText: 'Mira met Aria. Later Borin waved.',
        contextRevision: 3,
        candidates,
        corrections: { includedIds: ['manual'], excludedIds: ['borin'], revision: 2 },
    });

    assert.deepEqual(snapshot.entities.map(x => x.id), ['manual', 'char', 'aria']);
    assert.deepEqual(snapshot.stage1Descriptions.map(x => x.id), ['manual', 'char', 'aria']);
    assert.deepEqual(snapshot.stage2Refs.map(x => x.id), ['manual', 'char', 'aria']);
    assert.deepEqual(snapshot.matchedReferences, [
        { id: 'char', name: 'Mira', matchedPhrases: ['Mira'], effective: true },
        { id: 'aria', name: 'Aria Rose', matchedPhrases: ['Aria'], effective: true },
        { id: 'borin', name: 'Borin', matchedPhrases: ['Borin'], effective: false },
    ]);
    assert.equal(snapshot.contextRevision, 3);
    assert.equal(snapshot.messageHash, hashMessage('Mira met Aria. Later Borin waved.'));
    assert.throws(() => { snapshot.entities.push(candidates[0]); }, TypeError);
});

test('buildSceneContextSnapshot detects ambiguous aliases', async () => {
    const candidates = [
        makeEntity('aria-rose', 'Aria Rose', ['Rose'], 'First rose', '/rose1.png'),
        makeEntity('rose-smith', 'Rose Smith', ['Rose'], 'Second rose', '/rose2.png'),
    ];

    const snapshot = await buildSceneContextSnapshot({
        chatId: 'chat-1',
        msgId: 9,
        messageText: 'Rose entered.',
        contextRevision: 1,
        candidates,
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });

    assert.deepEqual(snapshot.entities.map(x => x.id), []);
    assert.deepEqual(snapshot.ambiguities, [{ mention: 'rose', candidateIds: ['aria-rose', 'rose-smith'] }]);
    assert.deepEqual(snapshot.matchedReferences, [
        { id: 'aria-rose', name: 'Aria Rose', matchedPhrases: ['Rose'], effective: false },
        { id: 'rose-smith', name: 'Rose Smith', matchedPhrases: ['Rose'], effective: false },
    ]);
});

test('buildSceneContextSnapshot manual inclusion resolves ambiguity', async () => {
    const candidates = [
        makeEntity('aria-rose', 'Aria Rose', ['Rose'], 'First rose', '/rose1.png'),
        makeEntity('rose-smith', 'Rose Smith', ['Rose'], 'Second rose', '/rose2.png'),
    ];

    const snapshot = await buildSceneContextSnapshot({
        chatId: 'chat-1',
        msgId: 9,
        messageText: 'Rose entered.',
        contextRevision: 1,
        candidates,
        corrections: { includedIds: ['aria-rose'], excludedIds: [], revision: 0 },
    });

    assert.deepEqual(snapshot.entities.map(x => x.id), ['aria-rose']);
    assert.deepEqual(snapshot.ambiguities, [{ mention: 'rose', candidateIds: ['aria-rose', 'rose-smith'] }]);
});

test('buildSceneContextSnapshot orders NPCs by first mention index', async () => {
    const candidates = [
        makeEntity('borin', 'Borin', ['Borin'], 'Borin', '/borin.png'),
        makeEntity('aria', 'Aria Rose', ['Aria'], 'Aria', '/aria.png'),
    ];

    const snapshot = await buildSceneContextSnapshot({
        chatId: 'chat-1',
        msgId: 9,
        messageText: 'Aria waved. Borin nodded.',
        contextRevision: 1,
        candidates,
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });

    assert.deepEqual(snapshot.entities.map(x => x.id), ['aria', 'borin']);
});

test('materializeStage2References loads images in snapshot order', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        blob: async () => new Blob(['fake'], { type: 'image/png' }),
    });
    try {
        const snapshot = await buildSceneContextSnapshot({
            chatId: 'chat-1',
            msgId: 9,
            messageText: 'Aria and Borin.',
            contextRevision: 1,
            candidates: [
                makeEntity('aria', 'Aria Rose', ['Aria'], 'Aria', '/aria.png'),
                makeEntity('borin', 'Borin', ['Borin'], 'Borin', '/borin.png'),
            ],
            corrections: { includedIds: [], excludedIds: [], revision: 0 },
        });
        const refs = await materializeStage2References(snapshot);
        assert.deepEqual(refs.map(r => r.id), ['aria', 'borin']);
        assert.equal(refs[0].name, 'Aria Rose');
        assert.match(refs[0].dataUrl, /^data:image\/png;/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('materializeStage2References throws when image unavailable', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    try {
        const snapshot = await buildSceneContextSnapshot({
            chatId: 'chat-1',
            msgId: 9,
            messageText: 'Aria.',
            contextRevision: 1,
            candidates: [makeEntity('aria', 'Aria Rose', ['Aria'], 'Aria', '/missing.png')],
            corrections: { includedIds: [], excludedIds: [], revision: 0 },
        });
        // Name and path, not the internal id: this text surfaces to the user.
        await assert.rejects(
            () => materializeStage2References(snapshot),
            error => error?.code === 'REFERENCE_FILE_MISSING'
                && /Aria Rose \(\/missing\.png\)/.test(error.message)
                && /Data Maid/.test(error.message),
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ── Prompt-driven Stage 2 reference resolver ──

test('resolvePromptReferenceContext follows prompt, not source message text', async () => {
    const candidates = [
        makeEntity('char', 'Mira', ['Mira'], 'Main character', '/char.png'),
        makeEntity('aria', 'Aria Rose', ['Aria'], 'An NPC', '/aria.png'),
        makeEntity('borin', 'Borin', ['Borin'], 'Another NPC', '/borin.png'),
    ];

    const stage2 = await resolvePromptReferenceContext({
        prompt: 'Aria smiles.',
        candidates,
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });

    assert.deepEqual(stage2.entities.map(x => x.id), ['aria']);
    assert.deepEqual(stage2.stage2Refs.map(x => x.id), ['aria']);
});

test('resolvePromptReferenceContext includes char/user only when their names appear in prompt', async () => {
    const candidates = [
        makeEntity('char', 'Mira', ['Mira'], 'Main character', '/char.png'),
        makeEntity('user', 'Alex', ['Alex'], 'User persona', '/user.png'),
        makeEntity('aria', 'Aria Rose', ['Aria'], 'An NPC', '/aria.png'),
    ];

    const onlyMira = await resolvePromptReferenceContext({
        prompt: 'Mira looks at the sky.',
        candidates,
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });
    assert.deepEqual(onlyMira.entities.map(x => x.id), ['char']);

    const allMentioned = await resolvePromptReferenceContext({
        prompt: 'Mira and Alex welcome Aria.',
        candidates,
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });
    assert.deepEqual(allMentioned.entities.map(x => x.id), ['char', 'user', 'aria']);

    const noneMentioned = await resolvePromptReferenceContext({
        prompt: 'The sky is clear.',
        candidates,
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });
    assert.deepEqual(noneMentioned.entities.map(x => x.id), []);
});

test('resolvePromptReferenceContext uses strict name and alias matching', async () => {
    const candidates = [
        makeEntity('aria', 'Aria Rose', ['Aria'], 'red dress', '/aria.png'),
    ];

    const byAlias = await resolvePromptReferenceContext({
        prompt: 'Aria waits.',
        candidates,
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });
    assert.deepEqual(byAlias.entities.map(x => x.id), ['aria']);

    const byFullName = await resolvePromptReferenceContext({
        prompt: 'Aria Rose waits.',
        candidates,
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });
    assert.deepEqual(byFullName.entities.map(x => x.id), ['aria']);

    const byKeyword = await resolvePromptReferenceContext({
        prompt: 'The red dress waits.',
        candidates,
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });
    assert.deepEqual(byKeyword.entities.map(x => x.id), []);
});

test('resolvePromptReferenceContext respects empty prompt and Unicode boundaries', async () => {
    const candidates = [
        makeEntity('aria', 'Ария', ['Ария'], 'Aria', '/aria.png'),
        makeEntity('ariana', 'Ariana', ['Ariana'], 'Ariana', '/ariana.png'),
    ];

    const empty = await resolvePromptReferenceContext({
        prompt: '',
        candidates,
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });
    assert.deepEqual(empty.entities.map(x => x.id), []);

    const unicode = await resolvePromptReferenceContext({
        prompt: 'ария вошла',
        candidates,
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });
    assert.deepEqual(unicode.entities.map(x => x.id), ['aria']);

    const boundary = await resolvePromptReferenceContext({
        prompt: 'Ariana entered.',
        candidates,
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });
    assert.deepEqual(boundary.entities.map(x => x.id), ['ariana']);
});

test('resolvePromptReferenceContext orders manual references first, then all entities by first prompt mention', async () => {
    const candidates = [
        makeEntity('char', 'Mira', ['Mira'], 'Main', '/char.png'),
        makeEntity('user', 'Alex', ['Alex'], 'User', '/user.png'),
        makeEntity('aria', 'Aria Rose', ['Aria'], 'NPC A', '/aria.png'),
        makeEntity('borin', 'Borin', ['Borin'], 'NPC B', '/borin.png'),
        makeEntity('manual', 'Manual', [], 'Manual', '/manual.png'),
    ];

    const result = await resolvePromptReferenceContext({
        prompt: 'Borin and Aria meet. Mira watches.',
        candidates,
        corrections: { includedIds: ['manual', 'user'], excludedIds: [], revision: 2 },
    });

    assert.deepEqual(result.entities.map(x => x.id), ['manual', 'user', 'borin', 'aria', 'char']);
    assert.equal(result.referencesRevision, 2);
});

test('resolvePromptReferenceContext exclusions win over mentions and manual includes', async () => {
    const candidates = [
        makeEntity('aria', 'Aria Rose', ['Aria'], 'Aria', '/aria.png'),
        makeEntity('borin', 'Borin', ['Borin'], 'Borin', '/borin.png'),
    ];

    const result = await resolvePromptReferenceContext({
        prompt: 'Aria and Borin stand together.',
        candidates,
        corrections: { includedIds: ['aria'], excludedIds: ['aria', 'borin'], revision: 1 },
    });

    assert.deepEqual(result.entities.map(x => x.id), []);
    assert.equal(result.stage2Refs.length, 0);
});

test('resolvePromptReferenceContext reports ambiguous aliases', async () => {
    const candidates = [
        makeEntity('aria-rose', 'Aria Rose', ['Rose'], 'First rose', '/rose1.png'),
        makeEntity('rose-smith', 'Rose Smith', ['Rose'], 'Second rose', '/rose2.png'),
    ];

    const result = await resolvePromptReferenceContext({
        prompt: 'Rose entered.',
        candidates,
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });

    assert.deepEqual(result.entities.map(x => x.id), []);
    assert.deepEqual(result.ambiguities, [{ mention: 'rose', candidateIds: ['aria-rose', 'rose-smith'] }]);
});

test('resolvePromptReferenceContext manual inclusion resolves ambiguity', async () => {
    const candidates = [
        makeEntity('aria-rose', 'Aria Rose', ['Rose'], 'First rose', '/rose1.png'),
        makeEntity('rose-smith', 'Rose Smith', ['Rose'], 'Second rose', '/rose2.png'),
    ];

    const result = await resolvePromptReferenceContext({
        prompt: 'Rose entered.',
        candidates,
        corrections: { includedIds: ['aria-rose'], excludedIds: [], revision: 0 },
    });

    assert.deepEqual(result.entities.map(x => x.id), ['aria-rose']);
    assert.deepEqual(result.ambiguities, [{ mention: 'rose', candidateIds: ['aria-rose', 'rose-smith'] }]);
});

test('resolvePromptReferenceContext stage2Refs only includes entities with imagePath', async () => {
    const candidates = [
        makeEntity('aria', 'Aria Rose', ['Aria'], 'Aria', '/aria.png'),
        makeEntity('borin', 'Borin', ['Borin'], 'Borin', ''),
    ];

    const result = await resolvePromptReferenceContext({
        prompt: 'Aria and Borin stand together.',
        candidates,
        corrections: { includedIds: [], excludedIds: [], revision: 0 },
    });

    assert.deepEqual(result.entities.map(x => x.id), ['aria', 'borin']);
    assert.deepEqual(result.stage2Refs.map(x => x.id), ['aria']);
    assert.deepEqual(result.stage2Refs[0], { id: 'aria', name: 'Aria Rose', imagePath: '/aria.png' });
});

test('resolvePromptReferenceContext returns deep-frozen object with promptHash', async () => {
    const candidates = [
        makeEntity('aria', 'Aria Rose', ['Aria'], 'Aria', '/aria.png'),
    ];

    const result = await resolvePromptReferenceContext({
        prompt: 'Aria waits.',
        candidates,
        corrections: { includedIds: [], excludedIds: [], revision: 3 },
    });

    assert.equal(result.promptHash, hashMessage('Aria waits.'));
    assert.equal(result.referencesRevision, 3);
    assert.throws(() => { result.entities.push(candidates[0]); }, TypeError);
    assert.throws(() => { result.stage2Refs.push({}); }, TypeError);
});

