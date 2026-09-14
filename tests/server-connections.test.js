import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { uid } from '../src/core.js';
import { deriveStableRouteId } from '../src/image-connection-schema.js';
import {
  isValidConnectionId,
  isValidRouteId,
  validateApiFamily,
  validateCreateConnectionInput,
  validateManualRoute,
  sanitizePersistedRoute,
  sanitizeRoute,
  toConnectionDto,
} from '../server-plugin/src/validation.js';
import {
  listConnections,
  getConnection,
  createConnection,
  replaceConnection,
  tombstoneConnection,
} from '../server-plugin/src/storage/connections-store.js';
import { readJson, writeJson } from '../server-plugin/src/storage/atomic-json.js';
import { reconcileOperations } from '../server-plugin/src/storage/operations-store.js';
import { createConnectionService } from '../server-plugin/src/services/connections.js';
import { openAIImagesAdapter } from '../server-plugin/src/adapters/openai-images.js';
import { openRouterImagesAdapter } from '../server-plugin/src/adapters/openrouter-images.js';
import { createProbeService } from '../server-plugin/src/services/probe.js';
import { openAIModelsFixture } from './server-plugin/fixtures-openai.js';
import { openRouterImageModelsFixture } from './server-plugin/fixtures-openrouter.js';

import { geminiNativeAdapter } from '../server-plugin/src/adapters/gemini-native.js';
import { createFakeSafeFetch } from './server-plugin/fake-safe-fetch.js';
import { geminiModelsFixture } from './server-plugin/fixtures-gemini.js';
import { useTempDir, cleanupTempDir } from './server-plugin/temp-store.js';

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

function makePaths() {
  const root = useTempDir();
  tempDirs.push(root);
  return {
    root,
    connections: join(root, 'connections.json'),
    operations: join(root, 'operations.json'),
    journalKey: root,
  };
}

function makeLifecycle(overrides = {}) {
  const calls = [];
  const connections = new Map();
  const markers = new Map();
  let secretIndex = 0;
  const deps = {
    paths: makePaths(),
    validateConnection(record) {
      calls.push(['validate', record.id]);
      return record;
    },
    createOperationId: () => `operation${String(markers.size).padStart(6, '0')}`,
    now: () => '2026-07-27T12:00:00.000Z',
    operationStore: {
      async beginOperation(marker) {
        calls.push(['begin', marker.type, marker.phase]);
        markers.set(marker.id, { ...marker });
      },
      async advanceOperation(id, patch) {
        calls.push(['advance', patch.phase, patch.newSecretId ?? null]);
        markers.set(id, { ...markers.get(id), ...patch });
      },
      async finishOperation(id) {
        calls.push(['finish', id]);
        markers.delete(id);
      },
    },
    secretStore: {
      async writeSecret(value) {
        calls.push(['write-secret', value]);
        secretIndex += 1;
        return { id: `secret-${secretIndex}`, present: true };
      },
      async deleteSecret(id) {
        calls.push(['delete-secret', id]);
        return { id, present: false };
      },
    },
    connectionStore: {
      async createConnection(record) {
        calls.push(['create-metadata', record.id, record.secretId]);
        connections.set(record.id, { ...record });
        return record;
      },
      async getConnection(id) {
        calls.push(['get-metadata', id]);
        return connections.get(id) ?? null;
      },
      async replaceConnection(id, record) {
        calls.push(['replace-metadata', id, record.secretId]);
        connections.set(id, { ...record, id });
        return connections.get(id);
      },
      async tombstoneConnection(id) {
        calls.push(['tombstone-metadata', id]);
        const tombstone = { ...connections.get(id), tombstone: true };
        connections.set(id, tombstone);
        return tombstone;
      },
    },
    requestStore: {
      async deleteByConnection(id) { calls.push(['delete-requests', id]); },
    },
    artifactStore: {
      async deleteByConnection(id) { calls.push(['delete-artifacts', id]); },
    },
    ...overrides,
  };
  return { calls, connections, markers, deps, service: createConnectionService(deps) };
}

function makeRoute(overrides = {}) {
  return {
    id: 'route123456',
    modelId: 'image-model',
    label: 'Image Model',
    apiFamily: 'openai-images',
    source: 'manual',
    confidence: 'manual',
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

function makeRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'connection123456',
    name: 'Primary',
    endpoint: 'https://images.example.com/v1',
    modelRoute: makeRoute(),
    apiFamilyOverride: 'openai-images',
    secretId: 'secret-opaque',
    timeoutMs: 300000,
    createdAt: '2026-07-27T10:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
    ...overrides,
  };
}

describe('connection schema', () => {
  it('accepts current uid fixtures and rejects unsafe or malformed IDs', () => {
    for (let index = 0; index < 20; index += 1) {
      assert.equal(isValidConnectionId(uid()), true);
    }

    assert.equal(isValidRouteId('route_0123456789abcdef'), true);
    assert.equal(isValidRouteId('route-0123456789abcdef'), true);
    assert.equal(isValidRouteId('route/unsafe'), false);
    assert.equal(isValidRouteId(''), false);

    for (const invalid of [
      '', 'abcdef', 'ABCDEF1', 'abc-def1', 'abc/def123456',
      'abc\\def123456', 'abc\0def123456', 'abc\ndef123456', '../abcdef1',
    ]) {
      assert.equal(isValidConnectionId(invalid), false, `expected invalid ID: ${JSON.stringify(invalid)}`);
    }
  });

  it('accepts only supported API family values', () => {
    for (const family of ['auto', 'openai-images', 'gemini-native', 'openrouter-images']) {
      assert.equal(validateApiFamily(family), family);
    }
    for (const family of ['', 'openai', 'gemini', null]) {
      assert.throws(() => validateApiFamily(family), /API family/);
    }
  });

  it('accepts receipt-backed discovered stable route IDs and auto family, persisting concrete family', () => {
    const route = makeRoute({
      id: 'route_0123456789abcdef',
      source: 'openai-models',
    });
    const input = validateCreateConnectionInput({
      id: 'connection123456', name: 'Primary', endpoint: 'https://images.example.com/v1',
      apiFamilyOverride: 'auto', modelRoute: route, timeoutMs: 300000,
    }, () => '2026-07-27T12:00:00.000Z');
    assert.equal(input.apiFamilyOverride, 'auto');
    assert.equal(input.selectedRoute.apiFamily, 'openai-images');
    assert.equal(input.modelRouteId, route.id);
  });

  it('keeps manual routes on the connection UID contract and rejects auto family', () => {
    const route = makeRoute({ id: 'route_0123456789abcdef' });
    assert.throws(() => validateCreateConnectionInput({
      id: 'connection123456', name: 'Primary', endpoint: 'https://images.example.com/v1',
      apiFamilyOverride: 'openai-images', modelRoute: route, timeoutMs: 300000,
    }, () => '2026-07-27T12:00:00.000Z'), /project UID/);
    assert.throws(() => validateCreateConnectionInput({
      id: 'connection123456', name: 'Primary', endpoint: 'https://images.example.com/v1',
      apiFamilyOverride: 'auto', modelRoute: { ...makeRoute(), source: 'manual' }, timeoutMs: 300000,
    }, () => '2026-07-27T12:00:00.000Z'), /explicit/);
  });
  it('accepts canonical manual IDs while retaining legacy project UID IDs', () => {
    const canonicalRoute = makeRoute({
      id: deriveStableRouteId('manual', 'image-model', 'openai-images'),
    });
    assert.deepEqual(validateManualRoute(canonicalRoute, 'openai-images'), sanitizeRoute(canonicalRoute));
    assert.deepEqual(validateManualRoute(makeRoute(), 'openai-images'), sanitizeRoute(makeRoute()));
  });
  it('requires a matching explicit family and conservative manual capabilities', () => {
    const route = makeRoute();
    assert.deepEqual(validateManualRoute(route, 'openai-images'), sanitizeRoute(route));

    assert.throws(() => validateManualRoute(route, 'auto'), /explicit/);
    assert.throws(() => validateManualRoute(route, 'gemini-native'), /match/);
    assert.throws(() => validateManualRoute({ ...route, source: 'remote' }, 'openai-images'), /manual/);
    assert.throws(() => validateManualRoute({ ...route, modelId: '  ' }, 'openai-images'), /modelId/);
    assert.throws(() => validateManualRoute({
      ...route,
      capabilities: { ...route.capabilities, references: 'supported' },
    }, 'openai-images'), /conservative/);
    assert.throws(() => validateManualRoute({
      ...route,
      capabilities: { ...route.capabilities, maxReferences: 2 },
    }, 'openai-images'), /conservative/);
    assert.throws(() => validateManualRoute({
      ...route,
      capabilities: { ...route.capabilities, aspectRatios: ['1:1'] },
    }, 'openai-images'), /conservative/);
  });
});

describe('safe projection', () => {
  it('returns the exact DTO with sanitized route/catalog and bounded warnings', () => {
    const route = makeRoute({
      remoteMetadata: { providerSecret: 'do not expose' },
      fetchedAt: '2026-07-27T09:00:00.000Z',
      path: '/private/provider/path',
    });
    const record = makeRecord({
      modelRoute: undefined,
      modelRouteId: route.id,
      selectedRoute: route,
      key: 'raw-api-key',
      operations: [{ secretId: 'journal-secret' }],
      paths: { root: '/absolute/private/path' },
      remoteMetadata: { arbitrary: true },
      catalog: {
        routes: [route],
        fetchedAt: '2026-07-27T09:00:00.000Z',
        stale: true,
        warnings: [
          ...Array.from({ length: 25 }, (_, index) => `warning-${index}`),
          { remoteMetadata: 'not a string' },
        ],
        remoteMetadata: { rawCatalog: true },
        path: '/private/catalog',
      },
    });

    const dto = toConnectionDto(record);
    assert.deepEqual(Object.keys(dto), [
      'id', 'kind', 'name', 'endpoint', 'apiFamilyOverride', 'modelRouteId',
      'selectedRoute', 'timeoutMs', 'hasApiKey', 'catalog', 'createdAt', 'updatedAt',
    ]);
    assert.deepEqual(Object.keys(dto.selectedRoute), [
      'id', 'modelId', 'label', 'apiFamily', 'source', 'confidence', 'capabilities',
    ]);
    assert.deepEqual(Object.keys(dto.catalog), ['routes', 'fetchedAt', 'stale', 'warnings']);
    assert.equal(dto.hasApiKey, true);
    assert.equal(dto.catalog.warnings.length, 20);
    assert.deepEqual(dto.catalog.routes, [sanitizeRoute(route)]);

    const serialized = JSON.stringify(dto);
    for (const forbidden of ['secretId', 'raw-api-key', 'operations', '/absolute/private/path', 'remoteMetadata', 'providerSecret']) {
      assert.equal(serialized.includes(forbidden), false, `projection leaked ${forbidden}`);
    }
  });

  it('projects absent secret, route, and catalog as false/null', () => {
    const dto = toConnectionDto(makeRecord({
      secretId: '',
      modelRoute: undefined,
      modelRouteId: null,
      selectedRoute: null,
      catalog: null,
    }));
    assert.equal(dto.hasApiKey, false);
    assert.equal(dto.selectedRoute, null);
    assert.equal(dto.catalog, null);
  });

  it('redacts credentials, API keys, signed URLs, and provider secret text from catalog warnings', () => {
    const serialized = JSON.stringify(toConnectionDto(makeRecord({
      catalog: {
        routes: [],
        warnings: [
          'authorization: Bearer sk-live-secret-value',
          'api_key=provider-api-key-value',
          'download failed: https://cdn.example/x.png?X-Amz-Credential=user%2Fscope&X-Amz-Signature=deadbeef',
          'providerSecret: raw-provider-secret-text',
        ],
      },
    })));

    for (const leaked of ['sk-live-secret-value', 'provider-api-key-value', 'user%2Fscope', 'deadbeef', 'raw-provider-secret-text']) {
      assert.equal(serialized.includes(leaked), false, `warning leaked ${leaked}`);
    }
    assert.ok(serialized.includes('[REDACTED]'));
  });
});

describe('connection store', () => {
  it('atomically creates records with stable caller IDs and preserves sanitized selected route', async () => {
    const paths = makePaths();
    const route = makeRoute({ remoteMetadata: { unsafe: true } });
    const created = await createConnection(paths, makeRecord({ modelRoute: route }));

    assert.equal(created.id, 'connection123456');
    assert.equal(created.modelRouteId, route.id);
    assert.deepEqual(created.selectedRoute, sanitizeRoute(route));
    assert.equal('modelRoute' in created, false);
    assert.equal('remoteMetadata' in created.selectedRoute, false);
    assert.deepEqual(await getConnection(paths, created.id), created);
    assert.deepEqual(await listConnections(paths), [created]);
  });

  it('persists real adapter probe routes selected with auto as concrete families', async () => {
    const cases = [
      [openAIImagesAdapter, 'https://api.openai.com/v1', [{ status: 200, body: openAIModelsFixture }]],
      [geminiNativeAdapter, 'https://generativelanguage.googleapis.com', [{ status: 200, body: geminiModelsFixture }]],
      [openRouterImagesAdapter, 'https://openrouter.ai/api/v1', [
        { status: 200, body: openRouterImageModelsFixture },
        { status: 500, body: {} },
        { status: 500, body: {} },
      ]],
    ];
    for (const [adapter, endpoint, responses] of cases) {
      const fetch = createFakeSafeFetch(responses);
      const probe = createProbeService({ adapters: [adapter], safeRequest: fetch.safeRequest, now: () => new Date('2026-07-27T12:00:00.000Z') });
      const catalog = await probe.probeTransient({ endpoint, apiKey: 'test-key', apiFamilyOverride: 'auto', timeoutMs: 300000 });
      assert.ok(catalog.routes.length > 0, `${adapter.apiFamily} should discover a route`);
      const route = catalog.routes[0];
      assert.match(route.id, /^route_[a-f0-9]{24}$/);
      const validated = validateCreateConnectionInput({
        id: 'connection123456', name: adapter.apiFamily, endpoint,
        apiFamilyOverride: 'auto', modelRoute: route, timeoutMs: 300000,
      }, () => '2026-07-27T12:00:00.000Z');
      assert.equal(validated.apiFamilyOverride, 'auto');
      assert.equal(validated.selectedRoute.apiFamily, adapter.apiFamily);
      assert.equal(validated.modelRouteId, route.id);
    }
  });
  it('persists only bounded adapter metadata so a probed Gemini route generates after reload', async () => {
    const paths = makePaths();
    const probeFetch = createFakeSafeFetch([{ status: 200, body: geminiModelsFixture }]);
    const probe = await geminiNativeAdapter.probe({
      endpoint: 'https://api.example.com',
      secret: 'gemini-test-secret',
      safeRequest: probeFetch.safeRequest,
      now: () => new Date('2026-07-27T12:00:00.000Z'),
    });
    const probedRoute = {
      ...probe.routes[0],
      remoteMetadata: {
        ...probe.routes[0].remoteMetadata,
        arbitrary: 'do not persist',
        providerSecret: 'do not persist',
      },
    };

    const created = await createConnection(paths, makeRecord({
      modelRoute: probedRoute,
      apiFamilyOverride: 'gemini-native',
    }));
    assert.deepEqual(created.selectedRoute, sanitizePersistedRoute(probedRoute));
    assert.deepEqual(created.selectedRoute.remoteMetadata, {
      geminiApiVersion: 'v1',
      authStrategy: 'bearer',
      versionedBase: 'https://api.example.com/v1',
    });
    assert.equal(JSON.stringify(created).includes('do not persist'), false);

    const dto = toConnectionDto(created);
    assert.equal('remoteMetadata' in dto.selectedRoute, false);

    const persisted = await getConnection(paths, created.id);
    const generateFetch = createFakeSafeFetch([{ status: 200, body: {
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'cmVzdWx0' } }] } }],
    } }]);
    const generated = await geminiNativeAdapter.generate({
      secret: 'gemini-test-secret',
      safeRequest: generateFetch.safeRequest,
    }, persisted.selectedRoute, { prompt: 'Generate', references: [] });

    assert.deepEqual(generated, {
      kind: 'base64', value: 'cmVzdWx0', mimeType: 'image/png', warnings: [],
    });
    assert.equal(
      generateFetch.calls[0].url,
      'https://api.example.com/v1/models/gemini-2.5-flash-image:generateContent',
    );
  });

  it('serializes concurrent creates and rejects duplicate caller IDs', async () => {
    const paths = makePaths();
    await Promise.all(Array.from({ length: 12 }, (_, index) => createConnection(paths, makeRecord({
      id: `connection${String(index).padStart(6, '0')}`,
      name: `Connection ${index}`,
    }))));
    assert.equal((await listConnections(paths)).length, 12);
    await assert.rejects(createConnection(paths, makeRecord({ id: 'connection000000' })), /already exists/);
  });

  it('atomically replaces then tombstones a record and omits it from list/get', async () => {
    const paths = makePaths();
    await createConnection(paths, makeRecord());

    const replacementRoute = makeRoute({ id: 'route654321', modelId: 'new-model' });
    const replaced = await replaceConnection(paths, 'connection123456', makeRecord({
      id: 'ignoredid123456',
      name: 'Replaced',
      modelRoute: replacementRoute,
      updatedAt: '2026-07-27T11:00:00.000Z',
    }));
    assert.equal(replaced.id, 'connection123456');
    assert.equal(replaced.modelRouteId, replacementRoute.id);
    assert.deepEqual(replaced.selectedRoute, sanitizeRoute(replacementRoute));

    const tombstoned = await tombstoneConnection(paths, 'connection123456');
    assert.equal(tombstoned.tombstone, true);
    assert.deepEqual(await listConnections(paths), []);
    assert.equal(await getConnection(paths, 'connection123456'), null);

    const disk = await readJson(paths.connections, []);
    assert.equal(disk.length, 1);
    assert.equal(disk[0].tombstone, true);
    assert.equal(disk[0].modelRouteId, replacementRoute.id);
    assert.deepEqual(disk[0].selectedRoute, sanitizeRoute(replacementRoute));
  });
});

describe('connection lifecycle service', () => {
  it('validates and normalizes create input before markers or secrets are written', async () => {
    const paths = makePaths();
    const calls = [];
    const service = createConnectionService({
      paths,
      createOperationId: () => 'operation000000',
      now: () => '2026-07-27T12:00:00.000Z',
      operationStore: {
        async beginOperation() { calls.push('begin'); },
        async advanceOperation() { calls.push('advance'); },
        async finishOperation() { calls.push('finish'); },
      },
      secretStore: {
        async writeSecret() { calls.push('write-secret'); return { id: 'secret-created', present: true }; },
        async deleteSecret() { calls.push('delete-secret'); },
      },
      connectionStore: {
        async createConnection(record) { calls.push('create-metadata'); return record; },
      },
    });
    const input = {
      id: 'connection123456',
      name: '  Primary Images  ',
      endpoint: 'https://IMAGES.example.com:443/v1',
      apiFamilyOverride: 'openai-images',
      modelRoute: makeRoute(),
      timeoutMs: 300000,
    };

    const created = await service.create(input, 'api-key');

    assert.equal(created.name, 'Primary Images');
    assert.equal(created.endpoint, 'https://images.example.com/v1');
    assert.equal(created.modelRouteId, 'route123456');
    assert.deepEqual(created.selectedRoute, sanitizeRoute(input.modelRoute));
    assert.equal(created.createdAt, '2026-07-27T12:00:00.000Z');
    assert.equal(created.updatedAt, '2026-07-27T12:00:00.000Z');
    assert.equal(created.schemaVersion, 1);
    assert.deepEqual(calls, ['begin', 'write-secret', 'advance', 'create-metadata', 'advance', 'finish']);
  });

  it('rejects malicious or caller-owned create fields before any side effect', async () => {
    const sideEffects = [];
    const service = createConnectionService({
      paths: makePaths(),
      operationStore: { async beginOperation() { sideEffects.push('marker'); } },
      secretStore: { async writeSecret() { sideEffects.push('secret'); } },
      connectionStore: { async createConnection() { sideEffects.push('metadata'); } },
    });
    const valid = {
      id: 'connection123456',
      name: 'Primary',
      endpoint: 'https://images.example.com/v1',
      apiFamilyOverride: 'openai-images',
      modelRoute: makeRoute(),
      timeoutMs: 300000,
    };
    const malicious = [
      { ...valid, endpoint: 'http://169.254.169.254/latest/meta-data' },
      { ...valid, name: '   ' },
      { ...valid, name: 'x'.repeat(201) },
      { ...valid, timeoutMs: 0 },
      { ...valid, timeoutMs: 600001 },
      { ...valid, modelRoute: null },
      { ...valid, modelRoute: makeRoute({ id: '' }) },
      { ...valid, modelRouteId: 'attacker123456' },
      { ...valid, secretId: 'attacker-secret-id' },
      { ...valid, createdAt: '1999-01-01T00:00:00.000Z' },
      { ...valid, updatedAt: '1999-01-01T00:00:00.000Z' },
      { ...valid, schemaVersion: 999 },
      { ...valid, tombstone: true },
      { ...valid, selectedRoute: makeRoute() },
    ];

    for (const fixture of malicious) {
      await assert.rejects(service.create(fixture, 'api-key'));
    }
    assert.deepEqual(sideEffects, []);
  });

  it('creates in validate, marker, secret, metadata, finish order with the caller ID', async () => {
    const lifecycle = makeLifecycle();
    const created = await lifecycle.service.create(makeRecord({ secretId: undefined }), 'api-key');
    assert.equal(created.id, 'connection123456');
    assert.deepEqual(lifecycle.calls.map(call => call[0]), ['validate', 'begin', 'write-secret', 'advance', 'create-metadata', 'advance', 'finish']);
    assert.deepEqual(lifecycle.calls.find(call => call[0] === 'create-metadata'), ['create-metadata', 'connection123456', 'secret-1']);
  });

  it('labels secret writes with the durable operation ID', async () => {
    const lifecycle = makeLifecycle();
    lifecycle.deps.secretStore.writeSecret = async (value, label) => {
      lifecycle.calls.push(['write-secret', value, label]);
      return { id: 'secret-labeled', present: true };
    };
    await lifecycle.service.create(makeRecord({ secretId: undefined }), 'api-key');
    assert.deepEqual(lifecycle.calls.find(call => call[0] === 'write-secret'), [
      'write-secret', 'api-key', 'ur-image-studio:operation:operation000000',
    ]);
    assert.equal([...lifecycle.markers.values()].length, 0);
  });

  it('serializes rotate and delete transactions under the user journal lock', async () => {
    const paths = makePaths();
    await createConnection(paths, makeRecord({ secretId: 'secret-old' }));
    const calls = [];
    let releaseWrite;
    const writeBlocked = new Promise(resolve => { releaseWrite = resolve; });
    let writeStartedResolve;
    const writeStarted = new Promise(resolve => { writeStartedResolve = resolve; });
    const service = createConnectionService({
      paths,
      createOperationId: (() => { let i = 0; return () => `operation${String(i++).padStart(6, '0')}`; })(),
      secretStore: {
        async writeSecret() {
          calls.push('rotate-write');
          writeStartedResolve();
          await writeBlocked;
          return { id: 'secret-new', present: true };
        },
        async deleteSecret(id) { calls.push(`delete-secret:${id}`); },
      },
      requestStore: { async deleteByConnection() { calls.push('delete-requests'); } },
      artifactStore: { async deleteByConnection() { calls.push('delete-artifacts'); } },
    });

    const rotate = service.rotateKey('connection123456', 'new-key');
    await writeStarted;
    const deleting = service.delete('connection123456');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(calls, ['rotate-write']);
    releaseWrite();
    await Promise.all([rotate, deleting]);
    assert.ok(calls.indexOf('delete-secret:secret-old') < calls.indexOf('delete-secret:secret-new'));
    assert.ok(calls.indexOf('delete-secret:secret-new') < calls.indexOf('delete-requests'));
  });

  it('cleans the new secret after create metadata failure and retains marker if cleanup fails', async () => {
    const metadataError = new Error('metadata unavailable');
    const cleaned = makeLifecycle({ connectionStore: { async createConnection() { throw metadataError; } } });
    await assert.rejects(cleaned.service.create(makeRecord(), 'api-key'), error => error === metadataError);
    assert.deepEqual(cleaned.calls.filter(call => call[0] === 'delete-secret'), [['delete-secret', 'secret-1']]);
    assert.equal(cleaned.markers.size, 0);

    const retained = makeLifecycle();
    retained.deps.connectionStore.createConnection = async () => { throw metadataError; };
    retained.deps.secretStore.deleteSecret = async (id) => { retained.calls.push(['delete-secret', id]); throw new Error('cleanup unavailable'); };
    await assert.rejects(retained.service.create(makeRecord(), 'api-key'), error => error === metadataError);
    assert.equal(retained.markers.size, 1);
    assert.equal([...retained.markers.values()][0].newSecretId, 'secret-1');
  });

  it('retains the new secret and marker when create fails after metadata commit', async () => {
    const lifecycle = makeLifecycle();
    const advance = lifecycle.deps.operationStore.advanceOperation;
    lifecycle.deps.operationStore.advanceOperation = async (id, patch) => {
      await advance(id, patch);
      if (patch.phase === 'committed') throw new Error('marker update unavailable');
    };

    await assert.rejects(lifecycle.service.create(makeRecord(), 'api-key'), /marker update unavailable/);
    assert.equal(lifecycle.connections.get('connection123456').secretId, 'secret-1');
    assert.deepEqual(lifecycle.calls.filter(call => call[0] === 'delete-secret'), []);
    assert.equal(lifecycle.markers.size, 1);
  });

  it('updates metadata without rotating when the API key is missing or blank', async () => {
    for (const apiKey of [undefined, '', '   ']) {
      const lifecycle = makeLifecycle();
      lifecycle.connections.set('connection123456', makeRecord({ secretId: 'secret-old' }));

      const updated = await lifecycle.service.update(
        'connection123456',
        makeRecord({ secretId: undefined, name: 'Updated' }),
        apiKey,
      );

      assert.equal(updated.name, 'Updated');
      assert.equal(updated.secretId, 'secret-old');
      assert.deepEqual(lifecycle.calls.filter(call => call[0] === 'write-secret'), []);
      assert.equal(lifecycle.markers.size, 0);
    }
  });

  it('updates key and metadata through one durable rotate marker lifecycle', async () => {
    const lifecycle = makeLifecycle();
    lifecycle.connections.set('connection123456', makeRecord({ secretId: 'secret-old' }));

    const updated = await lifecycle.service.update(
      'connection123456',
      makeRecord({ secretId: undefined, name: 'Updated' }),
      'new-api-key',
    );

    assert.equal(updated.name, 'Updated');
    assert.equal(updated.secretId, 'secret-1');
    assert.deepEqual(lifecycle.calls.map(call => call[0]), [
      'get-metadata', 'validate', 'begin', 'write-secret', 'advance',
      'replace-metadata', 'advance', 'delete-secret', 'finish',
    ]);
    assert.deepEqual(lifecycle.calls.find(call => call[0] === 'begin'), ['begin', 'rotate-key', 'creating-secret']);
    assert.deepEqual(lifecycle.calls.filter(call => call[0] === 'delete-secret'), [['delete-secret', 'secret-old']]);
    assert.equal(lifecycle.markers.size, 0);
  });

  it('retains a committed update marker when old-key cleanup fails', async () => {
    const lifecycle = makeLifecycle();
    lifecycle.connections.set('connection123456', makeRecord({ secretId: 'secret-old' }));
    lifecycle.deps.secretStore.deleteSecret = async (id) => {
      lifecycle.calls.push(['delete-secret', id]);
      throw new Error('cleanup unavailable');
    };

    await assert.rejects(lifecycle.service.update(
      'connection123456',
      makeRecord({ secretId: undefined, name: 'Updated' }),
      'new-api-key',
    ), /cleanup unavailable/);

    assert.equal(lifecycle.connections.get('connection123456').name, 'Updated');
    assert.equal(lifecycle.connections.get('connection123456').secretId, 'secret-1');
    assert.deepEqual([...lifecycle.markers.values()].map(op => ({
      type: op.type, phase: op.phase, oldSecretId: op.oldSecretId, newSecretId: op.newSecretId,
    })), [{
      type: 'rotate-key', phase: 'committed', oldSecretId: 'secret-old', newSecretId: 'secret-1',
    }]);
  });

  it('rotates write-new-first and cleans the new orphan before metadata commit failure', async () => {
    const lifecycle = makeLifecycle();
    lifecycle.connections.set('connection123456', makeRecord({ secretId: 'secret-old' }));
    lifecycle.deps.connectionStore.replaceConnection = async () => { lifecycle.calls.push(['replace-metadata-failed']); throw new Error('metadata unavailable'); };
    await assert.rejects(lifecycle.service.rotateKey('connection123456', 'new-api-key'), /metadata unavailable/);
    assert.ok(lifecycle.calls.findIndex(call => call[0] === 'write-secret') < lifecycle.calls.findIndex(call => call[0] === 'replace-metadata-failed'));
    assert.deepEqual(lifecycle.calls.filter(call => call[0] === 'delete-secret'), [['delete-secret', 'secret-1']]);
    assert.equal(lifecycle.connections.get('connection123456').secretId, 'secret-old');
    assert.equal(lifecycle.markers.size, 0);
  });

  it('retains committed rotation marker when old-secret cleanup fails for reconciliation', async () => {
    const lifecycle = makeLifecycle();
    lifecycle.connections.set('connection123456', makeRecord({ secretId: 'secret-old' }));
    lifecycle.deps.secretStore.deleteSecret = async (id) => { lifecycle.calls.push(['delete-secret', id]); throw new Error('secret cleanup unavailable'); };
    await assert.rejects(lifecycle.service.rotateKey('connection123456', 'new-api-key'), /secret cleanup unavailable/);
    assert.equal(lifecycle.connections.get('connection123456').secretId, 'secret-1');
    assert.equal([...lifecycle.markers.values()][0].phase, 'committed');
    assert.deepEqual(lifecycle.calls.filter(call => call[0] === 'delete-secret'), [['delete-secret', 'secret-old']]);
  });

  it('tombstones metadata before idempotent delete cleanup and finishes last', async () => {
    const lifecycle = makeLifecycle();
    lifecycle.connections.set('connection123456', makeRecord({ secretId: 'secret-old' }));
    await lifecycle.service.delete('connection123456');
    const names = lifecycle.calls.map(call => call[0]);
    assert.ok(names.indexOf('tombstone-metadata') < names.indexOf('delete-secret'));
    assert.ok(names.indexOf('tombstone-metadata') < names.indexOf('delete-requests'));
    assert.ok(names.indexOf('tombstone-metadata') < names.indexOf('delete-artifacts'));
    assert.equal(names.at(-1), 'finish');
    assert.equal(lifecycle.markers.size, 0);
  });

  it('removes the delete marker when tombstoning fails before cleanup', async () => {
    const lifecycle = makeLifecycle();
    lifecycle.connections.set('connection123456', makeRecord({ secretId: 'secret-old' }));
    lifecycle.deps.connectionStore.tombstoneConnection = async () => {
      throw new Error('metadata unavailable');
    };

    await assert.rejects(lifecycle.service.delete('connection123456'), /metadata unavailable/);
    assert.equal(lifecycle.markers.size, 0);
    assert.deepEqual(lifecycle.calls.filter(call => call[0].startsWith('delete-')), []);
  });

  it('retains failed delete cleanup for safe integration with reconciliation', async () => {
    const lifecycle = makeLifecycle();
    lifecycle.connections.set('connection123456', makeRecord({ secretId: 'secret-old' }));
    lifecycle.deps.artifactStore.deleteByConnection = async () => { throw new Error('artifact cleanup unavailable'); };
    await assert.rejects(lifecycle.service.delete('connection123456'), /artifact cleanup unavailable/);
    assert.equal([...lifecycle.markers.values()][0].phase, 'tombstoned');
    await writeJson(lifecycle.deps.paths.operations, [...lifecycle.markers.values()]);
    const reconciled = [];
    await reconcileOperations({
      paths: lifecycle.deps.paths,
      connectionStore: { getConnections: () => [...lifecycle.connections.values()] },
      secretStore: { async deleteSecret(id) { reconciled.push(['secret', id]); } },
      requestStore: { async deleteByConnection(id) { reconciled.push(['requests', id]); } },
      artifactStore: { async deleteByConnection(id) { reconciled.push(['artifacts', id]); } },
    });
    assert.deepEqual(reconciled, [['secret', 'secret-old'], ['requests', 'connection123456'], ['artifacts', 'connection123456']]);
    assert.deepEqual(await readJson(lifecycle.deps.paths.operations, []), []);
  });
});
