// @ts-check
// Orphan sweep: report-only listing of URIS image files no live record points
// at; deletion counts successes and tolerates already-gone files.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals, mockFetch } from './_helpers.js';

installStGlobals();
globalThis.SillyTavern.getContext = () => ({ getRequestHeaders: () => ({}) });

const { deleteOrphanFiles, deleteUserFiles, findOrphanRefFiles } = await import('../src/data-care.js');

test('the sweep reports only files no live record points at', async () => {
    const orphans = await findOrphanRefFiles({
        listFolder: async (folder) => folder === 'URIS_Refs'
            ? ['user/images/URIS_Refs/used.png', 'user/images/URIS_Refs/orphan.png']
            : ['user/images/URIS_Thumbs/used-thumb.webp', 'user/images/URIS_Thumbs/lost-thumb.webp'],
        refs: async () => [{ id: 'r1', imagePath: 'user/images/URIS_Refs/used.png', thumbPath: 'user/images/URIS_Thumbs/used-thumb.webp' }],
        cards: async () => [],
    });
    assert.deepEqual(orphans, [
        'user/images/URIS_Refs/orphan.png',
        'user/images/URIS_Thumbs/lost-thumb.webp',
    ], 'used files stay, orphans surface');
});

test('the referenced set includes gallery card thumbnails', async () => {
    const orphans = await findOrphanRefFiles({
        listFolder: async (folder) => folder === 'URIS_Refs'
            ? []
            : ['user/images/URIS_Thumbs/kept.webp', 'user/images/URIS_Thumbs/lost.webp'],
        refs: async () => [],
        cards: async () => [{ id: 'c1', thumbPath: 'user/images/URIS_Thumbs/kept.webp' }],
    });
    assert.deepEqual(orphans, ['user/images/URIS_Thumbs/lost.webp']);
});

test('deleteOrphanFiles counts deletes and tolerates already-gone files', async () => {
    const restore = mockFetch((url, options) => {
        if (String(url) === '/api/images/delete') {
            const body = JSON.parse(options.body);
            return body.path.includes('gone') ? { ok: false, status: 404 } : { ok: true, status: 200 };
        }
        throw new Error(`unexpected ${url}`);
    });
    try {
        const deleted = await deleteOrphanFiles(['user/images/URIS_Refs/a.png', 'user/images/URIS_Refs/gone.png']);
        assert.equal(deleted, 2, '404 means the target state (gone) is reached');
    } finally { restore(); }
});

test('deleteUserFiles removes named stores and bounded shard range', async () => {
    const deleted = [];
    let shardProbes = 0;
    const del = async (name) => {
        if (name.startsWith('uris_refs_shard_s000')) { deleted.push(name); shardProbes++; return true; }
        if (name === 'uris_templates.json' || name === 'uris_templates.json.corrupt') { deleted.push(name); return true; }
        return false;   // miss
    };
    const count = await deleteUserFiles({ deleteFile: del });
    assert.ok(shardProbes >= 3 && shardProbes < 60, `the shard walk stops after a run of misses (${shardProbes})`);
    assert.ok(deleted.includes('uris_templates.json'));
    assert.ok(deleted.includes('uris_templates.json.corrupt'), 'corrupt side files are swept too');
    assert.equal(count, deleted.length);
});
