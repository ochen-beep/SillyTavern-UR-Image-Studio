// @ts-check
/**
 * Shared `/api/images/upload` field normalization.
 *
 * SillyTavern validates `format` against its own extension whitelist
 * (MEDIA_EXTENSIONS in src/constants.js) and answers 400 "Invalid image format"
 * for anything else - it does not fall back to a default. It also strips the
 * last dot-segment from `filename` via removeFileExtension(), so a name that
 * still contains a dot silently loses part of itself.
 *
 * Both upload paths (generated results and references) need the same rules, so
 * they live here instead of being reimplemented per call site.
 */

/**
 * Image subtypes ST accepts on upload. `jpeg` is normalized to `jpg`: both are
 * whitelisted, but one spelling keeps saved filenames consistent.
 */
const UPLOAD_FORMAT_PATTERN = /^image\/(png|jpe?g|webp|gif|bmp)$/;

/**
 * Map an image MIME type to an ST-accepted upload `format`.
 *
 * Rejects unknown types up front - `image/avif` and `image/svg+xml` are real
 * browser MIME types that ST refuses, and failing here beats spending a
 * round-trip to learn it. Comparison is case-insensitive because canvas and
 * clipboard sources are not consistent about casing.
 *
 * @param {string} mime
 * @returns {string} whitelisted extension, without a dot
 * @throws {Error} when the MIME type is not an ST-supported image format
 */
export function formatForMime(mime) {
    const subtype = String(mime ?? '').trim().toLowerCase().match(UPLOAD_FORMAT_PATTERN)?.[1];
    if (!subtype) {
        throw new Error(`Unsupported image format for SillyTavern upload: ${mime || '(none)'}`);
    }
    return subtype === 'jpeg' ? 'jpg' : subtype;
}

/**
 * Same mapping, but tolerant of a missing or non-image MIME type.
 *
 * For a downloaded result the MIME comes from the provider CDN, which often
 * sends `application/octet-stream` or nothing at all. That image is already
 * paid for, so an unusable Content-Type must not lose it - assume the fallback
 * and let the upload proceed. Use this only where the bytes are known to be an
 * image from context; prefer formatForMime() when the type is self-declared.
 *
 * @param {string} mime
 * @param {string} [fallback] whitelisted extension used when mime is unusable
 * @returns {string}
 */
export function formatForMimeOrDefault(mime, fallback = 'png') {
    try {
        return formatForMime(mime);
    } catch {
        return fallback;
    }
}

/**
 * Sanitize an upload `filename`.
 *
 * Dots become underscores to match ST's own saveBase64AsFile() helper;
 * otherwise the server's removeFileExtension() would truncate at the last dot
 * and turn `ref.v2` into `ref`. Everything outside a conservative alphabet is
 * folded to `_` so no traversal or separator survives.
 *
 * @param {string} [name]
 * @param {string} [fallback] used when nothing usable remains
 * @returns {string}
 */
export function sanitizeUploadFilename(name, fallback = `uris_${Date.now()}`) {
    const base = String(name ?? '')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    return base || fallback;
}
