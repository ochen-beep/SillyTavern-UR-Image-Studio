// @ts-check
//
// Chat Completions providers return generated images in wildly different
// shapes. The parser in src/providers/image-chat-completions.js tries each
// known location (message.images[], message.content[] multimodal array,
// message.content string, message.image_url) and returns the first image
// found. This suite covers every supported format plus the failure case.

import test from 'node:test';
import assert from 'node:assert/strict';

import { invokeImageProvider } from '../src/image-provider-registry.js';

const PNG_DATA_URL = 'data:image/png;base64,cG5n';
const JPEG_DATA_URL = 'data:image/jpeg;base64,anBlZw==';
const HTTP_IMAGE_URL = 'https://cdn.example/generated/image.png';

function route(modelId = 'gemini-3.1-flash-image-preview') {
  return {
    contractVersion: 1,
    generationContract: 'chat-completions',
    modelId,
    transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
  };
}

function makeTransport(response) {
  return {
    requestJson: async () => response,
    requestMultipart: async () => response,
    downloadResult: async () => response,
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
}

function baseRequest(transport, overrides = {}) {
  return invokeImageProvider({
    endpoint: 'https://api.example/v1', apiKey: 'secret',
    route: route(), request: { prompt: 'Draw a cat', references: [] }, transport,
    ...overrides,
  });
}

// ── 1. message.images[] (dedicated images array) ──

test('chat-completions parses message.images[] with image_url.url', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: { images: [{ image_url: { url: PNG_DATA_URL } }] } }] }));
  const result = await baseRequest(transport);
  assert.equal(result.kind, 'dataUrl');
  assert.equal(result.value, PNG_DATA_URL);
  assert.equal(result.mimeType, 'image/png');
});

test('chat-completions parses message.images[] with b64_json field', async () => {
  const jpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');
  const transport = makeTransport(jsonResponse({ choices: [{ message: { images: [{ b64_json: jpegB64 }] } }] }));
  const result = await baseRequest(transport);
  assert.equal(result.mimeType, 'image/jpeg');
});

// ── 2. message.content[] (multimodal array) ──

test('chat-completions parses image_url part in multimodal content array', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: { content: [
    { type: 'text', text: 'Here is your image' },
    { type: 'image_url', image_url: { url: PNG_DATA_URL } },
  ] } }] }));
  const result = await baseRequest(transport);
  assert.equal(result.kind, 'dataUrl');
  assert.equal(result.value, PNG_DATA_URL);
});

test('chat-completions parses image part with b64_json in multimodal content array', async () => {
  const jpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');
  const transport = makeTransport(jsonResponse({ choices: [{ message: { content: [
    { type: 'text', text: 'Done' },
    { type: 'image', b64_json: jpegB64, mime_type: 'image/jpeg' },
  ] } }] }));
  const result = await baseRequest(transport);
  assert.equal(result.mimeType, 'image/jpeg');
});

test('chat-completions extracts data URL from text part in multimodal content array', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: { content: [
    { type: 'text', text: `Result: ${JPEG_DATA_URL}` },
  ] } }] }));
  const result = await baseRequest(transport);
  assert.equal(result.value, JPEG_DATA_URL);
  assert.equal(result.mimeType, 'image/jpeg');
});

// ── 3. message.content (string) ──

test('chat-completions extracts bare data URL from content string', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: { content: PNG_DATA_URL } }] }));
  const result = await baseRequest(transport);
  assert.equal(result.value, PNG_DATA_URL);
  assert.equal(result.mimeType, 'image/png');
});

test('chat-completions extracts data URL from markdown image in content string', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: { content: `Here is your image:\n\n![generated](${JPEG_DATA_URL})\n\nEnjoy!` } }] }));
  const result = await baseRequest(transport);
  assert.equal(result.value, JPEG_DATA_URL);
  assert.equal(result.mimeType, 'image/jpeg');
});

test('chat-completions extracts HTTP image URL from markdown in content string', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: { content: `![result](${HTTP_IMAGE_URL})` } }] }));
  const result = await baseRequest(transport);
  assert.equal(result.kind, 'url');
  assert.equal(result.value, HTTP_IMAGE_URL);
});

test('chat-completions extracts bare HTTP image URL from content string', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: { content: HTTP_IMAGE_URL } }] }));
  const result = await baseRequest(transport);
  assert.equal(result.kind, 'url');
  assert.equal(result.value, HTTP_IMAGE_URL);
});

// ── 4. message.image_url (direct field) ──

test('chat-completions parses message.image_url as string', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: { content: 'Done', image_url: PNG_DATA_URL } }] }));
  const result = await baseRequest(transport);
  assert.equal(result.value, PNG_DATA_URL);
  assert.equal(result.mimeType, 'image/png');
});

test('chat-completions parses message.image_url as { url } object', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: { image_url: { url: JPEG_DATA_URL } } }] }));
  const result = await baseRequest(transport);
  assert.equal(result.value, JPEG_DATA_URL);
  assert.equal(result.mimeType, 'image/jpeg');
});

// ── 5. Failure cases ──

test('chat-completions throws when message has no image in any location', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: { content: 'Sorry, I cannot generate images.' } }] }));
  await assert.rejects(
    baseRequest(transport),
    err => err?.code === 'UPSTREAM_RESPONSE_INVALID' && /without an image/.test(err.message),
  );
});

test('chat-completions throws when message is null', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: null }] }));
  await assert.rejects(
    baseRequest(transport),
    err => err?.code === 'UPSTREAM_RESPONSE_INVALID' && /no message/.test(err.message),
  );
});

test('chat-completions throws when content array has only text parts', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: { content: [{ type: 'text', text: 'No image here' }] } }] }));
  await assert.rejects(baseRequest(transport), err => err?.code === 'UPSTREAM_RESPONSE_INVALID');
});

test('chat-completions throws when content is null (tool_calls only)', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: { content: null, tool_calls: [] } }] }));
  await assert.rejects(baseRequest(transport), err => err?.code === 'UPSTREAM_RESPONSE_INVALID');
});

// ── 6. Precedence: images[] checked before content ──

test('chat-completions prefers message.images[] over content when both present', async () => {
  const transport = makeTransport(jsonResponse({ choices: [{ message: {
    images: [{ url: PNG_DATA_URL }],
    content: JPEG_DATA_URL,
  } }] }));
  const result = await baseRequest(transport);
  assert.equal(result.value, PNG_DATA_URL);
});
