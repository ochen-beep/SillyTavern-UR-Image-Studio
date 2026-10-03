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
const serverFiles = new Map();
globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (url === '/api/files/verify') return jsonResponse({});
    if (url === '/api/files/upload' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        serverFiles.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
        return jsonResponse({});
    }
    if (String(url).startsWith('/user/files/')) {
        const name = decodeURIComponent(String(url).slice('/user/files/'.length));
        if (!serverFiles.has(name)) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
        return { ok: true, status: 200, text: async () => serverFiles.get(name), json: async () => ({}) };
    }
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
const { _resetDeliveryEvidenceForTests, noteDeliveryPostOutcome, _peekEvidenceForTests } = await import('../src/delivery-evidence.js');
const connectionsFacade = await import('../src/connections.js');

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
    _resetDeliveryEvidenceForTests();
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

    // Таймаут дедлайнный: fetchWithTimeout (core.js) планирует таймер на остаток
    // бюджета (deadlineAt - Date.now()), поэтому ноги получают 16789 или на
    // несколько миллисекунд меньше — тем меньше, чем сильнее загружена машина
    // (полный набор идёт параллельными процессами). Точное равенство делало тест
    // флапающим; проверяем, что каждая нога ушла именно с этим бюджетом.
    // (Разведка доставки #10 добавляет свой 15с-таймер — в legs он не входит.)
    const legs = timeouts.filter(delay => delay <= 16789 && delay >= 16789 * 0.9);
    assert.equal(legs.length, 2, 'ожидались ровно два таймера ног: скачивание и загрузка на сервер');
    for (const delay of legs) {
        assert.ok(
            delay <= 16789 && delay >= 16789 * 0.9,
            `таймаут ${delay} мс должен быть остатком бюджета 16789 мс — иначе нога ушла не с тем таймаутом`,
        );
    }
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

test('auto delivery: a direct POST failure with a dead preflight probes OPTIONS and, with the proxy unreachable, surfaces the proxy hint while recording the broken-direct experience', async () => {
    providerResponse = new TypeError('Failed to fetch');
    await assert.rejects(
        () => generateImageRequest('browser-image', request()),
        /CORS-прокси SillyTavern недоступен/,
    );
    const pending = await getPendingImages();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'dispatchingUnknown');
    const generationCalls = fetchCalls.filter(call => call.url === 'https://images.example/v1/images/generations');
    assert.equal(generationCalls.filter(call => call.options?.method === 'POST').length, 1, 'ровно одна прямая попытка платного POST');
    assert.equal(generationCalls.some(call => call.options?.method === 'OPTIONS'), true, 'preflight-оракул должен был провернуть OPTIONS');
    assert.equal(fetchCalls.some(call => call.options?.method === 'POST' && call.url.includes('/proxy/')), false, 'прокси недоступен — попытка спасения не доходит до POST');
    // Опыт записи: прямая помечена сломанной — следующая «Авто»-генерация пойдёт через прокси.
    const peek = _peekEvidenceForTests('browser-image');
    assert.ok(peek.delivery?.directBrokenAt, 'опыт о сломанной прямой должен быть записан');
});

test('auto delivery: dead preflight with a working ST proxy rescues the generation in the same call', async () => {
    const calls = [];
    const standardFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
        const urlStr = String(url);
        const viaProxy = urlStr.startsWith('/proxy/');
        const realUrl = viaProxy ? decodeURIComponent(urlStr.slice('/proxy/'.length)) : urlStr;
        calls.push({ url: realUrl, options, viaProxy });
        if (viaProxy && realUrl === 'https://example.com') return { ok: true, status: 200, text: async () => '' };
        if (realUrl === 'https://images.example/v1/images/generations') {
            if (viaProxy) return jsonResponse({ data: [{ b64_json: 'cmVzY3VlZA==' }] });
            throw new TypeError('Failed to fetch');
        }
        if (options.method === 'OPTIONS') throw new TypeError('Failed to fetch');
        if (realUrl === '/api/images/upload') return jsonResponse({ path: 'user/images/UR%20Image%20Studio/rescued.png' });
        throw new Error(`Forbidden network call: ${options.method || 'GET'} ${urlStr}`);
    };
    try {
        const result = await generateImageRequest('browser-image', request({ requestId: 'req_oracle_rescue_0001' }));
        assert.equal(result.kind, 'dataUrl');
        const sequence = calls.filter(call => call.url.endsWith('/v1/images/generations')).map(call => ({ viaProxy: call.viaProxy, method: call.options?.method }));
        assert.deepEqual(sequence, [
            { viaProxy: false, method: 'POST' },
            { viaProxy: false, method: 'OPTIONS' },
            { viaProxy: true, method: 'POST' },
        ], 'прямой POST → OPTIONS-оракул → спасение через прокси, один платный запрос суммарно');
        // Опыт записи: прямая помечена сломанной — следующая генерация пойдёт через прокси сразу.
        // Запись fire-and-forget — коротко дождёмся персиста.
        let peek = _peekEvidenceForTests('browser-image');
        for (let i = 0; i < 40 && !peek.delivery?.directBrokenAt; i++) {
            await new Promise(resolve => setTimeout(resolve, 5));
            peek = _peekEvidenceForTests('browser-image');
        }
        assert.ok(peek.delivery?.directBrokenAt);
    } finally {
        globalThis.fetch = standardFetch;
    }
});

test('auto delivery: a fresh broken-direct experience routes the next generation through the proxy without a doomed direct attempt', async () => {
    await noteDeliveryPostOutcome({ connId: 'browser-image', endpoint: 'https://images.example', delivery: 'direct', ok: false });
    const calls = [];
    const standardFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
        const urlStr = String(url);
        const viaProxy = urlStr.startsWith('/proxy/');
        const realUrl = viaProxy ? decodeURIComponent(urlStr.slice('/proxy/'.length)) : urlStr;
        calls.push({ url: realUrl, options, viaProxy });
        if (viaProxy && realUrl === 'https://example.com') return { ok: true, status: 200, text: async () => '' };
        if (viaProxy && realUrl === 'https://images.example/v1/images/generations') {
            return jsonResponse({ data: [{ b64_json: 'cHJveHk=' }] });
        }
        if (realUrl === '/api/images/upload') return jsonResponse({ path: 'user/images/UR%20Image%20Studio/via-proxy.png' });
        throw new Error(`unexpected fetch ${options.method || 'GET'} ${urlStr}`);
    };
    try {
        const result = await generateImageRequest('browser-image', request({ requestId: 'req_ladder_proxy_0001' }));
        assert.equal(result.kind, 'dataUrl');
        const providerCalls = calls.filter(call => call.url.endsWith('/v1/images/generations'));
        assert.equal(providerCalls.length, 1, 'ровно одна попытка к провайдеру');
        assert.equal(providerCalls[0].viaProxy, true, 'опыт сломанной прямой должен увести POST на прокси без повторного фейла');
    } finally {
        globalThis.fetch = standardFetch;
    }
});

test('auto delivery: a direct success clears the broken verdict and stamps directOkAt', async () => {
    await noteDeliveryPostOutcome({
        connId: 'browser-image', endpoint: 'https://images.example', delivery: 'direct', ok: false,
        now: Date.now() - 31 * 60 * 1000,
    });
    await generateImageRequest('browser-image', request({ requestId: 'req_direct_ok_0001' }));
    const peek = _peekEvidenceForTests('browser-image');
    // Нормализатор опускает пустые поля: «вердикта нет» = ключ отсутствует.
    assert.ok(!peek.delivery?.directBrokenAt, 'успешный прямой POST должен стирать вердикт «сломана»');
    assert.ok(peek.delivery?.directOkAt, 'и фиксировать рабочий прямой путь');
});

test('explicit-direct delivery never probes OPTIONS and keeps the typed ambiguity', async () => {
    await connectionsFacade.saveConnection({ id: 'browser-image', overrides: { delivery: 'direct' } });
    providerResponse = new TypeError('Failed to fetch');
    await assert.rejects(
        () => generateImageRequest('browser-image', request()),
        error => error?.code === 'IMAGE_DELIVERY_AMBIGUOUS' && /исход неизвестен/i.test(error.message),
    );
    const generationCalls = fetchCalls.filter(call => call.url === 'https://images.example/v1/images/generations');
    assert.deepEqual(generationCalls.map(call => call.options?.method), ['POST'], 'явный приказ «Только напрямую» — никаких OPTIONS и прокси');
});

test('provider HTTP errors close the record (known outcome), network-unknown stays reviewable', async () => {
    // Решение 2026-10-02: в INFO — только фактический результат. Ответ
    // провайдера (429) — исход известен: запись закрывается, карточка
    // «результат запроса неизвестен» не рождается (ошибку видно в QUEUE и
    // пуле, технический след — в dispatch-error журнале).
    providerResponse = jsonResponse({ error: { message: 'Quota exhausted' } }, 429);
    await assert.rejects(() => generateImageRequest('browser-image', request()), error => error.code === 'UPSTREAM_HTTP_ERROR');
    assert.equal(fetchCalls.filter(call => call.url === 'https://images.example/v1/images/generations').length, 1);
    assert.deepEqual(await getPendingImages(), [], 'HTTP-ответ — исход известен, страховка не нужна');
    // Обрыв сети — честное «неизвестно» (POST мог уйти): запись остаётся.
    providerResponse = new TypeError('Failed to fetch');
    await assert.rejects(() => generateImageRequest('browser-image', request({ requestId: 'req_net_unknown_0001' })));
    const pending = await listPendingBrowserRequests();
    assert.equal(pending.length, 1);
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
    assert.equal(fetchCalls.filter(call => call.url === 'https://images.example/v1/images/generations' && call.options?.method === 'POST').length, 1);
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
// that send no CORS headers (providers without CORS headers): the browser preflight would kill the
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
        id: 'browser-proxy', kind: 'image', name: 'Proxy', endpoint: 'https://no-cors.example/v1',
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
