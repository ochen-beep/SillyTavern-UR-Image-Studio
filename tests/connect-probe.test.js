// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { probeConnection } = await import('../src/connect-probe.js');

function jsonResponse(body, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        clone() { return jsonResponse(body, { ok, status }); },
        async json() { return body; },
        async text() { return JSON.stringify(body); },
        headers: { get: () => 'application/json' },
    };
}

function corsTypeError() {
    return new TypeError('Failed to fetch');
}

test('probe: bearer + OpenAI body shape on the first candidate', async () => {
    const seen = [];
    const outcome = await probeConnection({
        endpoint: 'https://relay.example/v1',
        apiKey: 'sk-test',
        fetch: async (url, options) => {
            seen.push({ url: String(url), auth: options.headers.Authorization || options.headers['x-goog-api-key'] || null });
            return jsonResponse({ data: [{ id: 'gpt-image-1' }, { id: 'gemini-3.1-flash-lite-image' }] });
        },
        proxiedFetch: async () => { throw new Error('proxy must not be called'); },
    });
    assert.deepEqual(outcome.modelIds, ['gpt-image-1', 'gemini-3.1-flash-lite-image']);
    assert.equal(outcome.modelMetadata.length, 2);
    assert.equal(outcome.modelMetadata[0].modelId, 'gpt-image-1');
    assert.equal(outcome.modelMetadata[0].mediaKind, undefined);
    assert.equal(outcome.modelMetadata[1].modelId, 'gemini-3.1-flash-lite-image');
    assert.equal(outcome.apiShape, 'openai');
    assert.equal(outcome.auth, 'bearer');
    assert.equal(outcome.delivery, 'direct');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, 'Bearer sk-test');
    assert.ok(outcome.checkedAt);
});

test('probe: generic Relay catalog retains nai-diffusion IDs without capability metadata', async () => {
    const outcome = await probeConnection({
        endpoint: 'https://relay.example/v1',
        apiKey: 'key',
        fetch: async () => jsonResponse({ data: [
            { id: 'nai-diffusion' },
            { id: 'vendor/nai-diffusion-v2' },
            { id: 'text-model' },
        ] }),
        proxiedFetch: async () => { throw new Error('proxy must not be called'); },
    });
    assert.deepEqual(outcome.modelIds, ['nai-diffusion', 'vendor/nai-diffusion-v2', 'text-model']);
    assert.equal(outcome.catalogSource, 'generic-models');
    assert.equal(outcome.catalogUrl, 'https://relay.example/v1/models');
});

test('probe: bearer rejected → x-goog-api-key wins (google-style gateway)', async () => {
    const attempts = [];
    const outcome = await probeConnection({
        endpoint: 'https://gateway.example/v1',
        apiKey: 'key-1',
        fetch: async (url, options) => {
            const auth = options.headers.Authorization || options.headers['x-goog-api-key'] || null;
            attempts.push(auth);
            if (auth === 'Bearer key-1') return jsonResponse({ error: { message: 'Invalid token' } }, { ok: false, status: 401 });
            return jsonResponse({ models: [{ name: 'models/gemini-2.5-flash-image' }] });
        },
        proxiedFetch: async () => { throw new Error('proxy must not be called'); },
    });
    assert.deepEqual(attempts, ['Bearer key-1', 'key-1']);
    assert.equal(outcome.auth, 'x-goog-api-key');
    assert.equal(outcome.apiShape, 'gemini');
    assert.deepEqual(outcome.modelIds, ['gemini-2.5-flash-image']);
});

test('probe: direct CORS block falls back to the ST proxy and records delivery', async () => {
    const outcome = await probeConnection({
        endpoint: 'https://nocors.example/v1',
        apiKey: 'k',
        fetch: async () => { throw corsTypeError(); },
        proxiedFetch: async () => jsonResponse({ data: [{ id: 'm1' }] }),
    });
    assert.equal(outcome.delivery, 'proxy');
    assert.equal(outcome.apiShape, 'openai');
    assert.equal(outcome.auth, 'bearer');
});

test('probe: corsMode proxy goes straight through the proxy without a direct attempt', async () => {
    const calls = [];
    const outcome = await probeConnection({
        endpoint: 'https://relay.example/v1',
        apiKey: 'k',
        corsMode: 'proxy',
        fetch: async () => { calls.push('direct'); return jsonResponse({ data: [] }); },
        proxiedFetch: async (url, options) => {
            calls.push(['proxy', String(url), options.headers.Authorization]);
            return jsonResponse({ data: [{ id: 'm' }] });
        },
    });
    assert.equal(outcome.delivery, 'proxy');
    assert.deepEqual(calls, [['proxy', 'https://relay.example/v1/models', 'Bearer k']]);
});

test('probe: google host prefers the native URL and x-goog auth', async () => {
    const attempts = [];
    const outcome = await probeConnection({
        endpoint: 'https://generativelanguage.googleapis.com',
        apiKey: 'g-key',
        fetch: async (url, options) => {
            attempts.push({ url: String(url), auth: options.headers['x-goog-api-key'] || options.headers.Authorization });
            return jsonResponse({ models: [{ name: 'models/gemini-2.5-flash-image' }] });
        },
        proxiedFetch: async () => { throw new Error('proxy must not be called'); },
    });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].url, 'https://generativelanguage.googleapis.com/v1beta/models');
    assert.equal(attempts[0].auth, 'g-key');
    assert.equal(outcome.apiShape, 'gemini');
});

test('probe: every attempt failed → one aggregated error', async () => {
    await assert.rejects(
        () => probeConnection({
            endpoint: 'https://dead.example/v1',
            apiKey: 'k',
            fetch: async () => jsonResponse({ error: { message: 'nope' } }, { ok: false, status: 500 }),
            proxiedFetch: async () => jsonResponse({ error: { message: 'nope' } }, { ok: false, status: 500 }),
        }),
        /Не удалось проверить подключение/,
    );
});

test('probe: empty endpoint throws immediately', async () => {
    await assert.rejects(() => probeConnection({ endpoint: '  ' }), /Endpoint is required/);
});

// A chunked catalog stream that the server cuts mid-body (observed on
// NanoGPT /api/v1/images/models: ~70s in, network TypeError from reader).
// The probe must keep the entries that arrived before the cut instead of
// failing the whole fetch.
function truncatedStreamResponse(models) {
    const full = JSON.stringify({ object: 'list', data: models });
    const cut = full.slice(0, Math.floor(full.length * 0.6));
    const bytes = new TextEncoder().encode(cut);
    let sent = false;
    return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        clone() { return truncatedStreamResponse(models); },
        get body() {
            return { getReader: () => ({ read: async () => {
                if (sent) throw new TypeError('network error mid-stream');
                sent = true;
                return { done: false, value: bytes };
            } }) };
        },
        async json() { throw new SyntaxError('Unexpected end of JSON input'); },
    };
}

test('probe: NanoGPT image catalog salvages entries from a truncated stream', async () => {
    const models = [
        { id: 'nvidia/cosmos-3-super/text-to-image', category: 'image', architecture: { output_modalities: ['image'] }, capabilities: { image_generation: true } },
        { id: 'krea/v2/medium/text-to-image', category: 'image', architecture: { output_modalities: ['image'] }, capabilities: { image_generation: true } },
        { id: 'fal-ai/boogu-image', category: 'image', architecture: { output_modalities: ['image'] }, capabilities: { image_generation: true } },
    ];
    const requests = [];
    const outcome = await probeConnection({
        endpoint: 'https://nano-gpt.com',
        apiKey: 'nano-key',
        fetch: async (url, options) => {
            requests.push({ url: String(url), auth: options.headers.Authorization });
            return truncatedStreamResponse(models);
        },
        proxiedFetch: async () => { throw new Error('proxy must not be called'); },
    });
    assert.deepEqual(requests, [{
        url: 'https://nano-gpt.com/api/v1/images/models',
        auth: 'Bearer nano-key',
    }]);
    assert.ok(outcome.modelIds.length >= 1, 'at least the first entry survives the cut');
    assert.equal(outcome.modelIds[0], 'nvidia/cosmos-3-super/text-to-image');
    assert.equal(outcome.modelMetadata[0].mediaKind, 'image');
    assert.equal(outcome.modelMetadata[0].imageGeneration, true);
    assert.equal(outcome.partial, true);
});

test('probe: NanoGPT endpoint accepts origin, /v1 and /api/v1 bases', async () => {
    for (const endpoint of ['https://nano-gpt.com', 'https://nano-gpt.com/v1', 'https://nano-gpt.com/api/v1']) {
        const urls = [];
        const outcome = await probeConnection({
            endpoint,
            apiKey: 'nano-key',
            fetch: async url => {
                urls.push(String(url));
                return jsonResponse({ data: [{ id: 'nai-diffusion', category: 'image' }] });
            },
            proxiedFetch: async () => { throw new Error('proxy must not be called'); },
        });
        assert.deepEqual(urls, ['https://nano-gpt.com/api/v1/images/models']);
        assert.deepEqual(outcome.modelIds, ['nai-diffusion']);
        assert.equal(outcome.catalogSource, 'nanogpt-image-models');
        assert.equal(outcome.catalogUrl, 'https://nano-gpt.com/api/v1/images/models');
        assert.equal(outcome.metadataCount, 1);
    }
});

test('probe: a NanoGPT lookalike host stays on the generic catalog path', async () => {
    const urls = [];
    const outcome = await probeConnection({
        endpoint: 'https://nano-gpt.com.evil.example',
        apiKey: 'key',
        fetch: async url => {
            urls.push(String(url));
            return jsonResponse({ data: [{ id: 'gpt-image-1' }] });
        },
        proxiedFetch: async () => { throw new Error('proxy must not be called'); },
    });
    assert.deepEqual(urls, ['https://nano-gpt.com.evil.example/v1/models']);
    assert.equal(outcome.catalogSource, 'generic-models');
});

test('probe: NanoGPT maps image-to-image and reference limits from bounded metadata', async () => {
    const outcome = await probeConnection({
        endpoint: 'https://nano-gpt.com',
        apiKey: 'nano-key',
        fetch: async () => jsonResponse({ data: [
            {
                id: 'text-to-image-only',
                category: 'image',
                capabilities: { image_generation: true, image_to_image: false },
                supported_parameters: { resolutions: ['1024x1024'] },
            },
            {
                id: 'edit-model',
                category: 'image',
                capabilities: { image_generation: true, image_to_image: true },
                supported_parameters: { resolutions: ['auto'], max_input_images: 5 },
            },
        ] }),
        proxiedFetch: async () => { throw new Error('proxy must not be called'); },
    });
    assert.deepEqual(outcome.modelMetadata[0], {
        modelId: 'text-to-image-only',
        mediaKind: 'image',
        imageGeneration: true,
        references: 'unsupported',
        supportedParameters: ['resolutions'],
        imageSizes: ['1024x1024'],
        source: 'nanogpt-image-models',
        provider: 'nanogpt',
    });
    assert.equal(outcome.modelMetadata[1].references, 'supported');
    assert.equal(outcome.modelMetadata[1].maxReferences, 5);
    assert.deepEqual(outcome.modelMetadata[1].imageSizes, ['auto']);
});

test('probe: a stream timeout never yields a partial catalog', async () => {
    // reader.read() rejects with AbortError — the salvage path must rethrow
    // the timeout instead of silently saving half a catalog.
    const response = {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        clone() { return response; },
        get body() {
            return { getReader: () => ({ read: async () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                throw error;
            } }) };
        },
        async json() { throw new SyntaxError('Unexpected end of JSON input'); },
    };
    await assert.rejects(
        () => probeConnection({
            endpoint: 'https://nano-gpt.com',
            apiKey: 'nano-key',
            timeoutMs: 1000,
            fetch: async () => response,
            proxiedFetch: async () => { throw new Error('proxy must not be called'); },
        }),
        /Таймаут/,
    );
});

test('probe: результат «Проверить» пишется в журнал диагностики', async () => {
    const journal = await import('../src/diagnostic-events.js');
    journal.resetDiagnosticEventsForTests();
    const outcome = await probeConnection({
        endpoint: 'https://relay.example/v1',
        apiKey: 'sk-test',
        fetch: async () => jsonResponse({ data: [{ id: 'gpt-image-1' }, { id: 'gemini-3.1-flash-lite-image' }] }),
        proxiedFetch: async () => { throw new Error('proxy must not be called'); },
    });
    assert.equal(outcome.modelIds.length, 2);
    const event = journal.listDiagnosticEvents().find(e => e.event === 'connection-probe');
    assert.ok(event, 'probe must write a journal event');
    assert.equal(event.outcome, 'ok');
    assert.ok(Number.isFinite(event.durationMs));
    assert.equal(event.details.models, 2);
});

test('probe: ошибка «Проверить» пишется в журнал с outcome error', async () => {
    const journal = await import('../src/diagnostic-events.js');
    journal.resetDiagnosticEventsForTests();
    await assert.rejects(probeConnection({
        endpoint: 'https://relay.example/v1',
        fetch: async () => { throw new Error('connection refused'); },
        proxiedFetch: async () => { throw new Error('no proxy'); },
    }));
    const event = journal.listDiagnosticEvents().find(e => e.event === 'connection-probe');
    assert.ok(event, 'a failed probe must also leave a trace');
    assert.equal(event.outcome, 'error');
    assert.equal(event.level, 'error');
});
