// @ts-check
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

let originalFetch;
let originalSt;
let ctx;
let uploadedFolders = [];
let deletedPaths = [];
let listedFolders = [];

beforeEach(async () => {
    originalFetch = globalThis.fetch;
    originalSt = globalThis.SillyTavern;
    uploadedFolders = [];
    deletedPaths = [];
    listedFolders = [];
    ctx = {
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
        characterId: 0,
        characters: [{ name: 'Aria' }],
        groupId: null,
    };
    globalThis.SillyTavern = {
        getContext: () => ctx,
        libs: { localforage: { getItem: async () => '' } },
    };
    const serverFiles = new Map();
    // Хранилище должно отвечать ДО clearCards(): ready() с недоступной
    // поверхностью ждёт, а не откатывается в settings-мир.
    globalThis.fetch = async (url, options = {}) => {
        if (url === '/api/files/verify') return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        if (url === '/api/files/upload' && options.method === 'POST') {
            const body = JSON.parse(options.body);
            serverFiles.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        }
        if (String(url).startsWith('/user/files/')) {
            const name = decodeURIComponent(String(url).slice('/user/files/'.length));
            if (!serverFiles.has(name)) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
            return { ok: true, status: 200, text: async () => serverFiles.get(name), json: async () => ({}) };
        }
        if (url === '/api/images/upload') {
            const body = JSON.parse(options.body);
            uploadedFolders.push(body.ch_name);
            return { ok: true, json: async () => ({ path: `user/images/${encodeURIComponent(body.ch_name)}/${body.filename}.png` }) };
        }
        if (url === '/api/images/delete') {
            deletedPaths.push(JSON.parse(options.body).path);
            return { ok: true, json: async () => ({}) };
        }
        if (url === '/api/images/list') {
            const folder = JSON.parse(options.body).folder;
            listedFolders.push(folder);
            // Return filenames that match cards added in this test.
            if (folder === 'Aria') return { ok: true, json: async () => ['aria_scene.png', 's.png', 'h.png'] };
            if (folder === 'UR Image Studio') return { ok: true, json: async () => ['old.png'] };
            return { ok: true, json: async () => [] };
        }
        return { ok: true, json: async () => ({}) };
    };
    // Clear in-memory gallery index from any prior test.
    const { clearCards } = await import('../src/gallery-index.js');
    await clearCards();
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.SillyTavern = originalSt;
});

test('generation lands in the character folder and reconcile confirms it', async () => {
    const { addCard, listCards } = await import('../src/gallery-index.js');
    // Simulate a card that the generation pipeline would have produced:
    await addCard({
        id: 'gen-1',
        imagePath: 'user/images/Aria/aria_scene.png',
        prompt: 'portrait',
        provenance: { chatId: 'c1', characterFolder: 'Aria' },
    });
    const cards = await listCards(); // triggers reconcile
    assert.equal(cards.find(c => c.id === 'gen-1')?.status, 'ready');
    assert.ok(listedFolders.includes('Aria'), 'reconcile scanned the Aria folder');
});

test('soft delete hides; hard delete removes card and file', async () => {
    const { addCard, listCards } = await import('../src/gallery-index.js');
    const { deleteGalleryCard, getGallery } = await import('../src/storage.js');
    await addCard({ id: 'soft', imagePath: 'user/images/Aria/s.png', prompt: 'p', provenance: { chatId: 'c1' } });
    await addCard({ id: 'hard', imagePath: 'user/images/Aria/h.png', prompt: 'p', provenance: { chatId: 'c1' } });

    await deleteGalleryCard('c1', 'soft', { deleteFile: false });
    await deleteGalleryCard('c1', 'hard', { deleteFile: true });

    const visible = await getGallery('c1');
    assert.deepEqual(visible.map(c => c.id), []);
    const all = await listCards({ reconcile: false });
    assert.equal(all.find(c => c.id === 'soft').hidden, true);
    assert.equal(all.find(c => c.id === 'hard'), undefined);
    assert.ok(deletedPaths.includes('user/images/Aria/h.png'));
    assert.equal(deletedPaths.includes('user/images/Aria/s.png'), false);
});

test('legacy folder cards still reconcile after the validator relaxation', async () => {
    const { addCard, listCards } = await import('../src/gallery-index.js');
    await addCard({ id: 'legacy-1', imagePath: 'user/images/UR%20Image%20Studio/old.png', prompt: 'p', provenance: { chatId: 'c1' } });
    const cards = await listCards();
    assert.equal(cards.find(c => c.id === 'legacy-1').status, 'ready');
    assert.ok(listedFolders.includes('UR Image Studio'), 'legacy folder still scanned');
});
