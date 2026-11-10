// @ts-check
/**
 * Protected user-files storage (`user/files/`) + the Data Maid shield.
 *
 * ST 1.19's Data Maid scans user/files (flat) and lists every file not
 * referenced from chat messages as an orphan — including all `uris_*` store
 * files. The only settings-based protection hook is
 * `extension_settings.character_attachments` (verified live 2026-11-06: a
 * registered `user/files/...` URL disappears from the Data Maid report;
 * src/endpoints/data-maid.js #collectFiles reads it, #collectImages does not).
 * The pseudo-character key below is never rendered by the attachments UI
 * (its readers key off the CURRENT character's avatar — public/script.js
 * chats.js), so entries are invisible yet keep Data Maid away.
 *
 * Every URIS-owned file in user/files is registered here on upload and
 * unregistered when URIS itself deletes the file. Files deleted by anything
 * else leave a stale entry that only this registry's own readers ever see.
 */
import { getCtx, saveSettings } from './core.js';
import { canonicalizeUserFilePath, canonicalizeNativeImagePath, canonicalizeStoredPath } from './native-image-path.js';

const PROTECTED_KEY = 'URIS Storage';

function attachmentsMap() {
    const ctx = getCtx();
    if (!ctx?.extensionSettings) return null;
    if (typeof ctx.extensionSettings.character_attachments !== 'object' || ctx.extensionSettings.character_attachments === null) {
        ctx.extensionSettings.character_attachments = {};
    }
    return ctx.extensionSettings.character_attachments;
}

/** @returns {Array<{name:string, url:string}>} registered URIS-owned files */
export function listProtectedUserFiles() {
    const map = attachmentsMap();
    const list = map?.[PROTECTED_KEY];
    return Array.isArray(list) ? list.filter(e => typeof e?.url === 'string') : [];
}

/** Persist a registry mutation without letting a settings-write failure break the caller. */
function persistRegistry() {
    try { saveSettings(); } catch { /* in-memory until the next successful save */ }
}

/** Register a user/files URL as URIS-owned so Data Maid treats it as known. */
export function protectUserFile(url) {
    const canonical = canonicalizeUserFilePath(url);
    if (!canonical) return false;
    const map = attachmentsMap();
    if (!map) return false;
    const list = Array.isArray(map[PROTECTED_KEY]) ? map[PROTECTED_KEY] : (map[PROTECTED_KEY] = []);
    if (!list.some(e => e?.url === canonical)) {
        list.push({ name: canonical.split('/').pop(), url: canonical });
        persistRegistry();
    }
    return true;
}

/**
 * Register any URIS-owned server file by path shape: user/files (store
 * documents, binaries) or user/images (gallery images, thumbnails under their
 * legacy folders). Same registry as protectUserFile — the maid's file scan
 * reads it natively, the images scan after the local/upstream consistency
 * patch mirrors the same block into #collectImages.
 * @param {string} path
 * @returns {boolean} false for foreign/broken shapes
 */
export function protectStoredFile(path) {
    const canonical = canonicalizeStoredPath(path);
    if (!canonical) return false;
    const map = attachmentsMap();
    if (!map) return false;
    const list = Array.isArray(map[PROTECTED_KEY]) ? map[PROTECTED_KEY] : (map[PROTECTED_KEY] = []);
    if (!list.some(e => e?.url === canonical)) {
        list.push({ name: canonical.split('/').pop(), url: canonical });
        persistRegistry();
    }
    return true;
}

/** Drop a URL from the registry (URIS deletes the file itself). */
export function unprotectUserFile(url) {
    const canonical = canonicalizeUserFilePath(url);
    if (!canonical) return false;
    const map = attachmentsMap();
    const list = Array.isArray(map?.[PROTECTED_KEY]) ? map[PROTECTED_KEY] : null;
    if (!list) return false;
    const next = list.filter(e => e?.url !== canonical);
    if (next.length === list.length) return false;
    map[PROTECTED_KEY] = next;
    persistRegistry();
    return true;
}

/** Remove the whole registry key (uninstall/clean hook — nothing is owned anymore). */
export function clearProtectedRegistry() {
    const map = attachmentsMap();
    if (!map || !Array.isArray(map[PROTECTED_KEY])) return false;
    delete map[PROTECTED_KEY];
    persistRegistry();
    return true;
}

/**
 * Reconcile the registry with the list of files URIS owns: register names that
 * are missing. Idempotent, network-free; covers files written before the
 * registry existed and entries wiped by a manual settings edit.
 * @param {string[]} names file names inside user/files (bare, no folder)
 * @returns {number} how many entries were added
 */
export function syncProtectedRegistry(names) {
    const map = attachmentsMap();
    if (!map || !Array.isArray(names)) return 0;
    const known = new Set(listProtectedUserFiles().map(e => e.url));
    let added = 0;
    for (const name of names) {
        if (typeof name !== 'string' || !name) continue;
        const url = `user/files/${name}`;
        if (known.has(url)) continue;
        known.add(url);
        protectUserFile(url);
        added++;
    }
    return added;
}

/**
 * Upload base64 bytes to `user/files/<name>` and register the file in the
 * protected registry. user/files is flat — the caller owns the name prefix
 * (uris_ref_/uris_thumb_/...). Returns the canonical stored path.
 */
export async function uploadNamedUserFile(name, base64, deps = {}) {
    const ctx = getCtx();
    const doFetch = deps.fetch || globalThis.fetch;
    const response = await doFetch('/api/files/upload', {
        method: 'POST',
        headers: { ...(ctx?.getRequestHeaders?.() ?? {}), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, data: base64 }),
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    if (!response?.ok) {
        const e = await response?.json?.().catch(() => ({})) || {};
        throw new Error(e?.error || `User file upload failed: ${response?.status}`);
    }
    const path = canonicalizeUserFilePath(`user/files/${name}`);
    if (!path) throw new Error(`Unusable user file name: ${name}`);
    protectUserFile(path);
    return path;
}

/**
 * Delete a stored server file, routing by path shape: user/files →
 * /api/files/delete, user/images → /api/images/delete. Registered files are
 * unregistered afterwards. A 404 counts as success (already in target state).
 * @returns {Promise<boolean>}
 */
export async function deleteStoredServerFile(path, deps = {}) {
    const filePath = canonicalizeUserFilePath(path);
    const imagePath = filePath ? null : canonicalizeNativeImagePath(path);
    if (!filePath && !imagePath) return false;
    const ctx = getCtx();
    const doFetch = deps.fetch || globalThis.fetch;
    try {
        const response = await doFetch(filePath ? '/api/files/delete' : '/api/images/delete', {
            method: 'POST',
            headers: { ...(ctx?.getRequestHeaders?.() ?? {}), 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath || imagePath }),
            ...(deps.signal ? { signal: deps.signal } : {}),
        });
        if (response.ok || response.status === 404) {
            // Both shapes lift protection: a stale entry pointing at a deleted
            // file would otherwise accumulate forever in the registry.
            unprotectStoredFile(filePath || imagePath);
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

/** Drop any registered URIS-owned path (either shape) from the registry. */
export function unprotectStoredFile(path) {
    const canonical = canonicalizeStoredPath(path);
    if (!canonical) return false;
    const map = attachmentsMap();
    const list = Array.isArray(map?.[PROTECTED_KEY]) ? map[PROTECTED_KEY] : null;
    if (!list) return false;
    const next = list.filter(e => e?.url !== canonical);
    if (next.length === list.length) return false;
    map[PROTECTED_KEY] = next;
    persistRegistry();
    return true;
}
