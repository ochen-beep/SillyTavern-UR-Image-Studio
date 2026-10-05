// @ts-check
/**
 * Прозрачная распаковка тел ответов (пункт 2.4 плана 2026-10-05): общий
 * извлекатель для catalog.js и providers/image-base.js, у которых кодек-таблица,
 * чтение байтов и двухфазное восстановление были продублированы.
 *
 * SillyTavern's /proxy/<url> middleware copies upstream headers verbatim but
 * node's fetch already decompresses the body upstream; when the copied
 * `Content-Encoding: gzip` header survives onto the proxy response, the
 * browser fetch layer will auto-decompress on its side too — and end up with
 * *doubly-decompressed* bytes which fail to parse as JSON. Conversely, when
 * the proxy DROPS the upstream Content-Encoding header but forwards gzip
 * bytes, the browser doesn't auto-decompress and we get raw gzip bytes (magic
 * 0x1f 0x8b at the head), shown to users as binary garbage. Either way the
 * upstream body is JSON underneath — sniff the magic bytes and decompress.
 *
 * gzip/deflate go through the Web `DecompressionStream(codec)`; zstd goes
 * through decodeZstdBytes (native DS('zstd') → fzstd polyfill). NOTE: the
 * zstd magic was mislabeled 'brotli'/'br' until 2026-08 — brotli has no
 * magic bytes at all and no browser implements DecompressionStream('br'),
 * so the old label made fuzhan's bodies undecodable (runbook 2026-07-11).
 *
 * NEVER throws — failures are swallowed and reported through the returned
 * shapes so the caller can decide whether to retry parse or give up.
 */
import { trace, warn, decodeZstdBytes } from './core.js';

export const COMPRESSED_BODY_CODECS = [
    { name: 'gzip', codec: 'gzip', match: b => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b },
    // codec: null marks "decode via decodeZstdBytes", not DecompressionStream.
    { name: 'zstd', codec: null, match: b => b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd },
    // RFC 1950 zlib: first byte's low nibble is method (8=deflate), high
    // nibble is window-log2-minus-8 (commonly 7 → 0x78); second byte is the
    // complement check so (b0*256 + b1) % 31 must equal 0.
    { name: 'deflate', codec: 'deflate', match: b => b.length >= 2 && b[0] === 0x78 && (b[0] * 256 + b[1]) % 31 === 0 },
];

export function isCompressedMagic(bytes) {
    return COMPRESSED_BODY_CODECS.some(entry => entry.match(bytes));
}

async function decodeEntry(bytes, { name, codec }) {
    if (codec === null) {
        const out = await decodeZstdBytes(bytes);
        if (out == null) {
            warn(`decompress-body: ${name} body present but no decoder succeeded`);
            return null;
        }
        return new TextDecoder('utf-8', { fatal: false }).decode(out);
    }
    if (typeof DecompressionStream !== 'function') {
        warn(`decompress-body: ${name} body present but DecompressionStream unavailable`);
        return null;
    }
    try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(codec));
        return await new Response(stream).text();
    } catch (e) {
        warn(`decompress-body: ${name} decompression threw:`, e?.message || e);
        return null;
    }
}

/** Read clone bytes binary-safe, with a lossy text fallback. @returns {Promise<{bytes:Uint8Array|null, preview:string}>} */
export async function readCloneBytes(clone) {
    if (!clone) { trace('decompress-body: no clone available'); return { bytes: null, preview: '' }; }
    try {
        const buf = typeof clone.arrayBuffer === 'function'
            ? await clone.arrayBuffer()
            : new TextEncoder().encode(await clone.text()).buffer;
        return { bytes: new Uint8Array(buf), preview: '' };
    } catch (e) {
        warn('decompress-body: arrayBuffer/text read failed:', e?.message || e);
        try { return { bytes: null, preview: (await clone.text()) || '' }; }
        catch { return { bytes: null, preview: '' }; }
    }
}

/**
 * Двухфазное восстановление текста из байтов: фаза 1 — декомпрессия по
 * магии (взаимоисключающие подписи, коммит на первом совпадении); фаза 2 —
 * оппортунистический перебор кодеков для потоков без канонической магии
 * (deflate-raw и т.п.). null — распознать не удалось.
 * @returns {Promise<{text: string, codec: string}|null>}
 */
export async function decompressBytes(bytes) {
    for (const entry of COMPRESSED_BODY_CODECS) {
        if (!entry.match(bytes)) continue;
        const decoded = await decodeEntry(bytes, entry);
        if (decoded != null) {
            trace(`decompress-body: ${entry.name} decompressed OK, len=`, decoded.length);
            return { text: decoded, codec: entry.name };
        }
        // Магия совпала, но декодировать не удалось — подписи взаимоисключающие,
        // другой кодек эти байты не заберёт: коммит на «это сжатие, которое мы
        // не прочитали».
        return null;
    }
    for (const entry of COMPRESSED_BODY_CODECS) {
        const decoded = await decodeEntry(bytes, entry);
        if (decoded != null) {
            trace(`decompress-body: ${entry.name} opportunistic decompressed OK, len=`, decoded.length);
            return { text: decoded, codec: entry.name };
        }
    }
    return null;
}

/** Lossy UTF-8 preview for diagnostics (HTML login pages, garbage, etc.). */
export function lossyPreview(bytes) {
    try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
    catch { return ''; }
}

/**
 * Текстовое восстановление из клона (потребитель image-base.readResponseText):
 * чистый текст без магии отдаётся как есть; сжатое декодируется. На неудаче —
 * lossy plain (никогда не null при читаемом клоне).
 * @returns {Promise<string|null>}
 */
export async function recoverTextFromClone(clone) {
    const { bytes } = await readCloneBytes(clone);
    if (!bytes) return null;
    const plain = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (plain && !isCompressedMagic(bytes)) return plain;
    const recovered = await decompressBytes(bytes);
    return recovered != null ? recovered.text : plain;
}

/**
 * JSON-восстановление из клона ответа (потребитель providers/image-base.js).
 * @returns {Promise<object|null>}
 */
export async function recoverJsonFromClone(clone) {
    const { bytes, preview } = await readCloneBytes(clone);
    if (!bytes) return null;
    trace('decompress-body: json bytes.length=', bytes.length, 'head=', Array.from(bytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' '));
    const plainText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    try { return JSON.parse(plainText); } catch { /* compressed or non-JSON */ }
    const recovered = await decompressBytes(bytes);
    if (recovered != null) {
        try { return JSON.parse(recovered.text); }
        catch (e) {
            warn('decompress-body: decompressed but JSON.parse failed:', e?.message || e);
            return null;
        }
    }
    void preview;
    return null;
}

/**
 * Каталожный фасад (потребитель catalog.js): текст или lossy-превью с кодеком.
 * @returns {Promise<{decoded: string|null, preview: string, codec: string|null}>}
 */
export async function tryGunzipIfMagic(clone) {
    const { bytes, preview: readPreview } = await readCloneBytes(clone);
    if (!bytes) return { decoded: null, preview: readPreview, codec: null };
    trace('decompress-body: bytes.length=', bytes.length, 'head=', Array.from(bytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' '), 'hasDS=', typeof DecompressionStream);
    const recovered = await decompressBytes(bytes);
    if (recovered != null) return { decoded: recovered.text, preview: '', codec: recovered.codec };
    // Коммитнутая магия, которую не смогли декодировать, или магии нет вовсе —
    // lossy-превью для диагностики HTML-логинок/404. Если магия была, но декодер
    // не справился, превью всё равно полезнее пустоты.
    const magicCodec = COMPRESSED_BODY_CODECS.find(entry => entry.match(bytes))?.name || null;
    trace('decompress-body: no decodable compression — emitting lossy preview, magicCodec=', magicCodec);
    return { decoded: null, preview: lossyPreview(bytes) || readPreview, codec: magicCodec };
}
