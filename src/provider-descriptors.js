// @ts-check
/**
 * Технические метаданные всех семи контрактов (пункт 2.3 плана 2026-10-05):
 * endpoint-нормализация, пути, авторизация, поллинг, wire-словари. Раньше
 * дескрипторы были у трёх контрактов, а та же информация была размазана по
 * адаптерам — нормализаторов endpoint'а существовало 5+, авторизация
 * дублировалась в трёх местах, regэкспы по display name протекали в
 * readJsonResponse.
 *
 * Контракт на поведение: normalize выдают байт-в-байт те же base URL, что и
 * старые адаптерные нормализаторы (покрыто tests/endpoint-utils.test.js).
 */
import { stripTrailingSlashes, stripVersionSuffix, withVersionSuffix } from './endpoint-utils.js';

const POLLINATIONS_CONTRACT = 'pollinations-images';
const NAISTERA_CONTRACT = 'naistera';
const COMFYUI_CONTRACT = 'comfyui';
const OPENAI_IMAGES_CONTRACT = 'openai-images';
const GEMINI_NATIVE_CONTRACT = 'gemini-native';
const CHAT_COMPLETIONS_CONTRACT = 'chat-completions';
const OPENROUTER_IMAGES_CONTRACT = 'openrouter-images';

export const PROVIDER_DESCRIPTORS = Object.freeze({
    [POLLINATIONS_CONTRACT]: Object.freeze({
        id: POLLINATIONS_CONTRACT,
        label: 'Pollinations',
        defaultEndpoint: 'https://gen.pollinations.ai',
        endpoint: Object.freeze({
            // Старый generationUrl: trim, хвостовые слэши, снять хвостовую /v1,
            // дописать /v1. Пустое значение — null (resolveEndpoint бросит).
            normalize: raw => {
                const base = stripVersionSuffix(raw);
                return base ? withVersionSuffix(base, '/v1') : null;
            },
            generationPath: '/images/generations',
            modelsPath: '/image/models',
            invalidMessage: 'Image provider endpoint is required.',
        }),
        auth: Object.freeze({
            required: true,
            scheme: 'bearer',
            tokenPrefix: 'sk_',
            statusCodes: Object.freeze({ 401: 'AUTH_INVALID', 403: 'AUTH_EXPIRED' }),
            missingError: Object.freeze({
                code: 'POLLINATIONS_TOKEN_REQUIRED',
                message: 'Pollinations requires an sk_ access token in the connection Key field.',
            }),
        }),
        operations: Object.freeze({
            generate: Object.freeze({ request: 'json', response: 'json', async: false }),
            edit: Object.freeze({ supported: false }),
        }),
        catalog: Object.freeze({ path: '/image/models', shape: 'array', auth: 'public' }),
        parameters: Object.freeze({
            quality: Object.freeze(['standard', 'hd', 'low', 'medium', 'high']),
            resolution: Object.freeze(['1k', '2k', '480p', '720p', '768p', '1080p']),
        }),
    }),
    // Naistera tokens are issued by the Telegram bot and have no documented
    // prefix (unlike Pollinations sk_/pk_), so auth only requires non-empty
    // bearer material and never pattern-matches the token shape.
    [NAISTERA_CONTRACT]: Object.freeze({
        id: NAISTERA_CONTRACT,
        label: 'Naistera',
        defaultEndpoint: 'https://naistera.org',
        endpoint: Object.freeze({
            // Старый baseUrl: trim, хвостовые слэши, снять хвостовой /api.
            normalize: raw => {
                const base = stripTrailingSlashes(raw).replace(/\/api$/i, '');
                if (!base) return null;
                return base;
            },
            generationPath: '/api/generate',
            jobPath: '/api/generate/jobs/:jobId',
            modelsPath: '/api/models',
            invalidMessage: 'Naistera endpoint is required.',
        }),
        auth: Object.freeze({
            required: true,
            scheme: 'bearer',
            tokenPrefix: null,
            statusCodes: Object.freeze({ 401: 'AUTH_INVALID', 403: 'AUTH_EXPIRED' }),
            missingError: Object.freeze({
                code: 'NAISTERA_TOKEN_REQUIRED',
                message: 'Naistera requires a token from the Telegram bot in the connection Key field.',
            }),
        }),
        operations: Object.freeze({
            // POST /api/generate answers either synchronously or with a job_id
            // that is polled on GET /api/generate/jobs/{job_id}.
            generate: Object.freeze({ request: 'json', response: 'json', async: true }),
            edit: Object.freeze({ supported: false }),
        }),
        catalog: Object.freeze({ path: '/api/models', shape: 'array', auth: 'bearer' }),
        parameters: Object.freeze({
            // From the /prompt constructor page; used only for validation,
            // the wire accepts whatever the API declares per model.
            aspectRatios: Object.freeze(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']),
            presets: Object.freeze(['digital', 'realism']),
        }),
        polling: Object.freeze({ intervalMs: 2500, maxMs: 0 }),  // maxMs 0 = connection timeoutMs is the deadline
    }),
    // Локальный ComfyUI: аутентификации нет, ключ опционален (Bearer уходит
    // только если задан — для reverse-proxy перед сервером). Каталога моделей
    // через «Проверить» нет: модель (чекпойнт) вводится вручную, список
    // workflow живёт на записи подключения.
    [COMFYUI_CONTRACT]: Object.freeze({
        id: COMFYUI_CONTRACT,
        label: 'ComfyUI',
        defaultEndpoint: 'http://127.0.0.1:8188',
        endpoint: Object.freeze({
            // Старый comfyBase: trim, хвостовые слэши, снять хвостовой /api.
            normalize: raw => {
                const base = stripTrailingSlashes(raw).replace(/\/api$/i, '');
                if (!base) return null;
                return base;
            },
            generationPath: '/prompt',
            modelsPath: '/models/checkpoints',
            invalidMessage: 'ComfyUI endpoint is required.',
        }),
        auth: Object.freeze({ required: false, scheme: null, tokenPrefix: null }),
        operations: Object.freeze({
            generate: Object.freeze({ request: 'json', response: 'json', async: true }),
            edit: Object.freeze({ supported: false }),
        }),
        parameters: Object.freeze({}),
        polling: Object.freeze({ intervalMs: 900, maxMs: 0 }),
    }),
    [OPENAI_IMAGES_CONTRACT]: Object.freeze({
        id: OPENAI_IMAGES_CONTRACT,
        label: 'OpenAI Images',
        defaultEndpoint: 'https://api.openai.com',
        endpoint: Object.freeze({
            // Старый endpointBase: trim, хвостовые слэши, дописать /v1 если
            // её ещё нет.
            normalize: raw => {
                const base = stripTrailingSlashes(raw);
                return base ? withVersionSuffix(base, '/v1') : null;
            },
            generationPath: '/images/generations',
            editPath: '/images/edits',
            modelsPath: '/models',
            invalidMessage: 'Image provider endpoint is required.',
        }),
        auth: Object.freeze({ required: true, scheme: 'bearer', tokenPrefix: null }),
        operations: Object.freeze({
            generate: Object.freeze({ request: 'json', response: 'json', async: false }),
            // Редактирование идёт по диалектной цепочке (multipart → JSON →
            // img2img) — свойство адаптера, дескриптору достаточно флага.
            edit: Object.freeze({ supported: true }),
        }),
        wire: Object.freeze({ aspectTable: 'gpt', qualityValues: Object.freeze(['auto', 'low', 'medium', 'high']) }),
    }),
    [GEMINI_NATIVE_CONTRACT]: Object.freeze({
        id: GEMINI_NATIVE_CONTRACT,
        label: 'Gemini Native',
        defaultEndpoint: 'https://generativelanguage.googleapis.com',
        endpoint: Object.freeze({
            // Старый generationUrl gemini: /v1beta дописывается, если base
            // ещё не кончается /v1 или /v1beta.
            normalize: raw => {
                const base = stripTrailingSlashes(raw);
                return base ? withVersionSuffix(base, '/v1beta', /\/v1(?:beta)?$/i) : null;
            },
            generationPath: '/models/:model:generateContent',
            modelsPath: '/models',
            invalidMessage: 'Gemini Native endpoint is required.',
        }),
        auth: Object.freeze({
            // Стратегия выбирается пробой «Проверить» (x-goog-api-key у Google,
            // bearer у релеев); дескриптор требует только наличия материала.
            required: true,
            scheme: 'bearer|x-goog-api-key',
            tokenPrefix: null,
        }),
        operations: Object.freeze({
            generate: Object.freeze({ request: 'json', response: 'json', async: false }),
            edit: Object.freeze({ supported: true }),
        }),
        wire: Object.freeze({ aspectTable: 'gemini' }),
    }),
    [CHAT_COMPLETIONS_CONTRACT]: Object.freeze({
        id: CHAT_COMPLETIONS_CONTRACT,
        label: 'Chat Completions',
        defaultEndpoint: 'https://api.openai.com',
        endpoint: Object.freeze({
            normalize: raw => {
                const base = stripTrailingSlashes(raw);
                return base ? withVersionSuffix(base, '/v1') : null;
            },
            generationPath: '/chat/completions',
            modelsPath: '/models',
            invalidMessage: 'Image provider endpoint is required.',
        }),
        auth: Object.freeze({ required: true, scheme: 'bearer', tokenPrefix: null }),
        operations: Object.freeze({
            generate: Object.freeze({ request: 'json', response: 'json', async: false }),
            edit: Object.freeze({ supported: true }),
        }),
        wire: Object.freeze({ aspectTable: 'gpt' }),
    }),
    [OPENROUTER_IMAGES_CONTRACT]: Object.freeze({
        id: OPENROUTER_IMAGES_CONTRACT,
        label: 'OpenRouter Images',
        defaultEndpoint: 'https://openrouter.ai',
        endpoint: Object.freeze({
            // Старый base openrouter: официальный origin → /api/v1; иначе
            // строка обязана кончаться /api/v1 (строгий контракт OpenRouter).
            normalize: raw => {
                const base = stripTrailingSlashes(raw);
                if (!base) return null;
                if (base === 'https://openrouter.ai') return `${base}/api/v1`;
                if (/\/api\/v1$/i.test(base)) return base;
                return null; // строгий отказ — не «дописать», а упасть
            },
            generationPath: '/images',
            modelsPath: '/models',
            invalidMessage: 'OpenRouter endpoint must be the official origin or end in /api/v1.',
        }),
        auth: Object.freeze({ required: true, scheme: 'bearer', tokenPrefix: null }),
        operations: Object.freeze({
            generate: Object.freeze({ request: 'json', response: 'json', async: false }),
            edit: Object.freeze({ supported: true }),
        }),
        wire: Object.freeze({ aspectTable: 'openrouter' }),
    }),
});

export function getProviderDescriptor(contract) {
    return PROVIDER_DESCRIPTORS[contract] || null;
}
