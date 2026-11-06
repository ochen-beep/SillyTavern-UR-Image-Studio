// @ts-check
/**
 * One-shot migration (2026-11, phase 3 of the Data-Maid protection plan):
 * legacy user/images binaries — reference images (URIS_Refs) and thumbnails
 * (URIS_Thumbs) — are copied to user/files under the protected registry
 * (user-files-storage.js), and the records are re-pointed at the copies.
 *
 * Idempotent: records already pointing at user/files skip; a binary that
 * fails to copy keeps its old path (nothing breaks — the old file still
 * serves). Originals are left on disk deliberately: the data-care sweep
 * ("Ничьи файлы") offers to remove them once nothing references them.
 */
import { log, warn } from './core.js';
import { canonicalizeNativeImagePath } from './native-image-path.js';
import { uploadNamedUserFile } from './user-files-storage.js';
import { randomToken } from './random.js';
import { listRefs, updateRef } from './refs-library.js';
import { listCards, updateCard } from './gallery-index.js';

function bytesToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/**
 * Copy one legacy user/images binary to user/files. Returns the new canonical
 * path, or null when the path is not a legacy image (already migrated, foreign,
 * or broken) or the copy failed — callers keep the old path in that case.
 */
export async function migrateOneBinary(imagePath, prefix, deps = {}) {
    const legacy = canonicalizeNativeImagePath(imagePath);
    if (!legacy) return null;
    const doFetch = deps.fetch || globalThis.fetch;
    const upload = deps.upload || uploadNamedUserFile;
    const base = legacy.split('/').pop() || '';
    const stem = base.replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9_-]/g, '') || 'img';
    const ext = (base.match(/\.([a-zA-Z0-9]+)$/)?.[1] || 'png').toLowerCase();
    try {
        const res = await doFetch(`/${legacy}`);
        if (!res?.ok) return null;
        const buf = await res.arrayBuffer();
        if (!buf?.byteLength) return null;
        return await upload(`uris_${prefix}_${stem}_${randomToken(6)}.${ext}`, bytesToBase64(buf));
    } catch (e) {
        warn('binaries-migration: copy failed for', legacy, e?.message || e);
        return null;
    }
}

/**
 * Move every legacy binary referenced by the refs pool and by gallery card
 * thumbnails. Best-effort, sequential (server-friendly), idempotent.
 * @returns {Promise<number>} how many files were copied
 */
export async function migrateStoredBinaries(deps = {}) {
    const migrate = deps.migrate || migrateOneBinary;
    let moved = 0;
    try {
        for (const ref of await listRefs()) {
            for (const field of ['imagePath', 'thumbPath']) {
                const next = await migrate(ref[field], field === 'thumbPath' ? 'thumb' : 'ref');
                if (next) { await updateRef(ref.id, { [field]: next }); moved++; }
            }
        }
    } catch (e) { warn('binaries-migration: refs pass failed', e?.message || e); }
    try {
        for (const card of await listCards({ reconcile: false })) {
            const next = await migrate(card.thumbPath, 'thumb');
            if (next) { await updateCard(card.id, { thumbPath: next }); moved++; }
        }
    } catch (e) { warn('binaries-migration: gallery pass failed', e?.message || e); }
    if (moved) log(`binaries-migration: moved ${moved} files to protected user/files storage`);
    return moved;
}
