import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerRoutes } from '../server-plugin/src/router.js';
import { ServerImageError } from '../server-plugin/src/errors.js';
import { createGenerationService } from '../server-plugin/src/services/generation.js';
import { createRequestStatusService } from '../server-plugin/src/services/request-status.js';
import { createFakeRouter } from './server-plugin/fake-router.js';
import { cleanupTempDir, useTempDir } from './server-plugin/temp-store.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const ROUTE = {
  id: 'route-1',
  apiFamily: 'test-family',
  modelId: 'image-1',
  source: 'catalog',
  capabilities: { generate: 'supported', references: 'supported', maxReferences: 2 },
};

let roots;
beforeEach(() => { roots = []; });
afterEach(() => { for (const root of roots) cleanupTempDir(root); });

function makeReq(root = useTempDir()) {
  if (!roots.includes(root)) roots.push(root);
  return { user: { directories: { root } } };
}

function generationBody(overrides = {}) {
  return {
    requestId: 'request-1',
    connectionId: 'conn-1',
    prompt: 'a lighthouse',
    references: [],
    ...overrides,
  };
}

function connection() {
  return {
    id: 'conn-1',
    endpoint: 'https://api.example.test',
    secretId: 'secret-1',
    timeoutMs: 1000,
    selectedRoute: ROUTE,
  };
}

function makeRes({ failJson = false } = {}) {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) {
      if (failJson) throw new Error('socket closed');
      this.body = value;
      return this;
    },
  };
}

function handler(routes, method, path) {
  const route = routes.find(candidate => candidate.method === method && candidate.path === path);
  assert.ok(route, `${method} ${path} should be registered`);
  return route.handlers[0];
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function routeServices({ adapter } = {}) {
  const generation = createGenerationService({
    getConnection: async () => connection(),
    readSecret: async () => 'raw-secret',
    adapters: [adapter ?? {
      apiFamily: 'test-family',
      async generate(context) {
        await context.beforeDispatch();
        return { kind: 'bytes', value: PNG, mimeType: 'image/png' };
      },
    }],
  });
  const status = createRequestStatusService();
  return {
    ensureReconciled: async () => {},
    executeGeneration: generation.executeGeneration,
    getRequestStatus: status.getRequestStatus,
  };
}

describe('generation request routes', () => {
  it('registers both routes and delegates the original user request contract after reconciliation', async () => {
    const calls = [];
    const generated = { requestId: 'request-1', state: 'claimed', diagnosticsId: null };
    const existing = { requestId: 'request-1', state: 'failed', diagnosticsId: 'diag-status' };
    const services = {
      async ensureReconciled(req) { calls.push(['reconcile', req]); },
      async executeGeneration(req, body) { calls.push(['execute', req, body]); return generated; },
      async getRequestStatus(req, id) { calls.push(['status', req, id]); return existing; },
    };
    const { router, routes } = createFakeRouter();
    registerRoutes(router, services);

    assert.deepEqual(routes.slice(-2).map(({ method, path }) => ({ method, path })), [
      { method: 'POST', path: '/v1/generate' },
      { method: 'GET', path: '/v1/requests/:requestId' },
    ]);

    const postReq = { ...makeReq(), body: generationBody() };
    const postRes = makeRes();
    await handler(routes, 'POST', '/v1/generate')(postReq, postRes);
    assert.equal(postRes.statusCode, 200);
    assert.deepEqual(postRes.body, generated);
    assert.deepEqual(calls.slice(0, 2), [['reconcile', postReq], ['execute', postReq, postReq.body]]);

    const getReq = { ...postReq, params: { requestId: 'request-1' } };
    const getRes = makeRes();
    await handler(routes, 'GET', '/v1/requests/:requestId')(getReq, getRes);
    assert.equal(getRes.statusCode, 200);
    assert.deepEqual(getRes.body, existing);
    assert.deepEqual(calls.slice(2), [['status', getReq, 'request-1']]);
  });

  it('enforces the user reconciliation barrier on POST and GET before invoking request services', async () => {
    const calls = [];
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      async ensureReconciled() { calls.push('reconcile'); },
      async executeGeneration() { calls.push('execute'); },
      async getRequestStatus() { calls.push('status'); },
    });

    for (const [method, path, req] of [
      ['POST', '/v1/generate', { body: generationBody() }],
      ['GET', '/v1/requests/:requestId', { params: { requestId: 'request-1' } }],
    ]) {
      const res = makeRes();
      await handler(routes, method, path)(req, res);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.body.error, {
        code: 'SERVER_USER_CONTEXT_MISSING',
        message: 'Authenticated user context is required',
        retryable: false,
        diagnosticsId: res.body.error.diagnosticsId,
      });
    }
    assert.deepEqual(calls, []);
  });

  it('single-flights concurrent duplicate POSTs and returns an existing ready artifact without paying twice', async () => {
    const release = deferred();
    let paidCalls = 0;
    const services = routeServices({
      adapter: {
        apiFamily: 'test-family',
        async generate(context) {
          paidCalls += 1;
          await context.beforeDispatch();
          await release.promise;
          return { kind: 'bytes', value: PNG, mimeType: 'image/png' };
        },
      },
    });
    const { router, routes } = createFakeRouter();
    registerRoutes(router, services);
    const root = useTempDir();
    const post = handler(routes, 'POST', '/v1/generate');
    const firstRes = makeRes();
    const secondRes = makeRes();
    const first = post({ ...makeReq(root), body: generationBody() }, firstRes);
    const second = post({ ...makeReq(root), body: generationBody() }, secondRes);

    await waitUntil(() => paidCalls === 1, 'adapter should receive exactly one paid call');
    assert.equal(paidCalls, 1);
    release.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(firstRes.body, secondRes.body);
    assert.equal(firstRes.body.state, 'ready');
    assert.equal(firstRes.body.result.value, `data:image/png;base64,${PNG.toString('base64')}`);

    const existingRes = makeRes();
    await post({ ...makeReq(root), body: generationBody() }, existingRes);
    assert.deepEqual(existingRes.body, firstRes.body);
    assert.equal(paidCalls, 1);

    const getRes = makeRes();
    await handler(routes, 'GET', '/v1/requests/:requestId')({
      ...makeReq(root), params: { requestId: 'request-1' },
    }, getRes);
    assert.deepEqual(getRes.body, firstRes.body);
  });

  it('returns exact safe conflict, missing-request, and domain-error envelopes', async () => {
    const root = useTempDir();
    const services = routeServices();
    const { router, routes } = createFakeRouter();
    registerRoutes(router, services);
    const post = handler(routes, 'POST', '/v1/generate');
    await post({ ...makeReq(root), body: generationBody() }, makeRes());

    const conflict = makeRes();
    await post({ ...makeReq(root), body: generationBody({ prompt: 'different immutable request' }) }, conflict);
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.body.error.code, 'REQUEST_ID_CONFLICT');
    assert.deepEqual(Object.keys(conflict.body.error).sort(), ['code', 'diagnosticsId', 'message', 'retryable']);
    assert.equal(JSON.stringify(conflict.body).includes('different immutable request'), false);

    const missing = makeRes();
    await handler(routes, 'GET', '/v1/requests/:requestId')({
      ...makeReq(root), params: { requestId: 'missing-request' },
    }, missing);
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(missing.body.error, {
      code: 'REQUEST_NOT_FOUND',
      message: 'Generation request was not found',
      retryable: false,
      diagnosticsId: missing.body.error.diagnosticsId,
    });

    const safe = makeRes();
    const isolated = createFakeRouter();
    registerRoutes(isolated.router, {
      ensureReconciled: async () => {},
      async executeGeneration() {
        throw new ServerImageError({
          code: 'UPSTREAM_TIMEOUT', message: 'Image provider timed out', retryable: true, diagnosticsId: 'diag-timeout',
        });
      },
      getRequestStatus: async () => null,
    });
    await handler(isolated.routes, 'POST', '/v1/generate')({ ...makeReq(), body: generationBody() }, safe);
    assert.equal(safe.statusCode, 503);
    assert.deepEqual(safe.body, {
      error: { code: 'UPSTREAM_TIMEOUT', message: 'Image provider timed out', retryable: true, diagnosticsId: 'diag-timeout' },
    });
  });

  it('recovers ready state through GET after the POST response socket fails without resubmitting', async () => {
    let paidCalls = 0;
    const services = routeServices({
      adapter: {
        apiFamily: 'test-family',
        async generate(context) {
          paidCalls += 1;
          await context.beforeDispatch();
          return { kind: 'bytes', value: PNG, mimeType: 'image/png' };
        },
      },
    });
    const { router, routes } = createFakeRouter();
    registerRoutes(router, services);
    const root = useTempDir();

    await assert.rejects(
      () => handler(routes, 'POST', '/v1/generate')({ ...makeReq(root), body: generationBody() }, makeRes({ failJson: true })),
      /socket closed/,
    );
    const recovered = makeRes();
    await handler(routes, 'GET', '/v1/requests/:requestId')({
      ...makeReq(root), params: { requestId: 'request-1' },
    }, recovered);
    assert.equal(recovered.body.state, 'ready');
    assert.match(recovered.body.result.value, /^data:image\/png;base64,/);

    await handler(routes, 'POST', '/v1/generate')({ ...makeReq(root), body: generationBody() }, makeRes());
    assert.equal(paidCalls, 1);
  });

  it('never resubmits an ambiguous dispatch on repeated POST or status GET', async () => {
    let paidCalls = 0;
    const services = routeServices({
      adapter: {
        apiFamily: 'test-family',
        async generate(context) {
          paidCalls += 1;
          await context.beforeDispatch();
          throw new Error('connection reset after request bytes');
        },
      },
    });
    const { router, routes } = createFakeRouter();
    registerRoutes(router, services);
    const root = useTempDir();
    const post = handler(routes, 'POST', '/v1/generate');

    const failed = makeRes();
    await post({ ...makeReq(root), body: generationBody() }, failed);
    assert.equal(failed.body.error.code, 'GENERATION_FAILED_AMBIGUOUS');
    assert.deepEqual(Object.keys(failed.body.error).sort(), ['code', 'diagnosticsId', 'message', 'retryable']);

    const repeated = makeRes();
    await post({ ...makeReq(root), body: generationBody() }, repeated);
    assert.deepEqual(repeated.body, { requestId: 'request-1', state: 'failed-ambiguous', diagnosticsId: null });

    const status = makeRes();
    await handler(routes, 'GET', '/v1/requests/:requestId')({
      ...makeReq(root), params: { requestId: 'request-1' },
    }, status);
    assert.deepEqual(status.body, repeated.body);
    assert.equal(paidCalls, 1);
  });
});
