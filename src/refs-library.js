// @ts-check
/**
 * Reference library: global pool + folders + chat binding.
 * Replaces references-profiles.js (v3-redesign).
 * Spec: docs/archive/plans/2026-07-14-references-chat-scoped-pool.md §2.
 *
 * The pool and its folders persist in ONE server file per user,
 * `data/<user>/user/files/uris_refs.json`, not in `extensionSettings` — they are
 * user-authored data (with an unbounded `description`), and the settings blob is
 * re-POSTed wholesale on every unrelated settings change. See `src/file-store.js`
 * and `docs/plans/2026-09-12-storage-externalization.md`.
 *
 * Folder preferences (pinned / sort / hideEmpty) deliberately STAY in settings:
 * they are device-local UI state and must not travel with an import.
 */
import {
    META_KEY,
    uid, log, warn, getCtx, getImageConnectionSettings, IMAGE_CONNECTION_SETTINGS_KEY, saveSettings,
    DEFAULT_CHAT_CONFIG_ENVELOPE, deepClone,
} from './core.js';
import { imageToDataUrl } from './references.js';
import { normalizeAliases } from './scene-context.js';
import { canonicalizeNativeImagePath } from './native-image-path.js';
import { normalizeReferenceCap } from './reference-limits.js';
import { createFileStore } from './file-store.js';
import { recordDiagnosticEvent } from './diagnostic-events.js';
import { isStudioActive, getStudioBinding, saveStudioBinding } from './studio-scope.js';

export const REFS_FILE_NAME = 'uris_refs.json';
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

const refsStore = createFileStore({
    label: 'references',
    name: REFS_FILE_NAME,
    version: REFS_STORE_VERSION,
    key: 'data',
    // The pool file is edited by every device this user's data syncs to
    // (Syncthing mirror, second browser): writes must merge with the server
    // document instead of clobbering it with a possibly stale mirror.
    mergeWithServer: true,
    empty: () => ({ refs: [], folders: [] }),
    countEntries: value => (Array.isArray(value?.refs) ? value.refs.length : null),
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
export function flushRefsWritesOnUnload() {
    refsStore.flushOnUnload();
}

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

/** @deprecated Use route capabilities or an explicit collector cap. */
export const MAX_REFS = null;

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
    const item = {
        id: data.id ? String(data.id) : uid(),
        name: String(data.name || '').trim() || 'Без названия',
        aliases: uniqueStrings(normalizeAliases(data.aliases)),
        description: String(data.description || ''),
        ...(bindingMode === 'description' ? { bindingMode } : {}),
        imagePath: data.imagePath || '',
        folders: uniqueStrings(Array.isArray(data.folders) ? data.folders : []),
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

// ── Folders CRUD ──

// Folder color palette (from Figma mockup). Assigned cyclically by
// index on creation. 10 colors are enough for visual distinguishability.
export const FOLDER_COLOR_PALETTE = [
    '#4a90d9', '#d97f3a', '#3ab09e', '#c94040', '#c9a030',
    '#7a5cc9', '#c94090', '#40a060', '#a04040', '#4a70b9',
];

/** Normalize a folder record: guarantees id/name/color/order fields. */
export function normalizeFolder(data = {}, fallbackIndex = 0) {
    return {
        id: data.id ? String(data.id) : uid(),
        name: String(data.name || 'Папка').trim() || 'Папка',
        color: typeof data.color === 'string' && /^#[0-9a-f]{6}$/i.test(data.color)
            ? data.color
            : (FOLDER_COLOR_PALETTE.length
                ? FOLDER_COLOR_PALETTE[fallbackIndex % FOLDER_COLOR_PALETTE.length]
                : '#808080'),
        order: Number.isFinite(data.order) ? data.order : 0,
    };
}

export async function listFolders() {
    const records = await sharedStore().list('ref-folders');
    return Array.isArray(records) ? records.map((folder, index) => normalizeFolder(folder, index)) : [];
}

export async function createFolder(name, opts = {}) {
    const folders = await listFolders();
    const item = normalizeFolder({
        name: String(name || 'Папка').trim() || 'Папка',
        color: typeof opts.color === 'string' ? opts.color : undefined,
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
    const next = normalizeFolder({
        ...current,
        name: patch.name !== undefined ? String(patch.name || '').trim() || 'Папка' : current.name,
        color: patch.color !== undefined ? patch.color : current.color,
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
export async function deleteFolder(id) {
    const folders = await listFolders();
    if (!folders.some(folder => folder.id === id)) return;
    const store = await requireSharedStore();
    await store.delete('ref-folders', id);
    // One batch mutate: a per-reference update loop re-read and re-uploaded
    // the whole refs file once per record (2N+2 round-trips for N refs).
    await store.updateWhere('refs',
        ref => Array.isArray(ref.folders) && ref.folders.includes(id),
        ref => normalizePoolReference({ ...ref, folders: ref.folders.filter(folderId => folderId !== id) }),
    );
    const prefs = getFolderPrefs();
    if (prefs.pinned.includes(id)) saveFolderPrefs({ pinned: prefs.pinned.filter(pinnedId => pinnedId !== id) });
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

// ── Smart-matching (§2.4) ──

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function isNameInText(name, text) {
    const phrase = String(name || '').trim();
    if (phrase.length < 2) return false;
    const pattern = phrase.split(/\s+/).map(escapeRegex).join('\\s+');
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'iu');
    return re.test(String(text || ''));
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

// ── Collect: which references to send ──

/** Optional per-generation reference override. */

/**
 * Reference descriptor for sending (without fetch).
 * @typedef {Object} RefDescriptor
 * @property {string} name
 * @property {'auto'|'pinned'} [kind]
 * @property {string} [refId]
 * @property {string} [imagePath]
 */

/**
 * Resolve which references are included for the current chat. Synchronous, no fetch.
 */
function _resolveRefs(context, override, maxRefs = null) {
    if (override?.enabled === false) return [];
    const cap = normalizeReferenceCap(maxRefs ?? override?.maxRefs);
    if (cap === 0) return [];
    const chatRefs = getChatRefs();
    const text = `${context.chatText || ''} ${context.instructionText || ''}`;
    const out = [];
    const seen = new Set();
    const folderIds = chatRefs.folderIds || [];
    const folderRecords = _poolCache && folderIds.length
        ? filterRefsByFolders(_poolCache, folderIds)
        : [];
    const records = [
        ...chatRefs.referenceIds.map(refId => getRefSync(refId)).filter(Boolean),
        ...folderRecords,
    ];
    for (const ref of records) {
        if (cap !== null && out.length >= cap) break;
        if (!ref?.imagePath || seen.has(ref.id)) continue;
        seen.add(ref.id);
        if (!(ref.aliases || []).some(alias => isNameInText(alias, text))) continue;
        out.push({ id: ref.id, refId: ref.id, name: ref.name, imagePath: ref.imagePath });
    }
    return out;
}

/**
 * Collect references for the current chat (with fetch dataUrl) — for pipeline.
 */
export async function collectRefsForCurrentChat(context = {}, override = null, maxRefs = null) {
    const cap = normalizeReferenceCap(maxRefs ?? override?.maxRefs);
    const descriptors = _resolveRefs(context, override, cap);
    if (!descriptors.length) { log('References collected: 0'); return []; }
    const refs = [];
    for (const d of descriptors) {
        let dataUrl = null;
        try { dataUrl = await imageToDataUrl(d.imagePath); } catch { /* ignore individual failures */ }
        if (dataUrl) refs.push({ id: d.id || d.refId || '', image: dataUrl, name: d.name });
    }
    log(`References collected: ${refs.length}`);
    return cap === null ? refs : refs.slice(0, cap);
}

export function previewRefsForCurrentChat(context = {}, override = null, maxRefs = null) {
    return _resolveRefs(context, override, maxRefs);
}

