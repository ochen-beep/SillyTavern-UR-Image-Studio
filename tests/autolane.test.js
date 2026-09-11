import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueAutoLane } from '../src/autolane.js';

test('autolane: serializes tasks in enqueue order', async () => {
    const order = [];
    const p1 = enqueueAutoLane(async () => { await new Promise(r => setTimeout(r, 30)); order.push(1); return 'a'; });
    const p2 = enqueueAutoLane(async () => { order.push(2); return 'b'; });
    assert.equal(await p1, 'a');
    assert.equal(await p2, 'b');
    assert.deepEqual(order, [1, 2]);
});

test('autolane: rejection does not poison the lane', async () => {
    await assert.rejects(enqueueAutoLane(async () => { throw Object.assign(new Error('x'), { code: 'E' }); }),
        e => e.code === 'E');
    const r = await enqueueAutoLane(async () => 'after');
    assert.equal(r, 'after');
});

test('autolane: sync throw rejects caller, lane survives', async () => {
    await assert.rejects(enqueueAutoLane(() => { throw new Error('sync'); }), /sync/);
    assert.equal(await enqueueAutoLane(() => 'after'), 'after');
});
