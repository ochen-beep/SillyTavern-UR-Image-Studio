import test from 'node:test';
import assert from 'node:assert/strict';
import { _testErrorBadge } from '../src/ui/window.js';

const { pluralRu, composeBadgeTitle } = _testErrorBadge;

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
