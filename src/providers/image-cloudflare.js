// @ts-check
/**
 * Cloudflare Workers AI image adapter (docs/providers/cloudflare-workers-ai.md).
 *
 * Contract:
 *   POST {base}/ai/run/{model}        base = origin + /client/v4/accounts/<id>
 *   GET  {base}/ai/models/search?task=Text-to-Image   (каталог, пробник)
 *
 * Формат ответа зависит от модели (факты живой проверки 2026-10-13):
 *   - FLUX-семейство (flux-1-schnell, flux-2-dev): JSON { result: { image: base64 } };
 *   - SDXL-семейство (sdxl-lightning, dreamshaper-8-lcm): бинарное тело.
 *     Content-Type при этом ВРЁТ (заявлен image/png, байты JPEG) — MIME
 *     определяется по магическим байтам, не по заголовку.
 *   - FLUX.2 klein принимает только multipart-вход; multipart в URIS идёт
 *     только напрямую, а api.cloudflare.com не отдаёт CORS-заголовков —
 *     из браузера такие модели недостижимы, поэтому отказ до платного POST.
 *
 * Референсы: только SDXL-семейство, один референс, image_b64 (img2img).
 * Дополнительные параметры (steps/seed/guidance/negative_prompt) — через
 * «Доп. параметры body (JSON)» карточки: extraBody мерджится в тело.
 */
import {
    imageResultFromValue, providerError, readJsonResponse, authProfileFor,
    requireInvocation, diagnosticRequestOptions, referencesFor,
    assertEncodedReferenceCount,
} from './image-base.js';
import { resolveEndpoint } from '../endpoint-utils.js';
import { getProviderDescriptor } from '../provider-descriptors.js';

const CF_DESCRIPTOR = getProviderDescriptor('cloudflare-workers-ai');

// Модели, которым нужен multipart-вход (вживую 2026-10-13: JSON → HTTP 400
// «required properties at '/' are 'multipart'»). Недостижимы из браузера.
const MULTIPART_ONLY_MODEL = /flux-2|klein/i;
// SDXL-семейство на CF: width/height/num_steps/guidance/negative_prompt и
// img2img через image_b64.
const SDXL_FAMILY_MODEL = /stable-diffusion|dreamshaper/i;

// Вживую 2026-10-13: двойной HTTP 408 (AiError 3046, ~121с) — модель мертва
// на стороне CF. Пробник исключает её из каталога.
const KNOWN_BROKEN_MODELS = new Set(['@cf/stabilityai/stable-diffusion-xl-base-1.0']);

/**
 * Класс модели для адаптера и пробника.
 * @returns {{input:'json'|'multipart'|'broken', references:'supported'|'unsupported', maxReferences:number}}
 */
export function classifyCloudflareModel(modelId) {
    const id = String(modelId || '');
    if (KNOWN_BROKEN_MODELS.has(id)) return { input: 'broken', references: 'unsupported', maxReferences: 0 };
    if (MULTIPART_ONLY_MODEL.test(id)) return { input: 'multipart', references: 'unsupported', maxReferences: 0 };
    if (SDXL_FAMILY_MODEL.test(id)) return { input: 'json', references: 'supported', maxReferences: 1 };
    return { input: 'json', references: 'unsupported', maxReferences: 0 };
}

function cloudflareAuthError(code, message) {
    const error = providerError(code, message);
    error.authCode = code === 'CLOUDFLARE_TOKEN_REQUIRED' ? 'AUTH_REQUIRED' : 'AUTH_INVALID';
    if (code === 'CLOUDFLARE_TOKEN_REQUIRED') error.reauthRequired = true;
    return error;
}

/**
 * CF выдаёт токены двух форм (cfut_ user tokens и классические API tokens) —
 * форму не матчим, только присутствие и отсутствие пробелов (конвенция
 * naistera: shape-matching неизвестного формата отрежет валидные токены).
 */
export function validateCloudflareToken(value) {
    const token = typeof value === 'string' ? value.trim() : '';
    if (!token) throw cloudflareAuthError('CLOUDFLARE_TOKEN_REQUIRED', 'Cloudflare Workers AI requires an API token (with Workers AI permissions) in the connection Key field.');
    if (/\s/.test(token)) throw cloudflareAuthError('CLOUDFLARE_TOKEN_INVALID', 'Cloudflare API token contains whitespace.');
    return token;
}

function baseUrl(endpoint) {
    return resolveEndpoint(CF_DESCRIPTOR, endpoint);
}

function bytesToBase64(bytes) {
    if (typeof Buffer === 'function' && typeof Buffer.from === 'function') return Buffer.from(bytes).toString('base64');
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
}

// SDXL-пара геометрии: aspectRatio → width/height (256–2048, стандартные
// SDXL-слоты). Только SDXL-семейство; FLUX на CF размера не принимает.
const SDXL_PORTRAIT = new Set(['2:3', '3:4', '4:5', '9:16']);
const SDXL_LANDSCAPE = new Set(['3:2', '4:3', '5:4', '16:9']);
function sdxlSize(aspectRatio) {
    const ratio = String(aspectRatio || '').trim();
    if (!ratio) return null;
    if (ratio === '1:1') return { width: 1024, height: 1024 };
    if (SDXL_PORTRAIT.has(ratio)) return { width: 832, height: 1216 };
    if (SDXL_LANDSCAPE.has(ratio)) return { width: 1216, height: 832 };
    if (ratio === '21:9') return { width: 1344, height: 576 };
    return null;
}

// Поля, которые карточка не должна перебивать через extraBody.
const RESERVED_BODY_KEYS = new Set(['prompt']);

function buildPayload(request, extraBody) {
    const extra = extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody) ? extraBody : {};
    const payload = {};
    for (const [key, value] of Object.entries(extra)) {
        if (!RESERVED_BODY_KEYS.has(key)) payload[key] = value;
    }
    payload.prompt = String(request?.prompt || '');
    return payload;
}

function withWarnings(result, warnings) {
    return { ...result, warnings };
}

export async function generateCloudflareImage(input) {
    const { endpoint, apiKey, route, request, transport, signal, connection = {}, diagnostic = null, parsedReferences } = requireInvocation(input);
    const token = validateCloudflareToken(apiKey);
    const modelId = route.modelId;
    const modelKind = classifyCloudflareModel(modelId);
    if (modelKind.input === 'broken') {
        throw providerError('CLOUDFLARE_MODEL_BROKEN', `Cloudflare model ${modelId} is failing upstream (HTTP 408 timeouts observed 2026-10-13) — pick another model.`);
    }
    if (modelKind.input === 'multipart') {
        throw providerError('CLOUDFLARE_MODEL_UNSUPPORTED', `Cloudflare model ${modelId} accepts only multipart input, which cannot reach api.cloudflare.com from a browser (no CORS, and the ST proxy forwards JSON only). Pick a JSON-input model (flux-1-schnell, sdxl-lightning, …).`);
    }
    const references = parsedReferences ?? referencesFor(request);
    if (references.length && modelKind.references !== 'supported') {
        throw providerError('REFERENCES_UNSUPPORTED', `Cloudflare model ${modelId} has no image input (img2img поддерживает только SDXL-семейство); the request was stopped before the paid POST.`);
    }
    if (references.length > modelKind.maxReferences) {
        throw providerError('TOO_MANY_REFERENCES', `Cloudflare model ${modelId} accepts at most ${modelKind.maxReferences} reference image.`);
    }

    const payload = buildPayload(request, connection.extraBody);
    const warnings = [];

    if (modelKind.references === 'supported') {
        const size = sdxlSize(request?.aspectRatio);
        if (size) { payload.width = size.width; payload.height = size.height; }
        if (references.length) {
            payload.image_b64 = references[0].data;
            // strength ≈ denoising; 1 = полная перерисовка. Настраивается через
            // extraBody; дефолт CF (1) слишком силён для img2img — 0.75 ближе
            // к поведению других провайдеров.
            if (payload.strength === undefined) payload.strength = 0.75;
        }
        assertEncodedReferenceCount(references.length, payload.image_b64 ? 1 : 0, 'image_b64');
    } else {
        if (String(request?.aspectRatio || '').trim()) warnings.push(`Cloudflare model ${modelId} has no size parameters — aspectRatio was not sent.`);
        assertEncodedReferenceCount(references.length, 0, 'none');
    }
    if (request?.imageSize) warnings.push(`Cloudflare Workers AI has no size tiers — imageSize was not sent.`);
    if (request?.quality && request.quality !== 'auto') warnings.push(`Cloudflare Workers AI has no quality parameter — quality was not sent.`);

    const response = await transport.requestJson(
        `${baseUrl(endpoint)}${CF_DESCRIPTOR.endpoint.generationPath}${modelId}`,
        diagnosticRequestOptions({
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal,
        }, diagnostic, {
            bodyKind: 'json',
            wireFields: Object.keys(payload),
            omittedFields: references.length ? [] : ['image_b64'],
        }),
        route,
        connection.timeoutMs,
    );

    // Бинарный ответ (SDXL-семейство): Content-Type ненадёжен (вживую: заявлен
    // image/png, байты JPEG) — MIME определяется магическими байтами внутри
    // imageResultFromValue. Не-2xx с image/* не бывает: ошибки CF — JSON.
    const contentType = String(response?.headers?.get?.('content-type') || '');
    if (response?.ok && contentType.startsWith('image/')) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length) throw providerError('UPSTREAM_RESPONSE_INVALID', 'Cloudflare returned an empty image body.');
        return withWarnings(imageResultFromValue(bytesToBase64(bytes)), warnings);
    }

    const body = await readJsonResponse(response, 'Cloudflare Workers AI', authProfileFor('cloudflare-workers-ai'));
    if (body?.success === false) {
        const detail = Array.isArray(body?.errors) && body.errors.length
            ? String(body.errors[0]?.message || body.errors[0]?.code || '')
            : '';
        throw providerError('UPSTREAM_RESPONSE_INVALID', `Cloudflare Workers AI reported failure${detail ? `: ${detail.slice(0, 240)}` : '.'}`);
    }
    const image = body?.result?.image;
    if (typeof image !== 'string' || !image) {
        throw providerError('UPSTREAM_RESPONSE_INVALID', 'Cloudflare Workers AI returned a successful response without result.image.');
    }
    return withWarnings(imageResultFromValue(image), warnings);
}
