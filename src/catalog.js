// @ts-check
import { CONTRACTS, normalizeRouteContract, stripSecrets } from './image-connection-schema.js';
import { normalizeReferenceCap } from './reference-limits.js';
import { proxiedFetch as defaultProxiedFetch, isCorsOrNetworkError } from './proxy.js';
import { tunnelBypassHeaders } from './tunnel-bypass.js';
import { trace, warn, decodeZstdBytes } from './core.js'

const IMAGE_MODEL = /(?:^|[\/_-])(?:gpt-image|dall-e|imagen|gemini[^/]*image|image)(?:[\/_-]|$)/i;

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function versionedUrl(endpoint, version = 'v1') {
    const url = new URL(text(endpoint));
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = /\/v\d+(?:beta)?$/i.test(path) ? path : `${path}/${version}`.replace(/\/+/g, '/');
    return url;
}

/** Versioned base URL for an endpoint (adds /v1 when absent). Test/probe seam. */
export function buildVersionedUrl(endpoint, version = 'v1') {
    return versionedUrl(endpoint, version);
}

function openRouterUrl(endpoint) {
    const url = new URL(text(endpoint));
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = path === '' ? '/api/v1' : path;
    return url;
}

function pollinationsUrl(endpoint, suffix) {
    const url = new URL(text(endpoint));
    let path = url.pathname.replace(/\/+$/, '');
    path = path.replace(/\/v1$/i, '');
    url.pathname = `${path}${suffix}`.replace(/\/+/g, '/');
    url.search = '';
    url.hash = '';
    return url;
}

/** Public Pollinations image catalog URL. */
export function buildPollinationsModelsUrl(endpoint) {
    return pollinationsUrl(endpoint, '/image/models');
}

/** NanoGPT image catalog URL. */
export function buildNanoGptImageModelsUrl(endpoint) {
    const url = new URL(text(endpoint));
    let path = url.pathname.replace(/\/+$/, '');
    // Accept endpoints pasted with the chat base (/v1) or the API base
    // (/api/v1) — the image catalog hangs off the bare origin.
    path = path.replace(/(?:\/api)?\/v1$/i, '');
    url.pathname = `${path}/api/v1/images/models`.replace(/\/+/g, '/');
    url.search = '';
    url.hash = '';
    return url;
}

function naisteraUrl(endpoint, suffix) {
    const url = new URL(text(endpoint));
    let path = url.pathname.replace(/\/+$/, '');
    // Accept endpoints pasted with a trailing /api; generation and catalog
    // both hang off the bare origin.
    path = path.replace(/\/api$/i, '');
    url.pathname = `${path}${suffix}`.replace(/\/+/g, '/');
    url.search = '';
    url.hash = '';
    return url;
}

/** Token-scoped Naistera model catalog URL. */
export function buildNaisteraModelsUrl(endpoint) {
    return naisteraUrl(endpoint, '/api/models');
}

function routeFor({ modelId, label, source, generationContract, likelyImage, capabilities, remoteMetadata }) {
    return normalizeRouteContract({
        source,
        modelId,
        label: label || modelId,
        generationContract,
        capabilities: capabilities || { generate: 'unknown', references: 'unknown', edit: 'unknown' },
        ...(remoteMetadata ? { remoteMetadata } : {}),
        bodyKind: 'json',
        proxyEligible: false,
        directCors: 'required',
        likelyImage,
    });
}

const MODEL_METADATA_KEYS = new Set([
    'id', 'name', 'displayName', 'title', 'category', 'output_modalities',
    'capabilities', 'resolutions', 'quality', 'supported_parameters',
    'supportedParameters', 'max_reference_images', 'maxReferences',
    'supports_references', 'supportsReferences', 'reference_images_supported',
    'referenceImagesSupported', 'references_supported', 'referencesSupported', 'references',
    'media_kind', 'mediaKind', 'kind',
]);

function boundedModelMetadata(item) {
    const source = stripSecrets(item && typeof item === 'object' && !Array.isArray(item) ? item : {});
    const output = {};
    for (const key of MODEL_METADATA_KEYS) {
        if (!(key in source)) continue;
        const value = source[key];
        if (typeof value === 'string') output[key] = value.slice(0, 256);
        else if (typeof value === 'boolean') output[key] = value;
        else if (typeof value === 'number' && Number.isFinite(value)) output[key] = value;
        else if (Array.isArray(value)) output[key] = value.slice(0, 64).filter(item => typeof item === 'string').map(item => item.slice(0, 128));
    }
    return output;
}

function readModels(payload, key, bounded = false) {
    const values = key === '__array'
        ? (Array.isArray(payload) ? payload : (Array.isArray(payload?.models) ? payload.models : []))
        : (Array.isArray(payload?.[key]) ? payload[key] : []);
    return values.map(item => {
        const descriptor = bounded ? boundedModelMetadata(item) : stripSecrets(item && typeof item === 'object' && !Array.isArray(item) ? item : {});
        const raw = text(descriptor.id || descriptor.name);
        const modelId = raw.replace(/^models\//, '');
        return modelId ? {
            ...descriptor,
            modelId,
            label: text(descriptor.displayName || descriptor.title) || modelId,
        } : null;
    }).filter(Boolean);
}

function pollinationsImageModel(model) {
    const category = text(model?.category).toLowerCase();
    const outputs = Array.isArray(model?.output_modalities) ? model.output_modalities.map(value => text(value).toLowerCase()) : [];
    return category === 'image' || outputs.includes('image') || outputs.includes('images');
}

function pollinationsRouteData(model) {
    const supportedParameters = Array.isArray(model?.capabilities)
        ? model.capabilities.filter(value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)).slice(0, 64)
        : (Array.isArray(model?.supported_parameters)
            ? model.supported_parameters.filter(value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)).slice(0, 64)
            : null);
    const rawMax = model?.max_reference_images ?? model?.maxReferences;
    const maxReferences = Number.isSafeInteger(rawMax) && rawMax >= 0 ? normalizeReferenceCap(rawMax) : null;
    const resolutions = Array.isArray(model?.resolutions)
        ? model.resolutions.filter(value => typeof value === 'string' && /^(1k|2k|480p|720p|768p|1080p)$/i.test(value)).map(value => value.toLowerCase()).slice(0, 16)
        : null;
    const qualityValues = Array.isArray(model?.quality)
        ? model.quality.filter(value => typeof value === 'string' && /^(standard|hd|low|medium|high)$/i.test(value)).map(value => value.toLowerCase()).slice(0, 8)
        : null;
    return {
        capabilities: {
            generate: 'unknown',
            references: 'unsupported',
            edit: 'unsupported',
            ...(supportedParameters ? { supportedParameters } : {}),
            ...(resolutions?.length ? { imageSizes: resolutions } : {}),
            ...(qualityValues?.length ? { qualityValues } : {}),
            ...(maxReferences !== null ? { maxReferences } : {}),
        },
        remoteMetadata: {
            providerName: 'Pollinations',
            catalogSource: '/image/models',
            generationUnverified: true,
        },
    };
}

/**
 * Map a Naistera /api/models record onto route capability data.
 *
 * Reference support is per-model (NovelAI-style models run without
 * references), and video models are marked via their media kind. The exact
 * field names come from the API response; several spellings are accepted
 * because the provider's public docs only describe shapes at marketing level.
 */
function naisteraRouteData(model) {
    const referenceCapability = modelReferenceCapability(model);
    const mediaKind = modelMediaKind(model);
    return {
        capabilities: {
            generate: 'unknown',
            references: referenceCapability.references,
            edit: 'unsupported',
            ...(referenceCapability.maxReferences !== undefined && referenceCapability.maxReferences !== null
                ? { maxReferences: referenceCapability.maxReferences } : {}),
        },
        remoteMetadata: {
            providerName: 'Naistera',
            catalogSource: '/api/models',
            ...(mediaKind ? { mediaKind } : {}),
            generationUnverified: true,
        },
    };
}

/** Keep only image models (video generation is out of scope for URIS routes). */
function naisteraImageModel(model) {
    const kind = text(model?.media_kind ?? model?.mediaKind ?? model?.kind).toLowerCase();
    if (kind) return kind === 'image';
    return true;  // no declared media kind → assume image; video models declare themselves
}

function modelMediaKind(model) {
    const kind = text(model?.media_kind ?? model?.mediaKind ?? model?.kind).toLowerCase();
    return kind === 'video' ? 'video' : kind === 'image' ? 'image' : null;
}

function modelReferenceCapability(model) {
    const rawMax = model?.max_reference_images ?? model?.maxReferences;
    if (Number.isSafeInteger(rawMax) && rawMax >= 0) {
        const maxReferences = normalizeReferenceCap(rawMax);
        return { references: maxReferences === 0 ? 'unsupported' : 'supported', maxReferences };
    }
    const explicit = model?.supports_references ?? model?.supportsReferences
        ?? model?.reference_images_supported ?? model?.referenceImagesSupported
        ?? model?.references_supported ?? model?.referencesSupported
        ?? (typeof model?.references === 'boolean' ? model.references : undefined);
    if (typeof explicit === 'boolean') return { references: explicit ? 'supported' : 'unsupported' };
    return { references: 'unknown' };
}

/** Safe per-model metadata used by the authenticated Naistera probe. */
export function boundedNaisteraModel(item) {
    const metadata = boundedModelMetadata(item);
    const modelId = text(metadata.id || metadata.name).replace(/^models\//, '');
    if (!modelId) return null;
    return {
        modelId,
        label: text(metadata.displayName || metadata.title) || modelId,
        ...modelReferenceCapability(metadata),
        ...(modelMediaKind(metadata) ? { mediaKind: modelMediaKind(metadata) } : {}),
    };
}

/**
 * Render a human-readable error from the upstream CORS failure returned by
 * the browser when the provider does not grant cross-origin access from ST.
 *
 * The browser's TypeError("Failed to fetch") is opaque (no status, no body),
 * so without help the user is left with no clue why discovery won't progress.
 * We report which host refused the cross-origin GET and explain the two paths
 * forward: either enable CORS on the provider (its ACAO/ACAH headers), or
 * opt the connection card into the ST CORS proxy via the checkbox.
 *
 * @param {string} url Upstream URL we attempted.
 * @param {Error} cause Original TypeError from the browser fetch.
 * @returns {Error}
 */
function explainCorsBlock(url, cause) {
    let host = url;
    try { host = new URL(url).host; } catch { /* keep raw */ }
    const error = new Error(
        `Direct browser fetch to "${host}" was blocked by CORS (the provider did not send permissive Access-Control-Allow-Origin/Headers, or sent duplicate values). ` +
        `Enable CORS on the provider, or set "Через CORS-прокси ST" on this connection card to route discovery through the SillyTavern server proxy.`,
    );
    error.cause = cause;
    error.code = 'CATALOG_CORS_BLOCK';
    return error;
}

/**
 * Surface a JSON parse failure on a 2xx catalog response as a friendly error
 * instead of bubbling the raw `SyntaxError("Unexpected token < in JSON ...")`
 * up to the UI.
 *
 * This commonly happens when the ST `/proxy/<url>` route returns a 200 OK with
 * an HTML body — either ST's own login redirect (when the session cookie has
 * expired) or a 404 HTML fallback on misconfigured deployments (e.g. when
 * `enableCorsProxy` is `false` but the route is intercepted by a static
 * middleware before the gated handler). The browser's `Response.json()` then
 * throws an opaque "Unexpected token < in JSON at position 0" which is exactly
 * the "неожиданный токен / невалидный json" shown to users today; without this
 * wrapper they get no hint that the problem is upstream routing, not the key.
 *
 * @param {Response} response
 * @param {string} preview Body snippet cloned before the failed read (best-effort).
 * @param {Error} cause The raw SyntaxError from Response.json().
 * @returns {Error}
 */
function explainCatalogBodyParseFailure(response, preview, cause) {
    const status = response?.status ?? 200;
    let contentType = null;
    try {
        if (response?.headers?.get) contentType = response.headers.get('content-type') || null;
    } catch { /* best-effort */ }
    const looksHtml = /<!doctype|<html/i.test(preview || '');
    const fragment = looksHtml
        ? `Upstream returned an HTML page (not JSON) at HTTP ${status}. The ST /proxy/ discovery route likely served the login/404 page — verify that enableCorsProxy: true is set in config.yaml and that your ST session is still logged in.`
        : `Upstream returned a non-JSON body at HTTP ${status}${contentType ? ` (Content-Type: ${contentType})` : ''}.`;
    const lead = preview
        ? ` First line: ${preview.split('\n', 1)[0].slice(0, 200)}`
        : ' Body was empty.';
    const error = new Error(`Model discovery failed: ${fragment}${lead}`);
    error.cause = cause;
    error.code = 'CATALOG_PARSE_FAILURE';
    return error;
}

/**
 * Render a helpful error message from an upstream catalog response.
 *
 * The body of a non-OK upstream response usually carries the real reason
 * ("Invalid token", "Invalid API key", expired quota, etc.) as JSON:
 *     {"error":{"message":"Invalid token ...","type":"new_api_error"}}
 * Surfacing this directly lets the user act on a wrong/expired key rather
 * than guessing at the opaque "Model catalog returned HTTP 400" wrapper
 * (status only — ST's CORS proxy additionally rewrites 401 to 400 to avoid
 * clobbering the browser's Basic-auth dialog, which strips the auth signal).
 *
 * @param {Response} response
 * @returns {Promise<Error>}
 */
async function readFailureText(response) {
    if (!response) return '';
    const clone = typeof response.clone === 'function' ? response.clone() : null;
    if (clone && typeof clone.arrayBuffer === 'function') {
        try {
            const bytes = new Uint8Array(await clone.arrayBuffer());
            const plain = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            const compressed = bytes.length >= 2 && ((bytes[0] === 0x1f && bytes[1] === 0x8b)
                || (bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd)
                || (bytes[0] === 0x78 && bytes.length >= 2 && (bytes[0] * 256 + bytes[1]) % 31 === 0));
            if (!compressed && plain) return plain;
            let decoded = null;
            if (bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
                const out = await decodeZstdBytes(bytes);
                if (out) decoded = new TextDecoder('utf-8', { fatal: false }).decode(out);
            } else if (typeof DecompressionStream === 'function') {
                const codec = bytes[0] === 0x1f && bytes[1] === 0x8b ? 'gzip' : 'deflate';
                const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(codec));
                decoded = await new Response(stream).text();
            }
            if (decoded != null) return decoded;
            if (plain) return plain;
        } catch { /* fallback to the live response stream */ }
    }
    try { return typeof response.text === 'function' ? await response.text() : ''; }
    catch { return ''; }
}

async function explainCatalogFailure(response) {
    const status = response.status;
    // 400 with no body usually means ST-proxy's 401→400 rewrite — treat it
    // as an authentication failure unless the upstream body says otherwise.
    const isAuthShaped = status === 400 || status === 401 || status === 403;
    let detail = '';
    try {
        detail = await readFailureText(response);
    } catch { /* best-effort */ }
    let upstreamMessage = '';
    if (detail) {
        try {
            const parsed = JSON.parse(detail);
            const msg = parsed?.error?.message || parsed?.message || parsed?.error;
            if (typeof msg === 'string' && msg.trim()) upstreamMessage = msg.trim();
        } catch { /* non-JSON body — fall through to raw extraction */ }
        if (!upstreamMessage) {
            // Bare text error line — keep it if it looks like a single concise line.
            const line = detail.split('\n', 1)[0].trim();
            if (line && line.length <= 200) upstreamMessage = line;
        }
    }
    const fragments = [
        `Model discovery failed (HTTP ${status})`,
        isAuthShaped && !upstreamMessage ? 'Endpoint rejected the API key (upstream returned an auth error). Check the connection card Key field — URIS keeps image-connection keys in its own browser-local store, separate from the Connection Manager secrets.' : '',
        upstreamMessage ? `Endpoint: ${upstreamMessage}` : '',
    ].filter(Boolean);
    const error = new Error(fragments.join(' '));
    error.httpStatus = Number.isSafeInteger(status) ? status : null;
    if (status === 401) {
        error.code = 'AUTH_INVALID';
        error.reauthRequired = true;
    } else if (status === 403) {
        error.code = 'AUTH_EXPIRED';
        error.reauthRequired = true;
    }
    return error;
}

// ── Truncated-stream salvage ──
//
// NanoGPT's image catalog (chunked transfer) is cut by the server ~70s in:
// reader.read() rejects mid-body and response.json() would discard every
// entry already received. readBodyJson therefore reads the stream manually
// and, on a genuine network truncation (never after an abort/timeout),
// salvages the complete JSON objects received before the cut.

function concatBytes(chunks) {
    let length = 0;
    for (const chunk of chunks) length += chunk.byteLength;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
    return out;
}

/**
 * Yield every complete top-level {...} object literal from a (possibly
 * truncated) JSON array body. String-aware: braces inside quoted values do
 * not open or close entries.
 */
function* completeJsonObjects(body) {
    let depth = 0, start = -1, inString = false, escape = false;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (inString) {
            if (escape) escape = false;
            else if (ch === '\\') escape = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') { if (depth === 0) start = i; depth++; }
        else if (ch === '}') {
            if (depth > 0 && --depth === 0 && start >= 0) {
                yield body.slice(start, i + 1);
                start = -1;
            }
        }
    }
}

// Matches the probe's catalog cap (connect-probe MAX_MODEL_IDS).
const SALVAGE_ENTRY_LIMIT = 500;

/** Salvage a usable payload (openai/gemini/array shape) from a truncated JSON text. */
function salvageTruncatedCatalog(text) {
    const candidates = [];
    const dataMatch = /"data"\s*:\s*\[/.exec(text);
    if (dataMatch) candidates.push({ key: 'data', body: text.slice(text.indexOf('[', dataMatch.index)) });
    const modelsMatch = /"models"\s*:\s*\[/.exec(text);
    if (modelsMatch) candidates.push({ key: 'models', body: text.slice(text.indexOf('[', modelsMatch.index)) });
    const trimmed = text.trimStart();
    if (trimmed.startsWith('[')) candidates.push({ key: null, body: trimmed });
    for (const candidate of candidates) {
        if (!candidate.body.startsWith('[')) continue;
        const entries = [];
        for (const literal of completeJsonObjects(candidate.body.slice(1))) {
            if (entries.length >= SALVAGE_ENTRY_LIMIT) break;
            try { entries.push(JSON.parse(literal)); } catch { /* malformed tail — skip */ }
        }
        if (entries.length) {
            if (!candidate.key) return entries;
            return { object: 'list', [candidate.key]: entries, salvaged: true };
        }
    }
    return null;
}

/**
 * Read a catalog response body as JSON. Falls back to response.json() when
 * no stream reader exists (test fakes, exotic hosts); otherwise accumulates
 * chunks manually so a mid-body disconnect still yields the entries that
 * arrived before the cut.
 */
async function readBodyJson(response, timeoutMs, externalSignal) {
    const reader = response?.body?.getReader ? response.body.getReader() : null;
    if (!reader) return await response.json();
    const chunks = [];
    let streamError = null;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
    } catch (error) {
        streamError = error;
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(concatBytes(chunks));
    try {
        return JSON.parse(text);
    } catch (parseError) {
        if (streamError?.name === 'AbortError') {
            if (externalSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
            const timeout = new Error(`Таймаут (${Math.round(timeoutMs / 1000)}с)`);
            timeout.code = 'CATALOG_TIMEOUT';
            throw timeout;
        }
        if (streamError) {
            const salvaged = salvageTruncatedCatalog(text);
            if (salvaged) {
                const count = Array.isArray(salvaged) ? salvaged.length : (salvaged.data || salvaged.models || []).length;
                warn(`request: поток каталога оборвался; salvaged ${count} полных записей`);
                return salvaged;
            }
            throw streamError;
        }
        throw parseError;
    }
}

/**
 * Send a catalog GET request.
 *
 * Delivery policy (configurable per-call so the connection card can choose
 * deterministically, instead of always auto-falling back):
 *   - mode === 'auto' (default, preserves historical behaviour): try direct
 *     fetch; on a CORS/network TypeError fall back to the ST CORS proxy.
 *   - mode === 'proxy': skip the direct attempt and route through the ST
 *     CORS proxy immediately (provider has no CORS and the user opted in).
 *   - mode === 'direct': never use the proxy. On a CORS/network failure
 *     throw a descriptive error so the user knows to enable CORS or switch
 *     the card to auto/proxy mode. No silent proxying.
 *
 * @param {URL|string} url
 * @param {string} apiKey
 * @param {function} fetcher
 * @param {function} proxiedFetcher
 * @param {object} headers
 * @param {number} timeoutMs
 * @param {AbortSignal} [externalSignal]
 * @param {'auto'|'proxy'|'direct'} [mode='auto']
 */
async function request(url, apiKey, fetcher, proxiedFetcher, headers, timeoutMs, externalSignal, mode = 'auto') {    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const options = {
        method: 'GET',
        // Tunnel consent-page bypass (loca.lt 511 / ngrok ERR_NGROK_6024):
        // injected first so caller-supplied headers win. Covers BOTH delivery
        // modes — connect-probe fetches direct with raw globalThis.fetch, and
        // the ST /proxy/ middleware forwards request headers verbatim.
        headers: {
            ...tunnelBypassHeaders(url),
            ...headers,
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: controller.signal,
    };
    // We do NOT try to steer the upstream Content-Encoding here:
    // Accept-Encoding is a forbidden fetch header, so the browser silently
    // drops it — the proxy never even sees it (evidence: the 2026-08-06
    // fuzhan probe still received a compressed body while this header was
    // being set). Compressed bodies are decoded at read time instead — see
    // tryGunzipIfMagic below (gzip/deflate via DecompressionStream, zstd via
    // decodeZstdBytes: native DS('zstd') → vendored fzstd polyfill).
    try {
        let response;
        if (mode === 'proxy') {
            // Opt-in: skip the direct attempt entirely.
            response = await proxiedFetcher(url, options, timeoutMs);
        } else try {
            response = await fetcher(url, options);
        } catch (error) {
            if (error?.name === 'AbortError') {
                if (externalSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
                throw new Error(`Таймаут (${Math.round(timeoutMs / 1000)}с)`);
            }
            if (!isCorsOrNetworkError(error)) throw error;
            if (mode === 'direct') throw explainCorsBlock(typeof url === 'string' ? url : url.toString(), error);
            response = await proxiedFetcher(url, options, timeoutMs);
        }
        if (!response.ok) throw await explainCatalogFailure(response);
        // Clone before any read so a JSON parse failure can still pull the raw
        // body for diagnostics (Response.json() consumes the stream on throw).
        const diagnosticClone = typeof response.clone === 'function' ? response.clone() : null;
        try {
            return await readBodyJson(response, timeoutMs, externalSignal);
        } catch (parseError) {
            if (parseError?.code === 'CATALOG_TIMEOUT' || parseError?.name === 'AbortError') throw parseError;
            // ST's /proxy/<url> middleware copies upstream headers verbatim but
            // node's fetch already decompresses the body upstream; when the
            // copied `Content-Encoding: gzip` header survives onto the proxy
            // response, the browser fetch layer will auto-decompress on its
            // side too — and end up with *doubly-decompressed* bytes which fail
            // to parse as JSON. Conversely, when the proxy DROPS the upstream
            // Content-Encoding header but forwards gzip bytes, the browser
            // doesn't auto-decompress and we get raw gzip bytes (magic 0x1f
            // 0x8b at the head), shown to users as binary garbage. Either way
            // the upstream /v1/models body is JSON underneath — try to
            // decompress a gzip-magic-cloned body via the Web
            // DecompressionStream before raising the verbose parse-failure
            // error.
            trace('request: response.json() threw, attempting compression recovery');
            const recovered = await tryGunzipIfMagic(diagnosticClone);
            if (recovered.decoded != null) {
                try { return JSON.parse(recovered.decoded); }
                catch /* decoded but still non-JSON */ { /* fall through to PARSE_FAILURE */ }
                const preview = recovered.decoded.split('\n', 1)[0].slice(0, 200);
                const cause = new Error(`decompressed body was not valid JSON. First line: ${preview}`);
                cause.cause = parseError;
                throw explainCatalogBodyParseFailure(response, recovered.decoded, cause);
            }
            throw explainCatalogBodyParseFailure(response, recovered.preview || '', parseError);
        }
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Catalog request machinery (mode-aware delivery, auth injection, compression
 * recovery, friendly failures) — exported for connect-probe.js, which layers
 * auth-strategy and body-shape detection on top of it.
 */
export { request as catalogRequest };

/**
 * Best-effort decompression of a non-JSON catalog response body.
 *
 * Sniffs for the transport compressions Cloudflare / nginx / similar
 * front-ends add when ST's `/proxy/<url>` forwards upstream bytes with the
 * Content-Encoding header hidden:
 *   * gzip    → magic 0x1f 0x8b           (RFC 1952)
 *   * zstd    → magic 0x28 0xb5 0x2f 0xfd (RFC 8878) — fuzhan.magicv4.ltd
 *   * deflate → zlib wrapper 0x78 + (sum%31==0) (RFC 1950)
 *
 * gzip/deflate go through the Web `DecompressionStream(codec)`; zstd goes
 * through decodeZstdBytes (native DS('zstd') → fzstd polyfill). NOTE: the
 * zstd magic was mislabeled 'brotli'/'br' until 2026-08 — brotli has no
 * magic bytes at all and no browser implements DecompressionStream('br'),
 * so the old label made fuzhan's bodies undecodable (runbook 2026-07-11).
 * For each magic that matches we return the decompressed text; the caller
 * still has to JSON.parse it. Otherwise we emit a lossy UTF-8 preview for
 * HTML/login-page diagnostics.
 *
 * NEVER throws — failures are swallowed and reported through the returned
 * shape so the caller can decide whether to retry parse, give up with
 * PARSE_FAILURE, etc.
 *
 * @param {Response|null} clone
 * @returns {Promise<{decoded: string|null, preview: string, codec: string|null}>}
 */
const COMPRESS_CODECS = [
    { name: 'gzip', codec: 'gzip', match: b => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b },
    // codec: null marks "decode via decodeZstdBytes", not DecompressionStream.
    { name: 'zstd', codec: null, match: b => b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd },
    // RFC 1950 zlib: first byte's low nibble is method (8=deflate), high
    // nibble is window-log2-minus-8 (commonly 7 → 0x78); second byte is the
    // complement check so (b0*256 + b1) % 31 must equal 0.
    { name: 'deflate', codec: 'deflate', match: b => b.length >= 2 && b[0] === 0x78 && (b[0] * 256 + b[1]) % 31 === 0 },
];

async function decodeEntry(bytes, { codec }) {
    if (codec === null) {
        const out = await decodeZstdBytes(bytes);
        return out == null ? null : new TextDecoder('utf-8', { fatal: false }).decode(out);
    }
    if (typeof DecompressionStream !== 'function') return null;
    try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(codec));
        return await new Response(stream).text();
    } catch { return null; }
}

async function tryGunzipIfMagic(clone) {
    if (!clone) { trace('gunzip: no clone available'); return { decoded: null, preview: '', codec: null }; }
    // Prefer arrayBuffer() (binary-safe) but fall back to text() for hosts
    // that only implement the text decode hook (test fakes, ancient proxies).
    let bytes;
    try {
        const buf = typeof clone.arrayBuffer === 'function'
            ? await clone.arrayBuffer()
            : new TextEncoder().encode(await clone.text()).buffer;
        bytes = new Uint8Array(buf);
    } catch (e) {
        warn('gunzip: arrayBuffer/text read failed:', e?.message || e);
        // Last-resort lossy text preview if neither hook is callable.
        try { return { decoded: null, preview: (await clone.text()) || '', codec: null }; }
        catch { return { decoded: null, preview: '', codec: null }; }
    }
    // Compact hex of first up-to-8 bytes for one-line diagnostics (so we can
    // tell from the URIS log whether the body actually was gzip / zstd / a
    // login HTML page / etc. — invaluable when reproing proxy issues offline).
    const headHex = Array.from(bytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    trace('gunzip: bytes.length=', bytes.length, 'head=', headHex, 'hasDS=', typeof DecompressionStream);
    // Phase 1 — magic-matched decompression. Each codec's signature check
    // is O(1) and consumes nothing on misses. The magics are mutually
    // exclusive, so on a match we commit to that codec (decoded or not).
    for (const entry of COMPRESS_CODECS) {
        if (!entry.match(bytes)) continue;
        const decoded = await decodeEntry(bytes, entry);
        if (decoded != null) {
            trace(`gunzip: ${entry.name} decompressed OK, len=`, decoded.length, 'head=', decoded.slice(0, 80));
            return { decoded, preview: '', codec: entry.name };
        }
        warn(`gunzip: ${entry.name} magic present but decode failed`);
        let preview;
        try { preview = new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
        catch { preview = ''; }
        return { decoded: null, preview, codec: entry.name };
    }
    // Phase 2 — opportunistic fallback. Rare encoders emit valid compression
    // streams whose first bytes don't match the magic above (e.g.
    // deflate-raw). The body already failed JSON.parse, so trying each codec
    // costs at most three quick decode attempts. This mirrors
    // readJsonResponse's recovery path so catalog discovery and generation
    // both survive compressed bodies without a conventional signature.
    for (const entry of COMPRESS_CODECS) {
        const decoded = await decodeEntry(bytes, entry);
        if (decoded != null) {
            trace(`gunzip: ${entry.name} opportunistic decompressed OK, len=`, decoded.length);
            return { decoded, preview: '', codec: entry.name };
        }
    }
    // No known compression magic AND none of the opportunistic codecs could
    // decode the bytes — best-effort UTF-8 preview for HTML login / 404
    // diagnostics. Surfaces ST's /proxy/ login redirect to the user.
    trace('gunzip: no compression magic — emitting lossy preview');
    try { return { decoded: null, preview: new TextDecoder('utf-8', { fatal: false }).decode(bytes), codec: null }; }
    catch { return { decoded: null, preview: '', codec: null }; }
}

/** Discover models without making generation or provider-specific capability probes. */
export async function discoverCatalog({ endpoint, apiKey = '', contract, timeoutMs = 120000, signal, fetch: fetcher = globalThis.fetch, proxiedFetch = defaultProxiedFetch, corsMode = 'auto' } = {}) {
    if (typeof fetcher !== 'function') throw new TypeError('fetch is required for catalog discovery');
    if (typeof proxiedFetch !== 'function') throw new TypeError('proxiedFetch is required for catalog discovery');
    if (!Object.values(CONTRACTS).includes(contract)) throw new TypeError('An explicit route contract is required');
    const mode = corsMode === 'proxy' || corsMode === 'direct' ? corsMode : 'auto';

    let url;
    let source;
    let models;
    if (contract === CONTRACTS.POLLINATIONS_IMAGES) {
        url = buildPollinationsModelsUrl(endpoint);
        const payload = await request(url, '', fetcher, proxiedFetch, {}, timeoutMs, signal, mode);
        source = 'pollinations-image-models';
        models = readModels(payload, '__array', true).filter(pollinationsImageModel);
    } else if (contract === CONTRACTS.NAISTERA) {
        url = buildNaisteraModelsUrl(endpoint);
        // The catalog is token-scoped (unlike Pollinations' public one): a
        // successful read also proves the bearer token itself, so the probe
        // can report the connection as verified rather than unverified.
        const payload = await request(url, apiKey, fetcher, proxiedFetch, {}, timeoutMs, signal, mode);
        source = 'naistera-models';
        models = readModels(payload, '__array', true).filter(naisteraImageModel);
    } else if (contract === CONTRACTS.GEMINI_NATIVE) {
        url = versionedUrl(endpoint);
        url.pathname += '/models';
        // Auth must mirror the generation path (providers/image-gemini.js
        // headers()): Google's own endpoint takes x-goog-api-key, while
        // OpenAI-compatible gateways fronting gemini models (new-api family)
        // expect Authorization: Bearer even on the
        // native-looking /models path. Sending x-goog-api-key there produced
        // HTTP 400 "Invalid token" while generation with Bearer worked.
        const isGoogleHost = /generativelanguage\.googleapis\.com/i.test(url.hostname);
        const payload = isGoogleHost
            ? await request(url, '', fetcher, proxiedFetch, apiKey ? { 'x-goog-api-key': apiKey } : {}, timeoutMs, signal, mode)
            : await request(url, apiKey, fetcher, proxiedFetch, {}, timeoutMs, signal, mode);
        source = 'gemini-models';
        models = readModels(payload, 'models');
    } else if (contract === CONTRACTS.OPENROUTER_IMAGES) {
        url = openRouterUrl(endpoint);
        url.pathname += '/images/models';
        const payload = await request(url, apiKey, fetcher, proxiedFetch, {}, timeoutMs, signal, mode);
        source = 'openrouter-image-models';
        models = readModels(payload, 'data');
    } else {
        url = versionedUrl(endpoint);
        url.pathname += '/models';
        const payload = await request(url, apiKey, fetcher, proxiedFetch, {}, timeoutMs, signal, mode);
        source = 'openai-models';
        models = readModels(payload, 'data');
    }

    const catalogModels = models.map(model => ({ ...model, likelyImage: (contract === CONTRACTS.POLLINATIONS_IMAGES || contract === CONTRACTS.NAISTERA) ? true : IMAGE_MODEL.test(model.modelId) }));
    return {
        fetchedAt: new Date().toISOString(),
        models: catalogModels,
        routes: catalogModels.map(model => {
            const pollinations = contract === CONTRACTS.POLLINATIONS_IMAGES ? pollinationsRouteData(model) : {};
            const naistera = contract === CONTRACTS.NAISTERA ? naisteraRouteData(model) : {};
            return {
                ...routeFor({
                    modelId: model.modelId,
                    label: model.label,
                    source,
                    generationContract: contract,
                    likelyImage: model.likelyImage,
                    ...pollinations,
                    ...naistera,
                }),
                likelyImage: model.likelyImage,
            };
        }),
    };
}
