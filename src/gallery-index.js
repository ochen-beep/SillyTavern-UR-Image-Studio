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
 * not the index size. Миграция из монолита — в sharded-file-store.js; миграция
 * из extensionSettings удалена (d331ca3): все установки того поколения давно
 * переехали в файлы.
 *
 * Native image FILES are untouched by any of this: they stay in ST's gallery
 * folders and are only referenced by `imagePath`.
 */

import { uid, log, warn, sanitizeId, getCtx } from './core.js';
import { listNativeImages } from './native-image-storage.js';
import { canonicalizeNativeImagePath, NATIVE_IMAGE_FOLDER } from './native-image-path.js';
import { createShardedFileStore } from './sharded-file-store.js';
import { readUrisSidecar } from './png-sidecar.js';

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
    // Name of the prompt template that composed this render, frozen at
    // generation time (image-api resolves it from the draft's templateId).
    'templateName',
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
    // Избранное (карточка закрепляется наверху сетки) и принадлежность папкам
    // галереи (id определений из gallery-folders.js, у карточки — массив).
    'favorite',
    'folders',
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

/** Test seam: which backend the store resolved to ('file' | 'readonly' | 'unknown'). */
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
    // id приходит из импортируемого бэкапа (чужой файл) и попадает в HTML-атрибуты:
    // невалидный алфавит → свежий uid() (см. SAFE_ID_RE в core.js).
    out.id = existing?.id || sanitizeId(input.id) || uid();
    out.imagePath = canonicalizeNativeImagePath(existing?.imagePath || cleanText(input.imagePath));
    if (!out.imagePath) throw new Error('Gallery card requires a native image path');
    out.prompt = cleanText(out.prompt, existing?.prompt || '');
    out.negativePrompt = cleanText(out.negativePrompt, existing?.negativePrompt || '');
    out.connectionId = cleanText(out.connectionId, existing?.connectionId || '');
    out.routeId = cleanText(out.routeId, existing?.routeId || '');
    out.modelId = cleanText(out.modelId, existing?.modelId || '');
    out.templateName = cleanText(out.templateName, existing?.templateName || '');
    out.generationContract = cleanText(out.generationContract, existing?.generationContract || '');
    out.status = out.status === 'missing' ? 'missing' : 'ready';
    out.hidden = out.hidden === true ? true : false;
    out.favorite = out.favorite === true;
    out.folders = Array.isArray(out.folders) ? out.folders.filter(id => typeof id === 'string') : (existing?.folders || []);
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

/** Export snapshot: all cards as stored, or null while the store mirror is
 *  not loaded — an export must never substitute "unknown" with "empty". */
export async function getCardsForExport() {
    await galleryStore.ready();
    const snap = galleryStore.snapshot();
    return snap === null ? null : snap.map(card => ({ ...card }));
}

/**
 * Backup import (data-port): 'merge' — incoming wins per id, current order
 * preserved, new ids appended; 'replace' — the store becomes the incoming set.
 * Cards without a usable imagePath are skipped (sanitizeGalleryCard throws).
 */
export async function importGalleryCards(incoming = [], mode = 'merge') {
    const clean = [];
    for (const raw of Array.isArray(incoming) ? incoming : []) {
        // id приходит из чужого файла: сначала через SAFE_ID_RE (sanitizeGalleryCard
        // с existing доверил бы исходный id как есть — он идёт в HTML-атрибуты).
        const id = sanitizeId(raw?.id);
        if (!id) { warn('importGalleryCards: skipped card with unusable id', raw?.id); continue; }
        try { clean.push(sanitizeGalleryCard({ ...raw, id }, { ...raw, id })); }
        catch { warn('importGalleryCards: skipped card without imagePath', id); }
    }
    await galleryStore.mutate(list => {
        if (mode === 'replace') { list.length = 0; list.push(...clean); return; }
        const pos = new Map(list.map((card, i) => [card.id, i]));
        for (const card of clean) {
            if (pos.has(card.id)) list[pos.get(card.id)] = card;
            else list.push(card);
        }
    });
    return clean.length;
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

/**
 * Отстегнуть id удалённой папки от всех карточек (один mutate — один шард-раунд
 * на задетый шард). Возвращает число затронутых карточек; ноль изменений —
 * записи на сервер не переписываются.
 */
export async function detachFolderFromCards(folderId) {
    if (!folderId) return 0;
    return galleryStore.mutate(list => {
        let affected = 0;
        for (let i = 0; i < list.length; i++) {
            const folders = list[i]?.folders;
            if (!Array.isArray(folders) || !folders.includes(folderId)) continue;
            list[i] = sanitizeGalleryCard({ ...list[i], folders: folders.filter(id => id !== folderId) }, list[i]);
            affected += 1;
        }
        return affected;
    });
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

// ── Folder-first view join ──

/**
 * Folder-first gallery view model: every file of the folder renders, card
 * metadata joins by imagePath when a card exists. Files never indexed get a
 * `cardless` stub (reduced action set in the view). A card marked `hidden`
 * suppresses its file — "hide" must keep hiding in a folder-first world.
 * Cards pointing at files outside the folder (or nowhere) simply do not join.
 * Pure; tested in node.
 * @param {string[]} paths - folder file paths (any spelling; canonicalized here)
 * @param {object[]} cards - gallery index cards
 * @returns {object[]} view items, one per file, in the folder's listing order
 */
export function mergeFolderWithCards(paths, cards) {
    const byPath = new Map();
    for (const card of Array.isArray(cards) ? cards : []) {
        const path = canonicalizeNativeImagePath(card?.imagePath);
        if (path && !byPath.has(path)) byPath.set(path, card);
    }
    const items = [];
    const seen = new Set();
    for (const raw of Array.isArray(paths) ? paths : []) {
        const path = canonicalizeNativeImagePath(raw);
        if (!path || seen.has(path)) continue;
        seen.add(path);
        const card = byPath.get(path);
        if (card?.hidden === true) continue;
        items.push(card
            ? { ...card, imagePath: path }
            : {
                id: null, imagePath: path, prompt: '', negativePrompt: '',
                status: 'ready', hidden: false, favorite: false, folders: [],
                referenceIds: [], createdAt: null, cardless: true,
            });
    }
    return items;
}

// ── Test-only surface ──

export function resetGalleryStoreForTests() {
    galleryStore.reset();
}

// ── Восстановление карточек из PNG-сайдкаров (фаза 4) ──

async function defaultReadSidecar(path) {
    try {
        const res = await fetch(`/${path}`);
        if (!res.ok) return null;
        return await readUrisSidecar(await res.blob());
    } catch { return null; }
}

async function defaultListFolders() {
    const ctx = getCtx();
    const res = await fetch('/api/images/folders', {
        method: 'POST',
        headers: { ...(ctx?.getRequestHeaders?.() ?? {}), 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`folders list failed: ${res.status}`);
    const list = await res.json().catch(() => []);
    return Array.isArray(list) ? list : [];
}

/**
 * Пройти по всем папкам user/images и для каждого PNG без карточки прочитать
 * вшитый при генерации iTXt-блок (см. png-sidecar.js) и создать по нему
 * карточку. Файлы без блока не трогаются (folder-first их и так показывает),
 * существующие карточки не перезаписываются. Возвращает { scanned, restored }.
 */
export async function restoreCardsFromSidecars(deps = {}) {
    await galleryStore.ready();
    const listFolders = deps.listFolders || defaultListFolders;
    const listFiles = deps.listFiles || ((folder) => listNativeImages({ folder }));
    const readSidecar = deps.readSidecar || defaultReadSidecar;
    const known = new Set(cards().map(c => canonicalizeNativeImagePath(c.imagePath)).filter(Boolean));
    let scanned = 0, restored = 0;
    // Служебные папки бинарников — не галерейный контент.
    const folders = (await listFolders()).filter(f => f !== 'URIS_Thumbs' && f !== 'URIS_Refs');
    // Папки сканируются параллельно (десятки персонажей × тяжёлый листинг
    // папки — последовательный обход ощущался как зависание на минуту).
    const progress = typeof deps.onProgress === 'function' ? deps.onProgress : null;
    let doneFolders = 0;
    progress?.(0, folders.length);
    await Promise.all(folders.map(async (folder) => {
        try {
            for (const path of await listFiles(folder).catch(() => [])) {
            const canonical = canonicalizeNativeImagePath(path);
            if (!canonical || known.has(canonical)) continue;
            scanned++;
            if (!/\.png$/i.test(canonical)) continue;   // сайдкар пишется только в PNG
            const meta = await readSidecar(canonical);
            if (!meta || typeof meta !== 'object') continue;
            const input = {
                imagePath: canonical,
                prompt: typeof meta.prompt === 'string' ? meta.prompt : '',
                connectionId: meta.connectionId || '', routeId: meta.routeId || '',
                modelId: meta.model || '', generationContract: meta.contract || '',
                provenance: { chatId: meta.chatId || null, requestId: meta.requestId || null, restored: true },
                status: 'ready',
            };
            if (typeof meta.negativePrompt === 'string' && meta.negativePrompt) input.negativePrompt = meta.negativePrompt;
            if (meta.aspect) input.aspectRatio = meta.aspect;
            if (meta.size) input.imageSize = meta.size;
            if (meta.quality) input.quality = meta.quality;
            if (Array.isArray(meta.refs)) input.referenceIds = meta.refs;
            if (Number.isFinite(meta.createdAt)) input.createdAt = meta.createdAt;
            try {
                await addCard(input);
                restored++;
                known.add(canonical);
            } catch (e) { warn('sidecar restore skipped', canonical, e?.message || e); }
            }
        } finally {
            progress?.(++doneFolders, folders.length);
        }
    }));
    return { scanned, restored };
}
