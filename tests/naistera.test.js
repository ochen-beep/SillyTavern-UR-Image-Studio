// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { invokeImageProvider } from '../src/image-provider-registry.js';
import { CONTRACTS, normalizeRouteContract } from '../src/image-connection-schema.js';
import { resolveDispatchPlan } from '../src/dispatch-plan.js';
import { discoverCatalog } from '../src/catalog.js';
import { probeConnection } from '../src/connect-probe.js';
import { classifyUrl } from '../src/netdump.js';
import { validateNaisteraToken } from '../src/providers/image-naistera.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'naistera');
const fixture = name => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

function route(modelId = 'nano-banana', capabilities = {}) {
    return {
        contractVersion: 1,
        generationContract: CONTRACTS.NAISTERA,
        modelId,
        capabilities: { generate: 'unknown', references: 'supported', edit: 'unsupported', maxReferences: 4, ...capabilities },
        transport: { bodyKind: 'json', proxyEligible: false, directCors: 'preferred' },
    };
}

function response(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json' },
        clone() { return response(body, status); },
        async json() { return body; },
        async text() { return JSON.stringify(body); },
    };
}

/** Transport double returning queued responses in order (per URL pattern optional). */
function transport(results) {
    const calls = [];
    const queue = Array.isArray(results) ? [...results] : [results];
    return {
        calls,
        requestJson: async (url, options, savedRoute, timeoutMs) => {
            calls.push({ url: String(url), options, route: savedRoute, timeoutMs });
            const result = typeof results === 'function' ? results(calls.length, String(url)) : queue.shift();
            if (!result) throw new Error('unexpected extra transport call');
            return result;
        },
        requestMultipart: async () => { throw new Error('Naistera must not use multipart'); },
    };
}

test('Naistera token accepts arbitrary non-empty shapes and rejects empty or whitespace', () => {
    assert.equal(validateNaisteraToken(' tg-bot-token-123 '), 'tg-bot-token-123');
    assert.throws(() => validateNaisteraToken(''), error => error?.code === 'NAISTERA_TOKEN_REQUIRED');
    assert.throws(() => validateNaisteraToken('   '), error => error?.code === 'NAISTERA_TOKEN_REQUIRED');
    assert.throws(() => validateNaisteraToken('token with spaces'), error => error?.code === 'NAISTERA_TOKEN_INVALID');
});

test('Naistera adapter handles a synchronous generate response without polling', async () => {
    const calls = transport(response(fixture('generate-sync.json')));
    const result = await invokeImageProvider({
        endpoint: 'https://naistera.org',
        apiKey: 'tg-token',
        connection: { timeoutMs: 30000 },
        route: route(),
        request: { prompt: 'A lighthouse', aspectRatio: '16:9', references: [] },
        transport: calls,
    });
    assert.equal(calls.calls.length, 1);
    assert.equal(calls.calls[0].url, 'https://naistera.org/api/generate');
    assert.equal(calls.calls[0].options.method, 'POST');
    assert.equal(calls.calls[0].options.headers.Authorization, 'Bearer tg-token');
    assert.deepEqual(JSON.parse(calls.calls[0].options.body), {
        prompt: 'A lighthouse', model: 'nano-banana', sync: false, aspect_ratio: '16:9',
    });
    assert.equal(result.kind, 'dataUrl');
    assert.equal(result.mimeType, 'image/png');
});

test('Naistera adapter polls a job to completion with read-only GETs', async () => {
    const calls = transport(call => {
        if (call === 1) return response(fixture('generate-accepted.json'));
        if (call === 2) return response(fixture('job-processing.json'));
        return response(fixture('job-completed.json'));
    });
    const result = await invokeImageProvider({
        endpoint: 'https://naistera.org',
        apiKey: 'tg-token',
        connection: { timeoutMs: 120000 },
        route: route(),
        request: { prompt: 'A lighthouse', references: [] },
        transport: calls,
    });
    assert.equal(calls.calls.length, 3);
    assert.equal(calls.calls[0].url, 'https://naistera.org/api/generate');
    assert.equal(calls.calls[1].url, 'https://naistera.org/api/generate/jobs/job_0123456789abcdef');
    assert.equal(calls.calls[2].url, 'https://naistera.org/api/generate/jobs/job_0123456789abcdef');
    for (const call of calls.calls.slice(1)) {
        assert.equal(call.options.method, 'GET');
        assert.equal(call.options.headers.Authorization, 'Bearer tg-token');
    }
    assert.equal(result.kind, 'dataUrl');
    assert.match(result.value, /^data:image\/jpeg;base64,/);
});

test('Naistera adapter accepts completed data_url responses', async () => {
    const calls = transport([
        response(fixture('generate-accepted.json')),
        response(fixture('job-completed.json')),
    ]);
    const result = await invokeImageProvider({
        endpoint: 'https://naistera.org',
        apiKey: 'tg-token',
        connection: { timeoutMs: 30000 },
        route: route(),
        request: { prompt: 'A lighthouse', references: [] },
        transport: calls,
    });
    assert.equal(result.kind, 'dataUrl');
    assert.match(result.value, /^data:image\/jpeg;base64,/);
});

test('Naistera polling timeout raises NAISTERA_JOB_TIMEOUT without a second POST', async () => {
    const calls = transport(call => call === 1
        ? response(fixture('generate-accepted.json'))
        : response(fixture('job-processing.json')));
    await assert.rejects(() => invokeImageProvider({
        endpoint: 'https://naistera.org',
        apiKey: 'tg-token',
        connection: { timeoutMs: 1 },  // deadline already reached after the POST
        route: route(),
        request: { prompt: 'A lighthouse', references: [] },
        transport: calls,
    }), error => error?.code === 'NAISTERA_JOB_TIMEOUT');
    assert.equal(calls.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('Naistera job failure surfaces the provider error detail', async () => {
    const calls = transport([
        response(fixture('generate-accepted.json')),
        response(fixture('job-failed.json')),
    ]);
    await assert.rejects(() => invokeImageProvider({
        endpoint: 'https://naistera.org',
        apiKey: 'tg-token',
        connection: { timeoutMs: 30000 },
        route: route(),
        request: { prompt: 'A lighthouse', references: [] },
        transport: calls,
    }), error => error?.code === 'NAISTERA_JOB_FAILED' && /content policy/.test(error.message));
});

test('Naistera upstream auth failures preserve typed status and never retry', async () => {
    for (const [status, code] of [[401, 'AUTH_INVALID'], [403, 'AUTH_EXPIRED']]) {
        const calls = transport(response(fixture('http-401.json'), status));
        await assert.rejects(() => invokeImageProvider({
            endpoint: 'https://naistera.org', apiKey: 'tg-token', route: route(),
            request: { prompt: 'A lighthouse', references: [] }, transport: calls,
        }), error => error?.code === code && error.httpStatus === status && error.reauthRequired === true);
        assert.equal(calls.calls.length, 1);
    }
});

test('Naistera missing token is typed as AUTH_REQUIRED before any transport call', async () => {
    const calls = transport(response(fixture('generate-sync.json')));
    await assert.rejects(() => invokeImageProvider({
        endpoint: 'https://naistera.org', apiKey: '', route: route(),
        request: { prompt: 'A lighthouse', references: [] }, transport: calls,
    }), error => error?.code === 'NAISTERA_TOKEN_REQUIRED' && error.authCode === 'AUTH_REQUIRED' && error.reauthRequired === true);
    assert.equal(calls.calls.length, 0);
});

test('Naistera sends references as data URLs and respects per-model cap', async () => {
    const calls = transport(response(fixture('generate-sync.json')));
    const dataUrl = 'data:image/png;base64,cG5n';
    await invokeImageProvider({
        endpoint: 'https://naistera.org',
        apiKey: 'tg-token',
        connection: { timeoutMs: 30000 },
        route: route('grok-pro', { maxReferences: 3 }),
        request: { prompt: 'Edit', aspectRatio: '1:1', references: [{ dataUrl }, { dataUrl }] },
        transport: calls,
    });
    const body = JSON.parse(calls.calls[0].options.body);
    assert.deepEqual(body.reference_objects, [{ image: dataUrl }, { image: dataUrl }]);
    assert.equal(body.reference_images, undefined);
    assert.equal(body.aspect_ratio, '1:1');

    // Over the cap → rejected before the paid POST.
    const capped = transport(response(fixture('generate-sync.json')));
    await assert.rejects(() => invokeImageProvider({
        endpoint: 'https://naistera.org', apiKey: 'tg-token', route: route('grok-pro', { maxReferences: 3 }),
        request: { prompt: 'Edit', references: [{ dataUrl }, { dataUrl }, { dataUrl }, { dataUrl }] },
        transport: capped,
    }), error => error?.code === 'TOO_MANY_REFERENCES');
    assert.equal(capped.calls.length, 0);

    // Model without reference support (NovelAI) → rejected before the POST.
    const unsupported = transport(response(fixture('generate-sync.json')));
    await assert.rejects(() => invokeImageProvider({
        endpoint: 'https://naistera.org', apiKey: 'tg-token', route: route('novelai', { references: 'unsupported', maxReferences: 0 }),
        request: { prompt: 'Edit', references: [{ dataUrl }] },
        transport: unsupported,
    }), error => error?.code === 'REFERENCES_UNSUPPORTED');
    assert.equal(unsupported.calls.length, 0);
});

test('Naistera endpoint with trailing /api is normalized', async () => {
    const calls = transport(response(fixture('generate-sync.json')));
    await invokeImageProvider({
        endpoint: 'https://naistera.org/api/',
        apiKey: 'tg-token',
        connection: { timeoutMs: 30000 },
        route: route(),
        request: { prompt: 'A lighthouse', references: [] },
        transport: calls,
    });
    assert.equal(calls.calls[0].url, 'https://naistera.org/api/generate');
});

test('Naistera dispatch plan selects the contract by endpoint and blocks edits', () => {
    const plan = resolveDispatchPlan({ endpoint: 'https://naistera.org', model: { id: 'nano-banana' } });
    assert.equal(plan.dialect, CONTRACTS.NAISTERA);
    assert.equal(plan.route.generationContract, CONTRACTS.NAISTERA);
    assert.equal(plan.route.capabilities.edit, 'unsupported');
    assert.equal(plan.route.transport.providerId, 'naistera');
});

test('Naistera catalog reads the token-scoped array, keeps image models, and maps capabilities', async () => {
    const requests = [];
    const result = await discoverCatalog({
        endpoint: 'https://naistera.org',
        contract: CONTRACTS.NAISTERA,
        apiKey: 'tg-token',
        fetch: async (url, options) => {
            requests.push({ url: String(url), options });
            return response(fixture('api-models.json'));
        },
        proxiedFetch: async () => { throw new Error('proxy must not be called'); },
    });
    assert.deepEqual(requests.map(item => item.url), ['https://naistera.org/api/models']);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer tg-token');
    // grok-video declares media_kind: video → filtered out of image routes.
    assert.deepEqual(result.models.map(model => model.modelId), ['nano-banana', 'grok-pro', 'novelai']);
    assert.equal(result.routes[0].generationContract, CONTRACTS.NAISTERA);
    assert.equal(result.routes[0].capabilities.maxReferences, 4);
    assert.equal(result.routes[2].capabilities.references, 'unsupported');
    assert.equal(result.routes[2].capabilities.maxReferences, 0);
    assert.equal(result.routes[0].remoteMetadata.providerName, 'Naistera');
});

test('Naistera probe reads the token-scoped catalog and reports a verified connection', async () => {
    const calls = [];
    const outcome = await probeConnection({
        endpoint: 'https://naistera.org',
        apiKey: 'tg-token',
        fetch: async (url, options) => {
            calls.push({ url: String(url), options });
            return response(fixture('api-models.json'));
        },
        proxiedFetch: async () => { throw new Error('proxy must not be called'); },
    });
    assert.equal(outcome.apiShape, 'naistera');
    assert.equal(outcome.auth, 'naistera-bearer');
    assert.deepEqual(outcome.modelIds, ['nano-banana', 'grok-pro', 'novelai']);
    assert.equal(outcome.generationUnverified, undefined);  // catalog proves the token
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://naistera.org/api/models');
    assert.equal(calls[0].options.method, 'GET');
});

test('Naistera probe rejects an unexpected catalog shape', async () => {
    await assert.rejects(() => probeConnection({
        endpoint: 'https://naistera.org',
        apiKey: 'tg-token',
        fetch: async () => response({ unexpected: true }),
        proxiedFetch: async () => { throw new Error('proxy must not be called'); },
    }), /unexpected \/api\/models shape/);
});

test('Naistera contract normalizes route metadata through the schema', () => {
    const normalized = normalizeRouteContract({
        generationContract: CONTRACTS.NAISTERA,
        source: 'naistera-models',
        modelId: 'nano-banana',
        capabilities: { references: 'supported', maxReferences: 4 },
        remoteMetadata: { providerName: 'Naistera', catalogSource: '/api/models', mediaKind: 'image', generationUnverified: true },
    });
    assert.equal(normalized.generationContract, CONTRACTS.NAISTERA);
    assert.equal(normalized.remoteMetadata.providerName, 'Naistera');
    assert.equal(normalized.remoteMetadata.mediaKind, 'image');
});

test('Naistera netdump classifies catalog and generation job URLs', () => {
    assert.equal(classifyUrl('https://naistera.org/api/models').kind, 'models');
    assert.equal(classifyUrl('https://naistera.org/api/generate').kind, 'image');
    assert.equal(classifyUrl('https://naistera.org/api/generate/jobs/job_123').kind, 'image');
});
