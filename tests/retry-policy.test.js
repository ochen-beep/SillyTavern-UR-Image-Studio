// @ts-check
// Тесты retry-политики callWithRetry.
// Главный инвариант: таймаут НЕ ретраится (генерация = деньги),
// 503/429/network — ретраятся.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals } from './_helpers.js';

installStGlobals();

import { state, callWithRetry } from '../src/core.js';

function configureRetry(maxRetries, retryDelay = 1) {
    state.settings = state.settings || {};
    state.settings.maxRetries = maxRetries;
    state.settings.retryDelay = retryDelay;
}

test('callWithRetry: таймаут НЕ ретраится (mode=generation)', async () => {
    let calls = 0;
    configureRetry(3);
    await assert.rejects(
        callWithRetry(async () => {
            calls++;
            throw new Error('Таймаут (120с)');
        }, 'test', 'generation'),
        /Таймаут/,
    );
    assert.equal(calls, 1, 'должен быть ровно 1 вызов, без ретраев');
});

test('callWithRetry: таймаут НЕ ретраится даже в network-режиме', async () => {
    let calls = 0;
    configureRetry(3);
    await assert.rejects(
        callWithRetry(async () => {
            calls++;
            throw new Error('Таймаут (120с)');
        }, 'test', 'network'),
        /Таймаут/,
    );
    assert.equal(calls, 1);
});

function withStatus(message, httpStatus) {
    const e = new Error(message);
    e.httpStatus = httpStatus;
    return e;
}

test('callWithRetry: 503 ретраится и в итоге succeeds', async () => {
    let calls = 0;
    configureRetry(2);
    const result = await callWithRetry(async (attempt) => {
        calls++;
        if (calls < 2) throw withStatus('Image API HTTP 503: overload', 503);
        return 'ok';
    }, 'test', 'generation');
    assert.equal(result, 'ok');
    assert.equal(calls, 2, 'первая попытка упала с 503, вторая — успех');
});

test('callWithRetry: 429 ретраится', async () => {
    let calls = 0;
    configureRetry(2);
    await callWithRetry(async () => {
        calls++;
        if (calls < 3) throw withStatus('HTTP 429: rate limit', 429);
        return 'ok';
    }, 'test', 'network');
    assert.equal(calls, 3);
});

test('callWithRetry: не-retryable ошибка (400) не ретраится', async () => {
    let calls = 0;
    configureRetry(3);
    await assert.rejects(
        callWithRetry(async () => {
            calls++;
            throw new Error('Image API HTTP 400: bad request');
        }, 'test', 'generation'),
        /400/,
    );
    assert.equal(calls, 1);
});

test('callWithRetry: maxRetries=0 → ровно 1 вызов всегда', async () => {
    let calls = 0;
    configureRetry(0);
    await assert.rejects(
        callWithRetry(async () => {
            calls++;
            throw withStatus('HTTP 503', 503);
        }, 'test'),
        /503/,
    );
    assert.equal(calls, 1);
});

test('callWithRetry: пометка noRetry запрещает ретрай даже при ретраебельном тексте', async () => {
    // DELIVERY_AMBIGUOUS из proxy.autoFetch: исход запроса неизвестен (возможно,
    // провайдер его обработал) — повтор мог бы списать деньги дважды.
    let calls = 0;
    configureRetry(3);
    await assert.rejects(
        callWithRetry(async () => {
            calls++;
            const e = new Error('Запрос ... автоматически не повторяется. Failed to fetch');
            e.noRetry = true;
            throw e;
        }, 'test', 'network'),
        /не повторяется/,
    );
    assert.equal(calls, 1, 'noRetry-ошибка не должна ретраиться');
});

test('callWithRetry: слово unavailable больше не триггерит ретрай (само-матчинг обёртки убран)', async () => {
    // «Text API is unavailable: …» — текст собственной обёртки провайдера;
    // раньше он гарантированно матчился и ретраил любой завёрнутый сбой.
    let calls = 0;
    configureRetry(2);
    await assert.rejects(
        callWithRetry(async () => {
            calls++;
            throw new Error('Text API is unavailable: что-то пошло не так');
        }, 'test', 'network'),
        /unavailable/,
    );
    assert.equal(calls, 1);
});

test('callWithRetry: «429» внутри текста ответа шлюза не ретраится', async () => {
    // Раньше ретрай решался подстрокой /429|502|503|504/ по всему сообщению,
    // поэтому «429» в любом месте текста шлюза повторял платный запрос.
    let calls = 0;
    configureRetry(3);
    await assert.rejects(
        callWithRetry(async () => {
            calls++;
            throw new Error('Gateway said: request id 4291 was rejected, see code 429 in the docs');
        }, 'test', 'generation'),
        /4291/,
    );
    assert.equal(calls, 1, 'текст без статуса и кода не повод повторять платный запрос');
});

test('callWithRetry: httpStatus из набора 429/502/503/504 ретраится, прочие статусы нет', async () => {
    configureRetry(2);
    for (const status of [429, 502, 503, 504]) {
        let calls = 0;
        const result = await callWithRetry(async () => {
            calls++;
            if (calls === 1) {
                const e = new Error('provider failed');
                e.httpStatus = status;
                throw e;
            }
            return 'ok';
        }, 'test', 'generation');
        assert.equal(result, 'ok', `статус ${status} должен ретраиться`);
        assert.equal(calls, 2, `статус ${status}: одна повторная попытка`);
    }

    let calls = 0;
    await assert.rejects(callWithRetry(async () => {
        calls++;
        const e = new Error('provider failed');
        e.httpStatus = 500;
        throw e;
    }, 'test', 'generation'), /provider failed/);
    assert.equal(calls, 1, '500 — ошибка провайдера, не транзиентный сбой');
});

test('callWithRetry: типизированный код транзиентного сбоя ретраится без httpStatus', async () => {
    // Сетевой обрыв не имеет HTTP-статуса вовсе — его несёт код ошибки.
    let calls = 0;
    configureRetry(2);
    const result = await callWithRetry(async () => {
        calls++;
        if (calls === 1) {
            const e = new Error('socket hang up');
            e.code = 'NETWORK';
            throw e;
        }
        return 'ok';
    }, 'test', 'network');
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
});

test('callWithRetry: успех с первой попытки', async () => {
    let calls = 0;
    configureRetry(3);
    const r = await callWithRetry(async () => {
        calls++;
        return 'data';
    }, 'test');
    assert.equal(r, 'data');
    assert.equal(calls, 1);
});
