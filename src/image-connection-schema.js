// @ts-check
import { normalizeReferenceCap } from './reference-limits.js';

export const CONTRACTS = Object.freeze({
  OPENAI_IMAGES: 'openai-images',
  GEMINI_NATIVE: 'gemini-native',
  CHAT_COMPLETIONS: 'chat-completions',
  OPENROUTER_IMAGES: 'openrouter-images',
  POLLINATIONS_IMAGES: 'pollinations-images',
  NAISTERA: 'naistera',
  COMFYUI: 'comfyui',
});
export const ALLOWED_CONTRACTS = new Set(Object.values(CONTRACTS));
export const CAPABILITY_STATES = new Set(['supported', 'unsupported', 'unknown']);
export const CONNECTION_TIMEOUT_DEFAULT_MS = 120000;
export const CONNECTION_TIMEOUT_MIN_MS = 15000;
export const CONNECTION_TIMEOUT_MAX_MS = 600000;
const BODY_KINDS = new Set(['json', 'multipart']);
const DIRECT_CORS = new Set(['required', 'preferred']);
// Wire dialect for /images/edits, stated per connection. A model ID cannot
// describe a protocol: the same gpt-image-2 wants multipart on one gateway and
// JSON on another. 'multipart' is the conservative default (what the OpenAI
// Images API has always accepted, and what was observed returning HTTP 200);
// 'json' is the proxy-traversable variant for providers without CORS headers.
export const EDIT_PROTOCOLS = new Set(['multipart', 'json']);
// Optional extensions for image-capable Chat Completions gateways. This is
// intentionally explicit: a model name or generic OpenAI URL does not prove
// that the gateway accepts a non-standard request member, and the two
// documented dialects differ in both shape and key casing:
//   - 'openrouter': top-level `image_config: { aspect_ratio, image_size }`
//     plus `modalities: ['image','text']` (docs.openrouter.ai, image generation).
//   - 'new-api': `extra_body: { google: { image_config: { aspect_ratio,
//     image_size } } }` — the new-api relay software (the base most
//     OpenAI-compatible gateways run) forwards it to
//     generationConfig.imageConfig and silently
//     IGNORES the top-level OpenRouter shape; keys must be snake_case (camelCase
//     hard-fails the request conversion, verified live 2026-09-16).
export const CHAT_COMPLETIONS_IMAGE_CONFIGS = new Set(['openrouter', 'new-api']);
const SECRET_KEYS = new Set([
  'apikey', 'apitoken', 'xapikey', 'xapitoken', 'xgoogapikey', 'token', 'password', 'secret', 'secretid', 'credential', 'credentialid', 'authorization',
  'accesstoken', 'refreshtoken', 'bearertoken', 'clientsecret', 'privatekey',
]);

export function isSecretKey(key) {
  return SECRET_KEYS.has(String(key).replace(/[\s_-]/g, '').toLowerCase());
}

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
export function normalizeEndpoint(value) { return text(value).replace(/\/+$/, ''); }
function resolveContract(input) {
  const value = text(input.generationContract || input.contract || input.apiFamily || input.contractId);
  if (!ALLOWED_CONTRACTS.has(value) || /[\s;]|javascript:/i.test(value)) {
    throw new TypeError(`Unknown or unsafe contract: ${value || '(missing)'}`);
  }
  return value;
}

function fnv1a64(input, seed) {
  let hash = seed;
  for (let index = 0; index < input.length; index++) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

/** Browser-safe, synchronous stable route ID. This is an identifier, not a secret. */
export function deriveStableRouteId(source, model, contract) {
  const normalizedSource = text(source);
  const normalizedModel = text(model);
  const normalizedContract = text(contract);
  if (!normalizedSource || !normalizedModel || !ALLOWED_CONTRACTS.has(normalizedContract)) {
    throw new TypeError('source, model, and contract are required for route ID');
  }
  const input = `${normalizedSource}\0${normalizedModel}\0${normalizedContract}`;
  const first = fnv1a64(input, 0xcbf29ce484222325n).toString(16).padStart(16, '0');
  const second = fnv1a64(input, 0x84222325cbf29cen).toString(16).padStart(16, '0');
  return `route_${(first + second).slice(0, 24)}`;
}

export function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
    output[key] = stripSecrets(child);
  }
  return output;
}

const CAPABILITY_STATE_FIELDS = new Set(['generate', 'references', 'edit']);
const STRING_LIST_CAPABILITY_FIELDS = new Set(['supportedParameters', 'aspectRatios', 'imageSizes', 'qualityValues']);
const CAPABILITY_METADATA_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CAPABILITY_METADATA_STRING = /^[^\u0000-\u001F\u007F]{1,256}$/;
const SECRET_SHAPED_CAPABILITY_KEY = /(?:api[_-]?key|authorization|token|secret|password|credential|private[_-]?key)/i;
const NULLABLE_CAPABILITY_FIELDS = new Set(['maxReferences', ...STRING_LIST_CAPABILITY_FIELDS]);
const REMOTE_METADATA_FIELDS = Object.freeze({
  [CONTRACTS.GEMINI_NATIVE]: new Set(['geminiApiVersion', 'authStrategy', 'versionedBase']),
  [CONTRACTS.OPENROUTER_IMAGES]: new Set(['providerTag', 'providerName', 'supportedParameters']),
  [CONTRACTS.POLLINATIONS_IMAGES]: new Set(['providerName', 'catalogSource', 'generationUnverified']),
  [CONTRACTS.NAISTERA]: new Set(['providerName', 'catalogSource', 'mediaKind', 'generationUnverified']),
});
const NULLABLE_REMOTE_METADATA_FIELDS = new Set(['supportedParameters']);

function safeMetadataString(value, key) {
  const normalized = text(value);
  if (!normalized || !CAPABILITY_METADATA_STRING.test(normalized)) {
    throw new TypeError(`Invalid capability metadata: ${key}`);
  }
  return normalized;
}

function safeStringList(value, key) {
  if (!Array.isArray(value) || value.length > 64) throw new TypeError(`Invalid capability metadata: ${key}`);
  return value.map(item => safeMetadataString(item, key));
}

function normalizeRemoteMetadata(value, contract) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid remote metadata');
  const allowedFields = REMOTE_METADATA_FIELDS[contract] || new Set();
  const result = {};
  for (const [key, metadata] of Object.entries(value)) {
    if (isSecretKey(key) || SECRET_SHAPED_CAPABILITY_KEY.test(key)) throw new TypeError(`Secret-shaped remote metadata field: ${key}`);
    if (!allowedFields.has(key)) throw new TypeError(`Invalid remote metadata field: ${key}`);
    if (metadata === null && NULLABLE_REMOTE_METADATA_FIELDS.has(key)) {
      result[key] = null;
    } else if (key === 'supportedParameters') {
      result[key] = safeStringList(metadata, key);
    } else if (key === 'generationUnverified') {
      if (metadata !== true) throw new TypeError(`Invalid remote metadata field: ${key}`);
      result[key] = true;
    } else {
      result[key] = safeMetadataString(metadata, key);
    }
  }
  return result;
}

function normalizeContractVersion(value) {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value !== 1) throw new TypeError('Unsupported contract version');
  return value;
}

export function normalizeConnectionTimeoutMs(value = CONNECTION_TIMEOUT_DEFAULT_MS) {
  if (!Number.isSafeInteger(value) || value < CONNECTION_TIMEOUT_MIN_MS || value > CONNECTION_TIMEOUT_MAX_MS) {
    throw new TypeError(`timeoutMs must be a safe integer between ${CONNECTION_TIMEOUT_MIN_MS} and ${CONNECTION_TIMEOUT_MAX_MS}`);
  }
  return value;
}

function normalizeCapabilities(value) {
  const input = plain(value);
  const result = {};
  for (const [key, capability] of Object.entries(input)) {
    if (SECRET_SHAPED_CAPABILITY_KEY.test(key)) throw new TypeError(`Secret-shaped capability field: ${key}`);
    if (!CAPABILITY_METADATA_KEY.test(key)) throw new TypeError(`Invalid capability metadata key: ${key}`);

    if (capability === null && NULLABLE_CAPABILITY_FIELDS.has(key)) {
      result[key] = null;
    } else if (CAPABILITY_STATE_FIELDS.has(key)) {
      if (!CAPABILITY_STATES.has(capability)) throw new TypeError(`Invalid capability state: ${key}`);
      result[key] = capability;
    } else if (key === 'maxReferences') {
      if (!Number.isInteger(capability) || capability < 0) throw new TypeError('Invalid capability metadata: maxReferences');
      result[key] = normalizeReferenceCap(capability);
    } else if (STRING_LIST_CAPABILITY_FIELDS.has(key)) {
      result[key] = safeStringList(capability, key);
    } else if (typeof capability === 'string') {
      result[key] = safeMetadataString(capability, key);
    } else if (typeof capability === 'boolean') {
      result[key] = capability;
    } else if (Number.isInteger(capability) && capability >= 0) {
      result[key] = capability;
    } else if (Array.isArray(capability)) {
      result[key] = safeStringList(capability, key);
    } else {
      throw new TypeError(`Invalid capability metadata: ${key}`);
    }
  }
  for (const key of CAPABILITY_STATE_FIELDS) if (!result[key]) result[key] = 'unknown';
  return result;
}

export function normalizeRouteContract(value = {}) {
  const input = plain(value);
  const contract = resolveContract(input);
  const contractVersion = normalizeContractVersion(input.contractVersion);
  const source = text(input.source) || 'unknown';
  const model = text(input.modelId || input.model);
  if (!model) throw new TypeError('Route model is required');
  const bodyKind = input.bodyKind === undefined ? 'json' : input.bodyKind;
  if (!BODY_KINDS.has(bodyKind)) throw new TypeError(`Invalid bodyKind: ${bodyKind}`);
  const directCors = input.directCors === undefined ? 'preferred' : input.directCors;
  if (!DIRECT_CORS.has(directCors)) throw new TypeError(`Invalid directCors: ${directCors}`);
  if (bodyKind === 'multipart' && directCors !== 'required') {
    throw new TypeError('Multipart routes require direct CORS and cannot use the proxy');
  }
  const id = deriveStableRouteId(source, model, contract);
  const remoteMetadata = normalizeRemoteMetadata(input.remoteMetadata, contract);
  // `capabilityObservations` was a persisted per-route observation map. The
  // observer is diagnostic-only now (see capability-observer.js), so the field
  // is dropped here rather than carried forward: it is destructured out of
  // `safeInput` so previously-persisted maps are cleaned up on the next
  // normalize instead of lingering in extension settings forever.
  // `proxyEligible` / `allowProxyFallback` / route-level `noResubmit` were
  // retired with the 2026-09-28 delivery rework: the transport gates escalation
  // on the preflight oracle alone, so these flags gated nothing and are
  // destructured out of persisted records the same way.
  const { contract: _contract, generationContract: _generationContract, apiFamily: _apiFamily, capabilityObservations: _legacyObservations, proxyEligible: _proxyEligible, allowProxyFallback: _allowProxyFallback, noResubmit: _noResubmit, ...safeInput } = stripSecrets(input);
  return {
    ...safeInput,
    id,
    contractVersion,
    generationContract: contract,
    source,
    modelId: model,
    apiFamily: contract,
    capabilities: normalizeCapabilities(input.capabilities),
    ...(remoteMetadata === undefined ? {} : { remoteMetadata }),
    transport: {
      bodyKind,
      directCors,
    },
  };
}

// ── Connection v2 projection: model / detected / overrides / evidence ──
//
// The v2 read model derives the "what to generate with and how" facts from
// the new fields (model, detected, overrides, evidence) while still emitting
// the legacy route fields (selectedRoute, apiFamilyOverride, useCorsProxy,
// editProtocol) so the interim connection card and browserDeliveryRoute keep
// working until the Phase 2 card lands. dispatch-plan.js is the consumer of
// the new fields; it imports CONTRACTS from this module, so these helpers
// must NOT import from dispatch-plan (module cycle).

const API_SHAPE_VALUES = new Set(['openai', 'gemini', 'openrouter', 'pollinations', 'naistera', 'comfyui', 'unknown']);
const AUTH_STRATEGIES = new Set(['bearer', 'x-goog-api-key', 'query', 'pollinations-sk', 'pollinations-public', 'naistera-bearer', 'none', 'unknown']);
const DELIVERY_VALUES = new Set(['auto', 'proxy', 'direct', 'unknown']);
const REF_MODES = new Set(['auto', 'always', 'never']);
const EVIDENCE_REF_STATES = new Set(['confirmed', 'rejected']);
const MAX_DETECTED_MODEL_IDS = 500;
const MAX_DETECTED_MODEL_METADATA = 500;
const MAX_EVIDENCE_ENTRIES = 50;

function textOrNull(value) {
    const s = typeof value === 'string' ? value.trim() : '';
    return s || null;
}

function normalizeConnectionModel(value, legacy = {}) {
    const input = plain(value);
    const explicitId = textOrNull(input.id);
    if (explicitId) {
        return {
            id: explicitId,
            ...(textOrNull(input.label) ? { label: textOrNull(input.label) } : {}),
            source: input.source === 'manual' ? 'manual' : 'list',
        };
    }
    const manualId = textOrNull(legacy.manualModelId);
    if (manualId) return { id: manualId, source: 'manual' };
    const routeModelId = textOrNull(legacy.selectedRouteModelId);
    if (routeModelId) {
        return {
            id: routeModelId,
            ...(textOrNull(legacy.selectedRouteLabel) ? { label: legacy.selectedRouteLabel } : {}),
            source: 'list',
        };
    }
    return null;
}

function normalizeConnectionOverrides(value, legacy = {}) {
    const input = plain(value);
    const out = {};
    const imageConfig = textOrNull(input.chatCompletionsImageConfig);
    if (imageConfig && CHAT_COMPLETIONS_IMAGE_CONFIGS.has(imageConfig)) {
        out.chatCompletionsImageConfig = imageConfig;
    }
    const dialect = textOrNull(input.dialect);
    if (dialect && ALLOWED_CONTRACTS.has(dialect)) {
        out.dialect = dialect;
    } else {
        const legacyDialect = textOrNull(legacy.apiFamilyOverride);
        if (legacyDialect && ALLOWED_CONTRACTS.has(legacyDialect)) out.dialect = legacyDialect;
    }
    if (EDIT_PROTOCOLS.has(input.editProtocol)) out.editProtocol = input.editProtocol;
    else if (legacy.editProtocol === 'json') out.editProtocol = 'json';
    const delivery = textOrNull(input.delivery);
    if (delivery && delivery !== 'auto' && DELIVERY_VALUES.has(delivery)) out.delivery = delivery;
    else if (delivery == null && legacy.useCorsProxy === true) out.delivery = 'proxy';
    const refs = textOrNull(input.refs);
    if (refs && REF_MODES.has(refs) && refs !== 'auto') out.refs = refs;
    if (Number.isInteger(input.maxRefs) && input.maxRefs >= 0) {
        out.maxRefs = normalizeReferenceCap(input.maxRefs);
    }
    return out;
}

function normalizeConnectionDetected(value, legacyRoutes = [], legacyCheckedAt = null) {
    const input = plain(value);
    const ids = Array.isArray(input.modelIds)
        ? input.modelIds
        : legacyRoutes;
    const modelIds = ids
        .map(item => (typeof item === 'string' ? item.trim() : (item && typeof item === 'object' ? text(item.modelId) : '')))
        .filter(Boolean)
        .slice(0, MAX_DETECTED_MODEL_IDS);
    const rawMetadata = Array.isArray(input.modelMetadata) ? input.modelMetadata : [];
    const modelMetadata = rawMetadata.slice(0, MAX_DETECTED_MODEL_METADATA).flatMap(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const modelId = textOrNull(item.modelId || item.id);
        if (!modelId) return [];
        const references = item.references === 'supported' || item.references === 'unsupported' ? item.references : 'unknown';
        const maxReferences = Number.isSafeInteger(item.maxReferences) && item.maxReferences >= 0
            ? normalizeReferenceCap(item.maxReferences) : null;
        const mediaKind = ['image', 'video', 'text', 'chat', 'audio', 'embedding'].includes(item.mediaKind) ? item.mediaKind : null;
        const outputModalities = Array.isArray(item.outputModalities)
            ? item.outputModalities.filter(value => typeof value === 'string').map(value => value.trim().slice(0, 64)).filter(Boolean).slice(0, 64)
            : [];
        const supportedParameters = Array.isArray(item.supportedParameters)
            ? item.supportedParameters.filter(value => typeof value === 'string').map(value => value.trim().slice(0, 64)).filter(Boolean).slice(0, 64)
            : [];
        const imageSizes = Array.isArray(item.imageSizes)
            ? item.imageSizes.filter(value => typeof value === 'string').map(value => value.trim().slice(0, 64)).filter(Boolean).slice(0, 64)
            : [];
        const qualityValues = Array.isArray(item.qualityValues)
            ? item.qualityValues.filter(value => typeof value === 'string').map(value => value.trim().slice(0, 64)).filter(Boolean).slice(0, 64)
            : [];
        const imageGeneration = typeof item.imageGeneration === 'boolean' ? item.imageGeneration : null;
        const source = textOrNull(item.source);
        const provider = textOrNull(item.provider);
        return [{
            modelId,
            ...(textOrNull(item.label) ? { label: textOrNull(item.label) } : {}),
            references,
            ...(maxReferences !== null ? { maxReferences } : {}),
            ...(mediaKind ? { mediaKind } : {}),
            ...(outputModalities.length ? { outputModalities } : {}),
            ...(supportedParameters.length ? { supportedParameters } : {}),
            ...(imageSizes.length ? { imageSizes } : {}),
            ...(qualityValues.length ? { qualityValues } : {}),
            ...(imageGeneration !== null ? { imageGeneration } : {}),
            ...(source ? { source } : {}),
            ...(provider ? { provider } : {}),
        }];
    });
    return {
        apiShape: API_SHAPE_VALUES.has(input.apiShape) ? input.apiShape : 'unknown',
        auth: AUTH_STRATEGIES.has(input.auth) ? input.auth : 'unknown',
        delivery: DELIVERY_VALUES.has(input.delivery) ? input.delivery : 'unknown',
        modelIds,
        ...(modelMetadata.length ? { modelMetadata } : {}),
        ...(textOrNull(input.catalogSource) ? { catalogSource: textOrNull(input.catalogSource).slice(0, 96) } : {}),
        ...(textOrNull(input.catalogUrl) ? { catalogUrl: textOrNull(input.catalogUrl).slice(0, 512) } : {}),
        ...(Number.isSafeInteger(input.metadataCount) && input.metadataCount >= 0 ? { metadataCount: Math.min(input.metadataCount, MAX_DETECTED_MODEL_METADATA) } : {}),
        checkedAt: textOrNull(input.checkedAt) || textOrNull(legacyCheckedAt),
        ...(input.partial === true ? { partial: true } : {}),
        ...(input.generationUnverified === true ? { generationUnverified: true } : {}),
    };
}

function normalizeConnectionEvidence(value) {
    const input = plain(value);
    const out = {};
    let count = 0;
    for (const [modelId, entry] of Object.entries(input)) {
        if (count >= MAX_EVIDENCE_ENTRIES) break;
        const key = modelId.trim();
        const record = plain(entry);
        const dialect = textOrNull(record.dialect);
        if (!key || !dialect || !ALLOWED_CONTRACTS.has(dialect)) continue;
        const refs = textOrNull(record.refs);
        out[key] = {
            dialect,
            ...(refs && EVIDENCE_REF_STATES.has(refs) ? { refs } : {}),
            ...(Number.isInteger(record.n) && record.n >= 0 ? { n: record.n } : {}),
            ...(textOrNull(record.reason) ? { reason: record.reason.slice(0, 200) } : {}),
            ...(record.userConfirmed === true ? { userConfirmed: true } : {}),
            ...(textOrNull(record.ts) ? { ts: record.ts } : {}),
        };
        count += 1;
    }
    return out;
}

function normalizeConnectionExtraBody(value) {
    const input = plain(value);
    if (!Object.keys(input).length) return {};
    return stripSecrets(input);
}


export function normalizeConnectionRecord(value = {}) {
    const rawInput = plain(value);
    const stripped = stripSecrets(rawInput);
    // Легаси-поля опыта доставки/диалекта (жили в записи до переезда в
    // браузер-локальный localforage) вырезаются, чтобы не кочевали вечно.
    const { deliveryEvidence: _legacyDeliveryEvidence, editDialectEvidence: _legacyEditDialectEvidence, ...input } = stripped;
    const contractVersion = normalizeContractVersion(input.contractVersion);
    const routeInput = input.selectedRoute || input.modelRoute;
    const rawRouteInput = rawInput.selectedRoute || rawInput.modelRoute;
    const routeContract = routeInput ? (routeInput.generationContract || routeInput.contract || routeInput.apiFamily) : '';
    const legacyFamily = text(input.apiFamilyOverride || input.apiFamily);
    const selectedRoute = routeInput
        ? routeContract
        ? normalizeRouteContract({
            ...routeInput,
            ...(rawRouteInput?.remoteMetadata === undefined ? {} : { remoteMetadata: rawRouteInput.remoteMetadata }),
            generationContract: routeContract,
        })
        : {
            ...stripSecrets(plain(routeInput)),
            resolutionState: 'unresolved',
        }
        : null;
    const overrides = normalizeConnectionOverrides(input.overrides, {
        // Promote only the user's explicit dropdown choice; `apiFamily` is a
        // derived emission of this normalizer and would otherwise turn every
        // re-read into a pin that the first creation did not have.
        apiFamilyOverride: textOrNull(input.apiFamilyOverride),
        editProtocol: input.editProtocol,
        useCorsProxy: input.useCorsProxy,
    });
    const apiFamily = selectedRoute?.generationContract
        || overrides.dialect
        || (legacyFamily && legacyFamily !== 'auto' ? legacyFamily : null);
    if (apiFamily && !ALLOWED_CONTRACTS.has(apiFamily)) throw new TypeError(`Unknown or unsafe contract: ${apiFamily}`);
    const legacyRoutes = Array.isArray(input.routes) ? input.routes : [];
    const detected = normalizeConnectionDetected(
        input.detected,
        legacyRoutes,
        input.catalog && typeof input.catalog === 'object' ? input.catalog.fetchedAt : null,
    );
    return {
        ...input,
        endpoint: normalizeEndpoint(input.endpoint),
        timeoutMs: normalizeConnectionTimeoutMs(input.timeoutMs),
        contractVersion,
        apiFamily,
        selectedRoute,
        selectedRouteId: selectedRoute?.id || text(input.selectedRouteId || input.modelRouteId) || null,
        // v2 read model (consumed by dispatch-plan.js).
        model: normalizeConnectionModel(input.model, {
            manualModelId: input.manualModelId,
            selectedRouteModelId: selectedRoute?.modelId,
            selectedRouteLabel: selectedRoute?.label,
        }),
        detected,
        overrides,
        evidence: normalizeConnectionEvidence(input.evidence),
        // deliveryEvidence/editDialectEvidence переехали в браузер-локальный
        // localforage (delivery-evidence.js): факты машинно-сетевые и не должны
        // гулять с серверными настройками на другие машины. Устаревшие поля
        // старых записей вырезаются ниже вместе с прочим мусором.
        extraBody: normalizeConnectionExtraBody(input.extraBody),
        // Legacy emissions stay in sync with overrides so the interim card and
        // browserDeliveryRoute keep working (Phase 2 replaces the card).
        useCorsProxy: overrides.delivery === 'proxy',
        editProtocol: overrides.editProtocol === 'json' ? 'json' : 'multipart',
    };
}

