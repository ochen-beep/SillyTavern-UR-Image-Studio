// @ts-check
// Unit tests for per-request abort helpers (abortGeneration / abortAllGenerations).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals } from './_helpers.js';
import { state, abortGeneration, abortAllGenerations } from '../src/core.js';

beforeEach(() => {
    installStGlobals();
    state.activeGenerations.clear();
});

test('abortGeneration: aborts the controller for the given requestId and returns true', () => {
    const ctrl = new AbortController();
    state.activeGenerations.set('req-1', ctrl);
    assert.equal(abortGeneration('req-1'), true);
    assert.equal(ctrl.signal.aborted, true);
});

test('abortGeneration: returns false for an unknown requestId', () => {
    assert.equal(abortGeneration('nonexistent'), false);
});

test('abortGeneration: does not remove the Map entry (cleanup is the pipeline finally\'s job)', () => {
    const ctrl = new AbortController();
    state.activeGenerations.set('req-2', ctrl);
    abortGeneration('req-2');
    assert.ok(state.activeGenerations.has('req-2'), 'Map entry persists until pipeline finally deletes it');
});

test('abortAllGenerations: aborts all registered controllers', () => {
    const a = new AbortController();
    const b = new AbortController();
    state.activeGenerations.set('req-a', a);
    state.activeGenerations.set('req-b', b);
    abortAllGenerations();
    assert.equal(a.signal.aborted, true);
    assert.equal(b.signal.aborted, true);
});

test('abortAllGenerations: no-op on an empty Map', () => {
    assert.doesNotThrow(() => abortAllGenerations());
});

test('stopQueue is scoped to the queue controller and does not abort manual generations', async () => {
    const { stopQueue } = await import('../src/pipeline-queue.js');
    const manual = new AbortController();
    state.activeGenerations.set('manual-req', manual);
    state.queueAbort = new AbortController();
    stopQueue();
    assert.equal(state.queueAbort.signal.aborted, true, 'queue controller is aborted');
    assert.equal(manual.signal.aborted, false, 'an unrelated manual generation is left running');
    state.activeGenerations.clear();
    state.queueAbort = null;
});
