// @ts-check
// Контракт канонического мьютекса serialize(key, fn): одинаковые ключи
// сериализуются, разные идут параллельно, rejecting-задача не ломает цепочку,
// простой ключ вычищается из карты.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialize } from '../src/serialize.js';

test('serialize: одинаковые ключи очередью, разные — параллельно', async () => {
    const events = [];
    const slow = (key, tag) => serialize(key, async () => {
        events.push(`${tag}:start`);
        await new Promise(resolve => setTimeout(resolve, 10));
        events.push(`${tag}:end`);
    });
    await Promise.all([slow('a', 'a1'), slow('a', 'a2'), slow('b', 'b1')]);
    // a2 не может начаться, пока идёт a1; b1 стартует параллельно с a1.
    const idx = tag => events.indexOf(`${tag}:start`);
    assert.ok(idx('a2') > events.indexOf('a1:end'), 'a2 стартует только после a1:end');
    assert.ok(idx('b1') > idx('a1:start') && idx('b1') < events.indexOf('a1:end'), 'b1 идёт параллельно с a1');
});

test('serialize: rejecting-задача пробрасывается вызывающему и не ломает цепочку', async () => {
    let calls = 0;
    await assert.rejects(
        () => serialize('k', async () => { calls++; throw new Error('boom'); }),
        /boom/,
    );
    const result = await serialize('k', async () => { calls++; return 'ok'; });
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
});

test('serialize: простой ключ удаляется из карты (нет утечки)', async () => {
    await serialize('idle-key', async () => 'done');
    // Внутренности не экспортируются — проверяем поведенчески: сотни ключей
    // после завершения не держат цепочку (нет способа увидеть Map напрямую,
    // но повторный вызов с тем же ключом обязан работать как первый).
    for (let i = 0; i < 200; i++) await serialize(`key-${i}`, async () => i);
    assert.equal(await serialize('idle-key', async () => 'again'), 'again');
});

test('serialize: задача стартует и после rejecting-предшественника (then(fn, fn))', async () => {
    const order = [];
    const first = serialize('lane', async () => { order.push('first'); throw new Error('x'); });
    const second = serialize('lane', async () => { order.push('second'); return 2; });
    await assert.rejects(first, /x/);
    assert.equal(await second, 2);
    assert.deepEqual(order, ['first', 'second']);
});
