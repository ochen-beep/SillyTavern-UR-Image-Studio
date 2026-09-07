// @ts-check
/** Shared image connection metadata and browser-local API keys. */
import {
    IMAGE_CONNECTION_SETTINGS_KEY,
    MODULE_NAME,
    getImageConnectionKeyNamespace,
    getImageConnectionSettings,
    getCtx,
    saveSettings,
    uid,
} from './core.js';
import { normalizeConnectionRecord, stripSecrets } from './image-connection-schema.js';

function moduleSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings) ctx.extensionSettings = {};
    if (!ctx.extensionSettings[MODULE_NAME] || typeof ctx.extensionSettings[MODULE_NAME] !== 'object') {
        ctx.extensionSettings[MODULE_NAME] = {};
    }
    return ctx.extensionSettings[MODULE_NAME];
}

function settings() {
    const shared = moduleSettings();
    if (!shared[IMAGE_CONNECTION_SETTINGS_KEY] || typeof shared[IMAGE_CONNECTION_SETTINGS_KEY] !== 'object') {
        shared[IMAGE_CONNECTION_SETTINGS_KEY] = getImageConnectionSettings({});
    }
    return shared[IMAGE_CONNECTION_SETTINGS_KEY];
}

function normalize(value) {
    return normalizeConnectionRecord(stripSecrets(value));
}

function isBrowserOwnedConnection(value) {
    const input = value && typeof value === 'object' ? value : {};
    return input.executionOwner !== 'server'
        && input.serverOwned !== true
        && input.legacyServer !== true
        && input.kind !== 'server-image';
}

function storedConnections() {
    const values = settings().connections;
    return Array.isArray(values) ? values : [];
}

function currentConnections() {
    return storedConnections().filter(isBrowserOwnedConnection).map(normalize);
}

function persist(connections) {
    const serverRecords = storedConnections().filter(connection => !isBrowserOwnedConnection(connection));
    settings().connections = [...serverRecords, ...connections.map(normalize)];
    saveSettings();
    return currentConnections();
}

export async function listConnections() {
    return currentConnections();
}

export async function getConnection(id) {
    return currentConnections().find(connection => connection.id === id) || null;
}

export async function createConnection(data = {}) {
    const input = { ...data, id: typeof data.id === 'string' && data.id ? data.id : uid() };
    const connection = normalize(input);
    const connections = currentConnections();
    const index = connections.findIndex(item => item.id === connection.id);
    if (index === -1) connections.push(connection);
    else connections[index] = connection;
    persist(connections);
    return connection;
}

export async function updateConnection(id, patch = {}) {
    if (!id) return null;
    const connections = currentConnections();
    const index = connections.findIndex(connection => connection.id === id);
    if (index === -1) return null;
    const previous = connections[index];
    const connection = normalize({ ...previous, ...patch, id });
    connections[index] = connection;
    persist(connections);
    if (connectionFingerprint(previous) !== connectionFingerprint(connection)) {
        await clearConnectionApiKey(id);
    }
    return connection;
}

export async function deleteConnection(id) {
    const connections = currentConnections();
    const next = connections.filter(connection => connection.id !== id);
    if (next.length === connections.length) return false;
    await clearConnectionApiKey(id);
    persist(next);
    return true;
}

function connectionFingerprint(connection) {
    return JSON.stringify({
        endpoint: String(connection?.endpoint || '').trim().replace(/\/+$/, '').toLowerCase(),
        provider: connection?.provider || connection?.apiFamily || null,
    });
}

function peekConnection(id) {
    const raw = globalThis.SillyTavern?.getContext?.()?.extensionSettings?.[MODULE_NAME]?.[IMAGE_CONNECTION_SETTINGS_KEY]?.connections;
    if (!Array.isArray(raw)) return null;
    return raw.find(connection => connection?.id === id) || null;
}
function keyMetaNamespace(id) {
    return `${getImageConnectionKeyNamespace(id)}:meta`;
}

function localforage() {
    return SillyTavern?.libs?.localforage;
}

export async function setConnectionApiKey(id, value) {
    const connection = peekConnection(id);
    const key = String(value || '').trim();
    const store = localforage();
    if (!store) return;
    if (key) {
        await store.setItem(getImageConnectionKeyNamespace(id), key);
        await store.setItem(keyMetaNamespace(id), connectionFingerprint(connection));
    } else {
        await store.removeItem(getImageConnectionKeyNamespace(id));
        await store.removeItem(keyMetaNamespace(id));
    }
}

export async function getConnectionApiKey(id) {
    const store = localforage();
    if (!store) return '';
    return String((await store.getItem(getImageConnectionKeyNamespace(id))) || '').trim();
}

export async function clearConnectionApiKey(id) {
    const store = localforage();
    if (!store) return;
    await store.removeItem(getImageConnectionKeyNamespace(id));
    await store.removeItem(keyMetaNamespace(id));
}
