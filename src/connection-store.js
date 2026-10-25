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

/**
 * Ручной порядок после drag & drop в списке коннектов: переставляет
 * browser-owned записи по orderedIds и persist'ит. Серверные записи
 * (executionOwner=server) остаются на своих местах перед ними.
 * @param {string[]} orderedIds полный список id в новом порядке
 * @returns {Promise<Array>} актуальный список
 */
export async function reorderConnections(orderedIds) {
    const connections = currentConnections();
    const byId = new Map(connections.map(connection => [connection.id, connection]));
    const next = orderedIds.map(id => byId.get(id)).filter(Boolean);
    if (next.length !== connections.length) return currentConnections();
    return persist(next);
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
    // The browser-local key is keyed by connection id and is deliberately NOT
    // fingerprint-bound to endpoint/provider/dialect: re-editing metadata after
    // a failed generation (endpoint typo fix, references-panel dialect pin)
    // must never silently erase it. The key leaves storage only through an
    // explicit user action: deleteConnection, or saving an empty Key field.
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

function keyMetaNamespace(id) {
    return `${getImageConnectionKeyNamespace(id)}:meta`;
}

function localforage() {
    return SillyTavern?.libs?.localforage;
}

export async function setConnectionApiKey(id, value) {
    const key = String(value || '').trim();
    const store = localforage();
    if (!store) return;
    if (key) {
        await store.setItem(getImageConnectionKeyNamespace(id), key);
    } else {
        await store.removeItem(getImageConnectionKeyNamespace(id));
    }
    // Legacy cleanup: the retired fingerprint guard stored connection metadata
    // beside the key; it is no longer read anywhere, so drop it on the next
    // key write/clear instead of leaving stale records in localforage.
    await store.removeItem(keyMetaNamespace(id));
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
