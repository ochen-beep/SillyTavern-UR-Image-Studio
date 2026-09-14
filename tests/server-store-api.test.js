import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  ServerStoreApiError,
  createRecord,
  deleteRecord,
  getRecord,
  getStoreStatus,
  listCharGallery,
  listCollection,
  replaceWhole,
  updateRecord,
} from '../src/server-store-api.js';
import { jsonResponse } from './server-api-fixtures.js';

const BASE = '/api/plugins/ur-image-studio/v1';
let originalFetch;
let originalSt;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalSt = globalThis.SillyTavern;
  globalThis.SillyTavern = {
    getContext: () => ({
      getRequestHeaders: () => ({ Authorization: 'Bearer auth', 'X-CSRF-Token': 'csrf' }),
    }),
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.SillyTavern = originalSt;
});

function captureFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return queue.shift() ?? jsonResponse({});
  };
  return calls;
}

describe('server store API client', () => {
  it('gets status through the common plugin base URL and preserves ST headers', async () => {
    const fixture = { schemaVersion: 1, state: 'ready', filesystem: { type: 'ntfs', degraded: false } };
    const calls = captureFetch(jsonResponse(fixture));

    assert.deepEqual(await getStoreStatus(), fixture);
    assert.equal(calls[0].url, `${BASE}/store/status`);
    assert.equal(calls[0].options.method, 'GET');
    assert.deepEqual(calls[0].options.headers, { Authorization: 'Bearer auth', 'X-CSRF-Token': 'csrf' });
  });

  it('gets lists and records using exact encoded store URLs', async () => {
    const calls = captureFetch([
      jsonResponse({ templates: [{ id: 't1' }] }),
      jsonResponse({ record: { id: 'a/b' } }),
    ]);

    assert.deepEqual(await listCollection('templates'), [{ id: 't1' }]);
    assert.deepEqual(await getRecord('templates', 'a/b'), { id: 'a/b' });
    assert.equal(calls[0].url, `${BASE}/store/templates`);
    assert.equal(calls[1].url, `${BASE}/store/templates/a%2Fb`);
  });

  it('creates, updates, replaces whole collections, and deletes through the matching verbs', async () => {
    const calls = captureFetch([
      jsonResponse({ record: { id: 't1', name: 'new' } }, 201),
      jsonResponse({ record: { id: 't1', name: 'changed' } }),
      jsonResponse({ templates: [{ id: 'legacy' }] }),
      jsonResponse({ deleted: true, id: 't1' }),
    ]);

    assert.deepEqual(await createRecord('templates', { id: 't1', name: 'new' }), { id: 't1', name: 'new' });
    assert.deepEqual(await updateRecord('templates', 't1', { name: 'changed' }), { id: 't1', name: 'changed' });
    assert.deepEqual(await replaceWhole('templates', [{ id: 'legacy' }]), [{ id: 'legacy' }]);
    assert.deepEqual(await deleteRecord('templates', 't1'), { deleted: true, id: 't1' });

    assert.deepEqual(calls.map(call => [call.url, call.options.method]), [
      [`${BASE}/store/templates`, 'POST'],
      [`${BASE}/store/templates/t1`, 'PUT'],
      [`${BASE}/store/templates`, 'PUT'],
      [`${BASE}/store/templates/t1`, 'DELETE'],
    ]);
    assert.deepEqual(JSON.parse(calls[0].options.body), { id: 't1', name: 'new' });
    assert.deepEqual(JSON.parse(calls[1].options.body), { name: 'changed' });
    assert.deepEqual(JSON.parse(calls[2].options.body), { value: [{ id: 'legacy' }] });
    assert.equal(calls[3].options.headers['Content-Type'], undefined);
  });

  it('maps store error envelopes into a typed safe error', async () => {
    captureFetch(jsonResponse({ error: {
      code: 'COLLECTION_UNKNOWN', message: 'Unknown collection', retryable: false, diagnosticsId: 'diag-1',
    } }, 400));

    await assert.rejects(listCollection('../escape'), error => {
      assert.ok(error instanceof ServerStoreApiError);
      assert.deepEqual({ code: error.code, message: error.message, retryable: error.retryable, diagnosticsId: error.diagnosticsId, httpStatus: error.httpStatus }, {
        code: 'COLLECTION_UNKNOWN', message: 'Unknown collection', retryable: false, diagnosticsId: 'diag-1', httpStatus: 400,
      });
      return true;
    });
  });

  it('reports SERVER_COMPONENT_UNAVAILABLE when status cannot fetch', async () => {
    globalThis.fetch = async () => { throw new TypeError('offline'); };
    await assert.rejects(getStoreStatus(), error => error instanceof ServerStoreApiError
      && error.code === 'SERVER_COMPONENT_UNAVAILABLE' && error.retryable === true);
  });

  it('lists a character gallery from ST basenames, filters uris_, and builds user-image paths', async () => {
    const calls = captureFetch(jsonResponse([
      'uris_2026.png', 'not-ours.jpg', 'uris_again.webp', '../escape.png',
    ]));

    const images = await listCharGallery('My Character');

    assert.deepEqual(images, [
      { filename: 'uris_2026.png', path: 'user/images/My%20Character/uris_2026.png' },
      { filename: 'uris_again.webp', path: 'user/images/My%20Character/uris_again.webp' },
    ]);
    assert.equal(calls[0].url, '/api/images/list');
    assert.equal(calls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].options.body), { folder: 'My Character' });
  });

  it('does not reference localforage or generic retry/proxy helpers', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/server-store-api.js', import.meta.url), 'utf8'));
    for (const forbidden of ['localforage', 'autoFetch', 'probeCorsProxy', 'callWithRetry']) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  });
});
