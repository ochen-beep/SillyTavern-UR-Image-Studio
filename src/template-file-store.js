// @ts-check
/**
 * Prompt-template persistence on the SillyTavern server: ONE JSON file per user,
 * `data/<user>/user/files/uris_templates.json`, read/written through the official
 * user-files surface (the same routes ST itself uses for chat attachments):
 *   POST /api/files/upload  { name, data: base64 }  → atomic write (write-file-atomic)
 *   GET  /user/files/<name>                          → static read
 *
 * Why not extensionSettings: ST's `saveSettingsDebounced` fires ~1s after a mutation
 * and POSTs the WHOLE settings.json (no merge, no lock — last writer wins). A template
 * edit within ~1.4s of tab close/reload is silently lost, and any other tab saving
 * settings can clobber it. Extensions cannot fix this from inside the settings blob:
 * the full settings object is not exposed, so a real flush-on-unload is impossible.
 * This store gives templates their own small atomic file instead:
 *   - every mutation schedules an immediate full-file upload through a serialized
 *     promise chain (one mutation → one durable write, in order);
 *   - `flushTemplateWritesOnUnload()` re-sends the newest payload with `fetch keepalive`
 *     from pagehide/visibilitychange so the browser may complete it after teardown;
 *   - write failures raise a (deduped) toastr error instead of vanishing.
 *
 * First load with no server file migrates the legacy `extensionSettings` copy; the
 * settings copy is kept as a fallback for downgrade/backup paths. If the user-files
 * endpoints are unavailable (older ST), the module reports mode 'legacy' and callers
 * keep using the settings-based store.
 */

import { getCtx, getImageConnectionSettings, IMAGE_CONNECTION_SETTINGS_KEY, log, warn } from './core.js';

export const TEMPLATE_FILE_NAME = 'uris_templates.json';
export const TEMPLATE_STORE_VERSION = 1;

/** Below this body size a keepalive unload flush is attempted (fetch keepalive cap ≈64KB). */
const KEEPALIVE_BODY_LIMIT = 60 * 1024;
const FAILURE_TOAST_INTERVAL = 5000;

let mode = 'unknown';          // 'unknown' | 'file' | 'legacy'
let readyPromise = null;       // memoized probe + load/migrate
let mirror = null;             // array of raw template records (source of truth in file mode)
let writeChain = Promise.resolve();
let pendingUnloadPayload = null; // { name, data } of the newest not-yet-confirmed write
let lastFailureToastAt = 0;

function stHeaders() {
    const h = getCtx()?.getRequestHeaders?.();
    return { ...(h && typeof h === 'object' ? h : {}), 'Content-Type': 'application/json' };
}

/** UTF-8-safe base64 (template instructions are user text, not Latin1). */
function textToBase64(text) {
    const bytes = new TextEncoder().encode(String(text));
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

function clone(value) {
    if (value === null || value === undefined) return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

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

function notifyStoreFailure(cause) {
    warn('template-file-store: upload failed:', cause?.message || cause);
    const now = Date.now();
    if (now - lastFailureToastAt < FAILURE_TOAST_INTERVAL) return;
    lastFailureToastAt = now;
    try {
        const toastr = globalThis.toastr;
        if (toastr?.error) toastr.error('Не удалось сохранить шаблоны на сервер.');
    } catch { /* no toastr in tests */ }
}

async function uploadTemplateFile(name, base64Data) {
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: stHeaders(),
        body: JSON.stringify({ name, data: base64Data }),
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text().catch(() => '')}`);
}

async function readTemplateFile() {
    const res = await fetch(`/user/files/${encodeURIComponent(TEMPLATE_FILE_NAME)}`, {
        method: 'GET',
        cache: 'no-store',
    });
    if (res.status === 404) return null; // no file yet = nothing migrated
    if (!res.ok) throw new Error(`read failed: ${res.status}`);
    const text = await res.text();
    return text || null;
}

function parseTemplateDoc(text) {
    let doc;
    try { doc = JSON.parse(text); } catch { return null; }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.templates)) return null;
    if (doc.v !== TEMPLATE_STORE_VERSION) return null;
    return doc.templates;
}

/**
 * Detect the user-files surface and load (or migrate into) the server file.
 * Any probe failure downgrades the session to 'legacy' (settings-based store).
 */
async function detectAndLoad() {
    let probe;
    try {
        probe = await fetch('/api/files/verify', {
            method: 'POST',
            headers: stHeaders(),
            body: JSON.stringify({ urls: [] }),
        });
    } catch (cause) {
        warn('template-file-store: user-files endpoint unavailable, using settings store:', cause?.message || cause);
        mode = 'legacy';
        return mode;
    }
    if (!probe.ok) {
        mode = 'legacy';
        return mode;
    }

    let text = null;
    try {
        text = await readTemplateFile();
    } catch (cause) {
        warn('template-file-store: read failed, falling back to settings copy:', cause?.message || cause);
    }

    mode = 'file'; // set before migration so the initial persist is not skipped

    const parsed = text ? parseTemplateDoc(text) : null;
    if (parsed) {
        mirror = parsed;
    } else {
        if (text) warn('template-file-store: file unreadable/corrupt, re-migrating from settings copy');
        mirror = clone(legacyTemplatesInSettings()) || [];
        if (mirror.length) schedulePersist();
    }
    return mode;
}

/** Resolve the store mode (and perform load/migration) exactly once per session. */
export function ensureTemplateStoreReady() {
    if (!readyPromise) readyPromise = detectAndLoad();
    return readyPromise;
}

export function templateStoreMode() { return mode; }

// ── Persistence ──

function schedulePersist() {
    if (mode !== 'file' || mirror === null) return Promise.resolve(false);
    const doc = { v: TEMPLATE_STORE_VERSION, templates: clone(mirror) };
    const json = JSON.stringify(doc);
    pendingUnloadPayload = { name: TEMPLATE_FILE_NAME, data: textToBase64(json) };
    const job = writeChain
        .then(() => uploadTemplateFile(pendingUnloadPayload.name, pendingUnloadPayload.data))
        .then(() => {
            if (pendingUnloadPayload?.name === TEMPLATE_FILE_NAME) pendingUnloadPayload = null;
            log('template-file-store: wrote', TEMPLATE_FILE_NAME, `(${doc.templates.length} templates)`);
            return true;
        })
        .catch(cause => {
            notifyStoreFailure(cause);
            return false; // payload stays pending so the unload flush can retry it
        });
    writeChain = job;
    return job;
}

/** Await all queued template file writes (import paths and tests). */
export function flushTemplateWrites() {
    return writeChain;
}

/**
 * Last-chance durability on page unload: re-send the newest not-yet-confirmed
 * payload with fetch keepalive so the request may outlive the page. A no-op when
 * every write already landed. The upload is a full-file atomic write, so this
 * extra attempt is idempotent.
 */
export function flushTemplateWritesOnUnload() {
    if (mode !== 'file' || !pendingUnloadPayload) return;
    const payload = pendingUnloadPayload;
    if (payload.data.length > KEEPALIVE_BODY_LIMIT) {
        warn('template-file-store: unload flush skipped, payload exceeds keepalive limit');
        return;
    }
    try {
        void fetch('/api/files/upload', {
            method: 'POST',
            headers: stHeaders(),
            body: JSON.stringify(payload),
            keepalive: true,
        });
    } catch { /* nothing else can be done during teardown */ }
}

// ── Mirror CRUD (file mode only) ──

/** Raw records from the mirror, cloned. Returns null in legacy mode. */
export async function listTemplateRecords() {
    if (await ensureTemplateStoreReady() !== 'file') return null;
    return mirror ? clone(mirror) : [];
}

/**
 * Apply a synchronous mutator to the mirror and schedule the file upload.
 * The mutator's return value is passed through as the operation result.
 */
export async function applyTemplateMutation(mutator) {
    if (await ensureTemplateStoreReady() !== 'file') return undefined;
    if (mirror === null) mirror = [];
    const result = mutator(mirror);
    await schedulePersist();
    return result;
}

/**
 * Replace the whole record set (backup import / rollback) and await durability.
 * Returns false when the session runs in legacy mode (settings already carry them).
 */
export async function replaceTemplateRecords(records) {
    if (await ensureTemplateStoreReady() !== 'file') return false;
    mirror = Array.isArray(records) ? clone(records) : [];
    await schedulePersist();
    return true;
}

/**
 * Fresh records for export paths. Null in legacy mode — the caller then keeps
 * reading templates from settings, as before.
 */
export async function getTemplateRecordsSnapshot() {
    if (await ensureTemplateStoreReady() !== 'file') return null;
    return mirror ? clone(mirror) : [];
}

// ── Test-only surface ──

export function resetTemplateFileStoreForTests() {
    mode = 'unknown';
    readyPromise = null;
    mirror = null;
    writeChain = Promise.resolve();
    pendingUnloadPayload = null;
    lastFailureToastAt = 0;
}
