// @ts-check
/** Native SillyTavern image-gallery storage for generated results. */
import { fetchWithTimeout } from './core.js';
import { downloadResult } from './image-transport.js';
import {
    NATIVE_IMAGE_FOLDER as NATIVE_GALLERY_FOLDER,
    canonicalizeNativeImagePath,
    nativeImagePathFromBasename,
} from './native-image-path.js';
import { formatForMime, formatForMimeOrDefault, sanitizeUploadFilename } from './st-upload-format.js';
import { optimizeReferenceImage } from './references.js';
import { isStudioActive, STUDIO_IMAGE_FOLDER } from './studio-scope.js';

export { NATIVE_GALLERY_FOLDER };

/**
 * Gallery thumbnails live in their OWN folder, never referenced by a card's
 * imagePath: gallery-index.reconcileCards auto-imports every unknown file from
 * scanned folders as a phantom card, and it scans only folders mentioned by
 * cards — this folder is never scanned, so thumbnails stay invisible to it.
 */
export const THUMBNAIL_FOLDER = 'URIS_Thumbs';
const THUMBNAIL_MAX_EDGE = 512;
const THUMBNAIL_WEBP_QUALITY = 0.78;

function getCtx() {
    return globalThis.SillyTavern?.getContext?.() ?? {};
}

function headers() {
    return { ...(getCtx().getRequestHeaders?.() ?? {}), 'Content-Type': 'application/json' };
}

/**
 * Resolve the image-storage folder for the current chat context.
 * Mirrors stable-diffusion/index.js: character name for solo chats,
 * group id for group chats, legacy folder as a safe fallback.
 * On the welcome screen (no chat open) generation lands in the dedicated
 * studio folder instead of the legacy one.
 * @returns {string}
 */
export function getCharacterImageFolder() {
    if (isStudioActive()) return STUDIO_IMAGE_FOLDER;
    const ctx = getCtx();
    if (ctx.groupId) return `group_${ctx.groupId}`;
    const name = ctx.characters?.[ctx.characterId]?.name;
    return name || NATIVE_GALLERY_FOLDER;
}

function safeFilename(name = '') {
    return sanitizeUploadFilename(name);
}

function parseDataUrl(value) {
    const match = String(value || '').match(/^data:(image\/(png|jpe?g|webp|gif));base64,([a-z0-9+/=\s]+)$/i);
    if (!match) throw new Error('Expected an image data URL');
    return { format: formatForMime(match[1]), image: match[3].replace(/\s/g, '') };
}

function bytesToBase64(bytes) {
    let binary = '';
    for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
    return btoa(binary);
}

async function blobPayload(blob) {
    const buffer = await blob.arrayBuffer();
    // Tolerant: these bytes are a paid result already in hand, and provider CDNs
    // routinely serve them as application/octet-stream or with no type at all.
    return { image: bytesToBase64(buffer), format: formatForMimeOrDefault(blob.type) };
}

/** Upload image data into the shared, ST-visible URIS gallery folder. */
export async function uploadGeneratedImage(dataUrl, { filename, ch_name, signal, timeoutMs } = {}) {
    const { image, format } = parseDataUrl(dataUrl);
    return uploadPayload({ image, format }, { filename, ch_name, signal, timeoutMs });
}

async function uploadPayload({ image, format }, { filename, ch_name, signal, timeoutMs, diagnostic } = {}) {
    let response;
    try {
        response = await fetchWithTimeout('/api/images/upload', {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ image, format, ch_name: ch_name ?? NATIVE_GALLERY_FOLDER, filename: safeFilename(filename) }),
            ...(signal === undefined ? {} : { signal }),
            ...(diagnostic ? { __urisDiagnostic: { ...diagnostic, role: 'native-upload' } } : {}),
        }, timeoutMs);
    } catch (cause) {
        if (cause?.name === 'AbortError') throw cause;
        throw new Error(`SillyTavern image upload failed: ${cause?.message || cause}`);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `SillyTavern image upload failed (${response.status})`);
    if (typeof payload?.path !== 'string' || !payload.path) throw new Error('SillyTavern image upload returned no path');
    const imagePath = canonicalizeNativeImagePath(payload.path);
    if (!imagePath) throw new Error('SillyTavern image upload returned an invalid native image path');
    return imagePath;
}

/** List safe ST-relative image paths from the dedicated native gallery folder. */
export async function listNativeImages({ signal, folder } = {}) {
    const targetFolder = folder ?? NATIVE_GALLERY_FOLDER;
    let response;
    try {
        response = await fetch('/api/images/list', {
            method: 'POST', headers: headers(), body: JSON.stringify({ folder: targetFolder }),
            ...(signal === undefined ? {} : { signal }),
        });
    } catch (cause) {
        throw new Error(`SillyTavern image list failed: ${cause?.message || cause}`);
    }
    const payload = await response.json().catch(() => []);
    if (!response.ok) throw new Error(payload?.error || `SillyTavern image list failed (${response.status})`);
    if (!Array.isArray(payload)) return [];
    return [...new Set(payload.flatMap(name => {
        if (typeof name !== 'string') return [];
        const canonical = canonicalizeNativeImagePath(name) || nativeImagePathFromBasename(name, targetFolder);
        return canonical ? [canonical] : [];
    }))];
}

async function blobMetadata(blob) {
    const type = String(blob?.type || '').toLowerCase() || null;
    let width = null;
    let height = null;
    try {
        if (typeof createImageBitmap === 'function') {
            const bitmap = await createImageBitmap(blob);
            width = Number.isFinite(bitmap.width) ? bitmap.width : null;
            height = Number.isFinite(bitmap.height) ? bitmap.height : null;
            bitmap.close?.();
        }
    } catch { /* Dimensions are diagnostic-only; preserve the result if decode is unavailable. */ }
    return { mimeType: type, bytes: Number.isFinite(blob?.size) ? blob.size : null, width, height };
}

async function materializedUpload(blob, options) {
    const metadata = await blobMetadata(blob);
    const imagePath = await uploadPayload(await blobPayload(blob), options);
    return options.withMetadata ? { imagePath, output: metadata } : imagePath;
}

/** Generate and upload a small thumbnail for an already-stored gallery image. */
export async function makeThumbnailForPath(imagePath, { filename, signal, timeoutMs, _optimize } = {}) {
    const response = await fetch(imagePath, { signal });
    if (!response.ok) throw new Error(`Thumbnail source fetch failed (${response.status})`);
    const blob = await response.blob();
    if (blob.type && !/^image\//i.test(blob.type)) throw new Error('Thumbnail source is not an image');
    const optimize = _optimize || optimizeReferenceImage;
    const optimized = await optimize(blob, {
        maxEdge: THUMBNAIL_MAX_EDGE,
        quality: THUMBNAIL_WEBP_QUALITY,
        version: `thumb-v1-${THUMBNAIL_MAX_EDGE}`,
        // Thumbs are local-only files (URIS_Thumbs is never scanned into the
        // gallery), so webp stays optimal here despite the v3 reference
        // cascade defaulting to jpeg/png for provider-bound images.
        formats: ['image/webp'],
    });
    const base = String(filename || '').replace(/\.[^.]+$/, '') || `thumb_${Date.now()}`;
    // uploadPayload sanitizes the whole filename and the server derives the
    // extension from `format` — pass a bare base name only.
    return uploadPayload(await blobPayload(optimized.blob), {
        filename: `${sanitizeUploadFilename(base)}_thumb`,
        ch_name: THUMBNAIL_FOLDER,
        signal,
        timeoutMs,
    });
}

/** Materialize a normalized provider result then upload it to the native gallery. */
export async function materializeImageResult(result, options = {}) {
    const ch_name = options.ch_name;
    if (typeof result === 'string' && result.startsWith('data:')) {
        const parsed = parseDataUrl(result);
        return materializedUpload(new Blob([Uint8Array.from(atob(parsed.image), c => c.charCodeAt(0))], { type: `image/${parsed.format}` }), options);
    }
    if (result?.kind === 'dataUrl') {
        const parsed = parseDataUrl(result.value);
        return materializedUpload(new Blob([Uint8Array.from(atob(parsed.image), c => c.charCodeAt(0))], { type: `image/${parsed.format}` }), options);
    }
    if (result?.kind === 'bytes' && result.value != null) {
        const blob = new Blob([result.value], { type: result.mimeType || 'image/png' });
        return materializedUpload(blob, { filename: options.filename, ch_name, signal: options.signal, timeoutMs: options.timeoutMs, diagnostic: options.diagnostic, withMetadata: options.withMetadata });
    }
    if (result?.kind !== 'url' || typeof result.value !== 'string') {
        throw new Error('Expected a data URL, byte result, or downloadable image URL');
    }
    const response = await downloadResult(result.value, { signal: options.signal, __urisDiagnostic: options.diagnostic }, options.timeoutMs);
    if (!response.ok) throw new Error(`Image result download failed (${response.status})`);
    return materializedUpload(await response.blob(), { filename: options.filename, ch_name, signal: options.signal, timeoutMs: options.timeoutMs, diagnostic: options.diagnostic, withMetadata: options.withMetadata });
}
