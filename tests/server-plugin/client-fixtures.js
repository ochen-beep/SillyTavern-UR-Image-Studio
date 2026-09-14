export const STATUS_FIXTURE = {
  ok: true,
  apiVersion: 1,
  features: {
    connections: true,
    discovery: true,
    generation: true,
    requestRecovery: true,
  },
  apiFamilies: ['openai-images', 'gemini-native', 'openrouter-images'],
};

export const CONNECTION_FIXTURE = {
  id: 'connection-1',
  name: 'Primary',
  endpoint: 'https://images.example.test/v1',
  modelRoute: { id: 'route-1', modelId: 'image-model', apiFamily: 'openai-images' },
};

export const PROBE_FIXTURE = {
  ok: true,
  normalizedEndpoint: 'https://images.example.test/v1',
  routes: [CONNECTION_FIXTURE.modelRoute],
  warnings: [],
};

export const GENERATION_FIXTURE = {
  requestId: 'request-1',
  state: 'ready',
  result: { kind: 'dataUrl', value: 'data:image/png;base64,abc', mimeType: 'image/png' },
  diagnosticsId: 'diag-1',
};

export const REQUEST_STATUS_FIXTURE = {
  requestId: 'request-1',
  state: 'claimed',
  diagnosticsId: null,
};

export function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}
