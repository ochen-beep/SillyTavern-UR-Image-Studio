import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildGeminiCandidates,
  geminiNativeAdapter,
} from '../server-plugin/src/adapters/gemini-native.js';
import { ServerImageError } from '../server-plugin/src/errors.js';
import { createFakeSafeFetch } from './server-plugin/fake-safe-fetch.js';
import {
  geminiModelsFixture,
  openAiGeminiModelsFixture,
  malformedGeminiModelsFixture,
} from './server-plugin/fixtures-gemini.js';

const NOW = '2026-07-27T12:00:00.000Z';

function makeContext(fake, overrides = {}) {
  return {
    endpoint: 'https://api.example.com',
    secret: 'gemini-test-secret',
    safeRequest: fake.safeRequest,
    now: () => new Date(NOW),
    ...overrides,
  };
}

describe('Gemini Native endpoint candidates', () => {
  it('tries v1 then v1beta for a bare origin', () => {
    assert.deepEqual(buildGeminiCandidates('https://api.example.com'), [
      { baseUrl: 'https://api.example.com/v1', geminiApiVersion: 'v1' },
      { baseUrl: 'https://api.example.com/v1beta', geminiApiVersion: 'v1beta' },
    ]);
    assert.deepEqual(buildGeminiCandidates('https://api.example.com/'), [
      { baseUrl: 'https://api.example.com/v1', geminiApiVersion: 'v1' },
      { baseUrl: 'https://api.example.com/v1beta', geminiApiVersion: 'v1beta' },
    ]);
  });

  it('tries supplied versions first without duplication', () => {
    assert.deepEqual(buildGeminiCandidates('https://api.example.com/v1'), [
      { baseUrl: 'https://api.example.com/v1', geminiApiVersion: 'v1' },
      { baseUrl: 'https://api.example.com/v1beta', geminiApiVersion: 'v1beta' },
    ]);
    assert.deepEqual(buildGeminiCandidates('https://api.example.com/v1beta/'), [
      { baseUrl: 'https://api.example.com/v1beta', geminiApiVersion: 'v1beta' },
      { baseUrl: 'https://api.example.com/v1', geminiApiVersion: 'v1' },
    ]);
  });

  it('preserves custom gateway subpaths', () => {
    assert.deepEqual(buildGeminiCandidates('https://gateway.example.com/google/gemini'), [
      { baseUrl: 'https://gateway.example.com/google/gemini/v1', geminiApiVersion: 'v1' },
      { baseUrl: 'https://gateway.example.com/google/gemini/v1beta', geminiApiVersion: 'v1beta' },
    ]);
    assert.deepEqual(buildGeminiCandidates('https://gateway.example.com/google/v1beta'), [
      { baseUrl: 'https://gateway.example.com/google/v1beta', geminiApiVersion: 'v1beta' },
      { baseUrl: 'https://gateway.example.com/google/v1', geminiApiVersion: 'v1' },
    ]);
  });
});

describe('Gemini Native probe', () => {
  it('uses x-goog-api-key for native Google endpoints and falls back by version', async () => {
    const fake = createFakeSafeFetch([
      { status: 404, body: {} },
      { status: 200, body: geminiModelsFixture },
    ]);
    const result = await geminiNativeAdapter.probe(makeContext(fake, {
      endpoint: 'https://generativelanguage.googleapis.com',
    }));

    assert.equal(result.status, 'ok');
    assert.deepEqual(fake.calls.map(call => call.url), [
      'https://generativelanguage.googleapis.com/v1/models',
      'https://generativelanguage.googleapis.com/v1beta/models',
    ]);
    for (const call of fake.calls) {
      assert.equal(call.method, 'GET');
      assert.equal(call.headers['x-goog-api-key'], 'gemini-test-secret');
      assert.equal('authorization' in call.headers, false);
    }
    assert.equal(result.routes[0].remoteMetadata.geminiApiVersion, 'v1beta');
  });

  it('uses Bearer auth and parses OpenAI-format Gemini catalogs on proxy endpoints', async () => {
    const fake = createFakeSafeFetch([{ status: 200, body: openAiGeminiModelsFixture }]);
    const result = await geminiNativeAdapter.probe(makeContext(fake, {
      endpoint: 'https://relay.example/v1',
    }));

    assert.equal(result.status, 'ok');
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, 'https://relay.example/v1/models');
    assert.equal(fake.calls[0].headers.authorization, 'Bearer gemini-test-secret');
    assert.deepEqual(result.routes.map(route => route.modelId), [
      'gemini-2.5-flash-image',
      'gemini-3-pro-image',
      'gemini-3.1-flash-image-preview',
    ]);
    assert.ok(result.routes.every(route => route.remoteMetadata.authStrategy === 'bearer'));
  });

  it('uses query key only on api.relay.example after Bearer and header authentication rejection', async () => {
    const fake = createFakeSafeFetch([
      { status: 401, body: {} },
      { status: 401, body: {} },
      { status: 200, body: geminiModelsFixture },
    ]);
    const result = await geminiNativeAdapter.probe(makeContext(fake, {
      endpoint: 'https://api.relay.example/v1beta',
    }));

    assert.equal(result.status, 'ok');
    assert.equal(fake.calls.length, 3);
    assert.equal(fake.calls[0].url, 'https://api.relay.example/v1beta/models');
    assert.equal(fake.calls[0].headers.authorization, 'Bearer gemini-test-secret');
    assert.equal(fake.calls[1].headers['x-goog-api-key'], 'gemini-test-secret');
    assert.equal(fake.calls[2].url, 'https://api.relay.example/v1beta/models?key=gemini-test-secret');
    assert.equal('x-goog-api-key' in fake.calls[2].headers, false);
    assert.equal('authorization' in fake.calls[2].headers, false);
    assert.ok(result.routes.every(route => route.remoteMetadata.authStrategy === 'query-key'));
  });

  it('tries each configured auth strategy on Relay non-auth failures without leaking credentials cross-host', async () => {
    const fake = createFakeSafeFetch([
      { status: 404, body: {} }, { status: 404, body: {} }, { status: 404, body: {} },
      { status: 404, body: {} }, { status: 404, body: {} }, { status: 404, body: {} },
    ]);
    const result = await geminiNativeAdapter.probe(makeContext(fake, {
      endpoint: 'https://api.relay.example',
    }));

    assert.equal(result.status, 'unavailable');
    assert.equal(fake.calls.length, 6);
    const queryCalls = fake.calls.filter(call => new URL(call.url).searchParams.has('key'));
    assert.equal(queryCalls.length, 2);
    assert.ok(queryCalls.every(call => new URL(call.url).hostname === 'api.relay.example'));
  });

  it('returns unauthorized when all Relay auth strategies fail or reject', async () => {
    const fake = createFakeSafeFetch([
      { status: 401, body: {} },
      new ServerImageError({ code: 'OUTBOUND_REQUEST_FAILED', message: 'failed' }),
      { status: 503, body: {} },
      { status: 401, body: {} },
      { status: 401, body: {} },
      { status: 401, body: {} },
    ]);

    const result = await geminiNativeAdapter.probe(makeContext(fake, {
      endpoint: 'https://api.relay.example/v1beta',
    }));

    assert.deepEqual(result, {
      status: 'unauthorized', routes: [], warnings: [], manualEntryAllowed: true,
    });
    assert.equal(fake.calls.length, 6);
  });

  it('uses Bearer on custom proxies but never leaks the key through query auth', async () => {
    const fake = createFakeSafeFetch([
      { status: 401, body: {} },
      { status: 403, body: {} },
      { status: 401, body: {} },
      { status: 403, body: {} },
    ]);
    const result = await geminiNativeAdapter.probe(makeContext(fake));

    assert.deepEqual(result, {
      status: 'unauthorized', routes: [], warnings: [], manualEntryAllowed: true,
    });
    assert.equal(fake.calls.length, 4);
    assert.equal(fake.calls[0].headers.authorization, 'Bearer gemini-test-secret');
    assert.equal(fake.calls[2].headers.authorization, 'Bearer gemini-test-secret');
    assert.ok(fake.calls.every(call => !new URL(call.url).searchParams.has('key')));
  });

  it('requires the exact Relay host rather than a suffix lookalike', async () => {
    const fake = createFakeSafeFetch([
      { status: 401, body: {} },
      { status: 401, body: {} },
    ]);
    await geminiNativeAdapter.probe(makeContext(fake, { endpoint: 'https://api.relay.example.attacker.example' }));
    assert.ok(fake.calls.every(call => !new URL(call.url).searchParams.has('key')));
  });

  it('normalizes conservative image routes with stable IDs and bounded metadata', async () => {
    const fixture = structuredClone(geminiModelsFixture);
    fixture.models[0].description = 'x'.repeat(2_000);
    fixture.models[0].unsafe = { nested: { secret: 'do-not-copy' } };
    const fake = createFakeSafeFetch([{ status: 200, body: fixture }]);
    const first = await geminiNativeAdapter.probe(makeContext(fake));
    const secondFake = createFakeSafeFetch([{ status: 200, body: { models: [...fixture.models].reverse() } }]);
    const second = await geminiNativeAdapter.probe(makeContext(secondFake));

    assert.deepEqual(first.routes.map(route => route.modelId), [
      'gemini-2.5-flash-image',
      'gemini-3.1-flash-image-preview',
      'publishers/example/models/gemini-image-custom',
    ]);
    const route = first.routes[0];
    assert.deepEqual(Object.keys(route), [
      'id', 'modelId', 'label', 'apiFamily', 'source', 'confidence',
      'capabilities', 'remoteMetadata', 'fetchedAt',
    ]);
    assert.equal(route.label, 'Gemini 2.5 Flash Image');
    assert.equal(route.apiFamily, 'gemini-native');
    assert.equal(route.source, 'gemini-models');
    assert.equal(route.confidence, 'medium');
    assert.deepEqual(route.capabilities, {
      generate: 'supported', references: 'unknown', maxReferences: null,
      aspectRatios: null, imageSizes: null, qualityValues: null,
    });
    assert.equal(route.remoteMetadata.geminiApiVersion, 'v1');
    assert.equal(route.remoteMetadata.authStrategy, 'bearer');
    assert.equal(route.remoteMetadata.versionedBase, 'https://api.example.com/v1');
    assert.ok(JSON.stringify(route.remoteMetadata).length <= 1_024);
    assert.equal(JSON.stringify(route.remoteMetadata).includes('do-not-copy'), false);
    assert.equal(second.routes.find(item => item.modelId === route.modelId).id, route.id);
    assert.equal(first.routes.some(item => item.modelId === 'gemini-2.5-pro'), false);
    assert.equal(first.routes.some(item => item.modelId === 'publishers/example/models/gemini-image-custom'), true);
    assert.equal(first.routes.some(item => item.modelId === 'gemini-image-embedding'), false);
    assert.equal(first.manualEntryAllowed, true);
  });

  it('follows bounded pagination and retains prior routes after a later-page failure', async () => {
    const fake = createFakeSafeFetch([
      { status: 200, body: {
        models: [geminiModelsFixture.models[0]],
        nextPageToken: 'page two/+',
      } },
      { status: 200, body: {
        models: [geminiModelsFixture.models[1]],
        nextPageToken: 'page-three',
      } },
      { status: 503, body: 'private upstream response' },
    ]);
    const result = await geminiNativeAdapter.probe(makeContext(fake));

    assert.equal(result.status, 'ok');
    assert.deepEqual(result.routes.map(route => route.modelId), [
      'gemini-2.5-flash-image', 'gemini-3.1-flash-image-preview',
    ]);
    assert.deepEqual(result.warnings, ['Gemini models catalog pagination stopped after a later page failed.']);
    assert.equal(fake.calls[1].url, 'https://api.example.com/v1/models?pageToken=page+two%2F%2B');
    assert.equal(fake.calls[2].url, 'https://api.example.com/v1/models?pageToken=page-three');
  });

  it('bounds pagination when the upstream repeats tokens forever', async () => {
    const fake = createFakeSafeFetch(Array.from({ length: 5 }, () => ({
      status: 200,
      body: { models: [], nextPageToken: 'repeat-token' },
    })));
    const result = await geminiNativeAdapter.probe(makeContext(fake));
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(result.warnings, [
      'Gemini models catalog pagination stopped at its safety limit.',
      'Gemini models catalog contained no image models.',
    ]);
  });

  it('returns structured unauthorized, unavailable, malformed, and no-model results', async () => {
    const unauthorizedMixed = createFakeSafeFetch([
      { status: 401, body: {} },
      { status: 404, body: {} },
    ]);
    assert.deepEqual(await geminiNativeAdapter.probe(makeContext(unauthorizedMixed)), {
      status: 'unauthorized', routes: [], warnings: [], manualEntryAllowed: true,
    });

    const unavailable = createFakeSafeFetch([
      new ServerImageError({ code: 'OUTBOUND_REQUEST_FAILED', message: 'failed' }),
      { status: 503, body: {} },
    ]);
    assert.deepEqual(await geminiNativeAdapter.probe(makeContext(unavailable)), {
      status: 'unavailable', routes: [],
      warnings: ['Gemini models catalog is unavailable (Error: Unexpected safeRequest call).'],
      manualEntryAllowed: true,
    });

    for (const body of ['{not json', malformedGeminiModelsFixture]) {
      const fake = createFakeSafeFetch([{ status: 200, body }]);
      const result = await geminiNativeAdapter.probe(makeContext(fake));
      assert.equal(result.status, 'malformed');
      assert.deepEqual(result.routes, []);
      assert.equal(result.manualEntryAllowed, true);
      assert.equal(result.warnings.length, 1);
    }

    const noModels = createFakeSafeFetch([{ status: 200, body: { models: [] } }]);
    assert.deepEqual(await geminiNativeAdapter.probe(makeContext(noModels)), {
      status: 'ok', routes: [], warnings: ['Gemini models catalog contained no image models.'], manualEntryAllowed: true,
    });
  });

});

describe('Gemini Native generation', () => {
  const route = {
    modelId: 'publishers/example/models/gemini image/custom',
    capabilities: { references: 'unknown' },
    remoteMetadata: {
      geminiApiVersion: 'v1beta',
      authStrategy: 'x-goog-api-key',
      versionedBase: 'https://gateway.example.com/google/v1beta',
    },
  };
  const request = {
    prompt: 'Restyle both references as a poster',
    aspectRatio: '16:9',
    imageSize: '2K',
    quality: 'high',
    references: [
      { dataUrl: 'data:IMAGE/WebP;base64,UklGRg==' },
      { dataUrl: 'data:image/jpeg;base64,/9j/2Q==' },
    ],
  };

  it('POSTs bearer auth for persisted proxy routes', async () => {
    const fake = createFakeSafeFetch([{ status: 200, body: {
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'cmVzdWx0' } }] } }],
    } }]);
    const bearerRoute = {
      ...route,
      remoteMetadata: {
        ...route.remoteMetadata,
        authStrategy: 'bearer',
        geminiApiVersion: 'v1',
        versionedBase: 'https://relay.example/v1',
      },
    };
    await geminiNativeAdapter.generate(makeContext(fake), bearerRoute, { ...request, references: [] });
    assert.equal(fake.calls[0].headers.authorization, 'Bearer gemini-test-secret');
    assert.equal('x-goog-api-key' in fake.calls[0].headers, false);
  });
  it('POSTs ordered references and supported config to the persisted route', async () => {
    const fake = createFakeSafeFetch([{ status: 200, body: {
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'cmVzdWx0' } }] } }],
    } }]);
    const signal = AbortSignal.abort();
    const beforeDispatch = () => {};

    const result = await geminiNativeAdapter.generate(
      makeContext(fake, { signal, timeoutMs: 12_345, beforeDispatch }), route, request,
    );

    assert.deepEqual(result, { kind: 'base64', value: 'cmVzdWx0', mimeType: 'image/png', warnings: [] });
    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    assert.equal(call.url, 'https://gateway.example.com/google/v1beta/models/publishers%2Fexample%2Fmodels%2Fgemini%20image%2Fcustom:generateContent');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['x-goog-api-key'], 'gemini-test-secret');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.equal('authorization' in call.headers, false);
    assert.equal(call.signal, signal);
    assert.equal(call.timeoutMs, 12_345);
    assert.equal(call.beforeDispatch, beforeDispatch);
    assert.deepEqual(JSON.parse(call.body), {
      contents: [{ parts: [
        { inlineData: { mimeType: 'IMAGE/WebP', data: 'UklGRg==' } },
        { inlineData: { mimeType: 'image/jpeg', data: '/9j/2Q==' } },
        { text: request.prompt },
      ] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
      },
    });
    assert.equal(JSON.stringify(JSON.parse(call.body)).includes('data:image/'), false);
    assert.equal(JSON.stringify(JSON.parse(call.body)).includes('quality'), false);
  });

  it('uses persisted query auth only for a Relay route and omits invalid config', async () => {
    const fake = createFakeSafeFetch([{ status: 200, body: {
      candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/webp', data: 'eA==' } }] } }],
    } }]);
    const queryRoute = {
      ...route,
      modelId: 'gemini-2.5-flash-image',
      remoteMetadata: {
        geminiApiVersion: 'v1',
        authStrategy: 'query-key',
        versionedBase: 'https://api.relay.example/v1',
      },
    };

    const result = await geminiNativeAdapter.generate(makeContext(fake), queryRoute, {
      prompt: 'Generate', aspectRatio: '', imageSize: '8K', quality: 'high', references: [],
    });

    assert.deepEqual(result, { kind: 'base64', value: 'eA==', mimeType: 'image/webp', warnings: [] });
    assert.equal(fake.calls[0].url, 'https://api.relay.example/v1/models/gemini-2.5-flash-image:generateContent?key=gemini-test-secret');
    assert.equal('x-goog-api-key' in fake.calls[0].headers, false);
    assert.deepEqual(JSON.parse(fake.calls[0].body).generationConfig, {
      responseModalities: ['TEXT', 'IMAGE'],
    });
  });

  it('does not guess routes or auth from malformed persisted metadata', async () => {
    for (const remoteMetadata of [
      { geminiApiVersion: 'v1', authStrategy: 'x-goog-api-key' },
      { geminiApiVersion: 'v2', authStrategy: 'x-goog-api-key', versionedBase: 'https://api.example.com/v2' },
      { geminiApiVersion: 'v1', authStrategy: 'unknown', versionedBase: 'https://api.example.com/v1' },
      { geminiApiVersion: 'v1', authStrategy: 'query-key', versionedBase: 'https://api.example.com/v1' },
    ]) {
      const fake = createFakeSafeFetch([]);
      await assert.rejects(
        geminiNativeAdapter.generate(makeContext(fake), { ...route, remoteMetadata }, { ...request, references: [] }),
        error => error instanceof ServerImageError && error.code === 'INVALID_ROUTE',
      );
      assert.equal(fake.calls.length, 0);
    }
  });

  it('parses camelCase and snake_case inline image responses', async () => {
    for (const [part, expected] of [
      [{ inlineData: { mimeType: 'image/jpeg', data: 'YWJj' } }, { mimeType: 'image/jpeg', value: 'YWJj' }],
      [{ inline_data: { mime_type: 'image/webp', data: 'ZGVm' } }, { mimeType: 'image/webp', value: 'ZGVm' }],
    ]) {
      const fake = createFakeSafeFetch([{ status: 200, body: {
        candidates: [{ content: { parts: [{ text: 'private response text' }, part] } }],
      } }]);
      const result = await geminiNativeAdapter.generate(makeContext(fake), route, { ...request, references: [] });
      assert.deepEqual(result, { kind: 'base64', value: expected.value, mimeType: expected.mimeType, warnings: [] });
      assert.equal(fake.calls.length, 1);
    }
  });

  it('rejects no-image responses with bounded redacted diagnostics', async () => {
    const privateText = 'PRIVATE_COMPLETE_MODEL_TEXT';
    const privateFeedback = 'PRIVATE_FEEDBACK_BYTES';
    const fake = createFakeSafeFetch([{ status: 200, body: {
      candidates: [{
        finishReason: `SAFETY_${'x'.repeat(500)}`,
        content: { parts: [{ text: privateText }] },
      }],
      promptFeedback: {
        blockReason: 'SAFETY',
        safetyRatings: [{ category: privateFeedback, probability: 'HIGH' }],
      },
    } }]);

    await assert.rejects(
      geminiNativeAdapter.generate(makeContext(fake), route, { ...request, references: [] }),
      error => {
        assert.ok(error instanceof ServerImageError);
        assert.equal(error.code, 'UPSTREAM_RESPONSE_INVALID');
        assert.equal(error.retryable, false);
        assert.match(error.message, /finishReason=SAFETY_/);
        assert.match(error.message, /promptFeedback=SAFETY/);
        assert.ok(error.message.length < 300);
        assert.equal(error.message.includes(privateText), false);
        assert.equal(error.message.includes(privateFeedback), false);
        assert.equal(error.message.includes(request.references[0].dataUrl), false);
        return true;
      },
    );
    assert.equal(fake.calls.length, 1);
  });

  it('rejects malformed references before dispatch', async () => {
    for (const references of [
      'not-an-array',
      [{ dataUrl: 'https://example.com/image.png' }],
      [{ dataUrl: 'data:text/plain;base64,eA==' }],
      [{ dataUrl: 'data:image/png;base64,not base64!' }],
      [{ dataUrl: 'data:image/png;base64,' }],
    ]) {
      const fake = createFakeSafeFetch([]);
      await assert.rejects(
        geminiNativeAdapter.generate(makeContext(fake), route, { ...request, references }),
        error => error instanceof ServerImageError && error.code === 'INVALID_REFERENCE',
      );
      assert.equal(fake.calls.length, 0);
    }
  });

  it('sends unknown references once and returns the selected route upstream rejection', async () => {
    const upstream = new ServerImageError({
      code: 'UPSTREAM_HTTP_ERROR', message: 'Gemini route rejected references', retryable: false,
    });
    const fake = createFakeSafeFetch([upstream]);

    await assert.rejects(
      geminiNativeAdapter.generate(makeContext(fake), route, request),
      error => error === upstream,
    );
    assert.equal(fake.calls.length, 1);
    assert.match(fake.calls[0].url, /:generateContent$/);
  });
});
