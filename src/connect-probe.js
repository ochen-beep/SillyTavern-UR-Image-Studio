// @ts-check
/**
 * «Проверить»: derive the gateway facts in one click.
 *
 * Layers auth-strategy detection on top of the catalog request machinery
 * (catalogRequest): for each candidate /models URL we try the auth strategies
 * in priority order, and the response BODY decides the endpoint API shape
 * ({data: [...]} → openai-compatible, {models: [...]} → gemini-native) —
 * the same URL can legitimately answer either depending on the gateway.
 *
 * Delivery fact: a direct attempt that dies on CORS is retried once through
 * the ST /proxy/ (the only safe retry — nothing was sent), and the working
 * delivery is reported so dispatch-plan can prefer it.
 *
 * Never throws for unreachable-but-classified outcomes; throws one aggregated
 * error only when every candidate × auth attempt failed.
 */
import { catalogRequest, buildVersionedUrl, buildPollinationsModelsUrl, buildNaisteraModelsUrl, buildNanoGptImageModelsUrl, boundedNaisteraModel } from './catalog.js';
import { proxiedFetch as defaultProxiedFetch } from './proxy.js';
import { validatePollinationsToken } from './providers/image-pollinations.js';
import { validateNaisteraToken } from './providers/image-naistera.js';
import { normalizeModelCatalog } from './model-catalog.js';

const MAX_MODEL_IDS = 500;

function nativeModelsUrl(endpoint) {
    const base = String(endpoint || '').trim().replace(/\/+$/, '');
    const versioned = /\/(v1|v1beta)$/i.test(base) ? base : `${base}/v1beta`;
    return `${versioned}/models`;
}

function candidateUrls(endpoint) {
    const isGoogleHost = /generativelanguage\.googleapis\.com/i.test(String(endpoint || ''));
    const openaiStyle = `${buildVersionedUrl(endpoint, 'v1').toString().replace(/\/+$/, '')}/models`;
    const nativeStyle = nativeModelsUrl(endpoint);
    const urls = isGoogleHost ? [nativeStyle, openaiStyle] : [openaiStyle, nativeStyle];
    return [...new Set(urls)];
}

function endpointHostname(endpoint) {
    try { return new URL(String(endpoint || '').trim()).hostname.toLowerCase().replace(/\.$/, ''); }
    catch { return ''; }
}

function isNanoGptEndpoint(endpoint) {
    const hostname = endpointHostname(endpoint);
    return hostname === 'nano-gpt.com' || hostname === 'www.nano-gpt.com';
}

function diagnosticCatalogUrl(value) {
    try {
        const url = new URL(String(value || ''));
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch { return ''; }
}

function isAuthShapedFailure(error) {
    const message = String(error?.message || '');
    return /HTTP 40[13]/.test(message)
        || /invalid token|api[ _-]?key|unauthorized|forbidden|auth/i.test(message);
}

function extractModels(payload, allowPollinations = false) {
    const result = normalizeModelCatalog(payload, {
        imageOnly: allowPollinations,
        source: allowPollinations ? 'pollinations-image-models' : 'generic-models',
        provider: allowPollinations ? 'pollinations' : 'generic',
    });
    return { shape: allowPollinations ? result.shape : result.shape, ids: result.modelIds, modelMetadata: result.entries };
}

/**
 * @typedef {object} ProbeOutcome
 * @property {'openai'|'gemini'} apiShape
 * @property {'bearer'|'x-goog-api-key'} auth
 * @property {'direct'|'proxy'} delivery
 * @property {string[]} modelIds
 * @property {string} checkedAt ISO timestamp
 */

/**
 * Probe a connection endpoint: detect auth strategy, API shape, delivery and
 * the model list.
 *
 * @param {{endpoint:string, apiKey?:string, timeoutMs?:number, signal?:AbortSignal,
 *          fetch?:Function, proxiedFetch?:Function, corsMode?:'auto'|'direct'|'proxy'}} input
 * @returns {Promise<ProbeOutcome>}
 */
export async function probeConnection(input = {}) {
    const {
        endpoint, apiKey = '', timeoutMs = 120000, signal,
        fetch: fetcher = globalThis.fetch,
        proxiedFetch = defaultProxiedFetch,
        corsMode = 'auto',
    } = input;
    if (!String(endpoint || '').trim()) throw new Error('Endpoint is required');
    const endpointText = String(endpoint);
    const isPollinationsHost = /(?:^|\.)pollinations\.ai(?:\/|$)/i.test(endpointText);
    const isNaisteraHost = /(?:^|[/.\-])naistera\.org(?:\/|$)/i.test(endpointText);
    if (isNaisteraHost) {
        // Token-scoped catalog: a successful read proves the bearer token
        // itself, so unlike Pollinations this probe reports generation as
        // verified rather than unverified.
        const token = String(apiKey || '').trim();
        validateNaisteraToken(token);
        const url = buildNaisteraModelsUrl(endpointText);
        let payload;
        let delivery = 'direct';
        try {
            const attempt = deliveryMode => catalogRequest(url, token, fetcher, proxiedFetch, {}, timeoutMs, signal, deliveryMode);
            try {
                payload = corsMode === 'proxy' ? await attempt('proxy') : await attempt('direct');
                if (corsMode === 'proxy') delivery = 'proxy';
            } catch (error) {
                if (corsMode !== 'direct' && error?.code === 'CATALOG_CORS_BLOCK') {
                    payload = await attempt('proxy');
                    delivery = 'proxy';
                } else throw error;
            }
        } catch (error) {
            const wrapped = new Error(`Не удалось получить каталог моделей Naistera: ${error?.message || error}`);
            if (error?.code) wrapped.code = error.code;
            if (Number.isSafeInteger(error?.httpStatus)) wrapped.httpStatus = error.httpStatus;
            if (error?.reauthRequired === true) wrapped.reauthRequired = true;
            throw wrapped;
        }
        const list = Array.isArray(payload) ? payload : (Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : null);
        if (!list) throw new Error('Naistera returned an unexpected /api/models shape (expected a JSON array).');
        const modelMetadata = [];
        const seen = new Set();
        for (const item of list) {
            const metadata = boundedNaisteraModel(item);
            if (!metadata || metadata.mediaKind === 'video' || seen.has(metadata.modelId)) continue;
            seen.add(metadata.modelId);
            modelMetadata.push({
                ...metadata,
                ...(metadata.mediaKind ? {} : { imageGeneration: true }),
                source: 'naistera-models',
                provider: 'naistera',
            });
            if (modelMetadata.length >= MAX_MODEL_IDS) break;
        }
        if (!modelMetadata.length) throw new Error('Naistera returned an empty model catalog.');
        return {
            apiShape: 'naistera',
            auth: token ? 'naistera-bearer' : 'naistera-public',
            delivery,
            modelIds: modelMetadata.map(item => item.modelId),
            modelMetadata,
            catalogSource: 'naistera-models',
            catalogUrl: diagnosticCatalogUrl(url),
            metadataCount: modelMetadata.length,
            checkedAt: new Date().toISOString(),
        };
    }
    if (isPollinationsHost) {
        const token = String(apiKey || '').trim();
        if (token) validatePollinationsToken(token);
        const url = buildPollinationsModelsUrl(endpointText);
        let payload;
        let delivery = 'direct';
        try {
            const attempt = deliveryMode => catalogRequest(url, '', fetcher, proxiedFetch, {}, timeoutMs, signal, deliveryMode);
            try {
                payload = corsMode === 'proxy' ? await attempt('proxy') : await attempt('direct');
                if (corsMode === 'proxy') delivery = 'proxy';
            } catch (error) {
                if (corsMode !== 'direct' && error?.code === 'CATALOG_CORS_BLOCK') {
                    payload = await attempt('proxy');
                    delivery = 'proxy';
                } else throw error;
            }
        } catch (error) {
            const wrapped = new Error(`Не удалось получить публичный каталог Pollinations: ${error?.message || error}`);
            if (error?.code) wrapped.code = error.code;
            if (Number.isSafeInteger(error?.httpStatus)) wrapped.httpStatus = error.httpStatus;
            if (error?.reauthRequired === true) wrapped.reauthRequired = true;
            throw wrapped;
        }
        const { shape, ids, modelMetadata } = extractModels(payload, true);
        if (shape !== 'pollinations' || !ids.length) throw new Error('Pollinations returned an empty or invalid image model catalog.');
        return {
            apiShape: 'pollinations',
            auth: token ? 'pollinations-sk' : 'pollinations-public',
            delivery,
            modelIds: ids,
            modelMetadata,
            catalogSource: 'pollinations-image-models',
            catalogUrl: diagnosticCatalogUrl(url),
            metadataCount: modelMetadata.length,
            generationUnverified: true,
            checkedAt: new Date().toISOString(),
        };
    }
    if (isNanoGptEndpoint(endpointText)) {
        const url = buildNanoGptImageModelsUrl(endpointText);
        let payload;
        let delivery = 'direct';
        try {
            const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
            const attempt = mode => catalogRequest(url, apiKey, fetcher, proxiedFetch, headers, timeoutMs, signal, mode);
            try {
                payload = corsMode === 'proxy' ? await attempt('proxy') : await attempt('direct');
                if (corsMode === 'proxy') delivery = 'proxy';
            } catch (error) {
                if (corsMode !== 'direct' && error?.code === 'CATALOG_CORS_BLOCK') {
                    payload = await attempt('proxy');
                    delivery = 'proxy';
                } else throw error;
            }
        } catch (error) {
            const wrapped = new Error(`Не удалось получить image-каталог NanoGPT: ${error?.message || error}`);
            if (error?.code) wrapped.code = error.code;
            if (Number.isSafeInteger(error?.httpStatus)) wrapped.httpStatus = error.httpStatus;
            throw wrapped;
        }
        const result = normalizeModelCatalog(payload, { source: 'nanogpt-image-models', provider: 'nanogpt' });
        if (!result.entries.length) throw new Error('NanoGPT returned an empty image model catalog.');
        return {
            apiShape: 'openai', auth: 'bearer', delivery,
            modelIds: result.modelIds, modelMetadata: result.entries,
            catalogSource: 'nanogpt-image-models',
            catalogUrl: diagnosticCatalogUrl(url),
            metadataCount: result.entries.length,
            ...(payload?.salvaged === true ? { partial: true } : {}),
            checkedAt: new Date().toISOString(),
        };
    }
    const isGoogleHost = /generativelanguage\.googleapis\.com/i.test(endpointText);
    const authOrder = isGoogleHost ? ['x-goog-api-key', 'bearer'] : ['bearer', 'x-goog-api-key'];
    const failures = [];

    for (const url of candidateUrls(endpoint)) {
        for (const auth of authOrder) {
            const headers = auth === 'x-goog-api-key'
                ? (apiKey ? { 'x-goog-api-key': apiKey } : {})
                : {};
            const apiKeyArg = auth === 'bearer' ? apiKey : '';
            const attempt = (mode) => catalogRequest(url, apiKeyArg, fetcher, proxiedFetch, headers, timeoutMs, signal, mode);

            let payload;
            let delivery = 'direct';
            try {
                try {
                    payload = corsMode === 'proxy' ? await attempt('proxy') : await attempt('direct');
                    if (corsMode === 'proxy') delivery = 'proxy';
                } catch (error) {
                    // The only safe retry in the whole flow: a CORS preflight
                    // refusal means nothing reached the provider.
                    if (corsMode !== 'direct' && error?.code === 'CATALOG_CORS_BLOCK') {
                        payload = await attempt('proxy');
                        delivery = 'proxy';
                    } else {
                        throw error;
                    }
                }
            } catch (error) {
                failures.push(`${url} [${auth}]: ${error?.message || error}`);
                continue;
            }

            const { shape, ids, modelMetadata } = extractModels(payload);
            if (!shape) {
                failures.push(`${url} [${auth}]: ответ не похож ни на OpenAI, ни на Gemini список моделей`);
                continue;
            }
            return {
                apiShape: shape,
                auth,
                delivery,
                modelIds: ids,
                modelMetadata,
                catalogSource: 'generic-models',
                catalogUrl: diagnosticCatalogUrl(url),
                metadataCount: modelMetadata.length,
                ...(payload?.salvaged === true ? { partial: true } : {}),
                checkedAt: new Date().toISOString(),
            };
        }
    }
    throw new Error(`Не удалось проверить подключение — ${failures.join(' | ')}`);
}
