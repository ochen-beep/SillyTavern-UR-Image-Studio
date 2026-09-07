// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('cardDimensions passes known sizes through and rejects partial/invalid ones', async () => {
    const { cardDimensions } = await import('../src/image-dimensions.js');
    assert.deepEqual(cardDimensions({ width: 800, height: 600 }), { width: 800, height: 600 });
    assert.equal(cardDimensions({ width: 800 }), null);
    assert.equal(cardDimensions({ width: 0, height: 100 }), null);
    assert.deepEqual(cardDimensions({ width: '800', height: '600' }), { width: 800, height: 600 });
    assert.equal(cardDimensions(null), null);
});

test('ensureCardDimensions returns known dimensions without probing', async () => {
    const { ensureCardDimensions } = await import('../src/image-dimensions.js');
    let probed = 0;
    const dims = await ensureCardDimensions('chat-1', { id: 'a', src: 'p', width: 4, height: 3 }, {
        _probe: () => { probed += 1; return { width: 1, height: 1 }; },
    });
    assert.deepEqual(dims, { width: 4, height: 3 });
    assert.equal(probed, 0);
});

test('ensureCardDimensions probes once, mutates the item and persists', async () => {
    const { ensureCardDimensions } = await import('../src/image-dimensions.js');
    const item = { id: 'card-1', src: 'user/images/f/one.png' };
    const persisted = [];
    const dims = await ensureCardDimensions('chat-1', item, {
        _probe: async (src) => ({ width: 800, height: 600, probedSrc: src }),
        _persist: async (id, patch) => persisted.push([id, patch]),
    });
    assert.deepEqual(dims, { width: 800, height: 600 });
    assert.equal(item.width, 800);
    assert.deepEqual(persisted, [['card-1', { width: 800, height: 600 }]]);
});

test('ensureCardDimensions degrades to fallback on probe failure', async () => {
    const { ensureCardDimensions, FALLBACK_DIMENSIONS } = await import('../src/image-dimensions.js');
    const dims = await ensureCardDimensions('chat-1', { id: 'a', src: 'p' }, {
        _probe: async () => { throw new Error('broken image'); },
    });
    assert.deepEqual(dims, FALLBACK_DIMENSIONS);
});

test('ensureCardDimensions skips probe without id or src', async () => {
    const { ensureCardDimensions, FALLBACK_DIMENSIONS } = await import('../src/image-dimensions.js');
    let probed = 0;
    assert.deepEqual(await ensureCardDimensions('chat-1', { id: 'a' }, {
        _probe: () => { probed += 1; return { width: 1, height: 1 }; },
    }), FALLBACK_DIMENSIONS);
    assert.deepEqual(await ensureCardDimensions('chat-1', { src: 'p' }, {
        _probe: () => { probed += 1; return { width: 1, height: 1 }; },
    }), FALLBACK_DIMENSIONS);
    assert.equal(probed, 0);
});

test('ensureCardDimensions rethrows AbortError instead of masking it', async () => {
    const { ensureCardDimensions } = await import('../src/image-dimensions.js');
    const abort = new DOMException('Aborted', 'AbortError');
    await assert.rejects(
        ensureCardDimensions('chat-1', { id: 'a', src: 'p' }, { _probe: async () => { throw abort; } }),
        (e) => e === abort,
    );
});
