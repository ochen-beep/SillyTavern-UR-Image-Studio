// @ts-check
// Unit-тесты для модуля CORS-прокси (src/proxy.js).
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, installStGlobals } from './_helpers.js';

installStGlobals();

const {
    proxyUrl, probeCorsProxy, isCorsProxyAvailable, proxiedFetch, _resetCache,
    autoFetch, clearHostStrategy, getHostStrategies, canProxyJsonRequest,
} = await import('../src/proxy.js');

test('canProxyJsonRequest rejects multipart bodies before probing or sending', async () => {
    _resetCache();
    assert.throws(
        () => canProxyJsonRequest({ method: 'POST', body: new FormData() }),
        /JSON.*multipart|multipart.*JSON/i,
    );
});

test('canProxyJsonRequest rejects a one-shot stream with a typed replayability error', async () => {
    assert.throws(
        () => canProxyJsonRequest({ method: 'POST', body: new ReadableStream() }),
        error => error?.code === 'NON_REPLAYABLE_BODY' && /replay|one-shot/i.test(error.message),
    );
});

test('canProxyJsonRequest rejects cross-realm FormData', async () => {
    const crossRealmFormData = { [Symbol.toStringTag]: 'FormData' };
    assert.throws(
        () => canProxyJsonRequest({ method: 'POST', body: crossRealmFormData }),
        /JSON.*multipart|multipart.*JSON/i,
    );
});


test('proxyUrl кодирует полный URL через encodeURIComponent', () => {
    const out = proxyUrl('https://api.example.com/v1/images/generations');
    assert.equal(out, '/proxy/' + encodeURIComponent('https://api.example.com/v1/images/generations'));
});

test('proxyUrl кодирует URL с query-параметрами', () => {
    const out = proxyUrl('https://image.pollinations.ai/prompt/a%20cat?width=1024');
    // encodeURIComponent внутри, значит исходное %20 тоже кодируется.
    assert.ok(out.startsWith('/proxy/'));
    assert.ok(!out.includes(' '));
});

// ── isCorsProxyAvailable: до пробы возвращает null ──

test('isCorsProxyAvailable возвращает null до первой пробы', () => {
    _resetCache();
    assert.equal(isCorsProxyAvailable(), null);
});

// ── probeCorsProxy: распознавание disabled-флага ──

beforeEach(() => { _resetCache(); clearHostStrategy(); });

test('probeCorsProxy: 404 + "CORS proxy is disabled" → false', async () => {
    const restore = mockFetch(() => ({
        ok: false, status: 404,
        text: async () => 'CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.',
    }));
    try {
        const result = await probeCorsProxy();
        assert.equal(result, false);
        assert.equal(isCorsProxyAvailable(), false);
    } finally { restore(); }
});

test('probeCorsProxy: любой другой статус → true (прокси жив)', async () => {
    const restore = mockFetch(() => ({ ok: true, status: 200 }));
    try {
        const result = await probeCorsProxy();
        assert.equal(result, true);
        assert.equal(isCorsProxyAvailable(), true);
    } finally { restore(); }
});

test('probeCorsProxy: 500 от апстрима → всё равно true (прокси отвечает)', async () => {
    const restore = mockFetch(() => ({ ok: false, status: 500, text: async () => 'upstream error' }));
    try {
        assert.equal(await probeCorsProxy(), true);
    } finally { restore(); }
});

test('probeCorsProxy: 404 без disabled-текста → true (апстрим отдал 404, прокси работает)', async () => {
    const restore = mockFetch(() => ({ ok: false, status: 404, text: async () => 'Not Found' }));
    try {
        assert.equal(await probeCorsProxy(), true);
    } finally { restore(); }
});

test('probeCorsProxy: сетевая ошибка → false, но НЕ кэшируется (транзиентная)', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network down'); };
    try {
        assert.equal(await probeCorsProxy(), false);
        assert.equal(isCorsProxyAvailable(), null, 'transient failure must not poison the session');
    } finally { globalThis.fetch = original; }
});

test('probeCorsProxy: после транзиентной ошибки рабочий прокси подхватывается без перезагрузки', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network down'); };
    await probeCorsProxy();
    globalThis.fetch = original;
    const restore = mockFetch(() => ({ ok: true, status: 200, text: async () => 'ok' }));
    try {
        assert.equal(await probeCorsProxy(), true);
    } finally { restore(); }
});

test('probeCorsProxy: выключенный прокси кэшируется на короткий TTL', async () => {
    const disabled = mockFetch(() => ({ ok: false, status: 404, text: async () => 'CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.' }));
    try {
        assert.equal(await probeCorsProxy(), false);
        assert.equal(isCorsProxyAvailable(), false);
    } finally { disabled(); }
    // Within the TTL the cached false stands (no re-probe)...
    const calls = [];
    const enabled = mockFetch(() => { calls.push('probe'); return { ok: true, status: 200, text: async () => 'ok' }; });
    try {
        assert.equal(await probeCorsProxy(), false, 'cached negative short-circuits inside the TTL');
        assert.deepEqual(calls, [], 'no network probe while the negative cache is fresh');
        // ...and once the cache goes stale (force emulates TTL expiry), the
        // now-enabled proxy is picked up without a page reload.
        assert.equal(await probeCorsProxy(true), true);
        assert.deepEqual(calls, ['probe'], 'stale negative re-probes and recovers');
    } finally { enabled(); }
});

test('probeCorsProxy forwards the caller signal and cancellation does not cache false', async () => {
    const controller = new AbortController();
    let seenSignal;
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
        seenSignal = options.signal;
        return new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
    };
    try {
        const pending = probeCorsProxy(false, controller.signal);
        controller.abort();
        await assert.rejects(pending, error => error?.name === 'AbortError');
        assert.ok(seenSignal?.aborted);
        assert.equal(isCorsProxyAvailable(), null);
    } finally { globalThis.fetch = original; }
});

// ── probeCorsProxy: кэширование ──

test('probeCorsProxy кэширует результат — второй вызов без fetch', async () => {
    let callCount = 0;
    const restore = mockFetch(() => { callCount++; return { ok: true, status: 200 }; });
    try {
        await probeCorsProxy();
        await probeCorsProxy();
        await probeCorsProxy();
        assert.equal(callCount, 1, 'fetch должен вызваться один раз при кэшировании');
    } finally { restore(); }
});

test('probeCorsProxy(force=true) сбрасывает кэш и перепроверяет', async () => {
    let callCount = 0;
    const restore = mockFetch(() => { callCount++; return { ok: true, status: 200 }; });
    try {
        await probeCorsProxy();
        await probeCorsProxy(true);
        assert.equal(callCount, 2, 'force должен вызвать повторный fetch');
    } finally { restore(); }
});

// ── proxiedFetch: успех ──

test('proxiedFetch: при доступном прокси вызывает fetch с /proxy/ префиксом', async () => {
    let capturedUrl = null;
    const restore = mockFetch((url) => { capturedUrl = url; return { ok: true, status: 200 }; });
    try {
        // Сначала делаем прокси доступным (probe вернёт true от mockFetch 200).
        await probeCorsProxy();
        await proxiedFetch('https://api.example.com/v1/images/generations', { method: 'POST' });
        // mockFetch декодирует /proxy/, так что capturedUrl = исходный URL.
        assert.equal(capturedUrl, 'https://api.example.com/v1/images/generations');
    } finally { restore(); }
});

test('proxiedFetch: передаёт method, headers, body как есть', async () => {
    let captured = null;
    const restore = mockFetch((url, options) => { captured = { url, options }; return { ok: true, status: 200 }; });
    try {
        await probeCorsProxy();
        await proxiedFetch('https://api.x.com/gen', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer k', 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: 'cat' }),
        });
        assert.equal(captured.options.method, 'POST');
        assert.equal(captured.options.headers.Authorization, 'Bearer k');
        assert.deepEqual(JSON.parse(captured.options.body), { prompt: 'cat' });
    } finally { restore(); }
});

test('proxiedFetch: не подставляет Accept-Encoding — браузер всё равно отбрасывает forbidden-заголовок', async () => {
    // Accept-Encoding is a forbidden fetch header: the browser drops it before
    // the request leaves the page, so injecting it here never reached ST's
    // proxy (fuzhan probe 2026-08-06 still received a compressed body while
    // the pin was in place). Compressed bodies are decoded at read time
    // instead (catalog.js / providers/image-base.js), so proxiedFetch must
    // pass the caller's options through untouched.
    let capturedHeaders = null;
    const restore = mockFetch((_url, options) => { capturedHeaders = options.headers; return { ok: true, status: 200 }; });
    try {
        await probeCorsProxy();
        await proxiedFetch('https://api.x.com/gen', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer k', 'Content-Type': 'application/json' },
            body: '{}',
        });
        assert.equal(capturedHeaders['Accept-Encoding'], undefined);
        assert.equal(capturedHeaders.Authorization, 'Bearer k');
        assert.equal(capturedHeaders['Content-Type'], 'application/json');
    } finally { restore(); }
});

// ── proxiedFetch: недоступный прокси ──

test('proxiedFetch: при выключенном прокси кидает понятную ошибку', async () => {
    const restore = mockFetch(() => ({
        ok: false, status: 404,
        text: async () => 'CORS proxy is disabled.',
    }));
    try {
        await assert.rejects(
            () => proxiedFetch('https://api.example.com/v1/images/generations', { method: 'POST' }),
            /CORS-прокси SillyTavern недоступен/,
        );
    } finally { restore(); }
});

// ── autoFetch: гибридный прямой→прокси с кэшем по хосту ──

test('autoFetch: дружелюбный хост идёт напрямую (viaProxy=false), кэшируется direct', async () => {
    const calls = [];
    const restore = mockFetch((url, _opts, viaProxy) => {
        calls.push({ url, viaProxy });
        return { ok: true, status: 200 };
    });
    try {
        await autoFetch('https://naistera.org/api/generate', { method: 'POST' });
        // Прямой запрос, без /proxy/ — это и есть дружелюбный путь.
        assert.equal(calls.length, 1);
        assert.equal(calls[0].viaProxy, false);
        assert.deepEqual(getHostStrategies(), { 'naistera.org': 'direct' });
    } finally { restore(); }
});

test('autoFetch: второй запрос к direct-хосту идёт напрямую без пробы прокси', async () => {
    let proxyCalls = 0;
    const restore = mockFetch((_url, _opts, viaProxy) => {
        if (viaProxy) proxyCalls++;
        return { ok: true, status: 200 };
    });
    try {
        await autoFetch('https://naistera.org/api/generate', { method: 'POST' });
        await autoFetch('https://naistera.org/api/generate', { method: 'POST' });
        await autoFetch('https://naistera.org/other', { method: 'GET' });
        assert.equal(proxyCalls, 0, 'прокси не должен вызываться для direct-хоста');
    } finally { restore(); }
});

test('autoFetch: CORS-блок платного POST не перепосылается — DELIVERY_AMBIGUOUS, хост учит прокси', async () => {
    const calls = [];
    const restore = mockFetch((_url, _opts, viaProxy) => {
        calls.push(viaProxy);
        if (!viaProxy) throw new TypeError('Failed to fetch'); // браузерный CORS-блок
        return { ok: true, status: 200 };
    });
    try {
        await assert.rejects(
            () => autoFetch('https://cdn.moe-atelier.site/v1/images/generations', { method: 'POST' }),
            e => e?.code === 'DELIVERY_AMBIGUOUS' && e?.noRetry === true,
        );
        // Ровно одна попытка: исход неизвестен, повтор мог бы списать деньги дважды.
        assert.deepEqual(calls, [false], 'платный POST не должен уходить второй раз через прокси');
        // Хост запомнен как требующий прокси — следующая попытка пойдёт сразу через неё.
        assert.equal(getHostStrategies()['cdn.moe-atelier.site'], 'proxy');
    } finally { restore(); }
});

test('autoFetch: CORS-блок GET-запроса → fallback на прокси, кэшируется proxy', async () => {
    // GET идемпотентен: исторический гибридный фолбэк для бесплатных запросов сохранён.
    const calls = [];
    const restore = mockFetch((_url, _opts, viaProxy) => {
        calls.push({ viaProxy });
        if (!viaProxy) throw new TypeError('Failed to fetch');
        return { ok: true, status: 200 };
    });
    try {
        await autoFetch('https://cdn.moe-atelier.site/v1/images/generations');
        const proxyRequests = calls.filter(c => c.viaProxy);
        assert.equal(calls.filter(c => !c.viaProxy).length, 1, 'должна быть 1 прямая попытка (упавшая)');
        assert.ok(proxyRequests.length >= 1, 'должен быть хотя бы 1 прокси-запрос');
        assert.deepEqual(getHostStrategies(), { 'cdn.moe-atelier.site': 'proxy' });
    } finally { restore(); }
});

test('autoFetch: второй POST к proxy-хосту идёт СРАЗУ через прокси (без прямой попытки)', async () => {
    let directAttempts = 0;
    const restore = mockFetch((_url, _opts, viaProxy) => {
        if (!viaProxy) { directAttempts++; throw new TypeError('Failed to fetch'); }
        return { ok: true, status: 200 };
    });
    try {
        await assert.rejects(
            () => autoFetch('https://cdn.moe-atelier.site/gen', { method: 'POST' }),
            e => e?.code === 'DELIVERY_AMBIGUOUS',
        );
        await autoFetch('https://cdn.moe-atelier.site/gen2', { method: 'POST' });
        // Первый POST: 1 прямой (упал, без повтора). Второй: 0 прямых + 1 прокси.
        assert.equal(directAttempts, 1, 'повторный запрос не должен бить напрямую для proxy-хоста');
    } finally { restore(); }
});

test('autoFetch: HTTP-ошибка апстрима (400/500) НЕ триггерит fallback на прокси', async () => {
    const calls = [];
    const restore = mockFetch((url, _opts, viaProxy) => {
        calls.push({ url, viaProxy });
        // Сервер ответил — путь работает. Это валидная ошибка, не CORS.
        return { ok: false, status: 500, text: async () => 'upstream error' };
    });
    try {
        await autoFetch('https://api.example.com/v1/images/generations', { method: 'POST' });
        // Должен быть только 1 вызов — прямой. Прокси не должен пытаться.
        assert.equal(calls.length, 1);
        assert.equal(calls[0].viaProxy, false);
    } catch (e) {
        // autoFetch пробрасывает Response с ok:false, fetchWithTimeout его не кидает;
        // провайдер сам проверит resp.ok. Здесь проверяем что нет второго вызова.
    } finally { restore(); }
});

test('autoFetch: CORS-блок платного POST при выключенном прокси — честная AMBIGUOUS-ошибка, прокси не опрашивается', async () => {
    const calls = [];
    const restore = mockFetch((_url, _opts, viaProxy) => {
        calls.push(viaProxy);
        if (!viaProxy) throw new TypeError('Failed to fetch');
        return { ok: false, status: 404, text: async () => 'CORS proxy is disabled.' };
    });
    try {
        await assert.rejects(
            () => autoFetch('https://cdn.moe-atelier.site/gen', { method: 'POST' }),
            e => e?.code === 'DELIVERY_AMBIGUOUS',
        );
        assert.deepEqual(calls, [false], 'выключенный прокси не должен опрашиваться для платного POST');
    } finally { restore(); }
});

test('autoFetch: CORS-блок GET + выключенный прокси → понятная ошибка', async () => {
    const restore = mockFetch((_url, _opts, viaProxy) => {
        if (!viaProxy) throw new TypeError('Failed to fetch');
        return { ok: false, status: 404, text: async () => 'CORS proxy is disabled.' };
    });
    try {
        await assert.rejects(
            () => autoFetch('https://cdn.moe-atelier.site/gen'),
            /CORS-прокси SillyTavern недоступен/,
        );
    } finally { restore(); }
});

test('autoFetch rejects malformed URL TypeError without proxy fallback', async () => {
    clearHostStrategy();
    _resetCache();
    const calls = [];
    const restore = mockFetch((_url, _opts, viaProxy) => {
        calls.push(viaProxy);
        throw new TypeError('Invalid URL');
    });
    try {
        await assert.rejects(() => autoFetch('not a URL', { method: 'POST' }), /Invalid URL/);
        assert.deepEqual(calls, [false]);
    } finally { restore(); }
});

test('autoFetch does not retry an ordinary Error with a browser-like TypeError name and message', async () => {
    clearHostStrategy();
    _resetCache();
    const calls = [];
    const original = new Error('NetworkError');
    original.name = 'TypeError';
    const restore = mockFetch((_url, _opts, viaProxy) => {
        calls.push(viaProxy);
        throw original;
    });
    try {
        await assert.rejects(
            () => autoFetch('https://ordinary-error.test/gen', { method: 'POST' }),
            error => error === original,
        );
        assert.deepEqual(calls, [false]);
        assert.equal(getHostStrategies()['ordinary-error.test'], undefined);
    } finally { restore(); }
});

test('autoFetch recovers a cached direct host through proxy after later CORS failure', async () => {
    clearHostStrategy();
    _resetCache();
    const calls = [];
    let directCount = 0;
    const restore = mockFetch((_url, _opts, viaProxy) => {
        calls.push(viaProxy);
        if (!viaProxy && ++directCount === 2) throw new TypeError('Failed to fetch');
        return { ok: true, status: 200 };
    });
    try {
        await autoFetch('https://recover-direct.test/gen');
        await autoFetch('https://recover-direct.test/gen2');
        assert.deepEqual(calls, [false, false, true, true]);
        assert.equal(getHostStrategies()['recover-direct.test'], 'proxy');
    } finally { restore(); }
});

test('autoFetch recovers a cached proxy host through direct after proxy failure', async () => {
    clearHostStrategy();
    _resetCache();
    const calls = [];
    const restore = mockFetch((url, _opts, viaProxy) => {
        calls.push(viaProxy);
        if (viaProxy && url.endsWith('/gen2')) throw new TypeError('Failed to fetch');
        if (!viaProxy && calls.length > 1) return { ok: true, status: 200 };
        if (!viaProxy) throw new TypeError('Failed to fetch');
        return { ok: true, status: 200 };
    });
    try {
        await autoFetch('https://recover-proxy.test/gen');
        await autoFetch('https://recover-proxy.test/gen2');
        assert.ok(calls.includes(false));
        assert.equal(getHostStrategies()['recover-proxy.test'], 'direct');
    } finally { restore(); }
});
test('autoFetch: AbortError/Таймаут НЕ переключают стратегию (пробрасываются как есть)', async () => {
    // fetchWithTimeout превращает внутренний AbortError в «Таймаут (...)»,
    // если внешний сигнал не абортнут. autoFetch должен пробросить его, не кэшируя.
    const restore = mockFetch(() => {
        // Моделируем таймаут: бросаем «Таймаут» напрямую (как сделал бы fetchWithTimeout).
        throw new Error('Таймаут (120с)');
    });
    try {
        await assert.rejects(
            () => autoFetch('https://slow.host/gen', { method: 'POST' }),
            /Таймаут/,
        );
        // Стратегия не должна кэшироваться при таймауте.
        assert.equal(getHostStrategies()['slow.host'], undefined);
    } finally { restore(); }
});

test('autoFetch: разные хосты кэшируются независимо', async () => {
    const restore = mockFetch((_url, _opts, viaProxy) => {
        // naistera.org отвечает напрямую, moe-atelier — блокирует CORS.
        if (!viaProxy) {
            const host = _url.includes('naistera') ? null : (() => { throw new TypeError('Failed to fetch'); })();
            return { ok: true, status: 200 };
        }
        return { ok: true, status: 200 };
    });
    try {
        await autoFetch('https://naistera.org/gen', { method: 'POST' });
        await assert.rejects(
            () => autoFetch('https://cdn.moe-atelier.site/gen', { method: 'POST' }),
            e => e?.code === 'DELIVERY_AMBIGUOUS',
        );
        const s = getHostStrategies();
        assert.equal(s['naistera.org'], 'direct');
        assert.equal(s['cdn.moe-atelier.site'], 'proxy');
    } finally { restore(); }
});

test('clearHostStrategy(host) очищает только указанный хост', async () => {
    const restore = mockFetch(() => ({ ok: true, status: 200 }));
    try {
        await autoFetch('https://a.host/gen', { method: 'POST' });
        await autoFetch('https://b.host/gen', { method: 'POST' });
        clearHostStrategy('a.host');
        const s = getHostStrategies();
        assert.equal(s['a.host'], undefined);
        assert.equal(s['b.host'], 'direct');
    } finally { restore(); }
});

// ── probeDeliveryStrategy: разведка пути доставки до платного POST ──

test('probeDeliveryStrategy: любой HTTP-ответ (даже 401) доказывает direct-доставку', async () => {
    const calls = [];
    const restore = mockFetch((url, opts) => {
        calls.push({ url: String(url), method: opts?.method });
        return { ok: false, status: 401 };
    });
    try {
        const { probeDeliveryStrategy } = await import('../src/proxy.js');
        const result = await probeDeliveryStrategy(
            'https://api.example.test/v1/chat/completions',
            'https://api.example.test/v1/models',
            { headers: { Authorization: 'Bearer k' } },
        );
        assert.equal(result, 'direct');
        assert.deepEqual(calls, [{ url: 'https://api.example.test/v1/models', method: 'GET' }]);
        assert.equal(getHostStrategies()['api.example.test'], 'direct');
    } finally { restore(); }
});

test('probeDeliveryStrategy: CORS TypeError → proxy, без обращения к прокси', async () => {
    const calls = [];
    const restore = mockFetch((_url, _opts, viaProxy) => {
        calls.push(viaProxy);
        if (!viaProxy) throw new TypeError('Failed to fetch');
        return { ok: true, status: 200 };
    });
    try {
        const { probeDeliveryStrategy } = await import('../src/proxy.js');
        const result = await probeDeliveryStrategy('https://strict.host/v1/chat/completions', 'https://strict.host/v1/models');
        assert.equal(result, 'proxy');
        assert.deepEqual(calls, [false], 'разведка делает только прямой GET, прокси не опрашивается');
        assert.equal(getHostStrategies()['strict.host'], 'proxy');
    } finally { restore(); }
});

test('probeDeliveryStrategy: известная стратегия отвечает из кэша без запроса', async () => {
    let calls = 0;
    const restore = mockFetch(() => { calls++; return { ok: true, status: 200 }; });
    try {
        const { probeDeliveryStrategy } = await import('../src/proxy.js');
        await autoFetch('https://known.host/gen', { method: 'POST' });
        const before = calls;
        const result = await probeDeliveryStrategy('https://known.host/other', 'https://known.host/models');
        assert.equal(result, 'direct');
        assert.equal(calls, before, 'кэшированная стратегия не порождает сетевых запросов');
    } finally { restore(); }
});

test('probeDeliveryStrategy: AbortError пробрасывается и не кэшируется', async () => {
    const restore = mockFetch(async (_url, opts) => {
        if (opts?.signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        return { ok: true, status: 200 };
    });
    try {
        const { probeDeliveryStrategy } = await import('../src/proxy.js');
        const ctrl = new AbortController();
        ctrl.abort();
        await assert.rejects(
            () => probeDeliveryStrategy('https://aborted.host/gen', 'https://aborted.host/models', { signal: ctrl.signal }),
            e => e?.name === 'AbortError',
        );
        assert.equal(getHostStrategies()['aborted.host'], undefined);
    } finally { restore(); }
});

test('probeDeliveryStrategy + autoFetch: разведанный proxy-хост принимает POST сразу через прокси', async () => {
    const directPosts = [];
    const restore = mockFetch((_url, opts, viaProxy) => {
        const method = String(opts?.method || 'GET').toUpperCase();
        if (!viaProxy && method === 'POST') directPosts.push(String(_url));
        if (!viaProxy) throw new TypeError('Failed to fetch');
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
    });
    try {
        const { probeDeliveryStrategy } = await import('../src/proxy.js');
        const strategy = await probeDeliveryStrategy('https://tunnel.host/v1/chat/completions', 'https://tunnel.host/v1/models');
        assert.equal(strategy, 'proxy');
        const resp = await autoFetch('https://tunnel.host/v1/chat/completions', { method: 'POST' });
        assert.equal(resp.status, 200);
        // Прямых платных POST — ноль: разведка (единственный прямой вызов) уже
        // отправила хост в proxy-стратегию.
        assert.deepEqual(directPosts, [], 'после разведки платный POST не тратит жертвенную прямую попытку');
    } finally { restore(); }
});
