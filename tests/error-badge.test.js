import test from 'node:test';
import assert from 'node:assert/strict';
import { _testErrorBadge } from '../src/ui/window.js';

const { pluralRu, composeBadgeTitle, pendingRowContext, pendingStatusLabel, mergeEvents, unseenRecoveryCount } = _testErrorBadge;

test('pluralRu: единица/мало/много и исключения 11-14, 21/111', () => {
    assert.equal(pluralRu(1, 'событие', 'события', 'событий'), 'событие');
    assert.equal(pluralRu(2, 'событие', 'события', 'событий'), 'события');
    assert.equal(pluralRu(5, 'событие', 'события', 'событий'), 'событий');
    assert.equal(pluralRu(11, 'событие', 'события', 'событий'), 'событий');
    assert.equal(pluralRu(12, 'событие', 'события', 'событий'), 'событий');
    assert.equal(pluralRu(14, 'событие', 'события', 'событий'), 'событий');
    assert.equal(pluralRu(21, 'событие', 'события', 'событий'), 'событие');
    assert.equal(pluralRu(111, 'событие', 'события', 'событий'), 'событий');
    assert.equal(pluralRu(22, 'запрос', 'запроса', 'запросов'), 'запроса');
});

test('composeBadgeTitle: единый счётчик новых событий', () => {
    assert.equal(composeBadgeTitle(0), 'События');
    assert.equal(composeBadgeTitle(1), '1 новое событие');
    assert.equal(composeBadgeTitle(3), '3 новых события');
    assert.equal(composeBadgeTitle(5), '5 новых событий');
    assert.equal(composeBadgeTitle(11), '11 новых событий');
});

test('unseenRecoveryCount: считаются только id вне seen-набора', () => {
    const pending = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    assert.equal(unseenRecoveryCount(pending, new Set()), 3);
    assert.equal(unseenRecoveryCount(pending, new Set(['a'])), 2);
    assert.equal(unseenRecoveryCount(pending, new Set(['a', 'b', 'c'])), 0);
    assert.equal(unseenRecoveryCount([], new Set()), 0);
    assert.equal(unseenRecoveryCount(null, new Set()), 0);
});

test('mergeEvents: одна лента, новые сверху, оба вида карточек', () => {
    const errors = [{ ts: 2000, scope: 'Генерация', message: 'boom', count: 1 }];
    const pending = [{
        id: 'r1',
        createdAt: new Date(3000).toISOString(),
        status: 'dispatchingUnknown',
        sourceMsgId: 4,
        modelId: 'm1',
        error: 'Direct image request failed',
    }];
    const events = mergeEvents(errors, pending);
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, 'recovery');
    assert.equal(events[0].ts, 3000);
    assert.equal(events[0].status, 'результат запроса неизвестен');
    assert.match(events[0].context, /пост #5/);
    assert.equal(events[1].kind, 'pool');
    assert.equal(events[1].ts, 2000);
    assert.match(events[1].text, /Генерация/);
    assert.equal(events[1].level, 'error');
});

test('mergeEvents: пустые входы — пустая лента', () => {
    assert.deepEqual(mergeEvents([], []), []);
    assert.deepEqual(mergeEvents(null, null), []);
});

test('pendingRowContext: время, пост (1-based) и модель из записи', () => {
    const ctx = pendingRowContext({
        createdAt: '2026-09-29T10:00:00.000Z',
        sourceMsgId: 7,
        modelId: 'gemini-3.1-flash',
    });
    assert.match(ctx, /пост #8/);
    assert.match(ctx, /gemini-3\.1-flash/);
    // Дата: запись может висеть днями, только «14:32» недостаточно.
    assert.match(ctx, /\d{2}:\d{2}/);
});

test('pendingRowContext: пустые и неприменимые поля пропускаются', () => {
    assert.equal(pendingRowContext({}), '');
    assert.equal(pendingRowContext({ createdAt: 'мусор', sourceMsgId: null, modelId: null }), '');
});

test('pendingStatusLabel: человекочитаемые статусы, неизвестный — как есть', () => {
    assert.equal(pendingStatusLabel({ status: 'notStarted' }), 'не отправлен');
    assert.equal(pendingStatusLabel({ status: 'dispatchingUnknown' }), 'результат запроса неизвестен');
    assert.equal(pendingStatusLabel({ status: 'resultReceived' }), 'ответ получен, сохранение не завершено');
    assert.equal(pendingStatusLabel({ status: 'что-то новое' }), 'что-то новое');
    assert.equal(pendingStatusLabel(null), 'неизвестный статус');
});
