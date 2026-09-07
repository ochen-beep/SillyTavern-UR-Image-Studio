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

test('callWithRetry: 503 ретраится и в итоге succeeds', async () => {
    let calls = 0;
    configureRetry(2);
    const result = await callWithRetry(async (attempt) => {
        calls++;
        if (calls < 2) throw new Error('Image API HTTP 503: overload');
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
        if (calls < 3) throw new Error('HTTP 429: rate limit');
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
            throw new Error('HTTP 503');
        }, 'test'),
        /503/,
    );
    assert.equal(calls, 1);
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
