// Shared fixtures for the server image/store API client tests.
// These exercise the client facades in src/server-image-api.js and
// src/server-store-api.js; they talk to a mocked fetch, not a real server.

/**
 * Build a minimal fetch Response-like object returning `body` as JSON.
 * @param {any} body
 * @param {number} [status=200]
 * @returns {{ ok: boolean, status: number, json: () => Promise<any> }}
 */
export function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
}

// /status envelope that satisfies getServerImageApiStatus() validation:
// apiVersion 1 and every entry of REQUIRED_FEATURES true.
export const STATUS_FIXTURE = {
    apiVersion: 1,
    features: {
        connections: true,
        discovery: true,
        generation: true,
        requestRecovery: true,
    },
};

export const CONNECTION_FIXTURE = {
    id: 'id/a',
    name: 'Example',
    endpoint: 'https://example.test',
    apiFamily: 'auto',
};

export const PROBE_FIXTURE = {
    probeId: 'probe-1',
    routes: [{ id: 'openai', label: 'OpenAI' }],
};

export const GENERATION_FIXTURE = {
    requestId: 'request-1',
    status: 'pending',
};

export const REQUEST_STATUS_FIXTURE = {
    requestId: 'request/a',
    status: 'completed',
    artifacts: [],
};
