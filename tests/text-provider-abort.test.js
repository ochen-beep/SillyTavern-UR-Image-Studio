// @ts-check
// AbortError должен доходить до вызывающего кода в неизменном виде: провайдеры
// не имеют права заворачивать отмену в «Text API is unavailable» / «недоступен» —
// callWithRetry сочтёт такую формулировку ретраебельной сетевой ошибкой и повторит
// отменённый запрос, а пайплайн запишет статус error вместо cancelled.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals, mockFetch } from './_helpers.js';

beforeEach(() => {
    installStGlobals();
});

/** Мок fetch, уважающий AbortSignal: на отмену бросает AbortError, как настоящий fetch. */
function abortAwareFetch() {
    return mockFetch(async (url, options) => {
        if (options?.signal?.aborted) {
            throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        };
    });
}

test('openai.generateText rethrows AbortError instead of wrapping it', async () => {
    const restore = abortAwareFetch();
    try {
        const { generateText } = await import('../src/providers/openai.js');
        const ctrl = new AbortController();
        ctrl.abort();
        await assert.rejects(
            generateText({ endpoint: 'https://api.test.com/v1', apiKey: 'k', model: 'm' }, 's', 'u', () => {}, ctrl.signal),
            (e) => {
                assert.equal(e?.name, 'AbortError', `expected AbortError, got: ${e?.name}: ${e?.message}`);
                assert.ok(!/unavailable/i.test(e?.message || ''), 'abort must not be rebranded as "unavailable"');
                return true;
            },
        );
    } finally {
        restore();
    }
});

test('gemini.generateText rethrows AbortError instead of wrapping it', async () => {
    const restore = abortAwareFetch();
    try {
        const { generateText } = await import('../src/providers/gemini.js');
        const ctrl = new AbortController();
        ctrl.abort();
        await assert.rejects(
            generateText({ endpoint: 'https://api.test.com', apiKey: 'k', model: 'gemini-x' }, 's', 'u', () => {}, ctrl.signal),
            (e) => {
                assert.equal(e?.name, 'AbortError', `expected AbortError, got: ${e?.name}: ${e?.message}`);
                assert.ok(!/недоступен/i.test(e?.message || ''), 'abort must not be rebranded as "недоступен"');
                return true;
            },
        );
    } finally {
        restore();
    }
});
