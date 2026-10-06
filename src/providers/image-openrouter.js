// @ts-check
import { trace } from '../core.js';
import { summarizeReference } from '../references.js';
import { imageResultFromValue, readJsonResponse, authProfileFor, referencesFor, requireInvocation, assertEncodedReferenceCount, diagnosticRequestOptions } from './image-base.js';
import { resolveEndpoint } from '../endpoint-utils.js';
import { getProviderDescriptor } from '../provider-descriptors.js';

const DESCRIPTOR = getProviderDescriptor('openrouter-images');

function parse(payload) {
  const first = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (typeof first?.b64_json === 'string' && first.b64_json) return imageResultFromValue(first.b64_json, first.media_type);
  if (typeof first?.url === 'string' && first.url) return imageResultFromValue(first.url);
  throw providerError('UPSTREAM_RESPONSE_INVALID', 'OpenRouter Images returned a successful response without an image.');
}

export async function generateOpenRouterImage(input) {
  const { endpoint, apiKey, route, request, transport, signal, connection = {}, diagnostic = null, parsedReferences } = requireInvocation(input);
  const references = parsedReferences ?? referencesFor(request);
  if (references.length && route?.capabilities?.references === 'unsupported') throw providerError('REFERENCES_UNSUPPORTED', 'Selected OpenRouter route does not support references.');
  const maxReferences = route?.capabilities?.maxReferences;
  if (Number.isSafeInteger(maxReferences) && references.length > maxReferences) throw providerError('TOO_MANY_REFERENCES', 'Too many reference images for the selected OpenRouter route.');
  const providerTag = route?.remoteMetadata?.providerTag;
  const remoteSupported = route?.remoteMetadata?.supportedParameters;
  const capabilitySupported = route?.capabilities?.supportedParameters;
  const supported = Array.isArray(remoteSupported)
    ? new Set(remoteSupported)
    : Array.isArray(capabilitySupported)
      ? new Set(capabilitySupported)
      : null;
  const supports = name => !supported || supported.has(name);
  const supportsValue = (name, value, capability) => {
    const allowed = route?.capabilities?.[capability];
    return supports(name) && (!Array.isArray(allowed) || allowed.includes(value));
  };
  if (references.length && !supports('input_references')) {
    throw providerError('REFERENCES_UNSUPPORTED', 'Selected OpenRouter route does not advertise reference image support.');
  }
  const payload = {
    model: route.modelId, prompt: String(request?.prompt || ''), n: 1,
    ...(typeof providerTag === 'string' && providerTag ? { provider: { only: [providerTag], allow_fallbacks: false } } : {}),
    ...(typeof request?.imageSize === 'string' && supportsValue('resolution', request.imageSize, 'imageSizes') ? { resolution: request.imageSize } : {}),
    ...(typeof request?.aspectRatio === 'string' && supportsValue('aspect_ratio', request.aspectRatio, 'aspectRatios') ? { aspect_ratio: request.aspectRatio } : {}),
    ...(typeof request?.quality === 'string' && supportsValue('quality', request.quality, 'qualityValues') ? { quality: request.quality } : {}),
    ...(references.length ? { input_references: references.map(({ dataUrl }) => ({ type: 'image_url', image_url: { url: dataUrl } })) } : {}),
  };
  const encodedReferences = payload.input_references?.length || 0;
  assertEncodedReferenceCount(references.length, encodedReferences, 'openrouter-input_references');
  trace('openrouter-images: outgoing payload', {
    rid: String(request?.requestId || '').slice(0, 8),
    model: route.modelId,
    op: references.length ? 'edit' : 'generate',
    delivery: request?.delivery || route?.transport?.initialDelivery || 'unknown',
    expectedRefs: references.length,
    encodedRefs: encodedReferences,
    refs: (request?.references || []).map(summarizeReference),
    parameters: {
      resolution: payload.resolution || null,
      aspect_ratio: payload.aspect_ratio || null,
      quality: payload.quality || null,
    },
  });
  const response = await transport.requestJson(`${resolveEndpoint(DESCRIPTOR, endpoint)}${DESCRIPTOR.endpoint.generationPath}`, diagnosticRequestOptions({
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal,
  }, diagnostic, { bodyKind: 'json', wireFields: Object.keys(payload), parameterSource: Array.isArray(remoteSupported) ? 'remoteMetadata.supportedParameters' : Array.isArray(capabilitySupported) ? 'route.capabilities.supportedParameters' : 'unknown' }), route, connection.timeoutMs);
  return parse(await readJsonResponse(response, 'OpenRouter Images', authProfileFor(route?.generationContract)));
}
