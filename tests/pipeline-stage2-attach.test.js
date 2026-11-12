// @ts-check
// Attach-хук Stage 2 (2026-11-13): платная карточка с provenance текущего чата
// встаёт в карусель поста (cardIds), если у поста уже есть uris-состояние.
// Посты без оболочек остаются чистыми (автоматика не создаёт оболочек).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals } from './_helpers.js';
import { hashMessage } from '../src/generation-drafts.js';

installStGlobals();

let chatArr = [];
let chatSaved = 0;
globalThis.SillyTavern.getContext = () => ({
    chatId: 'chat-1',
    chat: chatArr,
    saveChat: () => { chatSaved++; },
    chatMetadata: {},
});

const { attachEntryToCarousel } = await import('../src/pipeline-stage2.js');

function post(text) {
    return { mes: text, swipe_id: 0, swipes: [text],
        swipe_info: [{ send_date: null, extra: {} }], extra: {} };
}

beforeEach(() => {
    chatArr = [post('a'), post('b'), post('target post')];
    chatSaved = 0;
});

const entry = (id, imagePath, msgId, chatId = 'chat-1') => ({
    id,
    imagePath,
    provenance: { chatId, sourceMsgId: msgId },
});

test('attach: карточка встаёт в cardIds item\'а с совпавшим digest', () => {
    const digest = hashMessage('target post');
    chatArr[2].extra.uris = { v: 1, items: [
        { idx: -1, type: 'img', origin: 'story', status: 'pending', descHash: 'aa',
            digest, requestId: 'uris_1', createdAt: 1 },
    ] };
    attachEntryToCarousel(entry('card-9', 'p9.png', 2), { messageText: 'target post' });
    const item = chatArr[2].extra.uris.items[0];
    assert.deepEqual(item.cardIds, ['card-9']);
    assert.equal(item.cardId, 'card-9');
    assert.equal(item.imagePath, 'p9.png');
    assert.equal(item.status, 'ready', 'pending upgraded к готовой обложке');
    assert.equal(item.requestId, undefined);
});

test('attach: у поста без uris-состояния ничего не создаётся', () => {
    attachEntryToCarousel(entry('card-1', 'p1.png', 0));
    assert.equal(chatArr[0].extra?.uris, undefined, 'автоматика не плодит оболочек');
});

test('attach: чужой chatId → no-op', () => {
    attachEntryToCarousel(entry('card-2', 'p2.png', 1, 'other-chat'));
    assert.equal(chatArr[1].extra?.uris, undefined);
});

test('attach: нечисловой sourceMsgId / без id → no-op', () => {
    chatArr[1].extra.uris = { v: 1, items: [] };
    attachEntryToCarousel({ imagePath: 'p.png', provenance: { chatId: 'chat-1', sourceMsgId: null } });
    attachEntryToCarousel({ id: '', imagePath: 'p.png', provenance: { chatId: 'chat-1', sourceMsgId: 1 } });
    assert.deepEqual(chatArr[1].extra.uris.items, []);
});

test('attach: повтор того же id не дублирует cardIds', () => {
    const digest = hashMessage('target post');
    chatArr[2].extra.uris = { v: 1, items: [
        { idx: -1, type: 'img', origin: 'story', status: 'ready', descHash: 'aa',
            digest, imagePath: 'p9.png', cardId: 'card-9', cardIds: ['card-9'] },
    ] };
    attachEntryToCarousel(entry('card-9', 'p9.png', 2), { messageText: 'target post' });
    attachEntryToCarousel(entry('card-10', 'p10.png', 2), { messageText: 'target post' });
    const item = chatArr[2].extra.uris.items[0];
    assert.deepEqual(item.cardIds, ['card-9', 'card-10']);
    assert.equal(item.cardId, 'card-10', 'обложка ← последняя');
});
