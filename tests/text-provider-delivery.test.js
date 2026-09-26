// @ts-check
// Контракт доставки платного текстового POST (v0.9.2, A+B из deep-review):
//   1. Провайдер сначала делает дешёвую разведку пути (probeDeliveryStrategy —
//      GET /models с теми же заголовками), затем платный POST.
//   2. Если платный POST упал с неизвестным исходом (CORS-маскировка), провайдер
//      обязан провести DELIVERY_AMBIGUOUS наружу как есть — без переклейки в
//      «Text API is unavailable» (иначе callWithRetry сочтёт это ретраебельной
//      сетевой ошибкой и повторит возможно-оплаченный запрос).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals, mockFetch } from './_helpers.js';

// Кэш стратегий хостов в proxy.js — модульный (живёт дольше теста): оба кейса
// бьют в один хост, и стратегия, выученная openai-тестом, протекла бы в gemini.
const { clearHostStrategy, _resetCache } = await import('../src/proxy.js');

beforeEach(() => {
    installStGlobals();
    clearHostStrategy();
    _resetCache();
});

/**
 * Мок: разведочный GET отвечает 200 (хост «дружелюбный»), платный POST гибнет
 * фантомным CORS-блоком — тот самый редкий, но опасный исход «запрос обработан,
 * ответ спрятан браузером». Проверяет, что наружу выходит DELIVERY_AMBIGUOUS
 * без обёртки и без повторной отправки.
 */
function phantomCorsFetch(sent) {
    return mockFetch((_url, options = {}) => {
        sent.push({ method: String(options.method || 'GET'), url: String(_url) });
        if (String(options.method || 'GET').toUpperCase() === 'POST') {
            throw new TypeError('Failed to fetch');
        }
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
    });
}

/**
 * Мок: разведка отвечает 200, платный POST — HTTP-ошибкой. Статус должен доехать
 * до ошибки как httpStatus: callWithRetry решает ретрай по нему, а не по тексту.
 */
function httpErrorFetch(status) {
    return mockFetch((_url, options = {}) => {
        if (String(options.method || 'GET').toUpperCase() === 'POST') {
            return { ok: false, status, text: async () => 'overloaded' };
        }
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
    });
}

for (const [provider, modulePath, profile] of [
    ['openai', '../src/providers/openai.js', { endpoint: 'https://api.delivery.test/v1', apiKey: 'k', model: 'm' }],
    ['gemini', '../src/providers/gemini.js', { endpoint: 'https://api.delivery.test', apiKey: 'k', model: 'gemini-x' }],
]) {
    test(`${provider}.generateText: фантомный CORS на POST → DELIVERY_AMBIGUOUS без переклейки, один POST`, async () => {
        const sent = [];
        const restore = phantomCorsFetch(sent);
        try {
            const { generateText } = await import(modulePath);
            await assert.rejects(
                generateText(profile, 's', 'u', () => {}, null),
                e => e?.code === 'DELIVERY_AMBIGUOUS'
                    && e?.noRetry === true
                    && !/unavailable|недоступен/i.test(e?.message || ''),
            );
            const posts = sent.filter(item => item.method === 'POST');
            const gets = sent.filter(item => item.method === 'GET');
            assert.equal(posts.length, 1, 'платный POST уходит ровно один раз — без прокси-фолбэка');
            assert.equal(gets.length, 1, 'перед POST должна быть одна разведка (/models)');
            assert.ok(gets[0].url.endsWith('/models'), `разведка бьёт в /models, а не в ${gets[0].url}`);
        } finally {
            restore();
        }
    });

    test(`${provider}.generateText: HTTP-ошибка несёт httpStatus, а не только текст`, async () => {
        const restore = httpErrorFetch(503);
        try {
            const { generateText } = await import(modulePath);
            await assert.rejects(
                generateText(profile, 's', 'u', () => {}, null),
                e => e?.httpStatus === 503,
                'статус ответа должен лежать на ошибке, а не только в её сообщении',
            );
        } finally {
            restore();
        }
    });

    test(`${provider}.generateText: сетевой обрыв помечен кодом NETWORK`, async () => {
        const restore = mockFetch(() => { throw new TypeError('Failed to fetch'); });
        try {
            const { generateText } = await import(modulePath);
            await assert.rejects(
                generateText(profile, 's', 'u', () => {}, null),
                e => e?.code === 'NETWORK',
            );
        } finally {
            restore();
        }
    });
}
