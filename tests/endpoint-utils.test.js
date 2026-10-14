// @ts-check
// Пункт 2.3: единая нормализация endpoint'ов по дескриптору. Контракт —
// байт-в-байт те же URL, что выдавали прежние адаптерные нормализаторы
// (endpointBase, comfyBase, baseUrl naistera, generationUrl pollinations,
// base openrouter, версионирование gemini). Таблица «сырой → канонический»
// со злом: ///, хвостовой /v1, /api/v1, порт ComfyUI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resolveEndpoint, interpolatePath } from '../src/endpoint-utils.js';
import { getProviderDescriptor } from '../src/provider-descriptors.js';

const D = id => getProviderDescriptor(id);

function assertSame(descriptor, samples) {
    for (const [raw, expected] of samples) {
        assert.equal(resolveEndpoint(descriptor, raw), expected, `${JSON.stringify(raw)} → ${expected}`);
    }
}

test('openai-images: endpointBase — /v1 дописывается, хвосты снимаются, зло отсеивается', () => {
    const d = D('openai-images');
    assertSame(d, [
        ['https://gw.test', 'https://gw.test/v1'],
        ['https://gw.test/', 'https://gw.test/v1'],
        ['https://gw.test///', 'https://gw.test/v1'],
        ['https://gw.test/v1', 'https://gw.test/v1'],
        ['https://gw.test/v1/', 'https://gw.test/v1'],
        ['https://gw.test/api', 'https://gw.test/api/v1'],
    ]);
    // Пустое значение → INVALID_ENDPOINT с историческим текстом.
    assert.throws(() => resolveEndpoint(d, ''), e => e.code === 'INVALID_ENDPOINT' && /Image provider endpoint is required\./.test(e.message));
    // Пути дескриптора дают прежние URL целиком.
    assert.equal(`${resolveEndpoint(d, 'https://gw.test')}${d.endpoint.generationPath}`, 'https://gw.test/v1/images/generations');
    assert.equal(`${resolveEndpoint(d, 'https://gw.test')}${d.endpoint.editPath}`, 'https://gw.test/v1/images/edits');
    assert.equal(`${resolveEndpoint(d, 'https://gw.test')}${d.endpoint.modelsPath}`, 'https://gw.test/v1/models');
});

test('chat-completions: тот же /v1-базис, путь /chat/completions', () => {
    const d = D('chat-completions');
    assertSame(d, [
        ['https://gw.test', 'https://gw.test/v1'],
        ['https://gw.test/v1/', 'https://gw.test/v1'],
    ]);
    assert.equal(`${resolveEndpoint(d, 'https://gw.test')}${d.endpoint.generationPath}`, 'https://gw.test/v1/chat/completions');
});

test('gemini-native: /v1beta дописывается, /v1 и /v1beta сохраняются, :model интерполируется', () => {
    const d = D('gemini-native');
    assertSame(d, [
        ['https://gw.test', 'https://gw.test/v1beta'],
        ['https://gw.test/v1beta', 'https://gw.test/v1beta'],
        ['https://gw.test/v1', 'https://gw.test/v1'],
        ['https://generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com/v1beta'],
    ]);
    assert.equal(
        interpolatePath(d.endpoint.generationPath, { model: 'gemini-3.1-flash-image' }),
        '/models/gemini-3.1-flash-image:generateContent',
    );
    // Спецсимволы в model id кодируются.
    assert.equal(
        interpolatePath(d.endpoint.generationPath, { model: 'a/b c' }),
        '/models/a%2Fb%20c:generateContent',
    );
});

test('openrouter: официальный origin расширяется, чужие формы строго отвергаются', () => {
    const d = D('openrouter-images');
    assertSame(d, [
        ['https://openrouter.ai', 'https://openrouter.ai/api/v1'],
        ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1'],
        ['https://gw.test/api/v1', 'https://gw.test/api/v1'],
    ]);
    assert.throws(() => resolveEndpoint(d, 'https://gw.test'), e => e.code === 'INVALID_ENDPOINT' && /official origin or end in \/api\/v1/.test(e.message));
    assert.throws(() => resolveEndpoint(d, 'https://gw.test/v1'), e => e.code === 'INVALID_ENDPOINT');
});

test('pollinations: хвостовая /v1 снимается и пишется заново', () => {
    const d = D('pollinations-images');
    assertSame(d, [
        ['https://gen.pollinations.ai', 'https://gen.pollinations.ai/v1'],
        ['https://gen.pollinations.ai/', 'https://gen.pollinations.ai/v1'],
        ['https://gen.pollinations.ai/v1', 'https://gen.pollinations.ai/v1'],
    ]);
    assert.equal(`${resolveEndpoint(d, 'https://gen.pollinations.ai')}${d.endpoint.generationPath}`, 'https://gen.pollinations.ai/v1/images/generations');
});

test('naistera: хвостовой /api снимается, пути поколения и поллинга совпадают', () => {
    const d = D('naistera');
    assertSame(d, [
        ['https://naistera.org', 'https://naistera.org'],
        ['https://naistera.org/', 'https://naistera.org'],
        ['https://naistera.org/api', 'https://naistera.org'],
        ['https://naistera.org/api///', 'https://naistera.org'],
    ]);
    const base = resolveEndpoint(d, 'https://naistera.org/api');
    assert.equal(`${base}${d.endpoint.generationPath}`, 'https://naistera.org/api/generate');
    assert.equal(base + interpolatePath(d.endpoint.jobPath, { jobId: 'j 1/x' }), 'https://naistera.org/api/generate/jobs/j%201%2Fx');
    assert.throws(() => resolveEndpoint(d, ''), e => e.code === 'INVALID_ENDPOINT' && /Naistera endpoint is required\./.test(e.message));
});

test('comfyui: хвостовой /api снимается, порт сохраняется', () => {
    const d = D('comfyui');
    assertSame(d, [
        ['http://127.0.0.1:8188', 'http://127.0.0.1:8188'],
        ['http://127.0.0.1:8188/', 'http://127.0.0.1:8188'],
        ['http://127.0.0.1:8188/api', 'http://127.0.0.1:8188'],
    ]);
    const base = resolveEndpoint(d, 'http://127.0.0.1:8188/api');
    assert.equal(`${base}${d.endpoint.generationPath}`, 'http://127.0.0.1:8188/prompt');
    assert.throws(() => resolveEndpoint(d, ''), e => e.code === 'INVALID_ENDPOINT' && /ComfyUI endpoint is required\./.test(e.message));
});

test('cloudflare-workers-ai: base обязан включать account ID, хвосты /ai/run обрезаются', () => {
    const d = D('cloudflare-workers-ai');
    assertSame(d, [
        ['https://api.cloudflare.com/client/v4/accounts/abc123', 'https://api.cloudflare.com/client/v4/accounts/abc123'],
        ['https://api.cloudflare.com/client/v4/accounts/abc123/', 'https://api.cloudflare.com/client/v4/accounts/abc123'],
        ['https://api.cloudflare.com/client/v4/accounts/abc123///', 'https://api.cloudflare.com/client/v4/accounts/abc123'],
        // Полный run-URL вставили в поле адреса — обрезается до корня аккаунта.
        ['https://api.cloudflare.com/client/v4/accounts/abc123/ai/run/@cf/x/y', 'https://api.cloudflare.com/client/v4/accounts/abc123'],
    ]);
    // Без account ID — отказ с подсказкой.
    for (const raw of ['', 'https://api.cloudflare.com', 'https://api.cloudflare.com/client/v4']) {
        assert.throws(() => resolveEndpoint(d, raw), e => e.code === 'INVALID_ENDPOINT' && /account ID/.test(e.message));
    }
    const base = resolveEndpoint(d, 'https://api.cloudflare.com/client/v4/accounts/abc123');
    assert.equal(`${base}${d.endpoint.generationPath}@cf/x/y`, 'https://api.cloudflare.com/client/v4/accounts/abc123/ai/run/@cf/x/y');
    assert.equal(`${base}${d.endpoint.modelsPath}?task=Text-to-Image`, 'https://api.cloudflare.com/client/v4/accounts/abc123/ai/models/search?task=Text-to-Image');
});

test('grep-инвариант (пункт 2.3): регэксп /pollinations|naistera/i по display name удалён из image-base', async () => {
    const src = await readFile(new URL('../src/providers/image-base.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /pollinations\|naistera/i, 'isBearerContract больше не матчит display name');
    assert.match(src, /authProfileFor\(contract\)/, 'коды 401/403 берутся из дескриптора');
});

test('дескрипторы: статус-коды 401/403 только у bearer-контрактов с токенами от бота/сервиса', () => {
    assert.equal(D('pollinations-images').auth.statusCodes[401], 'AUTH_INVALID');
    assert.equal(D('pollinations-images').auth.statusCodes[403], 'AUTH_EXPIRED');
    assert.equal(D('naistera').auth.statusCodes[401], 'AUTH_INVALID');
    assert.equal(D('naistera').auth.statusCodes[403], 'AUTH_EXPIRED');
    // Остальные контракты — UPSTREAM_HTTP_ERROR (statusCodes нет).
    for (const id of ['openai-images', 'chat-completions', 'gemini-native', 'openrouter-images', 'comfyui']) {
        assert.equal(D(id).auth.statusCodes, undefined, `${id} не переопределяет auth-коды`);
    }
});
