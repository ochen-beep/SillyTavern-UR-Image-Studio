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
 */

import { createFileStore } from './file-store.js';

export const TEMPLATE_FILE_NAME = 'uris_templates.json';
export const TEMPLATE_STORE_VERSION = 1;

const store = createFileStore({
    label: 'templates',
    name: TEMPLATE_FILE_NAME,
    version: TEMPLATE_STORE_VERSION,
    key: 'templates',
    empty: () => [],
});

/** Resolve the store mode (and perform load/migration) exactly once per session. */
export function ensureTemplateStoreReady() {
    return store.ready();
}

/** Test seam: which backend the store resolved to ('file' | 'readonly' | 'unknown'). */
export function templateStoreMode() { return store.mode(); }

/** Await all queued template file writes (import paths and tests). */
export function flushTemplateWrites() {
    return store.flush();
}

// Универсальный unload-флаш — flushAllFileStoresOnUnload() из file-store.js:
// стор регистрируется в общем реестре при создании (createFileStore).

// ── Readonly/unknown mode ──
//
// mode 'readonly'/'unknown' (сервер недоступен / файл повреждён) вместо мутаций
// возвращает null/undefined: вызывающий код читает прежние данные из settings.

/** Raw records from the mirror, cloned. Returns null unless the store is in file mode. */
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
 * Returns false unless the store is in file mode (readonly/unknown: the caller
 * keeps the settings copy untouched).
 */
export async function replaceTemplateRecords(records) {
    if (await store.ready() !== 'file') return false;
    await store.replace(Array.isArray(records) ? records : []);
    return true;
}

// ── Test-only surface ──

export function resetTemplateFileStoreForTests() {
    store.reset();
}
