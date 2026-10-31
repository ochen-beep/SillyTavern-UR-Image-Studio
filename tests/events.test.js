// @ts-check
// Unit-тесты для src/events.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setFilter } from '../src/post-navigator.js';

// EventSource mock: real ST EventEmitter supports many subscribers per event,
// so we keep a Set of listeners per event (not a single fn). `listeners[evt]`
// returns the first registered handler — tests call it to simulate an emit,
// but ALL registered handlers fire on the actual emit. makeLast stores its own
// handler (ST's "makeLast" reorders; for unit tests we just track it separately).
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

// Compatibility shim: `listeners[evt]` returns the FIRST registered handler so
// existing tests can call it like a single-fn emit. To emit to all subscribers
// (mirrors real EventEmitter), use emitAll(evt).
const listeners = new Proxy({}, {
    get: (_t, prop) => {
        const set = listenersMap[prop];
        return set && set.size ? set.values().next().value : undefined;
    },
});

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

let testCtx = {
    chat: [],
    chatId: 'test-chat',
    eventSource,
    event_types,
    saveSettingsDebounced: () => {},
};

globalThis.SillyTavern = {
    getContext: () => testCtx,
};
globalThis.toastr = undefined;
globalThis.window = { location: { origin: 'http://localhost:8000' }, dispatchEvent: () => true };

const { state, META_KEY } = await import('../src/core.js');
const { POST_FILTER } = await import('../src/post-navigator.js');
const { bindEvents, unbindEvents } = await import('../src/events.js');

function makeInMemoryLFA() {
    const store = new Map();
    return {
        getItem: async (k) => (store.has(k) ? store.get(k) : null),
        setItem: async (k, v) => { store.set(k, v); },
        removeItem: async (k) => { store.delete(k); },
    };
}

let _chatMetadata = {};
let lfMock;

beforeEach(() => {
    listenersMap = {};
    makeLastListeners = {};
    _chatMetadata = {};
    lfMock = makeInMemoryLFA();
    testCtx.chat = [
        { mes: 'u1', is_user: true },
        { mes: 'a1', is_user: false },
        { mes: 'u2', is_user: true },
        { mes: 'a2', is_user: false },
    ];
    testCtx.chatMetadata = _chatMetadata;
    testCtx.saveMetadata = () => {};
    globalThis.SillyTavern.libs = { localforage: lfMock };
    state.settings = {
        enabled: true,
        followLastPost: true,
    };
    // Chat-scoped automation config projection (schema-v5) — the authoritative
    // runtime fields events.js reads. Never in state.settings: that object is
    // persisted globally and must not leak a per-chat mode across sessions.
    state.chatAutomationMode = 'build-prompt';
    setFilter(POST_FILTER.AI_ONLY);
    state.currentMsgId = null;
    state.currentChatId = null;
    testCtx.chatId = 'test-chat';
    unbindEvents();
});

test('bindEvents registers both auto event listeners', () => {
    bindEvents({ onAutomation: () => {} });
    assert.ok(makeLastListeners.CHARACTER_MESSAGE_RENDERED);
    assert.ok(listeners.USER_MESSAGE_RENDERED);
    unbindEvents();
});

test('ai-only flow: GENERATION_ENDED triggers, MESSAGE_SENT does not', () => {
    let called = null;
    bindEvents({ onAutomation: ({ msgId }) => { called = msgId; } });
    listeners.USER_MESSAGE_RENDERED();
    assert.equal(called, null);
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(called, 3);
    unbindEvents();
});

test('user-only flow: MESSAGE_SENT triggers, GENERATION_ENDED does not', () => {
    setFilter(POST_FILTER.USER_ONLY);
    state.generationFlow = POST_FILTER.USER_ONLY;
    let called = null;
    bindEvents({ onAutomation: ({ msgId }) => { called = msgId; } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(called, null);
    listeners.USER_MESSAGE_RENDERED();
    assert.equal(called, 2);
    unbindEvents();
});

test('all flow: identical duplicate triggers coalesce into one dispatch', () => {
    setFilter(POST_FILTER.ALL);
    state.generationFlow = POST_FILTER.ALL;
    testCtx.chat = [
        { mes: 'a1', is_user: false },
        { mes: 'u1', is_user: true },
        { mes: 'a2', is_user: false },
        { mes: 'u2', is_user: true },
    ];
    const calls = [];
    bindEvents({ onAutomation: ({ msgId }) => { calls.push(msgId); } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    listeners.USER_MESSAGE_RENDERED();
    // Same chat/msgId/text/action twice in a row = one dispatch (slot dedup).
    assert.deepEqual(calls, [3]);
    unbindEvents();
});

test('automation slot: rapid different triggers park latest and drain in order', async () => {
    setFilter(POST_FILTER.ALL);
    state.generationFlow = POST_FILTER.ALL;
    const calls = [];
    let resolveRun = null;
    bindEvents({ onAutomation: ({ msgId }) => {
        calls.push(msgId);
        if (msgId === 3) return new Promise(r => { resolveRun = r; });
        return undefined;
    } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();          // msgId 3 — in flight, gated
    listeners.USER_MESSAGE_RENDERED(1);                      // parked (msgId 1)
    listeners.USER_MESSAGE_RENDERED(0);                      // latest wins: msgId 0 replaces 1
    assert.deepEqual(calls, [3], 'only the first runs while the slot is busy');
    resolveRun();
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(calls, [3, 0], 'only the latest parked payload drains after completion');
    unbindEvents();
});

test('automation slot: a payload parked before a chat switch is dropped', async () => {
    setFilter(POST_FILTER.ALL);
    state.generationFlow = POST_FILTER.ALL;
    const calls = [];
    let resolveRun = null;
    bindEvents({ onAutomation: () => {
        calls.push('run');
        return new Promise(r => { resolveRun = r; });
    } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    listeners.USER_MESSAGE_RENDERED(1);
    // Chat switch mid-flight: the parked payload must not drain into the new chat.
    listeners.CHAT_CHANGED();
    resolveRun();
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(calls, ['run'], 'parked payload dropped after CHAT_CHANGED');
    unbindEvents();
});

test('MESSAGE_SENT uses provided msgId when available', () => {
    setFilter(POST_FILTER.ALL);
    state.generationFlow = POST_FILTER.ALL;
    let called = null;
    bindEvents({ onAutomation: ({ msgId }) => { called = msgId; } });
    listeners.USER_MESSAGE_RENDERED(1);
    assert.equal(called, 1);
    unbindEvents();
});

test('manual flow: neither auto event triggers', () => {
    state.chatGenerationFlow = POST_FILTER.MANUAL;
    state.generationFlow = POST_FILTER.MANUAL;
    let called = false;
    bindEvents({ onAutomation: () => { called = true; } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    listeners.USER_MESSAGE_RENDERED();
    assert.equal(called, false);
    unbindEvents();
});

test('GENERATION_ENDED triggers onAutomation for last AI post in ai-only flow', () => {
    let called = null;
    bindEvents({ onAutomation: ({ msgId }) => { called = msgId; } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(called, 3);
    unbindEvents();
});

test('GENERATION_ENDED triggers onAutomation for last AI post in all flow', () => {
    setFilter(POST_FILTER.ALL);
    state.generationFlow = POST_FILTER.ALL;
    let called = null;
    bindEvents({ onAutomation: ({ msgId }) => { called = msgId; } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(called, 3);
    unbindEvents();
});

test('MESSAGE_SENT triggers onAutomation for last user post in user-only flow', () => {
    setFilter(POST_FILTER.USER_ONLY);
    state.generationFlow = POST_FILTER.USER_ONLY;
    let called = null;
    bindEvents({ onAutomation: ({ msgId }) => { called = msgId; } });
    listeners.USER_MESSAGE_RENDERED();
    assert.equal(called, 2);
    unbindEvents();
});

test('auto triggers do nothing when extension disabled', () => {
    state.settings.enabled = false;
    let called = false;
    bindEvents({ onAutomation: () => { called = true; } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    listeners.USER_MESSAGE_RENDERED();
    assert.equal(called, false);
    unbindEvents();
});

test('auto triggers do nothing when automationMode is manual', () => {
    state.chatAutomationMode = 'manual';
    let called = false;
    bindEvents({ onAutomation: () => { called = true; } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    listeners.USER_MESSAGE_RENDERED();
    assert.equal(called, false);
    unbindEvents();
});

test('onAutomation receives captured chatId, msgId, messageText, and requestedAction', () => {
    state.chatAutomationMode = 'full-pipeline';
    let captured = null;
    bindEvents({ onAutomation: (payload) => { captured = payload; } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.ok(captured);
    assert.equal(captured.chatId, 'test-chat');
    assert.equal(captured.msgId, 3);
    assert.equal(captured.messageText, 'a2');
    assert.equal(captured.requestedAction, 'full-pipeline');
    assert.equal(captured.templateId, null);
    unbindEvents();
});

test('unbindEvents removes all listeners', () => {
    setFilter(POST_FILTER.ALL);
    state.generationFlow = POST_FILTER.ALL;
    bindEvents({ onAutomation: () => {} });
    unbindEvents();
    const remaining = Object.values(listenersMap).reduce((n, s) => n + s.size, 0);
    assert.equal(remaining, 0);
    assert.equal(Object.keys(makeLastListeners).length, 0);
});

test('CHAT_CHANGED awaits chat config load before dispatching uris:chat-changed', async () => {
    _chatMetadata[META_KEY] = {
        schemaVersion: 5,
        config: {
            automationMode: 'full-pipeline',
            generationFlow: 'all',
            imageProfileId: null,
            templateId: null,
        },
        refs: { referenceIds: [] },
    };
    state.chatAutomationMode = 'manual';
    let dispatched = false;
    const originalDispatch = window.dispatchEvent;
    window.dispatchEvent = (evt) => {
        if (evt.type === 'uris:chat-changed') dispatched = true;
        return true;
    };
    bindEvents({ onAutomation: () => {} });
    listeners.CHAT_CHANGED();
    assert.equal(dispatched, false, 'chat-changed must not fire synchronously before config load');
    await new Promise(r => setTimeout(r, 0));
    assert.equal(dispatched, true, 'chat-changed must fire after async config load');
    assert.equal(state.chatAutomationMode, 'full-pipeline');
    window.dispatchEvent = originalDispatch;
    unbindEvents();
});

test('automation is suppressed until the current schema-v5 chat config is applied', async () => {
    _chatMetadata[META_KEY] = {
        schemaVersion: 5,
        config: {
            automationMode: 'full-pipeline',
            generationFlow: 'ai-only',
            imageProfileId: 'img-current',
            templateId: null,
        },
        refs: { referenceIds: [] },
    };
    state.chatAutomationMode = 'manual';
    let called = false;
    bindEvents({ onAutomation: () => { called = true; } });
    listeners.CHAT_CHANGED();
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(called, false, 'automation must not run before the current chat config is applied');
    await new Promise(r => setTimeout(r, 0));
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(called, true, 'automation must run after the current chat config is applied');
    assert.equal(state.activeImageProfileId, 'img-current');
    unbindEvents();
});

test('rapid schema-v5 chat switches leave the later current chat configuration active', async () => {
    const metadataByChat = {
        'chat-a': {
            [META_KEY]: {
                schemaVersion: 5,
                config: {
                    automationMode: 'build-prompt',
                    generationFlow: 'user-only',
                    imageProfileId: 'conn-a',
                    templateId: null,
                },
                refs: { referenceIds: [] },
            },
        },
        'chat-b': {
            [META_KEY]: {
                schemaVersion: 5,
                config: {
                    automationMode: 'full-pipeline',
                    generationFlow: 'ai-only',
                    imageProfileId: 'conn-b',
                    templateId: null,
                },
                refs: { referenceIds: [] },
            },
        },
    };
    const originalGetContext = globalThis.SillyTavern.getContext;
    const originalDispatch = window.dispatchEvent;
    let eventCount = 0;
    window.dispatchEvent = (evt) => {
        if (evt.type === 'uris:chat-changed') eventCount++;
        return true;
    };
    globalThis.SillyTavern.getContext = () => ({
        ...testCtx,
        chatMetadata: metadataByChat[testCtx.chatId],
    });
    try {
        bindEvents({ onAutomation: () => {} });
        testCtx.chatId = 'chat-a';
        listeners.CHAT_CHANGED();
        testCtx.chatId = 'chat-b';
        listeners.CHAT_CHANGED();
        await new Promise(r => setTimeout(r, 0));
        assert.equal(state.chatAutomationMode, 'full-pipeline');
        assert.equal(state.activeImageProfileId, 'conn-b');
        assert.equal(eventCount, 1, 'chat-changed must dispatch only for the current chat');
    } finally {
        globalThis.SillyTavern.getContext = originalGetContext;
        window.dispatchEvent = originalDispatch;
        unbindEvents();
    }
});

test('GENERATION_ENDED falls back to state.currentChatId when ctx.chatId is empty (swipe race)', () => {
    // Reproduces the swipe race: after a swipe, ST's getContext().chatId is
    // transiently empty while the chat is still saving. automation must use
    // state.currentChatId (set on CHAT_CHANGED) instead of throwing
    // 'chatId is required' inside the pipeline.
    state.currentChatId = 'persisted-chat-id';
    testCtx.chatId = '';
    let captured = null;
    bindEvents({ onAutomation: (payload) => { captured = payload; } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(captured?.chatId, 'persisted-chat-id', 'must fall back to state.currentChatId');
    assert.equal(captured?.msgId, 3);
    unbindEvents();
});

test('GENERATION_ENDED retries automation after delay when chatId becomes available', async () => {
    // Both sources empty initially, but ctx.chatId becomes available after delay
    state.currentChatId = null;
    testCtx.chatId = '';
    let captured = null;
    bindEvents({ onAutomation: (payload) => { captured = payload; } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(captured, null, 'must not call immediately without chatId');
    // Simulate ST setting chatId after a short delay
    setTimeout(() => {
        testCtx.chatId = 'retry-chat-id';
    }, 100);
    await new Promise(r => setTimeout(r, 400));
    assert.ok(captured, 'must call onAutomation after retry');
    assert.equal(captured?.chatId, 'retry-chat-id', 'must use retry chatId');
    unbindEvents();
});

test('GENERATION_ENDED skips automation and logs when no chatId is available anywhere', async () => {
    // Both ctx.chatId and state.currentChatId are empty and stay empty:
    // automation must NOT fire onAutomation with an empty chatId (which would
    // throw deep in the pipeline). Silent skip + warn log instead.
    state.currentChatId = null;
    testCtx.chatId = '';
    let called = false;
    bindEvents({ onAutomation: () => { called = true; } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(called, false, 'must not call onAutomation immediately without a chatId');
    // Wait longer than the retry delay to ensure retry also fails
    await new Promise(r => setTimeout(r, 400));
    assert.equal(called, false, 'must not call onAutomation after retry without a chatId');
    unbindEvents();
});

test('GENERATION_ENDED re-reads fresh ctx.chatId after chat opens (stale getContext snapshot regression)', async () => {
    // Regression: ST's getContext() returns a NEW object per call — scalar fields
    // like chatId are frozen at call time. The extension binds events during page
    // load, before any chat is open, so a ctx captured by bindEvents keeps
    // chatId === undefined forever and automation never fires
    // ("Auto generation skipped: chatId is empty"). chatId must be re-read from a
    // fresh context at event time, exactly like DS Comments does.
    const originalGetContext = globalThis.SillyTavern.getContext;
    let liveChatId = ''; // no chat open at bind time
    globalThis.SillyTavern.getContext = () => ({ ...testCtx, chatId: liveChatId });
    // The open chat has full-pipeline automation saved in its metadata binding —
    // CHAT_CHANGED applies it to state, replacing the pre-chat defaults.
    _chatMetadata[META_KEY] = {
        schemaVersion: 4,
        config: {
            automationMode: 'full-pipeline',
            generationFlow: 'ai-only',
            imageProfileId: null,
            templateId: null,
        },
        refs: { referenceIds: [] },
    };
    let captured = null;
    try {
        bindEvents({ onAutomation: (payload) => { captured = payload; } });
        // Chat opens: ST emits CHAT_CHANGED, chatId is now available
        liveChatId = 'real-chat';
        listeners.CHAT_CHANGED();
        await new Promise(r => setTimeout(r, 0));
        // Swipe / new post generation completes
        makeLastListeners.CHARACTER_MESSAGE_RENDERED();
        assert.ok(captured, 'automation must fire once a chat is open');
        assert.equal(captured?.chatId, 'real-chat');
    } finally {
        globalThis.SillyTavern.getContext = originalGetContext;
        unbindEvents();
    }
});

test('CHAT_CHANGED recovers from loadChatConfig error and unblocks automation', async () => {
    testCtx.chatMetadata = {
        get [META_KEY]() { throw new Error('metadata boom'); }
    };
    const dispatched = [];
    const originalDispatch = window.dispatchEvent;
    window.dispatchEvent = (evt) => { dispatched.push(evt.type); return true; };
    let called = false;
    bindEvents({ onAutomation: () => { called = true; } });
    listeners.CHAT_CHANGED();
    assert.equal(dispatched.length, 0, 'chat-changed must not fire synchronously before config load');
    await new Promise(r => setTimeout(r, 0));
    assert.ok(dispatched.includes('uris:chat-changed'), 'chat-changed must still be dispatched after failed config load');
    assert.equal(called, false, 'automation should not have run before being triggered');
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(called, true, 'automation must be able to run after chat config load failure');
    window.dispatchEvent = originalDispatch;
    unbindEvents();
});

test('follow=ON: GENERATION_ENDED snaps currentMsgId to last post and dispatches uris:post-follow', () => {
    state.settings.followLastPost = true;
    state.chatAutomationMode = 'manual'; // automation off — pure UI snap
    state.currentMsgId = 1;                    // пользователь ушёл на старый пост
    const dispatched = [];
    const originalDispatch = window.dispatchEvent;
    window.dispatchEvent = (ev) => { dispatched.push(ev.type); return true; };
    let captured = null;
    bindEvents({ onAutomation: (p) => { captured = p; } });
    // Emit to ALL subscribers (makeLast automation + on follow), mirroring ST.
    if (makeLastListeners.CHARACTER_MESSAGE_RENDERED) makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    emitAll('GENERATION_ENDED');
    assert.equal(captured, null, 'automation must not fire in manual mode');
    assert.equal(state.currentMsgId, 3, 'currentMsgId must snap to last post');
    assert.ok(dispatched.includes('uris:post-follow'), 'uris:post-follow must be dispatched');
    window.dispatchEvent = originalDispatch;
    unbindEvents();
});

test('follow=ON: MESSAGE_SWIPED dispatches uris:post-follow even when currentMsgId unchanged', () => {
    state.settings.followLastPost = true;
    state.currentMsgId = 3; // уже на последнем — msgId не изменится
    const dispatched = [];
    const originalDispatch = window.dispatchEvent;
    window.dispatchEvent = (ev) => { dispatched.push(ev.type); return true; };
    bindEvents({ onAutomation: () => {} });
    listeners.MESSAGE_SWIPED();
    assert.equal(state.currentMsgId, 3);
    assert.ok(dispatched.includes('uris:post-follow'), 'swipe must trigger re-render even if msgId unchanged');
    window.dispatchEvent = originalDispatch;
    unbindEvents();
});

test('follow=OFF: GENERATION_ENDED does not touch currentMsgId or dispatch uris:post-follow', () => {
    state.settings.followLastPost = false;
    state.chatAutomationMode = 'manual';
    state.currentMsgId = 1;
    const dispatched = [];
    const originalDispatch = window.dispatchEvent;
    window.dispatchEvent = (ev) => { dispatched.push(ev.type); return true; };
    bindEvents({ onAutomation: () => {} });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(state.currentMsgId, 1, 'currentMsgId must stay where user left it');
    assert.equal(dispatched.includes('uris:post-follow'), false, 'must not dispatch when follow is off');
    window.dispatchEvent = originalDispatch;
    unbindEvents();
});

test('followLastPost flag is not cleared by manual navigation', () => {
    state.settings.followLastPost = true;
    state.currentMsgId = 3;
    bindEvents({ onAutomation: () => {} });
    // Символизирует ручной клик по стрелке ← через post-navigator
    state.currentMsgId = 2;
    assert.equal(state.settings.followLastPost, true, 'manual nav must not clear the flag');
    unbindEvents();
});

test('onStopAll fires on every GENERATION_STOPPED and is removed by unbindEvents', () => {
    let stopped = 0;
    bindEvents({ onAutomation: () => {}, onStopAll: () => { stopped++; } });
    assert.ok(listeners.GENERATION_STOPPED, 'stop listener is registered');
    // ST's stopGeneration() emits GENERATION_STOPPED on every Stop press.
    emitAll('GENERATION_STOPPED');
    emitAll('GENERATION_STOPPED');
    assert.equal(stopped, 2);
    unbindEvents();
    emitAll('GENERATION_STOPPED');
    assert.equal(stopped, 2, 'handler must not fire after unbindEvents');
});

test('bindEvents without onStopAll still subscribes GENERATION_STOPPED for the hold', () => {
    bindEvents({ onAutomation: () => {} });
    // The stop hold (drop parked automation, block the slot drain) must work
    // even when the caller passed no stop handler — e.g. a busy tab.
    assert.ok(listeners.GENERATION_STOPPED, 'stop listener is registered unconditionally');
    assert.doesNotThrow(() => emitAll('GENERATION_STOPPED'));
    unbindEvents();
});

// ── visible-content guard (aborted-CoT posts must not start automation) ──

test('GENERATION_ENDED does not trigger automation on a reasoning-only post from an aborted stream', () => {
    // Reproduces the abort-mid-CoT case: ST saves the partial message
    // (<think> without closing suffix) and emits GENERATION_ENDED — Stage 1
    // must not run on invisible content.
    testCtx.chat = [{ mes: 'u1', is_user: true }, { mes: '<think>partial reasoning never closed', is_user: false }];
    let called = null;
    bindEvents({ onAutomation: ({ msgId }) => { called = msgId; } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(called, null, 'reasoning-only post must not start automation');
    unbindEvents();
});

test('reasoning-only last post does not fall back to an older AI post', () => {
    // The skip must be a hard stop, not a filter miss: if the empty post fell
    // out of matchesFilter, getLastPostIndex() would return post #1 and
    // automation would silently regenerate an OLD post.
    testCtx.chat = [
        { mes: 'old scene', is_user: false },
        { mes: '<think>aborted', is_user: false },
    ];
    let called = null;
    bindEvents({ onAutomation: ({ msgId }) => { called = msgId; } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(called, null, 'must skip entirely — no fallback to the older post');
    unbindEvents();
});

test('GENERATION_ENDED still triggers when visible content precedes an unterminated think block', () => {
    testCtx.chat = [{ mes: 'Scene setup <think>partial', is_user: false }];
    let called = null;
    bindEvents({ onAutomation: ({ msgId }) => { called = msgId; } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(called, 0);
    unbindEvents();
});

test('empty and placeholder posts do not trigger automation', () => {
    testCtx.chat = [{ mes: 'u1', is_user: true }, { mes: '   ', is_user: false }];
    let called = null;
    bindEvents({ onAutomation: ({ msgId }) => { called = msgId; } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(called, null, 'whitespace-only post must not start automation');
    testCtx.chat = [{ mes: 'u1', is_user: true }, { mes: '...', is_user: false }];
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(called, null, "ST's '...' placeholder must not start automation");
    unbindEvents();
});

test('system and hidden posts do not trigger automation', () => {
    testCtx.chat = [{ mes: 'u1', is_user: true }, { mes: 'sys text', is_system: true }];
    let called = null;
    bindEvents({ onAutomation: ({ msgId }) => { called = msgId; } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(called, null, 'is_system post must not start automation');
    testCtx.chat = [{ mes: 'u1', is_user: true }, { mes: 'hidden text', is_hidden: true }];
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(called, null, 'is_hidden post must not start automation');
    unbindEvents();
});

test('user-only flow: empty user post does not trigger automation', () => {
    setFilter(POST_FILTER.USER_ONLY);
    state.generationFlow = POST_FILTER.USER_ONLY;
    testCtx.chat = [{ mes: '   ', is_user: true }];
    let called = null;
    bindEvents({ onAutomation: ({ msgId }) => { called = msgId; } });
    listeners.USER_MESSAGE_RENDERED();
    assert.equal(called, null);
    unbindEvents();
});

test('closed think block does not block automation (ST parsed the reasoning, mes is clean)', () => {
    // When auto-parse succeeds ST strips the block from mes itself; the guard
    // must not reject posts merely because a complete reasoning block existed.
    testCtx.chat = [{ mes: 'u1', is_user: true }, { mes: 'Real scene text', is_user: false }];
    let called = null;
    bindEvents({ onAutomation: ({ msgId }) => { called = msgId; } });
    makeLastListeners.CHARACTER_MESSAGE_RENDERED();
    assert.equal(called, 1);
    unbindEvents();
});


test('MESSAGE_SWIPED (swipe navigation) never dispatches automation', () => {
    let called = false;
    bindEvents({ onAutomation: () => { called = true; } });
    // Swiping between existing variants emits only MESSAGE_SWIPED — automation
    // listens to RENDERED events, so revisiting a swipe is free.
    listeners.MESSAGE_SWIPED(3);
    assert.equal(called, false, 'swipe navigation must not trigger automation');
    unbindEvents();
});
