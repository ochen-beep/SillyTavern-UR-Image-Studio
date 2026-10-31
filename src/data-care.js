// @ts-check
/**
 * Data care: the orphan-file sweep (Settings) and the removal hook's
 * (manifest `clean`) server-file inventory. Both touch only URIS-owned
 * surfaces: the URIS_Refs / URIS_Thumbs image folders and the uris_* user
 * files. Gallery images in character folders belong to ST's native gallery
 * and are deliberately never touched here.
 */
import { getCtx } from './core.js';
import { listNativeImages, THUMBNAIL_FOLDER } from './native-image-storage.js';
import { canonicalizeNativeImagePath } from './native-image-path.js';
import { listRefs } from './refs-library.js';
import { listCards } from './gallery-index.js';
import { listFileStores } from './file-store.js';

const REFS_FOLDER = 'URIS_Refs';

/** ST-relative paths that live records still point at. */
async function referencedPaths(deps) {
    const refs = deps.refs ? await deps.refs() : await listRefs();
    const cards = deps.cards ? await deps.cards() : await listCards({ reconcile: false });
    const used = new Set();
    for (const ref of refs) {
        for (const p of [ref.imagePath, ref.thumbPath]) {
            if (p) used.add(canonicalizeNativeImagePath(p) || p);
        }
    }
    for (const card of cards) {
        if (card.thumbPath) used.add(canonicalizeNativeImagePath(card.thumbPath) || card.thumbPath);
    }
    return used;
}

/**
 * Files in the URIS image folders that no live record points at. Report-only:
 * the caller renders the list and asks for a confirmation before deleting.
 * @param {{listFolder?:Function, refs?:Function, cards?:Function}} [deps] - injection for tests
 * @returns {Promise<string[]>} canonical paths, sorted
 */
export async function findOrphanRefFiles(deps = {}) {
    const listFolder = deps.listFolder || ((folder) => listNativeImages({ folder }));
    const used = await referencedPaths(deps);
    const [refFiles, thumbFiles] = await Promise.all([
        listFolder(REFS_FOLDER),
        listFolder(THUMBNAIL_FOLDER),
    ]);
    return [...new Set([...refFiles, ...thumbFiles])]
        .filter(path => !used.has(canonicalizeNativeImagePath(path) || path))
        .sort();
}

/**
 * Delete image files by ST-relative path. A 404 counts as success: the file
 * is already in the target state (gone). Returns how many deletes succeeded.
 */
export async function deleteOrphanFiles(paths, { signal } = {}) {
    const ctx = getCtx();
    let deleted = 0;
    for (const path of paths) {
        try {
            const res = await fetch('/api/images/delete', {
                method: 'POST',
                headers: { ...(ctx?.getRequestHeaders?.() ?? {}), 'Content-Type': 'application/json' },
                body: JSON.stringify({ path }),
                ...(signal ? { signal } : {}),
            });
            if (res.ok || res.status === 404) deleted++;
        } catch { /* one missed file must not stop the sweep */ }
    }
    return deleted;
}

async function deleteUserFile(name) {
    const ctx = getCtx();
    const res = await fetch('/api/files/delete', {
        method: 'POST',
        headers: { ...(ctx?.getRequestHeaders?.() ?? {}), 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: `files/${name}` }),
    });
    return res.ok;
}

/** Named stores plus the corrupt side files a repair may have parked. */
function ownedFileNames() {
    const names = [
        'uris_gallery.json', 'uris_gallery_manifest.json',
        'uris_refs.json', 'uris_refs_manifest.json', 'uris_refs_meta.json',
        'uris_presets.json', 'uris_templates.json', 'uris_studio.json',
    ];
    const out = [];
    for (const name of names) out.push(name, `${name}.corrupt`);
    return out;
}

/**
 * Remove every URIS user file: the named stores, the live stores' primary
 * files, and the shard files of the two known prefixes. Shards are allocated
 * sequentially from s0000, so the range walk stops after a run of 50 misses
 * instead of probing the full 10 000 the recovery scan allows.
 * @param {{deleteFile?:Function}} [deps] - injection for tests
 * @returns {Promise<number>} deleted count
 */
export async function deleteUserFiles(deps = {}) {
    const del = deps.deleteFile || deleteUserFile;
    const names = new Set(ownedFileNames());
    for (const store of listFileStores()) {
        if (store?.file) names.add(store.file);
    }
    let deleted = 0;
    for (const prefix of ['uris_gallery_shard_', 'uris_refs_shard_']) {
        let misses = 0;
        for (let n = 0; n < 10_000 && misses < 50; n++) {
            const name = `${prefix}s${String(n).padStart(4, '0')}.json`;
            names.delete(name);   // probed below, not by the bulk pass
            if (await del(name)) deleted++; else misses++;
        }
    }
    for (const name of names) {
        try { if (await del(name)) deleted++; } catch { /* uninstall race */ }
    }
    return deleted;
}

/** Delete every image in the two URIS folders. Returns the deleted count. */
export async function deleteOwnedImageFolders(deps = {}) {
    const listFolder = deps.listFolder || ((folder) => listNativeImages({ folder }));
    const files = [...await listFolder(REFS_FOLDER), ...await listFolder(THUMBNAIL_FOLDER)];
    return deleteOrphanFiles(files);
}
