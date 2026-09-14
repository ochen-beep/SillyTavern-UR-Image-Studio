import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { join } from 'node:path';

import { readJson, writeJson } from '../server-plugin/src/storage/atomic-json.js';
import {
  getCatalog,
  isCatalogStale,
  replaceCatalog,
} from '../server-plugin/src/storage/catalog-store.js';
import { cleanupTempDir, useTempDir } from './server-plugin/temp-store.js';

const tempDirs = [];
const NOW = '2026-07-27T12:00:00.000Z';

function makePaths() {
  const root = useTempDir();
  tempDirs.push(root);
  return { connections: join(root, 'connections.json') };
}

function route(overrides = {}) {
  return {
    id: 'route_1234567890abcdef12345678',
    modelId: 'image-model',
    label: 'Image Model',
    apiFamily: 'gemini-native',
    source: 'gemini-models',
    confidence: 'medium',
    capabilities: {
      generate: 'supported',
      references: 'unknown',
      maxReferences: null,
      aspectRatios: null,
      imageSizes: null,
      qualityValues: null,
    },
    remoteMetadata: {
      geminiApiVersion: 'v1beta',
      authStrategy: 'x-goog-api-key',
      versionedBase: 'https://api.example.com/v1beta',
      description: 'must not persist',
      arbitrarySecret: 'must not persist',
    },
    fetchedAt: NOW,
    ...overrides,
  };
}

function catalog(overrides = {}) {
  return {
    routes: [route()],
    fetchedAt: NOW,
    warnings: [],
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

describe('catalog store', () => {
  it('atomically replaces only the selected connection catalog and persists strict metadata allowlists', async () => {
    const paths = makePaths();
    await writeJson(paths.connections, [
      { id: 'connection123456', name: 'First', catalog: catalog({ fetchedAt: '2026-07-26T00:00:00.000Z' }) },
      { id: 'connection654321', name: 'Second', catalog: { routes: [], fetchedAt: 'old', warnings: [] } },
    ]);

    const stored = await replaceCatalog(paths, 'connection123456', catalog());
    const records = await readJson(paths.connections, []);

    assert.equal(stored.routes[0].remoteMetadata.geminiApiVersion, 'v1beta');
    assert.deepEqual(Object.keys(stored.routes[0].remoteMetadata).sort(), [
      'authStrategy', 'geminiApiVersion', 'versionedBase',
    ]);
    assert.equal(records[0].catalog.fetchedAt, NOW);
    assert.equal(records[1].catalog.fetchedAt, 'old');
  });

  it('keeps the old catalog when a replacement cannot be committed', async () => {
    const paths = makePaths();
    const oldCatalog = catalog({ fetchedAt: '2026-07-26T00:00:00.000Z' });
    await writeJson(paths.connections, [{ id: 'connection123456', catalog: oldCatalog }]);

    await assert.rejects(
      replaceCatalog(paths, 'missing123456', catalog()),
      /not found/,
    );

    assert.deepEqual(await getCatalog(paths, 'connection123456'), oldCatalog);
  });

  it('uses a 6 hour stale threshold for OpenRouter and 24 hours for OpenAI and Gemini', () => {
    const now = new Date(NOW);
    assert.equal(isCatalogStale(catalog({
      fetchedAt: '2026-07-27T05:59:59.999Z',
      routes: [route({ apiFamily: 'openrouter-images', source: 'openrouter-image-models' })],
    }), now), true);
    assert.equal(isCatalogStale(catalog({
      fetchedAt: '2026-07-27T05:59:59.999Z',
      routes: [route({ apiFamily: 'openai-images', source: 'openai-models' })],
    }), now), false);
    assert.equal(isCatalogStale(catalog({
      fetchedAt: '2026-07-26T11:59:59.999Z',
      routes: [route({ apiFamily: 'gemini-native', source: 'gemini-models' })],
    }), now), true);
  });
});
