// @ts-check
/**
 * ComfyUI image generation adapter (локальный ComfyUI-сервер, /prompt API).
 *
 * Источник истины — workflow в формате «Export (API)» ComfyUI. Подключение
 * хранит его дословно (connection.workflowJson); пустое поле означает
 * встроенный txt2img-граф, а при приложенных референсах — встроенный
 * img2img-граф (LoadImage → VAEEncode). Плейсхолдеры по конвенции ядра
 * SillyTavern: кавычкованные строковые токены ("%prompt%", "%model%")
 * заменяются на JSON.stringify-значение (замена задевает только строковые
 * поля), голые числовые (%seed%, %width%, %height%) — литерально. Промпт
 * подставляется ПОСЛЕДНИМ, чтобы процент-токены внутри него не переписывались.
 *
 * Проводка: POST /prompt → поллинг GET /history/{prompt_id} (дедлайн —
 * connection.timeoutMs, только read-only GET, второй POST невозможен) →
 * GET /view первой картинки → data URL. Отмена гасит ожидание и вдогонку
 * шлёт best-effort POST /interrupt, чтобы сервер не жёг GPU по заброшенной
 * задаче (на старых серверах тело игнорируется и отменяется вся очередь —
 * известное поведение, задокументировано в форме подключения).
 *
 * Референсы: POST /upload/image (multipart, только напрямую — ST-прокси не
 * умеет FormData), затем раскладка по нодам LoadImage в порядке возрастания
 * ID (первая референса → первый LoadImage). Граф без LoadImage отклоняет
 * референсы до любой отправки.
 */
import { fetchWithTimeout } from '../core.js';
import {
    detectImageMimeFromBase64,
    providerError,
    readJsonResponse,
    readResponseText,
    authProfileFor,
    referencesFor,
    requireInvocation,
    diagnosticRequestOptions,
} from './image-base.js';
import { resolveEndpoint } from '../endpoint-utils.js';
import { sleep as sharedSleep, abortError as baseAbortError } from '../async-utils.js';
import { getProviderDescriptor } from '../provider-descriptors.js';

const COMFYUI_DESCRIPTOR = getProviderDescriptor('comfyui');
const POLL_INTERVAL_MS = COMFYUI_DESCRIPTOR?.polling?.intervalMs || 900;
const OUTPUT_NODE_CLASSES = new Set(['SaveImage', 'PreviewImage', 'SaveImageWebsocket']);
const REFERENCE_EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

// Встроенный txt2img: стандартные ноды, ничего кастомного. %model% — имя
// файла чекпойнта из поля «Модель» подключения, %seed% генерируется клиентом
// (сервер ComfyUI ничего не рандомизирует сам).
export const COMFYUI_DEFAULT_WORKFLOW_TXT2IMG = `{
  "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "%model%" }, "_meta": { "title": "Load Checkpoint" } },
  "5": { "class_type": "EmptyLatentImage", "inputs": { "width": %width%, "height": %height%, "batch_size": 1 }, "_meta": { "title": "Empty Latent Image" } },
  "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "%prompt%", "clip": ["4", 1] }, "_meta": { "title": "Prompt" } },
  "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["4", 1] }, "_meta": { "title": "Negative" } },
  "3": { "class_type": "KSampler", "inputs": { "seed": %seed%, "steps": 25, "cfg": 7.0, "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 1.0, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0] }, "_meta": { "title": "KSampler" } },
  "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] }, "_meta": { "title": "VAE Decode" } },
  "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "uris", "images": ["8", 0] }, "_meta": { "title": "Save Image" } }
}`;

// Встроенный img2img: одна референса через LoadImage → VAEEncode, размер
// наследуется от самой картинки, denoise 0.65. Кастомные сценарии (Flux
// Kontext, IPAdapter, маски) — через собственный workflow на подключении.
export const COMFYUI_DEFAULT_WORKFLOW_IMG2IMG = `{
  "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "%model%" }, "_meta": { "title": "Load Checkpoint" } },
  "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "%prompt%", "clip": ["4", 1] }, "_meta": { "title": "Prompt" } },
  "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["4", 1] }, "_meta": { "title": "Negative" } },
  "10": { "class_type": "LoadImage", "inputs": { "image": "", "upload": "image" }, "_meta": { "title": "Reference" } },
  "11": { "class_type": "VAEEncode", "inputs": { "pixels": ["10", 0], "vae": ["4", 2] }, "_meta": { "title": "Encode Reference" } },
  "3": { "class_type": "KSampler", "inputs": { "seed": %seed%, "steps": 25, "cfg": 7.0, "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 0.65, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["11", 0] }, "_meta": { "title": "KSampler" } },
  "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] }, "_meta": { "title": "VAE Decode" } },
  "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "uris", "images": ["8", 0] }, "_meta": { "title": "Save Image" } }
}`;

// Точные соотношения сторон кратными 64 (сокращение дроби даёт ровно
// запрошенное соотношение — пост-проверка аспекта в image-api не ругается).
const COMFYUI_ASPECT_SIZES = new Map([
    ['1:1', { w: 1024, h: 1024 }],
    ['2:3', { w: 1024, h: 1536 }],
    ['3:2', { w: 1536, h: 1024 }],
    ['3:4', { w: 768, h: 1024 }],
    ['4:3', { w: 1024, h: 768 }],
    ['4:5', { w: 1024, h: 1280 }],
    ['5:4', { w: 1280, h: 1024 }],
    ['9:16', { w: 576, h: 1024 }],
    ['16:9', { w: 1024, h: 576 }],
    ['21:9', { w: 1344, h: 576 }],
]);

/** Aspect ratio "W:H" → пиксели builtin-графов; неизвестное — квадрат 1024. */
export function aspectSize(ratio) {
    return COMFYUI_ASPECT_SIZES.get(String(ratio || '').trim()) || { w: 1024, h: 1024 };
}

function comfyBase(endpoint) {
    return resolveEndpoint(COMFYUI_DESCRIPTOR, endpoint);
}

function authHeaders(apiKey) {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Подстановка плейсхолдеров в сырой текст workflow. Порядок важен: промпт —
 * последним, чтобы %токены% внутри текста промпта оставались контентом.
 */
export function substituteWorkflow(text, { modelId, prompt, seed, width, height }) {
    const source = String(text ?? '');
    const hasPromptPlaceholder = source.includes('"%prompt%"');
    const hasSeedPlaceholder = source.includes('%seed%');
    let out = source;
    if (source.includes('"%model%"')) out = out.split('"%model%"').join(JSON.stringify(String(modelId ?? '')));
    if (hasSeedPlaceholder) out = out.split('%seed%').join(String(Math.max(0, Math.trunc(Number(seed) || 0))));
    if (Number.isFinite(width)) out = out.split('%width%').join(String(Math.round(width)));
    if (Number.isFinite(height)) out = out.split('%height%').join(String(Math.round(height)));
    if (hasPromptPlaceholder) out = out.split('"%prompt%"').join(JSON.stringify(String(prompt ?? '')));
    return { text: out, hasPromptPlaceholder, hasSeedPlaceholder };
}

/**
 * Сводка по тексту workflow для живого индикатора в карточке: какие
 * плейсхолдеры найдены (по тем же токенам, что и подстановка), есть ли
 * выходная нода, сколько LoadImage, и есть ли чекпойнт-лоадер без %model%.
 * Работает и на битом JSON: чипы плейсхолдеров считаются по тексту, а
 * структурные поля остаются null.
 */
export function summarizeWorkflow(text) {
    const source = String(text ?? '');
    const placeholders = {
        prompt: source.includes('"%prompt%"'),
        seed: source.includes('%seed%'),
        model: source.includes('"%model%"'),
        width: source.includes('%width%'),
        height: source.includes('%height%'),
    };
    let parsed = null;
    let error = null;
    if (!source.trim()) {
        error = 'пустой workflow';
    } else {
        try {
            // Голые числовые плейсхолдеры делают текст невалидным JSON ДО
            // подстановки — для структурного анализа подставляем нули.
            parsed = JSON.parse(source.replace(/%seed%|%width%|%height%/g, '0'));
        } catch (e) { error = `не похоже на JSON: ${String(e?.message || e).slice(0, 120)}`; }
    }
    const ok = Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
    let hasOutput = null;
    let loadImageCount = null;
    let checkpointLoaderNoModel = null;
    if (ok) {
        const nodes = Object.values(parsed).filter(node => node && typeof node === 'object' && !Array.isArray(node));
        hasOutput = nodes.some(node => OUTPUT_NODE_CLASSES.has(String(node.class_type || '')));
        loadImageCount = nodes.filter(node => String(node.class_type || '') === 'LoadImage' && node.inputs && typeof node.inputs === 'object').length;
        checkpointLoaderNoModel = nodes.some(node => String(node.class_type || '') === 'CheckpointLoaderSimple') && !placeholders.model;
    }
    return { ok, error, placeholders, hasOutput, loadImageCount, checkpointLoaderNoModel };
}

/** Разобрать и провалидировать workflow ДО любых отправок (все проверки бесплатны). */
export function parseAndValidateWorkflow(text) {
    let workflow;
    try {
        workflow = JSON.parse(String(text ?? ''));
    } catch (error) {
        throw providerError('COMFY_WORKFLOW_INVALID', `Workflow не похож на JSON: ${String(error?.message || error).slice(0, 160)}. Нужен формат «Export (API)» из ComfyUI.`);
    }
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
        throw providerError('COMFY_WORKFLOW_INVALID', 'Workflow должен быть объектом {id_ноды: {class_type, inputs}} — это формат «Export (API)».');
    }
    const nodes = Object.values(workflow).filter(node => node && typeof node === 'object' && !Array.isArray(node));
    const hasOutput = nodes.some(node => OUTPUT_NODE_CLASSES.has(String(node.class_type || '')));
    if (!hasOutput) {
        const looksUiFormat = Array.isArray(workflow.nodes) && Array.isArray(workflow.links);
        throw providerError('COMFY_NO_OUTPUT', looksUiFormat
            ? 'В графе нет SaveImage/PreviewImage, и по виду это UI-формат: в ComfyUI включите Dev Mode и экспортируйте через «Export (API)».'
            : 'В графе нет SaveImage/PreviewImage — ComfyUI выполнит его, но не вернёт картинок.');
    }
    const loadImageNodes = nodes.filter(node => String(node.class_type || '') === 'LoadImage' && node.inputs && typeof node.inputs === 'object');
    return { workflow, hasOutput, loadImageNodes };
}

/**
 * Разложить загруженные файлы по нодам LoadImage. Порядок — возрастание ID
 * нод (целочисленные ключи JS-объекта всегда перебираются численно, т.е.
 * детерминированно): первая референса → LoadImage с наименьшим ID.
 */
export function mapLoadImageInputs(workflow, values) {
    const nodes = Object.values(workflow).filter(node => node?.class_type === 'LoadImage' && node.inputs && typeof node.inputs === 'object');
    const mapped = [];
    values.forEach((value, index) => {
        const node = nodes[index];
        if (!node) return;
        node.inputs.image = value;
        mapped.push(value);
    });
    return mapped;
}

/** URL забора готовой картинки; filename/subfolder/type берутся из history. */
export function viewUrlFor(base, image) {
    const params = new URLSearchParams();
    params.set('filename', String(image?.filename ?? ''));
    params.set('subfolder', String(image?.subfolder ?? ''));
    params.set('type', String(image?.type ?? 'output'));
    return `${comfyBase(base)}/view?${params.toString()}`;
}

/**
 * Итог чтения /history/{prompt_id}: pending (задачи ещё нет — ждёт в общей
 * очереди сервера), error (execution_error/execution_interrupted), empty
 * (выполнилось, картинок нет) или done с первой картинкой.
 */
export function extractHistoryOutcome(payload, promptId, workflow = null) {
    const entry = payload && typeof payload === 'object' ? payload[promptId] : null;
    if (!entry || typeof entry !== 'object') return { status: 'pending' };
    const status = entry.status && typeof entry.status === 'object' ? entry.status : {};
    const messages = Array.isArray(status.messages) ? status.messages : [];
    for (const message of messages) {
        const [type, data] = Array.isArray(message) ? message : [];
        if (type === 'execution_error') {
            // Сервер обычно даёт node_type; если нет — берём class_type из
            // собственного workflow по ID ноды.
            const node = String(data?.node_type || workflow?.[String(data?.node_id)]?.class_type || 'node');
            const detail = String(data?.exception_message || 'execution error');
            return { status: 'error', message: `${node} [${data?.node_id ?? '?'}]: ${detail}` };
        }
        if (type === 'execution_interrupted') {
            return { status: 'error', message: 'выполнение прервано на сервере ComfyUI' };
        }
    }
    const image = firstOutputImage(entry.outputs);
    if (image) return { status: 'done', image };
    if (status.completed === true || status.status_str === 'success') return { status: 'empty' };
    if (status.status_str === 'error') return { status: 'error', message: 'выполнение завершилось ошибкой без деталей' };
    return { status: 'pending' };
}

function firstOutputImage(outputs) {
    if (!outputs || typeof outputs !== 'object') return null;
    for (const nodeOutput of Object.values(outputs)) {
        const images = Array.isArray(nodeOutput?.images) ? nodeOutput.images : [];
        for (const image of images) {
            if (image && typeof image.filename === 'string' && image.filename) {
                return { filename: image.filename, subfolder: String(image.subfolder || ''), type: String(image.type || 'output') };
            }
        }
    }
    return null;
}

// Пункт 2.4: примитивы поллинга вынесены в ../async-utils.js.
function sleep(ms, signal) {
    return sharedSleep(ms, signal, { abortMessage: 'ComfyUI generation was cancelled.' });
}

function abortError() {
    return baseAbortError('ComfyUI generation was cancelled.');
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

async function uploadReferences({ base, references, requestId, transport, route, connection, signal, diagnostic }) {
    const uploaded = [];
    for (const [index, reference] of references.entries()) {
        const filename = `uris_${requestId}_ref${index + 1}.${REFERENCE_EXT_BY_MIME[reference.mimeType] || 'bin'}`;
        const form = new FormData();
        form.append('image', new Blob([Uint8Array.from(atob(reference.data), c => c.charCodeAt(0))], { type: reference.mimeType }), filename);
        form.append('overwrite', 'true');
        form.append('type', 'input');
        const response = await transport.requestMultipart(
            `${base}/upload/image`,
            diagnosticRequestOptions({
                method: 'POST',
                body: form,
                signal,
            }, diagnostic, { bodyKind: 'multipart', referenceCount: references.length }),
            route,
            connection.timeoutMs,
        );
        const payload = await readJsonResponse(response, 'ComfyUI Upload', authProfileFor('comfyui'));
        const name = String(payload?.name || '').trim();
        if (!name) throw providerError('UPSTREAM_RESPONSE_INVALID', 'ComfyUI /upload/image не вернул имя файла.');
        const subfolder = String(payload?.subfolder || '').trim();
        uploaded.push({ name, value: subfolder ? `${subfolder}/${name}` : name });
    }
    return uploaded;
}

async function queuePrompt({ base, workflow, apiKey, transport, route, connection, signal, diagnostic }) {
    const response = await transport.requestJson(
        `${base}/prompt`,
        diagnosticRequestOptions({
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
            // prompt_id/client_id не отправляем: сервер генерирует сам, для
            // поллинга и /interrupt хватает ответа. Никаких UUID на клиенте.
            body: JSON.stringify({ prompt: workflow }),
            signal,
        }, diagnostic, { bodyKind: 'json', wireFields: ['prompt'] }),
        route,
        connection.timeoutMs,
    );
    const raw = await readResponseText(response);
    let payload = null;
    try { payload = JSON.parse(raw); } catch { /* разбор ниже по статусу */ }
    if (!response.ok) throw promptRejectedError(response.status, payload, workflow);
    const promptId = String(payload?.prompt_id || '').trim();
    if (!promptId) throw providerError('UPSTREAM_RESPONSE_INVALID', 'ComfyUI не вернул prompt_id.');
    return promptId;
}

function promptRejectedError(status, payload, workflow = null) {
    const detail = String(payload?.error?.message || '').slice(0, 240);
    const nodeParts = [];
    const nodeErrors = payload?.node_errors && typeof payload.node_errors === 'object' ? payload.node_errors : {};
    for (const [nodeId, nodeError] of Object.entries(nodeErrors)) {
        if (nodeParts.length >= 3) break;
        const firstMessage = Array.isArray(nodeError?.errors)
            ? String(nodeError.errors[0]?.message || nodeError.errors[0]?.details || '')
            : '';
        // node_type от сервера или class_type из нашего же workflow — читабельнее «node [4]».
        const node = String(nodeError?.node_type || workflow?.[String(nodeId)]?.class_type || 'node');
        nodeParts.push(`${node} [${nodeId}]: ${firstMessage || 'ошибка валидации'}`);
    }
    const error = providerError('COMFY_PROMPT_REJECTED', `ComfyUI отклонил workflow (HTTP ${status}): ${detail || 'без деталей'}${nodeParts.length ? ` — ${nodeParts.join('; ')}` : ''}. Если в графе кастомные ноды — проверьте, что они установлены на сервере.`);
    error.httpStatus = Number.isSafeInteger(status) ? status : null;
    return error;
}

function comfyTimeout() {
    const error = providerError('COMFY_JOB_TIMEOUT', 'ComfyUI не завершил задачу до истечения таймаута подключения — задача могла остаться в общей очереди сервера. Для медленных моделей поднимите таймаут на карточке подключения.');
    error.jobStatus = 'timeout';
    return error;
}

async function pollHistory({ base, promptId, apiKey, transport, route, signal, diagnostic, deadlineAt, workflow }) {
    for (;;) {
        if (Date.now() >= deadlineAt) throw comfyTimeout();
        const remainingMs = Math.max(1, deadlineAt - Date.now());
        const response = await transport.requestJson(
            `${base}/history/${encodeURIComponent(promptId)}`,
            diagnosticRequestOptions({
                method: 'GET',
                headers: authHeaders(apiKey),
                signal,
            }, diagnostic, { bodyKind: 'json', wireFields: [], omittedFields: [], phase: 'poll' }),
            route,
            remainingMs,
        );
        const payload = await readJsonResponse(response, 'ComfyUI History', authProfileFor('comfyui'));
        const outcome = extractHistoryOutcome(payload, promptId, workflow);
        if (outcome.status === 'done') return outcome.image;
        if (outcome.status === 'error') throw providerError('COMFY_EXECUTION_ERROR', `ComfyUI не выполнил workflow: ${outcome.message}`);
        if (outcome.status === 'empty') throw providerError('COMFY_NO_OUTPUT', 'Workflow выполнился, но не вернул картинок — нужна нода SaveImage/PreviewImage с непустым выходом.');
        if (Date.now() >= deadlineAt) throw comfyTimeout();
        await sleep(POLL_INTERVAL_MS, signal);
    }
}

async function downloadImage({ base, image, transport, signal, deadlineAt }) {
    const url = viewUrlFor(base, image);
    const remainingMs = Math.max(1, deadlineAt - Date.now());
    // autoFetch: direct → прокси ST (GET идемпотентен, прокси стримит бинарные
    // ответы) — работает и без CORS-флага ComfyUI.
    const response = await transport.downloadResult(url, { signal }, remainingMs);
    if (!response?.ok) throw providerError('UPSTREAM_HTTP_ERROR', `ComfyUI /view вернул HTTP ${response?.status ?? '?'} для ${image.filename}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const value = bytesToBase64(bytes);
    const mimeType = detectImageMimeFromBase64(value) || 'image/png';
    return { value: `data:${mimeType};base64,${value}`, mimeType };
}

export async function generateComfyUIImage(input) {
    const { endpoint, apiKey, route, request, transport, signal, connection = {}, diagnostic = null } = requireInvocation(input);
    const base = comfyBase(endpoint);
    const references = referencesFor(request);
    const timeoutMs = Math.max(1, Number.isFinite(connection.timeoutMs) ? connection.timeoutMs : 120000);
    const deadlineAt = Date.now() + timeoutMs;
    const seed = Math.floor(Math.random() * 2 ** 53);
    const size = aspectSize(request?.aspectRatio);

    const customWorkflow = String(connection.workflowJson ?? '').trim();
    const template = customWorkflow || (references.length ? COMFYUI_DEFAULT_WORKFLOW_IMG2IMG : COMFYUI_DEFAULT_WORKFLOW_TXT2IMG);
    const substituted = substituteWorkflow(template, {
        modelId: route.modelId,
        prompt: String(request?.prompt || ''),
        seed,
        width: size.w,
        height: size.h,
    });
    if (!substituted.hasPromptPlaceholder) {
        throw providerError('COMFY_PROMPT_MISSING', 'В workflow нет "%prompt%" — URIS некуда передать промпт. Добавьте ноду CLIPTextEncode с текстом "%prompt%" или вставьте граф в формате Export (API).');
    }
    const { workflow, loadImageNodes } = parseAndValidateWorkflow(substituted.text);

    const warnings = [];
    if (!substituted.hasSeedPlaceholder) {
        warnings.push({ feature: 'Seed', details: 'в workflow нет %seed% — сид фиксированный, одинаковые запросы будут давать одинаковую картинку' });
    }

    if (references.length) {
        if (!loadImageNodes.length) {
            throw providerError('COMFY_NO_LOADIMAGE', 'В workflow нет ноды LoadImage — референсы некуда вставить. Используйте граф с LoadImage (например, img2img) или уберите референсы из запроса.');
        }
        if (references.length > loadImageNodes.length) {
            throw providerError('COMFY_TOO_MANY_REFERENCES', `Референсов ${references.length}, но нод LoadImage в workflow только ${loadImageNodes.length}. Добавьте ноды LoadImage или уменьшите лимит референсов на карточке подключения.`);
        }
        const uploaded = await uploadReferences({ base, references, requestId: request.requestId, transport, route, connection, signal, diagnostic });
        mapLoadImageInputs(workflow, uploaded.map(item => item.value));
    }

    const promptId = await queuePrompt({ base, workflow, apiKey, transport, route, connection, signal, diagnostic });

    // Отмена: signal гасит ожидание, /interrupt останавливает задачу на
    // сервере. Best-effort: таймаут 5 с, ошибки глотаются.
    const onAbort = () => {
        void fetchWithTimeout(`${base}/interrupt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
            body: JSON.stringify({ prompt_id: promptId }),
        }, 5000).catch(() => {});
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
        const image = await pollHistory({ base, promptId, apiKey, transport, route, signal, diagnostic, deadlineAt, workflow });
        const dataUrl = await downloadImage({ base, image, transport, signal, deadlineAt });
        return { kind: 'dataUrl', value: dataUrl.value, mimeType: dataUrl.mimeType, warnings };
    } finally {
        signal?.removeEventListener?.('abort', onAbort);
    }
}
