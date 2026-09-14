import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ServerImageApiError,
  createServerConnection,
  deleteServerConnection,
  generateServerImage,
  getServerRequest,
  listServerConnections,
  probeStoredConnection,
  probeTransientConnection,
  getServerImageApiStatus,
  updateServerConnection,
} from '../src/server-image-api.js';
import {
  CONNECTION_FIXTURE,
  GENERATION_FIXTURE,
  PROBE_FIXTURE,
  REQUEST_STATUS_FIXTURE,
  STATUS_FIXTURE,
  jsonResponse,
} from './server-api-fixtures.js';

const BASE = '/api/plugins/ur-image-studio/v1';
let originalFetch;
let originalSt;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalSt = globalThis.SillyTavern;
  globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({ Authorization: 'Bearer auth', 'X-CSRF-Token': 'csrf' }) }) };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.SillyTavern = originalSt;
});

function captureFetch(response = jsonResponse({})) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  return calls;
}

describe('server image API client', () => {
  it('gets status with same-origin URL and preserves request headers', async () => {
    const calls = captureFetch(jsonResponse(STATUS_FIXTURE));
    assert.deepEqual(await getServerImageApiStatus(), STATUS_FIXTURE);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/status`);
    assert.deepEqual(calls[0].options.headers, {
      Authorization: 'Bearer auth', 'X-CSRF-Token': 'csrf',
    });
    assert.equal(calls[0].options.method, 'GET');
  });

  it('validates status API version and required features', async () => {
    captureFetch(jsonResponse({ ...STATUS_FIXTURE, apiVersion: 2 }));
    await assert.rejects(getServerImageApiStatus(), error => error instanceof ServerImageApiError && error.code === 'SERVER_COMPONENT_INCOMPATIBLE');
    captureFetch(jsonResponse({ ...STATUS_FIXTURE, features: { ...STATUS_FIXTURE.features, generation: false } }));
    await assert.rejects(getServerImageApiStatus(), error => error.code === 'SERVER_COMPONENT_INCOMPATIBLE');
  });

  it('lists, probes, creates, updates, and deletes with exact routes and envelopes', async () => {
    const signal = new AbortController().signal;
    const calls = captureFetch(jsonResponse({ connections: [CONNECTION_FIXTURE] }));
    assert.deepEqual(await listServerConnections({ signal }), { connections: [CONNECTION_FIXTURE] });
    assert.equal(calls[0].url, `${BASE}/connections`);
    assert.equal(calls[0].options.signal, signal);

    const responses = [
      jsonResponse(PROBE_FIXTURE),
      jsonResponse({ probeId: 'probe-1', routes: [] }),
      jsonResponse({ connection: CONNECTION_FIXTURE }, 201),
      jsonResponse({ connection: CONNECTION_FIXTURE }),
      jsonResponse({ deleted: true, connectionId: 'id/a' }),
    ];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    };
    await probeTransientConnection({ endpoint: 'https://example.test', apiKey: 'secret', apiFamilyOverride: 'auto' });
    await probeStoredConnection('id/a');
    await createServerConnection({ id: 'id/a', apiKey: 'secret' });
    await updateServerConnection('id/a', { name: 'Updated' });
    assert.deepEqual(await deleteServerConnection('id/a'), { deleted: true, connectionId: 'id/a' });

    assert.deepEqual(calls.slice(1).map(call => [call.url, call.options.method]), [
      [`${BASE}/connections/probe`, 'POST'],
      [`${BASE}/connections/id%2Fa/probe`, 'POST'],
      [`${BASE}/connections`, 'POST'],
      [`${BASE}/connections/id%2Fa`, 'PUT'],
      [`${BASE}/connections/id%2Fa`, 'DELETE'],
    ]);
    assert.deepEqual(JSON.parse(calls[1].options.body), { endpoint: 'https://example.test', apiKey: 'secret', apiFamilyOverride: 'auto' });
    assert.deepEqual(JSON.parse(calls[3].options.body), { id: 'id/a', apiKey: 'secret' });
    assert.equal(calls[4].options.headers['Content-Type'], 'application/json');
  });

  it('passes abort signals and generation performs exactly one fetch attempt', async () => {
    const calls = captureFetch(jsonResponse(GENERATION_FIXTURE));
    const signal = new AbortController().signal;
    assert.deepEqual(await generateServerImage({ requestId: 'request-1' }, { signal }), GENERATION_FIXTURE);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/generate`);
    assert.equal(calls[0].options.signal, signal);
    assert.deepEqual(JSON.parse(calls[0].options.body), { requestId: 'request-1' });
  });

  it('gets request status with encoded request ID', async () => {
    const calls = captureFetch(jsonResponse(REQUEST_STATUS_FIXTURE));
    assert.deepEqual(await getServerRequest('request/a'), REQUEST_STATUS_FIXTURE);
    assert.equal(calls[0].url, `${BASE}/requests/request%2Fa`);
  });

  it('normalizes structured and malformed HTTP failures into safe errors', async () => {
    captureFetch(jsonResponse({ error: { code: 'AUTH_FAILED', message: 'Nope', retryable: true, diagnosticsId: 'diag' } }, 401));
    await assert.rejects(getServerImageApiStatus(), error => {
      assert.equal(error.name, 'ServerImageApiError');
      assert.deepEqual({ code: error.code, message: error.message, retryable: error.retryable, diagnosticsId: error.diagnosticsId, httpStatus: error.httpStatus }, {
        code: 'AUTH_FAILED', message: 'Nope', retryable: true, diagnosticsId: 'diag', httpStatus: 401,
      });
      return true;
    });
    captureFetch({ ok: false, status: 502, async json() { throw new Error('bad json'); } });
    await assert.rejects(listServerConnections(), error => error.code === 'HTTP_ERROR' && error.message === 'Server image API request failed' && error.httpStatus === 502);
  });

  it('does not reference forbidden retry or proxy helpers', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/server-image-api.js', import.meta.url), 'utf8'));
    for (const forbidden of ['autoFetch', 'probeCorsProxy', 'callWithRetry']) assert.equal(source.includes(forbidden), false, forbidden);
  });
});
