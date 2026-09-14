// @ts-check
/**
 * Observable availability state for the server-authoritative collection store.
 *
 * Mirrors `server-connection-state.js`, but probes `/store/status` through the
 * store facade. Collection migration and store-backed UI paths gate on
 * `status === 'available'`; an older server plugin can still provide image
 * connections while lacking the durable-store feature.
 */

import { getStoreStatus } from './server-store-api.js';

const initialState = () => Object.freeze({
  status: 'unknown',
  serverInfo: null,
  lastError: null,
});

let currentState = initialState();
let inFlightRefresh = null;
const subscribers = new Set();
let getStatus = getStoreStatus;

export function getStoreState() {
  return currentState;
}

export function subscribeStoreState(subscriber) {
  subscribers.add(subscriber);
  subscriber(currentState);
  return () => subscribers.delete(subscriber);
}

function publish(nextState) {
  currentState = Object.freeze(nextState);
  for (const subscriber of subscribers) {
    try { subscriber(currentState); } catch {}
  }
  return currentState;
}

export function refreshStoreState() {
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = getStatus()
    .then(serverInfo => publish({
      status: 'available',
      serverInfo,
      lastError: null,
    }))
    .catch(lastError => publish({
      status: lastError?.code === 'SERVER_COMPONENT_INCOMPATIBLE' ? 'incompatible' : 'unavailable',
      serverInfo: null,
      lastError,
    }))
    .finally(() => { inFlightRefresh = null; });

  return inFlightRefresh;
}

/** Test seam: inject status fetcher without replacing globals. */
export function setGetStoreStatusForTests(fn) {
  getStatus = fn ?? getStoreStatus;
}

/** Test seam: clear observable state/subscribers' in-flight work. */
export function resetStoreStateForTests() {
  currentState = initialState();
  inFlightRefresh = null;
  subscribers.clear();
}
