import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { registerRoutes } from '../server-plugin/src/router.js';
import { ServerImageError } from '../server-plugin/src/errors.js';
import { createFakeRouter } from './server-plugin/fake-router.js';

function makeReq(root, { body, params } = {}) {
  return {
    user: { directories: { root } },
    ...(body === undefined ? {} : { body }),
    ...(params === undefined ? {} : { params }),
  };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function route(routes, method, path) {
  const found = routes.find(r => r.method === method && r.path === path);
  assert.ok(found, `${method} ${path} should be registered`);
  return found.handlers[0];
}

function makeServices(overrides = {}) {
  return {
    ensureReconciled: async () => {},
    listConnections: async () => [],
    getStoreStatus: async () => ({
      schemaVersion: 1,
      state: 'ready',
      lastScanAt: '2026-07-29T12:00:00.000Z',
      conflictCopies: [],
      filesystem: { type: 'ntfs', degraded: false },
      migratedCollections: {},
    }),
    listStoreCollection: async () => [],
    getStoreRecord: async () => undefined,
    createStoreRecord: async (_req, _collection, payload) => ({ ...payload, updatedAt: '2026-07-29T12:00:00.000Z' }),
    replaceStoreRecord: async (_req, _collection, id, payload) => ({ ...payload, id, updatedAt: '2026-07-29T12:01:00.000Z' }),
    deleteStoreRecord: async () => true,
    replaceStoreWhole: async (_req, _collection, value) => value,
    ...overrides,
  };
}

describe('server store routes', () => {
  it('registers the seven store routes', () => {
    const { router, routes } = createFakeRouter();
    registerRoutes(router, makeServices());
    assert.deepEqual(
      routes.filter(r => r.path.startsWith('/v1/store/')).map(r => ({ method: r.method, path: r.path })),
      [
        { method: 'GET', path: '/v1/store/status' },
        { method: 'GET', path: '/v1/store/:collection' },
        { method: 'GET', path: '/v1/store/:collection/:id' },
        { method: 'POST', path: '/v1/store/:collection' },
        { method: 'PUT', path: '/v1/store/:collection' },
        { method: 'PUT', path: '/v1/store/:collection/:id' },
        { method: 'DELETE', path: '/v1/store/:collection/:id' },
      ],
    );
  });

  it('returns status without absolute filesystem paths', async () => {
    const { router, routes } = createFakeRouter();
    registerRoutes(router, makeServices({
      getStoreStatus: async () => ({
        schemaVersion: 1, state: 'ready', lastScanAt: '2026-07-29T12:00:00.000Z',
        conflictCopies: [{ collection: 'refs', file: 'refs.sync-conflict-x.json', mtime: 1 }],
        filesystem: { type: 'fuse', degraded: true }, migratedCollections: { templates: { count: 2 } },
      }),
    }));
    const res = makeRes();
    await route(routes, 'GET', '/v1/store/status')(makeReq('C:\\private\\alice'), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.filesystem.degraded, true);
    assert.equal(res.body.conflictCopies[0].file, 'refs.sync-conflict-x.json');
    assert.equal(JSON.stringify(res.body).includes('C:\\private'), false);
  });

  it('runs ensureReconciled before each store handler', async () => {
    const calls = [];
    const { router, routes } = createFakeRouter();
    registerRoutes(router, makeServices({
      ensureReconciled: async () => { calls.push('reconciled'); },
      listStoreCollection: async () => { calls.push('listed'); return []; },
    }));
    await route(routes, 'GET', '/v1/store/:collection')(makeReq('alice', { params: { collection: 'templates' } }), makeRes());
    assert.deepEqual(calls, ['reconciled', 'listed']);
  });

  it('isolates store collections by authenticated user context', async () => {
    const values = new Map([['alice', [{ id: 'a' }]], ['bob', [{ id: 'b' }]]]);
    const { router, routes } = createFakeRouter();
    registerRoutes(router, makeServices({
      listStoreCollection: async req => values.get(req.user.directories.root),
    }));
    const alice = makeRes();
    const bob = makeRes();
    const handler = route(routes, 'GET', '/v1/store/:collection');
    await handler(makeReq('alice', { params: { collection: 'templates' } }), alice);
    await handler(makeReq('bob', { params: { collection: 'templates' } }), bob);
    assert.deepEqual(alice.body, { templates: [{ id: 'a' }] });
    assert.deepEqual(bob.body, { templates: [{ id: 'b' }] });
  });

  it('performs collection CRUD and migration replacement through service methods', async () => {
    const calls = [];
    const { router, routes } = createFakeRouter();
    registerRoutes(router, makeServices({
      createStoreRecord: async (_req, name, payload) => { calls.push(['create', name, payload]); return { ...payload, updatedAt: 'now' }; },
      replaceStoreRecord: async (_req, name, id, payload) => { calls.push(['replace', name, id, payload]); return { ...payload, id, updatedAt: 'now' }; },
      deleteStoreRecord: async (_req, name, id) => { calls.push(['delete', name, id]); return true; },
      replaceStoreWhole: async (_req, name, value) => { calls.push(['whole', name, value]); return value; },
    }));

    const createRes = makeRes();
    await route(routes, 'POST', '/v1/store/:collection')(makeReq('alice', { params: { collection: 'templates' }, body: { id: 't1', name: 'T' } }), createRes);
    assert.equal(createRes.statusCode, 201);
    assert.deepEqual(createRes.body.record, { id: 't1', name: 'T', updatedAt: 'now' });

    const updateRes = makeRes();
    await route(routes, 'PUT', '/v1/store/:collection/:id')(makeReq('alice', { params: { collection: 'templates', id: 't1' }, body: { name: 'U' } }), updateRes);
    assert.equal(updateRes.statusCode, 200);
    assert.deepEqual(updateRes.body.record, { id: 't1', name: 'U', updatedAt: 'now' });

    const wholeRes = makeRes();
    await route(routes, 'PUT', '/v1/store/:collection')(makeReq('alice', { params: { collection: 'templates' }, body: { value: [{ id: 'legacy' }] } }), wholeRes);
    assert.deepEqual(wholeRes.body, { templates: [{ id: 'legacy' }] });

    const deleteRes = makeRes();
    await route(routes, 'DELETE', '/v1/store/:collection/:id')(makeReq('alice', { params: { collection: 'templates', id: 't1' } }), deleteRes);
    assert.deepEqual(deleteRes.body, { deleted: true, id: 't1' });
    assert.deepEqual(calls.map(c => c[0]), ['create', 'replace', 'whole', 'delete']);
  });

  it('returns 404 for a missing record', async () => {
    const { router, routes } = createFakeRouter();
    registerRoutes(router, makeServices({ getStoreRecord: async () => undefined }));
    const res = makeRes();
    await route(routes, 'GET', '/v1/store/:collection/:id')(makeReq('alice', { params: { collection: 'templates', id: 'missing' } }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error.code, 'COLLECTION_RECORD_NOT_FOUND');
  });

  it('returns a safe COLLECTION_UNKNOWN envelope for an invalid collection', async () => {
    const { router, routes } = createFakeRouter();
    registerRoutes(router, makeServices({
      listStoreCollection: async () => { throw new ServerImageError({ code: 'COLLECTION_UNKNOWN', message: 'Unknown collection' }); },
    }));
    const res = makeRes();
    await route(routes, 'GET', '/v1/store/:collection')(makeReq('alice', { params: { collection: '../secrets' } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'COLLECTION_UNKNOWN');
    assert.equal(JSON.stringify(res.body).includes('secrets.json'), false);
  });
});
