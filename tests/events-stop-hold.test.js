// @ts-check
// Stop hold: a parked automation payload must not drain after the user pressed
// Stop ("Stop stops everything"). The next real trigger clears the hold — new
// events keep working, the queue does not resume on its own.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let listenersMap = {};
let makeLastListeners = {};

const eventSource = {
    on: (evt, fn) => {
        if (!listenersMap[evt]) listenersMap[evt] = new Set();
        listenersMap[evt].add(fn);
    },
    makeLast: (evt, fn) => { makeLastListeners[evt] = fn; },
    removeListener: (evt, fn) => {
        if (listenersMap[evt]) listenersMap[evt].delete(fn);
        if (makeLastListeners[evt] === fn) delete makeLastListeners[evt];
    },
};

function emitAll(evt, ...args) {
    const set = listenersMap[evt];
    if (set) for (const fn of set) fn(...args);
}

const event_types = {
    GENERATION_ENDED: 'GENERATION_ENDED',
    MESSAGE_SENT: 'MESSAGE_SENT',
    MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    CHAT_CHANGED: 'CHAT_CHANGED',
    GENERATION_STOPPED: 'GENERATION_STOPPED',
    CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
    USER_MESSAGE_RENDERED: 'USER_MESSAGE_RENDERED',
};

const testCtx = {
    chat: [],
    chatId: 'test-chat',
    eventSource,
    event_types,
    saveSettingsDebounced: () => {},
};

globalThis.SillyTavern = { getContext: () => testCtx };
globalThis.toastr = undefined;
globalThis.window = { location: { origin: 'http://localhost:8000' }, dispatchEvent: () => true };

const { state } = await import('../src/core.js');
const { bindEvents, unbindEvents } = await import('../src/events.js');

function makeInMemoryLFA() {
    const store = new Map();
    return {
        getItem: async (k) => (store.has(k) ? store.get(k) : null),
        setItem: async (k, v) => { store.set(k, v); },
        removeItem: async (k) => { store.delete(k); },
    };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

beforeEach(async () => {
    listenersMap = {};
    makeLastListeners = {};
    globalThis.SillyTavern.libs = { localforage: makeInMemoryLFA() };
    globalThis.SillyTavern.getContext = () => testCtx;
    state.settings = { enabled: true, followLastPost: true };
    state.chatAutomationMode = 'build-prompt';
    state.currentChatId = 'test-chat';
    state.currentMsgId = null;
    testCtx.chat = [{ mes: 'first post', is_user: false }];
    unbindEvents();
});

test('Stop drops the parked payload; a new trigger works afterwards', async () => {
    let calls = 0;
    let releaseRun;
    const gate = new Promise(resolve => { releaseRun = resolve; });
    bindEvents({
        onAutomation: () => {
            calls += 1;
            return gate;
        },
    });

    // First trigger runs and holds the single slot.
    makeLastListeners.CHARACTER_MESSAGE_RENDERED(0);
    await tick();
    assert.equal(calls, 1, 'first trigger dispatched');

    // A second, different post parks while the first run is in flight.
    testCtx.chat.push({ mes: 'second post', is_user: false });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED(1);
    await tick();
    assert.equal(calls, 1, 'parked, not started');

    // Stop: the parked payload must not drain when the run finishes.
    emitAll(event_types.GENERATION_STOPPED);
    releaseRun();
    await tick();
    await tick();
    assert.equal(calls, 1, 'no drain after Stop');

    // A new real trigger clears the hold and runs.
    testCtx.chat.push({ mes: 'third post', is_user: false });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED(2);
    await tick();
    assert.equal(calls, 2, 'new trigger after Stop works');
    releaseRun();
    await tick();
    unbindEvents();
});

test('chatConfig is captured at trigger time, not at handler start', async () => {
    let seen = null;
    bindEvents({
        onAutomation: (payload) => {
            seen = payload;
            return Promise.resolve();
        },
    });
    state.generationDefaults = { aspectRatio: '16:9' };
    state.activeImageProfileId = 'conn-1';
    makeLastListeners.CHARACTER_MESSAGE_RENDERED(0);
    await tick();
    assert.ok(seen, 'automation dispatched');
    assert.equal(seen.chatConfig.imageProfileId, 'conn-1');
    assert.equal(seen.chatConfig.generationDefaults.aspectRatio, '16:9');

    // The runtime state moves on (chat switch applied another config) — the
    // captured snapshot stays the trigger-time one.
    state.activeImageProfileId = 'conn-2';
    assert.equal(seen.chatConfig.imageProfileId, 'conn-1', 'payload holds its own snapshot');
    unbindEvents();
});
