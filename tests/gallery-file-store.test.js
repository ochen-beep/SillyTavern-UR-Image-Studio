// @ts-check
/**
 * Gallery cards on the server-side card file (`uris_gallery.json`):
 * migration out of extensionSettings, the one-time strip that actually shrinks
 * settings.json, and the write-on-change discipline of reconcile.
 */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

const extensionSettings = {};
const serverFiles = new Map();
const uploads = [];
let verifyAvailable = true;
let failUploads = false;
let saveCalls = 0;

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
    globalThis.fetch = fetchStub;
}

const fetchStub = async (url, options = {}) => {
    if (url === '/api/files/verify') {
        if (!verifyAvailable) return { ok: false, status: 404, text: async () => '' };
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    if (url === '/api/files/upload' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        uploads.push(body);
        if (failUploads) return { ok: false, status: 500, text: async () => 'boom' };
        serverFiles.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    if (url === '/api/images/list') {
        const folder = JSON.parse(options.body).folder;
        // The native files that actually exist on this fake server.
        return { ok: true, json: async () => (folder === 'UR Image Studio' ? ['one.png'] : []) };
    }
    if (url.startsWith('/user/files/')) {
        const name = decodeURIComponent(url.slice('/user/files/'.length));
        if (!serverFiles.has(name)) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
        return { ok: true, status: 200, text: async () => serverFiles.get(name), json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => [], text: async () => '' };
};

const gallery = await import('../src/gallery-index.js');

/** The legacy settings copy of the index. */
function settingsIndex() {
    return extensionSettings.ur_image_studio?.imageConnections?.galleryIndex;
}

function fileCards() {
    const text = serverFiles.get(gallery.GALLERY_FILE_NAME);
    if (!text) return null;
    return JSON.parse(text).cards;
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

describe('gallery file store: migration', () => {
    it('moves the settings index into the file and strips it, freeing the bytes', async () => {
        seedSettingsCards([
            { id: 'c1', imagePath: img('one.png'), prompt: 'one', status: 'ready' },
            { id: 'c2', imagePath: img('two.png'), prompt: 'two', status: 'ready' },
        ]);

        assert.equal(await gallery.ensureGalleryStoreReady(), 'file');
        await gallery.flushGalleryWrites();

        assert.deepEqual(fileCards().map(c => c.id), ['c1', 'c2']);
        assert.equal(Object.hasOwn(extensionSettings.ur_image_studio.imageConnections, 'galleryIndex'), false,
            'the settings copy is what makes settings.json big — it must be gone');
        assert.equal(gallery.galleryStoreMode(), 'file');
    });

    it('leaves settings.json untouched when there is nothing to migrate', async () => {
        assert.equal(await gallery.ensureGalleryStoreReady(), 'file');
        await gallery.flushGalleryWrites();
        assert.equal(serverFiles.size, 0, 'no empty file is created');
        assert.equal(saveCalls, 0);
    });

    it('does not strip the settings copy when the migration write fails', async () => {
        seedSettingsCards([{ id: 'c1', imagePath: img('one.png'), prompt: 'one' }]);
        failUploads = true;

        await gallery.ensureGalleryStoreReady();
        await gallery.flushGalleryWrites();

        assert.deepEqual(settingsIndex().map(c => c.id), ['c1'], 'data survives a failed migration');
        assert.equal(serverFiles.size, 0);
    });

    it('an existing file wins and the stale settings copy is dropped', async () => {
        serverFiles.set(gallery.GALLERY_FILE_NAME, JSON.stringify({
            v: gallery.GALLERY_STORE_VERSION,
            cards: [{ id: 'from-file', imagePath: img('f.png'), prompt: 'f', status: 'ready' }],
        }));
        seedSettingsCards([{ id: 'stale', imagePath: img('s.png'), prompt: 's' }]);

        await gallery.ensureGalleryStoreReady();
        assert.deepEqual((await gallery.listCards({ reconcile: false })).map(c => c.id), ['from-file']);
        assert.equal(Object.hasOwn(extensionSettings.ur_image_studio.imageConnections, 'galleryIndex'), false);
    });

    it('shrinks the module settings footprint by roughly the size of the index', async () => {
        const { measureSettingsFootprint } = await import('../src/file-store.js');
        // A miniature version of the real situation: many cards carrying a long
        // prompt. This is the number the whole change is judged by.
        seedSettingsCards(Array.from({ length: 50 }, (_, i) => ({
            id: `c${i}`, imagePath: img(`f${i}.png`), prompt: 'x'.repeat(2000), status: 'ready',
        })));
        const before = measureSettingsFootprint('ur_image_studio');

        await gallery.ensureGalleryStoreReady();
        await gallery.flushGalleryWrites();

        const after = measureSettingsFootprint('ur_image_studio');
        assert.equal(before.entries.galleryIndex, 50);
        assert.equal(after.entries.galleryIndex ?? 0, 0, 'no cards left in settings');
        assert.equal(after.settingsBytes < before.settingsBytes / 10, true,
            `expected a large drop, got ${before.settingsBytes} → ${after.settingsBytes}`);
        assert.equal(fileCards().length, 50, 'all cards survived the move');
    });

    it('falls back to the settings store when user-files is unavailable', async () => {
        verifyAvailable = false;
        seedSettingsCards([]);
        const card = await gallery.addCard({ id: 'c1', imagePath: img('one.png'), prompt: 'one' });

        assert.equal(gallery.galleryStoreMode(), 'legacy');
        assert.equal(uploads.length, 0, 'no user-files traffic');
        assert.equal(saveCalls > 0, true, 'settings store persists via saveSettings');
        assert.equal(settingsIndex()[0].id, card.id);
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

        const raw = serverFiles.get(gallery.GALLERY_FILE_NAME);
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
