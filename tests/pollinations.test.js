// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { invokeImageProvider } from '../src/image-provider-registry.js';
import { CONTRACTS, normalizeRouteContract } from '../src/image-connection-schema.js';
import { resolveDispatchPlan } from '../src/dispatch-plan.js';
import { probeConnection } from '../src/connect-probe.js';
import { classifyUrl, scrubUrl } from '../src/netdump.js';
import { validatePollinationsToken } from '../src/providers/image-pollinations.js';
import { assertReferenceByteBudget, MAX_REFERENCE_BYTES_PER_IMAGE, MAX_REFERENCE_BYTES_TOTAL } from '../src/reference-limits.js';

function route(modelId = 'flux') {
    return {
        contractVersion: 1,
        generationContract: CONTRACTS.POLLINATIONS_IMAGES,
        modelId,
        capabilities: { generate: 'unknown', references: 'unsupported', edit: 'unsupported' },
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

function transport(result) {
    const calls = [];
    return {
        calls,
        requestJson: async (url, options, savedRoute, timeoutMs) => {
            calls.push({ url: String(url), options, route: savedRoute, timeoutMs });
            return result;
        },
        requestMultipart: async () => { throw new Error('Pollinations must not use multipart'); },
    };
}

test('Pollinations token accepts sk_ and rejects pk_, empty, and malformed values', () => {
    assert.equal(validatePollinationsToken(' sk_live_test '), 'sk_live_test');
    for (const value of ['', 'pk_client', 'token', 'sk_ with-space']) {
        assert.throws(() => validatePollinationsToken(value), error =>
            error?.code === (value ? 'POLLINATIONS_TOKEN_INVALID' : 'POLLINATIONS_TOKEN_REQUIRED'));
    }
});

test('Pollinations adapter sends one bearer JSON generation request and parses b64_json', async () => {
    const calls = transport(response({ data: [{ b64_json: 'cG5n', media_type: 'image/png' }] }));
    const result = await invokeImageProvider({
        endpoint: 'https://gen.pollinations.ai',
        apiKey: 'sk_live_test',
        connection: { timeoutMs: 31000 },
        route: route('flux'),
        request: { prompt: 'A lighthouse', aspectRatio: '16:9', imageSize: '2K', quality: 'high', references: [] },
        transport: calls,
    });

    assert.deepEqual(result, { kind: 'dataUrl', value: 'data:image/png;base64,cG5n', mimeType: 'image/png', warnings: [] });
    assert.equal(calls.calls.length, 1);
    assert.equal(calls.calls[0].url, 'https://gen.pollinations.ai/v1/images/generations');
    assert.equal(calls.calls[0].options.headers.Authorization, 'Bearer sk_live_test');
    assert.deepEqual(JSON.parse(calls.calls[0].options.body), {
        model: 'flux', prompt: 'A lighthouse', n: 1,
        size: '1536x1024', resolution: '2k', quality: 'high',
    });
    assert.equal(calls.calls[0].timeoutMs, 31000);
});

test('Pollinations rejects references before the paid POST', async () => {
    const calls = transport(response({ data: [{ b64_json: 'cG5n' }] }));
    await assert.rejects(() => invokeImageProvider({
        endpoint: 'https://gen.pollinations.ai', apiKey: 'sk_live_test', route: route(),
        request: { prompt: 'Edit', references: [{ dataUrl: 'data:image/png;base64,cG5n' }] }, transport: calls,
    }), error => error?.code === 'REFERENCES_UNSUPPORTED');
    assert.equal(calls.calls.length, 0);
});

test('Pollinations contract normalizes and dispatch plan selects it by endpoint', () => {
    const normalized = normalizeRouteContract({
        generationContract: CONTRACTS.POLLINATIONS_IMAGES,
        source: 'pollinations-image-models',
        modelId: 'flux',
        capabilities: { references: 'unsupported', edit: 'unsupported' },
        remoteMetadata: { providerName: 'Pollinations', catalogSource: '/image/models', generationUnverified: true },
    });
    assert.equal(normalized.generationContract, CONTRACTS.POLLINATIONS_IMAGES);
    assert.equal(normalized.remoteMetadata.generationUnverified, true);

    const plan = resolveDispatchPlan({ endpoint: 'https://gen.pollinations.ai', model: { id: 'flux' } });
    assert.equal(plan.dialect, CONTRACTS.POLLINATIONS_IMAGES);
    assert.equal(plan.route.capabilities.references, 'unsupported');
});

test('Pollinations probe uses the public catalog without a generation request', async () => {
    const calls = [];
    const outcome = await probeConnection({
        endpoint: 'https://gen.pollinations.ai/v1',
        apiKey: 'sk_live_test',
        fetch: async (url, options) => {
            calls.push({ url: String(url), options });
            return response([
                { name: 'flux', category: 'image', output_modalities: ['image'] },
                { name: 'text-model', category: 'text', output_modalities: ['text'] },
            ]);
        },
        proxiedFetch: async () => { throw new Error('proxy must not be called'); },
    });

    assert.deepEqual(outcome.modelIds, ['flux']);
    assert.equal(outcome.modelMetadata.length, 1);
    assert.equal(outcome.modelMetadata[0].modelId, 'flux');
    assert.equal(outcome.modelMetadata[0].mediaKind, 'image');
    assert.equal(outcome.modelMetadata[0].imageGeneration, true);
    assert.equal(outcome.generationUnverified, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://gen.pollinations.ai/image/models');
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.headers.Authorization, undefined);
});

test('Pollinations upstream auth failures preserve typed status and never retry', async () => {
    for (const [status, code] of [[401, 'AUTH_INVALID'], [403, 'AUTH_EXPIRED']]) {
        const calls = transport(response({ error: { message: 'token rejected' } }, status));
        await assert.rejects(() => invokeImageProvider({
            endpoint: 'https://gen.pollinations.ai', apiKey: 'sk_live_test', route: route('flux'),
            request: { prompt: 'A lighthouse', references: [] }, transport: calls,
        }), error => error?.code === code && error.httpStatus === status && error.reauthRequired === true);
        assert.equal(calls.calls.length, 1);
    }
});

test('Pollinations adapter normalizes documented resolution and rejects unsupported quality', async () => {
    const calls = transport(response({ data: [{ b64_json: 'cG5n' }] }));
    await invokeImageProvider({
        endpoint: 'https://gen.pollinations.ai', apiKey: 'sk_live_test', route: route('flux'),
        request: { prompt: 'A lighthouse', imageSize: '2K', quality: 'auto', references: [] }, transport: calls,
    });
    const body = JSON.parse(calls.calls[0].options.body);
    assert.equal(body.resolution, '2k');
    assert.equal(body.quality, undefined);
});

test('reference byte budget rejects oversized image and aggregate payload', () => {
    const largePayload = 'A'.repeat(Math.ceil((MAX_REFERENCE_BYTES_PER_IMAGE + 4) * 4 / 3 / 4) * 4);
    const one = `data:image/png;base64,${largePayload}`;
    assert.throws(() => assertReferenceByteBudget([{ dataUrl: one }]), error => error?.code === 'REFERENCE_TOO_LARGE');
    const small = `data:image/png;base64,${'A'.repeat(1024)}`;
    const refs = Array.from({ length: 70000 }, () => ({ dataUrl: small }));
    assert.throws(() => assertReferenceByteBudget(refs), error => error?.code === 'REFERENCE_BYTE_BUDGET_EXCEEDED');
    assert.ok(MAX_REFERENCE_BYTES_TOTAL > MAX_REFERENCE_BYTES_PER_IMAGE);
});

test('Pollinations catalog netdump classifies /image/models as models', () => {
    assert.equal(classifyUrl('https://gen.pollinations.ai/image/models').kind, 'models');
    assert.equal(classifyUrl('/image/models?token=secret').url.includes('secret'), false);
});

test('diagnostic URL scrubbing removes query-token credentials', () => {
    assert.equal(scrubUrl('https://gen.pollinations.ai/image/flux?token=secret&safe=1'), 'https://gen.pollinations.ai/image/flux?token=%3Credacted%3E&safe=1');
    assert.equal(classifyUrl('https://gen.pollinations.ai/image/flux?key=secret').url.includes('secret'), false);
});
