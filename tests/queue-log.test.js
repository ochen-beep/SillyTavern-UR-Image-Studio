// @ts-check
// Журнал очереди для бейджа QUEUE: что ждёт, что выполняется и чем кончилось.
// Цифра бейджа — только живое (waiting + running). Успех зелёный, неудача
// красная, отмена не подсвечивается ни тем ни другим.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { noteQueued, noteRunning, noteFinished, listQueueLog, queueBadgeCount, clearQueueLog, hasLiveQueueLane, laneFromSource } from '../src/ui/queue-log.js';

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

// ── Лейны: пачечная очередь vs ручные/авто/внешние ──

test('lane по умолчанию manual, pipeline-queue помечает очередь явно', () => {
    noteQueued({ id: 'm1', label: 'Пост #1' });
    noteQueued({ id: 'q1', label: 'Пост #2', lane: 'queue' });
    const byId = Object.fromEntries(listQueueLog().map(row => [row.id, row]));
    assert.equal(byId.m1.lane, 'manual');
    assert.equal(byId.q1.lane, 'queue');
});

test('hasLiveQueueLane — только живые строки пачечной очереди', () => {
    assert.equal(hasLiveQueueLane(), false);
    noteQueued({ id: 'm1', label: 'Пост #1' });
    noteQueued({ id: 'a1', label: 'Пост #2', lane: 'auto' });
    assert.equal(hasLiveQueueLane(), false, 'ручные и авто живые строки не очередь');
    noteQueued({ id: 'q1', label: 'Пост #3', lane: 'queue' });
    assert.equal(hasLiveQueueLane(), true);
    noteRunning('q1');
    assert.equal(hasLiveQueueLane(), true, 'выполняющийся элемент очереди — живой');
    noteFinished('q1', 'success');
    assert.equal(hasLiveQueueLane(), false, 'завершённая строка не очередь');
    noteQueued({ id: 'q2', label: 'Пост #4', lane: 'queue' });
    noteFinished('q2', 'cancelled');
    assert.equal(hasLiveQueueLane(), false, 'отменённая строка не очередь');
});

// Вытеснение при MAX_ROWS не должно выбрасывать живые строки, пока есть
// завершённые: иначе бейдж недосчитывает, а noteFinished вытесненных — no-op.
test('вытеснение при переполнении убирает сначала завершённые', () => {
    for (let i = 0; i < 48; i++) noteQueued({ id: `w${i}`, label: `Пост #${i}` });
    noteQueued({ id: 'd1', label: 'Пост #48' });
    noteFinished('d1', 'success');
    noteQueued({ id: 'd2', label: 'Пост #49' });
    noteFinished('d2', 'success');
    assert.equal(listQueueLog().length, 50);
    noteQueued({ id: 'w48', label: 'Пост #50' });
    const ids = listQueueLog().map(row => row.id);
    assert.equal(listQueueLog().length, 50);
    assert.ok(!ids.includes('d1'), 'старейшая завершённая вытеснена первой');
    assert.ok(ids.includes('d2'), 'более свежая завершённая пока жива');
    assert.ok(ids.includes('w0'), 'живая waiting-строка не вытеснена');
    noteQueued({ id: 'w49', label: 'Пост #51' });
    const ids2 = listQueueLog().map(row => row.id);
    assert.ok(!ids2.includes('d2'), 'следующая завершённая вытесняется следующей');
    assert.ok(ids2.includes('w0') && ids2.includes('w49'), 'все живые живы');
    assert.equal(queueBadgeCount(), 50, 'цифра бейджа не недосчитывает');
});

// ── Маппинг source события stage2-start на лейн синтезируемой строки ──

test('laneFromSource: auto, external:*, остальное manual', () => {
    assert.equal(laneFromSource('auto'), 'auto');
    assert.equal(laneFromSource('external:my-extension'), 'external');
    assert.equal(laneFromSource('manual'), 'manual');
    assert.equal(laneFromSource(undefined), 'manual');
});

// Retry-снапшот: упавшая строка пачечной очереди носит всё нужное для
// повторной отправки (кнопка «Повторить» в панели бейджа).
test('retry-снапшот проходит в строку ленты, у остальных его нет', () => {
    const retry = { chatId: 'c1', msgId: 1, messageText: 'A cat.', templateId: null,
        submission: { prompt: 'P', aspectRatio: null, imageSize: null, quality: null,
            references: { includedIds: [], excludedIds: [], revision: 0 } } };
    noteQueued({ id: 'q1', label: 'Пост #2', lane: 'queue', retry });
    const [row] = listQueueLog();
    assert.deepEqual(row.retry, retry);
    noteQueued({ id: 'm1', label: 'Пост #3' });
    const mrow = listQueueLog().find(r => r.id === 'm1');
    assert.equal(mrow.retry, null, 'ручные строки не предлагают повтор');
});
