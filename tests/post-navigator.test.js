// @ts-check
// Unit-тесты для src/post-navigator.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let testCtx = { chat: [] };

globalThis.SillyTavern = {
    getContext: () => testCtx,
};
globalThis.toastr = undefined;
globalThis.window = { location: { origin: 'http://localhost:8000' } };

const { state } = await import('../src/core.js');
const {
    POST_FILTER,
    setFilter,
    getFilter,
    getFilteredIndexes,
    isValidTarget,
    navigatePosts,
    getLastPostIndex,
    getPostInfo,
    setCurrentMsgId,
} = await import('../src/post-navigator.js');

beforeEach(() => {
    testCtx = { chat: [] };
    state.generationFlow = POST_FILTER.AI_ONLY;
    state.currentMsgId = null;
});

function setChat(chat) {
    testCtx.chat = chat;
}

test('getFilteredIndexes respects ai-only filter', () => {
    setChat([
        { mes: 'hi', is_user: true },
        { mes: 'hello', is_user: false },
        { mes: 'bye', is_user: true },
        { mes: 'goodbye', is_user: false },
    ]);
    setFilter(POST_FILTER.AI_ONLY);
    assert.deepEqual(getFilteredIndexes(), [1, 3]);
});

test('getFilteredIndexes respects user-only filter', () => {
    setChat([
        { mes: 'hi', is_user: true },
        { mes: 'hello', is_user: false },
        { mes: 'bye', is_user: true },
    ]);
    setFilter(POST_FILTER.USER_ONLY);
    assert.deepEqual(getFilteredIndexes(), [0, 2]);
});

test('getFilteredIndexes returns all for all and manual filters', () => {
    setChat([
        { mes: 'a', is_user: true },
        { mes: 'b', is_user: false },
    ]);
    setFilter(POST_FILTER.ALL);
    assert.deepEqual(getFilteredIndexes(), [0, 1]);
    setFilter(POST_FILTER.MANUAL);
    assert.deepEqual(getFilteredIndexes(), [0, 1]);
});

test('navigatePosts moves within filtered indexes', () => {
    setChat([
        { mes: 'u1', is_user: true },
        { mes: 'a1', is_user: false },
        { mes: 'u2', is_user: true },
        { mes: 'a2', is_user: false },
    ]);
    setFilter(POST_FILTER.AI_ONLY);
    state.currentMsgId = 3;
    assert.equal(navigatePosts(-1), 1);
    assert.equal(navigatePosts(1), 3);
});

test('navigatePosts falls back to last valid when current is invalid', () => {
    setChat([
        { mes: 'u1', is_user: true },
        { mes: 'a1', is_user: false },
    ]);
    setFilter(POST_FILTER.AI_ONLY);
    state.currentMsgId = 0;
    assert.equal(navigatePosts(0), 1);
});

test('navigatePosts returns null for empty chat', () => {
    setChat([]);
    setFilter(POST_FILTER.ALL);
    assert.equal(navigatePosts(0), null);
    assert.equal(state.currentMsgId, null);
});

test('getLastPostIndex returns last matching message', () => {
    setChat([
        { mes: 'u1', is_user: true },
        { mes: 'a1', is_user: false },
        { mes: 'u2', is_user: true },
    ]);
    setFilter(POST_FILTER.AI_ONLY);
    assert.equal(getLastPostIndex(), 1);
    setFilter(POST_FILTER.USER_ONLY);
    assert.equal(getLastPostIndex(), 2);
});

test('setFilter migrates currentMsgId when it no longer matches', () => {
    setChat([
        { mes: 'u1', is_user: true },
        { mes: 'a1', is_user: false },
    ]);
    state.currentMsgId = 0;
    setFilter(POST_FILTER.AI_ONLY);
    assert.equal(state.currentMsgId, 1);
});

test('isValidTarget rejects -1 and missing messages', () => {
    setChat([{ mes: 'u1', is_user: true }]);
    setFilter(POST_FILTER.ALL);
    assert.equal(isValidTarget(-1), false);
    assert.equal(isValidTarget(null), false);
    assert.equal(isValidTarget(5), false);
    assert.equal(isValidTarget(0), true);
});

test('setCurrentMsgId keeps valid target and falls back on invalid', () => {
    setChat([
        { mes: 'u1', is_user: true },
        { mes: 'a1', is_user: false },
    ]);
    setFilter(POST_FILTER.AI_ONLY);
    assert.equal(setCurrentMsgId(1), 1);
    assert.equal(state.currentMsgId, 1);
    assert.equal(setCurrentMsgId(0), 1);
    assert.equal(state.currentMsgId, 1);
});

test('getPostInfo labels user and AI posts', () => {
    setChat([{ mes: 'hello world', is_user: true }]);
    setFilter(POST_FILTER.ALL);
    state.currentMsgId = 0;
    assert.match(getPostInfo(), /Пост #0 \(user\): hello world…/);
});

test('invalid filter falls back to ai-only', () => {
    setChat([
        { mes: 'u1', is_user: true },
        { mes: 'a1', is_user: false },
    ]);
    setFilter('nonsense');
    assert.equal(getFilter(), POST_FILTER.AI_ONLY);
    assert.deepEqual(getFilteredIndexes(), [1]);
});
