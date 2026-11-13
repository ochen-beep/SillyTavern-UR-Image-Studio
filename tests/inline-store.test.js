import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Мок SillyTavern для модели extra.uris (2026-11-13): состояние item'ов живёт
// на объекте сообщения (msg.extra.uris), per-свайпные снапшоты ST 1.19 чекаутят
// extra сами. saveChat — шпион: записи в extra сохраняются чатом, не metadata.
let chatArr = [];
let metadata = {};
let metaSaved = 0;
let chatSaved = 0;
globalThis.SillyTavern = {
    getContext: () => ({
        chat: chatArr,
        chatMetadata: metadata,
        saveMetadataDebounced: () => { metaSaved++; },
        saveChat: () => { chatSaved++; },
    }),
};

const { getSlot, upsertItem, deleteItem, itemKey, attachCard, removeCardFromItems,
    migrateLegacySlots, flushChatSave, getConfig, setConfig } =
    await import('../src/inline/store.js');
const { hashMessage } = await import('../src/generation-drafts.js');

/** Пост с N свайпами; вариант i — текст `вариант i`. */
function post(extraProps = {}) {
    const swipes = ['вариант 0', 'вариант 1'];
    return {
        mes: swipes[1], swipe_id: 1, swipes,
        swipe_info: swipes.map(t => ({ send_date: null, extra: {} })),
        extra: {}, ...extraProps,
    };
}

beforeEach(() => {
    chatArr = [post()];
    metadata = {};
    metaSaved = 0;
    chatSaved = 0;
});

const digest0 = hashMessage('вариант 0');
const digest1 = hashMessage('вариант 1');

test('store: нет extra.uris → пустой слот', () => {
    assert.deepEqual(getSlot(0), { messageHash: null, items: [] });
});

test('store: upsertItem пишет в msg.extra.uris и сохраняет чатом', () => {
    const it = upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'pending',
        descHash: 'aa', digest: digest1, createdAt: 1 });
    assert.ok(it);
    const cont = chatArr[0].extra.uris;
    assert.equal(cont.v, 1);
    assert.equal(cont.items.length, 1);
    flushChatSave();
    assert.ok(chatSaved > 0, 'saveChat вызван');
    assert.equal(metaSaved, 0, 'metadata не трогается item-записью');
});

test('store: pending → ready апгрейд по ключу (idx,type,descHash)', () => {
    upsertItem(0, { idx: 0, type: 'img', origin: 'marker', status: 'pending', descHash: 'aa', digest: digest1 });
    upsertItem(0, { idx: 0, type: 'img', origin: 'marker', status: 'ready', descHash: 'aa', digest: digest1, imagePath: 'p.png' });
    assert.equal(getSlot(0).items.length, 1);
    assert.equal(getSlot(0).items[0].status, 'ready');
});

test('store: origin/digest/cardIds проходят whitelist, мусор нет', () => {
    upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'ready', descHash: 'aa',
        digest: digest1, cardIds: ['c1'], junk: { fn: () => {} } });
    const item = getSlot(0).items[0];
    assert.equal(item.origin, 'story');
    assert.deepEqual(item.cardIds, ['c1']);
    assert.equal(item.junk, undefined);
});

test('store: готовый ready не откатывается в error/pending', () => {
    upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'ready', descHash: 'aa',
        digest: digest1, imagePath: 'p.png', cardId: 'c1', cardIds: ['c1'] });
    upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'error', descHash: 'aa', digest: digest1 });
    upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'pending', descHash: 'aa', digest: digest1 });
    const item = getSlot(0).items[0];
    assert.equal(item.status, 'ready');
    assert.equal(item.imagePath, 'p.png');
});

test('store: requestId стирается при выходе из pending', () => {
    upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'pending', descHash: 'aa',
        digest: digest1, requestId: 'inl_1', createdAt: 1 });
    upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'error', descHash: 'aa',
        digest: digest1, error: 'boom' });
    const item = getSlot(0).items[0];
    assert.equal(item.status, 'error');
    assert.equal(item.requestId, undefined);
});

test('store: cardId без cardIds синхронизируется (инлайн-путь)', () => {
    upsertItem(0, { idx: 0, type: 'img', origin: 'marker', status: 'ready', descHash: 'mk',
        digest: digest1, imagePath: 'm.png', cardId: 'mc1' });
    const item = getSlot(0).items[0];
    assert.deepEqual(item.cardIds, ['mc1'], 'cardIds выведен из cardId');
    upsertItem(0, { idx: 0, type: 'img', origin: 'marker', status: 'ready', descHash: 'mk',
        digest: digest1, cardId: 'mc2' });
    assert.deepEqual(getSlot(0).items[0].cardIds, ['mc1', 'mc2'], 'новая карточка дописана');
});

test('store: undefined не затирает сохранённое', () => {
    upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'ready', descHash: 'aa',
        digest: digest1, imagePath: 'keep.png' });
    upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'ready', descHash: 'aa',
        digest: digest1, imagePath: undefined });
    assert.equal(getSlot(0).items[0].imagePath, 'keep.png');
});

test('store: writeItemForVariant — вариант по умолчанию live, чужой → снапшот', () => {
    // live: пост на варианте 1
    upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'ready', descHash: 'l1',
        digest: digest1, imagePath: 'live.png' });
    // чужой вариант 0 → снапшот
    upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'ready', descHash: 's0',
        digest: digest0, imagePath: 'snap.png' }, { variantIdx: 0 });
    assert.equal(chatArr[0].extra.uris.items.length, 1);
    assert.equal(chatArr[0].extra.uris.items[0].imagePath, 'live.png');
    assert.equal(chatArr[0].swipe_info[0].extra.uris.items[0].imagePath, 'snap.png');
});

test('store: несуществующий вариант → запись отклонена (null)', () => {
    const it = upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'ready',
        descHash: 'aa', digest: digest1 }, { variantIdx: 5 });
    assert.equal(it, null);
    assert.equal(chatArr[0].extra.uris, undefined);
});

test('store: attachCard добавляет в cardIds и ставит обложку, повтор — без дубля', () => {
    upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'ready', descHash: 'aa',
        digest: digest1, imagePath: 'first.png', cardId: 'c1', cardIds: ['c1'] });
    attachCard(0, digest1, 'c2', 'second.png');
    const item = getSlot(0).items[0];
    assert.deepEqual(item.cardIds, ['c1', 'c2']);
    assert.equal(item.cardId, 'c2');
    assert.equal(item.imagePath, 'second.png');
    attachCard(0, digest1, 'c2', 'second.png');
    assert.deepEqual(getSlot(0).items[0].cardIds, ['c1', 'c2']);
});

test('store: attachCard без item с таким digest → создаёт story-item (live-вариант)', () => {
    attachCard(0, digest1, 'c9', 'p9.png');
    const items = getSlot(0).items;
    assert.equal(items.length, 1);
    assert.equal(items[0].origin, 'story');
    assert.equal(items[0].digest, digest1);
    assert.deepEqual(items[0].cardIds, ['c9']);
});

test('store: attachCard с digest чужого варианта → item в снапшоте, не в live', () => {
    attachCard(0, digest0, 'c8', 'p8.png');
    assert.deepEqual(getSlot(0).items, [], 'пост сейчас на варианте 1 — live пуст');
    assert.equal(chatArr[0].swipe_info[0].extra.uris.items[0].cardId, 'c8');
});

test('store: attachCard стирает error при позднем завершении', () => {
    upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'error', descHash: 'aa',
        digest: digest1, error: 'Отменено' });
    attachCard(0, digest1, 'cL', 'late.png');
    const item = getSlot(0).items[0];
    assert.equal(item.status, 'ready');
    assert.equal(item.error, undefined, 'устаревшая ошибка стёрта');
    assert.equal(item.imagePath, 'late.png');
});

test('store: deleteItem убирает item по ключу', () => {
    upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'error', descHash: 'aa', digest: digest1 });
    deleteItem(0, itemKey({ idx: -1, type: 'img', descHash: 'aa' }));
    assert.deepEqual(getSlot(0).items, []);
});

test('store: removeCardFromItems вычёркивает, пусто → item исчезает', () => {
    upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'ready', descHash: 'aa',
        digest: digest1, imagePath: 'a.png', cardId: 'c1', cardIds: ['c1', 'c2'] });
    const touched = removeCardFromItems('c1');
    assert.equal(touched.length, 1);
    assert.equal(touched[0].needsCover, true);
    assert.equal(getSlot(0).items[0].cardId, 'c2');
    removeCardFromItems('c2');
    assert.deepEqual(getSlot(0).items, [], 'последняя карточка → item удалён');
});

// — Миграция legacy-слотов uris_inline → extra.uris (один раз, идемпотентно).

function seedLegacy(msgId, items, sourceText) {
    globalThis.SillyTavern.getContext().chatMetadata.uris_inline = {
        v: 1, cfg: { enabled: false, listenUser: false },
        msgs: { [String(msgId)]: { messageHash: null, sourceText, items } },
    };
}

test('store: legacy-слот читается до миграции (откат не прячет картинки)', () => {
    seedLegacy(0, [{ idx: -1, type: 'img', descHash: 'old', status: 'ready', imagePath: 'p.png' }], 'вариант 1');
    assert.equal(getSlot(0).items.length, 1);
});

test('store: migrateLegacySlots переносит items на объект сообщения', () => {
    seedLegacy(0, [{ idx: -1, type: 'img', descHash: 'old', status: 'ready', imagePath: 'p.png', cardId: 'c1' }], 'вариант 1');
    migrateLegacySlots();
    const items = getSlot(0).items;
    assert.equal(items.length, 1);
    assert.equal(items[0].origin, 'inline');
    assert.equal(items[0].digest, digest1);
    // идемпотентность
    migrateLegacySlots();
    assert.equal(getSlot(0).items.length, 1);
});

test('store: migrateLegacySlots переносит слот за индексом по sourceText', () => {
    chatArr = [post(), { mes: 'другой пост', extra: {} }];
    seedLegacy(0, [{ idx: 0, type: 'img', descHash: 'k', status: 'ready', imagePath: 'p.png' }], 'другой пост');
    migrateLegacySlots();
    assert.equal(getSlot(0).items.length, 0, 'индекс 0 теперь другой пост — ему чужой слот не положен');
    assert.equal(getSlot(1).items.length, 1);
    assert.equal(getSlot(1).items[0].origin, 'marker');
});

test('store: cfg живёт в uris_inline, как раньше', () => {
    assert.deepEqual(getConfig(), { enabled: false, listenUser: false });
    setConfig({ enabled: true });
    assert.deepEqual(getConfig(), { enabled: true, listenUser: false });
    flushChatSave();
});
