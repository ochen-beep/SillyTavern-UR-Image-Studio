// @ts-check
/**
 * Shared metadata index for images stored in the native ST gallery.
 *
 * The cards live in SERVER files per user — originally the single
 * `data/<user>/user/files/uris_gallery.json` — not in `extensionSettings`. They
 * were 4,8 MB of a 7,8 MB settings.json: ST's `saveSettingsDebounced` re-POSTs
 * the whole settings object, so every unrelated settings change (in any
 * extension) rewrote the entire gallery index. The official extension guide
 * forbids exactly this ("Don't store large data in extensionSettings"). See
 * `src/file-store.js` for the shared machinery and
 * `docs/plans/2026-09-12-storage-externalization.md` for the rationale. Since
 * 2026-10-03 the index lives in `createShardedFileStore`: fixed-size
 * `uris_gallery_shard_*.json` files behind a tiny `uris_gallery_manifest.json`
 * (`uris_gallery.json` remains only as the one-time migration source), so a
 * mutation uploads one shard — the write cost is bounded by the shard size,
 * not the index size.
 *
 * The first load migrates the legacy `extensionSettings` copy into the file and
 * drops it — keeping a copy would defeat the entire point at this size. The
 * migration is written before the copy is dropped, so an interrupted migration
 * simply repeats on the next load.
 *
 * Native image FILES are untouched by any of this: they stay in ST's gallery
 * folders and are only referenced by `imagePath`.
 */

import { uid, log, warn } from './core.js';
import { listNativeImages } from './native-image-storage.js';
import { canonicalizeNativeImagePath, NATIVE_IMAGE_FOLDER } from './native-image-path.js';
import { createShardedFileStore } from './sharded-file-store.js';

export const GALLERY_FILE_NAME = 'uris_gallery.json';
export const GALLERY_MANIFEST_NAME = 'uris_gallery_manifest.json';
export const GALLERY_SHARD_PREFIX = 'uris_gallery_shard_';
export const GALLERY_STORE_VERSION = 1;
const GALLERY_STORE_KEY = 'cards';

const SECRET_KEY = /(?:api[_-]?key|authorization|token|secret|password|credential)/i;
const PAYLOAD_KEY = /(?:dataurl|base64|bytes|blob|src|result)/i;

function decodeFolderFromPath(value) {
    const canonical = canonicalizeNativeImagePath(value);
    if (!canonical) return null;
    const parts = canonical.split('/');
    try { return decodeURIComponent(parts[2]); }
    catch { return null; }
}
const ALLOWED = [
    'id', 'imagePath', 'prompt', 'negativePrompt', 'connectionId', 'routeId', 'modelId',
    'generationContract', 'aspectRatio', 'imageSize', 'quality', 'referenceIds', 'provenance',
    'status', 'createdAt', 'updatedAt', 'sourceMsgId', 'style', 'refs', 'refsSig', 'stage2Snapshot',
    // Natural pixel dimensions: PhotoSwipe needs them before opening (open
    // animation, layout). Legacy cards may miss them — image-dimensions.js
    // probes lazily and persists here.
    'width', 'height',
    // Small variant for the grid (native-image-storage.THUMBNAIL_FOLDER);
    // the lightbox always opens the full imagePath.
    'thumbPath',
    'hidden',
];

const galleryStore = createShardedFileStore({
    label: 'gallery',
    manifestName: GALLERY_MANIFEST_NAME,
    shardPrefix: GALLERY_SHARD_PREFIX,
    monolithName: GALLERY_FILE_NAME,
    monolithKey: GALLERY_STORE_KEY,
    version: GALLERY_STORE_VERSION,
    shardTarget: 250,
    append: 'front',
    placeByStamp: true,
    placeStamp: r => (Number.isFinite(r?.createdAt) ? r.createdAt : 0),
    empty: () => [],
    countEntries: value => (Array.isArray(value) ? value.length : null),
    // The card index is edited by every device and every tab this user's data
    // syncs to — merge-per-shard carries the same concurrent-writer safety the
    // whole-document merge used to (2026-09-14 incident class), at shard size.
    mergeWithServer: true,
});

/** Resolve the card store (probe / load) exactly once per session. */
export function ensureGalleryStoreReady() {
    return galleryStore.ready();
}

export function galleryStoreMode() { return galleryStore.mode(); }

/** Await durability of queued card writes. */
export function flushGalleryWrites() {
    return galleryStore.flush();
}

/**
 * Last-chance durability on page unload. The card file is usually larger than
 * the ~64 KB keepalive cap, so this generally logs 'skipped' and relies on the
 * normal serialized write having landed — `addCard`/`updateCard` are awaited by
 * their callers before the generation is reported complete.
 */
/**
 * Synchronous read of the loaded cards. Requires a resolved store — every async
 * entry point below awaits `ready()` first, and `init()` warms it before the UI
 * renders, so the mirror is always populated by the time callers read it.
 */
function cards() {
    const list = galleryStore.snapshot();
    if (list === null) {
        warn('gallery-index: read before the card store was ready; returning no cards');
        return [];
    }
    return list;
}

function cleanText(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

/** Keep cards portable: recursively remove secrets, raw image payloads, and unsupported values. */
function sanitizeMetadata(value, depth = 0) {
    if (depth > 8 || value == null) return null;
    if (typeof value === 'string') {
        if (/^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(value)) return null;
        return value.length <= 4096 ? value : value.slice(0, 4096);
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        return value.map(item => sanitizeMetadata(item, depth + 1)).filter(item => item !== null);
    }
    if (typeof value !== 'object') return null;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        if (SECRET_KEY.test(key) || PAYLOAD_KEY.test(key)) continue;
        const safe = sanitizeMetadata(item, depth + 1);
        if (safe !== null) out[key] = safe;
    }
    return out;
}

export function sanitizeGalleryCard(input = {}, existing = null) {
    const now = Date.now();
    const out = {};
    for (const key of ALLOWED) {
        if (SECRET_KEY.test(key) || PAYLOAD_KEY.test(key) || !Object.hasOwn(input, key)) continue;
        out[key] = input[key];
    }
    out.id = existing?.id || (typeof input.id === 'string' && input.id ? input.id : uid());
    out.imagePath = canonicalizeNativeImagePath(existing?.imagePath || cleanText(input.imagePath));
    if (!out.imagePath) throw new Error('Gallery card requires a native image path');
    out.prompt = cleanText(out.prompt, existing?.prompt || '');
    out.negativePrompt = cleanText(out.negativePrompt, existing?.negativePrompt || '');
    out.connectionId = cleanText(out.connectionId, existing?.connectionId || '');
    out.routeId = cleanText(out.routeId, existing?.routeId || '');
    out.modelId = cleanText(out.modelId, existing?.modelId || '');
    out.generationContract = cleanText(out.generationContract, existing?.generationContract || '');
    out.status = out.status === 'missing' ? 'missing' : 'ready';
    out.hidden = out.hidden === true ? true : false;
    out.referenceIds = Array.isArray(out.referenceIds) ? out.referenceIds.filter(id => typeof id === 'string') : (existing?.referenceIds || []);
    for (const key of ['provenance', 'style', 'refs', 'refsSig', 'stage2Snapshot']) {
        if (Object.hasOwn(out, key)) out[key] = sanitizeMetadata(out[key]);
    }
    out.createdAt = Number.isFinite(existing?.createdAt) ? existing.createdAt : (Number.isFinite(input.createdAt) ? input.createdAt : now);
    out.updatedAt = now;
    return out;
}

export async function addCard(input) {
    const card = await galleryStore.mutate(list => {
        const existing = typeof input?.id === 'string' ? list.find(item => item.id === input.id) : null;
        // Throws before the list is touched when the image path is unusable.
        const next = sanitizeGalleryCard(input, existing);
        if (existing) list.splice(list.indexOf(existing), 1, next);
        else list.unshift(next);
        return next;
    });
    if (card) log('Gallery card stored', card.id);
    return card;
}

export async function updateCard(id, patch) {
    return galleryStore.mutate(list => {
        const existing = list.find(item => item.id === id);
        if (!existing) return null;
        const card = sanitizeGalleryCard({ ...existing, ...patch, id, imagePath: existing.imagePath }, existing);
        list.splice(list.indexOf(existing), 1, card);
        return card;
    });
}

export async function removeCard(id) {
    return galleryStore.mutate(list => {
        const position = list.findIndex(item => item.id === id);
        if (position === -1) return false;
        list.splice(position, 1);
        return true;
    });
}

/** Remove all metadata cards. Native image files remain untouched. */
export async function clearCards() {
    await galleryStore.mutate(list => { list.splice(0, list.length); });
}

/**
 * Count how many cards reference the given canonical image path.
 * Synchronous by design (delete paths branch on it); requires a resolved store.
 */
export function countCardsByImagePath(imagePath) {
    const canonical = canonicalizeNativeImagePath(imagePath);
    if (!canonical) return 0;
    return cards().filter(card => canonicalizeNativeImagePath(card.imagePath) === canonical).length;
}

export async function reconcileCards(paths = null) {
    await galleryStore.ready();
    let nativePaths;
    if (paths) {
        // paths is a precomputed array (used by tests / direct callers)
        nativePaths = new Set(paths.flatMap(path => {
            const canonical = canonicalizeNativeImagePath(path);
            return canonical ? [canonical] : [];
        }));
    } else {
        // Scan every distinct folder referenced by cards, plus the legacy folder,
        // so reconcile stays correct once cards live across character folders.
        const folders = new Set([NATIVE_IMAGE_FOLDER]);
        for (const card of cards()) {
            const folder = decodeFolderFromPath(card.imagePath);
            if (folder) folders.add(folder);
        }
        const lists = await Promise.all([...folders].map(folder => listNativeImages({ folder }).catch(() => [])));
        nativePaths = new Set(lists.flat());
    }

    // Recompute without writing, then persist only on a real change. Cards are
    // sanitized on write, so re-sanitizing every card on read would bump every
    // `updatedAt` and turn each gallery open into a full rewrite of the file.
    const changed = await galleryStore.mutate(list => {
        let dirty = false;
        for (let i = list.length - 1; i >= 0; i--) {
            const card = list[i];
            const canonical = canonicalizeNativeImagePath(card?.imagePath);
            if (!canonical) {
                list.splice(i, 1);
                dirty = true;
                continue;
            }
            const status = nativePaths.has(canonical) ? 'ready' : 'missing';
            if (canonical !== card.imagePath || status !== card.status) {
                list[i] = sanitizeGalleryCard({ ...card, imagePath: canonical, status }, card);
                dirty = true;
            }
        }
        const known = new Set(list.map(card => card.imagePath));
        for (const imagePath of nativePaths) {
            if (known.has(imagePath)) continue;
            list.unshift(sanitizeGalleryCard({ imagePath, prompt: '', status: 'ready', provenance: 'native' }));
            known.add(imagePath);
            dirty = true;
        }
        return dirty;
    }, { persist: false });
    if (changed) await galleryStore.persist();
    return cards();
}

export async function listCards({ reconcile = true } = {}) {
    if (reconcile) return reconcileCards();
    await galleryStore.ready();
    return cards();
}

// ── Test-only surface ──

export function resetGalleryStoreForTests() {
    galleryStore.reset();
}
