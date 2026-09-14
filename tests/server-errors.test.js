import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../server-plugin/index.js';
import { ServerImageError, toErrorEnvelope } from '../server-plugin/src/errors.js';
import { createFakeRouter } from './server-plugin/fake-router.js';

describe('server-plugin router registration', () => {
  it('registers GET /v1/status', () => {
    const { router, routes } = createFakeRouter();
    init(router);

    const statusRoute = routes.find(r => r.method === 'GET' && r.path === '/v1/status');
    assert.ok(statusRoute, 'GET /v1/status should be registered');
    assert.ok(statusRoute.handlers.length > 0, 'should have at least one handler');
  });

  it('GET /v1/status handler returns expected payload', async () => {
    const { router, routes } = createFakeRouter();
    await init(router, {
      async verifyHostCompatibility() {},
      async ensureReconciled() {},
      async listConnections() { return []; },
    });

    const statusRoute = routes.find(r => r.method === 'GET' && r.path === '/v1/status');
    const handler = statusRoute.handlers[0];

    // Simulate req/res objects
    const res = {
      _status: null,
      _body: null,
      status(code) { this._status = code; return this; },
      json(body) { this._body = body; },
    };

    await handler({ user: { directories: { root: '/users/alice' } } }, res);

    assert.equal(res._status, 200);
    assert.deepEqual(res._body, {
      ok: true,
      apiVersion: 1,
      features: {
        connections: true,
        discovery: true,
        generation: true,
        requestRecovery: true,
      },
      apiFamilies: ['openai-images', 'gemini-native', 'openrouter-images'],
    });
  });
});

describe('ServerImageError', () => {
  it('stores code, message, retryable, and diagnosticsId', () => {
    const err = new ServerImageError({
      code: 'TEST_ERROR',
      message: 'test message',
      retryable: true,
      diagnosticsId: 'abc-123',
    });

    assert.equal(err.code, 'TEST_ERROR');
    assert.equal(err.message, 'test message');
    assert.equal(err.retryable, true);
    assert.equal(err.diagnosticsId, 'abc-123');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof ServerImageError);
  });
});

describe('toErrorEnvelope', () => {
  it('returns only code, message, retryable, diagnosticsId for ServerImageError', () => {
    const err = new ServerImageError({
      code: 'E_CONN',
      message: 'connection failed',
      retryable: true,
    });

    const envelope = toErrorEnvelope(err);
    const keys = Object.keys(envelope).sort();
    assert.deepEqual(keys, ['code', 'diagnosticsId', 'message', 'retryable']);
    assert.equal(envelope.code, 'E_CONN');
    assert.equal(envelope.message, 'connection failed');
    assert.equal(envelope.retryable, true);
    assert.ok(typeof envelope.diagnosticsId === 'string');
    assert.match(envelope.diagnosticsId, /^[0-9a-f-]{36}$/);
  });

  it('uses existing diagnosticsId when present', () => {
    const err = new ServerImageError({
      code: 'E_EXISTING',
      message: 'has id',
      retryable: false,
      diagnosticsId: 'my-custom-id',
    });

    const envelope = toErrorEnvelope(err);
    assert.equal(envelope.diagnosticsId, 'my-custom-id');
  });

  it('translates plain errors to a fixed safe internal envelope', () => {
    const secrets = [
      'database failed for sk-live-secret at C:\\Users\\alice\\secrets.json',
      '/home/alice/private/config.json contains provider-token-123',
    ];

    for (const secret of secrets) {
      const envelope = toErrorEnvelope(new Error(secret));
      const keys = Object.keys(envelope).sort();
      assert.deepEqual(keys, ['code', 'diagnosticsId', 'message', 'retryable']);
      assert.equal(envelope.code, 'INTERNAL_ERROR');
      assert.equal(envelope.message, 'An internal server error occurred');
      assert.equal(envelope.retryable, false);
      assert.ok(typeof envelope.diagnosticsId === 'string');
      assert.equal(JSON.stringify(envelope).includes(secret), false);
    }
  });

  it('does not trust code, message, or diagnostics fields on unknown objects', () => {
    const envelope = toErrorEnvelope({
      code: 'ENOENT',
      message: { path: '/private/user-root', token: 'secret-token' },
      diagnosticsId: 'attacker-controlled',
      retryable: true,
    });

    assert.equal(envelope.code, 'INTERNAL_ERROR');
    assert.equal(envelope.message, 'An internal server error occurred');
    assert.equal(envelope.retryable, false);
    assert.notEqual(envelope.diagnosticsId, 'attacker-controlled');
    assert.equal(JSON.stringify(envelope).includes('/private/user-root'), false);
  });
});
