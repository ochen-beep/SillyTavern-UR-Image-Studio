// @ts-check
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

let context;
let originalSt;
let originalFetch;

/**
 * These cases cover card sanitization on the server-file store. The fetch stub
 * models a modern SillyTavern: the user-files surface answers, uploads land in
 * an in-memory `serverFiles` map (the server-file shape has its own deeper
 * suite, tests/gallery-file-store.test.js).
 */
const serverFiles = new Map();

function installFileFetch() {
    globalThis.fetch = async (url, options = {}) => {
        const u = String(url);
        if (u === '/api/files/verify') return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        if (u === '/api/files/upload' && options.method === 'POST') {
            const body = JSON.parse(options.body);
            serverFiles.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        }
        if (u.startsWith('/user/files/')) {
            const name = decodeURIComponent(u.slice('/user/files/'.length));
            if (!serverFiles.has(name)) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
            return { ok: true, status: 200, text: async () => serverFiles.get(name), json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => [], text: async () => '' };
    };
}

/** The stored card array from the in-memory server files (manifest + shards). */
function galleryFileDoc() {
    const manifestText = serverFiles.get('uris_gallery_manifest.json');
    if (!manifestText) return [];
    const cards = [];
    for (const row of (JSON.parse(manifestText).shards || [])) {
        const text = serverFiles.get(`uris_gallery_shard_${row.id}.json`);
        if (text) cards.push(...JSON.parse(text).records);
    }
    return cards;
}

beforeEach(async () => {
    originalSt = globalThis.SillyTavern;
    originalFetch = globalThis.fetch;
    context = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    globalThis.SillyTavern = { getContext: () => context };
    installFileFetch();
    // Flush BEFORE clearing: a write loop parked mid-upload from the previous
    // test must land in the PREVIOUS map, not leak into this one (proven flake
    // class — see flush-before-reset in the other store suites). Gallery is
    // awaited since sharding, so this is belt-and-braces, kept for symmetry.
    const { flushGalleryWrites, resetGalleryStoreForTests } = await import('../src/gallery-index.js');
    await flushGalleryWrites().catch(() => {});
    serverFiles.clear();
    resetGalleryStoreForTests();
});

afterEach(() => {
    globalThis.SillyTavern = originalSt;
    globalThis.fetch = originalFetch;
});

test('persists sanitized card metadata without bytes or secrets', async () => {
    const { addCard, listCards } = await import('../src/gallery-index.js');
    const card = await addCard({
        id: 'card-1', imagePath: 'user/images/UR%20Image%20Studio/one.png', prompt: 'portrait',
        routeId: 'route-1', modelId: 'model-1', referenceIds: ['ref-1'], status: 'ready',
        apiKey: 'must-not-persist', providerMetadata: { token: 'also-not-persist', seed: 5 },
        src: 'data:image/png;base64,secret-image-bytes', result: { value: 'data:image/png;base64,more-bytes' },
    });

    assert.equal(card.id, 'card-1');
    // Запись коалесцируется: читаем файл после flush, а не по таймингу микротасков.
    const { flushGalleryWrites } = await import('../src/gallery-index.js');
    await flushGalleryWrites();
    const stored = galleryFileDoc()[0];
    assert.equal(JSON.stringify(stored).includes('must-not-persist'), false);
    assert.equal(JSON.stringify(stored).includes('data:image'), false);
    assert.deepEqual(await listCards({ reconcile: false }), [card]);
});

test('removes nested secrets and image bytes from provenance metadata', async () => {
    const { addCard } = await import('../src/gallery-index.js');
    const card = await addCard({
        id: 'nested-safe',
        imagePath: 'user/images/UR%20Image%20Studio/nested.png',
        provenance: {
            source: 'openrouter',
            authorization: 'Bearer do-not-store',
            upstream: { apiKey: 'hidden', requestId: 'req-1' },
        },
        refs: [{ id: 'ref-1', image: 'data:image/png;base64,secret-bytes', name: 'Aria' }],
    });

    assert.deepEqual(card.provenance, { source: 'openrouter', upstream: { requestId: 'req-1' } });
    assert.deepEqual(card.refs, [{ id: 'ref-1', name: 'Aria' }]);
    assert.equal(JSON.stringify([...serverFiles.values()]).match(/do-not-store|"hidden":true|data:image|secret-bytes/), null);
});

test('updates and deletes cards by stable id', async () => {
    const { addCard, updateCard, removeCard, listCards } = await import('../src/gallery-index.js');
    await addCard({ id: 'same-id', imagePath: 'user/images/UR%20Image%20Studio/one.png', prompt: 'first' });
    const updated = await updateCard('same-id', { prompt: 'updated', id: 'ignored', imagePath: 'other' });

    assert.equal(updated.id, 'same-id');
    assert.equal(updated.prompt, 'updated');
    assert.equal(updated.imagePath, 'user/images/UR%20Image%20Studio/one.png');
    assert.equal(await removeCard('same-id'), true);
    assert.deepEqual(await listCards({ reconcile: false }), []);
});

test('reconciles missing native files and keeps manually added files as metadata-light cards', async () => {
    const { addCard, reconcileCards } = await import('../src/gallery-index.js');
    await addCard({ id: 'known', imagePath: 'user/images/UR%20Image%20Studio/known.png', prompt: 'known' });
    await addCard({ id: 'gone', imagePath: 'user/images/UR%20Image%20Studio/gone.png', prompt: 'gone' });

    const cards = await reconcileCards([
        'user/images/UR%20Image%20Studio/known.png',
        'user/images/UR%20Image%20Studio/manual.webp',
    ]);

    assert.equal(cards.find(card => card.id === 'known').status, 'ready');
    assert.equal(cards.find(card => card.id === 'gone').status, 'missing');
    const manual = cards.find(card => card.imagePath.endsWith('/manual.webp'));
    assert.ok(manual);
    assert.equal(manual.prompt, '');
    assert.equal(manual.status, 'ready');
});

test('reconciles equivalent literal-space and encoded native paths without duplicates', async () => {
    const { addCard, reconcileCards } = await import('../src/gallery-index.js');
    await addCard({ id: 'equivalent', imagePath: 'user/images/UR Image Studio/shared name.png', prompt: 'kept' });

    const cards = await reconcileCards([
        '/user/images/UR%20Image%20Studio/shared%20name.png',
        'user/images/UR Image Studio/new name.png',
        'user/images/Other%20Folder/foreign.png',
        'user/images/UR%20Image%20Studio/nested/file.png',
    ]);

    assert.equal(cards.filter(card => card.imagePath.endsWith('/shared%20name.png')).length, 1);
    assert.equal(cards.find(card => card.id === 'equivalent').status, 'ready');
    assert.ok(cards.some(card => card.imagePath.endsWith('/new%20name.png')));
    // 'Other Folder' is now a valid single-segment folder (Task 1 relaxed the validator)
    assert.ok(cards.some(card => card.imagePath.includes('Other%20Folder')));
    assert.equal(cards.some(card => card.imagePath.includes('nested')), false);
});

test('reconciliation skips invalid injected entries while retaining valid entries', async () => {
    const { reconcileCards } = await import('../src/gallery-index.js');
    const cards = await reconcileCards([
        'https://evil.example/file.png',
        'user/images/UR%20Image%20Studio/valid.png',
        'user/images/UR Image Studio/bad%2.png',
    ]);
    assert.deepEqual(cards.map(card => card.imagePath), ['user/images/UR%20Image%20Studio/valid.png']);
});


test('sanitizes direct image data URLs in metadata values, not only reserved field names', async () => {
    const { addCard } = await import('../src/gallery-index.js');
    const card = await addCard({
        id: 'embedded-data-url',
        imagePath: 'user/images/UR%20Image%20Studio/safe.png',
        provenance: {
            source: 'provider',
            notes: 'data:image/png;base64,do-not-store-this',
            upstream: { requestId: 'req-1', response: 'data:image/webp;base64,also-not-safe' },
        },
    });

    assert.deepEqual(card.provenance, { source: 'provider', upstream: { requestId: 'req-1' } });
    assert.equal(JSON.stringify([...serverFiles.values()]).includes('data:image'), false);
});

test('rejects URLs, data URLs, absolute paths, and unsafe paths as image paths', async () => {
    const { addCard } = await import('../src/gallery-index.js');
    for (const imagePath of [
        'https://images.example/result.png',
        'data:image/png;base64,aGVsbG8=',
        'user/images/UR%20Image%20Studio/../result.png',
    ]) {
        await assert.rejects(() => addCard({ imagePath }), /native image path/);
    }
});

test('preserves safe nested metadata fields containing image while removing image payloads and secrets', async () => {
    const { addCard } = await import('../src/gallery-index.js');
    const card = await addCard({
        imagePath: 'user/images/UR%20Image%20Studio/safe.png',
        provenance: {
            imageModel: 'gpt-image-1',
            imageCount: 1,
            previewImage: 'data:image/png;base64,do-not-store',
            nested: { imageProvider: 'openai', token: 'do-not-store' },
        },
    });

    assert.deepEqual(card.provenance, {
        imageModel: 'gpt-image-1',
        imageCount: 1,
        nested: { imageProvider: 'openai' },
    });
});

test('hidden flag round-trips through sanitizeGalleryCard and defaults to false', async () => {
    const { addCard, updateCard, listCards } = await import('../src/gallery-index.js');
    await addCard({ id: 'h1', imagePath: 'user/images/Alice/one.png', prompt: 'p' });
    const hidden = await updateCard('h1', { hidden: true });
    assert.equal(hidden.hidden, true);
    const cards = await listCards({ reconcile: false });
    assert.equal(cards.find(c => c.id === 'h1').hidden, true);
    const fresh = await addCard({ id: 'h2', imagePath: 'user/images/Alice/two.png', prompt: 'p2' });
    assert.equal(fresh.hidden, false);
});

test('reconcileCards scans every distinct folder referenced by cards plus the legacy folder', async () => {
    const listedFolders = [];
    const ctx = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    globalThis.SillyTavern = {
        getContext: () => ctx,
        libs: { localforage: { getItem: async () => '' } },
    };
    globalThis.fetch = async (url, options = {}) => {
        const u = String(url);
        if (u === '/api/files/verify') return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        if (u === '/api/files/upload' && options.method === 'POST') {
            const body = JSON.parse(options.body);
            serverFiles.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        }
        if (u.startsWith('/user/files/')) {
            const name = decodeURIComponent(u.slice('/user/files/'.length));
            if (!serverFiles.has(name)) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
            return { ok: true, status: 200, text: async () => serverFiles.get(name), json: async () => ({}) };
        }
        const body = JSON.parse(options.body);
        listedFolders.push(body.folder);
        if (body.folder === 'UR Image Studio') return { ok: true, json: async () => ['legacy.png'] };
        if (body.folder === 'Alice') return { ok: true, json: async () => ['alice1.png'] };
        return { ok: true, json: async () => [] };
    };
    const { addCard, reconcileCards } = await import('../src/gallery-index.js');
    await addCard({ id: 'a', imagePath: 'user/images/Alice/alice1.png', prompt: 'alice' });
    await addCard({ id: 'l', imagePath: 'user/images/UR%20Image%20Studio/legacy.png', prompt: 'legacy' });
    await addCard({ id: 'gone', imagePath: 'user/images/Alice/missing.png', prompt: 'gone' });

    const cards = await reconcileCards();

    assert.ok(listedFolders.includes('Alice'), 'Alice folder scanned');
    assert.ok(listedFolders.includes('UR Image Studio'), 'legacy folder scanned');
    assert.equal(cards.find(c => c.id === 'a').status, 'ready');
    assert.equal(cards.find(c => c.id === 'l').status, 'ready');
    assert.equal(cards.find(c => c.id === 'gone').status, 'missing');
});

test('persists natural dimensions on the card; bytes-like keys stay stripped', async () => {
    const { addCard, updateCard } = await import('../src/gallery-index.js');
    const card = await addCard({
        id: 'dims', imagePath: 'user/images/UR%20Image%20Studio/dims.png', prompt: 'sized',
        width: 800, height: 600,
    });
    assert.deepEqual({ width: card.width, height: card.height }, { width: 800, height: 600 });

    const updated = await updateCard('dims', { width: 1024, height: 768 });
    assert.deepEqual({ width: updated.width, height: updated.height }, { width: 1024, height: 768 });
    const stored = JSON.stringify(galleryFileDoc());
    assert.equal(stored.includes('"bytes"'), false);
});

test('persists the grid thumbnail path next to the full image path', async () => {
    const { addCard, updateCard } = await import('../src/gallery-index.js');
    const card = await addCard({
        id: 'thumb', imagePath: 'user/images/UR%20Image%20Studio/full.png', prompt: 'p',
    });
    assert.equal(card.thumbPath, undefined, 'карточка без миниатюры не должна получать пустой thumbPath');

    const updated = await updateCard('thumb', {
        thumbPath: 'user/images/URIS_Thumbs/full_thumb.webp',
    });
    assert.equal(updated.thumbPath, 'user/images/URIS_Thumbs/full_thumb.webp');
});
