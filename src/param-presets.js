// @ts-check
/** Image-generation parameter presets persisted in shared extension settings. */
import {
    getCtx, getImageConnectionSettings, IMAGE_CONNECTION_SETTINGS_KEY,
    VALID_ASPECT_RATIOS, VALID_IMAGE_SIZES, uid, log, saveSettings,
} from './core.js';

let testStore = null;

function sharedPresets() {
    const ctx = getCtx();
    if (!ctx.extensionSettings) ctx.extensionSettings = {};
    if (!ctx.extensionSettings.ur_image_studio || typeof ctx.extensionSettings.ur_image_studio !== 'object') {
        ctx.extensionSettings.ur_image_studio = {};
    }
    const settings = ctx.extensionSettings.ur_image_studio;
    if (!settings[IMAGE_CONNECTION_SETTINGS_KEY] || typeof settings[IMAGE_CONNECTION_SETTINGS_KEY] !== 'object') {
        settings[IMAGE_CONNECTION_SETTINGS_KEY] = getImageConnectionSettings({});
    }
    if (!Array.isArray(settings[IMAGE_CONNECTION_SETTINGS_KEY].presets)) {
        settings[IMAGE_CONNECTION_SETTINGS_KEY].presets = [];
    }
    return settings[IMAGE_CONNECTION_SETTINGS_KEY].presets;
}

function store() {
    if (testStore) return testStore;
    return {
        list: async () => sharedPresets(),
        create: async payload => {
            sharedPresets().push(payload);
            saveSettings();
            return payload;
        },
        update: async (id, payload) => {
            const records = sharedPresets();
            const index = records.findIndex(record => record.id === id);
            if (index === -1) return null;
            records[index] = payload;
            saveSettings();
            return payload;
        },
        delete: async id => {
            const records = sharedPresets();
            const index = records.findIndex(record => record.id === id);
            if (index !== -1) {
                records.splice(index, 1);
                saveSettings();
            }
        },
    };
}

export function setParamPresetStoreForTests(value) { testStore = value; }
export function resetParamPresetStoreForTests() { testStore = null; }

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
    return persisted ? normalizeImageParam(persisted) : null;
}

export async function deleteImageParam(id) {
    await store().delete(id);
    log('Удалён image param-пресет', id);
}
