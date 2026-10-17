// @ts-check
/**
 * Gallery folders: album definitions for the image gallery, plus the
 * device-local view prefs (режим «Все/Папки», активный фильтр, сортировка).
 *
 * The folder list is a SMALL satellite collection (десятки записей) and rides
 * its own plain file-store file, `data/<user>/user/files/uris_gallery_folders.json`
 * — та же форма, что у prompt-шаблонов (template-file-store.js) и у сателлита
 * папок референсов. Sharding не нужен: коллекция не растёт вместе с галереей.
 * Сами КАРТОЧКИ несут `folders: string[]` в шардированном индексе
 * (gallery-index.js); удаление папки отстёгивает id от всех карточек
 * (detachFolderFromCards), а не оставляет висячие ссылки.
 *
 * Записи переиспользуют normalizeFolder-подобную форму референсов (id/name/
 * color/order) без дерева: папки галереи — плоский список. View prefs —
 * device-local настройки (как folderPrefs референсов): режим «Папки» на
 * телефоне не обязан включать режим «Папки» на десктопе.
 */

import { getCtx, saveSettings, sanitizeId, uid, log } from './core.js';
import { createFileStore } from './file-store.js';
import { FOLDER_COLOR_PALETTE } from './refs-library.js';
import { detachFolderFromCards } from './gallery-index.js';

export const GALLERY_FOLDERS_FILE_NAME = 'uris_gallery_folders.json';
export const GALLERY_FOLDERS_STORE_VERSION = 1;

const store = createFileStore({
    label: 'gallery-folders',
    name: GALLERY_FOLDERS_FILE_NAME,
    version: GALLERY_FOLDERS_STORE_VERSION,
    key: 'folders',
    empty: () => [],
    mergeWithServer: true,
});

/** Resolve the store mode (probe / load) exactly once per session. */
export function ensureGalleryFoldersReady() {
    return store.ready();
}

/** Test seam: which backend the store resolved to ('file' | 'readonly' | 'unknown'). */
export function galleryFoldersStoreMode() { return store.mode(); }

/** Await durability of queued folder file writes (import paths and tests). */
export function flushGalleryFolderWrites() {
    return store.flush();
}

function normalizeGalleryFolder(data = {}, fallbackIndex = 0) {
    return {
        id: sanitizeId(data.id) || uid(),
        name: String(data.name || 'Папка').trim() || 'Папка',
        color: typeof data.color === 'string' && /^#[0-9a-f]{6}$/i.test(data.color)
            ? data.color
            : (FOLDER_COLOR_PALETTE.length
                ? FOLDER_COLOR_PALETTE[fallbackIndex % FOLDER_COLOR_PALETTE.length]
                : '#808080'),
        order: Number.isFinite(data.order) ? data.order : 0,
    };
}

export async function listGalleryFolders() {
    if (await store.ready() !== 'file') return [];
    const records = store.snapshot();
    return (Array.isArray(records) ? records : []).map((folder, index) => normalizeGalleryFolder(folder, index));
}

export async function createGalleryFolder(name) {
    if (await store.ready() !== 'file') return null;
    const folders = await listGalleryFolders();
    const item = normalizeGalleryFolder(
        { name: String(name || 'Папка').trim() || 'Папка', order: folders.length },
        folders.length,
    );
    const created = await store.mutate(list => {
        list.push(item);
        return item;
    });
    log('Gallery folder created', created?.id);
    return created;
}

export async function updateGalleryFolder(id, patch = {}) {
    if (await store.ready() !== 'file') return null;
    const current = (await listGalleryFolders()).find(folder => folder.id === id);
    if (!current) return null;
    const next = normalizeGalleryFolder({
        ...current,
        id: current.id,
        name: patch.name !== undefined ? String(patch.name || '').trim() || 'Папка' : current.name,
        color: patch.color !== undefined ? patch.color : current.color,
        order: patch.order !== undefined ? patch.order : current.order,
    });
    return store.mutate(list => {
        const index = list.findIndex(folder => folder?.id === id);
        if (index === -1) return null;
        list[index] = next;
        return next;
    });
}

/**
 * Delete a folder definition and detach its id from every gallery card.
 * Картинки остаются в галерее — теряют только принадлежность папке.
 */
export async function deleteGalleryFolder(id) {
    if (await store.ready() !== 'file') return false;
    const existed = (await listGalleryFolders()).some(folder => folder.id === id);
    if (!existed) return false;
    await store.mutate(list => {
        const index = list.findIndex(folder => folder?.id === id);
        if (index !== -1) list.splice(index, 1);
    });
    await detachFolderFromCards(id);
    log('Gallery folder deleted', id);
    return true;
}

// ── View prefs (device-local UI state) ──
// view ('all' | 'folders'), filter ('all' | 'none' | folder id), sort папок.
// Специально живут в настройках, а не в файле: раскладка вида — состояние
// устройства, как pinned/sort у папок референсов (см. refs-library).

const GALLERY_VIEW_PREFS_KEY = 'galleryViewPrefs';
export const GALLERY_FOLDER_SORT_MODES = ['manual', 'name', 'count'];

export function normalizeGalleryViewPrefs(data = {}) {
    return {
        view: data.view === 'folders' ? 'folders' : 'all',
        filter: typeof data.filter === 'string' && data.filter ? data.filter : 'all',
        sort: GALLERY_FOLDER_SORT_MODES.includes(data.sort) ? data.sort : 'manual',
    };
}

function studioSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings) ctx.extensionSettings = {};
    const root = ctx.extensionSettings;
    if (!root.ur_image_studio || typeof root.ur_image_studio !== 'object') root.ur_image_studio = {};
    return root.ur_image_studio;
}

export function getGalleryViewPrefs() {
    const raw = studioSettings()[GALLERY_VIEW_PREFS_KEY];
    return normalizeGalleryViewPrefs(raw && typeof raw === 'object' ? raw : {});
}

export function saveGalleryViewPrefs(patch = {}) {
    const next = normalizeGalleryViewPrefs({ ...getGalleryViewPrefs(), ...patch });
    studioSettings()[GALLERY_VIEW_PREFS_KEY] = next;
    saveSettings();
    return next;
}

// ── Test-only surface ──

export function resetGalleryFoldersStoreForTests() {
    store.reset();
}
