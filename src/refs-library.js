// @ts-check
/**
 * Reference library: global pool + folders + chat binding.
 * Replaces references-profiles.js (v3-redesign).
 * Spec: docs/archive/plans/2026-07-14-references-chat-scoped-pool.md §2.
 *
 * The pool and its folders persist in SERVER files per user — originally the
 * single `data/<user>/user/files/uris_refs.json` — not in `extensionSettings`:
 * they are user-authored data (with an unbounded `description`), and the
 * settings blob is re-POSTed wholesale on every unrelated settings change. See
 * `src/file-store.js` and `docs/plans/2026-09-12-storage-externalization.md`.
 * Since 2026-10-03 the pool lives in `createShardedFileStore`: refs ride
 * fixed-size `uris_refs_shard_*.json` files behind `uris_refs_manifest.json`
 * (`uris_refs.json` remains only as the one-time migration source) and the
 * folders ride the small `uris_refs_meta.json` satellite file.
 *
 * Folder preferences (pinned / sort / hideEmpty) deliberately STAY in settings:
 * they are device-local UI state and must not travel with an import.
 */
import {
    META_KEY,
    uid, log, warn, getCtx, getImageConnectionSettings, IMAGE_CONNECTION_SETTINGS_KEY, saveSettings,
    DEFAULT_CHAT_CONFIG_ENVELOPE, deepClone, sanitizeId,
} from './core.js';
import { normalizeAliases } from './scene-context.js';
import { canonicalizeNativeImagePath } from './native-image-path.js';
import { createShardedFileStore } from './sharded-file-store.js';
import { recordDiagnosticEvent } from './diagnostic-events.js';
import { isStudioActive, getStudioBinding, saveStudioBinding } from './studio-scope.js';

const REFS_FILE_NAME = 'uris_refs.json';
export const REFS_MANIFEST_NAME = 'uris_refs_manifest.json';
export const REFS_SHARD_PREFIX = 'uris_refs_shard_';
export const REFS_META_NAME = 'uris_refs_meta.json';
export const REFS_STORE_VERSION = 1;

/** Shared image-connections settings object, creating the nesting on demand. */
function imageSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings) ctx.extensionSettings = {};
    if (!ctx.extensionSettings.ur_image_studio || typeof ctx.extensionSettings.ur_image_studio !== 'object') {
        ctx.extensionSettings.ur_image_studio = {};
    }
    const settings = ctx.extensionSettings.ur_image_studio;
    if (!settings[IMAGE_CONNECTION_SETTINGS_KEY] || typeof settings[IMAGE_CONNECTION_SETTINGS_KEY] !== 'object') {
        settings[IMAGE_CONNECTION_SETTINGS_KEY] = getImageConnectionSettings({});
    }
    return settings[IMAGE_CONNECTION_SETTINGS_KEY];
}

// ── Pool + folders store (server file) ──

/** Callers use the folder-collection name; the document key is shorter. */
function documentKey(collection) {
    return collection === 'ref-folders' ? 'folders' : collection;
}

const refsStore = createShardedFileStore({
    label: 'references',
    manifestName: REFS_MANIFEST_NAME,
    shardPrefix: REFS_SHARD_PREFIX,
    monolithName: REFS_FILE_NAME,
    monolithKey: 'data',
    version: REFS_STORE_VERSION,
    shardTarget: 250,
    append: 'back',
    placeByStamp: false,
    shardedKey: 'refs',
    // refs: insertion-ordered array; folders are a small satellite array that
    // must not ride the manifest (the manifest has to be rebuildable from a
    // shard scan alone — user-files has no directory listing).
    meta: { name: REFS_META_NAME, keys: ['folders'], empty: () => ({ folders: [] }) },
    empty: () => ({ refs: [], folders: [] }),
    countEntries: value => (Array.isArray(value?.refs) ? value.refs.length : null),
    // The pool file is edited by every device this user's data syncs to
    // (Syncthing mirror, second browser): merge-per-shard keeps the
    // concurrent-writer safety of the whole-document merge.
    mergeWithServer: true,
});

/** Resolve the pool store (probe / load / migrate) exactly once per session. */
export function ensureRefsStoreReady() {
    return refsStore.ready();
}

export function refsStoreMode() { return refsStore.mode(); }

/** Await durability of queued pool writes. */
export function flushRefsWrites() {
    return refsStore.flush();
}

/**
 * Throw unless every queued pool write has actually reached the server.
 * `mutate()` schedules persistence without awaiting it, so a caller that shows
 * «Сохранено» right after its update would lie when the upload fails or the
 * session's writes are refused. Image-replacing flows must confirm durability
 * before telling the user the reference changed.
 */
export async function persistPoolOrThrow(action = 'сохранить') {
    const ok = await refsStore.flush();
    if (!ok) throw new Error(`не удалось ${action}: запись не подтверждена сервером`);
}

/**
 * Best-effort delete of a reference image file the pool no longer points at
 * after a replace/crop. The store's pre-write server merge makes resurrection of
 * an old record (and its path) theoretically possible, so the path is re-read
 * from the live pool before the unlink, and any failure is ignored: a leaked
 * file is harmless, deleting a referenced one is not.
 */
export async function releaseRefImage(oldPath) {
    if (!oldPath) return;
    try {
        const pool = await listRefs();
        // Any live record still pointing at the file (this or another reference)
        // forbids the unlink; the merge machinery can bring an old record back.
        const stillUsed = pool.some(r => canonicalizeNativeImagePath(r.imagePath)
            === canonicalizeNativeImagePath(oldPath));
        if (stillUsed) return;
        const ctx = getCtx();
        await fetch('/api/images/delete', {
            method: 'POST',
            headers: { ...(ctx?.getRequestHeaders?.() ?? {}), 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: oldPath }),
        });
    } catch { /* orphaned file, not user data */ }
}

/** Drop the settings copy only once the file is authoritative (migration path). */
/**
 * Live pool + folders for the backup exporter. Null in legacy mode, where the
 * settings copy already carries them and the exporter reads it directly.
 */
export async function getRefsForExport() {
    if (await refsStore.ready() !== 'file') return null;
    return refsStore.snapshot();
}

/**
 * Backup import / rollback: replace the whole pool with the restored records and
 * await durability. No-op in legacy mode (the settings restore carries them
 * there). Returns whether the file store accepted the records.
 */
export async function replaceRefsRecords(records) {
    if (await refsStore.ready() !== 'file') return false;
    await refsStore.replace({
        refs: Array.isArray(records?.refs) ? records.refs : [],
        folders: Array.isArray(records?.folders) ? records.folders : [],
    });
    _poolCache = null;
    return true;
}

/** The collection array inside a (live or cloned) document body. */
function bucket(value, collection) {
    const key = documentKey(collection);
    if (!value[key] || !Array.isArray(value[key])) value[key] = [];
    return value[key];
}

let testStore = null;

function collectionStore() {
    return {
        available: async () => true,
        list: async collection => {
            await refsStore.ready();
            const data = refsStore.snapshot();
            if (!data) return [];
            const records = data[documentKey(collection)];
            return Array.isArray(records) ? records : [];
        },
        create: async (collection, payload) => refsStore.mutate(data => {
            bucket(data, collection).push(payload);
            return payload;
        }),
        update: async (collection, id, payload) => refsStore.mutate(data => {
            const records = bucket(data, collection);
            const index = records.findIndex(record => record.id === id);
            if (index === -1) return null;
            records[index] = payload;
            return payload;
        }),
        // Patch every matching record in ONE mutate (one server round-trip):
        // per-reference update loops re-read and re-upload the whole file N times.
        updateWhere: async (collection, predicate, makeNext) => {
            let affected = 0;
            await refsStore.mutate(data => {
                const records = bucket(data, collection);
                for (let i = 0; i < records.length; i++) {
                    if (!predicate(records[i])) continue;
                    records[i] = makeNext(records[i]);
                    affected += 1;
                }
            });
            return affected;
        },
        delete: async (collection, id) => refsStore.mutate(data => {
            const records = bucket(data, collection);
            const index = records.findIndex(record => record.id === id);
            if (index !== -1) records.splice(index, 1);
        }),
    };
}

/** Test-only override for a shared collection backend. */
export function setRefStoreForTests(store) {
    testStore = store;
    _poolCache = null;
}

export function resetRefStoreForTests() {
    testStore = null;
    _poolCache = null;
    refsStore.reset();
}

function sharedStore() {
    if (!testStore) return collectionStore();
    return testStore;
}

function uniqueStrings(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        const normalized = String(value || '').trim();
        const key = normalized.toLocaleLowerCase();
        if (!normalized || seen.has(key)) continue;
        seen.add(key);
        out.push(normalized);
    }
    return out;
}

/** Normalize a persisted or incoming pool record to the current aliases-only schema. */
export function normalizePoolReference(data = {}) {
    const bindingMode = data.bindingMode === 'description' ? 'description' : 'image';
    // id/folders приходят из импортируемого бэкапа и попадают в HTML-атрибуты:
    // невалидный алфавит → свежий uid() / отбрасывается (SAFE_ID_RE в core.js).
    const item = {
        id: sanitizeId(data.id) || uid(),
        name: String(data.name || '').trim() || 'Без названия',
        aliases: uniqueStrings(normalizeAliases(data.aliases)),
        description: String(data.description || ''),
        ...(bindingMode === 'description' ? { bindingMode } : {}),
        imagePath: data.imagePath || '',
        folders: uniqueStrings(Array.isArray(data.folders) ? data.folders.map(sanitizeId).filter(Boolean) : []),
        createdAt: Number.isFinite(data.createdAt) ? data.createdAt : Date.now(),
        // Edit time drives cross-device merge resolution in file-store; absent
        // on records written before this build, which then never win a conflict.
        ...(Number.isFinite(data.updatedAt) ? { updatedAt: data.updatedAt } : {}),
    };
    const mime = typeof data.mime === 'string' && /^image\/(png|jpeg|webp)$/i.test(data.mime)
        ? data.mime.toLowerCase() : null;
    const width = validImageMetric(data.width);
    const height = validImageMetric(data.height);
    const sourceBytes = validImageMetric(data.sourceBytes, true);
    const optimizedBytes = validImageMetric(data.optimizedBytes, true);
    const optimizationVersion = typeof data.optimizationVersion === 'string' && data.optimizationVersion.trim()
        ? data.optimizationVersion.trim() : null;
    if (mime) item.mime = mime;
    if (width) item.width = width;
    if (height) item.height = height;
    if (sourceBytes !== null) item.sourceBytes = sourceBytes;
    if (optimizedBytes !== null) item.optimizedBytes = optimizedBytes;
    if (optimizationVersion) item.optimizationVersion = optimizationVersion;
    return item;
}

function validImageMetric(value, allowZero = false) {
    return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0) ? value : null;
}

// ── Pool CRUD ──

export async function listRefs() {
    const records = await sharedStore().list('refs');
    return Array.isArray(records) ? records.map(ref => normalizePoolReference(ref)) : [];
}

async function requireSharedStore() {
    return sharedStore();
}

export async function getRef(id) {
    const arr = await listRefs();
    return arr.find(r => r.id === id) || null;
}

export async function createRef(data = {}) {
    const store = await requireSharedStore();
    const item = normalizePoolReference(data);
    const response = await store.create('refs', item);
    const persisted = normalizePoolReference({ ...item, ...(response || {}) });
    await refreshPoolCache();
    recordDiagnosticEvent({ event: 'refs-crud', stage: 'refs', operation: 'create', details: { id: persisted.id } });
    log('Reference created', persisted.id, persisted.name);
    return persisted;
}

/** Create a reference by reusing the portable native-gallery path, never its bytes. */
export async function createReferenceFromGalleryCard(card = {}, options = {}) {
    const imagePath = canonicalizeNativeImagePath(card.imagePath);
    if (!imagePath) throw new Error('Gallery card requires a native image path');
    return createRef({
        name: options.name,
        aliases: options.aliases,
        folders: options.folders,
        imagePath,
        description: typeof card.prompt === 'string' ? card.prompt : '',
    });
}

/**
 * Дубликат записи пула: клон делит с оригиналом файл картинки (releaseRefImage
 * не отдаёт файл, пока на него смотрит хоть одна запись), но получает новый id,
 * имя «(копия)» и собственные правки — кроп/замена у одного никогда не трогают
 * другой. Поля прогоняются через createRef/normalizePoolReference, метаданные
 * картинки (mime/размеры/байты) переносятся как есть.
 * @param {object} source — запись из listRefs()/getRef()
 * @param {object} [overrides] — точечные поля поверх скопированных
 */
export async function cloneRef(source, overrides = {}) {
    if (!source?.id) throw new Error('cloneRef: нужна запись референса');
    return createRef({
        name: `${source.name || 'Без названия'} (копия)`,
        aliases: source.aliases,
        description: source.description,
        bindingMode: source.bindingMode,
        imagePath: source.imagePath,
        folders: source.folders,
        mime: source.mime,
        width: source.width,
        height: source.height,
        sourceBytes: source.sourceBytes,
        optimizedBytes: source.optimizedBytes,
        optimizationVersion: source.optimizationVersion,
        ...overrides,
    });
}

export async function updateRef(id, patch) {
    const current = await getRef(id);
    if (!current) return null;
    const next = { ...current, updatedAt: Date.now() };
    if (patch.name != null) next.name = String(patch.name).trim() || 'Без названия';
    if (patch.aliases !== undefined) next.aliases = normalizeAliases(patch.aliases);
    if (patch.description != null) next.description = String(patch.description);
    if (patch.bindingMode != null) next.bindingMode = patch.bindingMode === 'description' ? 'description' : 'image';
    if (patch.imagePath != null) next.imagePath = patch.imagePath;
    for (const key of ['mime', 'width', 'height', 'sourceBytes', 'optimizedBytes', 'optimizationVersion']) {
        if (patch[key] !== undefined) next[key] = patch[key];
    }
    if (patch.folders !== undefined) {
        next.folders = uniqueStrings(Array.isArray(patch.folders) ? patch.folders : []);
    }
    const store = await requireSharedStore();
    const payload = normalizePoolReference(next);
    const response = await store.update('refs', id, payload);
    if (response === null) throw new Error(`reference ${id} vanished before the update could be saved`);
    const persisted = normalizePoolReference({ ...payload, ...(response || {}) });
    await refreshPoolCache();
    recordDiagnosticEvent({ event: 'refs-crud', stage: 'refs', operation: 'update', details: { id } });
    return persisted;
}

export async function deleteRef(id) {
    const store = await requireSharedStore();
    await store.delete('refs', id);
    await refreshPoolCache();
    recordDiagnosticEvent({ event: 'refs-crud', stage: 'refs', operation: 'delete', details: { id } });
    log('Reference deleted', id);
}

/**
 * Filter reference list by active folder.
 * @param {Array} refs — reference records array (with folders: string[] field)
 * @param {'all'|'none'|string} folderFilter — 'all' | 'none' | folder identifier
 * @returns {Array} filtered array
 */
export function filterRefsByFolder(refs, folderFilter) {
    if (folderFilter === 'all') return refs.slice();
    if (folderFilter === 'none') return refs.filter(r => !Array.isArray(r.folders) || r.folders.length === 0);
    return refs.filter(r => Array.isArray(r.folders) && r.folders.includes(folderFilter));
}

/**
 * Return pool records belonging to any of the supplied folder IDs.
 * Folder IDs are storage identifiers; names are intentionally not used here.
 */
export function filterRefsByFolders(refs, folderIds = []) {
    const records = Array.isArray(refs) ? refs : [];
    const ids = Array.isArray(folderIds) ? folderIds.map(String) : [];
    const seen = new Set();
    const out = [];
    for (const folderId of ids) {
        for (const ref of records) {
            if (seen.has(ref?.id)) continue;
            if (!Array.isArray(ref?.folders) || !ref.folders.some(id => String(id) === folderId)) continue;
            seen.add(ref.id);
            out.push(ref);
        }
    }
    return out;
}

// ── Folder tree (2 levels: группа верхнего уровня → подпапки) ──

/**
 * Group folders by parent: Map(parentId | '' for top level → [folders in list
 * order]). Pure; missing/null parentId counts as top level.
 */
export function folderChildrenMap(folders) {
    const map = new Map();
    for (const folder of (Array.isArray(folders) ? folders : [])) {
        const key = folder?.parentId ? String(folder.parentId) : '';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(folder);
    }
    return map;
}

/** Direct children of folderId, in list order. */
export function folderChildFolders(folders, folderId) {
    return folderChildrenMap(folders).get(String(folderId)) || [];
}

/** True when the folder has at least one subfolder (i.e. renders as a group). */
export function folderHasChildren(folders, folderId) {
    return folderChildFolders(folders, folderId).length > 0;
}

/**
 * Descendant ids of folderId (excluding itself), depth-first in list order.
 * Cycle-safe: the walk never revisits an id, so a corrupt parentId loop
 * degrades to a partial walk instead of hanging the tab.
 */
export function folderDescendantIds(folders, folderId) {
    const kids = folderChildrenMap(folders);
    const out = [];
    const seen = new Set([String(folderId)]);
    const walk = (parentId) => {
        for (const child of (kids.get(parentId) || [])) {
            if (seen.has(child.id)) continue;
            seen.add(child.id);
            out.push(child.id);
            walk(child.id);
        }
    };
    walk(String(folderId));
    return out;
}

/** folderId + all descendants — the id set behind a recursive (group) filter. */
export function folderSubtreeIds(folders, folderId) {
    return [String(folderId), ...folderDescendantIds(folders, folderId)];
}

/**
 * Refs belonging to folderId OR any of its descendants (unique, refs order).
 * The recursive counterpart of filterRefsByFolder behind the group tap.
 */
export function filterRefsByFolderTree(refs, folders, folderId) {
    const ids = new Set(folderSubtreeIds(folders, folderId));
    return (Array.isArray(refs) ? refs : []).filter(ref =>
        Array.isArray(ref?.folders) && ref.folders.some(id => ids.has(String(id))));
}

/**
 * Expand selected folder ids so every folder id stands for its full subtree
 * (unique, stable order). Used by the generation whitelist: picking a group
 * there must pull in all descendant folders' references.
 */
export function expandFolderIdsToSubtrees(folders, ids = []) {
    const out = [];
    const seen = new Set();
    for (const id of (Array.isArray(ids) ? ids : []).map(String)) {
        for (const sub of folderSubtreeIds(folders, id)) {
            if (seen.has(sub)) continue;
            seen.add(sub);
            out.push(sub);
        }
    }
    return out;
}

// ── Folders CRUD ──

// Folder color palette (from Figma mockup). Assigned cyclically by
// index on creation. 10 colors are enough for visual distinguishability.
export const FOLDER_COLOR_PALETTE = [
    '#4a90d9', '#d97f3a', '#3ab09e', '#c94040', '#c9a030',
    '#7a5cc9', '#c94090', '#40a060', '#a04040', '#4a70b9',
];

/**
 * Normalize a folder record: guarantees id/name/color/order fields.
 * `parentId` is optional tree navigation (v4.1): null = top level; a folder
 * with parentId is a subfolder of a top-level folder. Depth cap is enforced
 * in createFolder/updateFolder, not here — normalization must stay total.
 */
export function normalizeFolder(data = {}, fallbackIndex = 0) {
    return {
        id: sanitizeId(data.id) || uid(),
        name: String(data.name || 'Папка').trim() || 'Папка',
        color: typeof data.color === 'string' && /^#[0-9a-f]{6}$/i.test(data.color)
            ? data.color
            : (FOLDER_COLOR_PALETTE.length
                ? FOLDER_COLOR_PALETTE[fallbackIndex % FOLDER_COLOR_PALETTE.length]
                : '#808080'),
        order: Number.isFinite(data.order) ? data.order : 0,
        parentId: sanitizeId(data.parentId) || null,
    };
}

/**
 * Depth cap for the folder tree: only top-level folders may contain children.
 * Returns a human-readable error when `parentId` is not a legal parent for
 * `folder`, or null when the move is legal. `parentId = null` (top level) is
 * always legal. A subfolder may move to another top-level group — the depth
 * stays 2; only a folder WITH children cannot go under anything.
 */
export function folderMoveError(folders, folder, parentId) {
    if (!parentId) return null;
    const list = Array.isArray(folders) ? folders : [];
    const parent = list.find(item => item.id === parentId);
    if (!parent) return 'Родительская папка не найдена';
    if (parent.id === folder.id) return 'Нельзя вложить папку в саму себя';
    if (parent.parentId) return 'Глубина вложенности ограничена двумя уровнями';
    if (list.some(item => item.parentId === folder.id)) {
        return 'Папка с подпапками не может быть вложена в другую папку';
    }
    return null;
}

export async function listFolders() {
    const records = await sharedStore().list('ref-folders');
    return Array.isArray(records) ? records.map((folder, index) => normalizeFolder(folder, index)) : [];
}

export async function createFolder(name, opts = {}) {
    const folders = await listFolders();
    if (opts.parentId) {
        const parent = folders.find(folder => folder.id === opts.parentId);
        if (!parent) throw new Error('Родительская папка не найдена');
        if (parent.parentId) throw new Error('Глубина вложенности ограничена двумя уровнями');
    }
    const item = normalizeFolder({
        name: String(name || 'Папка').trim() || 'Папка',
        color: typeof opts.color === 'string' ? opts.color : undefined,
        parentId: opts.parentId ? String(opts.parentId) : null,
        order: folders.length,
    }, folders.length);
    const store = await requireSharedStore();
    const created = normalizeFolder(await store.create('ref-folders', item), folders.length);
    recordDiagnosticEvent({ event: 'refs-crud', stage: 'refs', operation: 'folder-create', details: { id: created.id } });
    return created;
}

export async function updateFolder(id, patch = {}) {
    const folders = await listFolders();
    const index = folders.findIndex(folder => folder.id === id);
    if (index === -1) return null;
    const current = folders[index];
    let parentId = current.parentId;
    if (patch.parentId !== undefined) {
        const wanted = patch.parentId ? String(patch.parentId) : null;
        const moveError = folderMoveError(folders, current, wanted);
        if (moveError) throw new Error(moveError);
        parentId = wanted;
    }
    const next = normalizeFolder({
        ...current,
        name: patch.name !== undefined ? String(patch.name || '').trim() || 'Папка' : current.name,
        color: patch.color !== undefined ? patch.color : current.color,
        parentId,
        id: current.id,
        order: current.order,
    }, index);
    const store = await requireSharedStore();
    return normalizeFolder(await store.update('ref-folders', id, next), index);
}

export async function renameFolder(id, name) {
    return updateFolder(id, { name });
}

// Deleting a folder does not delete references: only removes the folder id from affected records.
// Subfolders of the deleted folder are lifted to the top level (approved design:
// cascade delete of folders is an unpredictable surprise; lift is reversible by hand).
export async function deleteFolder(id) {
    const folders = await listFolders();
    if (!folders.some(folder => folder.id === id)) return;
    const store = await requireSharedStore();
    await store.delete('ref-folders', id);
    await store.updateWhere('ref-folders',
        folder => folder && folder.parentId === id,
        folder => ({ ...folder, parentId: null }),
    );
    // One batch mutate: a per-reference update loop re-read and re-uploaded
    // the whole refs file once per record (2N+2 round-trips for N refs).
    await store.updateWhere('refs',
        ref => Array.isArray(ref.folders) && ref.folders.includes(id),
        ref => normalizePoolReference({ ...ref, folders: ref.folders.filter(folderId => folderId !== id) }),
    );
    const prefs = getFolderPrefs();
    const prefsPatch = {};
    if (prefs.pinned.includes(id)) prefsPatch.pinned = prefs.pinned.filter(pinnedId => pinnedId !== id);
    if (prefs.collapsed.includes(id)) prefsPatch.collapsed = prefs.collapsed.filter(collapsedId => collapsedId !== id);
    if (Object.keys(prefsPatch).length) saveFolderPrefs(prefsPatch);
    await refreshPoolCache();
    recordDiagnosticEvent({ event: 'refs-crud', stage: 'refs', operation: 'folder-delete', details: { id } });
    log('Folder deleted', id);
}

/**
 * Move every reference from folder `sourceId` into `targetId` and delete the
 * source folder. Returns the number of affected references.
 */
export async function mergeFolders(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return 0;
    const folders = await listFolders();
    if (!folders.some(folder => folder.id === sourceId) || !folders.some(folder => folder.id === targetId)) return 0;
    const store = await requireSharedStore();
    // One batch mutate for every moved reference (see deleteFolder).
    const affected = await store.updateWhere('refs',
        ref => Array.isArray(ref.folders) && ref.folders.includes(sourceId),
        ref => normalizePoolReference({ ...ref, folders: uniqueStrings([...ref.folders.filter(folderId => folderId !== sourceId), targetId]) }),
    );
    await store.delete('ref-folders', sourceId);
    const prefs = getFolderPrefs();
    if (prefs.pinned.includes(sourceId)) {
        saveFolderPrefs({ pinned: prefs.pinned.filter(pinnedId => pinnedId !== sourceId) });
    }
    await refreshPoolCache();
    recordDiagnosticEvent({ event: 'refs-crud', stage: 'refs', operation: 'folder-merge', details: { id: sourceId, targetId, refs: affected } });
    log('Folder merged', sourceId, '→', targetId, `(${affected} refs)`);
    return affected;
}

// ── Folder preferences (sidebar UI state) ──
// Pinned/sort/hideEmpty are DEVICE-LOCAL UI state and deliberately stay out of
// data-port PORTABLE_KEYS: pinning «Мама» на другом устройстве не переносится,
// зато не ломается merge-импорт, который юнионит refs/folders по id.

const FOLDER_PREFS_KEY = 'folderPrefs';
export const FOLDER_PREFS_MAX_PINNED = 12;
export const FOLDER_SORT_MODES = ['manual', 'name', 'count'];

/** Normalize persisted folder prefs: unknown sort → manual, pinned — unique ids, capped. */
export function normalizeFolderPrefs(data = {}) {
    return {
        pinned: uniqueStrings(Array.isArray(data.pinned) ? data.pinned : []).slice(0, FOLDER_PREFS_MAX_PINNED),
        sort: FOLDER_SORT_MODES.includes(data.sort) ? data.sort : 'manual',
        hideEmpty: data.hideEmpty === true,
        // Свёрнутые группы дерева (device-local UI state, как pinned).
        collapsed: uniqueStrings(Array.isArray(data.collapsed) ? data.collapsed : []),
    };
}

export function getFolderPrefs() {
    const raw = imageSettings()[FOLDER_PREFS_KEY];
    return normalizeFolderPrefs(raw && typeof raw === 'object' ? raw : {});
}

export function saveFolderPrefs(patch = {}) {
    const next = normalizeFolderPrefs({ ...getFolderPrefs(), ...patch });
    imageSettings()[FOLDER_PREFS_KEY] = next;
    saveSettings();
    return next;
}

// ── Chat binding (chatMetadata.uris_binding.refs) ──

/** Default pool-only binding for a new chat. */
export function defaultChatRefs() {
    return deepClone(DEFAULT_CHAT_CONFIG_ENVELOPE.refs);
}

function _rawBinding() {
    // Studio scope: the same uris_binding envelope lives in uris_studio.json,
    // because chatMetadata does not exist without an open chat.
    if (isStudioActive()) return getStudioBinding();
    const ctx = getCtx();
    const meta = ctx.chatMetadata?.[META_KEY];
    return meta && typeof meta === 'object' ? meta : null;
}

/** Read the current chat's schema-v5 reference binding without persisting it. */
export function getChatRefs() {
    const binding = _rawBinding();
    if (!binding?.schemaVersion || binding.schemaVersion < 4 || !binding.refs || typeof binding.refs !== 'object') {
        return defaultChatRefs();
    }
    const referenceIds = binding.refs.referenceIds;
    const folderIds = binding.refs.folderIds;
    return {
        referenceIds: Array.isArray(referenceIds) ? uniqueStrings(referenceIds.map(String)) : [],
        folderIds: Array.isArray(folderIds) ? uniqueStrings(folderIds.map(String)) : [],
    };
}

/** Merge-patch the current chat's refs into chatMetadata + saveMetadata.
 *  Ensures the surrounding schema-v5 binding/config exists and is preserved. */
export function saveChatRefs(patch) {
    if (isStudioActive()) return saveStudioChatRefs(patch);
    const ctx = getCtx();
    if (!ctx.chatMetadata) ctx.chatMetadata = {};
    const existing = ctx.chatMetadata[META_KEY];
    if (existing && (!existing.schemaVersion || existing.schemaVersion < 4)) {
        log('Chat refs skipped for non-schema binding');
        return defaultChatRefs();
    }
    if (!existing) {
        ctx.chatMetadata[META_KEY] = {
            schemaVersion: 5,
            config: deepClone(DEFAULT_CHAT_CONFIG_ENVELOPE.config),
            refs: deepClone(DEFAULT_CHAT_CONFIG_ENVELOPE.refs),
        };
    }
    const binding = ctx.chatMetadata[META_KEY];

    if (!binding.refs || typeof binding.refs !== 'object') {
        binding.refs = deepClone(DEFAULT_CHAT_CONFIG_ENVELOPE.refs);
    }

    const merged = { ...getChatRefs(), ...patch };
    binding.refs = {
        referenceIds: uniqueStrings(Array.isArray(merged.referenceIds) ? merged.referenceIds.map(String) : []),
        folderIds: uniqueStrings(Array.isArray(merged.folderIds) ? merged.folderIds.map(String) : []),
    };
    try { ctx.saveMetadata?.(); } catch { /* non-critical */ }
    log('Chat refs updated', binding.refs);
    return binding.refs;
}

/** Studio twin of saveChatRefs: the same invariants, but the surrounding
 *  schema-v5 envelope lives in uris_studio.json (see studio-scope.js). */
function saveStudioChatRefs(patch) {
    const existing = getStudioBinding();
    if (existing && (!existing.schemaVersion || existing.schemaVersion < 4)) {
        log('Chat refs skipped for non-schema binding (studio)');
        return defaultChatRefs();
    }
    const binding = existing || deepClone(DEFAULT_CHAT_CONFIG_ENVELOPE);
    if (!binding.refs || typeof binding.refs !== 'object') {
        binding.refs = deepClone(DEFAULT_CHAT_CONFIG_ENVELOPE.refs);
    }
    const merged = { ...getChatRefs(), ...patch };
    binding.refs = {
        referenceIds: uniqueStrings(Array.isArray(merged.referenceIds) ? merged.referenceIds.map(String) : []),
        folderIds: uniqueStrings(Array.isArray(merged.folderIds) ? merged.folderIds.map(String) : []),
    };
    saveStudioBinding(binding);
    log('Chat refs updated (studio)', binding.refs);
    return binding.refs;
}

// ── Pool cache (§2.6) ──

let _poolCache = null;

export async function refreshPoolCache() {
    _poolCache = await listRefs();
}

/**
 * Drop the in-memory pool cache (sync, no store read, no settings side effects).
 * Call after external mutations that bypass this module's CRUD (backup import,
 * server-store migration) so the next getRefSync()/listRefs() re-reads. Unlike
 * refreshPoolCache(), this never auto-creates the refs array in settings.
 */
export function invalidatePoolCache() {
    _poolCache = null;
}

/** Synchronous access to a pool reference by id (from cache). null if cache is empty / id not found. */
export function getRefSync(id) {
    if (!_poolCache) {
        // Not initialized (or invalidated after an external mutation). Callers
        // get null silently otherwise - surface it so the call-ordering hazard
        // (reads before refreshPoolCache) is debuggable instead of a silent miss.
        warn('getRefSync: refs pool cache is not initialized; call refreshPoolCache() first');
        return null;
    }
    return _poolCache.find(r => r.id === id) || null;
}
