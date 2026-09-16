// @ts-check
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, LF_REFS_POOL, LF_REFS_FOLDERS, META_KEY } from '../src/core.js';

const memoryStore = new Map();
const extensionSettings = {};
let settingsSaveCalls = 0;

function makeLocalforage() {
    return {
        async getItem(key) { return memoryStore.has(key) ? memoryStore.get(key) : []; },
        async setItem(key, value) { memoryStore.set(key, value); },
        async removeItem(key) { memoryStore.delete(key); },
    };
}

let _chatMetadata = {};
globalThis.SillyTavern = {
    getContext: () => ({
        // chatMetadata only exists while a chat is open — the stub mirrors that
        // invariant, otherwise chat-binding routing sends reads to the studio scope.
        chatId: 'test-chat',
        extensionSettings,
        saveSettingsDebounced: () => { settingsSaveCalls += 1; },
        saveMetadata: () => {},
        getRequestHeaders: () => ({}),
        get chatMetadata() { return _chatMetadata; },
    }),
    libs: { localforage: makeLocalforage() },
};
globalThis.toastr = undefined;

globalThis.FileReader ??= class FileReader {
    readAsDataURL(blob) {
        setTimeout(() => {
            this.result = 'data:image/png;base64,ZmFrZQ==';
            this.onloadend?.();
        }, 0);
    }
};

function withFetchBlob(fn) {
    return async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob(['fake'], { type: 'image/png' }) });
        try { await fn(); } finally { globalThis.fetch = originalFetch; }
    };
}

beforeEach(() => {
    memoryStore.clear();
    for (const key of Object.keys(extensionSettings)) delete extensionSettings[key];
    settingsSaveCalls = 0;
    _chatMetadata = {};
    setRefStoreForTests(makeRefStore());
});

afterEach(() => resetRefStoreForTests());

import {
    listRefs, getRef, createRef, updateRef, deleteRef, filterRefsByFolder,
    normalizePoolReference,
    setRefStoreForTests, resetRefStoreForTests,
} from '../src/refs-library.js';

test('listRefs uses canonical injected shared records instead of conflicting browser-local data', async () => {
    memoryStore.set(LF_REFS_POOL, [{ id: 'shared', name: 'Browser copy', imagePath: '/local.png' }]);
    const store = makeRefStore({ refs: [{ id: 'shared', name: 'Server copy', imagePath: '/server.png' }] });
    setRefStoreForTests(store);

    const [ref] = await listRefs();
    assert.equal(ref.id, 'shared');
    assert.equal(ref.name, 'Server copy');
    assert.equal(ref.imagePath, '/server.png');
    assert.deepEqual(store.calls, [['list', 'refs']]);
});

test('reference CRUD uses injected shared records and preserves imagePath across a patch', async () => {
    const store = makeRefStore();
    setRefStoreForTests(store);

    const created = await createRef({ id: 'aria', name: 'Aria', imagePath: 'user/images/URIS_Refs/aria.png', aliases: ['Aria'] });
    const updated = await updateRef(created.id, { name: 'Aria Rose', folders: ['cast'] });
    await deleteRef(created.id);

    assert.equal(updated.imagePath, 'user/images/URIS_Refs/aria.png');
    assert.deepEqual(store.calls.map(call => call.slice(0, 2)), [
        ['create', 'refs'], ['list', 'refs'], ['list', 'refs'], ['update', 'refs'], ['list', 'refs'], ['delete', 'refs'], ['list', 'refs'],
    ]);
    assert.deepEqual(store.value('refs'), []);
});

test('folder deletion patches only injected shared refs that contain the deleted folder', async () => {
    const store = makeRefStore({
        'ref-folders': [{ id: 'cast', name: 'Cast', color: '#4a90d9', order: 0 }],
        refs: [
            { id: 'aria', name: 'Aria', imagePath: '/aria.png', folders: ['cast', 'heroes'] },
            { id: 'bob', name: 'Bob', imagePath: '/bob.png', folders: ['heroes'] },
        ],
    });
    setRefStoreForTests(store);

    await deleteFolder('cast');

    assert.deepEqual(store.value('refs').map(ref => [ref.id, ref.folders]), [
        ['aria', ['heroes']], ['bob', ['heroes']],
    ]);
    assert.ok(store.calls.some(call => call[0] === 'delete' && call[1] === 'ref-folders'));
    assert.ok(store.calls.some(call => call[0] === 'update' && call[1] === 'refs' && call[2] === 'aria'));
    assert.ok(!store.calls.some(call => call[0] === 'update' && call[1] === 'refs' && call[2] === 'bob'));
});

test('test injection may model a shared backend without production fallback semantics', async () => {
    const store = makeRefStore();
    setRefStoreForTests(store);

    const ref = await createRef({ name: 'Aria', imagePath: '/aria.png' });

    assert.equal(ref.name, 'Aria');
    assert.deepEqual(store.value('refs').map(item => item.id), [ref.id]);
    assert.equal(extensionSettings.ur_image_studio, undefined);
});

test('reference mutations persist normalized metadata to shared settings', async () => {
    resetRefStoreForTests();
    const folder = await createFolder('Cast');
    const ref = await createRef({ name: 'Aria', imagePath: '/aria.png', folders: [folder.id], apiKey: 'not-metadata' });
    await updateRef(ref.id, { name: 'Aria Rose' });
    await deleteFolder(folder.id);

    const shared = extensionSettings.ur_image_studio.imageConnections;
    assert.deepEqual(shared.folders, []);
    assert.equal(shared.refs[0].name, 'Aria Rose');
    assert.deepEqual(shared.refs[0].folders, []);
    assert.equal(shared.refs[0].apiKey, undefined);
    assert.equal(settingsSaveCalls, 5);
});

test('creates a reference from a native gallery card without duplicating image bytes', async () => {
    const { createReferenceFromGalleryCard } = await import('../src/refs-library.js');
    const ref = await createReferenceFromGalleryCard({
        imagePath: 'user/images/UR%20Image%20Studio/generated.webp',
        prompt: 'cinematic portrait',
        modelId: 'image-model',
        referenceIds: ['source-ref'],
    }, { name: 'Gallery portrait', aliases: ['Portrait'] });

    assert.equal(ref.imagePath, 'user/images/UR%20Image%20Studio/generated.webp');
    assert.equal(ref.name, 'Gallery portrait');
    assert.equal(ref.description, 'cinematic portrait');
    assert.deepEqual(ref.aliases, ['Portrait']);
});

test('createReferenceFromGalleryCard canonicalizes only dedicated native gallery paths', async () => {
    const { createReferenceFromGalleryCard } = await import('../src/refs-library.js');
    const validCases = [
        ['user/images/UR Image Studio/literal name.png', 'user/images/UR%20Image%20Studio/literal%20name.png'],
        ['/user/images/UR Image Studio/leading slash.png', 'user/images/UR%20Image%20Studio/leading%20slash.png'],
        ['user/images/UR%20Image%20Studio/encoded%20name.png', 'user/images/UR%20Image%20Studio/encoded%20name.png'],
    ];
    for (const [imagePath, expected] of validCases) {
        const ref = await createReferenceFromGalleryCard({ imagePath }, { name: 'Gallery portrait' });
        assert.equal(ref.imagePath, expected);
    }

    for (const imagePath of [
        'user/images/UR%20Image%20Studio/../escape.png',
        'https://images.example/portrait.png',
        'data:image/png;base64,aGVsbG8=',
    ]) {
        await assert.rejects(
            createReferenceFromGalleryCard({ imagePath }, { name: 'Gallery portrait' }),
            /native image path/,
            imagePath,
        );
    }
});

test('createRef normalizes aliases and round-trips', async () => {
    const r = await createRef({ name: 'Aria Rose', imagePath: '/a.png', aliases: [' Aria ', 'Ария', 'Aria'] });
    assert.deepEqual(r.aliases, ['Aria', 'Ария']);
    const fetched = await getRef(r.id);
    assert.deepEqual(fetched.aliases, ['Aria', 'Ария']);
});

test('listRefs returns empty array by default', async () => {
    const arr = await listRefs();
    assert.deepEqual(arr, []);
});

test('listRefs returns created refs', async () => {
    await createRef({ name: 'A', imagePath: '/a.png' });
    await createRef({ name: 'B', imagePath: '/b.png' });
    const arr = await listRefs();
    assert.equal(arr.length, 2);
});

test('createRef default name when empty', async () => {
    const r = await createRef({ name: '', imagePath: '/x.png' });
    assert.equal(r.name, 'Без названия');
});

test('createRef stores description field', async () => {
    const { createRef, getRef } = await import('../src/refs-library.js');
    const ref = await createRef({ name: 'Aria', imagePath: '/p/aria.webp', description: 'blue hair, scar' });
    assert.equal(ref.description, 'blue hair, scar');
    const fetched = await getRef(ref.id);
    assert.equal(fetched.description, 'blue hair, scar');
});

test('createRef defaults description to empty string', async () => {
    const { createRef, getRef } = await import('../src/refs-library.js');
    const ref = await createRef({ name: 'NoDesc', imagePath: '/p/x.webp' });
    assert.equal(ref.description, '');
});

test('getRef returns ref by id or null', async () => {
    const r = await createRef({ name: 'Aria', imagePath: '/a.png' });
    const found = await getRef(r.id);
    assert.equal(found.name, 'Aria');
    assert.equal(await getRef('nonexistent'), null);
});

test('normalizePoolReference preserves folders array', async () => {
    const { createRef } = await import('../src/refs-library.js');
    const r = await createRef({ name: 'B', imagePath: '/b.png', folders: ['f1', 'f2'] });
    assert.deepEqual(r.folders, ['f1', 'f2']);
});

test('normalizePoolReference retains valid optional optimizer metadata', () => {
    const result = normalizePoolReference({
        id: 'aria', name: 'Aria', imagePath: '/aria.webp',
        mime: 'image/webp', width: 1024, height: 512,
        sourceBytes: 20000, optimizedBytes: 12000, optimizationVersion: 'ref-v2-1024',
    });
    assert.deepEqual(result, {
        id: 'aria', name: 'Aria', aliases: [], description: '', imagePath: '/aria.webp', folders: [],
        createdAt: result.createdAt, mime: 'image/webp', width: 1024, height: 512,
        sourceBytes: 20000, optimizedBytes: 12000, optimizationVersion: 'ref-v2-1024',
    });
    assert.deepEqual(Object.keys(normalizePoolReference({ name: 'Legacy' })).sort(),
        ['aliases', 'createdAt', 'description', 'folders', 'id', 'imagePath', 'name']);
});

test('updateRef sets folders via patch.folders array', async () => {
    const { createRef, updateRef } = await import('../src/refs-library.js');
    const r = await createRef({ name: 'C', imagePath: '/c.png', folders: ['f1'] });
    const updated = await updateRef(r.id, { folders: ['f1', 'f2'] });
    assert.deepEqual(updated.folders, ['f1', 'f2']);
});

test('updateRef retains optimizer metadata when patching unrelated fields', async () => {
    const { createRef, updateRef } = await import('../src/refs-library.js');
    const r = await createRef({
        name: 'Metadata', imagePath: '/metadata.webp',
        mime: 'image/webp', width: 1024, height: 768,
        sourceBytes: 24000, optimizedBytes: 12000, optimizationVersion: 'ref-v2-1024',
    });

    const updated = await updateRef(r.id, { description: 'updated description' });

    assert.deepEqual({
        mime: updated.mime,
        width: updated.width,
        height: updated.height,
        sourceBytes: updated.sourceBytes,
        optimizedBytes: updated.optimizedBytes,
        optimizationVersion: updated.optimizationVersion,
    }, {
        mime: 'image/webp', width: 1024, height: 768,
        sourceBytes: 24000, optimizedBytes: 12000, optimizationVersion: 'ref-v2-1024',
    });
});

test('updateRef propagates server failure without changing the existing record', async () => {
    const original = {
        id: 'stable', name: 'Stable', imagePath: '/stable.webp',
        mime: 'image/webp', width: 640, height: 480,
        sourceBytes: 10000, optimizedBytes: 5000, optimizationVersion: 'ref-v2-1024',
    };
    const store = makeRefStore({ refs: [original] });
    store.update = async () => { throw new Error('update unavailable'); };
    setRefStoreForTests(store);

    await assert.rejects(updateRef('stable', { name: 'Changed' }), /update unavailable/);
    assert.deepEqual(store.value('refs'), [original]);
});

test('createRef retains optimizer metadata when the server response omits it', async () => {
    const store = makeRefStore();
    const create = store.create;
    store.create = async (name, payload) => {
        const persisted = await create.call(store, name, payload);
        return { id: persisted.id, name: persisted.name, imagePath: persisted.imagePath };
    };
    setRefStoreForTests(store);

    const ref = await createRef({
        name: 'Created', imagePath: '/created.webp',
        mime: 'image/webp', width: 800, height: 600,
        sourceBytes: 18000, optimizedBytes: 9000, optimizationVersion: 'ref-v2-1024',
    });

    assert.equal(ref.mime, 'image/webp');
    assert.equal(ref.width, 800);
    assert.equal(ref.optimizedBytes, 9000);
    assert.equal(ref.optimizationVersion, 'ref-v2-1024');
});

test('updateRef retains optimizer metadata when the server response omits it', async () => {
    const original = {
        id: 'server-omits', name: 'Original', imagePath: '/original.webp',
        mime: 'image/webp', width: 640, height: 480,
        sourceBytes: 10000, optimizedBytes: 5000, optimizationVersion: 'ref-v2-1024',
    };
    const store = makeRefStore({ refs: [original] });
    const update = store.update;
    store.update = async (name, id, payload) => {
        const persisted = await update.call(store, name, id, payload);
        return { id: persisted.id, name: persisted.name, imagePath: persisted.imagePath };
    };
    setRefStoreForTests(store);

    const ref = await updateRef(original.id, { description: 'changed' });

    assert.equal(ref.description, 'changed');
    assert.equal(ref.mime, 'image/webp');
    assert.equal(ref.width, 640);
    assert.equal(ref.optimizedBytes, 5000);
    assert.equal(ref.optimizationVersion, 'ref-v2-1024');
});

test('deleteRef removes ref', async () => {
    const r = await createRef({ name: 'A', imagePath: '/a.png' });
    await deleteRef(r.id);
    assert.equal(await getRef(r.id), null);
    assert.equal((await listRefs()).length, 0);
});

import { listFolders, createFolder, updateFolder, renameFolder, deleteFolder, FOLDER_COLOR_PALETTE } from '../src/refs-library.js';

function makeRefStore(initial = {}) {
    const collections = new Map(Object.entries(initial).map(([name, records]) => [name, structuredClone(records)]));
    const calls = [];
    return {
        calls,
        async available() { return true; },
        async list(name) {
            calls.push(['list', name]);
            return structuredClone(collections.get(name) || []);
        },
        async create(name, payload) {
            calls.push(['create', name, structuredClone(payload)]);
            const records = collections.get(name) || [];
            const persisted = { ...structuredClone(payload), updatedAt: 'server-time' };
            collections.set(name, [...records, persisted]);
            return structuredClone(persisted);
        },
        async update(name, id, payload) {
            calls.push(['update', name, id, structuredClone(payload)]);
            const records = collections.get(name) || [];
            const persisted = { ...structuredClone(payload), updatedAt: 'server-time' };
            collections.set(name, records.map(record => record.id === id ? persisted : record));
            return structuredClone(persisted);
        },
        async delete(name, id) {
            calls.push(['delete', name, id]);
            const records = collections.get(name) || [];
            collections.set(name, records.filter(record => record.id !== id));
        },
        value(name) { return structuredClone(collections.get(name) || []); },
    };
}

test('createFolder creates folder with order', async () => {
    const f1 = await createFolder('NPC');
    assert.ok(f1.id);
    assert.equal(f1.name, 'NPC');
    assert.equal(f1.order, 0);
    const f2 = await createFolder('Locations');
    assert.equal(f2.order, 1);
});

test('createFolder default name when empty', async () => {
    const f = await createFolder('');
    assert.equal(f.name, 'Папка');
});

test('listFolders returns created folders', async () => {
    await createFolder('NPC');
    await createFolder('Locations');
    const arr = await listFolders();
    assert.equal(arr.length, 2);
});

test('renameFolder updates name', async () => {
    const f = await createFolder('Old');
    const renamed = await renameFolder(f.id, 'New');
    assert.equal(renamed.name, 'New');
});

test('updateFolder persists supplied name and color', async () => {
    const folder = await createFolder('Old');
    const updated = await updateFolder(folder.id, { name: '  New  ', color: '#abcdef' });

    assert.deepEqual(updated, { ...folder, name: 'New', color: '#abcdef' });
    assert.deepEqual((await listFolders()).find(item => item.id === folder.id), updated);
});

test('updateFolder preserves custom color when color is omitted', async () => {
    const folder = await createFolder('Old', { color: '#abcdef' });
    const updated = await updateFolder(folder.id, { name: 'New' });

    assert.equal(updated.color, '#abcdef');
    assert.equal((await listFolders()).find(item => item.id === folder.id).color, '#abcdef');
});

test('updateFolder uses indexed palette fallback for an explicit invalid color', async () => {
    await createFolder('First');
    const folder = await createFolder('Second', { color: '#abcdef' });
    const updated = await updateFolder(folder.id, { color: 'invalid' });

    assert.equal(updated.color, FOLDER_COLOR_PALETTE[1]);
});

test('updateFolder returns null without changing storage for an unknown id', async () => {
    await createFolder('First');
    const lf = globalThis.SillyTavern.libs.localforage;
    const before = structuredClone(await lf.getItem(LF_REFS_FOLDERS));

    assert.equal(await updateFolder('missing-folder', { name: 'Changed', color: '#abcdef' }), null);
    assert.deepEqual(await lf.getItem(LF_REFS_FOLDERS), before);
});

test('deleteFolder removes folder', async () => {
    const f = await createFolder('NPC');
    await deleteFolder(f.id);
    assert.equal((await listFolders()).length, 0);
});

test('deleteFolder clears folders for refs in it', async () => {
    const f = await createFolder('NPC');
    const r = await createRef({ name: 'Aria', imagePath: '/a.png', folders: [f.id] });
    await deleteFolder(f.id);
    const after = await getRef(r.id);
    assert.deepEqual(after.folders, []);
});

test('createFolder assigns color from palette by order', async () => {
    const { createFolder, listFolders } = await import('../src/refs-library.js');
    const f0 = await createFolder('Zero');
    const f1 = await createFolder('One');
    const f2 = await createFolder('Two');
    assert.ok(f0.color && /^#[0-9a-f]{6}$/i.test(f0.color), 'color hex');
    const colors = [f0.color, f1.color, f2.color];
    assert.equal(new Set(colors).size, 3, 'first 3 colors are unique');
    const folders = await listFolders();
    assert.ok(folders.every(f => typeof f.color === 'string' && f.color.startsWith('#')));
    // Boundary: 11th folder wraps to the first palette color.
    for (let i = 3; i < 10; i++) await createFolder(`F${i}`);
    const f10 = await createFolder('Ten');
    assert.equal(f10.color, f0.color, '11th folder wraps to palette start');
});

test('createFolder preserves custom color if provided', async () => {
    const { createFolder } = await import('../src/refs-library.js');
    const f = await createFolder('Custom', { color: '#abcdef' });
    assert.equal(f.color, '#abcdef');
});

test('createFolder falls back to palette for invalid custom color', async () => {
    const f = await createFolder('Bad', { color: '#gggggg' });
    assert.notEqual(f.color, '#gggggg');
    assert.ok(/^#[0-9a-f]{6}$/i.test(f.color));
});

test('renameFolder preserves custom color', async () => {
    const f = await createFolder('Old', { color: '#abcdef' });
    const renamed = await renameFolder(f.id, 'New');
    assert.equal(renamed.color, '#abcdef');
});

import { getChatRefs, saveChatRefs, defaultChatRefs, filterRefsByFolders } from '../src/refs-library.js';

test('defaultChatRefs contains unified pool whitelist', () => {
    assert.deepEqual(defaultChatRefs(), { referenceIds: [], folderIds: [] });
});

test('getChatRefs returns default for chat without binding', () => {
    assert.deepEqual(getChatRefs(), defaultChatRefs());
});

test('saveChatRefs persists normalized referenceIds and preserves schema-v4 config', async () => {
    SillyTavern.getContext().chatMetadata[META_KEY] = {
        schemaVersion: 4,
        config: { imageProfileId: 'x' },
        refs: { referenceIds: [] },
    };
    await saveChatRefs({ referenceIds: [123, 'abc', '123'] });
    const meta = SillyTavern.getContext().chatMetadata[META_KEY];
    assert.deepEqual(meta.refs, { referenceIds: ['123', 'abc'], folderIds: [] });
    assert.equal(meta.config.imageProfileId, 'x');
});

import { isNameInText, getRefSync, refreshPoolCache } from '../src/refs-library.js';

test('isNameInText matches one exact whole phrase', () => {
    assert.ok(isNameInText('Aria', 'Aria walked in'));
    assert.ok(!isNameInText('Aria', 'Arianna walked in'));
    assert.ok(isNameInText('Aria Rose', 'Aria   Rose was there'));
    assert.ok(!isNameInText('Aria Rose', 'Rose was there'));
    assert.ok(!isNameInText('Cat', 'category'));
});

test('isNameInText ignores single-character tokens', () => {
    assert.ok(!isNameInText('A', 'A walked in'));
    assert.ok(!isNameInText('A', 'Some A text'));
});

import { collectRefsForCurrentChat, previewRefsForCurrentChat } from '../src/refs-library.js';

test('collect uses only aliases from the unified whitelist', withFetchBlob(async () => {
    const ref = await createRef({ name: 'Display only', aliases: ['Aria'], imagePath: '/a.png' });
    await saveChatRefs({ referenceIds: [ref.id] });
    assert.equal((await collectRefsForCurrentChat({ chatText: 'Display only enters' })).length, 0);
    const refs = await collectRefsForCurrentChat({ chatText: 'Aria enters' });
    assert.deepEqual(refs.map(item => item.id), [ref.id]);
}));

test('preview returns pool descriptors with stable ids', async () => {
    const ref = await createRef({ name: 'Aria card', aliases: ['Aria'], imagePath: '/a.png' });
    await saveChatRefs({ referenceIds: [ref.id] });
    assert.deepEqual(previewRefsForCurrentChat({ chatText: 'Aria' }).map(item => item.id), [ref.id]);
});

test('legacy preview expands selected folder candidates when cache is ready', async () => {
    const folder = await createFolder('Locations');
    const ref = await createRef({ name: 'Forest', aliases: ['forest'], folders: [folder.id], imagePath: '/forest.png' });
    await refreshPoolCache();
    await saveChatRefs({ folderIds: [folder.id] });
    assert.deepEqual(previewRefsForCurrentChat({ chatText: 'A forest scene' }).map(item => item.id), [ref.id]);
});

// ── schema-v4 chat-scoped config integration (Task 1) ──

const DEFAULT_CONFIG = Object.freeze({
    imageProfileId: null,
    templateId: null,
    generationDefaults: { modelId: null, aspectRatio: null, imageSize: null, quality: null },
    automationMode: 'manual',
    generationFlow: 'ai-only',
});

test('saveChatRefs initializes schema-v5 binding with default config when absent', async () => {
    assert.equal(_chatMetadata[META_KEY], undefined);
    await saveChatRefs({ referenceIds: ['ref-1'] });
    const meta = _chatMetadata[META_KEY];
    assert.equal(meta.schemaVersion, 5);
    assert.deepEqual(meta.config, DEFAULT_CONFIG);
    assert.deepEqual(meta.refs, { referenceIds: ['ref-1'], folderIds: [] });
});

test('saveChatRefs preserves existing schema-v5 config and schemaVersion', async () => {
    _chatMetadata[META_KEY] = {
        schemaVersion: 5,
        config: {
            imageProfileId: 'img-1',
            templateId: 'tpl-1',
            automationMode: 'build-prompt',
            generationFlow: 'user-only',
        },
        refs: {},
    };
    await saveChatRefs({ referenceIds: ['ref-2'] });
    const meta = _chatMetadata[META_KEY];
    assert.equal(meta.schemaVersion, 5);
    assert.equal(meta.config.imageProfileId, 'img-1');
    assert.equal(meta.config.templateId, 'tpl-1');
    assert.equal(meta.config.automationMode, 'build-prompt');
    assert.equal(meta.config.generationFlow, 'user-only');
    assert.equal(Object.hasOwn(meta.config, 'characterIds'), false);
    assert.deepEqual(meta.refs, { referenceIds: ['ref-2'], folderIds: [] });
});

test('getChatRefs reads refs from a schema-v4 binding without config interference', () => {
    _chatMetadata[META_KEY] = {
        schemaVersion: 4,
        config: DEFAULT_CONFIG,
        refs: {
            referenceIds: ['ref-1'],
        },
    };
    assert.deepEqual(getChatRefs(), {
        referenceIds: ['ref-1'],
        folderIds: [],
    });
});

test('getChatRefs ignores a non-schema-v4 binding without writing metadata', () => {
    const legacyBinding = { schemaVersion: 3, refs: { referenceIds: ['legacy-ref'] } };
    _chatMetadata[META_KEY] = legacyBinding;

    assert.deepEqual(getChatRefs(), defaultChatRefs());
    assert.strictEqual(_chatMetadata[META_KEY], legacyBinding);
});

test('saveChatRefs ignores a non-schema-v4 binding without writing metadata', () => {
    const legacyBinding = { schemaVersion: 3, refs: { referenceIds: ['legacy-ref'] } };
    _chatMetadata[META_KEY] = legacyBinding;

    assert.deepEqual(saveChatRefs({ referenceIds: ['current-ref'] }), defaultChatRefs());
    assert.strictEqual(_chatMetadata[META_KEY], legacyBinding);
});

test('filterRefsByFolders returns the union of selected folders', () => {
    const refs = [
        { id: 'a', folders: ['one'] },
        { id: 'b', folders: ['two'] },
        { id: 'c', folders: ['one', 'two'] },
        { id: 'd', folders: [] },
    ];
    assert.deepEqual(filterRefsByFolders(refs, ['two', 'missing']).map(ref => ref.id), ['b', 'c']);
});

test('filterRefsByFolder: all returns everything', () => {
    const refs = [{ folders: ['a'] }, { folders: [] }, { folders: ['a', 'b'] }];
    assert.equal(filterRefsByFolder(refs, 'all').length, 3);
});

test('filterRefsByFolder: none returns only unfiled refs', () => {
    const refs = [{ folders: ['a'] }, { folders: [] }, { folders: ['a', 'b'] }];
    const out = filterRefsByFolder(refs, 'none');
    assert.deepEqual(out, [{ folders: [] }]);
});

test('filterRefsByFolder: folderId returns refs in multi-folder', () => {
    const refs = [
        { id: '1', folders: ['a'] },
        { id: '2', folders: [] },
        { id: '3', folders: ['a', 'b'] },
        { id: '4', folders: ['b'] },
    ];
    const out = filterRefsByFolder(refs, 'b');
    assert.deepEqual(out.map(r => r.id), ['3', '4']);
});

test('filterRefsByFolder: defensive against missing folders', () => {
    const refs = [{ id: '1' }, { id: '2', folders: ['x'] }];
    assert.equal(filterRefsByFolder(refs, 'all').length, 2);
    assert.deepEqual(filterRefsByFolder(refs, 'none').map(r => r.id), ['1']);
    assert.deepEqual(filterRefsByFolder(refs, 'x').map(r => r.id), ['2']);
});

test('getRefSync returns null and warns when the pool cache is not initialized', () => {
    // beforeEach reset _poolCache to null via setRefStoreForTests.
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    try {
        const result = getRefSync('anything');
        assert.equal(result, null);
        assert.ok(warnings.some(w => /pool cache is not initialized/.test(w)), 'warns about uninitialized cache');
    } finally {
        console.warn = originalWarn;
    }
});

test('getRefSync resolves from cache after refreshPoolCache', async () => {
    setRefStoreForTests(makeRefStore({ refs: [{ id: 'r1', name: 'One', imagePath: '/x.png' }] }));
    await refreshPoolCache();
    assert.equal(getRefSync('r1')?.name, 'One');
    assert.equal(getRefSync('missing'), null);
});

test('refs CRUD пишет события в журнал диагностики', async () => {
    const journal = await import('../src/diagnostic-events.js');
    journal.resetDiagnosticEventsForTests();
    const created = await createRef({ name: 'Журнальная' });
    await deleteRef(created.id);
    const crud = journal.listDiagnosticEvents().filter(e => e.event === 'refs-crud');
    assert.deepEqual(crud.map(e => e.operation), ['create', 'delete']);
    assert.equal(crud[0].details.id, created.id);
});
