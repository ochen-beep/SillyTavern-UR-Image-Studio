// @ts-check
/**
 * Prompt-template persistence: ONE JSON file per user on the SillyTavern server,
 * `data/<user>/user/files/uris_templates.json`, through the official user-files
 * surface (the same routes ST itself uses for chat attachments).
 *
 * Why not extensionSettings: ST's `saveSettingsDebounced` fires ~1s after a
 * mutation and POSTs the WHOLE settings.json (no merge, no lock — last writer
 * wins). A template edit within ~1.4s of tab close/reload is silently lost, and
 * any other tab or extension saving settings can clobber it. Extensions cannot
 * fix this from inside the settings blob: the full settings object is not
 * exposed, so a real flush-on-unload is impossible.
 *
 * The probe / mirror / serialized-write / keepalive-flush machinery now lives in
 * `src/file-store.js`, shared with the gallery, the reference pool and presets.
 * This module is the template-shaped wrapper around it; see that file for the
 * contract and the rationale.
 *
 * Unlike the large stores, templates deliberately KEEP the settings copy
 * (`stripLegacyOnLoad: false`) as a downgrade/backup fallback — they are a few
 * kilobytes, so keeping a copy costs nothing and an older extension version can
 * still read them.
 *
 * If the user-files endpoints are unavailable (older ST), the module reports
 * mode 'legacy' and `prompt-templates.js` keeps using its settings-backed store.
 */

import { IMAGE_CONNECTION_SETTINGS_KEY, getCtx, getImageConnectionSettings } from './core.js';
import { createFileStore } from './file-store.js';

export const TEMPLATE_FILE_NAME = 'uris_templates.json';
export const TEMPLATE_STORE_VERSION = 1;

/** Legacy migration source: the templates array inside the module settings. */
function legacyTemplatesInSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings) ctx.extensionSettings = {};
    if (!ctx.extensionSettings.ur_image_studio || typeof ctx.extensionSettings.ur_image_studio !== 'object') {
        ctx.extensionSettings.ur_image_studio = {};
    }
    const settings = ctx.extensionSettings.ur_image_studio;
    if (!settings[IMAGE_CONNECTION_SETTINGS_KEY] || typeof settings[IMAGE_CONNECTION_SETTINGS_KEY] !== 'object') {
        settings[IMAGE_CONNECTION_SETTINGS_KEY] = getImageConnectionSettings({});
    }
    if (!Array.isArray(settings[IMAGE_CONNECTION_SETTINGS_KEY].templates)) {
        settings[IMAGE_CONNECTION_SETTINGS_KEY].templates = [];
    }
    return settings[IMAGE_CONNECTION_SETTINGS_KEY].templates;
}

const store = createFileStore({
    label: 'templates',
    name: TEMPLATE_FILE_NAME,
    version: TEMPLATE_STORE_VERSION,
    key: 'templates',
    empty: () => [],
    legacyRead: () => legacyTemplatesInSettings(),
    stripLegacyOnLoad: false,
});

/** Resolve the store mode (and perform load/migration) exactly once per session. */
export function ensureTemplateStoreReady() {
    return store.ready();
}

export function templateStoreMode() { return store.mode(); }

/** Await all queued template file writes (import paths and tests). */
export function flushTemplateWrites() {
    return store.flush();
}

/**
 * Last-chance durability on page unload: re-send the newest not-yet-confirmed
 * payload with `fetch keepalive` so the request may outlive the page. A no-op
 * when every write already landed.
 */
export function flushTemplateWritesOnUnload() {
    store.flushOnUnload();
}

// ── Mirror CRUD (file mode only) ──
//
// Legacy mode returns null/undefined instead of mutating: `prompt-templates.js`
// owns its own settings-backed store there, and writing through this module as
// well would double-persist the same records.

/** Raw records from the mirror, cloned. Returns null in legacy mode. */
export async function listTemplateRecords() {
    if (await store.ready() !== 'file') return null;
    return store.snapshot();
}

/**
 * Apply a synchronous mutator to the mirror and schedule the file upload.
 * The mutator's return value is passed through as the operation result.
 */
export async function applyTemplateMutation(mutator) {
    if (await store.ready() !== 'file') return undefined;
    return store.mutate(mutator);
}

/**
 * Replace the whole record set (backup import / rollback) and await durability.
 * Returns false when the session runs in legacy mode (settings already carry them).
 */
export async function replaceTemplateRecords(records) {
    if (await store.ready() !== 'file') return false;
    await store.replace(Array.isArray(records) ? records : []);
    return true;
}

/**
 * Fresh records for export paths. Null in legacy mode — the caller then keeps
 * reading templates from settings, as before.
 */
export async function getTemplateRecordsSnapshot() {
    if (await store.ready() !== 'file') return null;
    return store.snapshot();
}

// ── Test-only surface ──

export function resetTemplateFileStoreForTests() {
    store.reset();
}
