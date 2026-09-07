// @ts-check
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals, mockFetch } from './_helpers.js';

installStGlobals();

const { fetchImageRoute, requestJson, requestMultipart, downloadResult } = await import('../src/image-transport.js');
const { _resetCache } = await import('../src/proxy.js');

function route(transport = {}) {
    return {
        id: 'route_123',
        generationContract: 'openai-images',
        transport: {
            bodyKind: 'json',
            proxyEligible: true,
            directCors: 'preferred',
            ...transport,
        },
    };
}

beforeEach(() => _resetCache());

test('requestJson delegates JSON routes to the contract transport', async () => {
    const calls = [];
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, options, viaProxy });
        return { ok: true, status: 202 };
    });
    try {
        const response = await requestJson('https://images.example/v1/generations', {
            method: 'POST', headers: { Authorization: 'Bearer image-key' }, body: '{"prompt":"cat"}',
        }, route());

        assert.equal(response.status, 202);
        assert.deepEqual(calls.map(call => call.viaProxy), [false]);
    } finally { restore(); }
});

test('requestMultipart uses direct CORS and exposes a typed actionable error', async () => {
    const restore = mockFetch(() => { throw new TypeError('Failed to fetch'); });
    try {
        await assert.rejects(
            () => requestMultipart('https://images.example/v1/edits', { method: 'POST', body: new FormData() }),
            error => error?.code === 'MULTIPART_CORS_REQUIRED' && /direct CORS/i.test(error.message),
        );
    } finally { restore(); }
});

test('requestMultipart clears inherited initialDelivery:proxy to direct (multipart cannot proxy)', async () => {
    let called = false;
    const restore = mockFetch(() => { called = true; return { ok: true, status: 200 }; });
    try {
        // Route with initialDelivery:'proxy' (set by browserDeliveryRoute when
        // useCorsProxy is on and catalog bodyKind is 'json'). requestMultipart
        // must override to 'direct' because multipart cannot traverse the proxy.
        // If initialDelivery were still 'proxy', transportFor would throw
        // "Proxy-first delivery requires a JSON route" before fetch is called.
        await requestMultipart('https://images.example/v1/edits', { method: 'POST', body: new FormData() }, {
            transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred', initialDelivery: 'proxy' },
        });
        assert.ok(called, 'direct fetch must be called (initialDelivery cleared from proxy to direct)');
    } finally { restore(); }
});

test('downloadResult uses direct transport without proxy fallback', async () => {
    const calls = [];
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, options, viaProxy });
        return { ok: true, status: 200 };
    });
    try {
        const response = await downloadResult('https://images.example/result.png');
        assert.equal(response.status, 200);
        assert.deepEqual(calls.map(call => call.viaProxy), [false]);
    } finally { restore(); }
});

test('fetchImageRoute returns the direct JSON response and preserves request headers and body', async () => {
    const calls = [];
    const headers = { Authorization: 'Bearer image-key', 'Content-Type': 'application/json' };
    const body = JSON.stringify({ prompt: 'cat' });
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, options, viaProxy });
        return { ok: true, status: 201 };
    });
    try {
        const response = await fetchImageRoute('https://images.example/v1/generations', {
            method: 'POST', headers, body,
        }, route(), 45_000);

        assert.equal(response.status, 201);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].viaProxy, false);
        assert.equal(calls[0].options.method, 'POST');
        assert.equal(calls[0].options.headers, headers);
        assert.equal(calls[0].options.body, body);
    } finally { restore(); }
});

test('fetchImageRoute never proxy-resubmits an ambiguous JSON POST despite eligible route metadata', async () => {
    const calls = [];
    const headers = { Authorization: 'Bearer image-key', 'Content-Type': 'application/json' };
    const body = JSON.stringify({ model: 'image-1', prompt: 'cat' });
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, options, viaProxy });
        throw new TypeError('Failed to fetch');
    });
    try {
        await assert.rejects(
            () => fetchImageRoute('https://images.example/v1/generations', {
                method: 'POST', headers, body,
            }, route()),
            error => error?.code === 'IMAGE_DELIVERY_AMBIGUOUS',
        );
        assert.deepEqual(calls.map(call => call.viaProxy), [false]);
    } finally { restore(); }
});

test('fetchImageRoute does not resubmit an ambiguous paid JSON POST', async () => {
    const calls = [];
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, options, viaProxy });
        throw new TypeError('Failed to fetch');
    });
    try {
        await assert.rejects(
            () => fetchImageRoute('https://images.example/v1/generations', { method: 'POST' }, route({ proxyEligible: false })),
            error => error?.code === 'IMAGE_DELIVERY_AMBIGUOUS' && /outcome is uncertain/i.test(error.message),
        );
        assert.deepEqual(calls.map(call => call.viaProxy), [false]);
    } finally { restore(); }
});

test('fetchImageRoute preserves proxy fallback for explicitly safe JSON GETs', async () => {
    const calls = [];
    const previousContext = globalThis.SillyTavern.getContext;
    globalThis.SillyTavern.getContext = () => ({
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'st-token' }),
    });
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, options, viaProxy });
        if (!viaProxy) throw new TypeError('Failed to fetch');
        return { ok: true, status: 200 };
    });
    try {
        await fetchImageRoute('https://images.example/v1/models', {
            method: 'GET',
            headers: { Authorization: 'Bearer image-key', 'Content-Type': 'application/json' },
        }, route());

        assert.deepEqual(calls.map(call => call.viaProxy), [false, true, true]);
        assert.equal(calls[0].options.headers['X-CSRF-Token'], undefined);
        // proxiedFetch passes headers through untouched: Accept-Encoding is a
        // forbidden fetch header the browser drops anyway, so it is not
        // injected; compressed proxy bodies are decoded at read time.
        assert.deepEqual(calls[2].options.headers, {
            'X-CSRF-Token': 'st-token',
            Authorization: 'Bearer image-key',
            'Content-Type': 'application/json',
        });
    } finally {
        restore();
        globalThis.SillyTavern.getContext = previousContext;
    }
});

test('fetchImageRoute does not proxy a GET when route is marked no-resubmit', async () => {
    const calls = [];
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, options, viaProxy });
        throw new TypeError('Failed to fetch');
    });
    try {
        await assert.rejects(
            () => fetchImageRoute('https://images.example/v1/models', { method: 'GET' }, route({ noResubmit: true })),
            error => error?.code === 'IMAGE_DELIVERY_AMBIGUOUS',
        );
        assert.deepEqual(calls.map(call => call.viaProxy), [false]);
    } finally { restore(); }
});
test('fetchImageRoute never falls back after an HTTP response', async () => {
    const calls = [];
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, options, viaProxy });
        return { ok: false, status: 503 };
    });
    try {
        const response = await fetchImageRoute('https://images.example/v1/generations', { method: 'POST' }, route());
        assert.equal(response.status, 503);
        assert.deepEqual(calls.map(call => call.viaProxy), [false]);
    } finally { restore(); }
});


test('fetchImageRoute reports typed ambiguous delivery when route policy disables proxy fallback', async () => {
    const calls = [];
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, options, viaProxy });
        throw new TypeError('Failed to fetch');
    });
    try {
        await assert.rejects(
            () => fetchImageRoute('https://images.example/v1/generations', { method: 'POST' }, route({ proxyEligible: false })),
            error => error?.code === 'IMAGE_DELIVERY_AMBIGUOUS' && /outcome is uncertain/i.test(error.message),
        );
        assert.deepEqual(calls.map(call => call.viaProxy), [false]);
    } finally { restore(); }
});

test('fetchImageRoute does not proxy an ordinary Error with a browser-like TypeError name and message', async () => {
    const calls = [];
    const original = new Error('Failed to fetch');
    original.name = 'TypeError';
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, options, viaProxy });
        throw original;
    });
    try {
        await assert.rejects(
            () => fetchImageRoute('https://images.example/v1/generations', { method: 'POST' }, route()),
            error => error === original,
        );
        assert.deepEqual(calls.map(call => call.viaProxy), [false]);
    } finally { restore(); }
});

test('fetchImageRoute preserves the proxy disabled diagnostic for safe JSON GETs', async () => {
    const calls = [];
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, options, viaProxy });
        if (!viaProxy) throw new TypeError('Failed to fetch');
        return { ok: false, status: 404, text: async () => 'CORS proxy is disabled.' };
    });
    try {
        await assert.rejects(
            () => fetchImageRoute('https://images.example/v1/generations', { method: 'GET' }, route()),
            /CORS-прокси SillyTavern недоступен/,
        );
        assert.equal(calls.filter(call => !call.viaProxy).length, 1);
        assert.equal(calls.filter(call => call.viaProxy).length, 1);
    } finally { restore(); }
});

test('fetchImageRoute rejects an invalid multipart proxy contract before sending a request', async () => {
    const calls = [];
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, options, viaProxy });
        return { ok: true, status: 200 };
    });
    try {
        await assert.rejects(
            () => fetchImageRoute('https://images.example/v1/edits', { method: 'POST', body: new FormData() }, route({
                bodyKind: 'multipart', proxyEligible: true, directCors: 'preferred',
            })),
            /multipart routes require direct CORS and cannot use the proxy/i,
        );
        assert.deepEqual(calls, []);
    } finally { restore(); }
});

test('fetchImageRoute rejects a JSON route without explicit transport metadata before sending', async () => {
    const calls = [];
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, options, viaProxy });
        return { ok: true, status: 200 };
    });
    try {
        await assert.rejects(
            () => fetchImageRoute('https://images.example/v1/generations', { method: 'POST' }, { transport: { bodyKind: 'json' } }),
            /JSON routes require explicit proxyEligible and directCors transport metadata/i,
        );
        assert.deepEqual(calls, []);
    } finally { restore(); }
});

test('fetchImageRoute requires direct CORS for multipart failures and never proxies them', async () => {
    const calls = [];
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, options, viaProxy });
        throw new TypeError('Failed to fetch');
    });
    try {
        await assert.rejects(
            () => fetchImageRoute('https://images.example/v1/edits', { method: 'POST', body: new FormData() }, route({
                bodyKind: 'multipart', proxyEligible: false, directCors: 'required',
            })),
            /multipart.*direct CORS|required.*direct CORS/i,
        );
        assert.deepEqual(calls.map(call => call.viaProxy), [false]);
    } finally { restore(); }
});

test('fetchImageRoute does not proxy a deliberate abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const calls = [];
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, options, viaProxy });
        throw new DOMException('Aborted', 'AbortError');
    });
    try {
        await assert.rejects(
            () => fetchImageRoute('https://images.example/v1/generations', { method: 'POST', signal: controller.signal }, route()),
            error => error?.name === 'AbortError',
        );
        assert.deepEqual(calls.map(call => call.viaProxy), [false]);
    } finally { restore(); }
});

// ── Proxy-first delivery (initialDelivery: 'proxy') ────────────────────────────
//
// When the connection opted into the ST CORS proxy and the route is
// JSON-eligible, `browserDeliveryRoute` sets `transport.initialDelivery =
// 'proxy'`. The paid POST must go through /proxy/ on the FIRST attempt with
// no direct try - this is the safe path for providers that send no CORS
// headers at all (CloseAI etc.), because the browser preflight would kill
// the direct POST before it ever reaches the provider, and the resulting
// `IMAGE_DELIVERY_AMBIGUOUS` would otherwise block the only working path.

test('fetchImageRoute dispatches through the proxy immediately when initialDelivery is proxy', async () => {
    const calls = [];
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, options, viaProxy });
        return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'aGk=' }] }) };
    });
    try {
        const response = await fetchImageRoute('https://closeai.example/v1/images/generations', {
            method: 'POST', headers: { Authorization: 'Bearer key' }, body: '{"prompt":"cat"}',
        }, route({ initialDelivery: 'proxy' }));
        assert.equal(response.status, 200);
        // proxiedFetch probes the ST /proxy/ once (GET example.com) then sends
        // the actual POST through /proxy/<url>. Both calls go via the proxy;
        // crucially NO direct attempt to the provider origin was made.
        assert.ok(calls.length >= 1);
        assert.ok(calls.every(call => call.viaProxy === true), 'no call may go direct to the provider origin');
        const postCall = calls.find(call => call.options?.method === 'POST');
        assert.ok(postCall, 'the paid POST must be dispatched through the proxy');
        assert.ok(String(postCall.url).includes('closeai.example'), 'POST must target the provider via the proxy');
    } finally { restore(); }
});

test('fetchImageRoute proxy-first never falls back to direct on proxy failure (no resubmit)', async () => {
    const calls = [];
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, viaProxy });
        // ST /proxy/ itself returned a network error - do NOT silently retry direct.
        throw new TypeError('Failed to fetch');
    });
    try {
        await assert.rejects(
            () => fetchImageRoute('https://closeai.example/v1/images/generations', { method: 'POST' }, route({ initialDelivery: 'proxy' })),
            // The proxy failure propagates as-is; no MULTIPART_CORS_REQUIRED and
            // no IMAGE_DELIVERY_AMBIGUOUS (those are direct-path codes). The
            // point is: one attempt only.
        );
        assert.equal(calls.length, 1, 'a proxy-first POST must not be retried direct after a proxy failure');
        assert.equal(calls[0].viaProxy, true);
    } finally { restore(); }
});

test('fetchImageRoute rejects proxy-first on a multipart route at transportFor time', async () => {
    const restore = mockFetch(() => { throw new Error('should not be reached'); });
    try {
        await assert.rejects(
            () => fetchImageRoute('https://images.example/v1/edits', { method: 'POST', body: new FormData() }, route({
                bodyKind: 'multipart', proxyEligible: false, directCors: 'required', initialDelivery: 'proxy',
            })),
            /Proxy-first delivery requires a JSON route/i,
        );
    } finally { restore(); }
});

test('fetchImageRoute allows proxy-first on a catalog-style proxyEligible:false JSON route (explicit user opt-in)', async () => {
    // catalog.js marks every route proxyEligible:false to block the automatic
    // direct->proxy fallback. Proxy-first is an explicit user choice for the
    // first attempt and must NOT be gated by that flag - otherwise providers
    // that send no CORS headers (CloseAI) stay unreachable even with the
    // useCorsProxy checkbox ticked.
    const calls = [];
    const restore = mockFetch((url, options, viaProxy) => {
        calls.push({ url, options, viaProxy });
        return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'aGk=' }] }) };
    });
    try {
        const response = await fetchImageRoute('https://closeai.example/v1/images/generations', {
            method: 'POST', body: '{"prompt":"cat"}',
        }, route({ proxyEligible: false, initialDelivery: 'proxy' }));
        assert.equal(response.status, 200);
        assert.ok(calls.every(call => call.viaProxy === true), 'no call may go direct');
    } finally { restore(); }
});
