// @ts-check
// Transport failures must name the endpoint they hit: a wrong-path mistake
// (/v1 vs /v1beta) used to surface as a bare "network error". The stamp is
// method + origin/path only — the query can carry signed tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals, mockFetch } from './_helpers.js';

installStGlobals();

const { requestJson, requestMultipart } = await import('../src/image-transport.js');
const { _resetCache } = await import('../src/proxy.js');

function route() {
    return {
        id: 'route_url',
        generationContract: 'openai-images',
        transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
    };
}

test('json route network failure carries the endpoint origin+path, no query', async () => {
    _resetCache();
    const restore = mockFetch(() => { throw new TypeError('Failed to fetch'); });
    try {
        const err = await requestJson('https://images.example/v1beta/models/xx:generate?token=SIGNED', {
            method: 'POST', headers: { Authorization: 'Bearer k' }, body: '{}',
        }, route()).catch(e => e);
        assert.match(err.message, /https:\/\/images\.example\/v1beta\/models\/xx:generate/);
        assert.equal(err.message.includes('SIGNED'), false, 'query never enters the stamp');
    } finally { restore(); }
});

test('multipart CORS failure keeps its typed code and gains the endpoint stamp', async () => {
    _resetCache();
    const restore = mockFetch(() => { throw new TypeError('Failed to fetch'); });
    try {
        const err = await requestMultipart('https://images.example/v1/edits', { method: 'POST', body: new FormData() }).catch(e => e);
        assert.equal(err.code, 'MULTIPART_CORS_REQUIRED');
        assert.match(err.message, /https:\/\/images\.example\/v1\/edits/);
    } finally { restore(); }
});
