// @ts-check
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
const extensionSettings = {};
const fetchCalls = [];
let providerResponse;

globalThis.SillyTavern = {
    getContext: () => ({
        extensionSettings,
        getRequestHeaders: () => ({ 'X-Test': 'browser-image-api' }),
        saveSettingsDebounced: () => {},
    }),
    libs: { localforage: {
        getItem: async key => store.get(key) ?? null,
        setItem: async (key, value) => { store.set(key, value); },
        removeItem: async key => { store.delete(key); },
    } },
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (url === 'https://images.example/v1/images/generations') {
        if (providerResponse instanceof Error) throw providerResponse;
        return providerResponse;
    }
    if (url === 'https://images.example/result.png') {
        return { ok: true, blob: async () => new Blob(['image-bytes'], { type: 'image/png' }) };
    }
    if (url === '/api/images/upload') return jsonResponse({ path: 'user/images/UR%20Image%20Studio/generated.png' });
    throw new Error(`Forbidden network call: ${options.method || 'GET'} ${url}`);
};

const { createConnection, setConnectionApiKey } = await import('../src/connection-store.js');
const { listPendingBrowserRequests, getPendingBrowserRequest, getPendingBrowserRequestStatus, discardPendingBrowserRequest, clearPendingBrowserRequests } = await import('../src/browser-image-recovery.js');
// These cases only ever assert browser-path records, so they read through the
// browser-owned reader rather than the legacy cross-kind one.
const getPendingImages = listPendingBrowserRequests;
const { listDiagnosticEvents, resetDiagnosticEventsForTests } = await import('../src/diagnostic-events.js');
const { generateImageRequest } = await import('../src/image-api.js');

after(() => { globalThis.fetch = originalFetch; });

function jsonResponse(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function connection() {
    return {
        id: 'browser-image', kind: 'image', name: 'Browser image', endpoint: 'https://images.example',
        selectedRoute: {
            id: 'route-openai', source: 'test', modelId: 'gpt-image-1', generationContract: 'openai-images',
            contractVersion: 1, capabilities: { generate: 'supported', references: 'unknown' },
            bodyKind: 'json', proxyEligible: true, directCors: 'preferred',
        },
    };
}

function request(overrides = {}) {
    return {
        requestId: 'req_browser_dispatch_0001', prompt: 'A brass observatory', aspectRatio: '16:9',
        imageSize: '2K', quality: 'high', references: [], chatId: 'chat-1', sourceMsgId: 7, ...overrides,
    };
}

beforeEach(async () => {
    store.clear();
    for (const key of Object.keys(extensionSettings)) delete extensionSettings[key];
    fetchCalls.length = 0;
    providerResponse = jsonResponse({ data: [{ b64_json: 'cmVhZHk=' }] });
    await createConnection(connection());
    await setConnectionApiKey('browser-image', 'local-key-only');
});

test('browser connection dispatches its persisted contract then materializes a native gallery card', async () => {
    const result = await generateImageRequest('browser-image', request());

    assert.equal(result.kind, 'dataUrl');
    assert.equal(result.galleryEntry.imagePath, 'user/images/UR%20Image%20Studio/generated.png');
    assert.equal(result.galleryEntry.prompt, 'A brass observatory');
    assert.equal(result.galleryEntry.provenance.chatId, 'chat-1');
    assert.equal(result.galleryEntry.provenance.sourceMsgId, 7);
    assert.ok(result.galleryEntry.provenance.characterFolder);
    assert.equal(result.galleryEntry.generationContract, 'openai-images');
    const providerCall = fetchCalls.find(call => call.url === 'https://images.example/v1/images/generations');
    assert.ok(providerCall);
    assert.equal(providerCall.options.headers.Authorization, 'Bearer local-key-only');
    assert.equal(fetchCalls.some(call => call.url.includes('/api/plugins/ur-image-studio')), false);
    assert.ok(fetchCalls.some(call => call.url === '/api/images/upload'));
    assert.equal(JSON.stringify(extensionSettings).includes('local-key-only'), false);
});

test('materialize-result records decoded image dimensions and derived aspect ratio', async () => {
    resetDiagnosticEventsForTests();
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async () => ({ width: 1536, height: 1024, close() {} });
    try {
        await generateImageRequest('browser-image', request({ aspectRatio: '16:9' }));
    } finally {
        if (originalCreateImageBitmap) globalThis.createImageBitmap = originalCreateImageBitmap;
        else delete globalThis.createImageBitmap;
    }
    const event = listDiagnosticEvents().find(item => item.event === 'materialize-result');
    assert.ok(event, 'materialize-result event missing');
    assert.equal(event.details.width, 1536);
    assert.equal(event.details.height, 1024);
    assert.equal(event.details.aspectRatio, '3:2');
    assert.equal(event.details.requestedAspectRatio, '16:9');
});

test('browser generation passes the resolved connection timeout to result materialization', async () => {
    const resolved = connection();
    resolved.timeoutMs = 16789;
    const originalSetTimeout = globalThis.setTimeout;
    const timeouts = [];
    globalThis.setTimeout = (callback, delay, ...args) => {
        timeouts.push(delay);
        return originalSetTimeout(callback, delay, ...args);
    };
    try {
        await createConnection(resolved);
        await setConnectionApiKey('browser-image', 'local-key-only');
        await generateImageRequest('browser-image', request());
    } finally {
        globalThis.setTimeout = originalSetTimeout;
    }

    assert.deepEqual(timeouts, [16789, 16789]);
});

test('resultReceived remains pending when native upload fails without provider redispatch', async () => {
    providerResponse = jsonResponse({ data: [{ url: 'https://images.example/result.png' }] });
    const standardFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
        fetchCalls.push({ url: String(url), options });
        if (url === 'https://images.example/v1/images/generations') return providerResponse;
        if (url === 'https://images.example/result.png') {
            return { ok: true, blob: async () => new Blob(['image-bytes'], { type: 'image/png' }) };
        }
        if (url === '/api/images/upload') throw new Error('Native upload unavailable');
        throw new Error(`Forbidden network call: ${options.method || 'GET'} ${url}`);
    };
    try {
        await assert.rejects(() => generateImageRequest('browser-image', request()), /Native upload unavailable/);
    } finally {
        globalThis.fetch = standardFetch;
    }

    const pending = await getPendingImages();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'resultReceived');
    assert.equal(fetchCalls.filter(call => call.url === 'https://images.example/v1/images/generations').length, 1);
});

test('missing browser-local key fails before a provider request with an actionable error', async () => {
    await setConnectionApiKey('browser-image', '');
    await assert.rejects(() => generateImageRequest('browser-image', request()), error => error.code === 'MISSING_API_KEY' && /API key/i.test(error.message));
    assert.equal(fetchCalls.length, 0);
});

test('paid browser network failure keeps dispatchingUnknown with one direct attempt and typed ambiguity', async () => {
    providerResponse = new TypeError('Failed to fetch');
    await assert.rejects(
        () => generateImageRequest('browser-image', request()),
        error => error?.code === 'IMAGE_DELIVERY_AMBIGUOUS' && /outcome is uncertain/i.test(error.message),
    );
    const pending = await getPendingImages();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'dispatchingUnknown');
    assert.equal(fetchCalls.filter(call => call.url === 'https://images.example/v1/images/generations').length, 1);
    assert.equal(fetchCalls.some(call => call.url.includes('/proxy/')), false);
});

test('provider HTTP errors do not retry a paid generation and remain reviewable', async () => {
    providerResponse = jsonResponse({ error: { message: 'Quota exhausted' } }, 429);
    await assert.rejects(() => generateImageRequest('browser-image', request()), error => error.code === 'UPSTREAM_HTTP_ERROR');
    assert.equal(fetchCalls.filter(call => call.url === 'https://images.example/v1/images/generations').length, 1);
    const pending = await getPendingImages();
    assert.equal(pending[0].status, 'dispatchingUnknown');
});

test('browser pending recovery bulk clear removes all browser-owned records', async () => {
    providerResponse = new TypeError('Failed to fetch');
    await assert.rejects(() => generateImageRequest('browser-image', request({ requestId: 'req-a' })));
    await assert.rejects(() => generateImageRequest('browser-image', request({ requestId: 'req-b' })));
    assert.equal((await listPendingBrowserRequests()).length, 2);
    assert.equal(await clearPendingBrowserRequests(), 2);
    assert.deepEqual(await listPendingBrowserRequests(), []);
});

test('browser pending recovery exposes status and explicit discard only', async () => {
    providerResponse = new TypeError('Failed to fetch');
    await assert.rejects(() => generateImageRequest('browser-image', request()));

    const pending = await listPendingBrowserRequests();
    assert.equal(pending.length, 1);
    assert.equal((await getPendingBrowserRequest(pending[0].id)).id, pending[0].id);
    assert.deepEqual(await getPendingBrowserRequestStatus(pending[0].id), {
        id: pending[0].id, requestId: pending[0].requestId, status: 'dispatchingUnknown', error: pending[0].error,
    });
    assert.equal(await discardPendingBrowserRequest(pending[0].id), true);
    assert.deepEqual(await listPendingBrowserRequests(), []);
    assert.equal(fetchCalls.filter(call => call.url === 'https://images.example/v1/images/generations').length, 1);
});

test('browser dispatch preserves a captured route through normalization and does not resubmit it', async () => {
    const capturedRoute = {
        id: 'route-captured', contractVersion: 1, generationContract: 'openai-images', modelId: 'gpt-image-1',
        capabilities: { references: 'supported', maxReferences: 1 },
        transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
    };

    await assert.rejects(
        () => generateImageRequest('browser-image', request({ references: [
            { id: 'first', dataUrl: 'data:image/png;base64,cG5n' },
            { id: 'second', dataUrl: 'data:image/jpeg;base64,anBlZw==' },
        ] }), undefined, undefined, { route: capturedRoute }),
        error => error?.code === 'TOO_MANY_REFERENCES',
    );

    assert.equal(fetchCalls.length, 0);
});

// ── Proxy-first generation delivery (connection useCorsProxy opt-in) ──────────
//
// When the connection card has `useCorsProxy: true` and the route is
// JSON-eligible, the paid POST must be dispatched through the ST /proxy/ on
// the first attempt - no direct try. This is the safe path for providers
// that send no CORS headers (CloseAI): the browser preflight would kill the
// direct POST before it reaches the provider, and IMAGE_DELIVERY_AMBIGUOUS
// would otherwise block the only working route.

test('browser dispatch routes a JSON generation through the ST proxy when useCorsProxy is set on the connection', async () => {
    // Reset fetch to a /proxy/-aware mock so we can observe viaProxy.
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        const urlStr = String(url);
        const viaProxy = urlStr.startsWith('/proxy/');
        const realUrl = viaProxy ? decodeURIComponent(urlStr.slice('/proxy/'.length)) : urlStr;
        calls.push({ url: realUrl, options, viaProxy });
        if (viaProxy && realUrl.endsWith('/v1/images/generations')) {
            return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'b3JkZXI=' }] }) };
        }
        if (viaProxy && realUrl === 'https://example.com') {
            // probeCorsProxy availability check.
            return { ok: true, status: 200, text: async () => '' };
        }
        if (realUrl === '/api/images/upload') return { ok: true, status: 200, json: async () => ({ path: 'user/images/UR%20Image%20Studio/proxy-first.png' }) };
        throw new Error(`unexpected fetch ${options.method || 'GET'} ${urlStr}`);
    };
    const proxyRoute = {
        id: 'route-proxy-first', contractVersion: 1, generationContract: 'openai-images', modelId: 'gpt-image-2',
        capabilities: { references: 'supported', maxReferences: 1 },
        transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
    };
    await createConnection({
        id: 'browser-proxy', kind: 'image', name: 'Proxy', endpoint: 'https://closeai.example/v1',
        useCorsProxy: true, selectedRoute: proxyRoute,
    });
    await setConnectionApiKey('browser-proxy', 'proxy-key');
    try {
        await generateImageRequest('browser-proxy', request({}), undefined, undefined, { route: proxyRoute });
        // The paid POST must have gone through /proxy/, never direct.
        const posts = calls.filter(c => c.options?.method === 'POST' && c.url.endsWith('/v1/images/generations'));
        assert.equal(posts.length, 1, 'exactly one paid POST');
        assert.equal(posts[0].viaProxy, true, 'the paid POST must traverse the ST proxy, not go direct');
    } finally {
        // Restore the file-level fetch mock for subsequent tests.
        globalThis.fetch = async (url, options = {}) => {
            fetchCalls.push({ url: String(url), options });
            if (url === 'https://images.example/v1/images/generations') {
                if (providerResponse instanceof Error) throw providerResponse;
                return providerResponse;
            }
            if (url === 'https://images.example/result.png') {
                return { ok: true, blob: async () => new Blob(['image-bytes'], { type: 'image/png' }) };
            }
            if (url === '/api/images/upload') return jsonResponse({ path: 'user/images/UR%20Image%20Studio/generated.png' });
            throw new Error(`Forbidden network call: ${options.method || 'GET'} ${url}`);
        };
    }
});
