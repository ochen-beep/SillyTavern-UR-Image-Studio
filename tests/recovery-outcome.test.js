// @ts-check
// Классификация исхода dispatch-ошибки для страховочной записи (решение
// 2026-10-02): в бейдж INFO попадает только фактический результат, никаких
// промежуточных статусов.
//
// Отмена пользователем и ответ провайдера — ИЗВЕСТНЫЕ исходы: страховочная
// запись закрывается, карточка в INFO не рождается (отмену инициировал сам
// пользователь, ответ провайдера уже виден красной строкой в QUEUE и в пуле
// событий; технический след — dispatch-error в журнале).
// Таймаут и обрыв сети — честное «неизвестно»: POST мог уйти к провайдеру,
// запись остаётся на разбор.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchErrorKnown } from '../src/browser-image-recovery.js';

const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });

test('dispatchErrorKnown: отмена пользователем — исход известен', () => {
    assert.equal(dispatchErrorKnown(abortError(), { aborted: true }), true);
    // signal не передан, но ошибка — AbortError (callWithRetry пробрасывает её
    // дальше после проверки signal.aborted).
    assert.equal(dispatchErrorKnown(abortError(), null), true);
    assert.equal(dispatchErrorKnown(abortError(), { aborted: false }), true);
});

test('dispatchErrorKnown: ответ провайдера (httpStatus) — исход известен', () => {
    const http429 = Object.assign(new Error('Too Many Requests'), { httpStatus: 429 });
    const http500 = Object.assign(new Error('Upstream failed'), { httpStatus: 500 });
    assert.equal(dispatchErrorKnown(http429, null), true);
    assert.equal(dispatchErrorKnown(http500, { aborted: false }), true);
});

test('dispatchErrorKnown: таймаут и обрыв сети — честное «неизвестно»', () => {
    // fetchWithTimeout кидает обычный Error('Timeout (Ns)') — POST мог дойти.
    assert.equal(dispatchErrorKnown(new Error('Timeout (120s)'), null), false);
    assert.equal(dispatchErrorKnown(new TypeError('fetch failed'), null), false);
    assert.equal(dispatchErrorKnown(new Error('что-то новое'), null), false);
    // httpStatus не safe-integer — ответом провайдера не считается.
    assert.equal(dispatchErrorKnown(Object.assign(new Error('x'), { httpStatus: null }), null), false);
    assert.equal(dispatchErrorKnown(Object.assign(new Error('x'), { httpStatus: '429' }), null), false);
});

test('dispatchErrorKnown: отменённый сигнал важнее текста ошибки', () => {
    // Отмена во время чтения тела: ошибка может быть любой формы, но
    // aborted-сигнал решает — пользователь сам остановил генерацию.
    assert.equal(dispatchErrorKnown(new TypeError('body stream interrupted'), { aborted: true }), true);
});
