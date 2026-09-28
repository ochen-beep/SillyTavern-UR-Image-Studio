import test from 'node:test';
import assert from 'node:assert/strict';
import { _testErrorBadge } from '../src/ui/window.js';

const { pluralRu, composeBadgeTitle, pendingRowContext, pendingStatusLabel, recoveryBadgeCount } = _testErrorBadge;

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

test('composeBadgeTitle: пусто — просто «События»', () => {
    assert.equal(composeBadgeTitle(0, 0), 'События');
});

test('composeBadgeTitle: только новые события', () => {
    assert.equal(composeBadgeTitle(1, 0), '1 новое событие');
    assert.equal(composeBadgeTitle(3, 0), '3 новых события');
    assert.equal(composeBadgeTitle(5, 0), '5 новых событий');
});

test('composeBadgeTitle: только recovery-записи (грамматика с плюрализацией)', () => {
    assert.equal(composeBadgeTitle(0, 1), '1 незавершённый запрос');
    assert.equal(composeBadgeTitle(0, 2), '2 незавершённых запроса');
    assert.equal(composeBadgeTitle(0, 5), '5 незавершённых запросов');
});

test('composeBadgeTitle: смесь через разделитель', () => {
    assert.equal(composeBadgeTitle(2, 1), '2 новых события · 1 незавершённый запрос');
});

test('recoveryBadgeCount: «не отправлен» не держит бейдж, неизвестный исход держит', () => {
    assert.equal(recoveryBadgeCount([]), 0);
    assert.equal(recoveryBadgeCount([{ status: 'notStarted' }, { status: 'notStarted' }]), 0);
    assert.equal(recoveryBadgeCount([{ status: 'notStarted' }, { status: 'dispatchingUnknown' }, { status: 'resultReceived' }]), 2);
    assert.equal(recoveryBadgeCount(null), 0);
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
