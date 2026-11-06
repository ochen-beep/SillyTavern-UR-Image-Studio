// @ts-check
// Фаза 4, UI-часть: восстановление карточек из вшитых подписей.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals, makeUserFileServer } from './_helpers.js';

installStGlobals();
const fileServer = makeUserFileServer();
const serverFiles = fileServer.serverFiles;
globalThis.fetch = fileServer.fetch;

const gallery = await import('../src/gallery-index.js');

beforeEach(() => {
    serverFiles.clear();
    gallery.resetGalleryStoreForTests();
});

test('восстановление: карточка создаётся из подписи, существующая не трогается, без подписи — пропуск', async () => {
    // существующая карточка (например, выжила после аварии)
    await gallery.addCard({ id: 'keep', imagePath: 'user/images/Damien/old.png', prompt: 'original' });

    const deps = {
        listFolders: async () => ['Damien', 'URIS_Thumbs'],
        listFiles: async (folder) => folder === 'Damien'
            ? ['user/images/Damien/old.png', 'user/images/Damien/new.png', 'user/images/Damien/no-sidecar.png', 'user/images/Damien/legacy.jpg']
            : ['user/files/uris_thumb_x.webp'],
        readSidecar: async (path) => {
            if (path.endsWith('new.png')) return { v: 1, prompt: 'Ханна ♥', model: 'gemini-3.1-flash-image', connectionId: 'c1', routeId: 'r1', contract: 'gemini-native', aspect: '4:3', refs: ['r1', 'r2'], chatId: 'chat-9', requestId: 'req-1', createdAt: 12345 };
            return null;
        },
    };
    const result = await gallery.restoreCardsFromSidecars(deps);
    // scanned: 3 файла без карточки (old.png уже имеет карточку; URIS_Thumbs пропущена как служебная)
    assert.deepEqual(result, { scanned: 3, restored: 1 });

    const cards = await gallery.listCards({ reconcile: false });
    assert.equal(cards.length, 2);
    const restored = cards.find(c => c.imagePath === 'user/images/Damien/new.png');
    assert.ok(restored, 'карточка создана');
    assert.equal(restored.prompt, 'Ханна ♥');
    assert.equal(restored.modelId, 'gemini-3.1-flash-image');
    assert.equal(restored.generationContract, 'gemini-native');
    assert.equal(restored.aspectRatio, '4:3');
    assert.deepEqual(restored.referenceIds, ['r1', 'r2']);
    assert.equal(restored.provenance.chatId, 'chat-9');
    assert.equal(restored.provenance.restored, true);
    assert.equal(restored.createdAt, 12345);
    const keep = cards.find(c => c.id === 'keep');
    assert.equal(keep.prompt, 'original', 'существующая карточка не перезаписана');

    // Идемпотентность: второй прогон — restored 0.
    // после первого прогона карточка new.png существует → scanned 2 (no-sidecar + legacy.jpg)
    assert.deepEqual(await gallery.restoreCardsFromSidecars(deps), { scanned: 2, restored: 0 });
});

test('без injected deps работает против стаба fetch (регрессия: getCtx не был импортирован)', async () => {
    const result = await gallery.restoreCardsFromSidecars();
    assert.deepEqual(result, { scanned: 0, restored: 0 });
});
