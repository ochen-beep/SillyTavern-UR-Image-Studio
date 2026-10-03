import test from 'node:test';
import assert from 'node:assert/strict';
import { _testErrorBadge } from '../src/ui/window.js';

const { pluralRu, composeBadgeTitle, pendingRowContext, pendingStatusLabel, mergeEvents, unseenRecoveryCount, badgeIsIdle, BADGE_IDLE_CLASS, badgeButtonHtml, reviewableRecovery } = _testErrorBadge;

test('reviewableRecovery: живая генерация — не событие, завершённая — событие', () => {
    const pending = [
        { id: 'live', requestId: 'live', status: 'dispatchingUnknown' },
        { id: 'dead', requestId: 'dead', status: 'dispatchingUnknown', error: 'fetch failed' },
        { id: 'recv', requestId: 'recv', status: 'resultReceived', error: 'save failed' },
    ];
    const live = new Map([['live', new AbortController()]]);
    const out = reviewableRecovery(pending, live);
    // Живая запись скрыта из бейджа и панели целиком: её показывает QUEUE.
    assert.deepEqual(out.map(item => item.id), ['dead', 'recv']);
});

test('reviewableRecovery: requestId без записи в реестре проходит (fallback на id)', () => {
    const pending = [{ id: 'x', status: 'dispatchingUnknown' }];
    const live = new Map([['x', new AbortController()]]);
    assert.deepEqual(reviewableRecovery(pending, live), [], 'id без requestId сверяется с реестром');
});

test('reviewableRecovery: без реестра живых (после перезагрузки) — все записи на разборе', () => {
    const pending = [{ id: 'a', requestId: 'a', status: 'dispatchingUnknown' }];
    assert.deepEqual(reviewableRecovery(pending, null), pending);
    assert.deepEqual(reviewableRecovery(pending, undefined), pending);
    assert.deepEqual(reviewableRecovery(null, new Map()), []);
});

test('badgeIsIdle: единое правило обоих бейджей — нет актуального, значит приглушён', () => {
    // QUEUE: 0 = ничего живого; INFO: 0 = всё просмотрено. Оба — idle.
    assert.equal(badgeIsIdle(0), true);
    assert.equal(badgeIsIdle(2), false);
    // Отрицательный счётчик — не повод падать: трактуется как «нечего показывать».
    assert.equal(badgeIsIdle(-1), true);
});

test('BADGE_IDLE_CLASS: имя класса синхронно с style.css', () => {
    assert.equal(BADGE_IDLE_CLASS, 'uris-error-badge--idle');
});

test('badgeButtonHtml: один набор классов, без hidden, слот цифры и опциональная точка', () => {
    const queue = badgeButtonHtml({ id: 'urisQueueBadge', label: 'QUEUE', title: 'Очередь генераций', controls: 'urisQueuePanel' });
    // Бейдж всегда в DOM: у самой кнопки hidden нет ни у одного из двух.
    // (У точки INFO атрибут hidden законен — она скрыта, пока нет серьёзного.)
    assert.doesNotMatch(queue, /<button[^>]*\bhidden\b/);
    assert.match(queue, /class="uris-icon-btn uris-error-badge"/);
    assert.match(queue, /id="urisQueueBadge"/);
    assert.match(queue, /aria-controls="urisQueuePanel"/);
    assert.match(queue, /aria-expanded="false"/);
    assert.match(queue, /id="urisQueueCount"/);
    assert.doesNotMatch(queue, /uris-badge-dot/, 'точка — только у бейджа с серьёзностью');

    const info = badgeButtonHtml({ id: 'urisErrorBadge', label: 'INFO', title: 'События', controls: 'urisErrorPanel', withDot: true });
    assert.doesNotMatch(info, /<button[^>]*\bhidden\b/);
    assert.match(info, /id="urisErrorCount"/);
    assert.match(info, /id="urisErrorDot"/);
});

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

test('unseenRecoveryCount: считаются только записи новее бейзлайна', () => {
    // Единая модель непрочитанности: recovery-чеки сверяются с тем же
    // персистентным таймстампом «просмотрено», что и пул сессии — никаких
    // отдельных id-наборов.
    const t0 = 1_000_000_000;
    const pending = [
        { id: 'old', createdAt: new Date(t0).toISOString() },
        { id: 'new', createdAt: new Date(t0 + 5_000).toISOString() },
        { id: 'noDate', createdAt: 'мусор' },
    ];
    assert.equal(unseenRecoveryCount(pending, t0), 2, 'новое + запись без даты (дефектные данные всплывают)');
    assert.equal(unseenRecoveryCount(pending, t0 + 10_000), 1);
    assert.equal(unseenRecoveryCount(pending, Number.POSITIVE_INFINITY), 1, 'нечитаемая дата — всегда непросмотренная');
    assert.equal(unseenRecoveryCount([], t0), 0);
    assert.equal(unseenRecoveryCount(null, t0), 0);
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
