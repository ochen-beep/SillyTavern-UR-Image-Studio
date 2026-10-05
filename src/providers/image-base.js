// @ts-check
import { trace, warn } from '../core.js';
import { assertReferenceByteBudget } from '../reference-limits.js';
import { recoverJsonFromClone, recoverTextFromClone } from '../decompress-body.js';
import { getProviderDescriptor } from '../provider-descriptors.js';

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/i;

// Shared aspect-ratio → size table for the OpenAI-compatible size taxonomy
// (1024/1536 slots). Used verbatim by gpt-image-* and by Pollinations (which
// proxies the same size vocabulary). dall-e-3 has its own taxonomy and keeps
// a per-adapter table (image-openai.js).
export const ASPECT_SIZES = new Map([
    ['1:1', '1024x1024'],
    // Portrait
    ['2:3', '1024x1536'], ['3:4', '1024x1536'], ['4:5', '1024x1536'], ['9:16', '1024x1536'],
    // Landscape
    ['3:2', '1536x1024'], ['4:3', '1536x1024'], ['5:4', '1536x1024'], ['16:9', '1536x1024'],
    // Ultrawide landscape - closest 2K landscape slot.
    ['21:9', '1536x1024'],
]);

// ── Распаковка тел ответов вынесена в ../decompress-body.js (пункт 2.4) ──
// Общий кодек-сниффер (gzip/zstd/deflate) и двухфазное восстановление живут
// там одним экземпляром: тот же кодек-набор обслуживает catalog.js.

export async function readResponseText(response) {
  if (!response) return '';
  const clone = typeof response.clone === 'function' ? response.clone() : null;
  if (clone) {
    const decoded = await recoverTextFromClone(clone);
    if (decoded != null) return decoded;
  }
  try {
    if (typeof response.text === 'function') return await response.text();
    if (typeof response.json === 'function') return JSON.stringify(await response.json());
  } catch { /* best effort */ }
  return '';
}

export class ImageProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImageProviderError';
    this.code = code;
  }
}

export function providerError(code, message) {
  return new ImageProviderError(code, message);
}

export function requireInvocation(input) {
  if (!input || typeof input !== 'object') throw providerError('INVALID_IMAGE_REQUEST', 'Image provider invocation is invalid.');
  if (typeof input.endpoint !== 'string' || !input.endpoint.trim()) throw providerError('INVALID_IMAGE_REQUEST', 'Image provider endpoint is required.');
  assertApiKeyForContract(input.route?.generationContract, input.apiKey);
  if (!input.route || typeof input.route !== 'object' || typeof input.route.modelId !== 'string' || !input.route.modelId.trim()) {
    throw providerError('INVALID_ROUTE', 'The selected image route is incomplete.');
  }
  if (!input.transport || typeof input.transport.requestJson !== 'function' || typeof input.transport.requestMultipart !== 'function') {
    throw providerError('INVALID_TRANSPORT', 'Image transport is unavailable.');
  }
  return input;
}

/**
 * Наличие ключа — по дескриптору контракта (пункт 2.3): ветки по имени
 * контракта удалены. Форма токена (sk_ у Pollinations и т.п.) валидируется
 * адаптером; здесь только присутствие и типизированная ошибка отсутствия.
 * @param {string|undefined} contract
 * @param {string|undefined} apiKey
 */
export function assertApiKeyForContract(contract, apiKey) {
  const auth = getProviderDescriptor(contract)?.auth || null;
  // required: false (ComfyUI) — ключ опционален, адаптер использует его сам.
  if (auth?.required === false) return;
  if (typeof apiKey === 'string' && apiKey.trim()) return;
  if (auth?.missingError) {
    const error = providerError(auth.missingError.code, auth.missingError.message);
    error.authCode = 'AUTH_REQUIRED';
    error.reauthRequired = true;
    throw error;
  }
  throw providerError('MISSING_API_KEY', 'An API key is required for the selected image connection.');
}

export function parseDataUrl(reference) {
  const value = typeof reference === 'string' ? reference : reference?.dataUrl;
  const match = DATA_URL.exec(value || '');
  if (!match || match[2].length % 4 !== 0) throw providerError('INVALID_REFERENCE', 'Reference image must be a valid base64 image data URL.');
  return {
    dataUrl: value,
    mimeType: match[1].toLowerCase(),
    data: match[2],
    ...(typeof reference?.description === 'string' && reference.description.trim()
      ? { description: reference.description.trim().slice(0, 2000) }
      : {}),
  };
}

export function referencesFor(request) {
  const references = request?.references ?? [];
  if (!Array.isArray(references)) throw providerError('INVALID_REFERENCE', 'References must be an array.');
  const parsed = references.map(parseDataUrl);
  try {
    assertReferenceByteBudget(parsed);
  } catch (error) {
    const wrapped = providerError(error.code || 'REFERENCE_BYTE_BUDGET_EXCEEDED', error.message);
    wrapped.bytes = error.bytes;
    wrapped.limit = error.limit;
    throw wrapped;
  }
  return parsed;
}

/**
 * Guard the adapter boundary against silently omitted reference parts.
 * The payload has already been built, so this checks the exact representation
 * that is about to be sent rather than the logical request count alone.
 */
export function assertEncodedReferenceCount(expected, encoded, encoding) {
  if (expected !== encoded) {
    throw providerError(
      'REFERENCE_ENCODING_MISMATCH',
      `Reference encoding mismatch for ${encoding}: expected ${expected}, encoded ${encoded}.`,
    );
  }
}

/** Enforce the persisted route's reference contract before any provider dispatch. */
export function assertReferencePolicy(route, request) {
  const references = request?.references ?? [];
  if (!Array.isArray(references)) throw providerError('INVALID_REFERENCE', 'References must be an array.');
  const capabilities = route?.capabilities || {};
  if (references.length && (capabilities.references === 'unsupported' || capabilities.maxReferences === 0)) {
    throw providerError('REFERENCES_UNSUPPORTED', 'Selected image route does not support references.');
  }
  if (Number.isSafeInteger(capabilities.maxReferences) && references.length > capabilities.maxReferences) {
    throw providerError('TOO_MANY_REFERENCES', 'Too many reference images for the selected image route.');
  }
}

function safeJsonParse(text) {
    try { return JSON.parse(text); } catch { return null; }
}

function extractErrorDetail(payload) {
    if (typeof payload?.error?.message === 'string') return payload.error.message;
    if (typeof payload?.error === 'string') return payload.error;
    // OpenAI-совместимые шлюзы отвечают и не под `error`: семейство new-api /
    // one-api кладёт причину в top-level `message` ({"success":false,"message":…}),
    // FastAPI-образные — в `detail` / `error.details`. Всё читается только на
    // не-2xx пути, где success-тел с посторонним `message` не бывает.
    if (typeof payload?.message === 'string') return payload.message;
    if (typeof payload?.detail === 'string') return payload.detail;
    if (typeof payload?.error?.details === 'string') return payload.error.details;
    return '';
}

export function diagnosticRequestOptions(options = {}, diagnostic = null, patch = {}) {
  if (!diagnostic && !Object.keys(patch).length) return options;
  return {
    ...options,
    __urisDiagnostic: {
      ...(diagnostic || {}),
      ...patch,
    },
  };
}

/**
 * Профиль авторизации контракта для readJsonResponse (пункт 2.3): коды
 * 401/403 берутся из descriptor.auth.statusCodes вместо регэкспа по display
 * name провайдера. Контракты без statusCodes получают UPSTREAM_HTTP_ERROR.
 * @param {string|undefined} contract
 * @returns {{statusCodes?: Record<number, string>}|null}
 */
export function authProfileFor(contract) {
  return getProviderDescriptor(contract)?.auth || null;
}

export async function readJsonResponse(response, provider, authProfile = null) {
  if (!response || typeof response.status !== 'number') throw providerError('UPSTREAM_RESPONSE_INVALID', `${provider} returned no response.`);
  if (response.status < 200 || response.status >= 300) {
    let detail = '';
    let raw = '';
    try {
      // Read text first so the raw body survives for the diagnostic log below;
      // response.json() would consume the stream and leave nothing to inspect.
      // Some minimal Response doubles (tests) expose only json(), so fall back.
      raw = await readResponseText(response);
      detail = extractErrorDetail(safeJsonParse(raw));
    } catch { /* status is sufficient */ }
    // Providers frequently put the actionable detail somewhere other than
    // `error.message` (a different field, an HTML page, a gateway banner). The
    // formatted error above only carries error.message, so log the truncated
    // raw body to keep the real reason visible in the panel. Truncated hard —
    // error bodies can be full HTML/CDN pages.
    if (raw) trace(`${provider}: HTTP ${response.status} raw body:`, raw.replace(/\s+/g, ' ').slice(0, 400));
    // Bearer-token contracts share the same 401/403 semantics: invalid token
    // vs expired/forbidden token, both demanding re-auth. Коды приходят из
    // дескриптора контракта (authProfileFor) — был регэксп по display name.
    const authCode = (response.status === 401 && authProfile?.statusCodes?.[401])
      || (response.status === 403 && authProfile?.statusCodes?.[403])
      || 'UPSTREAM_HTTP_ERROR';
    const error = providerError(authCode, `${provider} returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ''}.`);
    // Carry the numeric upstream status alongside the error so downstream
    // capability observers can classify auth/quota/provider-error without
    // regex over the message (the ST /proxy/ additionally remaps upstream
    // 401 to 400 to avoid clobbering browser Basic-auth; the status here is
    // the post-proxy status but the message preserves the upstream reason).
    error.httpStatus = Number.isSafeInteger(response.status) ? response.status : null;
    if (authCode !== 'UPSTREAM_HTTP_ERROR') error.reauthRequired = true;
    throw error;
  }
  // Clone before reading. A native Fetch Response becomes disturbed after
  // json(), so clone-after-failure masks the upstream parse/compression error
  // with "Response body is already used".
  const clone = typeof response.clone === 'function' ? response.clone() : null;
  try {
    return await response.json();
  } catch (parseError) {
    trace('readJsonResponse: response.json() threw, attempting compression recovery', provider);
    const recovered = await recoverJsonFromClone(clone, parseError);
    if (recovered != null) return recovered;
    throw providerError('UPSTREAM_RESPONSE_INVALID', `${provider} returned malformed JSON.`);
  }
}

// ── Image format detection from base64-encoded bytes ──
//
// OpenAI Images responses carry only { data: [{ b64_json }] } with no
// content_type field. Other providers (Imagen proxies, OpenRouter) return
// JPEG/WebP interchangeably. Hardcoding 'image/png' mislabels the data URL
// and breaks strict consumers (wrong file extension, validation failures).
// We sniff the decoded magic bytes instead - definitive for the four formats
// every supported provider emits. The cost is one atob() of 16 chars.
const IMAGE_MAGIC = [
  // PNG: 89 50 4E 47 0D 0A 1A 0A (RFC 2083 §11.2.2)
  { mime: 'image/png', match: b => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  // JPEG: FF D8 FF (SOI + marker start)
  { mime: 'image/jpeg', match: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  // WebP: RIFF....WEBP (12 bytes, WEBP at offset 8)
  { mime: 'image/webp', match: b => b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  // GIF: 47 49 46 38 (37|39) 61 (GIF8(7|9)a)
  { mime: 'image/gif', match: b => b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61 },
];

/**
 * Detect image MIME type from the first bytes of a base64-encoded string.
 * Returns null when no known format matches or the input is too short.
 * @param {string} b64
 * @returns {string | null}
 */
export function detectImageMimeFromBase64(b64) {
  if (typeof b64 !== 'string' || b64.length < 8) return null;
  // Decode enough chars for the longest signature (WebP = 12 bytes = 16 chars).
  const slice = b64.slice(0, 16);
  let bytes;
  try {
    if (typeof atob === 'function') {
      bytes = Uint8Array.from(atob(slice), c => c.charCodeAt(0));
    } else {
      bytes = new Uint8Array(Buffer.from(slice, 'base64'));
    }
  } catch { return null; }
  for (const { mime, match } of IMAGE_MAGIC) {
    if (match(bytes)) return mime;
  }
  return null;
}

export function imageResultFromValue(value, mimeType = null) {
  if (typeof value !== 'string' || !value) throw providerError('UPSTREAM_RESPONSE_INVALID', 'Image provider returned no image result.');
  if (value.startsWith('data:image/')) {
    const parsed = parseDataUrl(value);
    return { kind: 'dataUrl', value, mimeType: parsed.mimeType, warnings: [] };
  }
  if (/^https?:\/\//i.test(value)) return { kind: 'url', value, mimeType: null, warnings: [] };
  // Шлюзы шлют base64 с переносами строк (MIME-обёртка по 76 символов) —
  // нормализуем до валидации, иначе строгий регэксп отвергает корректные
  // байты (класс поломок «not correctly encoded», см. cherry-studio #14510).
  const normalized = value.replace(/\s+/g, '');
  if (!/^[a-z0-9+/]+={0,2}$/i.test(normalized) || normalized.length % 4 !== 0) throw providerError('UPSTREAM_RESPONSE_INVALID', 'Image provider returned invalid image data.');
  // Sniff the actual format from decoded magic bytes when the caller did not
  // supply an explicit MIME. Explicit MIME (e.g. Gemini's inlineData.mimeType,
  // OpenRouter's media_type) still wins - it is authoritative. Only when no
  // MIME is given do we sniff, falling back to 'image/png' for unknown formats
  // to preserve backwards compatibility.
  const sniffed = detectImageMimeFromBase64(normalized);
  const type = typeof mimeType === 'string' && mimeType.startsWith('image/') ? mimeType : (sniffed || 'image/png');
  return { kind: 'dataUrl', value: `data:${type};base64,${normalized}`, mimeType: type, warnings: [] };
}
