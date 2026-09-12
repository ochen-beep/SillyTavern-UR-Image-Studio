// @ts-check
/**
 * Reference pool and parameter presets on their server files:
 * migration out of extensionSettings, the strip that shrinks settings.json, and
 * CRUD landing in the file.
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
            chatMetadata: {},
            saveSettingsDebounced: () => { saveCalls += 1; },
            saveMetadata: () => {},
            getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
        }),
        libs: {
            localforage: {
                async getItem() { return null; },
                async setItem() {},
                async removeItem() {},
                async keys() { return []; },
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
    if (url.startsWith('/user/files/')) {
        const name = decodeURIComponent(url.slice('/user/files/'.length));
        if (!serverFiles.has(name)) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
        return { ok: true, status: 200, text: async () => serverFiles.get(name), json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => [], text: async () => '' };
};

const refs = await import('../src/refs-library.js');
const presets = await import('../src/param-presets.js');

function imageConnections() {
    return extensionSettings.ur_image_studio?.imageConnections;
}

function storedDoc(name) {
    const text = serverFiles.get(name);
    return text ? JSON.parse(text) : null;
}

beforeEach(() => {
    installStubs();
    for (const key of Object.keys(extensionSettings)) delete extensionSettings[key];
    serverFiles.clear();
    uploads.length = 0;
    verifyAvailable = true;
    failUploads = false;
    saveCalls = 0;
    refs.resetRefStoreForTests();
    presets.resetParamPresetStoreForTests();
});

afterEach(() => {
    refs.resetRefStoreForTests();
    presets.resetParamPresetStoreForTests();
});

after(() => {
    globalThis.SillyTavern = originalSt;
    globalThis.fetch = originalFetch;
    globalThis.toastr = originalToastr;
});

describe('reference pool file store', () => {
    it('migrates refs and folders out of settings, then strips both', async () => {
        extensionSettings.ur_image_studio = {
            imageConnections: {
                refs: [{ id: 'r1', name: 'Aria', imagePath: 'user/images/x/a.png' }],
                folders: [{ id: 'f1', name: 'Мама' }],
            },
        };

        assert.equal(await refs.ensureRefsStoreReady(), 'file');
        await refs.flushRefsWrites();

        const doc = storedDoc(refs.REFS_FILE_NAME);
        assert.deepEqual(doc.data.refs.map(r => r.id), ['r1']);
        assert.deepEqual(doc.data.folders.map(f => f.id), ['f1']);
        assert.equal(Object.hasOwn(imageConnections(), 'refs'), false, 'settings copy stripped');
        assert.equal(Object.hasOwn(imageConnections(), 'folders'), false, 'settings copy stripped');
    });

    it('does not strip when the migration write fails', async () => {
        extensionSettings.ur_image_studio = {
            imageConnections: { refs: [{ id: 'r1', name: 'Aria' }] },
        };
        failUploads = true;

        await refs.ensureRefsStoreReady();
        await refs.flushRefsWrites();

        assert.deepEqual(imageConnections().refs.map(r => r.id), ['r1'], 'data survives');
        assert.equal(serverFiles.size, 0);
    });

    it('writes created, updated and deleted references into the file', async () => {
        await refs.ensureRefsStoreReady();

        const created = await refs.createRef({ name: 'Aria', aliases: ['Ария'], description: 'рыжая' });
        await refs.flushRefsWrites();
        assert.deepEqual(storedDoc(refs.REFS_FILE_NAME).data.refs.map(r => r.id), [created.id]);

        await refs.updateRef(created.id, { name: 'Aria II' });
        await refs.flushRefsWrites();
        assert.equal(storedDoc(refs.REFS_FILE_NAME).data.refs[0].name, 'Aria II');

        await refs.deleteRef(created.id);
        await refs.flushRefsWrites();
        assert.deepEqual(storedDoc(refs.REFS_FILE_NAME).data.refs, []);
    });

    it('keeps folders in the same document as the pool', async () => {
        await refs.ensureRefsStoreReady();
        const folder = await refs.createFolder('Мама');
        await refs.createRef({ name: 'Aria', folders: [folder.id] });
        await refs.flushRefsWrites();

        const doc = storedDoc(refs.REFS_FILE_NAME);
        assert.deepEqual(doc.data.folders.map(f => f.name), ['Мама']);
        assert.deepEqual(doc.data.refs[0].folders, [folder.id]);
    });

    it('falls back to settings when user-files is unavailable', async () => {
        verifyAvailable = false;
        extensionSettings.ur_image_studio = { imageConnections: { refs: [] } };

        const created = await refs.createRef({ name: 'Aria' });

        assert.equal(refs.refsStoreMode(), 'legacy');
        assert.equal(uploads.length, 0);
        assert.equal(saveCalls > 0, true);
        assert.deepEqual(imageConnections().refs.map(r => r.id), [created.id]);
    });

    it('leaves folder preferences in settings (device-local UI state)', async () => {
        await refs.ensureRefsStoreReady();
        refs.saveFolderPrefs({ sort: 'name' });
        assert.equal(imageConnections().folderPrefs.sort, 'name');
    });
});

describe('parameter preset file store', () => {
    it('migrates presets out of settings, then strips the copy', async () => {
        extensionSettings.ur_image_studio = {
            imageConnections: { presets: [{ id: 'p1', name: 'Cinematic', aspectRatio: '16:9', imageSize: '2K' }] },
        };

        assert.equal(await presets.ensureParamPresetStoreReady(), 'file');
        await presets.flushParamPresetWrites();

        assert.deepEqual(storedDoc(presets.PRESETS_FILE_NAME).presets.map(p => p.id), ['p1']);
        assert.equal(Object.hasOwn(imageConnections(), 'presets'), false);
    });

    it('writes created, updated and deleted presets into the file', async () => {
        await presets.ensureParamPresetStoreReady();

        const created = await presets.createImageParam({ name: 'Cinematic', aspectRatio: '16:9' });
        await presets.flushParamPresetWrites();
        assert.deepEqual(storedDoc(presets.PRESETS_FILE_NAME).presets.map(p => p.id), [created.id]);

        await presets.saveImageParam({ id: created.id, name: 'Cinematic II' });
        await presets.flushParamPresetWrites();
        assert.equal(storedDoc(presets.PRESETS_FILE_NAME).presets[0].name, 'Cinematic II');

        await presets.deleteImageParam(created.id);
        await presets.flushParamPresetWrites();
        assert.deepEqual(storedDoc(presets.PRESETS_FILE_NAME).presets, []);
    });

    it('survives a reload from the file', async () => {
        await presets.ensureParamPresetStoreReady();
        await presets.createImageParam({ name: 'Cinematic' });
        await presets.flushParamPresetWrites();

        presets.resetParamPresetStoreForTests();
        const listed = await presets.listImageParams();
        assert.deepEqual(listed.map(p => p.name), ['Cinematic']);
    });
});

describe('backup round-trip with file-backed data', () => {
    it('exports the live pool and presets, not the (now empty) settings blob', async () => {
        const backup = await import('../src/data-port.js');

        await refs.ensureRefsStoreReady();
        await refs.createRef({ name: 'Aria', aliases: ['Ария'] });
        await refs.flushRefsWrites();
        await presets.ensureParamPresetStoreReady();
        await presets.createImageParam({ name: 'Cinematic' });
        await presets.flushParamPresetWrites();

        // The settings copies hold nothing after the migration strip, so an
        // exporter that only read settings would silently ship an empty backup.
        assert.equal(imageConnections()?.refs?.length ?? 0, 0);
        assert.equal(imageConnections()?.presets?.length ?? 0, 0);

        const exported = await backup.exportUrisData();

        assert.deepEqual(exported.shared.refs.map(r => r.name), ['Aria']);
        assert.deepEqual(exported.shared.presets.map(p => p.name), ['Cinematic']);
    });

    it('restores exported records back into the file stores on import', async () => {
        const backup = await import('../src/data-port.js');

        await refs.ensureRefsStoreReady();
        const ref = await refs.createRef({ name: 'Aria' });
        await refs.flushRefsWrites();
        await presets.ensureParamPresetStoreReady();
        await presets.createImageParam({ name: 'Cinematic' });
        await presets.flushParamPresetWrites();

        const exported = await backup.exportUrisData();

        // Wipe both file stores to prove the import is what repopulates them.
        serverFiles.clear();
        refs.resetRefStoreForTests();
        presets.resetParamPresetStoreForTests();

        await backup.importUrisData(exported, { mode: 'replace' });
        await refs.flushRefsWrites();
        await presets.flushParamPresetWrites();

        assert.deepEqual(storedDoc(refs.REFS_FILE_NAME).data.refs.map(r => r.id), [ref.id]);
        assert.deepEqual(storedDoc(presets.PRESETS_FILE_NAME).presets.map(p => p.name), ['Cinematic']);
        assert.deepEqual((await refs.listRefs()).map(r => r.name), ['Aria']);
    });

    it('a backup without refs/presets sections leaves the file stores alone', async () => {
        const backup = await import('../src/data-port.js');

        await refs.ensureRefsStoreReady();
        const ref = await refs.createRef({ name: 'Aria' });
        await refs.flushRefsWrites();
        await presets.ensureParamPresetStoreReady();
        await presets.createImageParam({ name: 'Cinematic' });
        await presets.flushParamPresetWrites();

        // A partial backup (settings-less export, hand-edited, foreign variant):
        // no refs/folders/presets keys in the shared section at all.
        const exported = await backup.exportUrisData();
        const partial = structuredClone(exported);
        delete partial.shared.refs;
        delete partial.shared.folders;
        delete partial.shared.presets;
        delete partial.shared.templates;
        delete partial.data.extensionSettings;

        await backup.importUrisData(partial, { mode: 'merge' });
        await refs.flushRefsWrites();
        await presets.flushParamPresetWrites();

        assert.deepEqual(
            storedDoc(refs.REFS_FILE_NAME).data.refs.map(r => r.id),
            [ref.id],
            'an absent section must not be imported as an empty pool',
        );
        assert.deepEqual(storedDoc(presets.PRESETS_FILE_NAME).presets.map(p => p.name), ['Cinematic']);
        assert.deepEqual((await refs.listRefs()).map(r => r.name), ['Aria']);
        assert.deepEqual((await presets.listImageParams()).map(p => p.name), ['Cinematic']);
    });

    it('an explicitly empty refs section is imported as empty (replace mode)', async () => {
        const backup = await import('../src/data-port.js');

        await refs.ensureRefsStoreReady();
        await refs.createRef({ name: 'Aria' });
        await refs.flushRefsWrites();

        const exported = await backup.exportUrisData();
        exported.shared.refs = [];
        delete exported.shared.presets;

        await backup.importUrisData(exported, { mode: 'replace' });
        await refs.flushRefsWrites();

        assert.deepEqual(storedDoc(refs.REFS_FILE_NAME).data.refs, [], 'the backup says the pool is empty');
    });
});
