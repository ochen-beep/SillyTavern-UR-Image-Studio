const BASE_PATH = '/api/plugins/ur-image-studio/v1';
const REQUIRED_FEATURES = ['connections', 'discovery', 'generation', 'requestRecovery'];

export class ServerImageApiError extends Error {
  constructor({ code, message, retryable = false, diagnosticsId = null, httpStatus = null, warnings = null }) {
    super(message);
    this.name = 'ServerImageApiError';
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
    return new ServerImageApiError({
      code: typeof envelope.code === 'string' ? envelope.code : 'HTTP_ERROR',
      message: typeof envelope.message === 'string' ? envelope.message : 'Server image API request failed',
      retryable: envelope.retryable === true,
      diagnosticsId: typeof envelope.diagnosticsId === 'string' ? envelope.diagnosticsId : null,
      warnings: Array.isArray(envelope.warnings) ? envelope.warnings : null,
      httpStatus: response.status,
    });
  }
  return new ServerImageApiError({
    code: 'HTTP_ERROR',
    message: 'Server image API request failed',
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
    throw new ServerImageApiError({
      code: path === '/status' ? 'SERVER_COMPONENT_UNAVAILABLE' : 'NETWORK_ERROR',
      message: path === '/status' ? 'Server image component is unavailable' : 'Server image API request failed',
      retryable: cause?.name !== 'AbortError',
    });
  }
  const payload = await readJson(response);
  if (!response.ok) throw errorFromResponse(response, payload);
  return payload;
}

export async function getServerImageApiStatus(options = {}) {
  const result = await request('/status', options);
  if (result?.apiVersion !== 1 || !REQUIRED_FEATURES.every(feature => result?.features?.[feature] === true)) {
    throw new ServerImageApiError({
      code: 'SERVER_COMPONENT_INCOMPATIBLE',
      message: 'Server image API is incompatible with this client',
    });
  }
  return result;
}

export function listServerConnections(options = {}) {
  return request('/connections', options);
}

export function exportServerConnections(options = {}) {
  return request('/connections/export', options);
}

export function probeTransientConnection(input, options = {}) {
  return request('/connections/probe', { ...options, method: 'POST', body: input });
}

export function probeStoredConnection(connectionId, options = {}) {
  return request(`/connections/${encodeURIComponent(connectionId)}/probe`, { ...options, method: 'POST' });
}

export function createServerConnection(input, options = {}) {
  return request('/connections', { ...options, method: 'POST', body: input });
}

export function updateServerConnection(connectionId, input, options = {}) {
  return request(`/connections/${encodeURIComponent(connectionId)}`, { ...options, method: 'PUT', body: input });
}

export function deleteServerConnection(connectionId, options = {}) {
  return request(`/connections/${encodeURIComponent(connectionId)}`, { ...options, method: 'DELETE' });
}

export function generateServerImage(input, options = {}) {
  return request('/generate', { ...options, method: 'POST', body: input });
}

export function getServerRequest(requestId, options = {}) {
  return request(`/requests/${encodeURIComponent(requestId)}`, options);
}

export function importServerConnections(connections, options = {}) {
  return request('/connections/import', { ...options, method: 'POST', body: { connections } });
}

export function rollbackServerImport(importOperationId, rollbackToken, options = {}) {
  return request(`/connections/import/${encodeURIComponent(importOperationId)}/rollback`, { ...options, method: 'POST', body: { rollbackToken } });
}
