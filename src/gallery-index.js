// @ts-check
/** Shared metadata-only index for images stored in the native ST gallery. */
import { getCtx, getImageConnectionSettings, IMAGE_CONNECTION_SETTINGS_KEY, uid } from './core.js';
import { listNativeImages } from './native-image-storage.js';
import { canonicalizeNativeImagePath, NATIVE_IMAGE_FOLDER } from './native-image-path.js';

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
    'hidden',
];

function settings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings) ctx.extensionSettings = {};
    if (!ctx.extensionSettings.ur_image_studio || typeof ctx.extensionSettings.ur_image_studio !== 'object') {
        ctx.extensionSettings.ur_image_studio = {};
    }
    const moduleSettings = ctx.extensionSettings.ur_image_studio;
    moduleSettings[IMAGE_CONNECTION_SETTINGS_KEY] = getImageConnectionSettings(moduleSettings);
    return moduleSettings[IMAGE_CONNECTION_SETTINGS_KEY];
}

function index() {
    const store = settings();
    if (!Array.isArray(store.galleryIndex)) store.galleryIndex = [];
    return store.galleryIndex;
}

function persist() {
    getCtx().saveSettingsDebounced?.();
}

function cleanText(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

/** Keep settings portable: recursively remove secrets, raw image payloads, and unsupported values. */
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
    const cards = index();
    const existing = typeof input?.id === 'string' ? cards.find(card => card.id === input.id) : null;
    const card = sanitizeGalleryCard(input, existing);
    if (existing) cards.splice(cards.indexOf(existing), 1, card);
    else cards.unshift(card);
    persist();
    return card;
}

export async function updateCard(id, patch) {
    const cards = index();
    const existing = cards.find(card => card.id === id);
    if (!existing) return null;
    const card = sanitizeGalleryCard({ ...existing, ...patch, id, imagePath: existing.imagePath }, existing);
    cards.splice(cards.indexOf(existing), 1, card);
    persist();
    return card;
}

export async function removeCard(id) {
    const cards = index();
    const position = cards.findIndex(card => card.id === id);
    if (position === -1) return false;
    cards.splice(position, 1);
    persist();
    return true;
}

/** Remove all metadata cards. Native image files remain untouched. */
export async function clearCards() {
    const cards = index();
    cards.splice(0, cards.length);
    persist();
}

/** Count how many cards reference the given canonical image path. */
export function countCardsByImagePath(imagePath) {
    const canonical = canonicalizeNativeImagePath(imagePath);
    if (!canonical) return 0;
    return index().filter(card => canonicalizeNativeImagePath(card.imagePath) === canonical).length;
}

export async function reconcileCards(paths = null) {
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
        const cards = index();
        const folders = new Set([NATIVE_IMAGE_FOLDER]);
        for (const card of cards) {
            const folder = decodeFolderFromPath(card.imagePath);
            if (folder) folders.add(folder);
        }
        const lists = await Promise.all([...folders].map(folder => listNativeImages({ folder }).catch(() => [])));
        nativePaths = new Set(lists.flat());
    }
    const cards = index();
    for (let i = cards.length - 1; i >= 0; i--) {
        const canonical = canonicalizeNativeImagePath(cards[i]?.imagePath);
        if (!canonical) {
            cards.splice(i, 1);
            continue;
        }
        cards[i] = sanitizeGalleryCard({ ...cards[i], imagePath: canonical, status: nativePaths.has(canonical) ? 'ready' : 'missing' }, cards[i]);
    }
    const known = new Set(cards.map(card => card.imagePath));
    for (const imagePath of nativePaths) {
        if (!known.has(imagePath)) cards.unshift(sanitizeGalleryCard({ imagePath, prompt: '', status: 'ready', provenance: 'native' }));
    }
    persist();
    return [...cards];
}

export async function listCards({ reconcile = true } = {}) {
    if (reconcile) return reconcileCards();
    return [...index()];
}
