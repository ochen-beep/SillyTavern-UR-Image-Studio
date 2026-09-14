// @ts-check
/**
 * Image-generation parameter presets.
 *
 * Persisted in ONE server file per user, `data/<user>/user/files/uris_presets.json`,
 * not in `extensionSettings` — they are user-authored data, and the settings blob
 * is re-POSTed wholesale on every unrelated settings change. See `src/file-store.js`
 * and `docs/plans/2026-09-12-storage-externalization.md`.
 */
import {
    getCtx, getImageConnectionSettings, IMAGE_CONNECTION_SETTINGS_KEY,
    VALID_ASPECT_RATIOS, VALID_IMAGE_SIZES, uid, log, saveSettings,
} from './core.js';
import { createFileStore } from './file-store.js';
import { recordDiagnosticEvent } from './diagnostic-events.js';

export const PRESETS_FILE_NAME = 'uris_presets.json';
export const PRESETS_STORE_VERSION = 1;

/** Shared image-connections settings object — the legacy preset store. */
function imageSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings) ctx.extensionSettings = {};
    if (!ctx.extensionSettings.ur_image_studio || typeof ctx.extensionSettings.ur_image_studio !== 'object') {
        ctx.extensionSettings.ur_image_studio = {};
    }
    const settings = ctx.extensionSettings.ur_image_studio;
    if (!settings[IMAGE_CONNECTION_SETTINGS_KEY] || typeof settings[IMAGE_CONNECTION_SETTINGS_KEY] !== 'object') {
        settings[IMAGE_CONNECTION_SETTINGS_KEY] = getImageConnectionSettings({});
    }
    return settings[IMAGE_CONNECTION_SETTINGS_KEY];
}

const presetsStore = createFileStore({
    label: 'param-presets',
    name: PRESETS_FILE_NAME,
    version: PRESETS_STORE_VERSION,
    key: 'presets',
    empty: () => [],
    legacyRead: () => imageSettings().presets,
    legacyWrite: value => {
        imageSettings().presets = value;
        saveSettings();
    },
    legacyStrip: () => {
        const current = imageSettings().presets;
        const freedBytes = Array.isArray(current) ? JSON.stringify(current).length : 0;
        delete imageSettings().presets;
        saveSettings();
        return freedBytes;
    },
    stripLegacyOnLoad: true,
    countEntries: value => (Array.isArray(value) ? value.length : null),
});

/** Resolve the preset store (probe / load / migrate) exactly once per session. */
export function ensureParamPresetStoreReady() {
    return presetsStore.ready();
}

export function paramPresetStoreMode() { return presetsStore.mode(); }

/** Await durability of queued preset writes. */
export function flushParamPresetWrites() {
    return presetsStore.flush();
}

export function flushParamPresetWritesOnUnload() {
    presetsStore.flushOnUnload();
}

/**
 * Live presets for the backup exporter. Null in legacy mode, where the settings
 * copy already carries them and the exporter reads it directly.
 */
export async function getParamPresetsForExport() {
    if (await presetsStore.ready() !== 'file') return null;
    return presetsStore.snapshot();
}

/**
 * Backup import / rollback: replace the whole preset set with the restored
 * records and await durability. No-op in legacy mode. Returns whether the file
 * store accepted the records.
 */
export async function replaceParamPresetRecords(records) {
    if (await presetsStore.ready() !== 'file') return false;
    await presetsStore.replace(Array.isArray(records) ? records : []);
    return true;
}

let testStore = null;

function store() {
    if (testStore) return testStore;
    return {
        list: async () => {
            await presetsStore.ready();
            return presetsStore.snapshot() ?? [];
        },
        create: async payload => presetsStore.mutate(records => {
            records.push(payload);
            return payload;
        }),
        update: async (id, payload) => presetsStore.mutate(records => {
            const index = records.findIndex(record => record.id === id);
            if (index === -1) return null;
            records[index] = payload;
            return payload;
        }),
        delete: async id => presetsStore.mutate(records => {
            const index = records.findIndex(record => record.id === id);
            if (index !== -1) records.splice(index, 1);
        }),
    };
}

export function setParamPresetStoreForTests(value) { testStore = value; }
export function resetParamPresetStoreForTests() {
    testStore = null;
    presetsStore.reset();
}

const DEFAULT_IMAGE_PARAM = Object.freeze({
    name: 'Новый параметр картинки', size: '1024x1024', quality: 'standard',
    aspectRatio: '1:1', imageSize: '1K', styleTemplate: '',
});

export function normalizeImageParam(data = {}) {
    const item = { id: data.id ? String(data.id) : uid(), ...structuredClone(DEFAULT_IMAGE_PARAM), ...data };
    if (!VALID_ASPECT_RATIOS.includes(item.aspectRatio)) item.aspectRatio = '1:1';
    if (!VALID_IMAGE_SIZES.includes(item.imageSize)) item.imageSize = '1K';
    return item;
}

export async function listImageParams() {
    const records = await store().list();
    return Array.isArray(records) ? records.map(normalizeImageParam) : [];
}

export async function createImageParam(data = {}) {
    const item = normalizeImageParam(data);
    const persisted = normalizeImageParam(await store().create(item));
    recordDiagnosticEvent({ event: 'preset-crud', stage: 'presets', operation: 'create', details: { id: persisted.id } });
    log('Создан image param-пресет', persisted.id);
    return persisted;
}

export async function getImageParam(id) {
    return (await listImageParams()).find(item => item.id === id) || null;
}

export async function saveImageParam(patch) {
    if (!patch?.id) return null;
    const current = await getImageParam(patch.id);
    if (!current) return null;
    const persisted = await store().update(patch.id, normalizeImageParam({ ...current, ...patch, id: patch.id }));
    if (persisted) recordDiagnosticEvent({ event: 'preset-crud', stage: 'presets', operation: 'update', details: { id: patch.id } });
    return persisted ? normalizeImageParam(persisted) : null;
}

export async function deleteImageParam(id) {
    await store().delete(id);
    recordDiagnosticEvent({ event: 'preset-crud', stage: 'presets', operation: 'delete', details: { id } });
    log('Удалён image param-пресет', id);
}
