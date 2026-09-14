// @ts-check
import { trace } from '../core.js';
import { summarizeReference } from '../references.js';
import { endpointBase, imageResultFromValue, providerError, readJsonResponse, referencesFor, requireInvocation, assertEncodedReferenceCount, diagnosticRequestOptions } from './image-base.js';

function chatUrl(endpoint) { return `${endpointBase(endpoint)}/chat/completions`; }

// ── Image extraction from chat completion messages ──
//
// Unlike /v1/images/generations (which always returns { data: [{ b64_json }] }),
// chat completion providers return generated images in wildly different shapes:
//
//   1. message.images[]               - dedicated array (some Chinese API proxies)
//   2. message.content[] (multimodal) - OpenAI vision format, assistant returns
//      content parts, one of which is { type: "image_url", image_url: { url } }
//      or { type: "image", b64_json }
//   3. message.content (string)       - the model embeds a data URL or image URL
//      directly in the text, sometimes wrapped in markdown: ![](data:...)
//   4. message.image_url              - the image is placed directly on the
//      message object as a string or { url } object
//
// We try each location in order and return the first image found. When nothing
// matches, we log the message structure (without full image data) so the user
// can see exactly what the provider sent and report it.

const DATA_URL_RE = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+={0,2}/i;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/i;
const HTTP_IMAGE_URL_RE = /https?:\/\/[^\s"'<>)]+\.(?:png|jpe?g|webp|gif)\b/i;

/** Extract an image value (data URL or HTTP URL) from a text string. */
function extractImageFromContent(text) {
  if (typeof text !== 'string' || !text) return null;
  // Data URLs are self-contained and unambiguous - check first.
  const dataUrl = text.match(DATA_URL_RE);
  if (dataUrl) return dataUrl[0];
  // Markdown image syntax: ![alt](url) - url may be data: or https:
  const md = text.match(MARKDOWN_IMAGE_RE);
  if (md?.[1]) return md[1];
  // Bare HTTP URL to an image file (least reliable - could be a reference
  // link rather than the generated image - but some providers do this).
  const http = text.match(HTTP_IMAGE_URL_RE);
  if (http) return http[0];
  return null;
}

function parse(payload) {
  const message = Array.isArray(payload?.choices) ? payload.choices[0]?.message : null;
  if (!message || typeof message !== 'object') {
    throw providerError('UPSTREAM_RESPONSE_INVALID', 'Chat Completions returned no message in the response.');
  }

  // 1. message.images[] - dedicated images array.
  if (Array.isArray(message.images)) {
    for (const image of message.images) {
      const value = image?.image_url?.url ?? image?.url ?? image?.data_url ?? image?.b64_json;
      if (typeof value === 'string' && value) return imageResultFromValue(value, image?.media_type ?? image?.mime_type);
    }
  }

  // 2. message.content as a multimodal array (OpenAI vision response format).
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part?.type === 'image_url' && typeof part?.image_url?.url === 'string' && part.image_url.url) {
        return imageResultFromValue(part.image_url.url);
      }
      if (part?.type === 'image' && typeof part?.b64_json === 'string' && part.b64_json) {
        return imageResultFromValue(part.b64_json, part?.mime_type);
      }
      // Some providers embed a data URL inside a text part.
      if (part?.type === 'text' && typeof part?.text === 'string') {
        const found = extractImageFromContent(part.text);
        if (found) return imageResultFromValue(found);
      }
    }
  }

  // 3. message.content as a string - data URL, markdown image, or bare URL.
  if (typeof message.content === 'string' && message.content) {
    const found = extractImageFromContent(message.content);
    if (found) return imageResultFromValue(found);
  }

  // 4. message.image_url - image placed directly on the message object.
  if (message.image_url) {
    const value = typeof message.image_url === 'string' ? message.image_url : message.image_url?.url;
    if (typeof value === 'string' && value) return imageResultFromValue(value);
  }

  // Diagnostic: log the message structure (truncated, no full image data) so
  // the user can see what format the provider actually uses. This is the only
  // way to debug "without an image" errors without manual network inspection.
  trace('chat-completions: no image found in message', {
    keys: Object.keys(message),
    contentType: Array.isArray(message.content) ? 'array' : typeof message.content,
    contentPreview: typeof message.content === 'string' ? message.content.slice(0, 300) : null,
    contentPartTypes: Array.isArray(message.content) ? message.content.map(p => p?.type ?? typeof p) : null,
    hasImages: Array.isArray(message.images),
    imagesLength: Array.isArray(message.images) ? message.images.length : 0,
    hasImageUrl: 'image_url' in message,
  });
  throw providerError('UPSTREAM_RESPONSE_INVALID', 'Chat Completions returned a successful response without an image.');
}

export async function generateChatCompletionImage(input) {
  const { endpoint, apiKey, route, request, transport, signal, connection = {}, diagnostic = null } = requireInvocation(input);
  const references = referencesFor(request);
  const bindingText = (request?.referenceBindings || []).map(binding =>
    `Reference image ${binding.index} corresponds to "${binding.label}". Use it as the visual reference for that subject.`
  );
  const content = [
    { type: 'text', text: String(request?.prompt || '') },
    ...references.flatMap((reference, index) => [
      ...(bindingText[index] ? [{ type: 'text', text: bindingText[index] }] : []),
      { type: 'image_url', image_url: { url: reference.dataUrl } },
    ]),
  ];
  const encodedReferences = content.filter(part => part?.type === 'image_url').length;
  assertEncodedReferenceCount(references.length, encodedReferences, 'chat-image_url');
  const imageConfig = route?.capabilities?.chatCompletionsImageConfig === 'openrouter'
    ? Object.fromEntries([
      ['aspect_ratio', request?.aspectRatio],
      ['image_size', request?.imageSize],
    ].filter(([, value]) => typeof value === 'string' && value.trim()))
    : null;
  // OpenRouter returns image output on chat/completions only when the request
  // explicitly opts in via `modalities` — without it the model answers
  // text-only and the parser finds no image. Other gateways either ignore the
  // field or reject unknown params, so it is gated to the openrouter capability.
  const wantsOpenRouterImages = route?.capabilities?.chatCompletionsImageConfig === 'openrouter';
  const body = {
    model: route.modelId,
    messages: [{ role: 'user', content }],
    stream: false,
    ...(wantsOpenRouterImages ? { modalities: ['image', 'text'] } : {}),
    ...(imageConfig && Object.keys(imageConfig).length ? { image_config: imageConfig } : {}),
  };
  const wireFields = ['model', 'messages', 'stream', ...(wantsOpenRouterImages ? ['modalities'] : []), ...(imageConfig && Object.keys(imageConfig).length ? ['image_config'] : [])];
  const omittedFields = [
    ...(imageConfig ? [] : ['aspectRatio', 'imageSize']),
    'quality',
  ];
  const parameterSource = imageConfig ? 'chat-completions-image-config' : null;
  // Same shape as the openai-images payload log: per-ref metadata only
  // (name/MIME/KB), never the dataUrl itself.
  trace('chat-completions: outgoing payload', {
    rid: String(request?.requestId || '').slice(0, 8),
    model: route.modelId,
    op: references.length ? 'edit-json' : 'generate',
    expectedRefs: references.length,
    encodedRefs: encodedReferences,
    refs: references.map(summarizeReference),
  });
  const response = await transport.requestJson(chatUrl(endpoint), diagnosticRequestOptions({
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal,
  }, diagnostic, {
    bodyKind: 'json', wireFields, omittedFields,
    ...(parameterSource ? { parameterSource } : {}),
  }), route, connection.timeoutMs);
  return parse(await readJsonResponse(response, 'Chat Completions'));
}
