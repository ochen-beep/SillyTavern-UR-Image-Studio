// @ts-check
// Контракт шапки плавающего окна (src/ui/window.js).
//
// Заголовок «🎨 UR Image Studio» удалён (решение 2026-10-02): постоянную
// надпись в шапке никто не читал, окно опознаётся по содержимому, а место
// освобождено под будущие элементы. Статусная строка urisStatus удалена следом
// (2026-10-02, унификация уведомлений): это был мусорный канал — текст далеко
// от действия, и у всех трёх его пользователей есть собственная обратная
// связь (withBusy-кнопка Stage 1, disabled+тосты у проверки подключения,
// QUEUE-бейдж и пульс лаунчера у регенерации).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _testWindowMarkup } from '../src/ui/window.js';

const { WINDOW_TEMPLATE } = _testWindowMarkup;

test('шапка без заголовка: ни надписи, ни эмодзи', () => {
    assert.doesNotMatch(WINDOW_TEMPLATE, /uris-title/);
    assert.doesNotMatch(WINDOW_TEMPLATE, /🎨/);
});

test('шапка без статусной строки: канал уведомлений убран', () => {
    assert.doesNotMatch(WINDOW_TEMPLATE, /uris-status/);
    assert.doesNotMatch(WINDOW_TEMPLATE, /urisStatus/);
});

test('шапка сохраняет функциональные элементы', () => {
    assert.match(WINDOW_TEMPLATE, /id="urisHeader"/);
    assert.match(WINDOW_TEMPLATE, /class="uris-header-actions"/);
    assert.match(WINDOW_TEMPLATE, /id="urisQueueBadge"/);
    assert.match(WINDOW_TEMPLATE, /id="urisErrorBadge"/);
    assert.match(WINDOW_TEMPLATE, /id="urisClose"/);
});
