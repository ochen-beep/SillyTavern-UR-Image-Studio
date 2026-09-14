import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultServices, init } from '../server-plugin/index.js';
import { claimRequest, getRequest, transitionRequest } from '../server-plugin/src/journal/journal.js';
import { getUserPaths } from '../server-plugin/src/storage/paths.js';
import { registerRoutes } from '../server-plugin/src/router.js';
import { ServerImageError } from '../server-plugin/src/errors.js';
import { createReceiptCache } from '../server-plugin/src/services/receipt-cache.js';
import { importConnections, rollbackImport } from '../server-plugin/src/services/connections.js';
import { getOrCreateJournalKey } from '../server-plugin/src/storage/journal-key-store.js';
import { readJson, writeJson } from '../server-plugin/src/storage/atomic-json.js';
import { createFakeRouter } from './server-plugin/fake-router.js';
import { cleanupTempDir, useTempDir } from './server-plugin/temp-store.js';

const STATUS_BODY = {
  ok: true,
  apiVersion: 1,
  features: {
    connections: true,
    discovery: true,
    generation: true,
    requestRecovery: true,
  },
  apiFamilies: ['openai-images', 'gemini-native', 'openrouter-images'],
};

function makeReq(root) {
  return { user: { directories: { root } } };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function findRoute(routes, path, method = 'GET') {
  const route = routes.find(candidate => candidate.method === method && candidate.path === path);
  assert.ok(route, `${method} ${path} should be registered`);
  return route.handlers[0];
}

function discoveredRoute(overrides = {}) {
  return {
    id: 'route123456',
    modelId: 'image-model',
    label: 'Image Model',
    apiFamily: 'openai-images',
    source: 'openai-models',
    confidence: 'high',
    capabilities: {
      generate: 'supported',
      references: 'unknown',
      maxReferences: null,
      aspectRatios: null,
      imageSizes: null,
      qualityValues: null,
    },
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('server router', () => {
  it('registers exactly the twelve server image HTTP routes', () => {
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      ensureReconciled: async () => {},
      listConnections: async () => [],
    });

    assert.deepEqual(routes.map(({ method, path }) => ({ method, path })), [
      { method: 'GET', path: '/v1/status' },
      { method: 'GET', path: '/v1/store/status' },
      { method: 'GET', path: '/v1/store/:collection' },
      { method: 'GET', path: '/v1/store/:collection/:id' },
      { method: 'POST', path: '/v1/store/:collection' },
      { method: 'PUT', path: '/v1/store/:collection' },
      { method: 'PUT', path: '/v1/store/:collection/:id' },
      { method: 'DELETE', path: '/v1/store/:collection/:id' },
      { method: 'GET', path: '/v1/connections' },
      { method: 'GET', path: '/v1/connections/export' },
      { method: 'POST', path: '/v1/connections/import' },
      { method: 'POST', path: '/v1/connections/import/:importOperationId/rollback' },
      { method: 'POST', path: '/v1/connections/probe' },
      { method: 'POST', path: '/v1/connections/:connectionId/probe' },
      { method: 'POST', path: '/v1/connections' },
      { method: 'PUT', path: '/v1/connections/:connectionId' },
      { method: 'DELETE', path: '/v1/connections/:connectionId' },
      { method: 'POST', path: '/v1/generate' },
      { method: 'GET', path: '/v1/requests/:requestId' },
    ]);
  });

  it('fails closed on every route when user root is missing without invoking services', async () => {
    const calls = [];
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      async ensureReconciled() { calls.push('reconcile'); },
      async listConnections() { calls.push('list'); return []; },
    });

    for (const path of ['/v1/status', '/v1/connections']) {
      for (const req of [{}, { user: {} }, { user: { directories: {} } }]) {
        const res = makeRes();
        await findRoute(routes, path)(req, res);
        assert.equal(res.statusCode, 401);
        assert.equal(res.body.error.code, 'SERVER_USER_CONTEXT_MISSING');
        assert.equal(res.body.error.message, 'Authenticated user context is required');
        assert.deepEqual(Object.keys(res.body.error).sort(), ['code', 'diagnosticsId', 'message', 'retryable']);
      }
    }

    assert.deepEqual(calls, []);
  });

  it('translates unexpected handler failures to a safe internal envelope', async () => {
    const leaked = 'SQL failed at C:\\Users\\alice\\private.db with token sk-secret';
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      async ensureReconciled() {},
      async listConnections() { throw new Error(leaked); },
    });
    const res = makeRes();

    await findRoute(routes, '/v1/connections')(makeReq('alice'), res);

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error.code, 'INTERNAL_ERROR');
    assert.equal(res.body.error.message, 'An internal server error occurred');
    assert.equal(JSON.stringify(res.body).includes(leaked), false);
  });

  it('isolates users and returns only the exact safe connections envelope', async () => {
    const aliceSafe = { id: 'alice123456', name: 'Alice', hasApiKey: true };
    const bobSafe = { id: 'bob1234567', name: 'Bob', hasApiKey: false };
    const records = new Map([
      ['/users/alice', [{ ...aliceSafe, secretId: 'alice-secret', operations: ['private'] }]],
      ['/users/bob', [{ ...bobSafe, secretId: 'bob-secret', privatePath: '/users/bob' }]],
    ]);
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      ensureReconciled: async () => {},
      listConnections: async (req) => records.get(req.user.directories.root).map(record => ({
        id: record.id,
        name: record.name,
        hasApiKey: record.hasApiKey,
      })),
    });
    const handler = findRoute(routes, '/v1/connections');
    const aliceRes = makeRes();
    const bobRes = makeRes();

    await handler(makeReq('/users/alice'), aliceRes);
    await handler(makeReq('/users/bob'), bobRes);

    assert.equal(aliceRes.statusCode, 200);
    assert.deepEqual(aliceRes.body, { connections: [aliceSafe] });
    assert.deepEqual(bobRes.body, { connections: [bobSafe] });
    assert.equal(JSON.stringify([aliceRes.body, bobRes.body]).includes('secret'), false);
    assert.equal(JSON.stringify([aliceRes.body, bobRes.body]).includes('privatePath'), false);
  });

  it('awaits reconciliation before status and connection listing', async () => {
    const calls = [];
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      async ensureReconciled(req) {
        calls.push(`reconcile:${req.user.directories.root}`);
      },
      async listConnections(req) {
        calls.push(`list:${req.user.directories.root}`);
        return [];
      },
    });

    const statusRes = makeRes();
    await findRoute(routes, '/v1/status')(makeReq('alice'), statusRes);
    assert.deepEqual(statusRes.body, STATUS_BODY);
    await findRoute(routes, '/v1/connections')(makeReq('bob'), makeRes());

    assert.deepEqual(calls, ['reconcile:alice', 'reconcile:bob', 'list:bob']);
  });

  it('coalesces concurrent first reconciliation requests for the same user', async () => {
    const barrier = deferred();
    let reconciliationCalls = 0;
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      async ensureReconciled() {
        reconciliationCalls += 1;
        await barrier.promise;
      },
      async listConnections() {
        return [];
      },
    });
    const status = findRoute(routes, '/v1/status');
    const list = findRoute(routes, '/v1/connections');

    const statusPending = status(makeReq('alice'), makeRes());
    const listPending = list(makeReq('alice'), makeRes());
    await Promise.resolve();
    assert.equal(reconciliationCalls, 1);

    barrier.resolve();
    await Promise.all([statusPending, listPending]);
    assert.equal(reconciliationCalls, 1);
  });

  it('returns a safe reconciliation error, skips listing, and permits retry', async () => {
    let reconciliationCalls = 0;
    let listCalls = 0;
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      async ensureReconciled() {
        reconciliationCalls += 1;
        if (reconciliationCalls === 1) {
          throw new ServerImageError({
            code: 'RECONCILIATION_UNAVAILABLE',
            message: 'Connection recovery is temporarily unavailable',
            retryable: true,
            diagnosticsId: 'diag-reconcile',
          });
        }
      },
      async listConnections() {
        listCalls += 1;
        return [];
      },
    });
    const handler = findRoute(routes, '/v1/connections');
    const failed = makeRes();
    const retried = makeRes();

    await handler(makeReq('alice'), failed);
    assert.equal(failed.statusCode, 503);
    assert.deepEqual(failed.body, {
      error: {
        code: 'RECONCILIATION_UNAVAILABLE',
        message: 'Connection recovery is temporarily unavailable',
        retryable: true,
        diagnosticsId: 'diag-reconcile',
      },
    });
    assert.equal(listCalls, 0);

    await handler(makeReq('alice'), retried);
    assert.equal(retried.statusCode, 200);
    assert.deepEqual(retried.body, { connections: [] });
    assert.equal(reconciliationCalls, 2);
    assert.equal(listCalls, 1);
  });

  it('retains a matching receipt on write failure, consumes it after success, and rejects replay', async () => {
    const route = discoveredRoute();
    let attempts = 0;
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      ensureReconciled: async () => {},
      listConnections: async () => [],
      probeTransient: async () => ({ routes: [route], warnings: [] }),
      async createConnection() {
        attempts += 1;
        if (attempts === 1) throw new Error('metadata unavailable');
        return { id: 'connection123456' };
      },
    });
    const probeRes = makeRes();
    await findRoute(routes, '/v1/connections/probe', 'POST')({
      ...makeReq('alice'),
      body: { endpoint: 'https://images.example.com/v1', apiKey: 'secret', apiFamilyOverride: 'openai-images' },
    }, probeRes);
    const request = {
      ...makeReq('alice'),
      body: {
        id: 'connection123456',
        endpoint: 'https://images.example.com/v1',
        apiKey: 'secret',
        probeId: probeRes.body.probeId,
        modelRoute: route,
      },
    };
    const create = findRoute(routes, '/v1/connections', 'POST');

    const failed = makeRes();
    await create(request, failed);
    assert.equal(failed.statusCode, 500);

    const succeeded = makeRes();
    await create(request, succeeded);
    assert.equal(succeeded.statusCode, 201);

    const replayed = makeRes();
    await create(request, replayed);
    assert.equal(replayed.statusCode, 400);
    assert.equal(replayed.body.error.code, 'PROBE_RECEIPT_INVALID');
    assert.equal(attempts, 2);
  });

  it('requires an exact non-null sanitized route and keeps receipts after mismatches', async () => {
    const route = discoveredRoute({ remoteMetadata: { private: 'discarded' } });
    const calls = [];
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      ensureReconciled: async () => {},
      listConnections: async () => [],
      probeTransient: async () => ({ routes: [route], warnings: [] }),
      async createConnection(_req, input) {
        calls.push(input.modelRoute);
        return { id: input.id };
      },
    });
    const probeRes = makeRes();
    await findRoute(routes, '/v1/connections/probe', 'POST')({
      ...makeReq('alice'),
      body: { endpoint: 'https://images.example.com/v1', apiKey: 'secret', apiFamilyOverride: 'openai-images' },
    }, probeRes);
    const create = findRoute(routes, '/v1/connections', 'POST');
    const base = {
      id: 'connection123456', endpoint: 'https://images.example.com/v1',
      apiKey: 'secret', probeId: probeRes.body.probeId,
    };

    for (const modelRoute of [null, discoveredRoute({ modelId: 'attacker-model' })]) {
      const res = makeRes();
      await create({ ...makeReq('alice'), body: { ...base, modelRoute } }, res);
      assert.equal(res.body.error.code, 'PROBE_RECEIPT_INVALID');
    }

    const accepted = makeRes();
    await create({
      ...makeReq('alice'),
      body: { ...base, modelRoute: { ...route, remoteMetadata: { private: 'different-discarded' } } },
    }, accepted);
    assert.equal(accepted.statusCode, 201);
    assert.equal(calls.length, 1);
  });

  it('preserves an existing key for route-only updates authorized by stored refresh', async () => {
    const route = discoveredRoute();
    const updates = [];
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      ensureReconciled: async () => {},
      listConnections: async () => [],
      async refreshStored() {
        return {
          routes: [route], warnings: [],
          receiptContext: { endpoint: 'https://images.example.com/v1', apiKeyDigest: 'stored-key-digest' },
        };
      },
      async getStoredReceiptContext() {
        return { endpoint: 'https://images.example.com/v1', apiKeyDigest: 'stored-key-digest' };
      },
      async updateConnection(_req, id, input, apiKey) {
        updates.push({ id, input, apiKey });
        return { id };
      },
    });
    const refreshRes = makeRes();
    await findRoute(routes, '/v1/connections/:connectionId/probe', 'POST')({
      ...makeReq('alice'), params: { connectionId: 'connection123456' },
    }, refreshRes);
    assert.equal(typeof refreshRes.body.probeId, 'string');
    assert.equal('receiptContext' in refreshRes.body, false);

    const changedEndpoint = makeRes();
    await findRoute(routes, '/v1/connections/:connectionId', 'PUT')({
      ...makeReq('alice'),
      params: { connectionId: 'connection123456' },
      body: {
        endpoint: 'https://attacker.example.com/v1',
        probeId: refreshRes.body.probeId,
        modelRoute: route,
      },
    }, changedEndpoint);
    assert.equal(changedEndpoint.body.error.code, 'PROBE_RECEIPT_INVALID');

    const updateRes = makeRes();
    await findRoute(routes, '/v1/connections/:connectionId', 'PUT')({
      ...makeReq('alice'),
      params: { connectionId: 'connection123456' },
      body: {
        endpoint: 'https://images.example.com/v1', apiKey: '   ',
        probeId: refreshRes.body.probeId, modelRoute: route,
      },
    }, updateRes);
    assert.equal(updateRes.statusCode, 200);
    assert.equal(updates[0].apiKey, undefined);
  });

  it('rejects arbitrary discovered update routes but permits explicit manual routes without a receipt', async () => {
    const updates = [];
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      ensureReconciled: async () => {},
      listConnections: async () => [],
      getStoredReceiptContext: async () => ({ endpoint: 'https://images.example.com/v1', apiKeyDigest: 'stored' }),
      async updateConnection(_req, id, input, apiKey) {
        updates.push({ id, input, apiKey });
        return { id };
      },
    });
    const update = findRoute(routes, '/v1/connections/:connectionId', 'PUT');
    const params = { connectionId: 'connection123456' };
    const discovered = makeRes();
    await update({
      ...makeReq('alice'), params,
      body: { endpoint: 'https://images.example.com/v1', modelRoute: discoveredRoute() },
    }, discovered);
    assert.equal(discovered.body.error.code, 'PROBE_RECEIPT_INVALID');

    const manual = makeRes();
    await update({
      ...makeReq('alice'), params,
      body: {
        endpoint: 'https://images.example.com/v1',
        modelRoute: discoveredRoute({ source: 'manual', confidence: 'manual' }),
      },
    }, manual);
    assert.equal(manual.statusCode, 200);
    assert.equal(updates.length, 1);
  });

  it('returns the exact delete envelope', async () => {
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      ensureReconciled: async () => {},
      listConnections: async () => [],
      deleteConnection: async () => ({ id: 'connection123456', deleted: true, private: 'omit' }),
    });
    const res = makeRes();
    await findRoute(routes, '/v1/connections/:connectionId', 'DELETE')({
      ...makeReq('alice'), params: { connectionId: 'connection123456' },
    }, res);
    assert.deepEqual(res.body, { deleted: true, connectionId: 'connection123456' });
  });

  it('GET /v1/connections/export returns portable templates for each connection', async () => {
    const records = [
      { id: 'conn123456', name: 'My API', endpoint: 'https://api.example.com/v1', apiFamilyOverride: 'openai-images', timeoutMs: 30000, selectedRoute: { id: 'r1', modelId: 'dall-e-3', label: 'DALL-E 3', apiFamily: 'openai-images', source: 'openai-models', confidence: 'high', capabilities: { generate: 'supported', references: 'unknown', maxReferences: null, aspectRatios: null, imageSizes: null, qualityValues: null } }, secretId: 'sec-1', catalog: { routes: [], fetchedAt: '2025-01-01', stale: false, warnings: [] }, createdAt: '2025-01-01', updatedAt: '2025-01-01' },
      { id: 'conn654321', name: 'Another', endpoint: 'https://another.example.com/v1', apiFamilyOverride: 'gemini-native', timeoutMs: 60000, selectedRoute: { id: 'r2', modelId: 'gemini-2.0-flash-exp-image-generation', label: 'Gemini', apiFamily: 'gemini-native', source: 'openai-models', confidence: 'high', capabilities: { generate: 'supported', references: 'unknown', maxReferences: null, aspectRatios: null, imageSizes: null, qualityValues: null } }, secretId: 'sec-2', createdAt: '2025-01-02', updatedAt: '2025-01-02' },
    ];
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      ensureReconciled: async () => {},
      listConnections: async () => [],
      exportConnections: async () => records.map(r => ({
        id: r.id, name: r.name, endpoint: r.endpoint,
        selectedRoute: { modelId: r.selectedRoute.modelId, apiFamily: r.selectedRoute.apiFamily, source: r.selectedRoute.source, confidence: r.selectedRoute.confidence, capabilities: r.selectedRoute.capabilities },
        apiFamilyOverride: r.apiFamilyOverride, timeoutMs: r.timeoutMs,
      })),
    });
    const res = makeRes();
    await findRoute(routes, '/v1/connections/export')(makeReq('alice'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.connections.length, 2);
    const tmpl = res.body.connections[0];
    assert.equal(tmpl.id, 'conn123456');
    assert.equal(tmpl.name, 'My API');
    assert.equal(tmpl.endpoint, 'https://api.example.com/v1');
    assert.equal(tmpl.apiFamilyOverride, 'openai-images');
    assert.equal(tmpl.timeoutMs, 30000);
    assert.equal(tmpl.selectedRoute.modelId, 'dall-e-3');
    assert.equal(tmpl.selectedRoute.apiFamily, 'openai-images');
    assert.equal(tmpl.selectedRoute.source, 'openai-models');
    assert.equal(tmpl.selectedRoute.confidence, 'high');
    assert.ok(tmpl.selectedRoute.capabilities);
  });

  it('GET /v1/connections/export excludes secretId, apiKey, catalog, journal, artifacts', async () => {
    const records = [
      { id: 'conn123456', name: 'My API', endpoint: 'https://api.example.com/v1', apiFamilyOverride: 'openai-images', timeoutMs: 30000, selectedRoute: { modelId: 'dall-e-3', apiFamily: 'openai-images', source: 'openai-models', confidence: 'high', capabilities: {} }, secretId: 'sec-123', catalog: { routes: ['data'] }, journal: { entries: [] }, artifacts: { files: [] } },
    ];
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      ensureReconciled: async () => {},
      listConnections: async () => [],
      exportConnections: async () => records.map(r => ({
        id: r.id, name: r.name, endpoint: r.endpoint,
        selectedRoute: { modelId: r.selectedRoute.modelId, apiFamily: r.selectedRoute.apiFamily, source: r.selectedRoute.source, confidence: r.selectedRoute.confidence, capabilities: r.selectedRoute.capabilities },
        apiFamilyOverride: r.apiFamilyOverride, timeoutMs: r.timeoutMs,
      })),
    });
    const res = makeRes();
    await findRoute(routes, '/v1/connections/export')(makeReq('alice'), res);
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes('secretId'), 'secretId leaked');
    assert.ok(!body.includes('sec-123'), 'secret value leaked');
    assert.ok(!body.includes('catalog'), 'catalog leaked');
    assert.ok(!body.includes('journal'), 'journal leaked');
    assert.ok(!body.includes('artifacts'), 'artifacts leaked');
  });

  it('GET /v1/connections/export returns empty array when no connections exist', async () => {
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      ensureReconciled: async () => {},
      listConnections: async () => [],
      exportConnections: async () => [],
    });
    const res = makeRes();
    await findRoute(routes, '/v1/connections/export')(makeReq('alice'), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { connections: [] });
  });

  it('GET /v1/connections/export requires authenticated user context', async () => {
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      ensureReconciled: async () => {},
      listConnections: async () => [],
      exportConnections: async () => [],
    });
    for (const req of [{}, { user: {} }, { user: { directories: {} } }]) {
      const res = makeRes();
      await findRoute(routes, '/v1/connections/export')(req, res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error.code, 'SERVER_USER_CONTEXT_MISSING');
    }
  });

  it('isolates reconciliation failure between users', async () => {
    const calls = [];
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      async ensureReconciled(req) {
        const root = req.user.directories.root;
        calls.push(`reconcile:${root}`);
        if (root === 'alice') {
          throw new ServerImageError({
            code: 'RECONCILIATION_UNAVAILABLE',
            message: 'Alice unavailable',
            retryable: true,
          });
        }
      },
      async listConnections(req) {
        const root = req.user.directories.root;
        calls.push(`list:${root}`);
        return [{ id: root }];
      },
    });
    const handler = findRoute(routes, '/v1/connections');
    const aliceRes = makeRes();
    const bobRes = makeRes();

    await Promise.all([
      handler(makeReq('alice'), aliceRes),
      handler(makeReq('bob'), bobRes),
    ]);

    assert.equal(aliceRes.statusCode, 503);
    assert.deepEqual(bobRes.body, { connections: [{ id: 'bob' }] });
    assert.deepEqual(calls.sort(), ['list:bob', 'reconcile:alice', 'reconcile:bob']);
  });
});

describe('POST /v1/connections/import', () => {
  const template = (overrides = {}) => ({
    id: 'conn123456',
    name: 'Imported Conn',
    endpoint: 'https://api.example.com/v1',
    selectedRoute: {
      id: 'route_1234567890abcdef12345678',
      modelId: 'dall-e-3',
      apiFamily: 'openai-images',
      source: 'openai-models',
      confidence: 'high',
      capabilities: { generate: 'supported', references: 'unknown', maxReferences: null, aspectRatios: null, imageSizes: null, qualityValues: null },
    },
    apiFamilyOverride: 'openai-images',
    timeoutMs: 30000,
    version: 1,
    ...overrides,
  });

  const manualTemplate = (overrides = {}) => ({
    id: 'conn789012',
    name: 'Manual Conn',
    endpoint: 'https://manual.example.com/v1',
    selectedRoute: {
      id: 'route_abcdef1234567890abcdef12',
      modelId: 'custom-model',
      apiFamily: 'openai-images',
      source: 'manual',
      confidence: 'manual',
      capabilities: { generate: 'supported', references: 'unknown', maxReferences: null, aspectRatios: null, imageSizes: null, qualityValues: null },
    },
    apiFamilyOverride: 'openai-images',
    timeoutMs: 60000,
    version: 1,
    ...overrides,
  });

  const remoteTemplate = (overrides = {}) => ({
    id: 'conn345678',
    name: 'Remote Conn',
    endpoint: 'https://remote.example.com/v1',
    selectedRoute: {
      id: 'route_9876543210abcdef98765432',
      modelId: 'gemini-2.0-flash-exp-image-generation',
      apiFamily: 'gemini-native',
      source: 'openai-models',
      confidence: 'high',
      capabilities: { generate: 'supported', references: 'unknown', maxReferences: null, aspectRatios: null, imageSizes: null, qualityValues: null },
    },
    apiFamilyOverride: 'gemini-native',
    timeoutMs: 120000,
    version: 1,
    ...overrides,
  });

  it('creates keyless connections with new IDs', async () => {
    const root = useTempDir();
    try {
      const paths = getUserPaths(makeReq(root));
      const journalKeyBytes = await getOrCreateJournalKey(paths);
      const result = await importConnections(paths, [template()], journalKeyBytes);

      assert.equal(typeof result.importOperationId, 'string');
      assert.equal(typeof result.rollbackToken, 'string');
      assert.equal(result.connections.length, 1);
      assert.equal(result.connections[0].id, 'conn123456');
      assert.equal(result.connections[0].hasApiKey, false);
      assert.equal(result.connections[0].secretId, undefined);
      assert.deepEqual(result.idMap, {});
      assert.equal(result.created.length, 1);
      assert.equal(result.created[0].id, 'conn123456');
      assert.equal(result.created[0].version, 1);
      assert.deepEqual(result.reusedIds, []);

      // Verify records are on disk
      const records = await readJson(paths.connections, []);
      assert.equal(records.length, 1);
      assert.equal(records[0].secretId, null);
      assert.equal(records[0].hasApiKey, undefined);
      assert.equal(records[0].modelRouteId, 'route_1234567890abcdef12345678');
      assert.equal(records[0].selectedRoute.id, 'route_1234567890abcdef12345678');
    } finally {
      cleanupTempDir(root);
    }
  });

  it('reuses identical existing metadata', async () => {
    const root = useTempDir();
    try {
      const paths = getUserPaths(makeReq(root));
      const journalKeyBytes = await getOrCreateJournalKey(paths);
      // First import
      await importConnections(paths, [template()], journalKeyBytes);
      // Second import with same metadata
      const result = await importConnections(paths, [template()], journalKeyBytes);

      assert.equal(result.connections.length, 0);
      assert.deepEqual(result.created, []);
      assert.deepEqual(result.reusedIds, ['conn123456']);
      assert.deepEqual(result.idMap, {});
    } finally {
      cleanupTempDir(root);
    }
  });

  it('generates a new ID when a matching connection selects a different route ID', async () => {
    const root = useTempDir();
    try {
      const paths = getUserPaths(makeReq(root));
      const journalKeyBytes = await getOrCreateJournalKey(paths);
      await importConnections(paths, [template()], journalKeyBytes);
      const result = await importConnections(paths, [template({ selectedRoute: {
        ...template().selectedRoute,
        id: 'route_aaaaaaaaaaaaaaaaaaaaaaaa',
      } })], journalKeyBytes);

      assert.equal(result.connections.length, 1);
      assert.notEqual(result.connections[0].id, 'conn123456');
      assert.ok(result.idMap.conn123456);
    } finally {
      cleanupTempDir(root);
    }
  });

  it('generates new IDs on collision and returns idMap', async () => {
    const root = useTempDir();
    try {
      const paths = getUserPaths(makeReq(root));
      const journalKeyBytes = await getOrCreateJournalKey(paths);
      // First import with original ID
      await importConnections(paths, [template()], journalKeyBytes);
      // Second import with same ID but different metadata
      const result = await importConnections(paths, [template({ name: 'Different Name' })], journalKeyBytes);

      assert.equal(result.connections.length, 1);
      assert.notEqual(result.connections[0].id, 'conn123456');
      assert.ok(result.idMap['conn123456']);
      assert.equal(result.idMap['conn123456'], result.connections[0].id);
      assert.deepEqual(result.reusedIds, []);
    } finally {
      cleanupTempDir(root);
    }
  });

  it('stores manual routes exactly', async () => {
    const root = useTempDir();
    try {
      const paths = getUserPaths(makeReq(root));
      const journalKeyBytes = await getOrCreateJournalKey(paths);
      const result = await importConnections(paths, [manualTemplate()], journalKeyBytes);

      assert.equal(result.connections.length, 1);
      assert.equal(result.connections[0].id, 'conn789012');
      assert.equal(result.connections[0].hasApiKey, false);

      // Verify stored record has manual route without requiresProbe
      const records = await readJson(paths.connections, []);
      assert.ok(records[0].selectedRoute);
      assert.equal(records[0].selectedRoute.source, 'manual');
      assert.equal(records[0].selectedRoute.requiresProbe, undefined);
    } finally {
      cleanupTempDir(root);
    }
  });

  it('stores remote routes with requiresProbe: true', async () => {
    const root = useTempDir();
    try {
      const paths = getUserPaths(makeReq(root));
      const journalKeyBytes = await getOrCreateJournalKey(paths);
      const result = await importConnections(paths, [remoteTemplate()], journalKeyBytes);

      assert.equal(result.connections.length, 1);
      assert.equal(result.connections[0].id, 'conn345678');

      // Verify stored record has requiresProbe: true
      const records = await readJson(paths.connections, []);
      assert.ok(records[0].selectedRoute);
      assert.equal(records[0].selectedRoute.source, 'openai-models');
      assert.equal(records[0].selectedRoute.requiresProbe, true);
    } finally {
      cleanupTempDir(root);
    }
  });

  it('rejects malformed IDs and credential-bearing endpoints before persisting imports', async () => {
    const root = useTempDir();
    try {
      const paths = getUserPaths(makeReq(root));
      const journalKeyBytes = await getOrCreateJournalKey(paths);

      for (const unsafeTemplate of [
        template({ id: '../conn123456' }),
        template({ endpoint: 'https://api-key@api.example.com/v1' }),
        template({ endpoint: 'https://api.example.com/v1?api_key=secret' }),
      ]) {
        await assert.rejects(importConnections(paths, [unsafeTemplate], journalKeyBytes));
        assert.deepEqual(await readJson(paths.connections, []), []);
      }
    } finally {
      cleanupTempDir(root);
    }
  });

  it('validates imported route payloads and normalizes valid portable records before persistence', async () => {
    const root = useTempDir();
    try {
      const paths = getUserPaths(makeReq(root));
      const journalKeyBytes = await getOrCreateJournalKey(paths);

      for (const unsafeTemplate of [
        template({ apiFamilyOverride: 'unsupported-api' }),
        template({ selectedRoute: { ...template().selectedRoute, id: '../unsafe-route' } }),
        template({ selectedRoute: { ...template().selectedRoute, apiFamily: 'unsupported-api' } }),
      ]) {
        await assert.rejects(importConnections(paths, [unsafeTemplate], journalKeyBytes));
        assert.deepEqual(await readJson(paths.connections, []), []);
      }

      await importConnections(paths, [template({
        name: '  Portable Conn  ',
        endpoint: 'https://API.example.com:443/v1',
        secretId: 'attacker-secret',
        apiKey: 'attacker-api-key',
        selectedRoute: { ...template().selectedRoute, capabilities: 'not-an-object' },
      })], journalKeyBytes);

      const [stored] = await readJson(paths.connections, []);
      assert.equal(stored.name, 'Portable Conn');
      assert.equal(stored.endpoint, 'https://api.example.com/v1');
      assert.equal(stored.secretId, null);
      assert.deepEqual(stored.selectedRoute.capabilities, {
        generate: 'unknown', references: 'unknown', maxReferences: null,
        aspectRatios: null, imageSizes: null, qualityValues: null,
      });
      assert.equal(stored.selectedRoute.requiresProbe, true);
    } finally {
      cleanupTempDir(root);
    }
  });

  it('returns importOperationId and rollbackToken', async () => {
    const root = useTempDir();
    try {
      const paths = getUserPaths(makeReq(root));
      const journalKeyBytes = await getOrCreateJournalKey(paths);
      const result = await importConnections(paths, [template(), manualTemplate()], journalKeyBytes);

      assert.equal(typeof result.importOperationId, 'string');
      assert.ok(result.importOperationId.length > 0);
      assert.equal(typeof result.rollbackToken, 'string');
      assert.ok(result.rollbackToken.length > 0);
      assert.equal(result.rollbackToken, /^[a-f0-9]{64}$/.test(result.rollbackToken) ? result.rollbackToken : 'not a hex string');
      assert.match(result.rollbackToken, /^[a-f0-9]+$/);
    } finally {
      cleanupTempDir(root);
    }
  });

  it('requires authenticated user', async () => {
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      ensureReconciled: async () => {},
      listConnections: async () => [],
      importConnections: async () => ({}),
    });
    for (const req of [{}, { user: {} }, { user: { directories: {} } }]) {
      const res = makeRes();
      await findRoute(routes, '/v1/connections/import', 'POST')(req, res);
      assert.equal(res.statusCode, 401);
    }
  });
});

describe('POST /v1/connections/import/:id/rollback', () => {
  it('removes newly created records', async () => {
    const root = useTempDir();
    try {
      const paths = getUserPaths(makeReq(root));
      const journalKeyBytes = await getOrCreateJournalKey(paths);
      const importResult = await importConnections(paths, [
        { id: 'conn111111', name: 'One', endpoint: 'https://api.example.com/v1', selectedRoute: null, apiFamilyOverride: 'openai-images', timeoutMs: 30000, version: 1 },
        { id: 'conn222222', name: 'Two', endpoint: 'https://api.example.com/v1', selectedRoute: null, apiFamilyOverride: 'openai-images', timeoutMs: 30000, version: 1 },
      ], journalKeyBytes);

      const result = await rollbackImport(paths, importResult.importOperationId, importResult.rollbackToken, journalKeyBytes);

      assert.deepEqual(result.deleted.sort(), ['conn111111', 'conn222222']);
      assert.deepEqual(result.skippedModified, []);

      // Verify records are gone from disk
      const records = await readJson(paths.connections, []);
      assert.equal(records.length, 0);
    } finally {
      cleanupTempDir(root);
    }
  });

  it('skips modified records', async () => {
    const root = useTempDir();
    try {
      const paths = getUserPaths(makeReq(root));
      const journalKeyBytes = await getOrCreateJournalKey(paths);
      const importResult = await importConnections(paths, [
        { id: 'conn111111', name: 'One', endpoint: 'https://api.example.com/v1', selectedRoute: null, apiFamilyOverride: 'openai-images', timeoutMs: 30000, version: 1 },
        { id: 'conn222222', name: 'Two', endpoint: 'https://api.example.com/v1', selectedRoute: null, apiFamilyOverride: 'openai-images', timeoutMs: 30000, version: 1 },
      ], journalKeyBytes);

      // Manually modify one record's version on disk to simulate external update
      const records = await readJson(paths.connections, []);
      const modified = records.map(r => r.id === 'conn111111' ? { ...r, name: 'Modified', version: 2 } : r);
      await writeJson(paths.connections, modified);

      const result = await rollbackImport(paths, importResult.importOperationId, importResult.rollbackToken, journalKeyBytes);

      assert.deepEqual(result.deleted, ['conn222222']);
      assert.deepEqual(result.skippedModified, ['conn111111']);
    } finally {
      cleanupTempDir(root);
    }
  });

  it('is idempotent', async () => {
    const root = useTempDir();
    try {
      const paths = getUserPaths(makeReq(root));
      const journalKeyBytes = await getOrCreateJournalKey(paths);
      const importResult = await importConnections(paths, [
        { id: 'conn111111', name: 'One', endpoint: 'https://api.example.com/v1', selectedRoute: null, apiFamilyOverride: 'openai-images', timeoutMs: 30000, version: 1 },
      ], journalKeyBytes);

      // First rollback
      const first = await rollbackImport(paths, importResult.importOperationId, importResult.rollbackToken, journalKeyBytes);
      assert.deepEqual(first.deleted, ['conn111111']);
      assert.deepEqual(first.skippedModified, []);

      // Second rollback should be idempotent
      const second = await rollbackImport(paths, importResult.importOperationId, importResult.rollbackToken, journalKeyBytes);
      assert.deepEqual(second.deleted, []);
      assert.deepEqual(second.skippedModified, []);

      // Verify no records remain
      const records = await readJson(paths.connections, []);
      assert.equal(records.length, 0);
    } finally {
      cleanupTempDir(root);
    }
  });

  it('rejects invalid rollbackToken', async () => {
    const root = useTempDir();
    try {
      const paths = getUserPaths(makeReq(root));
      const journalKeyBytes = await getOrCreateJournalKey(paths);
      const importResult = await importConnections(paths, [
        { id: 'conn111111', name: 'One', endpoint: 'https://api.example.com/v1', selectedRoute: null, apiFamilyOverride: 'openai-images', timeoutMs: 30000, version: 1 },
      ], journalKeyBytes);

      await assert.rejects(
        rollbackImport(paths, importResult.importOperationId, 'invalid-token', journalKeyBytes),
        /Invalid rollback token/,
      );

      // Verify records still exist
      const records = await readJson(paths.connections, []);
      assert.equal(records.length, 1);
    } finally {
      cleanupTempDir(root);
    }
  });

  it('requires authenticated user', async () => {
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      ensureReconciled: async () => {},
      listConnections: async () => [],
      rollbackImport: async () => ({}),
    });
    for (const req of [{}, { user: {} }, { user: { directories: {} } }]) {
      const res = makeRes();
      await findRoute(routes, '/v1/connections/import/:importOperationId/rollback', 'POST')(req, res);
      assert.equal(res.statusCode, 401);
    }
  });
});

describe('server plugin init', () => {
  it('reconciles connection operations, generation journal, and retention in production order', async () => {
    const root = useTempDir();
    try {
      const req = makeReq(root);
      const paths = getUserPaths(req);
      await claimRequest(paths, { requestId: 'claimed', fingerprint: 'a'.repeat(64), connectionId: 'c', route: {} });
      await claimRequest(paths, { requestId: 'dispatching', fingerprint: 'b'.repeat(64), connectionId: 'c', route: {} });
      await transitionRequest(paths, 'dispatching', 'dispatching');
      await claimRequest(paths, { requestId: 'durable', fingerprint: 'c'.repeat(64), connectionId: 'c', route: {} });
      await transitionRequest(paths, 'durable', 'dispatching');
      await transitionRequest(paths, 'durable', 'result-received', {
        providerResult: { kind: 'url', value: 'https://cdn.example.test/image?signature=durable', mimeType: 'image/png' },
      });
      const calls = [];
      const services = await createDefaultServices({
        SecretManagerClass: class {},
        reconcileOperations: async () => { calls.push('operations'); },
        materializeArtifact: async ({ requestId, result }) => {
          calls.push(['materialize', requestId, result.kind]);
          return { relativePath: `artifacts/${requestId}.png`, mimeType: 'image/png', byteLength: 16, sha256: 'd'.repeat(64) };
        },
        enforceRetention: async receivedPaths => { calls.push(['retention', receivedPaths.root]); },
      });

      await services.ensureReconciled(req);

      assert.deepEqual(calls, [
        'operations', ['materialize', 'durable', 'url'], ['retention', paths.root],
      ]);
      assert.equal((await getRequest(paths, 'claimed')).state, 'not-dispatched');
      assert.equal((await getRequest(paths, 'dispatching')).state, 'failed-ambiguous');
      assert.equal((await getRequest(paths, 'durable')).state, 'ready');
    } finally {
      cleanupTempDir(root);
    }
  });

  it('verifies host compatibility without reconciling users during init', async () => {
    let compatibilityChecks = 0;
    let reconciliationCalls = 0;
    const { router, routes } = createFakeRouter();

    await init(router, {
      async verifyHostCompatibility() {
        compatibilityChecks += 1;
      },
      async ensureReconciled() {
        reconciliationCalls += 1;
      },
      async listConnections() {
        return [];
      },
    });

    assert.equal(compatibilityChecks, 1);
    assert.equal(reconciliationCalls, 0);
    assert.deepEqual(routes.map(route => route.path), [
      '/v1/status',
      '/v1/store/status', '/v1/store/:collection', '/v1/store/:collection/:id',
      '/v1/store/:collection', '/v1/store/:collection',
      '/v1/store/:collection/:id', '/v1/store/:collection/:id',
      '/v1/connections', '/v1/connections/export', '/v1/connections/import',
      '/v1/connections/import/:importOperationId/rollback', '/v1/connections/probe',
      '/v1/connections/:connectionId/probe', '/v1/connections',
      '/v1/connections/:connectionId', '/v1/connections/:connectionId',
      '/v1/generate', '/v1/requests/:requestId',
    ]);
  });
});

describe('probe receipt cache', () => {
  it('is user, endpoint, key, and TTL scoped and bounds sanitized routes', () => {
    let current = 1000;
    const cache = createReceiptCache({ now: () => current, ttlMs: 50, maxRoutes: 1 });
    const first = discoveredRoute({ remoteMetadata: { secret: 'remove' } });
    const second = discoveredRoute({ id: 'route654321', modelId: 'second' });
    const receipt = cache.issue('alice', {
      endpoint: 'https://images.example.com/v1',
      apiKey: 'raw-secret-never-store',
      routes: [first, second],
    });
    const context = {
      endpoint: 'https://images.example.com/v1', apiKey: 'raw-secret-never-store', route: first,
    };

    assert.equal(cache.peek('alice', receipt.probeId, context), true);
    assert.equal(cache.peek('bob', receipt.probeId, context), false);
    assert.equal(cache.peek('alice', receipt.probeId, { ...context, endpoint: 'https://other.example.com/v1' }), false);
    assert.equal(cache.peek('alice', receipt.probeId, { ...context, apiKey: 'wrong' }), false);
    assert.equal(cache.peek('alice', receipt.probeId, { ...context, route: second }), false);
    assert.equal(cache.consume('alice', receipt.probeId), true);
    assert.equal(cache.peek('alice', receipt.probeId, context), false);

    const expiring = cache.issue('alice', {
      endpoint: context.endpoint, apiKey: context.apiKey, routes: [first],
    });
    current = 1050;
    assert.equal(cache.peek('alice', expiring.probeId, context), false);
  });
});
