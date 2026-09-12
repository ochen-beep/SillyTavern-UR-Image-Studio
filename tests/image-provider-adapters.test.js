// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { invokeImageProvider } from '../src/image-provider-registry.js';

const PNG = 'data:image/png;base64,cG5n';
const JPEG = 'data:image/jpeg;base64,anBlZw==';

function route(generationContract, modelId, extra = {}) {
  return {
    contractVersion: 1,
    generationContract,
    modelId,
    transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
    ...extra,
  };
}

function makeTransport(response) {
  const calls = [];
  return {
    calls,
    requestJson: async (url, options, savedRoute, timeoutMs) => {
      calls.push({ kind: 'json', url, options, route: savedRoute, timeoutMs });
      return response;
    },
    requestMultipart: async (url, options, savedRoute, timeoutMs) => {
      calls.push({ kind: 'multipart', url, options, route: savedRoute, timeoutMs });
      return response;
    },
    downloadResult: async (url, options) => {
      calls.push({ kind: 'download', url, options });
      return response;
    },
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
}

test('openai-images sends JSON generations and normalizes URL results', async () => {
  const transport = makeTransport(jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
  const result = await invokeImageProvider({
    endpoint: 'https://api.example/v1', apiKey: 'secret',
    connection: { timeoutMs: 4100 },
    route: route('openai-images', 'gpt-image-1'),
    request: { prompt: 'A lighthouse', aspectRatio: '16:9', imageSize: '1K', quality: 'high', references: [] }, transport,
  });

  assert.deepEqual(result, { kind: 'url', value: 'https://cdn.example/result.png', mimeType: null, warnings: [] });
  assert.equal(transport.calls[0].kind, 'json');
  assert.equal(transport.calls[0].url, 'https://api.example/v1/images/generations');
  // No response_format: it is a DALL-E compatibility parameter that GPT Image
  // models reject outright ("Unknown parameter: 'response_format'"), and
  // sending it broke a provider that had previously returned HTTP 200.
  assert.deepEqual(JSON.parse(transport.calls[0].options.body), {
    model: 'gpt-image-1', prompt: 'A lighthouse', n: 1, size: '1536x1024', quality: 'high',
  });
  assert.equal(transport.calls[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(transport.calls[0].timeoutMs, 4100);
});

test('openai-images sends edits as JSON with images[].image_url data URLs when the connection opts in', async () => {
  const transport = makeTransport(jsonResponse({ data: [{ b64_json: 'cmVzdWx0' }] }));
  const result = await invokeImageProvider({
    endpoint: 'https://api.example', apiKey: 'secret',
    connection: { timeoutMs: 4200, editProtocol: 'json' },
    route: route('openai-images', 'gpt-image-1'),
    request: { prompt: 'Edit this', references: [{ dataUrl: PNG }, { dataUrl: JPEG }] }, transport,
  });

  assert.deepEqual(result, { kind: 'dataUrl', value: 'data:image/png;base64,cmVzdWx0', mimeType: 'image/png', warnings: [] });
  assert.equal(transport.calls[0].kind, 'json');
  assert.equal(transport.calls[0].url, 'https://api.example/v1/images/edits');
  assert.equal(transport.calls[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(transport.calls[0].options.headers['Content-Type'], 'application/json');
  // input_fidelity stays: unlike response_format, it is a documented GPT Image
  // edits parameter, and the model-name check gates only this parameter - never
  // the wire protocol, which comes from connection.editProtocol.
  assert.deepEqual(JSON.parse(transport.calls[0].options.body), {
    model: 'gpt-image-1', prompt: 'Edit this', n: 1,
    images: [{ image_url: PNG }, { image_url: JPEG }],
    input_fidelity: 'high',
  });
  assert.equal(transport.calls[0].timeoutMs, 4200);
});

test('openai-images sends edits as multipart with repeated image fields by default', async () => {
  const transport = makeTransport(jsonResponse({ data: [{ b64_json: 'cmVzdWx0' }] }));
  const result = await invokeImageProvider({
    endpoint: 'https://api.example', apiKey: 'secret',
    connection: { timeoutMs: 4200 },
    route: route('openai-images', 'dall-e-2'),
    request: { prompt: 'Edit this', references: [{ dataUrl: PNG }, { dataUrl: JPEG }] }, transport,
  });

  assert.deepEqual(result, { kind: 'dataUrl', value: 'data:image/png;base64,cmVzdWx0', mimeType: 'image/png', warnings: [] });
  assert.equal(transport.calls[0].kind, 'multipart');
  assert.equal(transport.calls[0].url, 'https://api.example/v1/images/edits');
  assert.equal(transport.calls[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(transport.calls[0].options.headers['Content-Type'], undefined);
  assert.equal(transport.calls[0].options.body.getAll('image').length, 2);
  assert.equal(transport.calls[0].timeoutMs, 4200);
});

test('openai-images multipart edit: reference filenames carry a proper extension', async () => {
  // Relay upstreams derive the expected file type from the multipart filename:
  // a bare "image" name fails with "Image edit file content does not match its
  // declared MIME type" even for perfectly valid bytes (novaproxy.space,
  // incident 2026-09-09: same jpeg bytes → 400 as "image", 200 as "ref.jpg").
  const transport = makeTransport(jsonResponse({ data: [{ b64_json: 'cmVzdWx0' }] }));
  await invokeImageProvider({
    endpoint: 'https://api.example', apiKey: 'secret',
    connection: { timeoutMs: 4200 },
    route: route('openai-images', 'dall-e-2'),
    request: { prompt: 'Edit this', references: [{ dataUrl: PNG }, { dataUrl: JPEG }] }, transport,
  });
  const files = transport.calls[0].options.body.getAll('image');
  assert.deepEqual(files.map(file => file.name), ['image_1.png', 'image_2.jpg']);
  assert.deepEqual(files.map(file => file.type), ['image/png', 'image/jpeg']);
});

test('openai-images sends input_fidelity for gpt-image-1 edits only', async () => {
  // gpt-image-1 (incl. namespaced) keeps the documented fidelity parameter...
  for (const modelId of ['gpt-image-1', 'openai/gpt-image-1']) {
    const transport = makeTransport(jsonResponse({ data: [{ b64_json: 'cmVzdWx0' }] }));
    await invokeImageProvider({
      endpoint: 'https://api.example', apiKey: 'secret', connection: {},
      route: route('openai-images', modelId),
      request: { prompt: 'Edit', references: [{ dataUrl: PNG }] }, transport,
    });
    assert.equal(transport.calls[0].options.body.get('input_fidelity'), 'high', modelId);
  }
  // ...but gpt-image-2 must not get it: elysiumai.garden rejects it with
  // HTTP 400 "The model 'gpt-image-2' does not support the 'input_fidelity'
  // parameter" (2026-08-06). Never send a parameter the model has not
  // documented - a lenient gateway accepting it proves nothing.
  for (const modelId of ['gpt-image-2', 'openai/gpt-image-2', 'gpt-image-2-c', 'gpt-image-10']) {
    const transport = makeTransport(jsonResponse({ data: [{ b64_json: 'cmVzdWx0' }] }));
    await invokeImageProvider({
      endpoint: 'https://api.example', apiKey: 'secret', connection: {},
      route: route('openai-images', modelId),
      request: { prompt: 'Edit', references: [{ dataUrl: PNG }] }, transport,
    });
    assert.equal(transport.calls[0].options.body.get('input_fidelity'), null, modelId);
  }
});

test('openai-images JSON edits omit input_fidelity for non-gpt-image-1 models', async () => {
  const transport = makeTransport(jsonResponse({ data: [{ b64_json: 'cmVzdWx0' }] }));
  await invokeImageProvider({
    endpoint: 'https://api.example', apiKey: 'secret',
    connection: { editProtocol: 'json' },
    route: route('openai-images', 'openai/gpt-image-2'),
    request: { prompt: 'Edit', references: [{ dataUrl: PNG }] }, transport,
  });
  const body = JSON.parse(transport.calls[0].options.body);
  assert.equal('input_fidelity' in body, false);
  assert.equal(body.model, 'openai/gpt-image-2');
});

test('openai-images preserves captured no-resubmit metadata for JSON edits', async () => {
  const transport = makeTransport(jsonResponse({ data: [{ b64_json: 'cmVzdWx0' }] }));
  const savedRoute = route('openai-images', 'gpt-image-1', {
    noResubmit: true,
    transport: { bodyKind: 'multipart', proxyEligible: false, directCors: 'required', noResubmit: true },
  });

  await invokeImageProvider({
    endpoint: 'https://api.example', apiKey: 'secret', route: savedRoute,
    connection: { editProtocol: 'json' },
    request: { prompt: 'Edit this', references: [{ dataUrl: PNG }] }, transport,
  });

  // The connection's editProtocol picks JSON regardless of the route's declared
  // bodyKind; the route metadata (noResubmit, proxyEligible, directCors) is
  // still forwarded to the transport for delivery decisions.
  assert.equal(transport.calls[0].kind, 'json');
  assert.equal(transport.calls[0].route.noResubmit, true);
  assert.equal(transport.calls[0].route.transport.noResubmit, true);
  assert.equal(transport.calls[0].route.transport.proxyEligible, false);
  assert.equal(transport.calls[0].route.transport.directCors, 'required');
});

// ── multipart → JSON proxy fallback ─────────────────────────────────────────
//
// A multipart edit dies on the browser preflight (provider sends no CORS
// headers). When the connection opted into the ST CORS proxy, the adapter
// retries ONCE as JSON through /proxy/. Safe by construction: the multipart
// POST never reached the provider (preflight failure => body never sent =>
// nothing billed), and the retry goes proxy-first with noResubmit.

function multipartCorsError() {
  const error = new Error('Multipart image requests require direct CORS. Enable CORS on the image provider or use a JSON image route.');
  error.code = 'MULTIPART_CORS_REQUIRED';
  return error;
}

// Local variant of makeTransport: requestMultipart throws `multipartError`,
// requestJson resolves with `jsonResponse`. Shared makeTransport stays untouched.
function makeFallbackTransport({ multipartError, jsonResponse }) {
  const calls = [];
  return {
    calls,
    requestJson: async (url, options, savedRoute, timeoutMs) => {
      calls.push({ kind: 'json', url, options, route: savedRoute, timeoutMs });
      return jsonResponse;
    },
    requestMultipart: async (url, options, savedRoute, timeoutMs) => {
      calls.push({ kind: 'multipart', url, options, route: savedRoute, timeoutMs });
      throw multipartError;
    },
    downloadResult: async (url, options) => {
      calls.push({ kind: 'download', url, options });
      return jsonResponse;
    },
  };
}

const REFS = [{ dataUrl: PNG }, { dataUrl: JPEG }];

test('openai-images retries a CORS-blocked multipart edit as JSON through the proxy', async () => {
  const transport = makeFallbackTransport({ multipartError: multipartCorsError(), jsonResponse: jsonResponse({ data: [{ b64_json: 'cmVzdWx0' }] }) });
  const req = { prompt: 'Edit this', references: REFS };
  const result = await invokeImageProvider({
    endpoint: 'https://api.example', apiKey: 'secret',
    connection: { timeoutMs: 4300, useCorsProxy: true },
    route: route('openai-images', 'gpt-image-1'),
    request: req, transport,
  });

  // Two wire attempts: multipart first, then the JSON retry.
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[0].kind, 'multipart');
  assert.equal(transport.calls[1].kind, 'json');
  assert.equal(transport.calls[1].url, 'https://api.example/v1/images/edits');
  assert.equal(transport.calls[1].options.headers.Authorization, 'Bearer secret');
  assert.equal(transport.calls[1].options.headers['Content-Type'], 'application/json');
  // The retry goes through /proxy/ immediately (proxy-first, no direct re-try)
  // and keeps the no-resubmit guard so there is exactly one paid attempt total.
  assert.equal(transport.calls[1].route.transport.initialDelivery, 'proxy');
  assert.equal(transport.calls[1].route.transport.noResubmit, true);
  // Fallback diagnostic marker.
  assert.equal(transport.calls[1].options.__urisDiagnostic.attempt, 'proxy-fallback');
  // Same JSON body as an explicit editProtocol:'json' edit.
  assert.deepEqual(JSON.parse(transport.calls[1].options.body), {
    model: 'gpt-image-1', prompt: 'Edit this', n: 1,
    images: [{ image_url: PNG }, { image_url: JPEG }],
    input_fidelity: 'high',
  });
  assert.deepEqual(result, { kind: 'dataUrl', value: 'data:image/png;base64,cmVzdWx0', mimeType: 'image/png', warnings: [] });
  // The provider stamps the actual wire dialect and delivery so the capability
  // observer logs the fallback truth (edit-json / proxy), not the plan.
  assert.equal(req.editDialect, 'json');
  assert.equal(req.delivery, 'proxy');
});

test('openai-images never falls back to JSON without the CORS proxy opt-in', async () => {
  const transport = makeFallbackTransport({ multipartError: multipartCorsError(), jsonResponse: jsonResponse({ data: [{ b64_json: 'cmVzdWx0' }] }) });
  const req = { prompt: 'Edit this', references: REFS };
  await assert.rejects(
    invokeImageProvider({
      endpoint: 'https://api.example', apiKey: 'secret',
      connection: { useCorsProxy: false },
      route: route('openai-images', 'gpt-image-1'),
      request: req, transport,
    }),
    error => error?.code === 'MULTIPART_CORS_REQUIRED',
  );
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].kind, 'multipart');
  // The dialect stamp records the attempted multipart; delivery stays untouched
  // (no fallback happened).
  assert.equal(req.editDialect, 'multipart');
  assert.equal(req.delivery, undefined);
});

test('openai-images never falls back after an HTTP response (double-billing guard)', async () => {
  // An upstream 5xx proves the POST arrived and may have been billed — the
  // multipart failure is NOT a preflight rejection, so no JSON retry.
  const upstream = new Error('OpenAI Images returned HTTP 500');
  upstream.code = 'UPSTREAM_HTTP_ERROR';
  upstream.httpStatus = 500;
  const transport = makeFallbackTransport({ multipartError: upstream, jsonResponse: jsonResponse({ data: [{ b64_json: 'cmVzdWx0' }] }) });
  await assert.rejects(
    invokeImageProvider({
      endpoint: 'https://api.example', apiKey: 'secret',
      connection: { useCorsProxy: true },
      route: route('openai-images', 'gpt-image-1'),
      request: { prompt: 'Edit this', references: REFS }, transport,
    }),
    error => error?.code === 'UPSTREAM_HTTP_ERROR',
  );
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].kind, 'multipart');
});

test('openai-images never falls back on user abort', async () => {
  const transport = makeFallbackTransport({ multipartError: new DOMException('Aborted', 'AbortError'), jsonResponse: jsonResponse({ data: [{ b64_json: 'cmVzdWx0' }] }) });
  await assert.rejects(
    invokeImageProvider({
      endpoint: 'https://api.example', apiKey: 'secret',
      connection: { useCorsProxy: true },
      route: route('openai-images', 'gpt-image-1'),
      request: { prompt: 'Edit this', references: REFS }, transport,
    }),
    error => error?.name === 'AbortError',
  );
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].kind, 'multipart');
});

test('openai-images preserves the final upstream 524 after the safe CORS fallback', async () => {
  const upstream = jsonResponse({ error: { message: 'Gateway timeout while contacting the provider' } }, 524);
  const transport = makeFallbackTransport({ multipartError: multipartCorsError(), jsonResponse: upstream });
  const req = { prompt: 'Edit this', references: REFS };

  await assert.rejects(
    invokeImageProvider({
      endpoint: 'https://api.example', apiKey: 'secret',
      connection: { useCorsProxy: true },
      route: route('openai-images', 'gpt-image-1'),
      request: req, transport,
    }),
    error => error?.code === 'UPSTREAM_HTTP_ERROR'
      && error.httpStatus === 524
      && /HTTP 524/.test(error.message)
      && /Gateway timeout/.test(error.message),
  );
  assert.deepEqual(transport.calls.map(call => call.kind), ['multipart', 'json']);
});

test('openai-images sniffs JPEG MIME from b64_json when no content_type is provided', async () => {
  // Real JPEG SOI+JFIF magic bytes, base64-encoded.
  const jpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');
  const transport = makeTransport(jsonResponse({ data: [{ b64_json: jpegB64 }] }));
  const result = await invokeImageProvider({
    endpoint: 'https://api.example/v1', apiKey: 'secret',
    route: route('openai-images', 'imagen-4.0-generate-001'),
    request: { prompt: 'Photo', references: [] }, transport,
  });
  assert.equal(result.kind, 'dataUrl');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.value, `data:image/jpeg;base64,${jpegB64}`);
});

test('openai-images uses provider-declared content_type when present', async () => {
  // JPEG bytes but provider explicitly declares image/webp -> explicit wins.
  const jpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');
  const transport = makeTransport(jsonResponse({ data: [{ b64_json: jpegB64, content_type: 'image/webp' }] }));
  const result = await invokeImageProvider({
    endpoint: 'https://api.example/v1', apiKey: 'secret',
    route: route('openai-images', 'gpt-image-1'),
    request: { prompt: 'Photo', references: [] }, transport,
  });
  assert.equal(result.mimeType, 'image/webp');
  assert.equal(result.value, `data:image/webp;base64,${jpegB64}`);
});

test('gemini-native keeps references ordered and parses inline image data', async () => {
  const transport = makeTransport(jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/webp', data: 'd2VicA==' } }] } }] }));
  const result = await invokeImageProvider({
    endpoint: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'gem-key',
    connection: { timeoutMs: 4300 },
    route: route('gemini-native', 'gemini-2.5-flash-image'),
    request: { prompt: 'Combine', aspectRatio: '1:1', imageSize: '2K', references: [{ dataUrl: PNG }, { dataUrl: JPEG }] }, transport,
  });

  assert.deepEqual(result, { kind: 'dataUrl', value: 'data:image/webp;base64,d2VicA==', mimeType: 'image/webp', warnings: [] });
  assert.equal(transport.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent');
  assert.equal(transport.calls[0].options.headers['x-goog-api-key'], 'gem-key');
  assert.deepEqual(JSON.parse(transport.calls[0].options.body).contents[0].parts, [
    { inlineData: { mimeType: 'image/png', data: 'cG5n' } },
    { inlineData: { mimeType: 'image/jpeg', data: 'anBlZw==' } },
    { text: 'Combine' },
  ]);
  assert.equal(transport.calls[0].timeoutMs, 4300);
});

test('gemini-native 200 OK without an image is a parse failure, whatever the shape', async () => {
  // Text-only answer (model talked instead of drawing), safety refusal and a
  // rewriting proxy answering in an OpenAI envelope all surface the same way:
  // the provider must throw UPSTREAM_RESPONSE_INVALID so the capability
  // observer classifies it as a parser gap, not a capability statement.
  const shapes = [
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'I cannot draw that.' }] } }] },
    { promptFeedback: { blockReason: 'IMAGE_SAFETY' }, candidates: [] },
    { data: [{ b64_json: 'cmVzdWx0' }] },
  ];
  for (const payload of shapes) {
    const transport = makeTransport(jsonResponse(payload));
    await assert.rejects(
      invokeImageProvider({
        endpoint: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'gem-key',
        connection: {}, route: route('gemini-native', 'gemini-image'),
        request: { prompt: 'Draw', references: [] }, transport,
      }),
      err => err.code === 'UPSTREAM_RESPONSE_INVALID' && /without an image/.test(err.message),
    );
  }
});

test('chat-completions sends multimodal content and parses message images', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: { images: [{ image_url: { url: PNG } }] } }] }));
  const result = await invokeImageProvider({
    endpoint: 'https://compat.example/v1', apiKey: 'key', connection: { timeoutMs: 4400 }, route: route('chat-completions', 'image-model'),
    request: { prompt: 'Restyle', references: [{ dataUrl: JPEG }] }, transport,
  });

  assert.deepEqual(result, { kind: 'dataUrl', value: PNG, mimeType: 'image/png', warnings: [] });
  assert.equal(transport.calls[0].url, 'https://compat.example/v1/chat/completions');
  assert.deepEqual(JSON.parse(transport.calls[0].options.body).messages, [{ role: 'user', content: [
    { type: 'text', text: 'Restyle' }, { type: 'image_url', image_url: { url: JPEG } },
  ] }]);
  assert.equal(transport.calls[0].timeoutMs, 4400);
});

test('chat-completions conditionally sends OpenRouter-compatible image_config', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: { images: [{ image_url: { url: PNG } }] } }] }));
  await invokeImageProvider({
    endpoint: 'https://linkapi.ai/v1', apiKey: 'key',
    route: route('chat-completions', 'gemini-3.1-flash-image-preview', {
      capabilities: { chatCompletionsImageConfig: 'openrouter' },
    }),
    request: { prompt: 'Wide scene', aspectRatio: '16:9', imageSize: '1K', quality: 'high', references: [] }, transport,
  });

  assert.equal(transport.calls.length, 1);
  assert.deepEqual(JSON.parse(transport.calls[0].options.body), {
    model: 'gemini-3.1-flash-image-preview',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Wide scene' }] }],
    stream: false,
    image_config: { aspect_ratio: '16:9', image_size: '1K' },
  });
});

test('generic chat-completions keeps image controls off the wire', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: { images: [{ image_url: { url: PNG } }] } }] }));
  await invokeImageProvider({
    endpoint: 'https://compat.example/v1', apiKey: 'key',
    route: route('chat-completions', 'gemini-3.1-flash-image-preview'),
    request: { prompt: 'Wide scene', aspectRatio: '16:9', imageSize: '1K', quality: 'high', references: [] }, transport,
  });

  const body = JSON.parse(transport.calls[0].options.body);
  assert.equal(body.image_config, undefined);
  assert.equal(body.quality, undefined);
});

test('chat-completions image_config supports partial values without quality', async () => {
  for (const [request, expected] of [
    [{ aspectRatio: '16:9' }, { aspect_ratio: '16:9' }],
    [{ imageSize: '2K' }, { image_size: '2K' }],
  ]) {
    const transport = makeTransport(jsonResponse({ choices: [{ message: { images: [{ image_url: { url: PNG } }] } }] }));
    await invokeImageProvider({
      endpoint: 'https://compat.example/v1', apiKey: 'key',
      route: route('chat-completions', 'image-model', {
        capabilities: { chatCompletionsImageConfig: 'openrouter' },
      }),
      request: { prompt: 'Scene', quality: 'high', references: [], ...request }, transport,
    });
    const body = JSON.parse(transport.calls[0].options.body);
    assert.deepEqual(body.image_config, expected);
    assert.equal(body.quality, undefined);
    assert.equal(body.image_config.quality, undefined);
  }
});



test('openrouter-images uses its explicit route and input references', async () => {
  const transport = makeTransport(jsonResponse({ data: [{ b64_json: 'cmVzdWx0', media_type: 'image/webp' }] }));
  const result = await invokeImageProvider({
    endpoint: 'https://openrouter.ai', apiKey: 'or-key', connection: { timeoutMs: 4500 },
    route: route('openrouter-images', 'black-forest-labs/flux-1.1-pro', { remoteMetadata: { providerTag: 'fal' } }),
    request: { prompt: 'Poster', aspectRatio: '16:9', imageSize: '2K', quality: 'high', references: [{ dataUrl: PNG }] }, transport,
  });

  assert.deepEqual(result, { kind: 'dataUrl', value: 'data:image/webp;base64,cmVzdWx0', mimeType: 'image/webp', warnings: [] });
  assert.equal(transport.calls[0].url, 'https://openrouter.ai/api/v1/images');
  assert.deepEqual(JSON.parse(transport.calls[0].options.body).input_references, [{ type: 'image_url', image_url: { url: PNG } }]);
  assert.equal(transport.calls[0].timeoutMs, 4500);
});

test('openrouter-images uses capability parameter metadata when remote metadata is absent', async () => {
  const transport = makeTransport(jsonResponse({ data: [{ b64_json: 'cmVzdWx0' }] }));
  await invokeImageProvider({
    endpoint: 'https://openrouter.ai', apiKey: 'or-key',
    route: route('openrouter-images', 'author/model', {
      capabilities: {
        references: 'unknown', supportedParameters: ['resolution', 'aspect_ratio', 'quality'],
        imageSizes: ['2K'], aspectRatios: ['16:9'], qualityValues: ['high'],
      },
    }),
    request: { prompt: 'Poster', aspectRatio: '16:9', imageSize: '2K', quality: 'high', references: [] }, transport,
  });

  assert.deepEqual(JSON.parse(transport.calls[0].options.body), {
    model: 'author/model', prompt: 'Poster', n: 1, resolution: '2K', aspect_ratio: '16:9', quality: 'high',
  });
});

test('openrouter-images filters optional fields using persisted supported parameters', async () => {
  const transport = makeTransport(jsonResponse({ data: [{ b64_json: 'cmVzdWx0' }] }));
  await invokeImageProvider({
    endpoint: 'https://openrouter.ai', apiKey: 'or-key',
    route: route('openrouter-images', 'author/model', {
      remoteMetadata: { supportedParameters: ['aspect_ratio'] },
      capabilities: { references: 'unknown' },
    }),
    request: { prompt: 'Poster', aspectRatio: '16:9', imageSize: '2K', quality: 'high', references: [] }, transport,
  });

  assert.deepEqual(JSON.parse(transport.calls[0].options.body), {
    model: 'author/model', prompt: 'Poster', n: 1, aspect_ratio: '16:9',
  });
});

test('openrouter-images omits optional values outside persisted route capabilities', async () => {
  const transport = makeTransport(jsonResponse({ data: [{ b64_json: 'cmVzdWx0' }] }));
  await invokeImageProvider({
    endpoint: 'https://openrouter.ai', apiKey: 'or-key',
    route: route('openrouter-images', 'author/model', {
      remoteMetadata: { supportedParameters: ['resolution', 'aspect_ratio', 'quality'] },
      capabilities: { references: 'unknown', imageSizes: ['1K'], aspectRatios: ['1:1'], qualityValues: ['standard'] },
    }),
    request: { prompt: 'Poster', aspectRatio: '16:9', imageSize: '2K', quality: 'high', references: [] }, transport,
  });

  assert.deepEqual(JSON.parse(transport.calls[0].options.body), {
    model: 'author/model', prompt: 'Poster', n: 1,
  });
});

test('gemini-native uses persisted version and auth metadata when available', async () => {
  const transport = makeTransport(jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'cmVzdWx0' } }] } }] }));
  await invokeImageProvider({
    endpoint: 'https://legacy.example', apiKey: 'gem-key',
    route: route('gemini-native', 'gemini-image', {
      remoteMetadata: { versionedBase: 'https://gateway.example/v1', authStrategy: 'bearer' },
    }),
    request: { prompt: 'Generate', references: [] }, transport,
  });

  assert.equal(transport.calls[0].url, 'https://gateway.example/v1/models/gemini-image:generateContent');
  assert.equal(transport.calls[0].options.headers.Authorization, 'Bearer gem-key');
  assert.equal(transport.calls[0].options.headers['x-goog-api-key'], undefined);
});

test('all provider contracts reject unsupported or excess references before dispatch', async () => {
  for (const contract of ['openai-images', 'gemini-native', 'chat-completions', 'openrouter-images']) {
    for (const [capabilities, references, code] of [
      [{ references: 'unsupported' }, [{ dataUrl: PNG }], 'REFERENCES_UNSUPPORTED'],
      [{ references: 'supported', maxReferences: 1 }, [{ dataUrl: PNG }, { dataUrl: JPEG }], 'TOO_MANY_REFERENCES'],
    ]) {
      const transport = makeTransport(jsonResponse({ data: [{ b64_json: 'cmVzdWx0' }] }));
      await assert.rejects(() => invokeImageProvider({
        endpoint: 'https://api.example', apiKey: 'secret',
        route: route(contract, 'image-model', { capabilities }),
        request: { prompt: 'Edit', references }, transport,
      }), error => error?.code === code, `${contract} should reject ${code}`);
      assert.equal(transport.calls.length, 0, `${contract} must not dispatch`);
    }
  }
});

test('rejects malformed successful provider responses without resubmission', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: { content: 'text only' } }] }));
  await assert.rejects(() => invokeImageProvider({
    endpoint: 'https://compat.example', apiKey: 'key', route: route('chat-completions', 'image-model'),
    request: { prompt: 'Image please', references: [] }, transport,
  }), error => error?.code === 'UPSTREAM_RESPONSE_INVALID' && /image/i.test(error.message));
  assert.equal(transport.calls.length, 1);
});

test('fails unknown contracts before dispatch and never infers from endpoint or model', async () => {
  const transport = makeTransport(jsonResponse({}));
  await assert.rejects(() => invokeImageProvider({
    endpoint: 'https://openrouter.ai', apiKey: 'key', route: route('unknown-contract', 'gpt-image-1'),
    request: { prompt: 'No dispatch' }, transport,
  }), error => error?.code === 'UNSUPPORTED_GENERATION_CONTRACT');
  assert.equal(transport.calls.length, 0);
});

test('rejects absent, malformed, and future route contract versions before dispatch', async () => {
  for (const contractVersion of [undefined, '1', 1.1, 2]) {
    const transport = makeTransport(jsonResponse({}));
    await assert.rejects(() => invokeImageProvider({
      endpoint: 'https://api.example', apiKey: 'key',
      route: route('openai-images', 'gpt-image-1', { contractVersion }),
      request: { prompt: 'No dispatch' }, transport,
    }), error => error?.code === 'UNSUPPORTED_CONTRACT_VERSION' && /contract version/i.test(error.message));
    assert.equal(transport.calls.length, 0);
  }
});

test('openai-images warns about dropped size/quality instead of dropping them silently', async () => {
  const transport = makeTransport(jsonResponse({ data: [{ b64_json: 'cG5n' }] }));
  const result = await invokeImageProvider({
    endpoint: 'https://api.example/v1', apiKey: 'secret',
    connection: { timeoutMs: 4100 },
    route: route('openai-images', 'gpt-image-1'),
    request: { prompt: 'A lighthouse', aspectRatio: '5:7', quality: 'hd', references: [] }, transport,
  });

  const body = JSON.parse(transport.calls[0].options.body);
  assert.equal(body.size, undefined, 'unmapped aspect ratio must not produce a size');
  assert.equal(body.quality, undefined, 'unknown quality value must be omitted');
  assert.deepEqual(result.warnings.map(w => w.feature), ['Стороны', 'Quality']);
  assert.match(result.warnings[0].details, /5:7/);
  assert.match(result.warnings[1].details, /hd/);
});

test('openai-images passes the dall-e quality scale (standard/hd) through', async () => {
  const transport = makeTransport(jsonResponse({ data: [{ b64_json: 'cG5n' }] }));
  const result = await invokeImageProvider({
    endpoint: 'https://api.example/v1', apiKey: 'secret',
    connection: { timeoutMs: 4100 },
    route: route('openai-images', 'dall-e-3'),
    request: { prompt: 'A lighthouse', aspectRatio: '1:1', quality: 'hd', references: [] }, transport,
  });
  assert.equal(JSON.parse(transport.calls[0].options.body).quality, 'hd');
  assert.deepEqual(result.warnings, [], 'hd is valid for dall-e — no warning');
});
