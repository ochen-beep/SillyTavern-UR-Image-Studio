// @ts-check
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const extensionSettings = {};
globalThis.SillyTavern = {
    getContext: () => ({ extensionSettings, saveSettingsDebounced: () => {} }),
    libs: { localforage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } },
};

const { recordReferenceEvidence } = await import('../src/connection-evidence.js');
const { referenceRejectionReason } = await import('../src/capability-observer.js');
const store = await import('../src/connection-store.js');

beforeEach(() => {
    extensionSettings.ur_image_studio = undefined;
});

function refError(message) {
    const error = new Error(message);
    error.code = 'UPSTREAM_HTTP_ERROR';
    error.httpStatus = 400;
    return error;
}

test('referenceRejectionReason classifies reference-shaped rejections only', () => {
    assert.match(referenceRejectionReason(refError('Image editing is only supported for compatible providers.')) || '', /edit/);
    assert.match(referenceRejectionReason(refError('maximum 3 images are allowed')) || '', /лимит/);
    assert.match(referenceRejectionReason(refError('failed to parse edit request (multipart)')) || '', /разобрать/);
    assert.equal(referenceRejectionReason(refError('insufficient quota')), null);
    assert.equal(referenceRejectionReason(new Error('Timeout (300s)')), null);
    assert.equal(referenceRejectionReason(null), null);
});

test('success with references records refs confirmed with n and dialect', async () => {
    await store.createConnection({ id: 'c1', name: 'X', endpoint: 'https://x.test/v1', model: { id: 'gpt-image-1', source: 'list' } });
    const entry = await recordReferenceEvidence({
        connectionId: 'c1', modelId: 'gpt-image-1', dialect: 'openai-images', refCount: 3,
    });
    assert.equal(entry.refs, 'confirmed');
    assert.equal(entry.n, 3);
    assert.equal(entry.dialect, 'openai-images');
    assert.ok(entry.ts);

    const conn = await store.getConnection('c1');
    assert.equal(conn.evidence['gpt-image-1'].refs, 'confirmed');
});

test('reference-shaped failure records refs rejected with reason; other errors record nothing', async () => {
    await store.createConnection({ id: 'c2', name: 'X', endpoint: 'https://x.test/v1', model: { id: 'm', source: 'list' } });

    const rejected = await recordReferenceEvidence({
        connectionId: 'c2', modelId: 'm', dialect: 'openai-images', refCount: 2,
        error: refError('image_url is required for this operation'),
    });
    assert.equal(rejected.refs, 'rejected');
    assert.match(rejected.reason, /поле/);

    // A quota error proves nothing about references — no write.
    const none = await recordReferenceEvidence({
        connectionId: 'c2', modelId: 'm', dialect: 'openai-images', refCount: 2,
        error: refError('insufficient quota'),
    });
    assert.equal(none, null);
    const conn = await store.getConnection('c2');
    assert.equal(conn.evidence.m.refs, 'rejected', 'the earlier fact is untouched');
});

test('a later confirmation overrides an earlier rejection (newest paid attempt wins)', async () => {
    await store.createConnection({ id: 'c3', name: 'X', endpoint: 'https://x.test/v1', model: { id: 'm', source: 'list' } });
    await recordReferenceEvidence({ connectionId: 'c3', modelId: 'm', dialect: 'openai-images', refCount: 1, error: refError('image editing is only supported for gpt-image') });
    const confirmed = await recordReferenceEvidence({ connectionId: 'c3', modelId: 'm', dialect: 'chat-completions', refCount: 2 });
    assert.equal(confirmed.refs, 'confirmed');
    assert.equal(confirmed.dialect, 'chat-completions');
    assert.equal(confirmed.reason, undefined, 'stale rejection reason does not linger');
});

test('concurrent evidence writes for different models both survive (mutex serialization)', async () => {
    await store.createConnection({ id: 'c4', name: 'X', endpoint: 'https://x.test/v1', model: { id: 'a', source: 'list' } });
    await Promise.all([
        recordReferenceEvidence({ connectionId: 'c4', modelId: 'a', dialect: 'openai-images', refCount: 1 }),
        recordReferenceEvidence({ connectionId: 'c4', modelId: 'b', dialect: 'chat-completions', refCount: 2 }),
    ]);
    const conn = await store.getConnection('c4');
    assert.equal(conn.evidence.a.refs, 'confirmed');
    assert.equal(conn.evidence.b.refs, 'confirmed');
});

test('user-confirmed flag survives schema normalization', async () => {
    await store.createConnection({ id: 'c5', name: 'X', endpoint: 'https://x.test/v1', model: { id: 'm', source: 'list' } });
    await recordReferenceEvidence({ connectionId: 'c5', modelId: 'm', dialect: 'gemini-native', refCount: 1, userConfirmed: true });
    const conn = await store.getConnection('c5');
    assert.equal(conn.evidence.m.userConfirmed, true);
});

test('missing connection or identity is a silent no-op', async () => {
    assert.equal(await recordReferenceEvidence({ connectionId: 'ghost', modelId: 'm', dialect: 'openai-images', refCount: 1 }), null);
    assert.equal(await recordReferenceEvidence({ connectionId: null, modelId: 'm', dialect: 'openai-images', refCount: 1 }), null);
    assert.equal(await recordReferenceEvidence({ connectionId: 'c1', modelId: '', dialect: 'openai-images', refCount: 1 }), null);
});
