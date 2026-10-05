// @ts-check
/**
 * Lazy dimension probe for gallery cards.
 *
 * The PhotoSwipe viewer needs width/height before opening (open animation,
 * layout). Fresh generations carry top-level width/height (written by
 * image-api.js at materialization), but legacy cards and reconcile-imported
 * cards (`provenance: 'native'`) do not. The probe decodes the image once and
 * persists the dimensions on the card, so each image is fetched at most once
 * per card lifetime.
 */
import { updateGalleryEntry } from './storage.js';

/**
 * Fallback for undecodable images: the viewer requires *some* size to open.
 * The loaded image still renders correctly inside the (slightly wrong) box.
 */
export const FALLBACK_DIMENSIONS = { width: 1024, height: 1024 };

function validDimension(value) {
    return Number.isFinite(value) && value > 0;
}

/** Known dimensions on a card, or null when missing/partial/invalid. */
export function cardDimensions(item) {
    const width = Number(item?.width);
    const height = Number(item?.height);
    if (validDimension(width) && validDimension(height)) return { width, height };
    return null;
}

// ── Resolution shortfall (пункт 1.2 плана 2026-10-05) ──────────────────────
//
// Провайдеры молча уронили тир разрешения: запрос 4K вернул 1024×1024
// (nano-gpt nano-banana-pro, 2026-10-05 01:01 UTC) — пользователь платит за
// 4K, получает 1K, и ни один пост-чек этого не видел (проверялись только
// пропорции). Пороги — эмпирика фактических выдач той сессии; 4K взят
// консервативно (реальные 4K-слоты ≈ 16 МП), чтобы не плодить ложных
// срабатываний на нестандартных выдачах.

const RESOLUTION_TIER_MIN_MP = new Map([
    ['1K', 0.80], // фактические 1K-выдачи: 1024×1536=1.57, 1280×720=0.92
    ['2K', 2.0],  // фактические 2K-выдачи: 2752×1536=4.23
    ['4K', 6.0],  // реальные 4K-слоты ≈ 16 МП; консервативный порог
]);

/**
 * Detect a silent resolution downgrade: the returned pixel count is below the
 * requested tier's expected minimum. Pure; null when there is nothing to
 * judge (unknown dimensions, unknown/absent tier) or the area is in range.
 *
 * @param {number|null|undefined} width
 * @param {number|null|undefined} height
 * @param {string|null|undefined} imageSize requested tier ('1K'|'2K'|'4K')
 * @returns {{tier:string, megapixels:number, minMegapixels:number}|null}
 */
export function resolutionShortfall(width, height, imageSize) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    const tier = String(imageSize ?? '').trim().toUpperCase();
    const minMegapixels = RESOLUTION_TIER_MIN_MP.get(tier);
    if (!minMegapixels) return null;
    const megapixels = (width * height) / 1_000_000;
    if (megapixels >= minMegapixels) return null;
    return { tier, megapixels, minMegapixels };
}

async function decodeImageDimensions(url, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (blob.type && !/^image\//i.test(blob.type)) throw new Error('not an image response');
    if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(blob);
        try {
            return { width: bitmap.width, height: bitmap.height };
        } finally { bitmap.close?.(); }
    }
    // Fallback decoder for engines exposing createImageBitmap but rejecting a
    // supported image (WebKit) — mirrors decodeBrowserBlob in references.js.
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    try {
        await new Promise((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('could not decode image'));
            image.src = objectUrl;
        });
        return { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height };
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

/**
 * Resolve card dimensions, probing (and persisting) them when unknown.
 * Works for id-less items too (single-image opens from References and
 * Generation): the probe still runs, only the persist step is skipped.
 * Never throws for a broken image: degrades to FALLBACK_DIMENSIONS so the
 * viewer can still open. AbortError propagates — the caller owns cancellation.
 *
 * @param {string} chatId
 * @param {{id?:string, src?:string, width?:number, height?:number}} item
 * @param {{signal?:AbortSignal, _probe?:Function, _persist?:Function}} [options] test seams
 * @returns {Promise<{width:number, height:number}>}
 */
export async function ensureCardDimensions(chatId, item, options = {}) {
    const known = cardDimensions(item);
    if (known) return known;
    if (!item?.src) return FALLBACK_DIMENSIONS;
    const probe = options._probe || decodeImageDimensions;
    const persist = options._persist || (item.id ? ((id, dims) => updateGalleryEntry(chatId, id, dims)) : null);
    try {
        const dims = await probe(item.src, options.signal);
        if (!validDimension(dims?.width) || !validDimension(dims?.height)) return FALLBACK_DIMENSIONS;
        const clean = { width: dims.width, height: dims.height };
        item.width = clean.width;
        item.height = clean.height;
        if (persist && item.id) {
            try { await persist(item.id, clean); } catch { /* dimensions are an optimization, never a feature gate */ }
        }
        return clean;
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        return FALLBACK_DIMENSIONS;
    }
}
