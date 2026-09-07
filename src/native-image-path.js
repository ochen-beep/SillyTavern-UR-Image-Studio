// @ts-check

export const NATIVE_IMAGE_FOLDER = 'UR Image Studio';
export const NATIVE_IMAGE_FOLDER_PATH = `user/images/${encodeURIComponent(NATIVE_IMAGE_FOLDER)}`;

function hasControls(value) {
    return /[\u0000-\u001F\u007F]/.test(value);
}

function decodeSegment(value) {
    if (typeof value !== 'string' || !value || hasControls(value) || /[\\/?#]/.test(value)) return null;
    let decoded;
    try { decoded = decodeURIComponent(value); }
    catch { return null; }
    if (!decoded || hasControls(decoded) || /[\\/?#]/.test(decoded) || decoded === '.' || decoded === '..') return null;
    if (/%(?:2f|2e|5c|25)/i.test(decoded)) return null;
    return decoded;
}

function encodeSegment(value) {
    return encodeURIComponent(value);
}

/**
 * Return one canonical ST-native image path under any single folder segment,
 * or null for untrusted input.
 *
 * Accepts `user/images/<folder>/<file>` where <folder> is any single sanitized
 * segment (matches how ST's character gallery scans user/images/<char.name>/).
 * Rejects traversal, schemes, control chars, query/fragment, nested paths.
 */
export function canonicalizeNativeImagePath(value) {
    if (typeof value !== 'string' || !value || hasControls(value) || /[\\?#]/.test(value)) return null;
    const source = value.startsWith('/') ? value.slice(1) : value;
    if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return null;
    const parts = source.split('/');
    if (parts.length !== 4 || parts[0] !== 'user' || parts[1] !== 'images') return null;
    const folder = decodeSegment(parts[2]);
    const filename = decodeSegment(parts[3]);
    if (!folder || !filename) return null;
    return `user/images/${encodeSegment(folder)}/${encodeSegment(filename)}`;
}

/**
 * Turn a single ST list basename into the canonical native image path.
 * @param {string} value - filename (with optional percent-encoding)
 * @param {string} [folder] - folder name; defaults to the legacy UR Image Studio folder
 */
export function nativeImagePathFromBasename(value, folder = NATIVE_IMAGE_FOLDER) {
    const filename = decodeSegment(value);
    if (!filename || !folder) return null;
    return `user/images/${encodeSegment(folder)}/${encodeSegment(filename)}`;
}
