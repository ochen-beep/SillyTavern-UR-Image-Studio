import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  buildOpenRouterBase,
  buildOpenRouterEndpointsUrl,
  buildOpenRouterModelsUrl,
  openRouterImagesAdapter,
} from '../server-plugin/src/adapters/openrouter-images.js';
import { ServerImageError } from '../server-plugin/src/errors.js';
import { createConnection, getConnection } from '../server-plugin/src/storage/connections-store.js';
import { sanitizePersistedRoute, toConnectionDto } from '../server-plugin/src/validation.js';
import { createFakeSafeFetch } from './server-plugin/fake-safe-fetch.js';
import { useTempDir, cleanupTempDir } from './server-plugin/temp-store.js';
import {
  malformedOpenRouterModelsFixture,
  openRouterFluxEndpointsFixture,
  openRouterImageModelsFixture,
  openRouterImagenEndpointsFixture,
} from './server-plugin/fixtures-openrouter.js';

const NOW = '2026-07-27T12:00:00.000Z';
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

function makeContext(fake, overrides = {}) {
  return {
    endpoint: 'https://openrouter.ai',
    secret: 'or-test-secret',
    safeRequest: fake.safeRequest,
    now: () => new Date(NOW),
    ...overrides,
  };
}

function successfulFetch(models = openRouterImageModelsFixture) {
  return createFakeSafeFetch([
    { status: 200, body: models },
    { status: 200, body: openRouterFluxEndpointsFixture },
    { status: 200, body: openRouterImagenEndpointsFixture },
  ]);
}

describe('OpenRouter image endpoint normalization', () => {
  it('uses the exact official API root and dedicated catalog URLs', () => {
    assert.equal(buildOpenRouterBase('https://openrouter.ai'), 'https://openrouter.ai/api/v1');
    assert.equal(buildOpenRouterBase('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1');
    assert.equal(buildOpenRouterModelsUrl('https://openrouter.ai/'), 'https://openrouter.ai/api/v1/images/models');
    assert.equal(
      buildOpenRouterEndpointsUrl('https://openrouter.ai', 'black-forest-labs/flux-1.1-pro'),
      'https://openrouter.ai/api/v1/images/models/black-forest-labs/flux-1.1-pro/endpoints',
    );
  });

  it('accepts only a documented compatible custom /api/v1 root', () => {
    assert.equal(buildOpenRouterBase('https://gateway.example/custom/api/v1/'), 'https://gateway.example/custom/api/v1');
    for (const endpoint of [
      'https://gateway.example',
      'https://gateway.example/v1',
      'https://gateway.example/api/v1/images',
      'http://gateway.example/api/v1',
    ]) {
      assert.throws(
        () => buildOpenRouterBase(endpoint),
        error => error instanceof ServerImageError && error.code === 'INVALID_ENDPOINT',
      );
    }
  });
});

describe('OpenRouter Images probe', () => {
  it('GETs the dedicated model and per-model endpoint catalogs with Bearer authentication', async () => {
    const fake = successfulFetch();
    const result = await openRouterImagesAdapter.probe(makeContext(fake));

    assert.equal(result.status, 'ok');
    assert.deepEqual(fake.calls.map(call => call.url), [
      'https://openrouter.ai/api/v1/images/models',
      'https://openrouter.ai/api/v1/images/models/black-forest-labs/flux-1.1-pro/endpoints',
      'https://openrouter.ai/api/v1/images/models/google/imagen-4-fast/endpoints',
    ]);
    assert.ok(fake.calls.every(call => call.method === 'GET'));
    assert.ok(fake.calls.every(call => call.headers.authorization === 'Bearer or-test-secret'));
    assert.ok(fake.calls.every(call => !/chat\/completions|responses|images\/generations|images\/edits/.test(call.url)));
  });

  it('lets endpoint descriptors override coarse model capabilities and preserves differing endpoints', async () => {
    const first = await openRouterImagesAdapter.probe(makeContext(successfulFetch()));
    const reordered = structuredClone(openRouterFluxEndpointsFixture);
    reordered.data.endpoints.reverse();
    const secondFake = createFakeSafeFetch([
      { status: 200, body: { data: [openRouterImageModelsFixture.data[0]] } },
      { status: 200, body: reordered },
    ]);
    const second = await openRouterImagesAdapter.probe(makeContext(secondFake));

    assert.equal(first.routes.length, 3);
    const fal = first.routes.find(route => route.remoteMetadata.providerTag === 'fal');
    const together = first.routes.find(route => route.remoteMetadata.providerTag === 'together');
    assert.ok(fal);
    assert.ok(together);
    assert.notEqual(fal.id, together.id);
    assert.equal(second.routes.find(route => route.remoteMetadata.providerTag === 'fal').id, fal.id);
    assert.deepEqual(fal.capabilities, {
      generate: 'supported',
      references: 'supported',
      maxReferences: 4,
      aspectRatios: ['1:1', '3:2', '16:9'],
      imageSizes: ['1K', '2K', '4K'],
      qualityValues: ['standard', 'high'],
    });
    assert.deepEqual(together.capabilities, {
      generate: 'supported',
      references: 'unsupported',
      maxReferences: null,
      aspectRatios: ['1:1'],
      imageSizes: ['1K'],
      qualityValues: [],
    });
    assert.deepEqual(
      first.routes.find(route => route.modelId === 'google/imagen-4-fast').capabilities.aspectRatios,
      ['1:1', '9:16'],
    );
    assert.equal(fal.fetchedAt, NOW);
    assert.deepEqual(fal.remoteMetadata.supportedParameters, [
      'aspect_ratio', 'resolution', 'quality', 'input_references', 'max_input_references',
    ]);
  });

  it('accepts documented supported_parameters descriptors at model and endpoint level', async () => {
    const fake = createFakeSafeFetch([
      { status: 200, body: { data: [{
        id: 'author/model',
        supported_parameters: [
          { name: 'aspect_ratio', type: 'enum', values: ['1:1'] },
          { name: 'input_references', type: 'boolean', value: false },
        ],
      }] } },
      { status: 200, body: { data: { endpoints: [{
        provider_name: 'Provider',
        provider_slug: 'provider-slug',
        provider_tag: 'provider-slug',
        supported_parameters: [
          { name: 'aspect_ratio', type: 'enum', values: ['16:9'] },
          { name: 'input_references', type: 'boolean' },
          { name: 'max_input_references', type: 'range', min: 1, max: 3 },
        ],
      }] } } },
    ]);

    const result = await openRouterImagesAdapter.probe(makeContext(fake));

    assert.deepEqual(result.routes[0].capabilities, {
      generate: 'supported', references: 'supported', maxReferences: 3,
      aspectRatios: ['16:9'], imageSizes: null, qualityValues: null,
    });
    assert.equal(result.routes[0].remoteMetadata.providerTag, 'provider-slug');
  });

  it('collapses unselectable endpoint variants to one conservative model route', async () => {
    const fake = createFakeSafeFetch([
      { status: 200, body: { data: [{ id: 'author/model', name: 'Model' }] } },
      { status: 200, body: { endpoints: [
        {
          provider_name: 'Provider A', provider_slug: 'provider-a', provider_tag: null,
          supported_parameters: {
            aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] },
            input_references: { type: 'boolean' },
            max_input_references: { type: 'range', min: 1, max: 4 },
          },
        },
        {
          provider_name: 'Provider B', provider_slug: 'provider-b', provider_tag: null,
          supported_parameters: {
            aspect_ratio: { type: 'enum', values: ['1:1'] },
          },
        },
      ] } },
    ]);

    const result = await openRouterImagesAdapter.probe(makeContext(fake));

    assert.equal(result.routes.length, 1);
    assert.equal(result.routes[0].modelId, 'author/model');
    assert.equal(result.routes[0].remoteMetadata?.providerTag, undefined);
    assert.deepEqual(result.routes[0].capabilities, {
      generate: 'supported', references: 'unsupported', maxReferences: null,
      aspectRatios: ['1:1'], imageSizes: null, qualityValues: null,
    });
  });

  it('maps malformed or unsafe descriptors conservatively', async () => {
    const models = { data: [{
      id: 'author/model',
      capabilities: [
        { name: 'aspect_ratio', type: 'range', min: 1, max: 2 },
        { name: 'resolution', type: 'enum', values: '2K' },
        { name: 'quality', type: 'enum', values: ['high', { secret: true }] },
        { name: 'input_references', type: 'boolean', value: 'yes' },
        { name: 'max_input_references', type: 'range', min: 0, max: 2.5 },
      ],
    }] };
    const fake = createFakeSafeFetch([
      { status: 200, body: models },
      { status: 200, body: { data: { endpoints: [] } } },
    ]);

    const result = await openRouterImagesAdapter.probe(makeContext(fake));
    assert.deepEqual(result.routes[0].capabilities, {
      generate: 'supported', references: 'unknown', maxReferences: null,
      aspectRatios: null, imageSizes: null, qualityValues: ['high'],
    });
  });

  it('persists a strict generation metadata allowlist while the safe DTO omits it', async () => {
    const route = (await openRouterImagesAdapter.probe(makeContext(successfulFetch()))).routes[0];
    route.remoteMetadata.providerSecret = 'do not persist';
    route.remoteMetadata.arbitrary = { nested: true };
    const persisted = sanitizePersistedRoute(route);

    assert.deepEqual(persisted.remoteMetadata, {
      providerTag: route.remoteMetadata.providerTag,
      providerName: route.remoteMetadata.providerName,
      supportedParameters: route.remoteMetadata.supportedParameters,
    });
    assert.ok(JSON.stringify(persisted.remoteMetadata).length <= 1_024);
    const dto = toConnectionDto({ selectedRoute: persisted });
    assert.equal('remoteMetadata' in dto.selectedRoute, false);
    assert.equal(JSON.stringify(dto).includes('do not persist'), false);
  });

  it('reports auth, transport, upstream, malformed model, and malformed endpoint failures safely', async () => {
    const unauthorized = createFakeSafeFetch([{ status: 403, body: { error: 'secret detail' } }]);
    assert.deepEqual(await openRouterImagesAdapter.probe(makeContext(unauthorized)), {
      status: 'unauthorized', routes: [], warnings: [], manualEntryAllowed: true,
    });

    const transport = createFakeSafeFetch([new Error('secret transport detail')]);
    assert.deepEqual(await openRouterImagesAdapter.probe(makeContext(transport)), {
      status: 'unavailable', routes: [], warnings: ['OpenRouter image models catalog is unavailable.'], manualEntryAllowed: true,
    });

    const upstream = createFakeSafeFetch([{ status: 503, body: 'secret upstream detail' }]);
    assert.deepEqual(await openRouterImagesAdapter.probe(makeContext(upstream)), {
      status: 'unavailable', routes: [], warnings: ['OpenRouter image models catalog returned HTTP 503.'], manualEntryAllowed: true,
    });

    for (const body of ['{not json', malformedOpenRouterModelsFixture]) {
      const fake = createFakeSafeFetch([{ status: 200, body }]);
      const result = await openRouterImagesAdapter.probe(makeContext(fake));
      assert.equal(result.status, 'malformed');
      assert.deepEqual(result.routes, []);
    }

    const badEndpoint = createFakeSafeFetch([
      { status: 200, body: { data: [openRouterImageModelsFixture.data[0]] } },
      { status: 200, body: { data: { endpoints: 'not-an-array' } } },
    ]);
    const result = await openRouterImagesAdapter.probe(makeContext(badEndpoint));
    assert.equal(result.status, 'ok');
    assert.equal(result.routes.length, 1);
    assert.deepEqual(result.warnings, ['OpenRouter endpoint catalog for black-forest-labs/flux-1.1-pro was malformed; using model metadata.']);
  });

});

describe('OpenRouter Images generation', () => {
  const route = {
    modelId: 'black-forest-labs/flux-1.1-pro',
    capabilities: {
      references: 'supported',
      maxReferences: 2,
      aspectRatios: ['1:1', '16:9'],
      imageSizes: ['1K', '2K'],
      qualityValues: ['standard', 'high'],
    },
    remoteMetadata: {
      providerTag: 'fal',
      providerName: 'FAL',
      supportedParameters: ['resolution', 'aspect_ratio', 'quality', 'input_references'],
    },
  };
  const request = {
    prompt: 'Restyle both references as a poster',
    aspectRatio: '16:9',
    imageSize: '2K',
    quality: 'high',
    references: [
      { dataUrl: 'data:image/webp;base64,UklGRg==' },
      { dataUrl: 'data:image/jpeg;base64,/9j/2Q==' },
    ],
  };

  it('POSTs one exact dedicated Images request with only advertised selected fields', async () => {
    const fake = createFakeSafeFetch([{ status: 200, body: {
      data: [{ b64_json: 'cmVzdWx0', media_type: 'image/webp' }],
    } }]);
    const signal = AbortSignal.abort();
    const beforeDispatch = () => {};

    const result = await openRouterImagesAdapter.generate(
      makeContext(fake, { signal, timeoutMs: 12_345, beforeDispatch }), route, request,
    );

    assert.deepEqual(result, { kind: 'base64', value: 'cmVzdWx0', mimeType: 'image/webp', warnings: [] });
    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    assert.equal(call.url, 'https://openrouter.ai/api/v1/images');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, 'Bearer or-test-secret');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.equal(call.signal, signal);
    assert.equal(call.timeoutMs, 12_345);
    assert.equal(call.beforeDispatch, beforeDispatch);
    assert.deepEqual(JSON.parse(call.body), {
      model: 'black-forest-labs/flux-1.1-pro',
      prompt: request.prompt,
      n: 1,
      provider: {
        only: ['fal'],
        allow_fallbacks: false,
      },
      resolution: '2K',
      aspect_ratio: '16:9',
      quality: 'high',
      input_references: [
        { type: 'image_url', image_url: { url: 'data:image/webp;base64,UklGRg==' } },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/2Q==' } },
      ],
    });
    assert.equal('stream' in JSON.parse(call.body), false);
    assert.doesNotMatch(call.url, /chat\/completions|responses|images\/generations|images\/edits/);
  });

  it('omits unadvertised, invalid, and unselected optional fields', async () => {
    const fake = createFakeSafeFetch([{ status: 200, body: {
      data: [{ b64_json: 'eA==', media_type: 'image/png' }],
    } }]);
    const limitedRoute = {
      ...route,
      capabilities: { ...route.capabilities, references: 'unsupported' },
      remoteMetadata: { supportedParameters: ['aspect_ratio'] },
    };

    await openRouterImagesAdapter.generate(makeContext(fake), limitedRoute, {
      prompt: 'Minimal', aspectRatio: '21:9', imageSize: '2K', quality: 'high', references: [],
    });

    assert.deepEqual(JSON.parse(fake.calls[0].body), {
      model: route.modelId, prompt: 'Minimal', n: 1,
    });
  });

  it('generates through a sanitized persisted route after reload', async () => {
    const paths = makePaths();
    const probedRoute = (await openRouterImagesAdapter.probe(makeContext(successfulFetch()))).routes
      .find(candidate => candidate.remoteMetadata.providerTag === 'fal');
    const created = await createConnection(paths, {
      schemaVersion: 1,
      id: 'connection123456',
      name: 'OpenRouter',
      endpoint: 'https://openrouter.ai',
      modelRouteId: probedRoute.id,
      selectedRoute: probedRoute,
      apiFamilyOverride: 'openrouter-images',
      secretId: 'secret-1',
      timeoutMs: 300_000,
      createdAt: NOW,
      updatedAt: NOW,
    });
    assert.deepEqual(created.selectedRoute.remoteMetadata, {
      providerTag: 'fal',
      providerName: 'FAL',
      supportedParameters: ['aspect_ratio', 'resolution', 'quality', 'input_references', 'max_input_references'],
    });
    const persisted = await getConnection(paths, created.id);
    const fake = createFakeSafeFetch([{ status: 200, body: {
      data: [{ b64_json: 'cmVsb2FkZWQ=', media_type: 'image/png' }],
    } }]);

    await openRouterImagesAdapter.generate(makeContext(fake), persisted.selectedRoute, {
      prompt: 'Reloaded', aspectRatio: '16:9', imageSize: '2K', quality: 'high', references: [],
    });

    assert.deepEqual(JSON.parse(fake.calls[0].body), {
      model: probedRoute.modelId,
      prompt: 'Reloaded',
      n: 1,
      provider: {
        only: ['fal'],
        allow_fallbacks: false,
      },
      resolution: '2K',
      aspect_ratio: '16:9',
      quality: 'high',
    });
  });

  it('sends unknown references once even when input_references is omitted from supported parameters', async () => {
    const fake = createFakeSafeFetch([{ status: 400, body: { error: 'references rejected' } }]);
    const unknownRoute = {
      ...route,
      capabilities: { ...route.capabilities, references: 'unknown', maxReferences: 1 },
      remoteMetadata: {
        providerTag: 'fal',
        providerName: 'FAL',
        supportedParameters: ['aspect_ratio'],
      },
    };

    await assert.rejects(
      openRouterImagesAdapter.generate(makeContext(fake), unknownRoute, {
        ...request,
        references: [request.references[0]],
      }),
      error => error instanceof ServerImageError
        && error.code === 'UPSTREAM_HTTP_ERROR'
        && error.retryable === false,
    );

    assert.equal(fake.calls.length, 1);
    assert.deepEqual(JSON.parse(fake.calls[0].body).input_references, [
      { type: 'image_url', image_url: { url: request.references[0].dataUrl } },
    ]);
  });

  it('rejects unsupported, excess, and malformed references before dispatch', async () => {
    const fixtures = [
      [{ dataUrl: 'https://example.com/not-data.png' }],
      [{ dataUrl: 'data:text/plain;base64,eA==' }],
      [{ dataUrl: 'data:image/svg+xml;base64,eA==' }],
      [{ dataUrl: 'data:image/png;base64,not base64!' }],
      [{ dataUrl: 'data:image/png;base64,' }],
    ];
    for (const references of fixtures) {
      const fake = createFakeSafeFetch([]);
      await assert.rejects(
        openRouterImagesAdapter.generate(makeContext(fake), route, { ...request, references }),
        error => error instanceof ServerImageError && error.code === 'INVALID_REFERENCE',
      );
      assert.equal(fake.calls.length, 0);
    }

    for (const [candidateRoute, references, code] of [
      [route, 'not-an-array', 'INVALID_REFERENCE'],
      [{ ...route, capabilities: { ...route.capabilities, references: 'unsupported' } }, request.references, 'REFERENCES_UNSUPPORTED'],
      [route, [...request.references, request.references[0]], 'TOO_MANY_REFERENCES'],
    ]) {
      const fake = createFakeSafeFetch([]);
      await assert.rejects(
        openRouterImagesAdapter.generate(makeContext(fake), candidateRoute, { ...request, references }),
        error => error instanceof ServerImageError && error.code === code,
      );
      assert.equal(fake.calls.length, 0);
    }
  });

  it('rejects malformed and non-2xx responses safely after one dispatch', async () => {
    for (const response of [
      { status: 200, body: {} },
      { status: 200, body: { data: [] } },
      { status: 200, body: { data: [{ media_type: 'image/png' }] } },
      { status: 200, body: '{not json' },
    ]) {
      const fake = createFakeSafeFetch([response]);
      await assert.rejects(
        openRouterImagesAdapter.generate(makeContext(fake), route, { ...request, references: [] }),
        error => error instanceof ServerImageError
          && error.code === 'UPSTREAM_RESPONSE_INVALID'
          && error.retryable === false,
      );
      assert.equal(fake.calls.length, 1);
    }

    for (const status of [401, 403]) {
      const fake = createFakeSafeFetch([{ status, body: { error: 'private auth detail' } }]);
      await assert.rejects(
        openRouterImagesAdapter.generate(makeContext(fake), route, { ...request, references: [] }),
        error => error instanceof ServerImageError
          && error.code === 'AUTH_FAILED'
          && error.retryable === false
          && !error.message.includes('private auth detail'),
      );
      assert.equal(fake.calls.length, 1);
    }

    for (const status of [400, 503]) {
      const fake = createFakeSafeFetch([{ status, body: { error: 'private upstream detail' } }]);
      await assert.rejects(
        openRouterImagesAdapter.generate(makeContext(fake), route, { ...request, references: [] }),
        error => error instanceof ServerImageError
          && error.code === 'UPSTREAM_HTTP_ERROR'
          && error.retryable === (status >= 500)
          && !error.message.includes('private upstream detail'),
      );
      assert.equal(fake.calls.length, 1);
    }

    const upstreamError = new ServerImageError({
      code: 'DESTINATION_BLOCKED', message: 'Safe destination rejection', retryable: false,
    });
    const fake = createFakeSafeFetch([upstreamError]);
    await assert.rejects(
      openRouterImagesAdapter.generate(makeContext(fake), route, { ...request, references: [] }),
      error => error === upstreamError,
    );
    assert.equal(fake.calls.length, 1);
  });
});
