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
import { canonicalizeNativeImagePath, canonicalizeStoredPath } from './native-image-path.js';
import { listRefs } from './refs-library.js';
import { listCards } from './gallery-index.js';
import { listFileStores, suspendAllStoresForClean } from './file-store.js';
import { unprotectUserFile, clearProtectedRegistry, syncProtectedRegistry, listProtectedUserFiles, deleteStoredServerFile } from './user-files-storage.js';

const REFS_FOLDER = 'URIS_Refs';

/** ST-relative paths that live records still point at. */
async function referencedPaths(deps) {
    const refs = deps.refs ? await deps.refs() : await listRefs();
    const cards = deps.cards ? await deps.cards() : await listCards({ reconcile: false });
    const used = new Set();
    for (const ref of refs) {
        for (const p of [ref.imagePath, ref.thumbPath]) {
            if (p) used.add(canonicalizeStoredPath(p) || p);
        }
    }
    for (const card of cards) {
        // Карточка может ссылаться и на файл в URIS-папках (референс, поднятый
        // в галерею) — иначе свип удалит бинарник из-под живой карточки.
        for (const p of [card.thumbPath, card.imagePath]) {
            if (p) used.add(canonicalizeStoredPath(p) || p);
        }
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
    // user/files has no directory listing, but URIS-owned binaries there are
    // all in the protected registry (phase 3) — the registry IS the listing.
    // A registry entry no live record references is an orphan.
    const registryFiles = (deps.protectedFiles ? deps.protectedFiles() : listProtectedUserFiles())
        .map(e => e?.url)
        .filter(url => typeof url === 'string' && /^user\/files\/uris_(ref|thumb)_/.test(url));
    return [...new Set([...refFiles, ...thumbFiles, ...registryFiles])]
        .filter(path => !used.has(canonicalizeStoredPath(path) || path))
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
        // deleteStoredServerFile routes by path shape (user/files vs
        // user/images), unregisters protected files, treats 404 as success.
        if (await deleteStoredServerFile(path, { signal })) deleted++;
    }
    return deleted;
}

async function deleteUserFile(name) {
    const ctx = getCtx();
    const res = await fetch('/api/files/delete', {
        method: 'POST',
        headers: { ...(ctx?.getRequestHeaders?.() ?? {}), 'Content-Type': 'application/json' },
        // The endpoint resolves the path against the user ROOT: the files dir
        // lives at `user/files/…`, not `files/…` (verified live — a `files/`
        // prefix is rejected with 400 and deletes nothing).
        body: JSON.stringify({ path: `user/files/${name}` }),
    });
    // 404 stays "not deleted" — the shard range walk in deleteUserFiles counts
    // misses and stops after a run of them.
    if (res.ok) unprotectUserFile(`user/files/${name}`);
    return res.ok;
}

/**
 * Register every owned file name in the Data Maid shield registry (init-time
 * reconcile: files written before the registry existed, entries wiped by a
 * manual settings edit). Idempotent and network-free.
 */
export function ensureOwnedFilesRegistered() {
    return syncProtectedRegistry(ownedFileNames());
}

/** Named stores plus the corrupt side files a repair may have parked. */
function ownedFileNames() {
    const names = [
        'uris_gallery.json', 'uris_gallery_manifest.json', 'uris_gallery_folders.json',
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

/**
 * The clean-hook entry point. Order matters: stores are frozen FIRST — the
 * extension is still live when ST runs the clean hook, and any later flush
 * would resurrect the files deleted below (proven live 2026-11-01).
 */
export async function cleanAllData() {
    suspendAllStoresForClean();
    const files = await deleteUserFiles();
    const images = await deleteOwnedImageFolders();
    // The shield registry tracks nothing after this point — drop the key
    // entirely instead of unprotecting names one by one (shards the range
    // walk never reached would leak otherwise).
    clearProtectedRegistry();
    return { files, images };
}
