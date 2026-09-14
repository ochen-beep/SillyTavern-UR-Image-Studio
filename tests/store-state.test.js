import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  getStoreState,
  refreshStoreState,
  subscribeStoreState,
  setGetStoreStatusForTests,
  resetStoreStateForTests,
} from '../src/store-state.js';
import { ServerStoreApiError } from '../src/server-store-api.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => resetStoreStateForTests());
afterEach(() => {
  setGetStoreStatusForTests(null);
  resetStoreStateForTests();
});

describe('server store availability state', () => {
  it('starts unknown, publishes available after a ready status, and notifies subscribers', async () => {
    const states = [];
    const unsubscribe = subscribeStoreState(state => states.push(state));
    setGetStoreStatusForTests(async () => ({ schemaVersion: 1, state: 'ready' }));

    const current = await refreshStoreState();

    assert.equal(getStoreState().status, 'available');
    assert.equal(current.status, 'available');
    assert.deepEqual(states.map(s => s.status), ['unknown', 'available']);
    unsubscribe();
  });

  it('maps incompatibility to incompatible', async () => {
    setGetStoreStatusForTests(async () => { throw new ServerStoreApiError({ code: 'SERVER_COMPONENT_INCOMPATIBLE', message: 'bad version' }); });
    const state = await refreshStoreState();
    assert.equal(state.status, 'incompatible');
    assert.equal(state.serverInfo, null);
    assert.equal(state.lastError.code, 'SERVER_COMPONENT_INCOMPATIBLE');
  });

  it('maps unavailable/network errors to unavailable', async () => {
    setGetStoreStatusForTests(async () => { throw new ServerStoreApiError({ code: 'SERVER_COMPONENT_UNAVAILABLE', message: 'offline', retryable: true }); });
    const state = await refreshStoreState();
    assert.equal(state.status, 'unavailable');
    assert.equal(state.lastError.code, 'SERVER_COMPONENT_UNAVAILABLE');
  });

  it('coalesces concurrent refreshes into one status request', async () => {
    const pending = deferred();
    let calls = 0;
    setGetStoreStatusForTests(async () => { calls += 1; return pending.promise; });

    const first = refreshStoreState();
    const second = refreshStoreState();
    assert.equal(first, second, 'same in-flight promise');
    assert.equal(calls, 1);

    pending.resolve({ schemaVersion: 1, state: 'ready' });
    const state = await first;
    assert.equal(state.status, 'available');
    assert.equal(calls, 1);
  });

  it('uses unavailable when a malformed status rejects inside the facade', async () => {
    setGetStoreStatusForTests(async () => { throw new Error('unexpected'); });
    const state = await refreshStoreState();
    assert.equal(state.status, 'unavailable');
    assert.equal(state.lastError.message, 'unexpected');
  });
});
