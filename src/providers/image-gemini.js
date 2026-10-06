// @ts-check
import { trace } from '../core.js';
import { summarizeReference } from '../references.js';
import { imageResultFromValue, providerError, readJsonResponse, authProfileFor, referencesFor, requireInvocation, assertEncodedReferenceCount, diagnosticRequestOptions } from './image-base.js';
import { resolveEndpoint, interpolatePath } from '../endpoint-utils.js';
import { getProviderDescriptor } from '../provider-descriptors.js';

const DESCRIPTOR = getProviderDescriptor('gemini-native');
import { unsupportedImageSizeReason } from '../image-model-capabilities.js';

function generationUrl(endpoint, route) {
  // Проба «Проверить» может закрепить versionedBase на маршруте — он
  // приоритетнее нормализации дескриптора.
  const savedBase = route?.remoteMetadata?.versionedBase;
  const base = savedBase
    ? String(savedBase).trim().replace(/\/+$/, '')
    : resolveEndpoint(DESCRIPTOR, endpoint);
  return base + interpolatePath(DESCRIPTOR.endpoint.generationPath, { model: route.modelId });
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
