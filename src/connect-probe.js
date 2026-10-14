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
import { catalogRequest, buildVersionedUrl, buildPollinationsModelsUrl, buildNaisteraModelsUrl, buildNanoGptImageModelsUrl } from './catalog.js';
import { proxiedFetch as defaultProxiedFetch } from './proxy.js';
import { validatePollinationsToken } from './providers/image-pollinations.js';
import { validateNaisteraToken } from './providers/image-naistera.js';
import { validateCloudflareToken, classifyCloudflareModel } from './providers/image-cloudflare.js';
import { getProviderDescriptor } from './provider-descriptors.js';
import { resolveEndpoint } from './endpoint-utils.js';
import { normalizeModelCatalog } from './model-catalog.js';
import { recordDiagnosticEvent } from './diagnostic-events.js';
import { noteProbe } from './delivery-evidence.js';
import { resetModelFailureStreak } from './capability-observer.js';
import { CONTRACTS } from './image-connection-schema.js';

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

/**
 * One catalog fetch shared by the Naistera/Pollinations/NanoGPT branches:
 * explicit delivery mode for the first try, the single safe CORS retry
 * (a preflight refusal means nothing was sent), and the same user-facing
 * error wrapping. Returns { payload, delivery }.
 */
async function fetchCatalogPayload({ url, apiKey = '', headers = {}, timeoutMs, signal, corsMode, fetcher, proxiedFetch, errorPrefix, keepReauth = true }) {
    let payload;
    let delivery = 'direct';
    try {
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
        const wrapped = new Error(`${errorPrefix}: ${error?.message || error}`);
        if (error?.code) wrapped.code = error.code;
        if (Number.isSafeInteger(error?.httpStatus)) wrapped.httpStatus = error.httpStatus;
        if (keepReauth && error?.reauthRequired === true) wrapped.reauthRequired = true;
        throw wrapped;
    }
    return { payload, delivery };
}

function extractModels(payload, allowPollinations = false) {
    const result = normalizeModelCatalog(payload, {
        imageOnly: allowPollinations,
        source: allowPollinations ? 'pollinations-image-models' : 'generic-models',
        provider: allowPollinations ? 'pollinations' : 'generic',
    });
    return { shape: result.shape, ids: result.modelIds, modelMetadata: result.entries };
}

// Список из combo-входа ComfyUI: на 0.38+ это плоский ["a.safetensors", {...opts}],
// на старых (0.20.x) — вложенный [["a.safetensors"], {...opts}]. Берём только строки.
function comfyComboNames(value) {
    if (!Array.isArray(value)) return [];
    const list = Array.isArray(value[0]) ? value[0] : value;
    return list.filter(item => typeof item === 'string' && item.trim());
}

/** Probe a ComfyUI connection: /system_stats (ping) + список чекпойнтов. */
async function probeComfyConnection({ endpoint, timeoutMs, signal, fetcher, proxiedFetch, corsMode }) {
    const base = String(endpoint || '').trim().replace(/\/+$/, '');
    const fetchPart = async (path, errorPrefix) => fetchCatalogPayload({
        url: `${base}${path}`, timeoutMs, signal, corsMode, fetcher, proxiedFetch, errorPrefix, keepReauth: false,
    });
    let delivery = 'direct';
    let catalogUrl = '';
    let catalogSource = 'comfy-models';
    await fetchPart('/system_stats', 'Не удалось получить /system_stats ComfyUI').then(result => { delivery = result.delivery; });
    let modelIds = [];
    const modelsUrl = `${base}/models/checkpoints`;
    try {
        const models = await fetchPart('/models/checkpoints', 'Не удалось получить список чекпойнтов ComfyUI');
        delivery = models.delivery;
        modelIds = comfyComboNames(models.payload);
        catalogUrl = modelsUrl;
    } catch {
        // На старых серверах /models/{folder} нет — фолбэк на /object_info.
    }
    if (!modelIds.length) {
        const infoUrl = `${base}/object_info/CheckpointLoaderSimple`;
        const info = await fetchPart('/object_info/CheckpointLoaderSimple', 'Не удалось получить /object_info ComfyUI');
        delivery = info.delivery;
        modelIds = comfyComboNames(info.payload?.CheckpointLoaderSimple?.input?.required?.ckpt_name);
        catalogSource = 'comfy-object-info';
        catalogUrl = infoUrl;
    }
    if (!modelIds.length) {
        throw new Error('Сервер ComfyUI отвечает, но чекпойнтов не найдено — проверьте папку models/checkpoints на сервере.');
    }
    return {
        apiShape: 'comfyui',
        auth: 'none',
        delivery,
        modelIds,
        modelMetadata: modelIds.map(id => ({ modelId: id, imageGeneration: true })),
        catalogSource,
        catalogUrl: diagnosticCatalogUrl(catalogUrl),
        metadataCount: modelIds.length,
        checkedAt: new Date().toISOString(),
    };
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
 *          fetch?:Function, proxiedFetch?:Function, corsMode?:'auto'|'direct'|'proxy',
 *          dialect?:string}} input
 * @returns {Promise<ProbeOutcome>}
 */
async function runProbeConnection(input = {}) {
    const {
        endpoint, apiKey = '', timeoutMs = 120000, signal,
        fetch: fetcher = globalThis.fetch,
        proxiedFetch = defaultProxiedFetch,
        corsMode = 'auto',
        dialect = '',
    } = input;
    if (!String(endpoint || '').trim()) throw new Error('Endpoint is required');
    const endpointText = String(endpoint);
    if (dialect === CONTRACTS.COMFYUI) {
        return probeComfyConnection({ endpoint: endpointText, timeoutMs, signal, fetcher, proxiedFetch, corsMode });
    }
    // Cloudflare Workers AI: host api.cloudflare.com или явный пин диалекта.
    // Каталог токен-скопленный (GET /ai/models/search доказывает ключ),
    // поэтому generationUnverified не ставится (прецедент naistera).
    if (dialect === CONTRACTS.CLOUDFLARE_WORKERS_AI || endpointHostname(endpointText) === 'api.cloudflare.com') {
        const descriptor = getProviderDescriptor(CONTRACTS.CLOUDFLARE_WORKERS_AI);
        const token = String(apiKey || '').trim();
        validateCloudflareToken(token);
        // Бросает INVALID_ENDPOINT с подсказкой про account ID, если адрес
        // введён без /client/v4/accounts/<id>.
        const base = resolveEndpoint(descriptor, endpointText);
        const url = `${base}${descriptor.endpoint.modelsPath}?task=Text-to-Image`;
        const { payload, delivery } = await fetchCatalogPayload({
            url, apiKey: token, timeoutMs, signal, corsMode, fetcher, proxiedFetch,
            errorPrefix: 'Не удалось получить каталог моделей Cloudflare',
        });
        const list = Array.isArray(payload?.result) ? payload.result : null;
        if (!list) throw new Error('Cloudflare returned an unexpected /ai/models/search shape (expected a result array).');
        const shaped = [];
        for (const item of list) {
            const name = String(item?.name || '').trim();
            if (!name) continue;
            // Клиентская страховка поверх ?task=Text-to-Image.
            if (item?.task && String(item.task?.name || '').toLowerCase() !== 'text-to-image') continue;
            const kind = classifyCloudflareModel(name);
            // multipart-only и известно-сломанные модели из браузера мертвы —
            // в каталог не включаем (см. classifyCloudflareModel, факты 2026-10-13).
            if (kind.input !== 'json') continue;
            shaped.push({
                id: name,
                imageGeneration: true,
                references: kind.references,
                ...(kind.maxReferences > 0 ? { maxReferences: kind.maxReferences } : {}),
            });
        }
        if (!shaped.length) throw new Error('Cloudflare returned an empty Text-to-Image catalog (после исключения multipart-only моделей).');
        // normalizeModelCatalog — граница персистенции (bounded, secret-stripped).
        const { entries } = normalizeModelCatalog(shaped, { source: 'cloudflare-ai-models', provider: 'cloudflare' });
        return {
            apiShape: 'cloudflare',
            auth: 'bearer',
            delivery,
            modelIds: entries.map(entry => entry.modelId),
            modelMetadata: entries,
            catalogSource: 'cloudflare-ai-models',
            catalogUrl: diagnosticCatalogUrl(url),
            metadataCount: entries.length,
            checkedAt: new Date().toISOString(),
        };
    }
    const isPollinationsHost = /(?:^|\.)pollinations\.ai(?:\/|$)/i.test(endpointText);
    const isNaisteraHost = /(?:^|[/.\-])naistera\.org(?:\/|$)/i.test(endpointText);
    if (isNaisteraHost) {
        // Token-scoped catalog: a successful read proves the bearer token
        // itself, so unlike Pollinations this probe reports generation as
        // verified rather than unverified.
        const token = String(apiKey || '').trim();
        validateNaisteraToken(token);
        const url = buildNaisteraModelsUrl(endpointText);
        const { payload, delivery } = await fetchCatalogPayload({
            url, apiKey: token, timeoutMs, signal, corsMode, fetcher, proxiedFetch,
            errorPrefix: 'Не удалось получить каталог моделей Naistera',
        });
        const list = Array.isArray(payload) ? payload : (Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : null);
        if (!list) throw new Error('Naistera returned an unexpected /api/models shape (expected a JSON array).');
        // normalizeModelCatalog is the persistence boundary (bounded, secret-
        // stripped) — the same normalizer the Pollinations branch persists.
        const { entries } = normalizeModelCatalog(payload, { source: 'naistera-models', provider: 'naistera', excludeVideo: true });
        const modelMetadata = entries.map(entry => ({
            ...entry,
            ...(entry.mediaKind ? {} : { imageGeneration: true }),
        }));
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
        const { payload, delivery } = await fetchCatalogPayload({
            url, timeoutMs, signal, corsMode, fetcher, proxiedFetch,
            errorPrefix: 'Не удалось получить публичный каталог Pollinations',
        });
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
        // NanoGPT wrap never sets reauthRequired (historical contract).
        const { payload, delivery } = await fetchCatalogPayload({
            url, apiKey, timeoutMs, signal, corsMode, fetcher, proxiedFetch,
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            errorPrefix: 'Не удалось получить image-каталог NanoGPT', keepReauth: false,
        });
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

/**
 * Journal wrapper around the probe: «Проверить» is the first thing a user does
 * when a connection misbehaves, so both outcomes land in the diagnostic
 * journal. The probe's own HTTP traffic stays invisible to the netdump by
 * design (model catalogs are skipped), which makes this event the only trace
 * the check leaves.
 */
export async function probeConnection(input = {}) {
    const startedAt = Date.now();
    const connId = input?.connectionId ?? null;
    const endpointHost = endpointHostname(input?.endpoint);
    try {
        const result = await runProbeConnection(input);
        // Пункт 3.1: «Проверить» перечитало каталог — счётчик падений модели
        // сброшен, факт-строка не должен пугать устаревшей статистикой.
        resetModelFailureStreak(connId);
        // Пункт 2.1: вердикт доставки пробы — в единый delivery-evidence.
        // Лестница «Авто» читает его как fallback после опыта платных POST;
        // detected.delivery остаётся только отображением на карточке.
        if (connId && (result?.delivery === 'direct' || result?.delivery === 'proxy')) {
            noteProbe({ connId, endpoint: input?.endpoint, verdict: result.delivery }).catch(() => {});
        }
        recordDiagnosticEvent({
            event: 'connection-probe', stage: 'probe', connId,
            outcome: 'ok', durationMs: Date.now() - startedAt,
            details: {
                endpointHost,
                apiShape: result?.apiShape || null,
                models: Array.isArray(result?.modelIds) ? result.modelIds.length : null,
            },
        });
        return result;
    } catch (e) {
        recordDiagnosticEvent({
            event: 'connection-probe', stage: 'probe', connId, level: 'error',
            outcome: 'error', durationMs: Date.now() - startedAt,
            details: { endpointHost, errorName: e?.name || 'Error', message: String(e?.message || e) },
        });
        throw e;
    }
}
