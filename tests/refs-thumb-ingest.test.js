// @ts-check
// Ingest thumbnails: the pool tile must decode the small URIS_Thumbs file, not
// the full edge-1024 image. The thumbnail is best-effort — its failure never
// fails the ingest — and old records without one keep the full-image fallback.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals } from './_helpers.js';

installStGlobals();
globalThis.SillyTavern.getContext = () => ({ getRequestHeaders: () => ({}), chat: [], chatId: 'chat-1', extensionSettings: { ur_image_studio: {} } });

const { ingestReferenceImage } = await import('../src/references.js');
const { normalizePoolReference } = await import('../src/refs-library.js');
const { poolTileHtml } = await import('../src/ui/refs-view-shared.js');

const OPTIMIZED = { dataUrl: 'data:image/jpeg;base64,aGVsbG8=', mime: 'image/jpeg', width: 1024, height: 768, sourceBytes: 10, optimizedBytes: 8, optimizationVersion: 'v3' };

test('ingest stores the thumbnail path next to the image path', async () => {
    const uploaded = [];
    const result = await ingestReferenceImage('blob', 'ref_1.png', {
        optimize: async () => OPTIMIZED,
        upload: async (dataUrl, name) => { uploaded.push(name); return 'user/images/URIS_Refs/ref_1.png'; },
        thumb: async (imagePath) => {
            assert.equal(imagePath, 'user/images/URIS_Refs/ref_1.png', 'the thumb derives from the uploaded image');
            return 'user/images/URIS_Thumbs/ref_1_thumb.webp';
        },
    });
    assert.equal(result.imagePath, 'user/images/URIS_Refs/ref_1.png');
    assert.equal(result.metadata.thumbPath, 'user/images/URIS_Thumbs/ref_1_thumb.webp');
});

test('a failed thumbnail never fails the ingest', async () => {
    const result = await ingestReferenceImage('blob', 'ref_2.png', {
        optimize: async () => OPTIMIZED,
        upload: async () => 'user/images/URIS_Refs/ref_2.png',
        thumb: async () => { throw new Error('no canvas'); },
    });
    assert.equal(result.metadata.thumbPath, undefined, 'record falls back to the full image');
    assert.equal(result.imagePath, 'user/images/URIS_Refs/ref_2.png');
});

test('pool records keep a valid thumbPath and drop a foreign one', () => {
    const kept = normalizePoolReference({ id: 'r1', name: 'A', imagePath: 'user/images/URIS_Refs/a.png', thumbPath: 'user/images/URIS_Thumbs/a_thumb.webp' });
    assert.equal(kept.thumbPath, 'user/images/URIS_Thumbs/a_thumb.webp');
    const dropped = normalizePoolReference({ id: 'r2', name: 'B', imagePath: 'user/images/URIS_Refs/b.png', thumbPath: 'https://evil.example/t.webp' });
    assert.equal(dropped.thumbPath, undefined);
});

test('pool tiles decode the thumbnail; records without one fall back', () => {
    const withThumb = poolTileHtml({ id: 'r1', name: 'A', imagePath: 'user/images/URIS_Refs/a.png', thumbPath: 'user/images/URIS_Thumbs/a_thumb.webp' }, new Map());
    assert.match(withThumb, /src="user\/images\/URIS_Thumbs\/a_thumb\.webp"/);
    const legacy = poolTileHtml({ id: 'r2', name: 'B', imagePath: 'user/images/URIS_Refs/b.png' }, new Map());
    assert.match(legacy, /src="user\/images\/URIS_Refs\/b\.png"/, 'old records keep working via the fallback');
});
