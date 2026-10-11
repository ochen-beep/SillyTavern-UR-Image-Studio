// @ts-check
import { trace } from '../core.js';
import { summarizeReference } from '../references.js';
import { imageResultFromValue, providerError, readJsonResponse, authProfileFor, referencesFor, requireInvocation, assertEncodedReferenceCount, diagnosticRequestOptions } from './image-base.js';
import { resolveEndpoint, interpolatePath } from '../endpoint-utils.js';
import { getProviderDescriptor } from '../provider-descriptors.js';

const DESCRIPTOR = getProviderDescriptor('gemini-native');
const INTERACTIONS_DESCRIPTOR = getProviderDescriptor('gemini-interactions');
import { unsupportedImageSizeReason } from '../image-model-capabilities.js';

function generationUrl(endpoint, route, descriptor = DESCRIPTOR) {
  // Проба «Проверить» может закрепить versionedBase на маршруте — он
  // приоритетнее нормализации дескриптора.
  const savedBase = route?.remoteMetadata?.versionedBase;
  const base = savedBase
    ? String(savedBase).trim().replace(/\/+$/, '')
    : resolveEndpoint(descriptor, endpoint);
  return base + interpolatePath(descriptor.endpoint.generationPath, { model: route.modelId });
}

function headers(endpoint, route, apiKey) {
  const strategy = route?.remoteMetadata?.authStrategy;
  if (strategy === 'bearer') return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  if (strategy === 'x-goog-api-key') return { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' };
  return /generativelanguage\.googleapis\.com/i.test(endpoint)
    ? { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

// The generationConfig carries the geometry a model actually owns. An
// unsupported resolution tier is dropped rather than forwarded: on this family
// an unknown imageSize can fail the entire request (and with it the aspect
// ratio), and the caller gets a warning explaining what was dropped and why.
function body(route, request, references) {
  const requestedSize = typeof request?.imageSize === 'string' && request.imageSize.trim() ? request.imageSize.trim() : null;
  const sizeReason = requestedSize ? unsupportedImageSizeReason(route?.modelId, requestedSize) : null;
  const imageConfig = {
    ...(typeof request?.aspectRatio === 'string' ? { aspectRatio: request.aspectRatio } : {}),
    ...(requestedSize && !sizeReason ? { imageSize: requestedSize } : {}),
  };
  const referenceBindings = Array.isArray(request?.referenceBindings) ? request.referenceBindings : [];
  const parts = [];
  references.forEach((reference, index) => {
    const binding = referenceBindings[index];
    if (binding) parts.push({ text: `Reference image ${binding.index} corresponds to "${binding.label}". Use it as the visual reference for that subject.` });
    parts.push({ inlineData: { mimeType: reference.mimeType, data: reference.data } });
  });
  parts.push({ text: String(request?.prompt || '') });
  return {
    payload: {
      contents: [{ parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(Object.keys(imageConfig).length ? { imageConfig } : {}) },
    },
    sizeWarning: sizeReason ? { size: requestedSize, reason: sizeReason } : null,
  };
}

function parse(payload) {
  for (const candidate of Array.isArray(payload?.candidates) ? payload.candidates : []) {
    for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
      const inline = part?.inlineData ?? part?.inline_data;
      const mimeType = inline?.mimeType ?? inline?.mime_type;
      if (typeof inline?.data === 'string' && typeof mimeType === 'string' && mimeType.startsWith('image/')) return imageResultFromValue(inline.data, mimeType);
    }
  }
  // Structure dump (metadata only, never image bytes) for the "200 OK without
  // image" case, mirroring the chat-completions provider. It separates the
  // three real causes: a safety refusal (promptFeedback.blockReason or a
  // SAFETY/IMAGE_SAFETY finishReason), a text-only answer (text parts, no
  // inlineData), and a rewriting proxy that answered in a different envelope
  // (no candidates key at all — e.g. an OpenAI-shaped { data: [...] } body,
  // visible via topKeys).
  trace('gemini-native: no image found in response', {
    topKeys: payload && typeof payload === 'object' ? Object.keys(payload) : null,
    blockReason: payload?.promptFeedback?.blockReason ?? payload?.promptFeedback?.block_reason ?? null,
    candidates: Array.isArray(payload?.candidates) ? payload.candidates.map(c => ({
      finishReason: c?.finishReason ?? c?.finish_reason ?? null,
      partTypes: Array.isArray(c?.content?.parts)
        ? c.content.parts.map(p => ((p?.inlineData || p?.inline_data) ? 'inlineData' : p?.text != null ? 'text' : 'other'))
        : null,
    })) : null,
  });
  throw providerError('UPSTREAM_RESPONSE_INVALID', 'Gemini Native returned a successful response without an image.');
}

export async function generateGeminiImage(input) {
  const { endpoint, apiKey, route, request, transport, signal, connection = {}, diagnostic = null, parsedReferences } = requireInvocation(input);
  const references = parsedReferences ?? referencesFor(request);
  const { payload, sizeWarning } = body(route, request, references);
  const encodedReferences = payload.contents[0].parts.filter(part => part?.inlineData).length;
  assertEncodedReferenceCount(references.length, encodedReferences, 'gemini-inlineData');
  trace('gemini-native: outgoing payload', {
    rid: String(request?.requestId || '').slice(0, 8),
    model: route.modelId,
    op: references.length ? 'edit' : 'generate',
    delivery: request?.delivery || route?.transport?.initialDelivery || 'unknown',
    expectedRefs: references.length,
    encodedRefs: encodedReferences,
    refs: (request?.references || []).map(ref => ({ id: ref?.id, name: ref?.name, ...summarizeReference(ref) })),
    imageConfig: payload.generationConfig.imageConfig || null,
    droppedImageSize: sizeWarning ? sizeWarning.size : null,
  });
  const response = await transport.requestJson(generationUrl(endpoint, route), diagnosticRequestOptions({
    method: 'POST', headers: headers(endpoint, route, apiKey), body: JSON.stringify(payload), signal,
  }, diagnostic, {
    bodyKind: 'json', wireFields: ['contents', 'generationConfig', 'responseModalities', ...(payload.generationConfig.imageConfig ? ['imageConfig'] : [])],
    ...(sizeWarning ? { omittedFields: ['imageSize'] } : {}),
  }), route, connection.timeoutMs);
  const warnings = sizeWarning
    ? [{ feature: 'Размер', details: `размер ${sizeWarning.size} не поддерживается: ${sizeWarning.reason} — параметр опущен.` }]
    : [];
  return { ...parse(await readJsonResponse(response, 'Gemini Native', authProfileFor(route?.generationContract))), warnings };
}

// ── Interactions API (Nano Banana 2.1+) ────────────────────────────────────
// Документированная поверхность 2.1+ (v1beta/interactions, майская схема
// 2026): input[] вместо contents[], геометрия в polymorphic response_format
// вместо generationConfig.imageConfig. store:false — interactions по умолчанию
// сохраняются у Google (+3-5 c латентности на store=true, python-genai #3059),
// а URIS stateless: previous_interaction_id не используется.
function interactionsBody(route, request, references) {
  const requestedSize = typeof request?.imageSize === 'string' && request.imageSize.trim() ? request.imageSize.trim() : null;
  const sizeReason = requestedSize ? unsupportedImageSizeReason(route?.modelId, requestedSize) : null;
  const responseFormat = {
    type: 'image',
    ...(typeof request?.aspectRatio === 'string' ? { aspect_ratio: request.aspectRatio } : {}),
    ...(requestedSize && !sizeReason ? { image_size: requestedSize } : {}),
  };
  const referenceBindings = Array.isArray(request?.referenceBindings) ? request.referenceBindings : [];
  const input = [];
  references.forEach((reference, index) => {
    const binding = referenceBindings[index];
    if (binding) input.push({ type: 'text', text: `Reference image ${binding.index} corresponds to "${binding.label}". Use it as the visual reference for that subject.` });
    input.push({ type: 'image', mime_type: reference.mimeType, data: reference.data });
  });
  input.push({ type: 'text', text: String(request?.prompt || '') });
  return {
    payload: { model: route.modelId, store: false, input, response_format: responseFormat },
    sizeWarning: sizeReason ? { size: requestedSize, reason: sizeReason } : null,
  };
}

// Ответ: convenience-поле output_image {mime_type, data} либо — при
// интерливде текст+картинки (3-pro) — шаги model_output с image-блоками
// в content[] (схема steps, легаси-outputs выключена 2026-06-08).
function parseInteractions(payload) {
  const direct = payload?.output_image;
  const directMime = direct?.mime_type ?? direct?.mimeType;
  if (typeof direct?.data === 'string' && (typeof directMime !== 'string' || directMime.startsWith('image/'))) {
    return imageResultFromValue(direct.data, directMime || 'image/png');
  }
  for (const step of Array.isArray(payload?.steps) ? payload.steps : []) {
    if (step?.type !== 'model_output') continue;
    for (const block of Array.isArray(step?.content) ? step.content : []) {
      const mime = block?.mime_type ?? block?.mimeType;
      if (block?.type === 'image' && typeof block?.data === 'string' && typeof mime === 'string' && mime.startsWith('image/')) {
        return imageResultFromValue(block.data, mime);
      }
    }
  }
  trace('gemini-interactions: no image found in response', {
    topKeys: payload && typeof payload === 'object' ? Object.keys(payload) : null,
    stepTypes: Array.isArray(payload?.steps) ? payload.steps.map(step => step?.type ?? 'other') : null,
  });
  throw providerError('UPSTREAM_RESPONSE_INVALID', 'Gemini Interactions returned a successful response without an image.');
}

export async function generateGeminiInteractionsImage(input) {
  const { endpoint, apiKey, route, request, transport, signal, connection = {}, diagnostic = null, parsedReferences } = requireInvocation(input);
  const references = parsedReferences ?? referencesFor(request);
  const { payload, sizeWarning } = interactionsBody(route, request, references);
  const encodedReferences = payload.input.filter(item => item?.type === 'image').length;
  assertEncodedReferenceCount(references.length, encodedReferences, 'gemini-interactions:image');
  trace('gemini-interactions: outgoing payload', {
    rid: String(request?.requestId || '').slice(0, 8),
    model: route.modelId,
    op: references.length ? 'edit' : 'generate',
    expectedRefs: references.length,
    encodedRefs: encodedReferences,
    responseFormat: payload.response_format,
    droppedImageSize: sizeWarning ? sizeWarning.size : null,
  });
  const response = await transport.requestJson(generationUrl(endpoint, route, INTERACTIONS_DESCRIPTOR), diagnosticRequestOptions({
    method: 'POST', headers: headers(endpoint, route, apiKey), body: JSON.stringify(payload), signal,
  }, diagnostic, {
    bodyKind: 'json', wireFields: ['model', 'input', 'response_format', 'store'],
    ...(sizeWarning ? { omittedFields: ['image_size'] } : {}),
  }), route, connection.timeoutMs);
  const warnings = sizeWarning
    ? [{ feature: 'Размер', details: `размер ${sizeWarning.size} не поддерживается: ${sizeWarning.reason} — параметр опущен.` }]
    : [];
  return { ...parseInteractions(await readJsonResponse(response, 'Gemini Interactions', authProfileFor(route?.generationContract))), warnings };
}
