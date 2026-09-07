// @ts-check
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeReferenceStore } from './_helpers.js';
import { LF_REFS_POOL, META_KEY } from '../src/core.js';
import { resetRefStoreForTests, setRefStoreForTests } from '../src/refs-library.js';

const memoryStore = new Map();
let chatMetadata = {};

beforeEach(() => {
    memoryStore.clear();
    chatMetadata = {};
    resetRefStoreForTests();
    setRefStoreForTests(makeReferenceStore());
    globalThis.SillyTavern = {
        getContext: () => ({
            chatId: 'chat-1',
            get chatMetadata() { return chatMetadata; },
            saveMetadata: () => {},
        }),
        libs: {
            localforage: {
                getItem: async key => memoryStore.has(key) ? memoryStore.get(key) : null,
                setItem: async (key, value) => { memoryStore.set(key, value); },
                removeItem: async key => { memoryStore.delete(key); },
                keys: async () => Array.from(memoryStore.keys()),
            },
        },
    };
});

test('normalizePoolReference keeps only current aliases', async () => {
    const { normalizePoolReference } = await import('../src/refs-library.js');
    const ref = normalizePoolReference({
        id: 'rada',
        name: 'Серая мышь',
        aliases: ['Рада', 'rada'],
        keywords: ['RADA', 'Мышка'],
        imagePath: '/rada.png',
    });

    assert.deepEqual(ref.aliases, ['Рада', 'rada']);
    assert.equal(ref.name, 'Серая мышь');
});

test('createRef keeps name display-only and drops retired fields', async () => {
    const { createRef } = await import('../src/refs-library.js');
    const ref = await createRef({
        name: 'Пипа',
        aliases: 'Рада, Rada',
        imagePath: '/rada.png',
    });

    assert.deepEqual(ref.aliases, ['Рада', 'Rada']);
    assert.equal(ref.aliases.includes('Пипа'), false);
});

