import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ADAPTERS, getAdapter } from '../server-plugin/src/adapters/index.js';
import {
  buildManualRoute,
  probeAdapters,
} from '../server-plugin/src/adapters/coordinator.js';
import { createProbeService } from '../server-plugin/src/services/probe.js';
import { validateManualRoute } from '../server-plugin/src/validation.js';
import { stableRouteId } from '../server-plugin/src/adapters/common.js';
import { deriveStableRouteId } from '../src/image-connection-schema.js';

const NOW = '2026-07-27T12:00:00.000Z';

function route(apiFamily, source, modelId = 'duplicate-image-model') {
  return {
    id: `route-${apiFamily}-${source}`,
    modelId,
    label: modelId,
    apiFamily,
    source,
    confidence: 'medium',
    capabilities: {
      generate: 'supported',
      references: 'unknown',
      maxReferences: null,
      aspectRatios: null,
      imageSizes: null,
      qualityValues: null,
    },
    fetchedAt: NOW,
  };
}

function fakeAdapter(apiFamily, behavior) {
  return {
    apiFamily,
    async probe(context) {
      return behavior(context);
    },
    async generate() {
      throw new Error('generate must never be called while probing');
    },
  };
}

describe('adapter registry', () => {
  it('contains exactly the three static image API families', () => {
    assert.deepEqual(ADAPTERS.map(adapter => adapter.apiFamily), [
      'openai-images',
      'gemini-native',
      'openrouter-images',
    ]);
    assert.equal(getAdapter('gemini-native').apiFamily, 'gemini-native');
    assert.equal(getAdapter('auto'), null);
  });
});

describe('probe coordinator', () => {
  it('runs automatic probes concurrently with allSettled semantics and keeps duplicate model IDs distinct', async () => {
    const calls = [];
    const adapters = [
      fakeAdapter('openai-images', async () => {
        calls.push('openai-images');
        return { status: 'ok', routes: [route('openai-images', 'openai-models')], warnings: [] };
      }),
      fakeAdapter('gemini-native', async () => {
        calls.push('gemini-native');
        throw new Error('secret-value-must-not-leak');
      }),
      fakeAdapter('openrouter-images', async () => {
        calls.push('openrouter-images');
        return { status: 'ok', routes: [route('openrouter-images', 'openrouter-image-models')], warnings: [] };
      }),
    ];

    const result = await probeAdapters({ endpoint: 'https://api.example.com' }, {
      adapters,
      apiFamilyOverride: 'auto',
      now: () => new Date(NOW),
    });

    assert.deepEqual(calls.sort(), ['gemini-native', 'openai-images', 'openrouter-images']);
    assert.equal(result.routes.length, 2);
    assert.equal(new Set(result.routes.map(item => item.id)).size, 2);
    assert.equal(result.warnings.length, 1);
    assert.doesNotMatch(result.warnings[0], /secret-value/);
    assert.equal(result.fetchedAt, NOW);
  });

  it('runs exactly one adapter for an explicit override', async () => {
    const calls = [];
    const adapters = ['openai-images', 'gemini-native', 'openrouter-images'].map(apiFamily => (
      fakeAdapter(apiFamily, async () => {
        calls.push(apiFamily);
        return { status: 'ok', routes: [route(apiFamily, `${apiFamily}-source`)], warnings: [] };
      })
    ));

    const result = await probeAdapters({}, {
      adapters,
      apiFamilyOverride: 'gemini-native',
      now: () => new Date(NOW),
    });

    assert.deepEqual(calls, ['gemini-native']);
    assert.equal(result.routes[0].apiFamily, 'gemini-native');
  });

  it('throws a catalog error when every adapter fails', async () => {
    const adapters = [
      fakeAdapter('openai-images', async () => { throw new Error('first secret'); }),
      fakeAdapter('gemini-native', async () => ({ status: 'unauthorized', routes: [], warnings: [] })),
      fakeAdapter('openrouter-images', async () => ({ status: 'unavailable', routes: [], warnings: [] })),
    ];

    await assert.rejects(
      probeAdapters({}, { adapters, apiFamilyOverride: 'auto' }),
      error => error.code === 'CATALOG_UNAVAILABLE' && !/secret/.test(error.message),
    );
  });

  it('distinguishes a successful catalog containing no image models', async () => {
    const adapters = [
      fakeAdapter('openai-images', async () => ({ status: 'ok', routes: [], warnings: [] })),
    ];

    const result = await probeAdapters({}, { adapters, apiFamilyOverride: 'auto' });

    assert.deepEqual(result.routes, []);
    assert.equal(result.noImageModels, true);
    assert.match(result.warnings[0], /no image models/i);
  });

  it('uses distinct deterministic canonical IDs per boundary', () => {
    const source = 'manual';
    const modelId = 'gpt-image-1';
    const generationContract = 'openai-images';

    // The browser and the plugin deliberately use different deterministic
    // algorithms (browser FNV-1a, plugin SHA-256). Cross-boundary ID parity was
    // removed when the browser became the route authority; each boundary is
    // internally stable and canonical within its own scope.
    const browserId = deriveStableRouteId(source, modelId, generationContract);
    const pluginId = stableRouteId(generationContract, source, modelId);

    assert.match(browserId, /^route_[a-f0-9]{24}$/);
    assert.match(pluginId, /^route_[a-f0-9]{24}$/);
    assert.notEqual(browserId, pluginId);

    // Each algorithm is deterministic: the same inputs always yield the same ID.
    assert.equal(browserId, deriveStableRouteId(source, modelId, generationContract));
    assert.equal(pluginId, stableRouteId(generationContract, source, modelId));
  });

  it('builds a stable conservative manual route only for an explicit family', () => {
    const first = buildManualRoute({
      apiFamilyOverride: 'openai-images',
      modelId: 'vendor/image-model',
      label: 'Vendor Image',
    });
    const second = buildManualRoute({
      apiFamilyOverride: 'openai-images',
      modelId: 'vendor/image-model',
      label: 'Renamed Label',
    });

    assert.equal(first.id, second.id);
    assert.match(first.id, /^route_[a-f0-9]{24}$/);
    assert.equal(first.apiFamily, 'openai-images');
    assert.equal(first.source, 'manual');
    assert.equal(first.confidence, 'manual');
    assert.deepEqual(first.capabilities, {
      generate: 'supported',
      references: 'unknown',
      maxReferences: null,
      aspectRatios: null,
      imageSizes: null,
      qualityValues: null,
    });
    assert.deepEqual(validateManualRoute(first, 'openai-images'), first);
    assert.throws(() => buildManualRoute({ apiFamilyOverride: 'auto', modelId: 'x' }), /explicit/i);
  });
});

describe('probe service', () => {
  it('constructs adapter context through dependency injection and transient probe does not persist', async () => {
    const writes = [];
    const seen = [];
    const service = createProbeService({
      adapters: [fakeAdapter('openai-images', async context => {
        seen.push(context);
        return { status: 'ok', routes: [route('openai-images', 'openai-models')], warnings: [] };
      })],
      safeRequest: async () => { throw new Error('unused'); },
      now: () => new Date(NOW),
      catalogStore: { async replaceCatalog(...args) { writes.push(args); } },
    });

    const result = await service.probeTransient({
      endpoint: 'https://api.example.com',
      secret: 'request-only-secret',
      apiFamilyOverride: 'auto',
      timeoutMs: 1234,
    });

    assert.equal(result.routes.length, 1);
    assert.equal(writes.length, 0);
    assert.equal(seen[0].secret, 'request-only-secret');
    assert.equal(seen[0].endpoint, 'https://api.example.com');
    assert.equal(seen[0].timeoutMs, 1234);
    assert.equal(typeof seen[0].safeRequest, 'function');
  });

  it('refresh persists after partial success but preserves and returns stale catalog after total failure', async () => {
    const oldCatalog = { routes: [route('openai-images', 'old')], fetchedAt: '2026-07-26T00:00:00.000Z', warnings: [] };
    const writes = [];
    let fail = false;
    const service = createProbeService({
      adapters: [fakeAdapter('openai-images', async () => {
        if (fail) throw new Error('request-only-secret');
        return { status: 'ok', routes: [route('openai-images', 'new')], warnings: [] };
      })],
      safeRequest: async () => { throw new Error('unused'); },
      now: () => new Date(NOW),
      connectionStore: {
        async getConnection() {
          return {
            id: 'connection123456',
            endpoint: 'https://api.example.com',
            secretId: 'secret-id',
            apiFamilyOverride: 'auto',
            timeoutMs: 3000,
            catalog: oldCatalog,
          };
        },
      },
      secretProvider: {
        async withSecret(_id, use) { return use('request-only-secret'); },
      },
      catalogStore: {
        async replaceCatalog(_paths, _id, value) { writes.push(value); return value; },
      },
    });

    const refreshed = await service.refreshStored({}, 'connection123456');
    assert.equal(writes.length, 1);
    assert.equal(refreshed.stale, false);

    fail = true;
    const preserved = await service.refreshStored({}, 'connection123456');
    assert.equal(writes.length, 1);
    assert.equal(preserved.stale, true);
    assert.deepEqual(preserved.routes, oldCatalog.routes);
    assert.doesNotMatch(preserved.warnings.join(' '), /request-only-secret/);
  });
});
