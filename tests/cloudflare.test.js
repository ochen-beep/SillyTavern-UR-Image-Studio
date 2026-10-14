// @ts-check
// Cloudflare Workers AI (contract 'cloudflare-workers-ai'): адаптер, пробник,
// dispatch-plan, netdump. Факты контракта — docs/providers/cloudflare-workers-ai.md
// (вживую 2026-10-13: JSON base64 у flux-1-schnell; бинарный ответ у
// sdxl-lightning с ВРУЩИМ Content-Type; klein — multipart-only; sdxl-base
// сломан 408; CORS закрыт).
import test from 'node:test';
import assert from 'node:assert/strict';

import { invokeImageProvider } from '../src/image-provider-registry.js';
import { CONTRACTS } from '../src/image-connection-schema.js';
import { resolveDispatchPlan } from '../src/dispatch-plan.js';
import { probeConnection } from '../src/connect-probe.js';
import { classifyUrl } from '../src/netdump.js';
import { validateCloudflareToken, classifyCloudflareModel } from '../src/providers/image-cloudflare.js';

const ENDPOINT = 'https://api.cloudflare.com/client/v4/accounts/acc123';
const FLUX = '@cf/black-forest-labs/flux-1-schnell';
const SDXL = '@cf/bytedance/stable-diffusion-xl-lightning';

// Минимальные JPEG-байты (FF D8 FF …) — достаточно для magic-sniffing.
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString('base64');

function route(modelId = FLUX, capabilities = {}) {
    return {
        contractVersion: 1,
        generationContract: CONTRACTS.CLOUDFLARE_WORKERS_AI,
        modelId,
        capabilities: { generate: 'unknown', references: 'unknown', edit: 'unknown', ...capabilities },
        transport: { bodyKind: 'json', directCors: 'preferred' },
    };
}

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json' },
        clone() { return jsonResponse(body, status); },
        async json() { return body; },
        async text() { return JSON.stringify(body); },
    };
}

/** Бинарный ответ: Content-Type png, байты — JPEG (живая аномалия CF). */
function binaryResponse(bytes, contentType = 'image/png') {
    return {
        ok: true,
        status: 200,
        headers: { get: name => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
        clone() { return binaryResponse(bytes, contentType); },
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
        async text() { return ''; },
    };
}

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
        requestMultipart: async () => { throw new Error('Cloudflare adapter must not use multipart'); },
    };
}

function invoke(overrides = {}) {
    return invokeImageProvider({
        endpoint: ENDPOINT,
        apiKey: 'cf-token',
        connection: { timeoutMs: 30000 },
        route: route(),
        request: { prompt: 'A lighthouse', references: [] },
        ...overrides,
    });
}

test('Cloudflare token: non-empty без пробелов; форма не матчится', () => {
    assert.equal(validateCloudflareToken(' cfut_abc123 '), 'cfut_abc123');
    assert.equal(validateCloudflareToken('classic-40-hex-chars-ok-too'), 'classic-40-hex-chars-ok-too');
    assert.throws(() => validateCloudflareToken(''), e => e?.code === 'CLOUDFLARE_TOKEN_REQUIRED' && e.reauthRequired === true);
    assert.throws(() => validateCloudflareToken('has space'), e => e?.code === 'CLOUDFLARE_TOKEN_INVALID');
});

test('classifyCloudflareModel: flux=plain json, sdxl=img2img, klein=multipart, sdxl-base=broken', () => {
    assert.deepEqual(classifyCloudflareModel(FLUX), { input: 'json', references: 'unsupported', maxReferences: 0 });
    assert.deepEqual(classifyCloudflareModel(SDXL), { input: 'json', references: 'supported', maxReferences: 1 });
    assert.equal(classifyCloudflareModel('@cf/black-forest-labs/flux-2-klein-4b').input, 'multipart');
    assert.equal(classifyCloudflareModel('@cf/black-forest-labs/flux-2-dev').input, 'multipart');
    assert.equal(classifyCloudflareModel('@cf/stabilityai/stable-diffusion-xl-base-1.0').input, 'broken');
});

test('flux: happy path — JSON ответ result.image (base64), MIME sniffed из байтов', async () => {
    const calls = transport(jsonResponse({ success: true, result: { image: JPEG_B64 }, errors: [], messages: [] }));
    const result = await invoke({ transport: calls });
    assert.equal(calls.calls.length, 1);
    assert.equal(calls.calls[0].url, `${ENDPOINT}/ai/run/${FLUX}`);
    assert.equal(calls.calls[0].options.method, 'POST');
    assert.equal(calls.calls[0].options.headers.Authorization, 'Bearer cf-token');
    assert.deepEqual(JSON.parse(calls.calls[0].options.body), { prompt: 'A lighthouse' });
    assert.equal(result.kind, 'dataUrl');
    assert.match(result.value, /^data:image\/jpeg;base64,/);
    assert.equal(result.mimeType, 'image/jpeg');
});

test('flux: aspectRatio не уходит на провод (у flux нет size), но предупреждение есть', async () => {
    const calls = transport(jsonResponse({ success: true, result: { image: JPEG_B64 } }));
    const result = await invoke({ transport: calls, request: { prompt: 'x', aspectRatio: '16:9', quality: 'high', references: [] } });
    const body = JSON.parse(calls.calls[0].options.body);
    assert.equal(body.width, undefined);
    assert.equal(body.height, undefined);
    assert.equal(result.warnings.length, 2); // aspectRatio + quality
    assert.match(result.warnings[0], /aspectRatio was not sent/);
});

test('extraBody карточки мерджится в тело, prompt перебить нельзя', async () => {
    const calls = transport(jsonResponse({ success: true, result: { image: JPEG_B64 } }));
    await invoke({ transport: calls, connection: { timeoutMs: 30000, extraBody: { steps: 8, seed: 42, prompt: 'evil' } } });
    const body = JSON.parse(calls.calls[0].options.body);
    assert.deepEqual(body, { steps: 8, seed: 42, prompt: 'A lighthouse' });
});

test('sdxl-lightning: бинарный ответ — MIME по магическим байтам, не по заголовку', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3]);
    const calls = transport(binaryResponse(jpeg, 'image/png'));
    const result = await invoke({
        transport: calls,
        route: route(SDXL, { references: 'supported', maxReferences: 1 }),
        request: { prompt: 'A lighthouse', aspectRatio: '16:9', references: [] },
    });
    const body = JSON.parse(calls.calls[0].options.body);
    assert.deepEqual([body.width, body.height], [1216, 832]); // SDXL-слоты для 16:9
    assert.equal(result.kind, 'dataUrl');
    assert.equal(result.mimeType, 'image/jpeg', 'заголовок image/png врёт — байты JPEG');
});

test('sdxl: референс уходит как image_b64 с strength 0.75 по умолчанию', async () => {
    const calls = transport(jsonResponse({ success: true, result: { image: JPEG_B64 } }));
    const dataUrl = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')}`;
    await invoke({
        transport: calls,
        route: route(SDXL, { references: 'supported', maxReferences: 1 }),
        request: { prompt: 'Edit', references: [{ dataUrl }] },
    });
    const body = JSON.parse(calls.calls[0].options.body);
    assert.equal(body.image_b64, dataUrl.split(',')[1]);
    assert.equal(body.strength, 0.75);
});

test('референсы: flux — REFERENCES_UNSUPPORTED до платного POST; sdxl — не больше одного', async () => {
    const dataUrl = 'data:image/png;base64,cG5nAA==';
    const fluxCalls = transport(jsonResponse({ success: true, result: { image: JPEG_B64 } }));
    await assert.rejects(() => invoke({
        transport: fluxCalls,
        request: { prompt: 'Edit', references: [{ dataUrl }] },
    }), e => e?.code === 'REFERENCES_UNSUPPORTED');
    assert.equal(fluxCalls.calls.length, 0);

    const sdxlCalls = transport(jsonResponse({ success: true, result: { image: JPEG_B64 } }));
    await assert.rejects(() => invoke({
        transport: sdxlCalls,
        route: route(SDXL, { references: 'supported', maxReferences: 1 }),
        request: { prompt: 'Edit', references: [{ dataUrl }, { dataUrl }] },
    }), e => e?.code === 'TOO_MANY_REFERENCES');
    assert.equal(sdxlCalls.calls.length, 0);
});

test('multipart-only (klein/flux-2) и известно-сломанные модели отклоняются до транспорта', async () => {
    const calls = transport(jsonResponse({ success: true, result: { image: JPEG_B64 } }));
    await assert.rejects(() => invoke({
        transport: calls, route: route('@cf/black-forest-labs/flux-2-klein-4b'),
    }), e => e?.code === 'CLOUDFLARE_MODEL_UNSUPPORTED');
    await assert.rejects(() => invoke({
        transport: calls, route: route('@cf/stabilityai/stable-diffusion-xl-base-1.0'),
    }), e => e?.code === 'CLOUDFLARE_MODEL_BROKEN');
    assert.equal(calls.calls.length, 0);
});

test('auth-ошибки типизированы (401→AUTH_INVALID, 403→AUTH_EXPIRED), без ретрая', async () => {
    for (const [status, code] of [[401, 'AUTH_INVALID'], [403, 'AUTH_EXPIRED']]) {
        const calls = transport(jsonResponse({ success: false, errors: [{ message: 'Unauthorized', code: 10000 }], result: {} }, status));
        await assert.rejects(() => invoke({ transport: calls }),
            e => e?.code === code && e.httpStatus === status && e.reauthRequired === true);
        assert.equal(calls.calls.length, 1);
    }
});

test('конверт success:false на 200 — типизированная ошибка с detail', async () => {
    const calls = transport(jsonResponse({ success: false, errors: [{ message: 'AiError: Bad input', code: 3030 }], result: {} }));
    await assert.rejects(() => invoke({ transport: calls }),
        e => e?.code === 'UPSTREAM_RESPONSE_INVALID' && /Bad input/.test(e.message));
});

test('200 без result.image — UPSTREAM_RESPONSE_INVALID', async () => {
    const calls = transport(jsonResponse({ success: true, result: {}, errors: [] }));
    await assert.rejects(() => invoke({ transport: calls }),
        e => e?.code === 'UPSTREAM_RESPONSE_INVALID' && /result\.image/.test(e.message));
});

test('нет токена — отказ до транспорта (AUTH_REQUIRED)', async () => {
    const calls = transport(jsonResponse({ success: true, result: { image: JPEG_B64 } }));
    await assert.rejects(() => invoke({ transport: calls, apiKey: '' }),
        e => e?.code === 'CLOUDFLARE_TOKEN_REQUIRED' && e.authCode === 'AUTH_REQUIRED' && e.reauthRequired === true);
    assert.equal(calls.calls.length, 0);
});

test('endpoint: вставленный run-URL обрезается до корня аккаунта', async () => {
    const calls = transport(jsonResponse({ success: true, result: { image: JPEG_B64 } }));
    await invoke({ transport: calls, endpoint: `${ENDPOINT}/ai/run/${FLUX}` });
    assert.equal(calls.calls[0].url, `${ENDPOINT}/ai/run/${FLUX}`);
});

test('dispatch plan: api.cloudflare.com → cloudflare-workers-ai', () => {
    const plan = resolveDispatchPlan({ endpoint: ENDPOINT, model: { id: FLUX } });
    assert.equal(plan.apiShape, 'cloudflare');
    assert.equal(plan.dialect, CONTRACTS.CLOUDFLARE_WORKERS_AI);
    assert.equal(plan.route.generationContract, CONTRACTS.CLOUDFLARE_WORKERS_AI);
});

test('пробник: каталог models/search, фильтрация multipart-only и битых моделей', async () => {
    const calls = [];
    const outcome = await probeConnection({
        endpoint: ENDPOINT,
        apiKey: 'cf-token',
        fetch: async (url, options) => {
            calls.push({ url: String(url), options });
            return jsonResponse({
                success: true,
                result: [
                    { id: '1', name: FLUX, task: { name: 'Text-to-Image' } },
                    { id: '2', name: SDXL, task: { name: 'Text-to-Image' } },
                    { id: '3', name: '@cf/black-forest-labs/flux-2-klein-4b', task: { name: 'Text-to-Image' } },
                    { id: '4', name: '@cf/stabilityai/stable-diffusion-xl-base-1.0', task: { name: 'Text-to-Image' } },
                    { id: '5', name: '@cf/meta/llama-3-8b', task: { name: 'Text Generation' } },
                ],
            });
        },
        proxiedFetch: async () => { throw new Error('proxy must not be called'); },
    });
    assert.equal(outcome.apiShape, 'cloudflare');
    assert.equal(outcome.auth, 'bearer');
    assert.deepEqual(outcome.modelIds, [FLUX, SDXL]);
    const byId = Object.fromEntries(outcome.modelMetadata.map(item => [item.modelId, item]));
    assert.equal(byId[FLUX].references, 'unsupported');
    assert.equal(byId[SDXL].references, 'supported');
    assert.equal(byId[SDXL].maxReferences, 1);
    assert.equal(byId[FLUX].imageGeneration, true);
    assert.equal(outcome.catalogSource, 'cloudflare-ai-models');
    assert.equal(outcome.generationUnverified, undefined); // каталог доказывает токен
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${ENDPOINT}/ai/models/search?task=Text-to-Image`);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer cf-token');
});

test('пробник: неожиданная форма каталога — понятная ошибка', async () => {
    await assert.rejects(() => probeConnection({
        endpoint: ENDPOINT,
        apiKey: 'cf-token',
        fetch: async () => jsonResponse({ unexpected: true }),
        proxiedFetch: async () => { throw new Error('proxy must not be called'); },
    }), /unexpected \/ai\/models\/search shape/);
});

test('пробник: endpoint без account ID — INVALID_ENDPOINT с подсказкой', async () => {
    await assert.rejects(() => probeConnection({
        endpoint: 'https://api.cloudflare.com',
        apiKey: 'cf-token',
        fetch: async () => { throw new Error('fetch must not be called'); },
        proxiedFetch: async () => { throw new Error('proxy must not be called'); },
    }), /account ID/);
});

test('netdump: каталог — skip/models, генерация — image', () => {
    assert.equal(classifyUrl(`${ENDPOINT}/ai/models/search?task=Text-to-Image`).kind, 'models');
    assert.equal(classifyUrl(`${ENDPOINT}/ai/models/search?task=Text-to-Image`).skip, true);
    assert.equal(classifyUrl(`${ENDPOINT}/ai/run/${FLUX}`).kind, 'image');
    assert.equal(classifyUrl(`${ENDPOINT}/ai/run/${FLUX}`).skip, false);
});
