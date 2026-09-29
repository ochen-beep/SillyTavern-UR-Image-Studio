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
