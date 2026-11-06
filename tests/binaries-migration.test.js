// @ts-check
// Фаза 3: перенос бинарников в user/files + свип сирот через реестр.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals, makeUserFileServer } from './_helpers.js';

installStGlobals();
const fileServer = makeUserFileServer();
const serverFiles = fileServer.serverFiles;
globalThis.fetch = fileServer.fetch;

const { migrateOneBinary, migrateStoredBinaries } = await import('../src/binaries-migration.js');
const { findOrphanRefFiles } = await import('../src/data-care.js');
const refsLib = await import('../src/refs-library.js');
const gallery = await import('../src/gallery-index.js');

test('migrateOneBinary: копирует legacy-бинарник в user/files, пропускает уже перенесённое', async () => {
    const uploads = [];
    const deps = {
        fetch: async (url) => url === '/user/images/URIS_Refs/a.png'
            ? { ok: true, arrayBuffer: async () => new TextEncoder().encode('PNG').buffer }
            : { ok: false, status: 404 },
        upload: async (name, b64) => { uploads.push([name, b64]); return `user/files/${name}`; },
    };
    const moved = await migrateOneBinary('user/images/URIS_Refs/a.png', 'ref', deps);
    assert.match(moved, /^user\/files\/uris_ref_a_[a-z0-9]+\.png$/);
    assert.equal(uploads.length, 1);
    assert.equal(atob(uploads[0][1]), 'PNG', 'байты доехали как base64');

    assert.equal(await migrateOneBinary('user/files/uris_ref_x_1.png', 'ref', deps), null, 'user/files пропускается');
    assert.equal(await migrateOneBinary('user/images/URIS_Refs/gone.png', 'ref', deps), null, '404 → null, старый путь остаётся');
    assert.equal(await migrateOneBinary('', 'ref', deps), null);
});

test('migrateStoredBinaries: перевешивает референсы и превью карточек на user/files', async () => {
    serverFiles.clear();
    serverFiles.set('uris_refs.json', JSON.stringify({ v: 1, data: {
        refs: [
            { id: 'r1', name: 'a', imagePath: 'user/images/URIS_Refs/a.png', thumbPath: 'user/images/URIS_Thumbs/a.webp' },
            { id: 'r2', name: 'b', imagePath: 'user/files/uris_ref_b_x.png' },
        ],
        folders: [],
    } }));
    refsLib.resetRefStoreForTests();
    gallery.resetGalleryStoreForTests();
    try {
        await gallery.addCard({ id: 'c1', imagePath: 'user/images/UR%20Image%20Studio/g.png', thumbPath: 'user/images/URIS_Thumbs/g.webp' });

        const moves = [];
        const moved = await migrateStoredBinaries({
            migrate: async (path, prefix) => {
                if (typeof path !== 'string' || !path.startsWith('user/images/')) return null;
                moves.push([prefix, path]);
                return `user/files/uris_${prefix}_moved_x.png`;
            },
        });
        assert.equal(moved, 3, 'imagePath+thumbPath рефа + thumbPath карточки; r2 уже перенесён');
        assert.deepEqual(moves.map(m => m[0]).sort(), ['ref', 'thumb', 'thumb']);

        const refs = await refsLib.listRefs();
        assert.equal(refs.find(r => r.id === 'r1').imagePath, 'user/files/uris_ref_moved_x.png');
        assert.equal(refs.find(r => r.id === 'r1').thumbPath, 'user/files/uris_thumb_moved_x.png');
        assert.equal(refs.find(r => r.id === 'r2').imagePath, 'user/files/uris_ref_b_x.png', 'не тронут');
        const card = (await gallery.listCards({ reconcile: false })).find(c => c.id === 'c1');
        assert.equal(card.thumbPath, 'user/files/uris_thumb_moved_x.png');

        // Идемпотентность: второй прогон ничего не двигает.
        const again = await migrateStoredBinaries({ migrate: async () => { throw new Error('must not be called'); } });
        assert.equal(again, 0);
    } finally {
        refsLib.resetRefStoreForTests();
        gallery.resetGalleryStoreForTests();
        serverFiles.clear();
    }
});

test('свип находит сирот в user/files через реестр, живые и чужие файлы не трогает', async () => {
    const orphans = await findOrphanRefFiles({
        listFolder: async () => [],
        refs: async () => [{ imagePath: 'user/files/uris_ref_live_1.png', thumbPath: 'user/files/uris_thumb_live_1.webp' }],
        cards: async () => [],
        protectedFiles: () => [
            { url: 'user/files/uris_ref_live_1.png' },
            { url: 'user/files/uris_thumb_live_1.webp' },
            { url: 'user/files/uris_ref_dead_2.png' },
            { url: 'user/files/uris_thumb_dead_2.webp' },
            { url: 'user/files/uris_refs.json' },        // метадата — не в скоупе свипа бинарников
            { url: 'user/files/notes.txt' },             // чужое
        ],
    });
    assert.deepEqual(orphans, ['user/files/uris_ref_dead_2.png', 'user/files/uris_thumb_dead_2.webp']);
});
