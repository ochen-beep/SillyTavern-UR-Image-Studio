// @ts-check
/**
 * Image utilities: user avatars, compression, server upload.
 * Reference collection logic lives in refs-library.js (v3-redesign).
 */
import { getCtx, log, warn } from './core.js';
import { canonicalizeNativeImagePath } from './native-image-path.js';
import { autoFetch } from './proxy.js';
import { formatForMime, sanitizeUploadFilename } from './st-upload-format.js';
import { makeThumbnailForPath } from './native-image-storage.js';
import { MAX_REFERENCE_BYTES_PER_IMAGE, MAX_REFERENCE_BYTES_TOTAL } from './reference-limits.js';

export async function imageToDataUrl(url, options = {}) {
    try {
        const resp = await fetch(url, { method: 'GET', signal: options.signal });
        // Protection against 404/HTML error pages: the ST proxy on a missing avatar
    // returns HTML (resp.ok=false or Content-Type: text/html), and without this
    // check FileReader would encode the body as data:text/html, producing a
    // "broken" reference that later fails optimizeReferenceImage ("not an image data URL").
    // Degrade to null so the slot is silently skipped, as intended for a missing avatar.
        if (!resp.ok) return null;
        const contentLength = Number(resp.headers?.get?.('content-length'));
        if (Number.isFinite(contentLength) && contentLength > MAX_REFERENCE_BYTES_PER_IMAGE) {
            const error = new Error('Reference image exceeds the per-image materialization budget.');
            error.code = 'REFERENCE_TOO_LARGE';
            throw error;
        }
        const blob = await resp.blob();
        if (!blob.type || !/^image\//i.test(blob.type)) return null;
        if (blob.size > MAX_REFERENCE_BYTES_PER_IMAGE) {
            const error = new Error('Reference image exceeds the per-image materialization budget.');
            error.code = 'REFERENCE_TOO_LARGE';
            throw error;
        }
        return await blobToDataUrlAbortable(blob, options.signal);
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        if (error?.code === 'REFERENCE_TOO_LARGE') throw error;
        return null;
    }
}

function blobToDataUrlAbortable(blob, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }
        const reader = new FileReader();
        const abort = () => {
            reader.abort?.();
            reject(new DOMException('Aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        reader.onloadend = () => {
            signal?.removeEventListener('abort', abort);
            if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError'));
            else resolve(reader.result);
        };
        reader.onerror = () => {
            signal?.removeEventListener('abort', abort);
            reject(reader.error || new Error('Could not read reference image'));
        };
        reader.readAsDataURL(blob);
    });
}

export function dataUrlToBase64(d) {
    const i = (d || '').indexOf(',');
    return i >= 0 ? d.slice(i + 1) : d;
}

export async function getUserAvatarDataUrl(userAvatarFile) {
    if (!userAvatarFile) return null;
    return await imageToDataUrl(`/User Avatars/${encodeURIComponent(userAvatarFile)}`);
}

export async function fetchUserAvatars() {
    try {
        const r = await fetch('/api/avatars/get', {
            method: 'POST',
            headers: getCtx().getRequestHeaders(),
        });
        return r.ok ? await r.json() : [];
    } catch { return []; }
}

// ── Data URL helpers ──

export function dataUrlMimeType(d) {
    const m = (d || '').match(/^data:([^;]+);/);
    return m ? m[1] : 'image/png';
}

/**
 * Diagnostic summary of one materialized reference: name + MIME + approximate
 * decoded size in KB. Deliberately excludes the dataUrl itself — the panel log
 * should show whether a reference physically exists and how heavy it is, never
 * dump pixel data or private content. `mime: 'invalid'` flags a ref whose
 * dataUrl is missing or not a data: URL (e.g. an optimize/upload that produced
 * garbage), which a bare `count` would happily hide.
 *
 * @param {{name?:string, id?:string, dataUrl?:string}|string} ref
 * @returns {{name:string, mime:string, kb:number}}
 */
export function summarizeReference(ref) {
    const dataUrl = typeof ref === 'string' ? ref : ref?.dataUrl;
    const name = (typeof ref === 'object' && ref && (ref.name || ref.id)) || '(unnamed)';
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        return { name, mime: 'invalid', kb: 0 };
    }
    const b64 = dataUrlToBase64(dataUrl);
    const bytes = Math.floor((b64.length * 3) / 4);
    return { name, mime: dataUrlMimeType(dataUrl), kb: Math.round(bytes / 1024) };
}

export async function dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return await res.blob();
}

export async function dataUrlToFile(dataUrl, filename) {
    const blob = await dataUrlToBlob(dataUrl);
    return new File([blob], filename, { type: blob.type || dataUrlMimeType(dataUrl) });
}

// ── Reference image optimization ──

// v3: webp removed from the default candidate set. Relay upstreams behind
// OpenAI-compatible gateways (adobe2banana, incident 2026-09-08) reject webp
// at a content validator ("Image edit file content does not match its declared
// MIME type", HTTP 400) even though the browser encodes it correctly. The bump
// also documents the contract change for anything that compares versions.
export const OPTIMIZATION_VERSION = 'ref-v3-1024';
export const MAX_EDGE = 1024;
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
export const WEBP_PHOTO_QUALITY = 0.82;
export const WEBP_ALPHA_QUALITY = 0.88;
export const JPEG_QUALITY = 0.85;

// webp deliberately absent: an original webp file must not slip onto the wire
// through the source pass-through (sourceCanWin) — the same relay validators
// reject it. Gallery thumbnails pin webp explicitly via options.formats;
// they are local-only files and never reach a provider.
const CANONICAL_MIMES = new Set(['image/png', 'image/jpeg']);

function imageError(message) {
    return new Error(`optimizeReferenceImage: ${message}`);
}

function validDimension(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function validQuality(value) {
    return typeof value === 'number' && value > 0 && value < 1;
}

/** Resolve an output version label for the effective optimization parameters. */
function resolveVersion(options, maxEdge) {
    if (typeof options.version === 'string' && options.version.trim()) return options.version.trim();
    return maxEdge === MAX_EDGE ? OPTIMIZATION_VERSION : `${OPTIMIZATION_VERSION}-${maxEdge}`;
}

async function inputToBlob(input) {
    if (typeof input === 'string') {
        if (!/^data:image\//i.test(input)) throw imageError('input must be an image input');
        return dataUrlToBlob(input);
    }
    if (typeof Blob !== 'undefined' && input instanceof Blob) return input;
    throw imageError('input must be a File, Blob, or image data URL');
}

export async function blobToDataUrl(blob) {
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(imageError('could not read optimized image'));
        reader.readAsDataURL(blob);
    });
}

async function decodeBrowserBlob(blob) {
    if (typeof createImageBitmap === 'function') {
        try {
            return await createImageBitmap(blob);
        } catch { /* WebKit may expose it but reject a supported image. */ }
    }
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    let settled = false;
    const release = () => {
        if (settled) return;
        settled = true;
        image.onload = null;
        image.onerror = null;
        image.src = '';
        URL.revokeObjectURL(objectUrl);
    };
    try {
        await new Promise((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(imageError('could not decode image'));
            image.src = objectUrl;
        });
        return {
            width: image.naturalWidth || image.width,
            height: image.naturalHeight || image.height,
            image,
            close: release,
        };
    } catch (error) {
        release();
        throw error;
    }
}

function nativeCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

function canvasBlob(canvas, mime, quality) {
    return new Promise(resolve => canvas.toBlob(resolve, mime, quality));
}

export const __testOnly = { decodeBrowserBlob };

function hasAlpha(context, width, height) {
    const pixels = context.getImageData(0, 0, width, height).data;
    for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] !== 255) return true;
    }
    return false;
}

/**
 * Browser-native reference optimizer. Browser encoder/EXIF behavior is left to
 * the platform decoder and must be manually checked on target browsers. Node
 * tests use the _test seam instead of emulating a browser DOM.
 *
 * Options: maxEdge caps the long edge (default MAX_EDGE=1024), quality /
 * qualityAlpha override the opaque/alpha encoder quality, version overrides
 * the reported optimizationVersion label (thumbnails use their own label so
 * reference re-optimization never matches on them).
 */
export async function optimizeReferenceImage(input, options = {}) {
    const seam = options._test || {};
    let bitmap = null;
    let canvas = null;
    try {
        const maxEdge = validDimension(options.maxEdge) ? options.maxEdge : MAX_EDGE;
        const webpPhotoQuality = validQuality(options.quality) ? options.quality : WEBP_PHOTO_QUALITY;
        const webpAlphaQuality = validQuality(options.qualityAlpha) ? options.qualityAlpha : WEBP_ALPHA_QUALITY;
        const jpegQuality = validQuality(options.quality) ? options.quality : JPEG_QUALITY;
        const source = await inputToBlob(input);
        const sourceMime = String(source.type || '').toLowerCase();
        if (!/^image\//.test(sourceMime)) throw imageError('input must be an image input');
        if (source.size > MAX_INPUT_BYTES) throw imageError('input is too large');

        const decode = seam.decode || decodeBrowserBlob;
        bitmap = await decode(source);
        const sourceWidth = bitmap.width;
        const sourceHeight = bitmap.height;
        if (!validDimension(sourceWidth) || !validDimension(sourceHeight)) throw imageError('invalid image dimensions');
        const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));

        canvas = (seam.createCanvas || nativeCanvas)(width, height);
        const context = canvas?.getContext?.('2d', { willReadFrequently: true });
        if (!context) throw imageError('could not create canvas context');
        context.drawImage(bitmap.image || bitmap, 0, 0, width, height);
        const alpha = hasAlpha(context, width, height);
        // Receiver-safe default (v3): jpeg for opaque, png for alpha — the same
        // formats ComfyUI/SillyTavern-adjacent tools send. options.formats pins
        // an explicit set for callers with different constraints (thumbnails
        // keep webp: local files, never uploaded to providers).
        const formats = Array.isArray(options.formats) && options.formats.length
            ? options.formats
            : (alpha ? ['image/png'] : ['image/jpeg']);
        const qualityForMime = (mime) => (mime === 'image/webp'
            ? (alpha ? webpAlphaQuality : webpPhotoQuality)
            : (mime === 'image/jpeg' ? jpegQuality : undefined));
        const candidates = formats.map(mime => [mime, qualityForMime(mime)]);
        const encode = seam.toBlob || ((mime, quality) => canvasBlob(canvas, mime, quality));
        const valid = [];
        for (const [mime, quality] of candidates) {
            try {
                const candidate = await encode(mime, quality);
                if (!candidate || candidate.size <= 0 || String(candidate.type).toLowerCase() !== mime) continue;
                const decoded = await decode(candidate);
                try {
                    if (decoded.width !== width || decoded.height !== height) continue;
                } finally { decoded.close?.(); }
                valid.push(candidate);
            } catch { /* Continue through the MIME fallback chain. */ }
        }
        const candidate = valid.sort((a, b) => a.size - b.size)[0] || null;
        const sourceCanWin = scale === 1 && CANONICAL_MIMES.has(sourceMime) && candidate && source.size < candidate.size;
        const selected = sourceCanWin ? source : candidate;
        if (!selected) throw imageError('no compatible image encoder is available');
        const mime = String(selected.type).toLowerCase();
        // [refs] instrumentation: which format actually reaches the wire and
        // why (kept until the 2026-09-08 webp/400 incident is confirmed fixed).
        log(`[refs] optimize: source ${sourceMime} ${source.size}B scale=${scale.toFixed(3)} → ${mime} ${selected.size}B (sourceCanWin=${selected === source}, formats=[${formats.join(', ')}])`);
        return {
            dataUrl: await (seam.blobToDataUrl || blobToDataUrl)(selected),
            blob: selected,
            mime,
            width,
            height,
            sourceBytes: source.size,
            optimizedBytes: selected.size,
            optimizationVersion: resolveVersion(options, maxEdge),
        };
    } catch (error) {
        throw error instanceof Error && error.message.startsWith('optimizeReferenceImage:')
            ? error : imageError(error?.message || 'could not optimize image');
    } finally {
        bitmap?.close?.();
        if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
}

// ── Wire-copy fitting for body-limited connections ──
//
// Некоторые шлюзы держат API за nginx с дефолтным client_max_body_size 1 МиБ
// (наблюдено байт-в-байт на apiddt.com 2026-10-06: тело 1048576 Б → 400,
// 1048577 Б → 413). Референс в JSON-теле едет как data URL и стоит ×4/3 от
// бинарного размера, поэтому один жирный PNG выталкивает тело за лимит, хотя
// тот же рисунок JPEG'ом помещается с запасом.
//
// Подгонка — только WIRE-TIME: каноничный референс в сторе остаётся PNG с
// альфой, и провайдеры без выученного лимита получают ровно то, что получали
// раньше. ponytail: флаттен в JPEG — единственный ярус; даунскейл ниже maxEdge
// добавляем, только если какой-то провайдер отвергнет полностью сплощённое тело.

/** Slack JSON-конверта вокруг data URL (model/prompt/size/n/скобки). */
const WIRE_FIT_OVERHEAD_BYTES = 4096;

/**
 * Оценка размера JSON-тела диспетча с этими референсами. data URL — это и есть
 * base64-представление в теле, так что .length точен; промпт меряем байтами.
 */
export function wireBodyBytes(references, prompt = '') {
    const promptBytes = new TextEncoder().encode(String(prompt || '')).length;
    let bytes = WIRE_FIT_OVERHEAD_BYTES + promptBytes;
    for (const reference of references || []) bytes += reference?.dataUrl?.length || 0;
    return bytes;
}

/**
 * Перекодировать один референс в JPEG на белой подложке. Потеря альфы здесь —
 * сам смысл операции (платим прозрачностью за размер тела). Возвращает НОВЫЙ
 * объект в форме parseDataUrl; вход нетронут.
 */
export async function flattenReferenceToJpeg(reference, { maxEdge = MAX_EDGE, quality = JPEG_QUALITY } = {}) {
    const source = await inputToBlob(reference.dataUrl);
    const decoded = await decodeBrowserBlob(source);
    try {
        const scale = Math.min(1, maxEdge / Math.max(decoded.width, decoded.height));
        const width = Math.max(1, Math.round(decoded.width * scale));
        const height = Math.max(1, Math.round(decoded.height * scale));
        const canvas = nativeCanvas(width, height);
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(decoded.image || decoded, 0, 0, width, height);
        const blob = await canvasBlob(canvas, 'image/jpeg', quality);
        const dataUrl = await blobToDataUrl(blob);
        return { ...reference, dataUrl, mimeType: 'image/jpeg', data: dataUrlToBase64(dataUrl) };
    } finally {
        decoded.close?.();
    }
}

/**
 * Подогнать набор референсов под бюджет тела соединения, сплощая сначала
 * самые тяжёлые PNG. Возвращает НОВЫЙ массив или null, когда набор и так
 * влезает (частый случай: лимит не выучен или референсы мелкие). Альфа
 * выживает на каждом референсе, которому флаттен не понадобился.
 * `options.flatten` — тестовый шов, как в ingestReferenceImage.
 */
export async function fitReferencesToWireBudget(references, budgetBytes, prompt = '', { flatten = flattenReferenceToJpeg, maxEdge = MAX_EDGE } = {}) {
    if (!Array.isArray(references) || !references.length) return null;
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) return null;
    if (wireBodyBytes(references, prompt) <= budgetBytes) return null;
    const fitted = [...references];
    const flattenOrder = fitted
        .map((reference, index) => ({ reference, index }))
        .filter(({ reference }) => reference?.mimeType === 'image/png')
        .sort((a, b) => b.reference.dataUrl.length - a.reference.dataUrl.length);
    for (const { index } of flattenOrder) {
        if (wireBodyBytes(fitted, prompt) <= budgetBytes) break;
        fitted[index] = await flatten(fitted[index], { maxEdge });
    }
    return fitted;
}

// ── Server upload ──

export async function uploadReferenceImage(dataUrl, filename, subfolder = 'URIS_Refs') {
    const ctx = getCtx();
    const format = formatForMime(dataUrlMimeType(dataUrl));
    const base64Data = dataUrlToBase64(dataUrl);
    const safeFilename = sanitizeUploadFilename(filename, 'ref');
    const r = await fetch('/api/images/upload', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ image: base64Data, format, ch_name: subfolder, filename: safeFilename }),
    });
    if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || `Reference upload failed: ${r.status}`);
    }
    const result = await r.json();
    // ST answers with a raw, unencoded path, so a subfolder like a character name
    // arrives with its spaces intact. Canonicalize once here: every consumer then
    // gets a path that is safe to put in markup and encoded exactly one time.
    const imagePath = canonicalizeNativeImagePath(result?.path);
    if (!imagePath) {
        throw new Error(`Reference upload returned an unusable path: ${result?.path || '(none)'}`);
    }
    log('Reference uploaded:', imagePath);
    return imagePath;
}

/**
 * Optimize and upload one reference image, returning the fields refs-library
 * persists: the ST path plus the optimizer's own metadata.
 *
 * Every reference entering the pool should carry its dimensions and byte sizes.
 * That metadata is what lets the pool show real sizes and re-optimize later when
 * OPTIMIZATION_VERSION moves, so a caller that uploads a raw data URL directly
 * gets a working path but a metadata-less record — the pool silently loses that
 * ability for exactly those images.
 *
 * `optimize`/`upload` are injectable so tests can assert the call order without
 * a canvas or a server.
 *
 * @param {string|Blob} input Data URL or blob, optimized before upload.
 * @param {string} filename
 * @returns {Promise<{imagePath:string, metadata:Object}>}
 */
export async function ingestReferenceImage(input, filename, {
    optimize,
    upload,
    thumb,
    subfolder = 'URIS_Refs',
} = {}) {
    const result = await (optimize || optimizeReferenceImage)(input);
    const imagePath = await (upload || uploadReferenceImage)(result.dataUrl, filename, subfolder);
    // Pool tiles decode the full edge-1024 file on every scroll frame: a small
    // server-side thumbnail keeps large pools cheap. Best-effort — a failed
    // thumbnail leaves the record on the full-image fallback, never fails the
    // ingest. Rides in `metadata` so every caller's existing spread persists it.
    let thumbPath = null;
    try {
        thumbPath = await (thumb || makeThumbnailForPath)(imagePath, { filename: `ref_${filename}` }) || null;
    } catch { /* thumbnails are an optimization, never a gate */ }
    return {
        imagePath,
        metadata: {
            mime: result.mime,
            width: result.width,
            height: result.height,
            sourceBytes: result.sourceBytes,
            optimizedBytes: result.optimizedBytes,
            optimizationVersion: result.optimizationVersion,
            ...(thumbPath ? { thumbPath } : {}),
        },
    };
}

// ── Scene-first reference materialization ──

/**
 * Send-time MIME normalization. References stored before v3 may be image/webp,
 * which several relayed upstreams reject at a content validator (HTTP 400
 * "Image edit file content does not match its declared MIME type" — adobe2banana,
 * incident 2026-09-08). Re-encode webp to jpeg (opaque) or png (alpha) right
 * before dispatch; anything else passes through untouched. No resizing — the
 * stored file is already edge-1024 optimized. Any encoder failure returns the
 * original data URL: sending a possibly-rejected webp is strictly better than
 * dropping the reference.
 *
 * @param {string} dataUrl
 * @param {{ signal?: AbortSignal, _test?: object }} [options]
 * @returns {Promise<string>}
 */
export async function normalizeReferenceDataUrl(dataUrl, options = {}) {
    const mime = dataUrlMimeType(dataUrl);
    if (mime !== 'image/webp') return dataUrl;
    const seam = options._test || {};
    try {
        const source = await (seam.dataUrlToBlob || dataUrlToBlob)(dataUrl);
        const decode = seam.decode || decodeBrowserBlob;
        const bitmap = await decode(source);
        const width = bitmap.width;
        const height = bitmap.height;
        if (!validDimension(width) || !validDimension(height)) throw imageError('invalid image dimensions');
        const canvas = (seam.createCanvas || nativeCanvas)(width, height);
        const context = canvas?.getContext?.('2d', { willReadFrequently: true });
        if (!context) throw imageError('could not create canvas context');
        context.drawImage(bitmap.image || bitmap, 0, 0, width, height);
        bitmap.close?.();
        const alpha = hasAlpha(context, width, height);
        const targetMime = alpha ? 'image/png' : 'image/jpeg';
        const encode = seam.toBlob || ((m, q) => canvasBlob(canvas, m, q));
        const blob = await encode(targetMime, alpha ? undefined : JPEG_QUALITY);
        if (!blob || blob.size <= 0 || String(blob.type).toLowerCase() !== targetMime) {
            throw imageError('re-encode produced no usable blob');
        }
        const out = await (seam.blobToDataUrl || blobToDataUrl)(blob);
        log(`[refs] send-normalize: image/webp → ${targetMime} (${source.size}B → ${blob.size}B)`);
        return out;
    } catch (error) {
        warn(`[refs] send-normalize failed, отправляю оригинал (image/webp): ${error?.message || error}`);
        return dataUrl;
    }
}

/**
 * Load image data URLs for the Stage 2 references in a SceneContextSnapshot.
 * Preserves snapshot order. Throws if a selected reference image cannot be loaded.
 *
 * @param {import('./scene-context.js').SceneContextSnapshot} snapshot
 * @returns {Promise<Array<{id:string,name:string,label?:string,description?:string,bindingMode?:string,dataUrl:string}>>}
 */
export async function materializeStage2References(snapshot, options = {}) {
    const refs = (snapshot?.stage2Refs || []).filter(ref => ref?.bindingMode !== 'description');
    const out = [];
    let totalBytes = 0;
    const deadline = Number.isFinite(options.deadline) ? options.deadline : Date.now() + (options.timeoutMs || 60000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    const relayAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', relayAbort, { once: true });
    try {
        for (const ref of refs) {
            if (controller.signal.aborted) {
                const error = new DOMException('Reference materialization aborted or timed out', 'AbortError');
                error.code = Date.now() >= deadline ? 'REFERENCE_MATERIALIZATION_TIMEOUT' : 'REFERENCE_MATERIALIZATION_ABORTED';
                throw error;
            }
            let dataUrl;
            try {
                dataUrl = await loadReferenceImage(ref.imagePath, {
                    signal: controller.signal,
                    timeoutMs: Math.max(1, deadline - Date.now()),
                });
            } catch (error) {
                if (error?.name === 'AbortError') {
                    const timedOut = Date.now() >= deadline;
                    error.code = timedOut ? 'REFERENCE_MATERIALIZATION_TIMEOUT' : 'REFERENCE_MATERIALIZATION_ABORTED';
                }
                throw error;
            }
            if (!dataUrl) {
                const label = ref.name || ref.id || '(unnamed)';
                // Typed and actionable: the most common cause is the file being
                // deleted outside the extension (manual cleanup, ST's Data Maid,
                // which cannot see the pool's references). The run stops — the
                // user explicitly attached this reference — but the message
                // names the exact card to fix instead of failing generically.
                const error = new Error(`Файл референса не найден: ${label} (${ref.imagePath || 'нет пути'}). Возможно, файл удалён вне расширения — например, встроенной уборкой Data Maid.`);
                error.code = 'REFERENCE_FILE_MISSING';
                throw error;
            }
            // v3: re-encode stored webp refs before the byte budget is computed
            // and before any provider sees them (multipart, JSON edits, Gemini
            // inline all consume this dataUrl). No-op for v3+ refs.
            dataUrl = await normalizeReferenceDataUrl(dataUrl, { signal: options.signal });
            if (controller.signal.aborted) {
                const error = new DOMException('Reference materialization aborted or timed out', 'AbortError');
                error.code = 'REFERENCE_MATERIALIZATION_ABORTED';
                throw error;
            }
            const comma = dataUrl.indexOf(',');
            const encoded = comma >= 0 ? dataUrl.slice(comma + 1).replace(/\s/g, '') : '';
            const bytes = encoded ? Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0) : 0;
            if (bytes > MAX_REFERENCE_BYTES_PER_IMAGE) {
                const error = new Error('Reference image exceeds the per-image materialization budget.');
                error.code = 'REFERENCE_TOO_LARGE';
                throw error;
            }
            totalBytes += bytes;
            if (totalBytes > MAX_REFERENCE_BYTES_TOTAL) {
                const error = new Error('Reference images exceed the aggregate materialization budget.');
                error.code = 'REFERENCE_BYTE_BUDGET_EXCEEDED';
                throw error;
            }
            out.push({
                id: ref.id,
                name: ref.name,
                label: ref.matchedLabel || ref.name || `reference ${out.length + 1}`,
                description: ref.description || '',
                bindingMode: ref.bindingMode || 'image',
                dataUrl,
            });
        }
        return out;
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', relayAbort);
    }
}

/**
 * A path served by the ST server itself, reachable without CORS.
 *
 * Canonical native paths are stored root-relative WITHOUT a leading slash
 * (`user/images/<folder>/<file>`), so testing for a slash alone would classify
 * every canonicalized reference as remote and hand it to autoFetch — where
 * hostnameOf() treats the whole relative string as a hostname and CORS-proxy
 * machinery gets applied to a local file. Accept both spellings: anything that
 * canonicalizes is by definition an ST-served path.
 */
function isSameOriginPath(path) {
    if (typeof path !== 'string' || !path) return false;
    if (path.startsWith('/')) return true;
    return canonicalizeNativeImagePath(path) !== null;
}

/**
 * Load a reference image as a data URL, regardless of where it lives.
 *
 * Same-origin ST paths are read directly. Remote URLs cannot be: the browser
 * blocks a cross-origin fetch of a provider CDN (observed as
 * `Access to fetch ... blocked by CORS policy` on aipro.hk.cn), and this
 * happens BEFORE the paid POST, so the whole generation dies on a reference
 * that is otherwise perfectly valid. Route those through the ST proxy instead.
 *
 * @param {string} imagePath Same-origin ST path or an absolute remote URL.
 * @returns {Promise<string|null>} Data URL, or null when unreadable.
 */
export async function loadReferenceImage(imagePath, options = {}) {
    const path = String(imagePath || '');
    if (!path) return null;
    const timeoutMs = Math.max(1, Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const relayAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', relayAbort, { once: true });
    try {
        if (isSameOriginPath(path)) return await imageToDataUrl(path, { signal: controller.signal });
        const response = await autoFetch(path, { method: 'GET', signal: controller.signal }, timeoutMs);
        if (!response.ok) return null;
        const contentLength = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(contentLength) && contentLength > MAX_REFERENCE_BYTES_PER_IMAGE) {
            const error = new Error('Reference image exceeds the per-image materialization budget.');
            error.code = 'REFERENCE_TOO_LARGE';
            throw error;
        }
        const blob = await response.blob();
        if (!blob.type || !/^image\//i.test(blob.type)) return null;
        if (blob.size > MAX_REFERENCE_BYTES_PER_IMAGE) {
            const error = new Error('Reference image exceeds the per-image materialization budget.');
            error.code = 'REFERENCE_TOO_LARGE';
            throw error;
        }
        return await blobToDataUrlAbortable(blob, options.signal);
    } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'REFERENCE_TOO_LARGE') throw error;
        warn('references: proxy fetch failed for remote reference', error?.message || error);
        return null;
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', relayAbort);
    }
}

/**
 * Import a remote reference into ST storage once, returning a durable
 * same-origin path.
 *
 * Provider CDN URLs are frequently temporary signed links
 * (`...?token=...`), so persisting one as a long-lived `imagePath` produces a
 * reference that silently rots. Callers that accept a remote URL should
 * localize it at save time and store the returned path instead.
 *
 * @param {string} remoteUrl
 * @param {string} filename
 * @returns {Promise<string>} Same-origin ST path.
 */
export async function localizeRemoteReference(remoteUrl, filename) {
    const dataUrl = await loadReferenceImage(remoteUrl);
    if (!dataUrl) throw new Error(`Reference image could not be downloaded: ${remoteUrl}`);
    const optimized = await optimizeReferenceImage(dataUrl);
    return uploadReferenceImage(optimized.dataUrl, filename);
}
