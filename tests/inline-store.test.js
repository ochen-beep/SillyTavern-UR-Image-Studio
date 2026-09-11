import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Мок SillyTavern/chatMetadata до импорта модуля (паттерн settings-tab.test.js)
let metadata = {};
let saved = 0;
globalThis.SillyTavern = {
    getContext: () => ({
        chatMetadata: metadata,
        saveMetadataDebounced: () => { saved++; },
    }),
};

const { getSlot, upsertItem, getConfig, setConfig, dropMessage } = await import('../src/inline/store.js');

beforeEach(() => { metadata = {}; saved = 0; });

test('store: empty metadata → empty slot', () => {
    assert.deepEqual(getSlot(5), { messageHash: null, items: [] });
});

test('store: upsertItem creates slot and updates item by (idx,type,descHash)', () => {
    upsertItem(5, { idx: 0, type: 'selfie', descHash: 'aa', status: 'pending' });
    upsertItem(5, { idx: 0, type: 'selfie', descHash: 'aa', status: 'ready', imagePath: 'p.png' });
    const slot = getSlot(5);
    assert.equal(slot.items.length, 1);
    assert.equal(slot.items[0].status, 'ready');
    assert.ok(saved > 0, 'saveMetadataDebounced вызван');
});

test('store: messageHash stored alongside items', () => {
    upsertItem(7, { idx: 0, type: 'img', descHash: 'bb', status: 'pending' }, { messageHash: 'h1' });
    assert.equal(getSlot(7).messageHash, 'h1');
});

test('store: config per chat', () => {
    assert.deepEqual(getConfig(), { enabled: false, listenUser: false });
    setConfig({ enabled: true, listenUser: true });
    assert.deepEqual(getConfig(), { enabled: true, listenUser: true });
});

test('store: dropMessage removes slot', () => {
    upsertItem(9, { idx: 0, type: 'img', descHash: 'cc', status: 'ready' });
    dropMessage(9);
    assert.deepEqual(getSlot(9).items, []);
});
