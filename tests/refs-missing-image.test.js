// @ts-check
// A ref file deleted outside the extension (manual cleanup, ST's Data Maid —
// which cannot see the pool's references) must fail with a typed, actionable
// error naming the exact card, not a generic "unavailable".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals, mockFetch } from './_helpers.js';

installStGlobals();

const { materializeStage2References } = await import('../src/references.js');

test('a missing ref file fails with a typed error naming the card', async () => {
    const restore = mockFetch(() => ({ ok: false, status: 404, text: async () => 'not found' }));
    try {
        const err = await materializeStage2References({
            stage2Refs: [{ id: 'r1', name: 'Аня', imagePath: 'user/images/URIS_Refs/anya.png', bindingMode: 'image' }],
        }).catch(e => e);
        assert.equal(err?.code, 'REFERENCE_FILE_MISSING');
        assert.match(err.message, /Аня/, 'the card name is in the message');
        assert.match(err.message, /URIS_Refs\/anya\.png/, 'the lost path is in the message');
        assert.match(err.message, /Data Maid/, 'the likely cause is named');
    } finally { restore(); }
});
