import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueAutoLane, enqueueBridgeTextLane } from '../src/autolane.js';

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

test('bridge text lane: serializes concurrent tasks (one paid text-LLM at a time)', async () => {
    let active = 0;
    let maxActive = 0;
    const task = () => enqueueBridgeTextLane(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
    });
    await Promise.all([task(), task(), task(), task()]);
    assert.equal(maxActive, 1);
});

test('bridge text lane: does not block the image autolane (separate keys)', async () => {
    let release;
    const blocker = enqueueBridgeTextLane(() => new Promise(resolve => { release = resolve; }));
    let autolaneDone = false;
    const imageTask = enqueueAutoLane(async () => { autolaneDone = true; });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(autolaneDone, true, 'image autolane must run while the text lane is busy');
    release();
    await blocker;
    await imageTask;
});
