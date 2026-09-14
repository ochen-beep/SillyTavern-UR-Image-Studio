import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Мок SillyTavern/chatMetadata до импорта модуля (паттерн settings-tab.test.js).
// chat[].mes обязателен: store читает его для sourceText, а главный регресс,
// который здесь ловится (стирание оплаченных item'ов при правке текста),
// виден только когда mock отдаёт живой чат.
let metadata = {};
let chatArr = [{ mes: 'первый текст' }];
let saved = 0;
globalThis.SillyTavern = {
    getContext: () => ({
        chatMetadata: metadata,
        chat: chatArr,
        saveMetadataDebounced: () => { saved++; },
    }),
};

const { getSlot, upsertItem, getConfig, setConfig, dropMessage } = await import('../src/inline/store.js');

beforeEach(() => { metadata = {}; chatArr = [{ mes: 'первый текст' }]; saved = 0; });

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

test('store: stale pending does not downgrade ready item', () => {
    upsertItem(5, { idx: 0, type: 'img', descHash: 'ee', status: 'ready', imagePath: 'p.png' });
    upsertItem(5, { idx: 0, type: 'img', descHash: 'ee', status: 'pending' });
    const slot = getSlot(5);
    assert.equal(slot.items[0].status, 'ready');
    assert.equal(slot.items[0].imagePath, 'p.png');
});

test('store: undefined fields do not clobber stored values', () => {
    upsertItem(6, { idx: 0, type: 'img', descHash: 'ff', status: 'ready', imagePath: 'keep.png' });
    upsertItem(6, { idx: 0, type: 'img', descHash: 'ff', status: 'pending', imagePath: undefined });
    const slot = getSlot(6);
    assert.equal(slot.items[0].status, 'ready');
    assert.equal(slot.items[0].imagePath, 'keep.png');
});

test('store: junk fields are not persisted', () => {
    upsertItem(8, { idx: 0, type: 'img', descHash: 'gg', status: 'pending', junk: { fn: () => {} }, extra: 'x' });
    const slot = getSlot(8);
    assert.deepEqual(Object.keys(slot.items[0]).sort(), ['descHash', 'idx', 'status', 'type']);
});

test('store: string and numeric msgId hit the same slot', () => {
    upsertItem('5', { idx: 0, type: 'img', descHash: 'dd', status: 'ready', imagePath: 'x.png' });
    assert.equal(getSlot(5).items.length, 1);
});

// — Регрессия «store-гейта по sourceText»: правка сообщения не должна ни
// прятать готовые item'ы (getSlot), ни стирать их при следующем upsert
// (сброс слота). Платный результат дороже устаревшего текста.

test('store: правка текста сообщения НЕ прячет готовые item\'ы', () => {
    upsertItem(0, { idx: 0, type: 'img', descHash: 'aa', status: 'ready', imagePath: 'p.png' });
    chatArr[0].mes = 'текст после правки';
    const slot = getSlot(0);
    assert.equal(slot.items.length, 1, 'готовый item остался в слоте');
    assert.equal(slot.items[0].status, 'ready');
    assert.equal(slot.items[0].imagePath, 'p.png');
});

test('store: upsert после правки не стирает слот — мерж по ключу, готовый + новый pending', () => {
    upsertItem(0, { idx: 0, type: 'img', descHash: 'aa', status: 'ready', imagePath: 'p.png', requestId: 'r1', createdAt: 1 });
    chatArr[0].mes = 'текст после правки';
    upsertItem(0, { idx: 0, type: 'img', descHash: 'bb', status: 'pending', requestId: 'r2', createdAt: 2 });
    const slot = getSlot(0);
    assert.equal(slot.items.length, 2, 'готовый остался + новый pending добавлен');
    assert.equal(slot.items.find(i => i.descHash === 'aa')?.status, 'ready');
    assert.equal(slot.items.find(i => i.descHash === 'bb')?.status, 'pending');
});

// — Гонка «клик ✕ в тик после готовности»: error-патч не должен гасить ready.

test('store: готовый ready не откатывается в error (картинка не теряется)', () => {
    upsertItem(0, { idx: 0, type: 'img', descHash: 'aa', status: 'ready', imagePath: 'p.png', requestId: 'r1', createdAt: 1 });
    upsertItem(0, { idx: 0, type: 'img', descHash: 'aa', status: 'error', requestId: null, error: 'cancelled' });
    const slot = getSlot(0);
    assert.equal(slot.items.length, 1);
    assert.equal(slot.items[0].status, 'ready');
    assert.equal(slot.items[0].imagePath, 'p.png', 'imagePath не обнулён');
});
