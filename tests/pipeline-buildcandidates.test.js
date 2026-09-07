// @ts-check
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const memoryStore = new Map();
const serverCollections = new Map();
let _chatMetadata = {};

const refStore = {
    async available() { return true; },
    async list(name) { return structuredClone(serverCollections.get(name) || []); },
    async create(name, payload) {
        const records = serverCollections.get(name) || [];
        const persisted = { ...structuredClone(payload), updatedAt: 'server-time' };
        serverCollections.set(name, [...records, persisted]);
        return structuredClone(persisted);
    },
    async update(name, id, payload) {
        const persisted = { ...structuredClone(payload), updatedAt: 'server-time' };
        const records = serverCollections.get(name) || [];
        serverCollections.set(name, records.map(record => record.id === id ? persisted : record));
        return structuredClone(persisted);
    },
    async delete(name, id) {
        serverCollections.set(name, (serverCollections.get(name) || []).filter(record => record.id !== id));
    },
};

beforeEach(async () => {
    memoryStore.clear();
    serverCollections.clear();
    _chatMetadata = {};
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            saveMetadata: () => {},
            getRequestHeaders: () => ({}),
            chat: {},
            chatId: 'test-chat',
            name1: 'Alex',
            name2: 'Aria Brightblade',
            characters: [{ name: 'Aria Brightblade', description: 'elf', avatar: 'aria.png' }],
            characterId: 0,
            get chatMetadata() { return _chatMetadata; },
            powerUserSettings: { personas: { 'persona-7': 'Alex' }, default_persona: 'persona-7' },
        }),
        libs: {
            localforage: {
                getItem: (k) => memoryStore.has(k) ? memoryStore.get(k) : null,
                setItem: (k, v) => { memoryStore.set(k, v); },
                removeItem: (k) => { memoryStore.delete(k); },
            },
        },
    };
    const { setRefStoreForTests } = await import('../src/refs-library.js');
    setRefStoreForTests(refStore);
});

afterEach(async () => {
    const { resetRefStoreForTests } = await import('../src/refs-library.js');
    resetRefStoreForTests();
});

test('buildCandidates: returns only pool records from referenceIds with stable ids', async () => {
    const { createRef, saveChatRefs } = await import('../src/refs-library.js');
    const { buildCandidates } = await import('../src/pipeline.js');
    const rada = await createRef({ name: 'Пипа', aliases: ['Rada', 'Рада'], imagePath: '/x/rada.png' });
    await createRef({ name: 'Unlisted', aliases: ['Ashton'], imagePath: '/x/unlisted.png' });
    await saveChatRefs({ referenceIds: [rada.id] });

    const candidates = await buildCandidates('test-chat');

    assert.deepEqual(candidates, [{
        id: rada.id,
        name: 'Пипа',
        aliases: ['Rada', 'Рада'],
        description: '',
        imagePath: '/x/rada.png',
    }]);
});

test('buildCandidates expands selected folders, preserves direct order, and deduplicates records', async () => {
    const { createRef, createFolder, saveChatRefs } = await import('../src/refs-library.js');
    const { buildCandidates } = await import('../src/pipeline.js');
    const direct = await createRef({ id: 'direct', name: 'Direct', aliases: ['Direct'], folders: ['folder-a'], imagePath: '/direct.png' });
    await createRef({ id: 'folder-a-ref', name: 'Folder A', aliases: ['A'], folders: ['folder-a'], imagePath: '/a.png' });
    await createRef({ id: 'folder-b-ref', name: 'Folder B', aliases: ['B'], folders: ['folder-b'], imagePath: '/b.png' });
    const folderA = await createFolder('A');
    const folderB = await createFolder('B');
    // Use actual generated folder IDs in the records so this also exercises the
    // storage shape rather than relying on display names.
    const { updateRef } = await import('../src/refs-library.js');
    await updateRef(direct.id, { folders: [folderA.id] });
    await updateRef('folder-a-ref', { folders: [folderA.id] });
    await updateRef('folder-b-ref', { folders: [folderB.id] });
    await saveChatRefs({ referenceIds: [direct.id], folderIds: [folderA.id, folderB.id] });
    assert.deepEqual((await buildCandidates('test-chat')).map(ref => ref.id), ['direct', 'folder-a-ref', 'folder-b-ref']);
});

test('buildCandidates: does not synthesize char or user from SillyTavern context', async () => {
    const { buildCandidates } = await import('../src/pipeline.js');
    assert.deepEqual(await buildCandidates('test-chat'), []);
});

test('buildCandidates: missing referenceIds are ignored', async () => {
    const { saveChatRefs } = await import('../src/refs-library.js');
    const { buildCandidates } = await import('../src/pipeline.js');
    await saveChatRefs({ referenceIds: ['missing'] });
    assert.deepEqual(await buildCandidates('test-chat'), []);
});

test('buildCandidates expands {{char}}/{{user}} macros in name and aliases', async () => {
    const { createRef, saveChatRefs } = await import('../src/refs-library.js');
    const { buildCandidates } = await import('../src/pipeline.js');
    // ctx (beforeEach): name2/characters[0] = 'Aria Brightblade', name1 = 'Alex'
    const ref = await createRef({ name: '{{char}}', aliases: ['{{char}}', '{{user}}', 'Aria'], imagePath: '/x.png' });
    await saveChatRefs({ referenceIds: [ref.id] });

    const [candidate] = await buildCandidates('test-chat');
    assert.equal(candidate.name, 'Aria Brightblade');
    // {{char}} -> 'Aria Brightblade', {{user}} -> 'Alex', 'Aria' stays; the
    // collapsed {{char}} duplicate of name is dropped from aliases.
    assert.deepEqual(candidate.aliases, ['Aria Brightblade', 'Alex', 'Aria']);
});

test('expanded aliases actually match the scene text', async () => {
    const { createRef, saveChatRefs } = await import('../src/refs-library.js');
    const { buildCandidates } = await import('../src/pipeline.js');
    const { matchesScenePhrase } = await import('../src/scene-context.js');
    const ref = await createRef({ name: 'Hero', aliases: ['{{char}}'], imagePath: '/x.png' });
    await saveChatRefs({ referenceIds: [ref.id] });

    const [candidate] = await buildCandidates('test-chat');
    // The alias was resolved to the character name, so it now matches the text.
    assert.ok(candidate.aliases.includes('Aria Brightblade'));
    assert.ok(matchesScenePhrase('Aria Brightblade', 'Aria Brightblade walks in'));
    assert.ok(!matchesScenePhrase('{{char}}', 'Aria Brightblade walks in'),
        'the raw macro token does not match (it was expanded)');
});
