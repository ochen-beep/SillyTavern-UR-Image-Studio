// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveWireGeometry, resolveWireQuality } from '../src/wire-params.js';
import { invokeImageProvider } from '../src/image-provider-registry.js';

// Manifest vocabularies quoted from the NanoGpt image catalog
// (GET /api/v1/images/models, snapshot 2026-09) — the same data the
// extension's catalog probe stores into route.capabilities.
const SEEDREAM_LITE = {
    supportedParameters: ['resolutions', 'max_images', 'max_output_images', 'input_image_constraints'],
    imageSizes: ['2048x2048', '2560x1440', '1440x2560', '3072x2048', '2048x3072', '4096x2304', '2304x4096'],
};
const SEEDREAM_PRO = {
    supportedParameters: ['resolutions', 'max_images', 'max_output_images', 'input_image_constraints'],
    imageSizes: ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '1k', '2k'],
};
const NANO_BANANA = {
    supportedParameters: ['resolutions', 'aspect_ratio', 'max_images', 'max_output_images', 'input_image_constraints'],
    imageSizes: ['auto'],
};
const NANO_BANANA_2 = {
    supportedParameters: ['resolutions', 'aspect_ratio', 'max_images', 'max_output_images', 'input_image_constraints'],
    imageSizes: ['1k', '2k', '4k'],
};
const GPT_IMAGE_15 = {
    supportedParameters: ['resolutions', 'max_images', 'max_output_images'],
    imageSizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
};
const GPT_IMAGE_TAXONOMY = new Map([
    ['1:1', '1024x1024'],
    ['2:3', '1024x1536'], ['3:4', '1024x1536'], ['4:5', '1024x1536'], ['9:16', '1024x1536'],
    ['3:2', '1536x1024'], ['4:3', '1536x1024'], ['5:4', '1536x1024'], ['16:9', '1536x1024'],
    ['21:9', '1536x1024'],
]);

test('seedream-v5.0-lite: WxH manifest → nearest model resolution instead of the gpt taxonomy', () => {
    assert.deepEqual(resolveWireGeometry({ route: { capabilities: SEEDREAM_LITE }, aspectRatio: '16:9' }), { param: 'size', value: '2560x1440', source: 'manifest-size-nearest' });
    assert.deepEqual(resolveWireGeometry({ route: { capabilities: SEEDREAM_LITE }, aspectRatio: '9:16' }), { param: 'size', value: '1440x2560', source: 'manifest-size-nearest' });
    assert.deepEqual(resolveWireGeometry({ route: { capabilities: SEEDREAM_LITE }, aspectRatio: '1:1' }), { param: 'size', value: '2048x2048', source: 'manifest-size-nearest' });
    // 3:2 exists verbatim; 4:3 has no exact slot → nearest (3:2 canvas).
    assert.deepEqual(resolveWireGeometry({ route: { capabilities: SEEDREAM_LITE }, aspectRatio: '3:2' }), { param: 'size', value: '3072x2048', source: 'manifest-size-nearest' });
    assert.equal(resolveWireGeometry({ route: { capabilities: SEEDREAM_LITE }, aspectRatio: '4:3' }).value, '3072x2048');
    // 21:9 has no close slot; nearest is still sent (best the model can do).
    assert.equal(resolveWireGeometry({ route: { capabilities: SEEDREAM_LITE }, aspectRatio: '21:9' }).param, 'size');
});

test('seedream-v5.0-pro: ratio literals in imageSizes travel as the size value', () => {
    assert.deepEqual(resolveWireGeometry({ route: { capabilities: SEEDREAM_PRO }, aspectRatio: '16:9' }), { param: 'size', value: '16:9', source: 'manifest-size-exact' });
    assert.deepEqual(resolveWireGeometry({ route: { capabilities: SEEDREAM_PRO }, aspectRatio: '4:3' }), { param: 'size', value: '4:3', source: 'manifest-size-exact' });
});

test('nano-banana: aspect_ratio-only manifest → aspect_ratio parameter', () => {
    assert.deepEqual(resolveWireGeometry({ route: { capabilities: NANO_BANANA }, aspectRatio: '16:9' }), { param: 'aspect_ratio', value: '16:9', source: 'manifest-aspect-param' });
    // nano-banana-2 lists resolution tiers, not WxH — tiers carry no aspect,
    // so the manifest aspect_ratio parameter is the only honest channel.
    assert.deepEqual(resolveWireGeometry({ route: { capabilities: NANO_BANANA_2 }, aspectRatio: '9:16' }), { param: 'aspect_ratio', value: '9:16', source: 'manifest-aspect-param' });
});

test('gpt-image-1.5: WxH manifest agrees with the gpt taxonomy', () => {
    assert.deepEqual(resolveWireGeometry({ route: { capabilities: GPT_IMAGE_15 }, aspectRatio: '16:9' }), { param: 'size', value: '1536x1024', source: 'manifest-size-nearest' });
    assert.deepEqual(resolveWireGeometry({ route: { capabilities: GPT_IMAGE_15 }, aspectRatio: '9:16' }), { param: 'size', value: '1024x1536', source: 'manifest-size-nearest' });
});

test('no manifest → the static family table keeps legacy gateways unchanged', () => {
    assert.deepEqual(resolveWireGeometry({ route: {}, aspectRatio: '16:9', fallbackTable: GPT_IMAGE_TAXONOMY }), { param: 'size', value: '1536x1024', source: 'static-table' });
    assert.deepEqual(resolveWireGeometry({ route: { capabilities: {} }, aspectRatio: '9:16', fallbackTable: GPT_IMAGE_TAXONOMY }), { param: 'size', value: '1024x1536', source: 'static-table' });
});

test('no manifest and an unmapped ratio → param null (caller warns)', () => {
    assert.deepEqual(resolveWireGeometry({ route: {}, aspectRatio: '5:7', fallbackTable: GPT_IMAGE_TAXONOMY }), { param: null, value: null, source: 'unmapped' });
});

test('an explicit aspectRatios enum wins over everything', () => {
    const route = { capabilities: { aspectRatios: ['1:1', '16:9', '21:9'], imageSizes: ['2048x2048'] } };
    assert.deepEqual(resolveWireGeometry({ route, aspectRatio: '21:9' }), { param: 'aspect_ratio', value: '21:9', source: 'manifest-aspect-list' });
});

test('an empty aspect ratio omits geometry without warnings', () => {
    assert.deepEqual(resolveWireGeometry({ route: { capabilities: SEEDREAM_LITE }, aspectRatio: '' }), { param: null, value: null, source: 'unspecified' });
});

test('quality: auto is omitted, manifest vocabulary drops unknown values', () => {
    const QUALITY = new Set(['low', 'medium', 'high']);
    assert.equal(resolveWireQuality({ capabilities: {} }, 'auto', QUALITY), undefined, "auto IS the default — never wire it (apihub 400)");
    assert.equal(resolveWireQuality({ capabilities: {} }, 'high', QUALITY), 'high');
    assert.equal(resolveWireQuality({ capabilities: {} }, 'hd', QUALITY), undefined);
    assert.equal(resolveWireQuality({ capabilities: { qualityValues: ['low', 'medium', 'high'] } }, 'high', QUALITY), 'high');
    assert.equal(resolveWireQuality({ capabilities: { qualityValues: ['low', 'medium', 'high'] } }, 'hd', QUALITY), undefined, 'manifest vocabulary drops values outside it');
});

// ── Adapter integration: the manifest must reach the wire ──

function route(generationContract, modelId, capabilities) {
    return {
        contractVersion: 1,
        generationContract,
        modelId,
        transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
        ...(capabilities ? { capabilities } : {}),
    };
}

function makeTransport(response) {
    const calls = [];
    return {
        calls,
        requestJson: async (url, options, savedRoute, timeoutMs) => {
            calls.push({ kind: 'json', url, options, route: savedRoute, timeoutMs });
            return response;
        },
        requestMultipart: async (url, options, savedRoute, timeoutMs) => {
            calls.push({ kind: 'multipart', url, options, route: savedRoute, timeoutMs });
            return response;
        },
        downloadResult: async (url, options) => {
            calls.push({ kind: 'download', url, options });
            return response;
        },
    };
}

function jsonResponse(body, status = 200) {
    return { status, ok: status >= 200 && status < 300, clone() { return this; }, json: async () => body, text: async () => JSON.stringify(body) };
}

async function generate(routeArg, request) {
    const transport = makeTransport(jsonResponse({ data: [{ b64_json: 'cG5n' }] }));
    const result = await invokeImageProvider({
        endpoint: 'https://api.example/v1', apiKey: 'secret',
        connection: { timeoutMs: 4100 },
        route: routeArg,
        request, transport,
    });
    return { body: JSON.parse(transport.calls[0].options.body), result };
}

test('openai-images: Seedream manifest sends the model WxH resolution, not the gpt taxonomy', async () => {
    // Regression 2026-09: every aspect collapsed to 1:1 because size=1536x1024
    // is not in seedream-v5.0-lite's vocabulary and NanoGpt dropped it silently.
    const { body, result } = await generate(route('openai-images', 'seedream-v5.0-lite', SEEDREAM_LITE), { prompt: 'A lighthouse', aspectRatio: '16:9', quality: 'auto', references: [] });
    assert.equal(body.size, '2560x1440');
    assert.equal(body.aspect_ratio, undefined);
    assert.equal(body.quality, undefined, 'auto must not be wired');
    assert.deepEqual(result.warnings, []);
});

test('openai-images: nano-banana manifest sends aspect_ratio instead of size', async () => {
    const { body, result } = await generate(route('openai-images', 'nano-banana', NANO_BANANA), { prompt: 'A lighthouse', aspectRatio: '16:9', quality: 'auto', references: [] });
    assert.equal(body.aspect_ratio, '16:9');
    assert.equal(body.size, undefined);
    assert.deepEqual(result.warnings, []);
});

test('openai-images: without a manifest the static taxonomy and warnings are unchanged', async () => {
    const { body, result } = await generate(route('openai-images', 'gpt-image-1'), { prompt: 'A lighthouse', aspectRatio: '5:7', quality: 'auto', references: [] });
    assert.equal(body.size, undefined);
    assert.deepEqual(result.warnings.map(w => w.feature), ['Стороны']);
    assert.match(result.warnings[0].details, /5:7/);
});

test('openai-images: dall-e keeps its own static table and quality scale', async () => {
    const { body } = await generate(route('openai-images', 'dall-e-3'), { prompt: 'A lighthouse', aspectRatio: '16:9', quality: 'high', references: [] });
    assert.equal(body.size, '1792x1024');
    assert.equal(body.quality, 'hd');
});
