// @ts-check
// TDD-контракт обхода страниц-перехватчиков бесплатных туннелей (loca.lt, ngrok-free).
//
// Проблема: localtunnel отдаёт consent-страницу с HTTP 511, а ngrok free —
// interstitial ERR_NGROK_6024 с HTTP 200+HTML всем запросам с браузерным
// User-Agent (расширение фетчит настоящим Chrome). Оба туннеля документируют
// обход сервисным заголовком: bypass-tunnel-reminder / ngrok-skip-browser-warning.
// Заголовок должен добавляться ТОЛЬКО туннельным хостам: кастомный заголовок
// включает CORS-preflight, и на посторонних эндпоинтах это лишний риск.
//
// Проверяем три слоя:
//   1. хелпер tunnelBypassHeaders(url) — таблица хостов → заголовки;
//   2. инъекция в core.fetchWithTimeout — покрывает прямой dispatch генерации,
//      proxiedFetch/autoFetch и всё, что ходит через core;
//   3. инъекция в catalog.catalogRequest — покрывает «Проверить» (connect-probe
//      фетчит сырым globalThis.fetch в обход core).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installStGlobals, mockFetch } from './_helpers.js';
import { tunnelBypassHeaders } from '../src/tunnel-bypass.js';

const LOCA = { 'bypass-tunnel-reminder': '1' };
const NGROK = { 'ngrok-skip-browser-warning': '1' };

// ── 1. хелпер: таблица хостов ────────────────────────────────────────────────

test('tunnelBypassHeaders: поддомен loca.lt → bypass-tunnel-reminder', () => {
    assert.deepEqual(tunnelBypassHeaders('https://relay.loca.lt/v1/models'), LOCA);
});

test('tunnelBypassHeaders: поддомен localtunnel.me → bypass-tunnel-reminder', () => {
    assert.deepEqual(tunnelBypassHeaders('https://my-tunnel.localtunnel.me/v1'), LOCA);
});

test('tunnelBypassHeaders: реальный вид ngrok-free.app → ngrok-skip-browser-warning', () => {
    assert.deepEqual(tunnelBypassHeaders('https://a10f-103-251-167-25.ngrok-free.app/v1/models'), NGROK);
});

test('tunnelBypassHeaders: ngrok.app и ngrok.dev → ngrok-skip-browser-warning', () => {
    assert.deepEqual(tunnelBypassHeaders('https://x.ngrok.app/v1'), NGROK);
    assert.deepEqual(tunnelBypassHeaders('https://x.ngrok.dev/v1'), NGROK);
});

test('tunnelBypassHeaders: регистр хоста не важен', () => {
    assert.deepEqual(tunnelBypassHeaders('https://Foo.LOCa.LT/v1'), LOCA);
});

test('tunnelBypassHeaders: порт, путь и query не мешают', () => {
    assert.deepEqual(tunnelBypassHeaders('https://x.ngrok-free.app:8443/v1/models?foo=1'), NGROK);
});

test('tunnelBypassHeaders: голый домен без поддомена не матчится', () => {
    // Туннель всегда живёт в поддомене (subdomain = id туннеля); голые
    // маркетинговые домены не должны получать служебные заголовки.
    assert.deepEqual(tunnelBypassHeaders('https://loca.lt/'), {});
    assert.deepEqual(tunnelBypassHeaders('https://ngrok.app/'), {});
});

test('tunnelBypassHeaders: похожие, но чужие хосты не матчатся', () => {
    assert.deepEqual(tunnelBypassHeaders('https://x.loca.lt.evil.io/v1'), {});
    assert.deepEqual(tunnelBypassHeaders('https://notloca.lt/v1'), {});
    assert.deepEqual(tunnelBypassHeaders('https://angrok.app/v1'), {});
    assert.deepEqual(tunnelBypassHeaders('https://evil.com/?u=https://y.loca.lt/v1'), {});
});

test('tunnelBypassHeaders: обычные хосты провайдеров → {}', () => {
    assert.deepEqual(tunnelBypassHeaders('https://api.example.test/v1/models'), {});
    assert.deepEqual(tunnelBypassHeaders('http://localhost:8000/api/images/list'), {});
    assert.deepEqual(tunnelBypassHeaders('https://pre-signed-firefly-prod.s3-accelerate.amazonaws.com/images/abc'), {});
});

test('tunnelBypassHeaders: относительные и мусорные входы → {}', () => {
    assert.deepEqual(tunnelBypassHeaders('/api/images/list'), {});
    assert.deepEqual(tunnelBypassHeaders('/proxy/https%3A%2F%2Fx.ngrok-free.app%2Fv1'), {});
    assert.deepEqual(tunnelBypassHeaders(''), {});
    assert.deepEqual(tunnelBypassHeaders('not a url'), {});
    assert.deepEqual(tunnelBypassHeaders(null), {});
    assert.deepEqual(tunnelBypassHeaders(undefined), {});
});

test('tunnelBypassHeaders: каждый вызов возвращает свежий объект', () => {
    const a = tunnelBypassHeaders('https://x.loca.lt/v1');
    a['bypass-tunnel-reminder'] = 'mutated';
    assert.deepEqual(tunnelBypassHeaders('https://x.loca.lt/v1'), LOCA);
});

// ── 2. инъекция в core.fetchWithTimeout ─────────────────────────────────────

beforeEach(() => {
    installStGlobals();
});

test('fetchWithTimeout: добавляет bypass на туннельный хост, сохраняя пользовательские заголовки', async () => {
    const seen = [];
    const restore = mockFetch((url, options) => {
        seen.push({ url: String(url), options });
        return { ok: true, status: 200, json: async () => ({}) };
    });
    try {
        const { fetchWithTimeout } = await import('../src/core.js');
        const response = await fetchWithTimeout(
            'https://a10f-103-251-167-25.ngrok-free.app/v1/models',
            { headers: { Authorization: 'Bearer k' } },
            5000,
        );
        await response.json(); // гасит deadline-таймер обёртки
        assert.equal(seen.length, 1);
        assert.equal(seen[0].options.headers['ngrok-skip-browser-warning'], '1');
        assert.equal(seen[0].options.headers.Authorization, 'Bearer k');
    } finally {
        restore();
    }
});

test('fetchWithTimeout: на обычном хосте служебных заголовков нет', async () => {
    const seen = [];
    const restore = mockFetch((url, options) => {
        seen.push({ url: String(url), options });
        return { ok: true, status: 200, json: async () => ({}) };
    });
    try {
        const { fetchWithTimeout } = await import('../src/core.js');
        const response = await fetchWithTimeout(
            'https://pre-signed-firefly-prod.s3-accelerate.amazonaws.com/images/abc',
            { headers: { Authorization: 'Bearer k' } },
            5000,
        );
        await response.json();
        assert.equal(seen[0].options.headers['bypass-tunnel-reminder'], undefined);
        assert.equal(seen[0].options.headers['ngrok-skip-browser-warning'], undefined);
        assert.equal(seen[0].options.headers.Authorization, 'Bearer k');
    } finally {
        restore();
    }
});

test('fetchWithTimeout: пользовательский bypass не перебивается инъекцией', async () => {
    const seen = [];
    const restore = mockFetch((url, options) => {
        seen.push({ url: String(url), options });
        return { ok: true, status: 200, json: async () => ({}) };
    });
    try {
        const { fetchWithTimeout } = await import('../src/core.js');
        const response = await fetchWithTimeout(
            'https://x.loca.lt/v1/models',
            { headers: { 'bypass-tunnel-reminder': 'custom-value' } },
            5000,
        );
        await response.json();
        assert.equal(seen[0].options.headers['bypass-tunnel-reminder'], 'custom-value');
    } finally {
        restore();
    }
});

test('fetchWithTimeout: same-origin запрос (relative URL) — без исключений и без заголовков', async () => {
    const seen = [];
    const restore = mockFetch((url, options) => {
        seen.push({ url: String(url), options });
        return { ok: true, status: 200, json: async () => ({}) };
    });
    try {
        const { fetchWithTimeout } = await import('../src/core.js');
        const response = await fetchWithTimeout('/proxy/https%3A%2F%2Fx.loca.lt%2Fv1', { method: 'GET' }, 5000);
        await response.json();
        // Запрос шёл без headers вовсе — инъекция не должна их порождать.
        assert.equal(seen[0].options.headers?.['bypass-tunnel-reminder'], undefined);
    } finally {
        restore();
    }
});

// ── 3. инъекция в catalog.catalogRequest (путь «Проверить», сырой fetch + ST-прокси) ──

test('discovery: direct-попытка к туннельному хосту несёт bypass-заголовок', async () => {
    const { catalogRequest } = await import('../src/catalog.js');
    const requests = [];
    await catalogRequest('https://y.loca.lt/v1/models', 'browser-key',
        async (url, options) => {
            requests.push([String(url), options]);
            return { ok: true, async json() { return { data: [] }; } };
        },
        async () => { throw new Error('proxy must not be called'); },
        {}, 120000);
    assert.equal(requests.length, 1);
    assert.equal(requests[0][1].headers['bypass-tunnel-reminder'], '1');
    assert.equal(requests[0][1].headers.Authorization, 'Bearer browser-key');
});

test('discovery: на обычном хосте служебных заголовков нет', async () => {
    const { catalogRequest } = await import('../src/catalog.js');
    const requests = [];
    await catalogRequest('https://api.example.test/v1/models', 'browser-key',
        async (url, options) => {
            requests.push([String(url), options]);
            return { ok: true, async json() { return { data: [] }; } };
        },
        async () => { throw new Error('proxy must not be called'); },
        {}, 120000);
    assert.equal(requests[0][1].headers['bypass-tunnel-reminder'], undefined);
    assert.equal(requests[0][1].headers['ngrok-skip-browser-warning'], undefined);
});

test('discovery: bypass сохраняется при fallback на ST-прокси (auto-режим)', async () => {
    const legs = [];
    const restore = mockFetch((url, options, viaProxy) => {
        legs.push({ url: String(url), viaProxy, headers: options.headers });
        // Прямая нога имитирует CORS-блокировку браузера.
        if (!viaProxy) throw new TypeError('Failed to fetch');
        // Probe доступности прокси (example.com) — любой ответ, кроме 404, годится.
        if (url === 'https://example.com') return { ok: true, status: 200, text: async () => 'ok' };
        return { ok: true, status: 200, async json() { return { data: [] }; } };
    });
    try {
        const { catalogRequest } = await import('../src/catalog.js');
        const { proxiedFetch } = await import('../src/proxy.js');
        await catalogRequest('https://y.loca.lt/v1/models', 'browser-key', globalThis.fetch, proxiedFetch, {}, 120000);
        const proxied = legs.find(leg => leg.viaProxy && /loca\.lt/.test(leg.url));
        assert.ok(proxied, 'ожидается leg через /proxy/ к туннельному хосту');
        assert.equal(proxied.headers['bypass-tunnel-reminder'], '1');
    } finally {
        restore();
    }
});
