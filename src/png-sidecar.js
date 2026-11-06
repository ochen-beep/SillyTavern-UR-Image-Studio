// @ts-check
/**
 * PNG sidecar (phase 4 of the Data-Maid plan): generation metadata rides the
 * image file itself as an uncompressed iTXt chunk with keyword `URIS`
 * (UTF-8 JSON — tEXt is latin-1-only, prompts are not). The file stays a
 * valid PNG: iTXt is a standard ancillary chunk every decoder skips or reads.
 *
 * Что это даёт: картинку можно перенести/переслать — промпт и параметры едут
 * с ней; индекс галереи теоретически восстановим из самих файлов.
 * Потолок (ponytail): только PNG (JPEG/WebP без tEXt-контейнера молча
 * пропускаются); читатель пока использует только тест — UI импорта позже.
 */

const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const KEYWORD = 'URIS';
/** ponytail: абсурдные метаданные не таскаем — потолок одним числом. */
const MAX_JSON_BYTES = 60_000;

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function itxtChunk(keyword, text) {
    const kw = new TextEncoder().encode(keyword);
    const body = new TextEncoder().encode(text);
    // keyword \0 flag(0) method(0) language\0 translated\0 text
    const data = new Uint8Array(kw.length + 5 + body.length);
    data.set(kw, 0);
    data.set(body, kw.length + 5);
    const chunk = new Uint8Array(12 + data.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    chunk.set(new TextEncoder().encode('iTXt'), 4);
    chunk.set(data, 8);
    view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
    return chunk;
}

/**
 * Append the URIS iTXt chunk right after IHDR. Non-PNG input (or a payload
 * past the ceiling) comes back untouched — the sidecar never breaks an upload.
 * @param {Blob} blob
 * @param {object} meta compact, JSON-serializable (caller's job to strip secrets)
 * @returns {Promise<Blob>}
 */
export async function embedUrisSidecar(blob, meta) {
    if (blob?.type !== 'image/png' || !meta || typeof meta !== 'object') return blob;
    const json = JSON.stringify(meta);
    if (!json || json.length > MAX_JSON_BYTES) return blob;
    const buf = new Uint8Array(await blob.arrayBuffer());
    if (buf.length < 8 || PNG_SIG.some((b, i) => buf[i] !== b)) return blob;
    const ihdrLen = new DataView(buf.buffer, buf.byteOffset).getUint32(8);
    const insertAt = 8 + 12 + ihdrLen;
    if (insertAt > buf.length) return blob;
    const chunk = itxtChunk(KEYWORD, json);
    const out = new Uint8Array(buf.length + chunk.length);
    out.set(buf.subarray(0, insertAt), 0);
    out.set(chunk, insertAt);
    out.set(buf.subarray(insertAt), insertAt + chunk.length);
    return new Blob([out], { type: 'image/png' });
}

/**
 * Read the URIS iTXt chunk back. Returns the parsed object or null (no chunk,
 * not a PNG, compressed iTXt — we never write those).
 * @param {Blob|ArrayBuffer|Uint8Array} source
 */
export async function readUrisSidecar(source) {
    const buf = source instanceof Blob
        ? new Uint8Array(await source.arrayBuffer())
        : source instanceof ArrayBuffer ? new Uint8Array(source) : source;
    if (!buf || buf.length < 8 || PNG_SIG.some((b, i) => buf[i] !== b)) return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let pos = 8;
    while (pos + 8 <= buf.length) {
        const len = view.getUint32(pos);
        const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
        const dataStart = pos + 8;
        if (dataStart + len > buf.length) return null; // corrupt — stop
        if (type === 'iTXt') {
            const data = buf.subarray(dataStart, dataStart + len);
            let i = data.indexOf(0);
            if (i > 0 && new TextDecoder().decode(data.subarray(0, i)) === KEYWORD) {
                if (data[i + 1] !== 0) return null; // compressed — not ours
                // skip method, language tag, translated keyword
                i = data.indexOf(0, i + 3);
                if (i < 0) return null;
                i = data.indexOf(0, i + 1);
                if (i < 0) return null;
                try { return JSON.parse(new TextDecoder().decode(data.subarray(i + 1))); }
                catch { return null; }
            }
        }
        if (type === 'IEND') return null;
        pos = dataStart + len + 4; // + CRC
    }
    return null;
}
