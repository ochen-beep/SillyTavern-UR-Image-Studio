// @ts-check
import { trace } from '../core.js';
import { summarizeReference } from '../references.js';
import { endpointBase, imageResultFromValue, providerError, readJsonResponse, referencesFor, requireInvocation, assertEncodedReferenceCount, diagnosticRequestOptions } from './image-base.js';
import { promptAspectConflicts } from '../aspect-ratio.js';
import { unsupportedImageSizeReason } from '../image-model-capabilities.js';

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

// ── Aspect/size channels and parameter warnings ──
//
// Chat Completions has no standard image-geometry members, so the aspect ratio
// either rides a gateway-specific dialect or it does not travel at all. Prompt
// text is deliberately NOT used as a fallback channel: it was tested live
// against a new-api relay gateway (2026-09-16) and the model ignored the
// ratio sentence in every placement, returning its default canvas. Relying on
// it would recreate the silent failure this warnings channel exists to expose.
// When no dialect is selected the user gets a warning pointing at the
// connection setting instead.
//
//   'openrouter' → { modalities, image_config: { aspect_ratio, image_size } }
//   'new-api'    → { extra_body: { google: { image_config: { aspect_ratio, image_size } } } }
//     (snake_case keys are enforced by the new-api converter; camelCase
//     hard-fails with convert_request_failed before any billing)
//
// `quality` has no member on either dialect and always warns when set.

// Keys the adapter owns; a connection's static extraBody must never clobber
// them (a wrong `model`/`messages` corrupts the request structurally).
const RESERVED_BODY_KEYS = new Set(['model', 'messages', 'stream']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-merge the connection's static "Доп. параметры body" into the built
 * request body (extra wins), so the connection field does something on the
 * dialect where bespoke gateway quirks actually live. Reserved keys are
 * skipped. Returns the body and the applied top-level keys for the trace.
 * @param {Record<string, unknown>} body
 * @param {unknown} extraBody
 * @returns {{ body: Record<string, unknown>, applied: string[] }}
 */
function mergeExtraBody(body, extraBody) {
  const extra = isPlainObject(extraBody) ? extraBody : {};
  const applied = [];
  const walk = (target, source) => {
    for (const [key, value] of Object.entries(source)) {
      if (RESERVED_BODY_KEYS.has(key)) continue;
      applied.push(key);
      if (isPlainObject(value) && isPlainObject(target[key])) walk(target[key], value);
      else target[key] = value;
    }
  };
  walk(body, extra);
  return { body, applied };
}

/**
 * Human-readable warnings for parameters this dialect cannot carry. 'auto'
 * never warns: omitting IS the auto behavior. Prompt-vs-settings aspect
 * conflicts are surfaced only when a parameter channel is active — without
 * one, the "dropped" warning below already covers the outcome.
 * @returns {Array<{feature: string, details: string}>}
 */
function paramWarnings({ mode, aspectRatio, imageSize, quality, prompt, unsupportedSize }) {
  const warnings = [];
  if (!mode) {
    if (aspectRatio) {
      warnings.push({
        feature: 'Стороны',
        details: `соотношение ${aspectRatio} не передаётся: для Chat Completions не выбран тип шлюза. Укажите «Параметры изображений Chat Completions» в настройках подключения (new-api или OpenRouter) — текст в промпте модель может не соблюдать.`,
      });
    }
    if (imageSize) {
      warnings.push({
        feature: 'Размер',
        details: `размер ${imageSize} не передаётся: у Chat Completions без типа шлюза нет параметра размера.`,
      });
    }
  }
  // Model-level rejection beats dialect-level silence: an unsupported tier can
  // fail the whole request (taking the aspect ratio with it), so it is dropped
  // even when a dialect channel is active.
  if (unsupportedSize) {
    warnings.push({ feature: 'Размер', details: `размер ${unsupportedSize.size} не поддерживается: ${unsupportedSize.reason} — параметр опущен.` });
  }
  if (quality && quality !== 'auto') {
    warnings.push({ feature: 'Quality', details: `значение «${quality}» не передаётся: у контракта Chat Completions нет параметра quality.` });
  }
  if (mode && aspectRatio) {
    const conflicts = promptAspectConflicts(prompt, aspectRatio);
    if (conflicts.length) {
      warnings.push({
        feature: 'Стороны',
        details: `в промпте указано ${conflicts.join(', ')}, а в настройках ${aspectRatio}: параметром уходит значение из настроек, проверьте, что они совпадают по замыслу.`,
      });
    }
  }
  return warnings;
}

export async function generateChatCompletionImage(input) {
  const { endpoint, apiKey, route, request, transport, signal, connection = {}, diagnostic = null } = requireInvocation(input);
  const references = referencesFor(request);
  const bindingText = (request?.referenceBindings || []).map(binding =>
    `Reference image ${binding.index} corresponds to "${binding.label}". Use it as the visual reference for that subject.`
  );
  const prompt = String(request?.prompt || '');
  const content = [
    { type: 'text', text: prompt },
    ...references.flatMap((reference, index) => [
      ...(bindingText[index] ? [{ type: 'text', text: bindingText[index] }] : []),
      { type: 'image_url', image_url: { url: reference.dataUrl } },
    ]),
  ];
  const encodedReferences = content.filter(part => part?.type === 'image_url').length;
  assertEncodedReferenceCount(references.length, encodedReferences, 'chat-image_url');
  const mode = route?.capabilities?.chatCompletionsImageConfig === 'openrouter' || route?.capabilities?.chatCompletionsImageConfig === 'new-api'
    ? route.capabilities.chatCompletionsImageConfig
    : null;
  const requestedSize = typeof request?.imageSize === 'string' && request.imageSize.trim() ? request.imageSize.trim() : null;
  const sizeReason = requestedSize ? unsupportedImageSizeReason(route.modelId, requestedSize) : null;
  const geometry = Object.fromEntries([
    ['aspect_ratio', typeof request?.aspectRatio === 'string' && request.aspectRatio.trim() ? request.aspectRatio.trim() : null],
    // A tier the model does not own is dropped before it reaches the wire: the
    // upstream may reject the whole request over it, which would cost the user
    // the aspect ratio too (new-api clears imageSize for exactly this reason).
    ['image_size', sizeReason ? null : requestedSize],
  ].filter(([, value]) => value));
  // OpenRouter returns image output on chat/completions only when the request
  // explicitly opts in via `modalities` — without it the model answers
  // text-only and the parser finds no image. new-api needs no modalities (and
  // top-level members from the OpenRouter shape are silently ignored there —
  // the parameter must travel inside extra_body instead).
  const wantsOpenRouterImages = mode === 'openrouter';
  let body = {
    model: route.modelId,
    messages: [{ role: 'user', content }],
    stream: false,
    ...(mode === 'openrouter'
      ? {
          modalities: ['image', 'text'],
          ...(Object.keys(geometry).length ? { image_config: geometry } : {}),
        }
      : {}),
    ...(mode === 'new-api' && Object.keys(geometry).length
      ? { extra_body: { google: { image_config: geometry } } }
      : {}),
  };
  const merged = mergeExtraBody(body, connection?.extraBody);
  body = merged.body;
  const wireFields = ['model', 'messages', 'stream',
    ...(wantsOpenRouterImages ? ['modalities'] : []),
    ...(mode === 'openrouter' && body.image_config ? ['image_config'] : []),
    ...(mode === 'new-api' && body.extra_body ? ['extra_body'] : []),
    ...merged.applied,
  ];
  const omittedFields = [
    ...(mode ? [] : ['aspectRatio', 'imageSize']),
    'quality',
  ];
  const aspectChannel = mode === 'openrouter' ? 'image_config(openrouter)'
    : mode === 'new-api' ? 'extra_body.google.image_config(new-api)'
      : 'none';
  const parameterSource = mode ? `chat-completions-${mode}` : null;
  const warnings = paramWarnings({
    mode,
    aspectRatio: typeof request?.aspectRatio === 'string' && request.aspectRatio.trim() ? request.aspectRatio.trim() : null,
    imageSize: requestedSize,
    quality: typeof request?.quality === 'string' && request.quality.trim() ? request.quality.trim() : null,
    prompt,
    ...(sizeReason ? { unsupportedSize: { size: requestedSize, reason: sizeReason } } : {}),
  });
  // Same shape as the openai-images payload log: per-ref metadata only
  // (name/MIME/KB), never the dataUrl itself.
  trace('chat-completions: outgoing payload', {
    rid: String(request?.requestId || '').slice(0, 8),
    model: route.modelId,
    op: references.length ? 'edit-json' : 'generate',
    aspectChannel,
    expectedRefs: references.length,
    encodedRefs: encodedReferences,
    refs: references.map(summarizeReference),
    extraBodyKeys: merged.applied,
    warnings: warnings.length,
  });
  const response = await transport.requestJson(chatUrl(endpoint), diagnosticRequestOptions({
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal,
  }, diagnostic, {
    bodyKind: 'json', wireFields, omittedFields, aspectChannel,
    ...(parameterSource ? { parameterSource } : {}),
  }), route, connection.timeoutMs);
  return { ...parse(await readJsonResponse(response, 'Chat Completions')), warnings };
}
