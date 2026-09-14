import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildOpenAIBase,
  buildOpenAIEditUrl,
  buildOpenAIGenerateUrl,
  buildOpenAIModelsUrl,
} from '../server-plugin/src/adapters/common.js';
import { openAIImagesAdapter } from '../server-plugin/src/adapters/openai-images.js';
import { ServerImageError } from '../server-plugin/src/errors.js';
import { safeRequest } from '../server-plugin/src/network/safe-fetch.js';
import { createFakeSafeFetch } from './server-plugin/fake-safe-fetch.js';
import {
  malformedOpenAIModelsFixture,
  openAIModelsFixture,
} from './server-plugin/fixtures-openai.js';

const NOW = '2026-07-27T12:00:00.000Z';

function makeContext(fake, overrides = {}) {
  return {
    endpoint: 'https://api.example.com',
    secret: 'sk-test-secret',
    safeRequest: fake.safeRequest,
    now: () => new Date(NOW),
    ...overrides,
  };
}

function transportResponse(body) {
  const bytes = Buffer.from(JSON.stringify(body));
  return {
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    },
  };
}

function parseMultipart(body, contentType) {
  const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1];
  assert.ok(boundary, 'multipart Content-Type must include a boundary');
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = body.indexOf(delimiter);
  while (cursor !== -1) {
    cursor += delimiter.length;
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) break;
    assert.equal(body.subarray(cursor, cursor + 2).toString(), '\r\n');
    const headerStart = cursor + 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    assert.notEqual(headerEnd, -1);
    const next = body.indexOf(delimiter, headerEnd + 4);
    assert.notEqual(next, -1);
    parts.push({
      headers: body.subarray(headerStart, headerEnd).toString('utf8'),
      value: body.subarray(headerEnd + 4, next - 2),
    });
    cursor = next;
  }
  return parts;
}

describe('OpenAI endpoint builders', () => {
  it('appends v1 only to a bare HTTPS origin', () => {
    assert.equal(buildOpenAIBase('https://api.example.com'), 'https://api.example.com/v1');
    assert.equal(buildOpenAIBase('https://api.example.com/'), 'https://api.example.com/v1');
  });

  it('preserves existing root and custom v1 paths without duplication', () => {
    assert.equal(buildOpenAIBase('https://api.example.com/v1'), 'https://api.example.com/v1');
    assert.equal(buildOpenAIBase('https://api.example.com/custom/v1'), 'https://api.example.com/custom/v1');
  });

  it('builds exact catalog, generation, and edit URLs', () => {
    const endpoint = 'https://api.example.com/custom/v1';
    assert.equal(buildOpenAIModelsUrl(endpoint), 'https://api.example.com/custom/v1/models');
    assert.equal(buildOpenAIGenerateUrl(endpoint), 'https://api.example.com/custom/v1/images/generations');
    assert.equal(buildOpenAIEditUrl(endpoint), 'https://api.example.com/custom/v1/images/edits');
  });
});

describe('OpenAI Images probe', () => {
  it('GETs only the models catalog with Bearer authentication', async () => {
    const fake = createFakeSafeFetch([{ status: 200, body: openAIModelsFixture }]);
    const result = await openAIImagesAdapter.probe(makeContext(fake));

    assert.equal(result.status, 'ok');
    assert.equal(result.manualEntryAllowed, true);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, 'https://api.example.com/v1/models');
    assert.equal(fake.calls[0].method, 'GET');
    assert.equal(fake.calls[0].headers.authorization, 'Bearer sk-test-secret');
    assert.doesNotMatch(fake.calls[0].url, /images\/(?:generations|edits)|chat\/completions|responses/);
  });

  it('normalizes image routes with stable IDs, conservative capabilities, and bounded metadata', async () => {
    const fixture = structuredClone(openAIModelsFixture);
    fixture.data[0].description = 'x'.repeat(2_000);
    fixture.data[0].unsafe = { nested: { token: 'do-not-copy-arbitrary-data' } };
    const fake = createFakeSafeFetch([{ status: 200, body: fixture }]);

    const first = await openAIImagesAdapter.probe(makeContext(fake));
    const secondFake = createFakeSafeFetch([{ status: 200, body: { data: [...fixture.data].reverse() } }]);
    const second = await openAIImagesAdapter.probe(makeContext(secondFake));

    assert.equal(first.status, 'ok');
    assert.deepEqual(first.routes.map(route => route.modelId), ['gpt-image-1', 'dall-e-3']);
    const explicit = first.routes[0];
    assert.deepEqual(Object.keys(explicit), [
      'id', 'modelId', 'label', 'apiFamily', 'source', 'confidence',
      'capabilities', 'remoteMetadata', 'fetchedAt',
    ]);
    assert.equal(explicit.apiFamily, 'openai-images');
    assert.equal(explicit.source, 'openai-models');
    assert.equal(explicit.confidence, 'high');
    assert.equal(explicit.capabilities.generate, 'supported');
    assert.equal(explicit.capabilities.references, 'supported');
    assert.equal(explicit.capabilities.maxReferences, 4);
    assert.equal(explicit.fetchedAt, NOW);
    assert.ok(JSON.stringify(explicit.remoteMetadata).length <= 1_024);
    assert.equal(JSON.stringify(explicit.remoteMetadata).includes('do-not-copy-arbitrary-data'), false);
    assert.equal(second.routes.find(route => route.modelId === explicit.modelId).id, explicit.id);

    const hinted = first.routes[1];
    assert.equal(hinted.confidence, 'medium');
    assert.equal(hinted.capabilities.generate, 'supported');
    assert.equal(hinted.capabilities.references, 'unknown');
    assert.equal(hinted.capabilities.maxReferences, null);
    assert.equal(first.routes.some(route => route.modelId === 'text-model-with-image-in-its-name'), false);
    assert.equal(first.routes.some(route => route.modelId === 'gpt-4.1'), false);
  });

  it('rejects overlong model IDs instead of collapsing distinct identities', async () => {
    const prefix = `gpt-image-${'x'.repeat(491)}`;
    const fake = createFakeSafeFetch([{ status: 200, body: {
      data: [
        { id: `${prefix}a`, capabilities: { image_generation: true } },
        { id: `${prefix}b`, capabilities: { image_generation: true } },
      ],
    } }]);

    const result = await openAIImagesAdapter.probe(makeContext(fake));

    assert.equal(result.status, 'ok');
    assert.deepEqual(result.routes, []);
  });

  it('disposes an unread non-2xx safe response before returning', async () => {
    let destroyed = 0;
    const realSafeRequest = options => safeRequest({
      ...options,
      resolver: async () => ['8.8.8.8'],
      transport: async () => ({
        status: 503,
        statusText: 'Service Unavailable',
        headers: new Headers(),
        body: {
          destroy() { destroyed += 1; },
          async *[Symbol.asyncIterator]() { yield Buffer.from('upstream diagnostic'); },
        },
      }),
    });

    const result = await openAIImagesAdapter.probe(makeContext({ safeRequest: realSafeRequest }));

    assert.equal(result.status, 'unavailable');
    assert.equal(destroyed, 1);
  });

  it('returns an unauthorized status for authentication rejection', async () => {
    const fake = createFakeSafeFetch([{ status: 401, body: { error: { message: 'bad key' } } }]);
    assert.deepEqual(await openAIImagesAdapter.probe(makeContext(fake)), {
      status: 'unauthorized', routes: [], warnings: [], manualEntryAllowed: true,
    });
  });

  it('returns an unavailable status for transport and upstream failures', async () => {
    const transport = createFakeSafeFetch([new ServerImageError({
      code: 'OUTBOUND_REQUEST_FAILED', message: 'Outbound request failed', retryable: true,
    })]);
    assert.deepEqual(await openAIImagesAdapter.probe(makeContext(transport)), {
      status: 'unavailable', routes: [],
      warnings: ['OpenAI models catalog is unavailable (OUTBOUND_REQUEST_FAILED: Outbound request failed).'],
      manualEntryAllowed: true,
    });

    const upstream = createFakeSafeFetch([{ status: 503, body: 'secret upstream text' }]);
    assert.deepEqual(await openAIImagesAdapter.probe(makeContext(upstream)), {
      status: 'unavailable', routes: [], warnings: ['OpenAI models catalog returned HTTP 503.'], manualEntryAllowed: true,
    });
  });

  it('returns malformed for invalid JSON or an invalid catalog shape', async () => {
    const invalidJson = createFakeSafeFetch([{ status: 200, body: '{not json' }]);
    assert.deepEqual(await openAIImagesAdapter.probe(makeContext(invalidJson)), {
      status: 'malformed', routes: [], warnings: ['OpenAI models catalog returned malformed JSON.'], manualEntryAllowed: true,
    });

    const invalidShape = createFakeSafeFetch([{ status: 200, body: malformedOpenAIModelsFixture }]);
    assert.deepEqual(await openAIImagesAdapter.probe(makeContext(invalidShape)), {
      status: 'malformed', routes: [], warnings: ['OpenAI models catalog has an invalid shape.'], manualEntryAllowed: true,
    });
  });

  it('never uses forbidden paid or text endpoints on any probe outcome', async () => {
    for (const response of [
      { status: 200, body: openAIModelsFixture },
      { status: 401, body: {} },
      { status: 500, body: {} },
    ]) {
      const fake = createFakeSafeFetch([response]);
      await openAIImagesAdapter.probe(makeContext(fake));
      assert.equal(fake.calls.length, 1);
      assert.doesNotMatch(fake.calls[0].url, /images\/(?:generations|edits)|chat\/completions|responses/);
    }
  });

});

describe('OpenAI Images generation', () => {
  const route = { modelId: 'gpt-image-1' };
  const request = {
    prompt: 'A lighthouse in a storm',
    aspectRatio: '3:2',
    imageSize: '2K',
    quality: 'high',
    references: [],
  };

  it('POSTs one exact JSON generation request and forwards dispatch controls', async () => {
    const fake = createFakeSafeFetch([{ status: 200, body: { data: [{ b64_json: 'YWJj' }] } }]);
    const signal = AbortSignal.abort();
    const beforeDispatch = () => {};

    const result = await openAIImagesAdapter.generate(
      makeContext(fake, { signal, timeoutMs: 12_345, beforeDispatch }),
      route,
      request,
    );

    assert.deepEqual(result, { kind: 'base64', value: 'YWJj', mimeType: 'image/png', warnings: [] });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, 'https://api.example.com/v1/images/generations');
    assert.equal(fake.calls[0].method, 'POST');
    assert.equal(fake.calls[0].headers.authorization, 'Bearer sk-test-secret');
    assert.equal(fake.calls[0].headers['content-type'], 'application/json');
    assert.equal(fake.calls[0].signal, signal);
    assert.equal(fake.calls[0].timeoutMs, 12_345);
    assert.equal(fake.calls[0].beforeDispatch, beforeDispatch);
    const body = JSON.parse(fake.calls[0].body);
    assert.deepEqual(body, {
      model: 'gpt-image-1',
      prompt: 'A lighthouse in a storm',
      n: 1,
      size: '1536x1024',
      quality: 'high',
    });
    assert.equal('response_format' in body, false);
    assert.equal('output_format' in body, false);
    assert.doesNotMatch(fake.calls[0].url, /chat\/completions|responses/);
  });

  it('maps canonical portrait and landscape ratios to supported OpenAI sizes', async () => {
    for (const [aspectRatio, size] of [['9:16', '1024x1536'], ['16:9', '1536x1024']]) {
      const fake = createFakeSafeFetch([{ status: 200, body: { data: [{ b64_json: 'eA==' }] } }]);
      await openAIImagesAdapter.generate(makeContext(fake), route, { ...request, aspectRatio });
      assert.equal(JSON.parse(fake.calls[0].body).size, size);
    }
  });

  it('omits invalid or undefined optional generation fields', async () => {
    const fake = createFakeSafeFetch([{ status: 200, body: { data: [{ url: 'https://cdn.example/result.png' }] } }]);

    await openAIImagesAdapter.generate(makeContext(fake), route, {
      prompt: 'Minimal request', aspectRatio: '21:9', imageSize: undefined, quality: 'ultra', references: [],
    });

    assert.deepEqual(JSON.parse(fake.calls[0].body), {
      model: 'gpt-image-1', prompt: 'Minimal request', n: 1,
    });
  });

  it('POSTs bounded multipart bytes with repeated image fields and preserved MIME for edits', async () => {
    const fake = createFakeSafeFetch([{ status: 200, body: { data: [{ b64_json: 'ZWRpdA==' }] } }]);
    const references = [
      { dataUrl: 'data:image/webp;base64,UklGRg==' },
      { dataUrl: 'data:image/jpeg;base64,/9j/2Q==' },
    ];

    await openAIImagesAdapter.generate(makeContext(fake), route, { ...request, references });

    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    assert.equal(call.url, 'https://api.example.com/v1/images/edits');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, 'Bearer sk-test-secret');
    assert.match(call.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.ok(Buffer.isBuffer(call.body));
    const parts = parseMultipart(call.body, call.headers['content-type']);
    assert.deepEqual(parts.map(part => /name="([^"]+)"/.exec(part.headers)?.[1]), [
      'model', 'prompt', 'n', 'size', 'quality', 'input_fidelity', 'image', 'image',
    ]);
    assert.deepEqual(parts.slice(0, 6).map(part => part.value.toString()), [
      'gpt-image-1', request.prompt, '1', '1536x1024', 'high', 'high',
    ]);
    const images = parts.slice(6);
    assert.equal(images.length, 2);
    assert.match(images[0].headers, /Content-Type: image\/webp/i);
    assert.match(images[1].headers, /Content-Type: image\/jpeg/i);
    assert.deepEqual(images[0].value, Buffer.from('RIFF'));
    assert.deepEqual(images[1].value, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });

  it('omits input_fidelity and invalid edit options for unallowlisted models', async () => {
    const fake = createFakeSafeFetch([{ status: 200, body: { data: [{ b64_json: 'eA==' }] } }]);

    await openAIImagesAdapter.generate(makeContext(fake), { modelId: 'gpt-image-custom' }, {
      prompt: 'Edit', aspectRatio: 'invalid', quality: 'hd', references: [{ dataUrl: 'data:image/png;base64,eA==' }],
    });

    const call = fake.calls[0];
    const parts = parseMultipart(call.body, call.headers['content-type']);
    assert.deepEqual(parts.map(part => /name="([^"]+)"/.exec(part.headers)?.[1]), ['model', 'prompt', 'n', 'image']);
  });

  it('dispatches an edit exactly once through real safeRequest', async () => {
    const calls = [];
    const realSafeRequest = options => safeRequest({
      ...options,
      resolver: async () => ['8.8.8.8'],
      transport: async (url, init) => {
        calls.push({ url: String(url), init });
        return transportResponse({ data: [{ b64_json: 'ZWRpdA==' }] });
      },
    });

    const result = await openAIImagesAdapter.generate(
      makeContext({ safeRequest: realSafeRequest }),
      route,
      { ...request, references: [{ dataUrl: 'data:image/png;base64,UklGRg==' }] },
    );

    assert.equal(result.value, 'ZWRpdA==');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.example.com/v1/images/edits');
    assert.ok(Buffer.isBuffer(calls[0].init.body));
    assert.match(calls[0].init.headers.get('content-type'), /^multipart\/form-data; boundary=/);
  });

  it('rejects oversized edit multipart before real safeRequest transport without leaking reference bytes', async () => {
    const referenceBytes = Buffer.from('PRIVATE_REFERENCE_BYTES');
    let calls = 0;
    const realSafeRequest = options => safeRequest({
      ...options,
      maxRequestBytes: 128,
      resolver: async () => ['8.8.8.8'],
      transport: async () => {
        calls += 1;
        return transportResponse({ data: [{ b64_json: 'eA==' }] });
      },
    });

    await assert.rejects(
      openAIImagesAdapter.generate(makeContext({ safeRequest: realSafeRequest }), route, {
        ...request,
        references: [{ dataUrl: `data:image/png;base64,${referenceBytes.toString('base64')}` }],
      }),
      error => {
        assert.ok(error instanceof ServerImageError);
        assert.equal(error.code, 'REQUEST_TOO_LARGE');
        assert.equal(error.message.includes(referenceBytes.toString()), false);
        assert.equal(error.message.includes(referenceBytes.toString('base64')), false);
        return true;
      },
    );
    assert.equal(calls, 0);
  });

  it('rejects invalid references without dispatching or silently dropping extras', async () => {
    for (const references of [
      [{ dataUrl: 'https://example.com/not-data.png' }],
      [{ dataUrl: 'data:text/plain;base64,eA==' }],
      [{ dataUrl: 'data:image/svg+xml;base64,eA==' }],
      [{ dataUrl: 'data:image/png;base64,not base64!' }],
      [{ dataUrl: 'data:image/png;base64,' }],
    ]) {
      const fake = createFakeSafeFetch([]);
      await assert.rejects(
        openAIImagesAdapter.generate(makeContext(fake), route, { ...request, references }),
        error => error instanceof ServerImageError && error.code === 'INVALID_REFERENCE',
      );
      assert.equal(fake.calls.length, 0);
    }

    const many = Array.from({ length: 17 }, () => ({ dataUrl: 'data:image/png;base64,eA==' }));
    const fake = createFakeSafeFetch([]);
    await assert.rejects(
      openAIImagesAdapter.generate(makeContext(fake), route, { ...request, references: many }),
      error => error instanceof ServerImageError && error.code === 'TOO_MANY_REFERENCES',
    );
    assert.equal(fake.calls.length, 0);
  });

  it('parses base64, URL, raw image bytes, and compatibility top-level URL responses', async () => {
    const cases = [
      {
        response: { status: 200, body: { data: [{ b64_json: 'YWJj' }] } },
        expected: { kind: 'base64', value: 'YWJj', mimeType: 'image/png', warnings: [] },
      },
      {
        response: { status: 200, body: { data: [{ url: 'https://cdn.example/image.png' }] } },
        expected: { kind: 'url', value: 'https://cdn.example/image.png', mimeType: null, warnings: [] },
      },
      {
        response: { status: 200, body: 'raw-image', headers: { 'content-type': 'image/webp' } },
        expected: { kind: 'bytes', value: Buffer.from('raw-image'), mimeType: 'image/webp', warnings: [] },
      },
      {
        response: { status: 200, body: { url: 'https://proxy.example/image.png' } },
        expected: {
          kind: 'url', value: 'https://proxy.example/image.png', mimeType: null,
          warnings: ['OpenAI Images returned a compatibility top-level URL.'],
        },
      },
    ];

    for (const { response, expected } of cases) {
      const fake = createFakeSafeFetch([response]);
      const result = await openAIImagesAdapter.generate(makeContext(fake), route, request);
      if (expected.kind === 'bytes') {
        assert.equal(result.kind, 'bytes');
        assert.deepEqual(Buffer.from(result.value), expected.value);
        assert.equal(result.mimeType, expected.mimeType);
        assert.deepEqual(result.warnings, []);
      } else {
        assert.deepEqual(result, expected);
      }
      assert.equal(fake.calls.length, 1);
    }
  });

  it('sniffs JPEG MIME from b64_json magic bytes when no content_type is declared', async () => {
    const jpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');
    const fake = createFakeSafeFetch([{ status: 200, body: { data: [{ b64_json: jpegB64 }] } }]);
    const result = await openAIImagesAdapter.generate(makeContext(fake), route, request);
    assert.equal(result.kind, 'base64');
    assert.equal(result.value, jpegB64);
    assert.equal(result.mimeType, 'image/jpeg');
  });

  it('rejects malformed 2xx and preserves safe non-2xx errors', async () => {
    for (const response of [
      { status: 200, body: {} },
      { status: 200, body: { data: [] } },
      { status: 200, body: '{not json' },
      { status: 200, body: '', headers: { 'content-type': 'image/png' } },
    ]) {
      const fake = createFakeSafeFetch([response]);
      await assert.rejects(
        openAIImagesAdapter.generate(makeContext(fake), route, request),
        error => error instanceof ServerImageError && error.code === 'UPSTREAM_RESPONSE_INVALID' && error.retryable === false,
      );
      assert.equal(fake.calls.length, 1);
    }

    const upstreamError = new ServerImageError({
      code: 'UPSTREAM_HTTP_ERROR', message: 'Safe upstream failure', retryable: true,
    });
    const fake = createFakeSafeFetch([upstreamError]);
    await assert.rejects(openAIImagesAdapter.generate(makeContext(fake), route, request), error => error === upstreamError);
    assert.equal(fake.calls.length, 1);
  });
});
