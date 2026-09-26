// @ts-check
// Журнал очереди для бейджа QUEUE: что ждёт, что выполняется и чем кончилось.
// Цифра бейджа — только живое (waiting + running). Успех зелёный, неудача
// красная, отмена не подсвечивается ни тем ни другим.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { noteQueued, noteRunning, noteFinished, listQueueLog, queueBadgeCount, clearQueueLog } from '../src/ui/queue-log.js';

beforeEach(() => clearQueueLog({ all: true }));

test('постановка и старт: цифра считает живое, журнал помнит порядок', () => {
    noteQueued({ id: 'a', label: 'Пост #3' });
    noteQueued({ id: 'b', label: 'Пост #4' });
    assert.equal(queueBadgeCount(), 2);
    noteRunning('a');
    const log = listQueueLog();
    assert.equal(log.find(row => row.id === 'a').status, 'running');
    assert.equal(log.find(row => row.id === 'b').status, 'waiting');
    assert.equal(queueBadgeCount(), 2, 'выполняющаяся генерация всё ещё в пуле');
});

test('успех зелёный и выходит из цифры, неудача красная, отмена без заливки', () => {
    noteQueued({ id: 'ok', label: 'Пост #1' });
    noteRunning('ok');
    noteFinished('ok', 'success');
    noteQueued({ id: 'bad', label: 'Пост #2' });
    noteFinished('bad', 'error', 'шлюз отказал');
    noteQueued({ id: 'stop', label: 'Пост #5' });
    noteFinished('stop', 'cancelled');
    const byId = Object.fromEntries(listQueueLog().map(row => [row.id, row]));
    assert.equal(byId.ok.tone, 'ok');
    assert.equal(byId.bad.tone, 'fail');
    assert.equal(byId.bad.detail, 'шлюз отказал');
    assert.equal(byId.stop.tone, null, 'отмена — не успех и не провал');
    assert.equal(queueBadgeCount(), 0);
});

test('финиш неизвестной генерации ничего не создаёт задним числом', () => {
    noteFinished('ghost', 'success');
    assert.equal(listQueueLog().length, 0);
});

test('очистка убирает завершённое и оставляет то, что ещё в работе', () => {
    noteQueued({ id: 'live', label: 'Пост #1' });
    noteRunning('live');
    noteQueued({ id: 'done', label: 'Пост #2' });
    noteFinished('done', 'success');
    clearQueueLog();
    const log = listQueueLog();
    assert.deepEqual(log.map(row => row.id), ['live']);
    assert.equal(queueBadgeCount(), 1);
});
