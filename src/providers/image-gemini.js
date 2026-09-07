// @ts-check
import { trace } from '../core.js';
import { summarizeReference } from '../references.js';
import { endpointBase, imageResultFromValue, providerError, readJsonResponse, referencesFor, requireInvocation, assertEncodedReferenceCount, diagnosticRequestOptions } from './image-base.js';

function generationUrl(endpoint, route) {
  const savedBase = route?.remoteMetadata?.versionedBase;
  const base = String(savedBase || endpoint || '').trim().replace(/\/+$/, '');
  if (!base) throw providerError('INVALID_ENDPOINT', 'Gemini Native endpoint is required.');
  const versionedBase = /\/(v1|v1beta)$/i.test(base) ? base : `${base}/v1beta`;
  return `${versionedBase}/models/${encodeURIComponent(route.modelId)}:generateContent`;
}

function headers(endpoint, route, apiKey) {
  const strategy = route?.remoteMetadata?.authStrategy;
  if (strategy === 'bearer') return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  if (strategy === 'x-goog-api-key') return { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' };
  return /generativelanguage\.googleapis\.com/i.test(endpoint)
    ? { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

function body(request, references) {
  const imageConfig = {
    ...(typeof request?.aspectRatio === 'string' ? { aspectRatio: request.aspectRatio } : {}),
    ...(typeof request?.imageSize === 'string' ? { imageSize: request.imageSize } : {}),
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
    contents: [{ parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(Object.keys(imageConfig).length ? { imageConfig } : {}) },
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
  const { endpoint, apiKey, route, request, transport, signal, connection = {}, diagnostic = null } = requireInvocation(input);
  const references = referencesFor(request);
  const payload = body(request, references);
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
  });
  const response = await transport.requestJson(generationUrl(endpoint, route), diagnosticRequestOptions({
    method: 'POST', headers: headers(endpoint, route, apiKey), body: JSON.stringify(payload), signal,
  }, diagnostic, { bodyKind: 'json', wireFields: ['contents', 'generationConfig', 'responseModalities', ...(payload.generationConfig.imageConfig ? ['imageConfig'] : [])] }), route, connection.timeoutMs);
  return parse(await readJsonResponse(response, 'Gemini Native'));
}
