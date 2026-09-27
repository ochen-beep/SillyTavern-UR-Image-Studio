// @ts-check
import { trace } from '../core.js';
import { summarizeReference } from '../references.js';
import { endpointBase, imageResultFromValue, providerError, readJsonResponse, referencesFor, requireInvocation, assertEncodedReferenceCount, diagnosticRequestOptions, ASPECT_SIZES } from './image-base.js';
import { resolveWireGeometry, resolveWireQuality } from '../wire-params.js';

// Map all VALID_ASPECT_RATIOS (core.js) to OpenAI-compatible image sizes. The
// shared table lives in image-base.js (same vocabulary as Pollinations). The
// previous table only covered 5 ratios; selecting 3:4, 4:3, 4:5, 5:4 or 21:9
// used to omit `size` entirely, so the provider picked an aspect freely
// (often 9:16) and the user's choice was silently ignored.
//
// This table is now only the FALLBACK for gateways that publish no per-model
// manifest. When the route carries the model's own vocabulary
// (route.capabilities.imageSizes / supportedParameters — NanoGpt, OpenRouter),
// resolveWireGeometry (wire-params.js) picks the wire parameter from the
// manifest instead: model-specific WxH resolutions for Seedream, literal
// aspect strings for seedream-v5.0-pro, `aspect_ratio` for nano-banana. A new
// gateway that publishes a manifest therefore needs no code change here.
//
// Two size taxonomies exist and are NOT interchangeable:
//   - gpt-image-*: 1024x1024 | 1536x1024 | 1024x1536 (+ auto). 1792x1024 is
//     rejected by strict gateways.
//   - dall-e-3:    1024x1024 | 1792x1024 | 1024x1792. 1536x1024 does not
//     exist → HTTP 400 "invalid size".
// The family is derived from the model id; unknown families use the
// gpt-image table (the current gateway mainstream).
const ASPECT_SIZES_DALLE = new Map([
  ['1:1', '1024x1024'],
  // Landscape (dall-e-3's only wide slot)
  ['3:2', '1792x1024'], ['4:3', '1792x1024'], ['5:4', '1792x1024'], ['16:9', '1792x1024'], ['21:9', '1792x1024'],
  // Portrait
  ['2:3', '1024x1792'], ['3:4', '1024x1792'], ['4:5', '1024x1792'], ['9:16', '1024x1792'],
]);
const QUALITY_VALUES = new Set(['auto', 'low', 'medium', 'high']);
// dall-e speaks the legacy quality scale (standard/hd) and REJECTS the
// gpt-image values with HTTP 400. Both vocabularies are accepted as INPUT: the
// value is persisted per chat (and the external bridge only ever sends the
// intent scale), so it outlives a model switch, and mapping low/medium→standard
// + high→hd keeps a deliberate choice from being silently replaced by the
// provider default. 'auto' has no dall-e spelling — omitting the parameter IS
// "standard" — so it resolves to undefined instead of a warning.
// The list OFFERED per family lives in dispatch-plan VALID_PARAMS and is tied
// to this table by a contract test (tests/image-provider-adapters.test.js), so
// the two sides cannot drift apart again.
const DALLE_QUALITY_MAP = new Map([
  ['low', 'standard'], ['medium', 'standard'], ['high', 'hd'],
  ['standard', 'standard'], ['hd', 'hd'],
]);

/** dall-e family: its own size table and legacy quality vocabulary. */
function isDalleModel(route) {
  return /dall[-_. ]?e/i.test(String(route?.modelId || ''));
}

/**
 * The `quality` value that goes on the wire, or undefined to omit the
 * parameter. Unknown values are omitted, never guessed; paramWarnings reports
 * them to the user.
 *
 * @param {{modelId?: string}} route
 * @param {unknown} quality
 * @returns {string|undefined}
 */
function wireQuality(route, quality) {
  if (typeof quality !== 'string' || !quality) return undefined;
  if (!isDalleModel(route)) {
    // 'auto' is deliberately omitted (resolveWireQuality): it IS the provider
    // default, and gateways exist that reject the explicit value outright
    // (apihub 400 "quality is not supported", observed 2026-09).
    return resolveWireQuality(route, quality, QUALITY_VALUES);
  }
  if (quality === 'auto') return undefined;
  return DALLE_QUALITY_MAP.get(quality);
}

function generationUrl(endpoint) { return `${endpointBase(endpoint)}/images/generations`; }
function editUrl(endpoint) { return `${endpointBase(endpoint)}/images/edits`; }

function sizesForRoute(route) {
  return isDalleModel(route) ? ASPECT_SIZES_DALLE : ASPECT_SIZES;
}

/** Manifest-first wire geometry for the requested aspect ratio. */
function wireGeometry(route, request) {
  return resolveWireGeometry({ route, aspectRatio: request?.aspectRatio, fallbackTable: sizesForRoute(route) });
}

function generationBody(route, request, geometry = wireGeometry(route, request)) {
  const size = geometry.param === 'size' ? geometry.value : undefined;
  const aspectRatio = geometry.param === 'aspect_ratio' ? geometry.value : undefined;
  const quality = wireQuality(route, request?.quality);
  // output_format is intentionally omitted: gpt-image-1 defaults to PNG on
  // OpenAI, and other providers (Imagen proxies, etc.) may reject or ignore
  // the parameter. The response-side parser sniffs the actual format from
  // magic bytes, so whatever the provider returns is handled correctly.
  // response_format is deliberately NOT sent. It is a DALL-E compatibility
  // parameter that GPT Image models reject outright ("Unknown parameter:
  // 'response_format'" on strict gateways). GPT Image always
  // returns base64 anyway, and `parse` below accepts both b64_json and url, so
  // omitting it is strictly safer across providers.
  return {
    model: route.modelId,
    prompt: String(request?.prompt || ''),
    n: 1,
    ...(size ? { size } : {}),
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(quality ? { quality } : {}),
  };
}

// input_fidelity is documented ONLY for gpt-image-1. Sending it to any other
// model can hard-fail the request before generation: observed 2026-08-06, one
// strict gateway rejected `gpt-image-2` with HTTP 400 "The model
// 'gpt-image-2' does not support the 'input_fidelity' parameter", while a
// lenient gateway silently accepted it. The old
// prefix match (gpt-image-*) assumed future gpt-image-N models would inherit
// the parameter - gateways do not, so assume nothing: match exactly
// gpt-image-1 (tolerating aggregator namespace prefixes like
// "openai/gpt-image-1") and let every other model use the provider default.
// This mirrors the server adapter's allowlist
// (tests/server-openai-images.test.js, "unallowlisted models").
//
// NOTE: this pattern gates input_fidelity ONLY. It must never decide the wire
// protocol - see `editProtocol` below for why.
const GPT_IMAGE_MODEL = /(^|\/)gpt-image-1$/i;

/**
 * Choose the /images/edits dialect.
 *
 * A model ID does not describe a wire protocol. The same `gpt-image-2` wants
 * JSON on one gateway and multipart on another, so inferring the dialect from
 * the model name is guaranteed to be wrong for some provider. The dialect is a
 * property of the CONNECTION and must be stated explicitly.
 *
 * `multipart` is the baseline because it is what the OpenAI Images API has
 * always accepted and what actually returned HTTP 200 on the providers we have
 * observed. `json` is opt-in per connection (`editProtocol: 'json'`), which is
 * also the only dialect able to traverse the JSON-only ST /proxy/.
 *
 * @param {{ editProtocol?: string }} connection
 * @returns {'multipart'|'json'}
 */
function editProtocol(connection) {
  return connection?.editProtocol === 'json' ? 'json' : 'multipart';
}

// Multipart filenames must carry an extension consistent with the declared
// MIME: relay upstreams derive the expected file type from the filename, and a
// bare "image" name fails validation with "Image edit file content does not
// match its declared MIME type" even for perfectly valid bytes (observed
// 2026-09-09: same jpeg bytes → 400 as "image", 200 as "ref.jpg").
const FILE_EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function formData(route, request, references) {
  const form = new FormData();
  form.append('model', route.modelId);
  form.append('prompt', String(request?.prompt || ''));
  form.append('n', '1');
  // No response_format: GPT Image rejects it (see generationBody).
  // Edits stay on the `size` parameter only: `aspect_ratio` is verified for
  // the generations path (NanoGpt 2026-09), unverified for /images/edits, and
  // strict gateways reject unknown members on edits — so the geometry reaches
  // the wire as a size whenever the model speaks one.
  const geometry = wireGeometry(route, request);
  if (geometry.param === 'size') form.append('size', geometry.value);
  const quality = wireQuality(route, request?.quality);
  if (quality) form.append('quality', quality);
  if (GPT_IMAGE_MODEL.test(String(route.modelId || ''))) form.append('input_fidelity', 'high');
  references.forEach((reference, index) => form.append('image', new Blob([Uint8Array.from(atob(reference.data), c => c.charCodeAt(0))], { type: reference.mimeType }), `image_${index + 1}.${FILE_EXT_BY_MIME[reference.mimeType] || 'bin'}`));
  return form;
}

// JSON edit body for the OpenAI /v1/images/edits application/json variant.
// References are passed as images[].image_url data URLs, which the OpenAI spec
// explicitly accepts. Unlike multipart, this JSON body can traverse the ST CORS
// proxy, so it is the dialect to pick for providers that send no CORS headers.
// Selected per connection via `editProtocol: 'json'`.
function editJsonBody(route, request, references) {
  const geometry = wireGeometry(route, request);
  const quality = wireQuality(route, request?.quality);
  const body = {
    model: route.modelId,
    prompt: String(request?.prompt || ''),
    n: 1,
    images: references.map(ref => ({ image_url: ref.dataUrl })),
  };
  if (geometry.param === 'size') body.size = geometry.value;
  if (quality) body.quality = quality;
  if (GPT_IMAGE_MODEL.test(String(route.modelId || ''))) body.input_fidelity = 'high';
  return body;
}

function parse(payload) {
  const first = Array.isArray(payload?.data) ? payload.data[0] : null;
  // Use the provider's declared content_type when present (some proxies add
  // it); otherwise let imageResultFromValue sniff the format from magic bytes.
  if (typeof first?.b64_json === 'string' && first.b64_json) return imageResultFromValue(first.b64_json, first?.content_type ?? first?.mime_type ?? null);
  if (typeof first?.url === 'string' && first.url) return imageResultFromValue(first.url);
  throw providerError('UPSTREAM_RESPONSE_INVALID', 'OpenAI Images returned a successful response without an image.');
}

/**
 * Dispatch a JSON /v1/images/edits edit. Used both for the explicit
 * `editProtocol:'json'` connection and for the multipart→JSON proxy fallback
 * (when a multipart edit dies on the browser preflight and the connection
 * opted into the ST CORS proxy). The only difference between the two paths is
 * `proxyFirst`: a fallback retry must go through /proxy/ immediately — there
 * is no point re-trying the direct delivery that just failed — while an
 * explicit JSON edit keeps the user-chosen initial delivery.
 *
 * @param {object} args
 * @param {boolean} [args.proxyFirst=false] — force `initialDelivery:'proxy'`
 *   on the retried route so the paid POST cannot reach the provider directly.
 */
function sendJsonEdit({ endpoint, route, request, references, transport, headers, signal, connection, diagnostic, proxyFirst = false }) {
  // Stamp the wire dialect so the capability observer reports what actually
  // went out (also covers the multipart→JSON proxy fallback, which re-stamps
  // delivery to 'proxy' in the caller).
  if (request && typeof request === 'object') request.editDialect = 'json';
  const payload = editJsonBody(route, request, references);
  assertEncodedReferenceCount(references.length, payload.images.length, 'openai-images');
  const proxyRoute = proxyFirst
    ? {
        ...route,
        transport: { ...route.transport, initialDelivery: 'proxy', noResubmit: true, allowProxyFallback: false },
      }
    : route;
  return transport.requestJson(
    editUrl(endpoint),
    diagnosticRequestOptions(
      { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal },
      diagnostic,
      { bodyKind: 'json', ...(proxyFirst ? { attempt: 'proxy-fallback' } : {}), wireFields: ['model', 'prompt', 'n', 'images', ...(payload.size ? ['size'] : []), ...(payload.quality ? ['quality'] : []), ...(payload.input_fidelity ? ['input_fidelity'] : [])] },
    ),
    proxyRoute,
    connection.timeoutMs,
  );
}

/**
 * Whether a failed multipart edit may be retried as JSON through the ST CORS
 * proxy. This must stay strictly limited to a provably pre-flight failure:
 * `MULTIPART_CORS_REQUIRED` is raised only when the direct multipart POST never
 * reached the provider (the Authorization header forces a CORS preflight; on a
 * failed preflight the browser does not send the body, so nothing was billed).
 * Any HTTP response — even a 5xx — proves the POST arrived and may have been
 * paid for, and an abort/timeout means the outcome is unknown, so neither may
 * ever trigger a second attempt. The connection must have opted into the proxy
 * (useCorsProxy), because the JSON retry is only useful if it can actually
 * traverse the JSON-only ST /proxy/.
 */
function shouldFallbackToProxyJson(error, connection) {
  return error?.code === 'MULTIPART_CORS_REQUIRED' && connection?.useCorsProxy === true;
}

/**
 * Warnings for parameters this API cannot carry: an aspect ratio the manifest
 * and the static table both refuse, or a quality value the model does not
 * know, is dropped from the body today — surface that as a warning instead of
 * letting the user's selection silently vanish. 'auto' is not a dropped
 * value: it resolves to "omit the parameter", which the provider then fills
 * with its own default, so it never warns.
 */
function paramWarnings(route, request) {
  const warnings = [];
  if (request?.aspectRatio && wireGeometry(route, request).param === null) {
    warnings.push({ feature: 'Стороны', details: `соотношение ${request.aspectRatio} не поддерживается ни манифестом модели, ни таблицей шлюза — геометрия не передана, размер выберет провайдер` });
  }
  if (request?.quality && request.quality !== 'auto' && wireQuality(route, request.quality) === undefined) {
    warnings.push({ feature: 'Quality', details: `значение «${request.quality}» не поддерживается этой моделью — параметр опущен` });
  }
  return warnings;
}

export async function generateOpenAIImage(input) {
  const { endpoint, apiKey, route, request, transport, signal, connection = {}, diagnostic = null } = requireInvocation(input);
  const references = referencesFor(request);
  if (references.length && route?.capabilities?.references === 'unsupported') {
    throw providerError('REFERENCES_UNSUPPORTED', 'Selected OpenAI Images route does not support references.');
  }
  const maxReferences = route?.capabilities?.maxReferences;
  if (Number.isSafeInteger(maxReferences) && references.length > maxReferences) {
    throw providerError('TOO_MANY_REFERENCES', 'Too many reference images for the selected OpenAI Images route.');
  }
  // Diagnostic: what physically leaves the browser. The per-ref summary
  // (name/MIME/KB) proves the multipart/JSON body actually carries the images;
  // a bare count cannot distinguish "2 refs sent" from "2 empty blobs sent".
  trace('openai-images: outgoing payload', {
    rid: String(request?.requestId || '').slice(0, 8),
    model: route.modelId,
    op: references.length ? (editProtocol(connection) === 'json' ? 'edit-json' : 'edit-multipart') : 'generate',
    refs: (request?.references || []).map(summarizeReference),
  });
  const headers = { Authorization: `Bearer ${apiKey}` };
  let response;
  if (references.length) {
    if (editProtocol(connection) === 'json') {
      response = await sendJsonEdit({ endpoint, route, request, references, transport, headers, signal, connection, diagnostic });
    } else {
      // Multipart edit. When the direct multipart POST dies on the browser
      // preflight (provider sends no CORS headers) and the connection opted
      // into the ST CORS proxy, retry ONCE as JSON through /proxy/. Safe by
      // construction: MULTIPART_CORS_REQUIRED means the body never reached the
      // provider, so nothing was billed; the JSON retry then goes proxy-first
      // with noResubmit, so there is exactly one paid attempt total.
      if (request && typeof request === 'object') request.editDialect = 'multipart';
      const form = formData(route, request, references);
      const encodedReferences = typeof form.getAll === 'function' ? form.getAll('image').length : references.length;
      assertEncodedReferenceCount(references.length, encodedReferences, 'openai-multipart-images');
      try {
        response = await transport.requestMultipart(editUrl(endpoint), diagnosticRequestOptions({ method: 'POST', headers, body: form, signal }, diagnostic, { bodyKind: 'multipart', wireFields: ['model', 'prompt', 'n', 'image', ...(form.get('size') ? ['size'] : []), ...(form.get('quality') ? ['quality'] : []), ...(form.get('input_fidelity') ? ['input_fidelity'] : [])] }), route, connection.timeoutMs);
      } catch (error) {
        if (!shouldFallbackToProxyJson(error, connection)) throw error;
        // The JSON retry goes through /proxy/ (proxy-first) — stamp the actual
        // delivery so the observer log reads edit-json / proxy, not the
        // pre-dispatch plan (edit-multipart / direct). sendJsonEdit below
        // re-stamps editDialect to 'json'.
        if (request && typeof request === 'object') request.delivery = 'proxy';
        trace('openai-images: multipart blocked by preflight, retrying as JSON via proxy', {
          rid: String(request?.requestId || '').slice(0, 8),
          model: route.modelId,
          op: 'edit-json-fallback',
          refs: (request?.references || []).map(summarizeReference),
        });
        response = await sendJsonEdit({ endpoint, route, request, references, transport, headers, signal, connection, diagnostic, proxyFirst: true });
      }
    }
  } else {
    const geometry = wireGeometry(route, request);
    const payload = generationBody(route, request, geometry);
    response = await transport.requestJson(generationUrl(endpoint), diagnosticRequestOptions({ method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal }, diagnostic, { bodyKind: 'json', parameterSource: geometry.source, wireFields: ['model', 'prompt', 'n', ...(payload.size ? ['size'] : []), ...(payload.aspect_ratio ? ['aspect_ratio'] : []), ...(payload.quality ? ['quality'] : [])] }), route, connection.timeoutMs);
  }
  return { ...parse(await readJsonResponse(response, 'OpenAI Images')), warnings: paramWarnings(route, request) };
}
