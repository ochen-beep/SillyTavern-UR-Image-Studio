// @ts-check
/**
 * Browser facade for server-authoritative URIS collections.
 *
 * This deliberately mirrors `server-image-api.js`: same plugin base URL,
 * request-header source, and safe error-envelope handling. Domain modules use
 * this facade instead of browser-local persistence after their per-collection migration.
 */

const BASE_PATH = '/api/plugins/ur-image-studio/v1';

export class ServerStoreApiError extends Error {
  constructor({ code, message, retryable = false, diagnosticsId = null, httpStatus = null, warnings = null }) {
    super(message);
    this.name = 'ServerStoreApiError';
    this.code = code;
    this.retryable = Boolean(retryable);
    this.diagnosticsId = diagnosticsId;
    this.httpStatus = httpStatus;
    this.warnings = Array.isArray(warnings) ? warnings : null;
  }
}

function getCtx() {
  return globalThis.SillyTavern?.getContext?.() ?? {};
}

function headersFor(body) {
  const headers = { ...(getCtx().getRequestHeaders?.() ?? {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return headers;
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

function errorFromResponse(response, payload) {
  const envelope = payload?.error;
  if (envelope && typeof envelope === 'object') {
    return new ServerStoreApiError({
      code: typeof envelope.code === 'string' ? envelope.code : 'HTTP_ERROR',
      message: typeof envelope.message === 'string' ? envelope.message : 'Server store API request failed',
      retryable: envelope.retryable === true,
      diagnosticsId: typeof envelope.diagnosticsId === 'string' ? envelope.diagnosticsId : null,
      warnings: Array.isArray(envelope.warnings) ? envelope.warnings : null,
      httpStatus: response.status,
    });
  }
  return new ServerStoreApiError({
    code: 'HTTP_ERROR',
    message: 'Server store API request failed',
    httpStatus: response.status,
  });
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(`${BASE_PATH}${path}`, {
      method,
      headers: headersFor(body),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    throw new ServerStoreApiError({
      code: path === '/store/status' ? 'SERVER_COMPONENT_UNAVAILABLE' : 'NETWORK_ERROR',
      message: path === '/store/status' ? 'Server store component is unavailable' : 'Server store API request failed',
      retryable: cause?.name !== 'AbortError',
    });
  }
  const payload = await readJson(response);
  if (!response.ok) throw errorFromResponse(response, payload);
  return payload;
}

/** @param {string} value */
function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

/**
 * Get collection-store availability/status. The status endpoint is intentionally
 * separate from the main image API status: older server-plugin versions may
 * support image connections but not the durable store.
 */
export function getStoreStatus(options = {}) {
  return request('/store/status', options);
}

/** Get a whole collection (no pagination; UI caches it in memory). */
export async function listCollection(name, options = {}) {
  const payload = await request(`/store/${encodeSegment(name)}`, options);
  return payload?.[name];
}

/** Get one record by id, or reject with a typed 404 error when absent. */
export async function getRecord(name, id, options = {}) {
  const payload = await request(`/store/${encodeSegment(name)}/${encodeSegment(id)}`, options);
  return payload?.record;
}

/** Create one collection record. */
export async function createRecord(name, payload, options = {}) {
  const result = await request(`/store/${encodeSegment(name)}`, { ...options, method: 'POST', body: payload });
  return result?.record;
}

/** Replace one collection record. */
export async function updateRecord(name, id, payload, options = {}) {
  const result = await request(`/store/${encodeSegment(name)}/${encodeSegment(id)}`, { ...options, method: 'PUT', body: payload });
  return result?.record;
}

/** Delete one collection record. */
export function deleteRecord(name, id, options = {}) {
  return request(`/store/${encodeSegment(name)}/${encodeSegment(id)}`, { ...options, method: 'DELETE' });
}

/**
 * Replace a complete collection. Used only by idempotent migration after
 * read-back verification; normal UI mutations use record-level methods.
 */
export async function replaceWhole(name, value, options = {}) {
  const payload = await request(`/store/${encodeSegment(name)}`, {
    ...options,
    method: 'PUT',
    body: { value },
  });
  return payload?.[name];
}

/**
 * Upload an image through ST's native endpoint. It receives a normalized
 * payload (base64 bytes, format, ch_name, filename) and returns ST's portable
 * root-relative URL path (`user/images/<folder>/<filename>`).
 */
export async function uploadImage(input, { signal } = {}) {
  let response;
  try {
    response = await fetch('/api/images/upload', {
      method: 'POST',
      headers: headersFor(input),
      body: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    throw new ServerStoreApiError({
      code: 'NETWORK_ERROR',
      message: 'SillyTavern image upload request failed',
      retryable: cause?.name !== 'AbortError',
    });
  }
  const payload = await readJson(response);
  if (!response.ok) throw errorFromResponse(response, payload);
  return payload;
}

/**
 * List URIS-owned image files in a SillyTavern character-gallery folder.
 * ST `/api/images/list` returns basenames, not paths; this facade filters
 * `uris_` entries and constructs the portable root-relative `user/images/`
 * path that ST's media renderer expects.
 */
export async function listCharGallery(folder, { signal } = {}) {
  let response;
  try {
    response = await fetch('/api/images/list', {
      method: 'POST',
      headers: headersFor({ folder }),
      body: JSON.stringify({ folder }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    throw new ServerStoreApiError({
      code: 'NETWORK_ERROR',
      message: 'SillyTavern image-list request failed',
      retryable: cause?.name !== 'AbortError',
    });
  }
  const payload = await readJson(response);
  if (!response.ok) throw errorFromResponse(response, payload);
  if (!Array.isArray(payload)) return [];

  const encodedFolder = encodeSegment(folder);
  return payload
    .filter(filename => typeof filename === 'string' && filename.startsWith('uris_')
      && !filename.includes('/') && !filename.includes('\\'))
    .map(filename => ({
      filename,
      path: `user/images/${encodedFolder}/${encodeSegment(filename)}`,
    }));
}
