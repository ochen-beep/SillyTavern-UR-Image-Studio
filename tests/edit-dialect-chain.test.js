// @ts-check
// Диалектная цепочка редактирования openai-images (multipart → JSON → img2img)
// под политикой доставки 'auto'. Транспорт скриптованный: ответ по URL+методу,
// OPTIONS-оракул мокается через globalThis.fetch (fetchWithTimeout).
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch } from './_helpers.js';

// Персистентный settings-бэг: опыт диалекта должен переживать запись/чтение
// коннекта в рамках теста (installStGlobals отдаёт свежий объект на каждый вызов).
const extensionSettings = {};
globalThis.SillyTavern = {
    getContext: () => ({ extensionSettings, saveSettingsDebounced: () => {} }),
    libs: { localforage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } },
};

const { invokeImageProvider } = await import('../src/image-provider-registry.js');
const { _resetDeliveryEvidenceForTests } = await import('../src/delivery-evidence.js');

const PNG = 'data:image/png;base64,cG5n';
const JPEG = 'data:image/jpeg;base64,anBlZw==';

// Кэш доступности ST-прокси session-глобальный — держим «доступен».
const { probeCorsProxy, _resetCache } = await import('../src/proxy.js');

function route(extra = {}) {
  return {
    contractVersion: 1,
    generationContract: 'openai-images',
    modelId: 'gpt-image-2',
    capabilities: { references: 'supported', maxReferences: 4 },
    transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred', ...extra.transport, ...(extra.transport?.deliveryPolicy ? {} : {}) },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'transport')),
  };
}

const AUTO_ROUTE = () => route({ transport: { deliveryPolicy: 'auto' } });

function connection(overrides = {}) {
  return { timeoutMs: 5000, ...overrides };
}

function request(overrides = {}) {
  return { prompt: 'Edit this', references: [{ dataUrl: PNG }, { dataUrl: JPEG }], requestId: 'req_chain_0001', ...overrides };
}

/**
 * Скриптованный транспорт: handler(url, {method}, kind) → Response-подобное.
 * requestMultipart к /edits, requestJson к /edits или /generations.
 */
function scriptedTransport(handler) {
  const calls = [];
  return {
    calls,
    requestJson: async (url, options, savedRoute, timeoutMs) => {
      calls.push({ kind: 'json', url, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null });
      return handler(url, options, 'json');
    },
    requestMultipart: async (url, options, savedRoute, timeoutMs) => {
      calls.push({ kind: 'multipart', url, method: 'POST' });
      return handler(url, options, 'multipart');
    },
    downloadResult: async () => { throw new Error('unexpected download'); },
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(async () => {
    delete extensionSettings.ur_image_studio;
    _resetDeliveryEvidenceForTests();
    _resetCache();
    // ST-прокси доступен (GET /proxy/example.com → 200).
    await probeCorsProxy(true);
});

test('chain: multipart CORS-dead + JSON accepted → JSON via proxy wins', async () => {
  const transport = scriptedTransport((url, options, kind) => {
    if (kind === 'multipart') throw Object.assign(new TypeError('Failed to fetch'), { code: 'MULTIPART_CORS_REQUIRED' });
    if (url.endsWith('/images/edits')) return jsonResponse({ data: [{ b64_json: 'anNvbg==' }] });
    throw new Error(`unexpected ${url}`);
  });
  // OPTIONS-оракул: preflight мёртв.
  const restore = mockFetch((_url, options) => {
    if (options?.method === 'OPTIONS') throw new TypeError('Failed to fetch');
    throw new Error('unexpected direct fetch');
  });
  try {
    const result = await invokeImageProvider({
      endpoint: 'https://gw.example', apiKey: 'k', connection: connection(),
      route: AUTO_ROUTE(), request: request(), transport,
    });
    assert.equal(result.kind, 'dataUrl');
    const kinds = transport.calls.map(c => `${c.kind}:${c.url.split('/v1/')[1]}`);
    assert.deepEqual(kinds, ['multipart:images/edits', 'json:images/edits'], 'multipart → JSON /edits через прокси, без img2img');
    assert.deepEqual(transport.calls[1].body.images, [{ image_url: PNG }, { image_url: JPEG }]);
  } finally { restore(); }
});

test('chain: JSON dialect rejected (422) → img2img via generations+image wins', async () => {
  const transport = scriptedTransport((url, options, kind) => {
    if (kind === 'multipart') throw Object.assign(new TypeError('Failed to fetch'), { code: 'MULTIPART_CORS_REQUIRED' });
    if (url.endsWith('/images/edits')) return jsonResponse({ error: { message: 'edits endpoint requires multipart' } }, 422);
    if (url.endsWith('/images/generations')) return jsonResponse({ data: [{ b64_json: 'aTJp' }] });
    throw new Error(`unexpected ${url}`);
  });
  const restore = mockFetch((_url, options) => {
    if (options?.method === 'OPTIONS') throw new TypeError('Failed to fetch');
    throw new Error('unexpected direct fetch');
  });
  try {
    const result = await invokeImageProvider({
      endpoint: 'https://gw.example', apiKey: 'k', connection: connection(),
      route: AUTO_ROUTE(), request: request(), transport,
    });
    assert.equal(result.value, 'data:image/png;base64,aTJp');
    const kinds = transport.calls.map(c => `${c.kind}:${c.url.split('/v1/')[1]}`);
    assert.deepEqual(kinds, ['multipart:images/edits', 'json:images/edits', 'json:images/generations'], 'третья нога — generations+image');
    const img2imgBody = transport.calls[2].body;
    assert.deepEqual(img2imgBody.image, [PNG, JPEG], 'референсы едут массивом data URL');
    assert.equal(img2imgBody.prompt, 'Edit this');
  } finally { restore(); }
});

test('chain: JSON leg answered 502 → terminal, the paid img2img leg never fires', async () => {
  // A 5xx means the gateway/upstream broke after possibly accepting the
  // request: the outcome is ambiguous and a second paid POST on top of it is
  // a double billing, not a dialect discovery.
  const transport = scriptedTransport((url, options, kind) => {
    if (kind === 'multipart') throw Object.assign(new TypeError('Failed to fetch'), { code: 'MULTIPART_CORS_REQUIRED' });
    if (url.endsWith('/images/edits')) return jsonResponse({ error: { message: 'bad gateway' } }, 502);
    throw new Error(`unexpected ${url}`);
  });
  const restore = mockFetch((_url, options) => {
    if (options?.method === 'OPTIONS') throw new TypeError('Failed to fetch');
    throw new Error('unexpected direct fetch');
  });
  try {
    await assert.rejects(
      () => invokeImageProvider({
        endpoint: 'https://gw.example', apiKey: 'k', connection: connection(),
        route: AUTO_ROUTE(), request: request(), transport,
      }),
      error => error?.httpStatus === 502,
    );
    assert.equal(transport.calls.length, 2, 'multipart + JSON only — no img2img leg');
  } finally { restore(); }
});

test('chain: both JSON and img2img rejected → EDITS_DIALECT_EXHAUSTED with both causes', async () => {
  const transport = scriptedTransport((url, options, kind) => {
    if (kind === 'multipart') throw Object.assign(new TypeError('Failed to fetch'), { code: 'MULTIPART_CORS_REQUIRED' });
    if (url.endsWith('/images/edits')) return jsonResponse({ error: { message: 'must be multipart' } }, 422);
    if (url.endsWith('/images/generations')) return jsonResponse({ error: { message: 'no image queue' } }, 400);
    throw new Error(`unexpected ${url}`);
  });
  const restore = mockFetch((_url, options) => {
    if (options?.method === 'OPTIONS') throw new TypeError('Failed to fetch');
    throw new Error('unexpected direct fetch');
  });
  try {
    await assert.rejects(
      () => invokeImageProvider({
        endpoint: 'https://gw.example', apiKey: 'k', connection: connection(),
        route: AUTO_ROUTE(), request: request(), transport,
      }),
      error => error?.code === 'EDITS_DIALECT_EXHAUSTED'
        && /HTTP 422/.test(error.message)
        && /HTTP 400/.test(error.message)
        && /недоступны из браузера/.test(error.message),
    );
    assert.equal(transport.calls.length, 3, 'ровно три попытки, без ретраев');
  } finally { restore(); }
});

test('chain: fresh img2img evidence skips straight to generations+image proxy-first', async () => {
  const store = await import('../src/connection-store.js');
  const evidence = await import('../src/delivery-evidence.js');
  await store.createConnection({ id: 'chain-hint', kind: 'image', name: 'X', endpoint: 'https://gw.example', model: { id: 'm', source: 'list' } });
  await evidence.noteEditDialectOutcome({ connId: 'chain-hint', endpoint: 'https://gw.example', dialect: 'img2img', ok: true });
  const conn = await store.getConnection('chain-hint');

  const transport = scriptedTransport((url, options, kind) => {
    if (kind === 'multipart') throw new Error('multipart must be skipped');
    if (url.endsWith('/images/edits')) throw new Error('edits must be skipped');
    if (url.endsWith('/images/generations')) return jsonResponse({ data: [{ b64_json: 'aTJp' }] });
    throw new Error(`unexpected ${url}`);
  });
  const result = await invokeImageProvider({
    endpoint: 'https://gw.example', apiKey: 'k', connection: { ...connection(), ...conn },
    route: AUTO_ROUTE(), request: request(), transport,
  });
  assert.equal(result.value, 'data:image/png;base64,aTJp');
  assert.deepEqual(transport.calls.map(c => `${c.kind}:${c.url.split('/v1/')[1]}`), ['json:images/generations'], 'опыт увёл цепочку сразу на img2img');
});

test('chain: auth rejection on JSON never falls through to img2img', async () => {
  const transport = scriptedTransport((url, options, kind) => {
    if (kind === 'multipart') throw Object.assign(new TypeError('Failed to fetch'), { code: 'MULTIPART_CORS_REQUIRED' });
    if (url.endsWith('/images/edits')) return jsonResponse({ error: { message: 'bad key' } }, 401);
    throw new Error(`unexpected ${url}`);
  });
  const restore = mockFetch((_url, options) => {
    if (options?.method === 'OPTIONS') throw new TypeError('Failed to fetch');
    throw new Error('unexpected direct fetch');
  });
  try {
    await assert.rejects(
      () => invokeImageProvider({
        endpoint: 'https://gw.example', apiKey: 'k', connection: connection(),
        route: AUTO_ROUTE(), request: request(), transport,
      }),
      error => error?.httpStatus === 401,
    );
    assert.equal(transport.calls.length, 2, '401 — не диалектный факт, img2img не запускается');
  } finally { restore(); }
});

test('chain: oracle alive on multipart → ambiguous, no dialect retry', async () => {
  const transport = scriptedTransport((url, options, kind) => {
    if (kind === 'multipart') throw Object.assign(new TypeError('Failed to fetch'), { code: 'MULTIPART_CORS_REQUIRED' });
    throw new Error(`unexpected ${url}`);
  });
  const restore = mockFetch((_url, options) => {
    if (options?.method === 'OPTIONS') return { ok: true, status: 200 };
    throw new Error('unexpected direct fetch');
  });
  try {
    await assert.rejects(
      () => invokeImageProvider({
        endpoint: 'https://gw.example', apiKey: 'k', connection: connection(),
        route: AUTO_ROUTE(), request: request(), transport,
      }),
      error => error?.code === 'IMAGE_DELIVERY_AMBIGUOUS' && /multipart/.test(error.message),
    );
    assert.deepEqual(transport.calls.map(c => c.kind), ['multipart'], 'исход неизвестен — диалекты не меняются');
  } finally { restore(); }
});

test('chain: explicit-direct policy keeps the shipped single multipart attempt', async () => {
  const transport = scriptedTransport((url, options, kind) => {
    if (kind === 'multipart') throw Object.assign(new TypeError('Failed to fetch'), { code: 'MULTIPART_CORS_REQUIRED' });
    throw new Error(`unexpected ${url}`);
  });
  try {
    await assert.rejects(
      () => invokeImageProvider({
        endpoint: 'https://gw.example', apiKey: 'k', connection: connection(),
        route: route({ transport: { deliveryPolicy: 'explicit-direct' } }), request: request(), transport,
      }),
      error => error?.code === 'MULTIPART_CORS_REQUIRED',
    );
    assert.deepEqual(transport.calls.map(c => c.kind), ['multipart'], 'явный приказ — ни оракула, ни цепочки');
  } finally { /* no fetch mock to restore */ }
});

test('chain: shipped explicit-proxy fallback goes through the same oracle (dead → JSON proxy)', async () => {
  const transport = scriptedTransport((url, options, kind) => {
    if (kind === 'multipart') throw Object.assign(new TypeError('Failed to fetch'), { code: 'MULTIPART_CORS_REQUIRED' });
    if (url.endsWith('/images/edits')) return jsonResponse({ data: [{ b64_json: 'c2hpcA==' }] });
    throw new Error(`unexpected ${url}`);
  });
  const restore = mockFetch((_url, options) => {
    if (options?.method === 'OPTIONS') throw new TypeError('Failed to fetch');
    throw new Error('unexpected direct fetch');
  });
  try {
    const result = await invokeImageProvider({
      endpoint: 'https://gw.example', apiKey: 'k', connection: connection({ useCorsProxy: true }),
      route: route({ transport: { deliveryPolicy: 'explicit-proxy' } }), request: request(), transport,
    });
    assert.equal(result.value, 'data:image/png;base64,c2hpcA==');
    assert.deepEqual(transport.calls.map(c => c.kind), ['multipart', 'json'], 'исторический фолбэк сохранён, но за оракулом');
  } finally { restore(); }
});

test('chain: shipped explicit-proxy fallback refuses when the oracle cannot prove non-delivery', async () => {
  const transport = scriptedTransport((url, options, kind) => {
    if (kind === 'multipart') throw Object.assign(new TypeError('Failed to fetch'), { code: 'MULTIPART_CORS_REQUIRED' });
    throw new Error(`unexpected ${url}`);
  });
  const restore = mockFetch((_url, options) => {
    if (options?.method === 'OPTIONS') return { ok: true, status: 200 };
    throw new Error('unexpected direct fetch');
  });
  try {
    await assert.rejects(
      () => invokeImageProvider({
        endpoint: 'https://gw.example', apiKey: 'k', connection: connection({ useCorsProxy: true }),
        route: route({ transport: { deliveryPolicy: 'explicit-proxy' } }), request: request(), transport,
      }),
      error => error?.code === 'IMAGE_DELIVERY_AMBIGUOUS' && /multipart/.test(error.message),
    );
    assert.deepEqual(transport.calls.map(c => c.kind), ['multipart'], 'alive-оракул запрещает смену диалекта и для явной галочки');
  } finally { restore(); }
});

test('chain: img2img body keeps geometry and omits input_fidelity', async () => {
  const transport = scriptedTransport((url, options, kind) => {
    if (kind === 'multipart') throw Object.assign(new TypeError('Failed to fetch'), { code: 'MULTIPART_CORS_REQUIRED' });
    if (url.endsWith('/images/edits')) return jsonResponse({ error: { message: 'must be multipart' } }, 422);
    if (url.endsWith('/images/generations')) return jsonResponse({ data: [{ b64_json: 'aTJp' }] });
    throw new Error(`unexpected ${url}`);
  });
  const restore = mockFetch((_url, options) => {
    if (options?.method === 'OPTIONS') throw new TypeError('Failed to fetch');
    throw new Error('unexpected direct fetch');
  });
  try {
    await invokeImageProvider({
      endpoint: 'https://gw.example', apiKey: 'k', connection: connection(),
      route: AUTO_ROUTE(), request: { prompt: 'Edit this', aspectRatio: '16:9', quality: 'auto', references: [{ dataUrl: PNG }], requestId: 'req_chain_0002' }, transport,
    });
    const body = transport.calls[2].body;
    assert.equal(body.size, '1536x1024', 'геометрия едет как в generations');
    assert.equal(body.input_fidelity, undefined, 'input_fidelity — параметр edits, в generations не идёт');
    assert.equal(body.aspect_ratio, undefined);
  } finally { restore(); }
});

// Ремап 401→400 в ST /proxy/ (живое наблюдение 2026-10-03: невалидный ключ
// напрямую 401, через прокси 400 «无效的令牌»): платная JSON-нога падает 400-й,
// и раньше цепочка тратила img2img-ногу и отдавала EDITS_DIALECT_EXHAUSTED
// вместо честной auth-ошибки. Теперь 400 на прокси проходит бесплатную пробу
// GET /models: сломанный ключ останавливает цепочку, живой — идёт дальше.
test('chain: проксированный 400 + сломанный ключ (проба 400) → img2img не тратится', async () => {
  const transport = scriptedTransport((url, options, kind) => {
    if (kind === 'multipart') throw Object.assign(new TypeError('Failed to fetch'), { code: 'MULTIPART_CORS_REQUIRED' });
    if (url.endsWith('/images/edits')) return jsonResponse({ error: { message: '无效的令牌' } }, 400);
    if (url.endsWith('/models')) return jsonResponse({ error: { message: '无效的令牌' } }, 400);
    throw new Error(`unexpected ${url}`);
  });
  const restore = mockFetch((_url, options) => {
    if (options?.method === 'OPTIONS') throw new TypeError('Failed to fetch');
    throw new Error('unexpected direct fetch');
  });
  try {
    await assert.rejects(
      () => invokeImageProvider({ endpoint: 'https://gw.example', apiKey: 'k', connection: connection(), route: AUTO_ROUTE(), request: request(), transport }),
      /无效的令牌/,
      'пользователь видит исходную ошибку платной ноги, а не EDITS_DIALECT_EXHAUSTED',
    );
    const kinds = transport.calls.map(c => `${c.kind}:${c.url.split('/v1/')[1]}`);
    assert.deepEqual(kinds, ['multipart:images/edits', 'json:images/edits', 'json:models'],
      'img2img-нога не выполняется: бесплатная проба доказала, что 400 — это auth');
  } finally { restore(); }
});

test('chain: проксированный 400 + живой ключ (проба 200) → img2img идёт как раньше', async () => {
  const transport = scriptedTransport((url, options, kind) => {
    if (kind === 'multipart') throw Object.assign(new TypeError('Failed to fetch'), { code: 'MULTIPART_CORS_REQUIRED' });
    if (url.endsWith('/images/edits')) return jsonResponse({ error: { message: 'unknown parameter' } }, 400);
    if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'gpt-image-2' }] });
    if (url.endsWith('/images/generations')) return jsonResponse({ data: [{ b64_json: 'aTIyaQ==' }] });
    throw new Error(`unexpected ${url}`);
  });
  const restore = mockFetch((_url, options) => {
    if (options?.method === 'OPTIONS') throw new TypeError('Failed to fetch');
    throw new Error('unexpected direct fetch');
  });
  try {
    const result = await invokeImageProvider({
      endpoint: 'https://gw.example', apiKey: 'k', connection: connection(),
      route: AUTO_ROUTE(), request: request(), transport,
    });
    assert.equal(result.kind, 'dataUrl');
    const kinds = transport.calls.map(c => `${c.kind}:${c.url.split('/v1/')[1]}`);
    assert.deepEqual(kinds, ['multipart:images/edits', 'json:images/edits', 'json:models', 'json:images/generations'],
      'живой ключ: проба пропускает дальше, строгий шлюз получает img2img как раньше');
  } finally { restore(); }
});
