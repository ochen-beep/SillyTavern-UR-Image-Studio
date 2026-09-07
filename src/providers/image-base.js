// @ts-check
import { trace, warn, decodeZstdBytes } from '../core.js';
import { assertReferenceByteBudget } from '../reference-limits.js';

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/i;

// ── Transparent response decompression for /proxy/-forwarded bodies ──
//
// SillyTavern's /proxy/<url> middleware copies upstream headers verbatim.
// When the upstream is served behind Cloudflare/etc. that adds
// `Content-Encoding: br|gzip|deflate`, node's fetch has already decoded on
// its side; depending on what the proxy then re-encodes, the browser-facing
// Response is one of:
//   * already-decompressed bytes with a stale `Content-Encoding` header
//     (browser then tries to auto-decompress again → JSON.parse fails on
//      binary-looking input);
//   * raw upstream bytes (gzip/zstd magic at the head) because the proxy
//     did not set the Content-Encoding header — browser doesn't auto-decode
//     → JSON.parse fails on raw compression bytes.
//
// Either way, the underlying upstream payload is JSON. We sniff the magic
// bytes from a fresh clone and decompress when they match a known format:
// gzip/deflate via the Web DecompressionStream API, zstd via the shared
// decodeZstdBytes helper (core.js: native DecompressionStream('zstd') where
// the browser has it, else the vendored fzstd polyfill). When nothing works
// we fall back to lossy UTF-8 preview + UPSTREAM_RESPONSE_INVALID. This is
// the only place image providers read the body, so doing it here covers the
// Catalog probe, OpenAI/Gemini/OpenRouter/ChatCompletions generation paths
// uniformly.
//
// NOTE: brotli has NO magic bytes and no browser implements
// DecompressionStream('br') — there is nothing to sniff or decode for it.
// This table carried a 'brotli'/'br' entry until 2026-08: the `28 b5 2f fd`
// signature is actually the zstd frame magic (RFC 8878), and routing it to
// the nonexistent 'br' codec is exactly why proxy-delivered bodies from
// fuzhan.magicv4.ltd died here (runbook 2026-07-11, console logs 2026-08-06).
const MAGIC = [
  // RFC 1952 gzip. Two fixed bytes + optional method/flags/timestamp.
  { name: 'gzip', codec: 'gzip', match: b => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b },
  // RFC 8878 zstd frame magic (0xFD2FB528, little-endian). codec: null marks
  // "decode via decodeZstdBytes", not via DecompressionStream.
  { name: 'zstd', codec: null, match: b => b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd },
  // RFC 1950 zlib (deflate-with-zlib-header). First byte's low 4 bits are
  // the compression method (always 8 for deflate), upper 4 bits are the
  // window-size log2 minus 8 (commonly 7 → 0x78). Second byte's complement
  // check: (b0*256 + b1) % 31 === 0.
  { name: 'deflate', codec: 'deflate', match: b => b.length >= 2 && b[0] === 0x78 && (b[0] * 256 + b[1]) % 31 === 0 },
];

function headHex(bytes, n = 8) {
  return Array.from(bytes.slice(0, n)).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

async function decompressEntry(bytes, { name, codec }) {
  // zstd: DecompressionStream('zstd') only exists in recent Chromium, so the
  // shared helper feature-detects it and falls back to the fzstd polyfill.
  if (codec === null) {
    const out = await decodeZstdBytes(bytes);
    if (out == null) {
      warn('readJsonResponse: zstd body present but no decoder succeeded');
      return null;
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(out);
    trace('readJsonResponse: zstd decompressed OK, len=', text.length);
    return text;
  }
  if (typeof DecompressionStream !== 'function') {
    warn(`readJsonResponse: ${name} body present but DecompressionStream unavailable`);
    return null;
  }
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(codec));
    const decoded = await new Response(stream).text();
    trace(`readJsonResponse: ${name} decompressed OK, len=`, decoded.length);
    return decoded;
  } catch (e) {
    warn(`readJsonResponse: ${name} decompression threw:`, e?.message || e);
    return null;
  }
}

async function recoverJsonFromClone(clone, originalParseError) {
  if (!clone) return null;
  let bytes;
  try {
    const buf = typeof clone.arrayBuffer === 'function'
      ? await clone.arrayBuffer()
      : new TextEncoder().encode(await clone.text()).buffer;
    bytes = new Uint8Array(buf);
  } catch (e) {
    warn('readJsonResponse: arrayBuffer/text read failed:', e?.message || e);
    return null;
  }
  trace('readJsonResponse: bytes.length=', bytes.length, 'head=', headHex(bytes));
  const plainText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  try { return JSON.parse(plainText); } catch { /* compressed or non-JSON */ }
  // Phase 1 — magic-matched decompression. Cheap, O(1) check per codec,
  // and consumes nothing when signatures don't match.
  for (const entry of MAGIC) {
    if (entry.match(bytes)) {
      const decoded = await decompressEntry(bytes, entry);
      if (decoded != null) {
        try { return JSON.parse(decoded); }
        catch (e) {
          warn(`readJsonResponse: ${entry.name} decompressed but JSON.parse failed:`, e?.message || e);
          return null;
        }
      }
      // Magic matched but decode failed → corrupt/truncated frame. The
      // magics are mutually exclusive, so no other codec claims these bytes;
      // commit to "this was compression we couldn't read" and surface the
      // parse error instead of scanning further.
      break;
    }
  }
  // Phase 2 — opportunistic fallback. Rare encoders emit valid compression
  // streams whose first bytes don't match the magic above (e.g. deflate-raw).
  // The body already failed JSON.parse, so trying each remaining codec costs
  // at most three quick decode attempts on a rare recovery path.
  for (const entry of MAGIC) {
    const decoded = await decompressEntry(bytes, entry);
    if (decoded != null) {
      try { return JSON.parse(decoded); }
      catch { /* try next codec */ }
    }
  }
  return null;
}

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

async function recoverTextFromClone(clone) {
  let bytes;
  try {
    const buf = typeof clone.arrayBuffer === 'function'
      ? await clone.arrayBuffer()
      : new TextEncoder().encode(await clone.text()).buffer;
    bytes = new Uint8Array(buf);
  } catch { return null; }
  const plain = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (plain && !MAGIC.some(entry => entry.match(bytes))) return plain;
  for (const entry of MAGIC) {
    if (!entry.match(bytes)) continue;
    const decoded = await decompressEntry(bytes, entry);
    if (decoded != null) return decoded;
  }
  return plain;
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
  if (typeof input.apiKey !== 'string' || !input.apiKey.trim()) {
    if (input.route?.generationContract === 'pollinations-images') {
      const error = providerError('POLLINATIONS_TOKEN_REQUIRED', 'Pollinations requires an sk_ access token in the connection Key field.');
      error.authCode = 'AUTH_REQUIRED';
      error.reauthRequired = true;
      throw error;
    }
    if (input.route?.generationContract === 'naistera') {
      const error = providerError('NAISTERA_TOKEN_REQUIRED', 'Naistera requires a token from the Telegram bot in the connection Key field.');
      error.authCode = 'AUTH_REQUIRED';
      error.reauthRequired = true;
      throw error;
    }
    throw providerError('MISSING_API_KEY', 'An API key is required for the selected image connection.');
  }
  if (!input.route || typeof input.route !== 'object' || typeof input.route.modelId !== 'string' || !input.route.modelId.trim()) {
    throw providerError('INVALID_ROUTE', 'The selected image route is incomplete.');
  }
  if (!input.transport || typeof input.transport.requestJson !== 'function' || typeof input.transport.requestMultipart !== 'function') {
    throw providerError('INVALID_TRANSPORT', 'Image transport is unavailable.');
  }
  return input;
}

export function endpointBase(endpoint, suffix = '/v1') {
  const value = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!value) throw providerError('INVALID_ENDPOINT', 'Image provider endpoint is required.');
  if (/\/v1$/i.test(value)) return value;
  return `${value}${suffix}`;
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

export async function readJsonResponse(response, provider) {
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
    // vs expired/forbidden token, both demanding re-auth.
    const isBearerContract = /pollinations|naistera/i.test(String(provider || ''));
    const authCode = isBearerContract && response.status === 401
      ? 'AUTH_INVALID'
      : isBearerContract && response.status === 403
        ? 'AUTH_EXPIRED'
        : 'UPSTREAM_HTTP_ERROR';
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
  if (!/^[a-z0-9+/]+={0,2}$/i.test(value) || value.length % 4 !== 0) throw providerError('UPSTREAM_RESPONSE_INVALID', 'Image provider returned invalid image data.');
  // Sniff the actual format from decoded magic bytes when the caller did not
  // supply an explicit MIME. Explicit MIME (e.g. Gemini's inlineData.mimeType,
  // OpenRouter's media_type) still wins - it is authoritative. Only when no
  // MIME is given do we sniff, falling back to 'image/png' for unknown formats
  // to preserve backwards compatibility.
  const sniffed = detectImageMimeFromBase64(value);
  const type = typeof mimeType === 'string' && mimeType.startsWith('image/') ? mimeType : (sniffed || 'image/png');
  return { kind: 'dataUrl', value: `data:${type};base64,${value}`, mimeType: type, warnings: [] };
}

export function firstImageResult(payload, fields = []) {
  for (const field of fields) {
    const value = field(payload);
    if (typeof value === 'string' && value) return imageResultFromValue(value, field.mimeType?.(payload) ?? null);
  }
  throw providerError('UPSTREAM_RESPONSE_INVALID', 'Image provider returned a successful response without an image.');
}
