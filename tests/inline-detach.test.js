// @ts-check
// Отклейка карточки от каруселей постов (2026-11-13): deleteImage и
// «Убрать из поста» сходятся в detachCardFromPosts (gallery-actions).
// Обложка ← предыдущая cardIds с резолвом пути по карточке галереи;
// пустой список → item исчезает. Прямой узкий мок: listCards подменяется
// через динамический import — module mock недоступен, поэтому резолв
// обложки проверяется через REAL gallery-index поверх in-memory file-store
// проще: здесь проверяем store-примитивы, резолв обложки — smoke без галереи.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals } from './_helpers.js';

installStGlobals();

let chatArr = [];
let chatSaved = 0;
globalThis.SillyTavern.getContext = () => ({
    chatId: 'chat-1',
    chat: chatArr,
    chatMetadata: {},
    saveChat: () => { chatSaved++; },
    saveMetadataDebounced: () => {},
});

const { removeCardFromItems, upsertItem, getSlot } = await import('../src/inline/store.js');
const { detachCardFromPosts } = await import('../src/ui/gallery-actions.js');

function post(text) {
    return { mes: text, swipe_id: 0, swipes: [text],
        swipe_info: [{ send_date: null, extra: {} }], extra: {} };
}

beforeEach(() => {
    chatArr = [post('пост с картинкой')];
    chatSaved = 0;
});

test('detach: карточка-обложка вычеркнута, item исчез без галереи (деградация)', async () => {
    upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'ready', descHash: 'aa',
        digest: 'd', imagePath: 'a.png', cardId: 'c1', cardIds: ['c1'] });
    const ok = await detachCardFromPosts({ id: 'c1' });
    assert.equal(ok, true);
    assert.deepEqual(getSlot(0).items, [], 'последняя карточка → item удалён');
});

test('detach: вторая карточка становится обложкой (путь резолвится по карточке)', async () => {
    upsertItem(0, { idx: -1, type: 'img', origin: 'story', status: 'ready', descHash: 'aa',
        digest: 'd', imagePath: 'a.png', cardId: 'c1', cardIds: ['c1', 'c2'] });
    const ok = await detachCardFromPosts({ id: 'c1' }, {
        listCards: async () => [{ id: 'c2', imagePath: 'b.png' }],
    });
    assert.equal(ok, true);
    const items = getSlot(0).items;
    assert.equal(items.length, 1);
    assert.equal(items[0].cardId, 'c2');
    assert.equal(items[0].imagePath, 'b.png', 'обложка ← карточка из cardIds');
    assert.equal(items[0].status, 'ready');
});

test('detach: карточка не в каруселях → false, чат не тронут', async () => {
    const ok = await detachCardFromPosts({ id: 'unknown' });
    assert.equal(ok, false);
    assert.equal(chatSaved, 0);
});
