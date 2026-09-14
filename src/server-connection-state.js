import { getServerImageApiStatus } from './server-image-api.js';

let currentState = Object.freeze({
    status: 'unknown',
    serverInfo: null,
    lastError: null,
});
let inFlightRefresh = null;
const subscribers = new Set();

export function getServerConnectionState() {
    return currentState;
}

export function subscribeServerConnectionState(subscriber) {
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

export function refreshServerConnectionState() {
    if (inFlightRefresh) return inFlightRefresh;

    inFlightRefresh = getServerImageApiStatus()
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
