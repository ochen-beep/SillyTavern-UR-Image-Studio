// @ts-check
/**
 * Gallery cards on the sharded server files (`uris_gallery_manifest.json` +
 * `uris_gallery_shard_*.json`; `uris_gallery.json` is only the migration
 * source): migration out of extensionSettings, the one-time strip that actually
 * shrinks settings.json, and the write-on-change discipline of reconcile.
 */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { makeUserFileServer } from './_helpers.js';

const extensionSettings = {};
let verifyAvailable = true;
let failUploads = false;
let saveCalls = 0;

// Фейковый user-files сервер: verifyAvailable роняет probe, failUploads роняет
// запись, /api/images/list отдаёт существующие нативные файлы, остальное — 200
// c json-массивом (как в прежнем локальном стбе).
const fileServer = makeUserFileServer({
    verify() {
        if (!verifyAvailable) return { ok: false, status: 404, text: async () => '' };
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    },
    onUpload() {
        if (failUploads) return { ok: false, status: 500, text: async () => 'boom' };
        return undefined;
    },
    fallback(url, options) {
        if (url === '/api/images/list') {
            const folder = JSON.parse(options.body).folder;
            // The native files that actually exist on this fake server.
            return { ok: true, json: async () => (folder === 'UR Image Studio' ? ['one.png'] : []) };
        }
        return { ok: true, status: 200, json: async () => [], text: async () => '' };
    },
});
const serverFiles = fileServer.serverFiles;
const uploads = fileServer.uploads;

const originalSt = globalThis.SillyTavern;
const originalFetch = globalThis.fetch;
const originalToastr = globalThis.toastr;

function installStubs() {
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings,
            saveSettingsDebounced: () => { saveCalls += 1; },
            getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
        }),
        libs: {
            localforage: {
                async getItem() { return null; },
                async setItem() {},
                async removeItem() {},
            },
        },
    };
    globalThis.toastr = { error() {} };
    globalThis.fetch = fileServer.fetch;
}

const gallery = await import('../src/gallery-index.js');

/** The legacy settings copy of the index. */
function settingsIndex() {
    return extensionSettings.ur_image_studio?.imageConnections?.galleryIndex;
}

function fileCards() {
    const manifestText = serverFiles.get(gallery.GALLERY_MANIFEST_NAME);
    if (!manifestText) return null;
    const cards = [];
    for (const row of (JSON.parse(manifestText).shards || [])) {
        const text = serverFiles.get(`${gallery.GALLERY_SHARD_PREFIX}${row.id}.json`);
        if (text) cards.push(...JSON.parse(text).records);
    }
    return cards;
}

/** Everything the gallery store has on the server (manifest + shard bodies). */
function galleryFileTexts() {
    return [...serverFiles.entries()]
        .filter(([name]) => name === gallery.GALLERY_MANIFEST_NAME || name.startsWith(gallery.GALLERY_SHARD_PREFIX))
        .map(([, text]) => text);
}

function seedSettingsCards(cards) {
    extensionSettings.ur_image_studio = { imageConnections: { galleryIndex: cards } };
}

const img = name => `user/images/UR%20Image%20Studio/${name}`;

beforeEach(() => {
    installStubs();
    for (const key of Object.keys(extensionSettings)) delete extensionSettings[key];
    serverFiles.clear();
    uploads.length = 0;
    verifyAvailable = true;
    failUploads = false;
    saveCalls = 0;
    gallery.resetGalleryStoreForTests();
});

afterEach(() => { gallery.resetGalleryStoreForTests(); });

after(() => {
    globalThis.SillyTavern = originalSt;
    globalThis.fetch = originalFetch;
    globalThis.toastr = originalToastr;
});

describe('gallery file store: load', () => {
    it('no file and no cards → nothing is created', async () => {
        assert.equal(await gallery.ensureGalleryStoreReady(), 'file');
        await gallery.flushGalleryWrites();
        assert.equal(serverFiles.size, 0, 'no empty file is created');
        assert.equal(saveCalls, 0);
    });

    it('a settings blob with no data starts from the empty file value', async () => {
        seedSettingsCards([{ id: 'stale', imagePath: img('s.png'), prompt: 's' }]);
        assert.equal(await gallery.ensureGalleryStoreReady(), 'file');
        assert.deepEqual(await gallery.listCards({ reconcile: false }), [], 'настройки больше не источник данных');
    });

    it('no user-files API → readonly, writes refused, nothing uploaded', async () => {
        verifyAvailable = false;
        assert.equal(await gallery.ensureGalleryStoreReady(), 'readonly');
        await gallery.addCard({ id: 'c1', imagePath: img('one.png'), prompt: 'one' });
        await gallery.flushGalleryWrites();

        assert.equal(gallery.galleryStoreMode(), 'readonly');
        assert.equal(uploads.length, 0, 'no user-files traffic');
    });
});

describe('gallery file store: writes', () => {
    it('persists add, update and remove into the card file', async () => {
        await gallery.ensureGalleryStoreReady();

        await gallery.addCard({ id: 'c1', imagePath: img('one.png'), prompt: 'one' });
        await gallery.flushGalleryWrites();
        assert.deepEqual(fileCards().map(c => c.id), ['c1']);

        await gallery.updateCard('c1', { thumbPath: 'user/images/URIS_Thumbs/one_thumb.webp' });
        await gallery.flushGalleryWrites();
        assert.equal(fileCards()[0].thumbPath, 'user/images/URIS_Thumbs/one_thumb.webp');

        await gallery.removeCard('c1');
        await gallery.flushGalleryWrites();
        assert.deepEqual(fileCards(), []);
    });

    it('keeps secrets and image bytes out of the card file', async () => {
        await gallery.ensureGalleryStoreReady();
        await gallery.addCard({
            id: 'c1', imagePath: img('one.png'), prompt: 'p',
            apiKey: 'must-not-persist',
            provenance: { token: 'nope', source: 'openrouter' },
            src: 'data:image/png;base64,secret-bytes',
        });
        await gallery.flushGalleryWrites();

        const raw = galleryFileTexts().join('\n');
        assert.equal(/must-not-persist|nope|data:image|secret-bytes/.test(raw), false);
        assert.equal(fileCards()[0].provenance.source, 'openrouter');
    });

    it('counts cards by image path once the store is loaded', async () => {
        await gallery.ensureGalleryStoreReady();
        await gallery.addCard({ id: 'a', imagePath: img('shared.png'), prompt: 'a' });
        await gallery.addCard({ id: 'b', imagePath: img('shared.png'), prompt: 'b' });
        await gallery.flushGalleryWrites();

        assert.equal(gallery.countCardsByImagePath(img('shared.png')), 2);
        assert.equal(gallery.countCardsByImagePath(img('other.png')), 0);
    });
});

describe('gallery file store: reconcile', () => {
    it('does not write when nothing changed', async () => {
        await gallery.ensureGalleryStoreReady();
        await gallery.addCard({ id: 'c1', imagePath: img('one.png'), prompt: 'one' });
        await gallery.flushGalleryWrites();
        const writesSoFar = uploads.length;

        await gallery.listCards();
        await gallery.listCards();
        await gallery.flushGalleryWrites();

        assert.equal(uploads.length, writesSoFar,
            'opening the gallery must not rewrite the whole index');
    });

    it('writes when a card status flips or a native file appears', async () => {
        await gallery.ensureGalleryStoreReady();
        await gallery.addCard({ id: 'gone', imagePath: img('gone.png'), prompt: 'gone' });
        await gallery.flushGalleryWrites();
        const writesSoFar = uploads.length;

        await gallery.reconcileCards([img('manual.webp')]);
        await gallery.flushGalleryWrites();

        assert.equal(uploads.length > writesSoFar, true, 'a real change persists');
        const cards = fileCards();
        assert.equal(cards.find(c => c.id === 'gone').status, 'missing');
        assert.equal(cards.some(c => c.imagePath.endsWith('/manual.webp')), true);
    });

    it('does not bump updatedAt for untouched cards on reconcile', async () => {
        await gallery.ensureGalleryStoreReady();
        const before = await gallery.addCard({ id: 'c1', imagePath: img('one.png'), prompt: 'one' });
        await gallery.flushGalleryWrites();

        await gallery.reconcileCards([img('one.png')]);
        await gallery.flushGalleryWrites();

        const after_ = (await gallery.listCards({ reconcile: false })).find(c => c.id === 'c1');
        assert.equal(after_.updatedAt, before.updatedAt, 'an unchanged card keeps its timestamp');
    });
});

describe('gallery file store: two-session lost update', () => {
    it('a second tab writing between this session writes does not roll back its cards', async () => {
        await gallery.ensureGalleryStoreReady();
        await gallery.addCard({ id: 'a', imagePath: img('a.png'), prompt: 'a' });
        await gallery.flushGalleryWrites();

        // Вторая вкладка: тот же код (merge per shard), своё зеркало, общие файлы.
        const { createShardedFileStore } = await import('../src/sharded-file-store.js');
        const { resetFileStoresForTests } = await import('../src/file-store.js');
        const tabB = createShardedFileStore({
            label: 'gallery-tab-b',
            manifestName: gallery.GALLERY_MANIFEST_NAME,
            shardPrefix: gallery.GALLERY_SHARD_PREFIX,
            monolithName: gallery.GALLERY_FILE_NAME,
            monolithKey: 'cards',
            version: gallery.GALLERY_STORE_VERSION,
            shardTarget: 250,
            append: 'front',
            placeByStamp: true,
            empty: () => [],
            countEntries: value => (Array.isArray(value) ? value.length : null),
            mergeWithServer: true,
        });
        try {
            await tabB.ready();
            await tabB.mutate(list => {
                list.unshift({
                    id: 'c', imagePath: img('c.png'), prompt: 'c',
                    createdAt: Date.now(), updatedAt: Date.now(), status: 'ready',
                });
            });
            await tabB.flush();

            const ids = fileCards().map(c => c.id).sort();
            assert.deepEqual(ids, ['a', 'c'],
                'карточка первой вкладки «a» не должна быть затёрта записью второй вкладки');
        } finally {
            resetFileStoresForTests();
        }
    });

    it('an external stale whole-shard overwrite is picked up by the pre-write merge', async () => {
        await gallery.ensureGalleryStoreReady();
        await gallery.addCard({ id: 'a', imagePath: img('a.png'), prompt: 'a' });
        await gallery.flushGalleryWrites();

        // Внешний писатель (Syncthing/старая сборка) кладёт свой шард целиком.
        const foreignCard = {
            id: 'b', imagePath: img('b.png'), prompt: 'b',
            createdAt: Date.now(), updatedAt: Date.now(), status: 'ready',
        };
        serverFiles.set(`${gallery.GALLERY_SHARD_PREFIX}s0000.json`, JSON.stringify({
            v: gallery.GALLERY_STORE_VERSION, kind: 'shard', store: 'gallery', id: 's0000',
            records: [foreignCard],
        }));

        // Локальная сессия пишет снова: pre-write merge перечитывает шард и
        // вбирает чужую карточку в свою запись (карточка «a» при этом честно
        // удалена внешней записью шарда целиком — сервер её уже не имел).
        await gallery.addCard({ id: 'c', imagePath: img('c.png'), prompt: 'c' });
        await gallery.flushGalleryWrites();

        const ids = fileCards().map(c => c.id).sort();
        assert.deepEqual(ids, ['b', 'c']);
    });
});
