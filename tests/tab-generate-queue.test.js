// @ts-check
// UI tests for the Generate-tab queue status: the «Остановить» button wires the
// already-imported stopQueue() to a visible control (Task #4-min).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

// Full fake DOM so updateQueueStatus can set innerHTML and query it back.
const { document } = makeFakeDocument();
globalThis.document = document;
globalThis.window = { location: { origin: 'http://localhost:8000' }, dispatchEvent: () => {} };
globalThis.SillyTavern = {
    getContext: () => ({ extensionSettings: {}, saveSettingsDebounced: () => {}, getRequestHeaders: () => ({}) }),
    libs: { localforage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } },
};
globalThis.toastr = undefined;

const { state } = await import('../src/core.js');
const { updateQueueStatus, setCancelState } = await import('../src/ui/tab-generate.js');

function makeRoot() {
    const root = document.createElement('div');
    root.innerHTML = '<div class="uris-queue-status" id="urisQueueStatus"></div>';
    return root;
}

beforeEach(() => {
    state.queue = [];
    state.queueRunning = false;
    state.queueAbort = null;
    state.activeGenerations = new Map();
});

afterEach(() => {
    state.queue = [];
    state.queueRunning = false;
    state.queueAbort = null;
});

test('updateQueueStatus renders nothing when the queue is empty and idle', () => {
    const root = makeRoot();
    updateQueueStatus(root);
    const status = root.querySelector('#urisQueueStatus');
    assert.equal(status.textContent, '');
    assert.equal(status.querySelector('#urisStopQueue'), null);
});

test('updateQueueStatus renders an «Остановить» button while items are queued', () => {
    state.queue = [{ item: {}, resolve: () => {}, reject: () => {} }];
    const root = makeRoot();
    updateQueueStatus(root);
    const status = root.querySelector('#urisQueueStatus');
    const btn = status.querySelector('#urisStopQueue');
    assert.ok(btn, 'stop button is rendered');
    assert.equal(btn.tagName, 'button');
    assert.match(status.textContent, /В очереди: 1/);
});

test('updateQueueStatus renders the button while the queue is running even if no items remain', () => {
    state.queue = [];
    state.queueRunning = true;
    const root = makeRoot();
    updateQueueStatus(root);
    assert.ok(root.querySelector('#urisStopQueue'), 'stop button is rendered while running');
});

test('clicking the stop button invokes stopQueue (aborts the shared queue controller)', () => {
    state.queue = [{ item: {}, resolve: () => {}, reject: () => {} }];
    // stopQueue() aborts only the shared queue controller (cascades to queued
    // Stage 2 via the linked signal). Plant a controller spy so the click ->
    // stopQueue -> abort path is observable.
    let aborted = false;
    state.queueAbort = { aborted: false, abort() { aborted = true; } };
    const root = makeRoot();
    updateQueueStatus(root);
    const btn = root.querySelector('#urisStopQueue');
    assert.ok(btn);
    btn.click();
    assert.equal(aborted, true, 'stopQueue aborted the queue controller');
});

test('stop button is removed again once the queue drains and becomes idle', () => {
    state.queue = [{ item: {}, resolve: () => {}, reject: () => {} }];
    const root = makeRoot();
    updateQueueStatus(root);
    assert.ok(root.querySelector('#urisStopQueue'));
    state.queue = [];
    state.queueRunning = false;
    updateQueueStatus(root);
    assert.equal(root.querySelector('#urisStopQueue'), null, 'button disappears when idle');
});

test('setCancelState shows the cancel button with the requestId while running', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button id="urisCancelImage" hidden data-request-id=""></button>';
    setCancelState(root, 'req-abc', true);
    const btn = root.querySelector('#urisCancelImage');
    assert.equal(btn.hidden, false, 'button is shown');
    assert.equal(btn.getAttribute('data-request-id'), 'req-abc');
});

test('setCancelState hides the cancel button when not running', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button id="urisCancelImage" data-request-id="req-abc"></button>';
    setCancelState(root, null, false);
    const btn = root.querySelector('#urisCancelImage');
    assert.equal(btn.hidden, true, 'button is hidden');
});

test('setCancelState is a no-op when the cancel button is absent', () => {
    const root = makeRoot();
    assert.doesNotThrow(() => setCancelState(root, 'req-x', true));
});
