// @ts-check
/**
 * Naistera image generation adapter.
 *
 * Contract (see docs/providers/naistera-api.md):
 *   POST /api/generate              { prompt, model, aspect_ratio, preset?, reference_objects? }
 *   GET  /api/generate/jobs/{job_id}   polling with the same bearer token
 *   `reference_objects`: `{ image: dataUrl, description? }[]` for image-capable models
 *
 * A generation may answer synchronously (result in the POST response) or
 * asynchronously (job_id). The polling loop runs under the connection's
 * overall timeoutMs deadline and the caller's AbortSignal: one POST, then
 * read-only GETs — never a second paid POST.
 */
import { imageResultFromValue, providerError, readJsonResponse, authProfileFor, referencesFor, requireInvocation, diagnosticRequestOptions } from './image-base.js';
import { resolveEndpoint, interpolatePath } from '../endpoint-utils.js';
import { sleep, pollUntil, abortError as baseAbortError } from '../async-utils.js';
import { getProviderDescriptor } from '../provider-descriptors.js';

const NAISTERA_DESCRIPTOR = getProviderDescriptor('naistera');
const POLL_INTERVAL_MS = NAISTERA_DESCRIPTOR?.polling?.intervalMs || 2500;
const ASPECT_RATIOS = new Set(NAISTERA_DESCRIPTOR?.parameters?.aspectRatios || []);
const PRESETS = new Set(NAISTERA_DESCRIPTOR?.parameters?.presets || []);
const TERMINAL_STATES = new Set(['completed', 'succeeded', 'done', 'failed', 'error', 'cancelled', 'canceled']);

function naisteraAuthError(code, message) {
    const error = providerError(code, message);
    error.authCode = code === 'NAISTERA_TOKEN_REQUIRED' ? 'AUTH_REQUIRED' : 'AUTH_INVALID';
    if (code === 'NAISTERA_TOKEN_REQUIRED') error.reauthRequired = true;
    return error;
}

/**
 * Naistera tokens come from the Telegram bot and have no documented prefix,
 * so the only local validation is non-emptiness. Shape-matching an unknown
 * token format would reject valid tokens after any provider-side change.
 */
export function validateNaisteraToken(value) {
    const token = typeof value === 'string' ? value.trim() : '';
    if (!token) throw naisteraAuthError('NAISTERA_TOKEN_REQUIRED', 'Naistera requires a token from the Telegram bot in the connection Key field.');
    if (/\s/.test(token)) throw naisteraAuthError('NAISTERA_TOKEN_INVALID', 'Naistera token contains whitespace.');
    return token;
}

function baseUrl(endpoint) {
    return resolveEndpoint(NAISTERA_DESCRIPTOR, endpoint);
}

function body(route, request, parsedReferences) {
    const payload = {
        prompt: String(request?.prompt || ''),
        model: route.modelId,
        // Ask for an asynchronous job so long-running models do not hold the
        // paid POST open; the adapter still accepts a synchronous image result
        // for provider compatibility.
        sync: false,
    };
    const aspectRatio = String(request?.aspectRatio || '').trim();
    if (aspectRatio && (ASPECT_RATIOS.size === 0 || ASPECT_RATIOS.has(aspectRatio))) {
        payload.aspect_ratio = aspectRatio;
    }
    const preset = String(request?.preset ?? '').trim().toLowerCase();
    if (preset && PRESETS.has(preset)) payload.preset = preset;
    const references = parsedReferences ?? referencesFor(request);
    if (references.length) payload.reference_objects = references.map(ref => ({
        image: ref.dataUrl,
        ...(typeof ref.description === 'string' && ref.description.trim()
            ? { description: ref.description.trim().slice(0, 2000) }
            : {}),
    }));
    return { payload, references };
}

function extractResult(payload, { allowMissing = false } = {}) {
    const mediaKind = String(payload?.media_kind ?? payload?.mediaKind ?? payload?.kind ?? '').trim().toLowerCase();
    if (mediaKind === 'video') {
        throw providerError('NAISTERA_VIDEO_UNSUPPORTED', 'Naistera returned a video result, but URIS image generation does not support video yet.');
    }
    // Successful generation: image payload. Accept the common spellings; the
    // provider's public docs do not pin the exact field name.
    const candidates = [
        payload?.image, payload?.image_url, payload?.url, payload?.output_url,
        payload?.result, payload?.result_url, payload?.data, payload?.data_url,
        payload?.b64_json, payload?.base64, payload?.image_data,
        payload?.image?.b64_json, payload?.image?.base64,
        payload?.result?.b64_json, payload?.result?.base64,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate) return imageResultFromValue(candidate);
    }
    const firstOutput = Array.isArray(payload?.outputs) ? payload.outputs[0] : null;
    if (firstOutput && typeof firstOutput === 'string') return imageResultFromValue(firstOutput);
    if (Array.isArray(payload?.images) && typeof payload?.images[0] === 'string' && payload.images[0]) {
        return imageResultFromValue(payload.images[0]);
    }
    if (allowMissing) return null;
    throw providerError('UPSTREAM_RESPONSE_INVALID', 'Naistera returned a successful response without an image.');
}

function jobStatus(payload) {
    const status = String(payload?.status ?? payload?.state ?? '').trim().toLowerCase();
    return status || 'processing';
}

function jobErrorMessage(payload) {
    if (typeof payload?.error === 'string') return payload.error;
    if (typeof payload?.error?.message === 'string') return payload.error.message;
    return '';
}

// Пункт 2.4: примитивы поллинга вынесены в ../async-utils.js.
function abortError() {
    return baseAbortError('Naistera generation was cancelled.');
}

/**
 * Poll GET /api/generate/jobs/{job_id} until a terminal state or the deadline.
 * Read-only GETs only; a timeout/abort never triggers a second POST.
 * Скелет дедлайна/сна — pollUntil из async-utils (пункт 19).
 */
async function pollJob({ jobUrl, token, transport, route, connection, signal, deadlineAt, diagnostic }) {
    return pollUntil({
        signal,
        deadlineAt,
        intervalMs: POLL_INTERVAL_MS,
        timeoutError: () => {
            const error = providerError('NAISTERA_JOB_TIMEOUT', 'Naistera job did not complete before the connection timeout.');
            error.jobStatus = 'timeout';
            return error;
        },
        attempt: async (remainingMs) => {
            const response = await transport.requestJson(
                jobUrl,
                diagnosticRequestOptions({
                    method: 'GET',
                    headers: { Authorization: `Bearer ${token}` },
                    signal,
                }, diagnostic, {
                    bodyKind: 'json',
                    wireFields: [],
                    omittedFields: [],
                    phase: 'poll',
                }),
                route,
                remainingMs,
            );
            const payload = await readJsonResponse(response, 'Naistera Jobs', authProfileFor('naistera'));
            const status = jobStatus(payload);
            if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
                const detail = jobErrorMessage(payload);
                const error = providerError('NAISTERA_JOB_FAILED', `Naistera job ${status}${detail ? `: ${detail.slice(0, 240)}` : '.'}`);
                error.jobStatus = status;
                return { done: false, error };
            }
            const result = extractResult(payload, { allowMissing: true });
            // A present image is authoritative regardless of the declared status:
            // some APIs omit status on the completed response and just carry the
            // image payload.
            if (result) return { done: true, value: result };
            if (TERMINAL_STATES.has(status)) {
                return { done: false, error: providerError('NAISTERA_JOB_FAILED', `Naistera job ended in status "${status}" without an image.`) };
            }
            return { done: false };
        },
    });
}

export async function generateNaisteraImage(input) {
    const { endpoint, apiKey, route, request, transport, signal, connection = {}, diagnostic = null, parsedReferences } = requireInvocation(input);
    const token = validateNaisteraToken(apiKey);
    const preset = request?.preset ?? connection?.extraBody?.preset;
    const effectiveRequest = preset === undefined ? request : { ...request, preset };
    const { payload, references } = body(route, effectiveRequest, parsedReferences);
    if (references.length && route?.capabilities?.references !== 'supported') {
        throw providerError('REFERENCES_UNSUPPORTED', 'Naistera reference support was not declared for this model; the request was stopped before the paid POST.');
    }
    const timeoutMs = Math.max(1, Number.isFinite(connection.timeoutMs) ? connection.timeoutMs : 120000);
    const deadlineAt = Date.now() + timeoutMs;

    const response = await transport.requestJson(
        `${baseUrl(endpoint)}${NAISTERA_DESCRIPTOR.endpoint.generationPath}`,
        diagnosticRequestOptions({
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal,
        }, diagnostic, {
            bodyKind: 'json',
            wireFields: Object.keys(payload),
            omittedFields: references.length ? [] : ['reference_objects', 'preset'],
        }),
        route,
        connection.timeoutMs,
    );
    const initial = await readJsonResponse(response, 'Naistera Generate', authProfileFor('naistera'));

    // Synchronous completion: the POST response already carries the image.
    const immediate = extractResult(initial, { allowMissing: true });
    if (immediate) return immediate;

    // Async: poll the job under the same deadline and signal.
    const jobId = String(initial?.job_id ?? initial?.jobId ?? initial?.id ?? '').trim();
    if (!jobId) throw providerError('UPSTREAM_RESPONSE_INVALID', 'Naistera returned neither an image nor a job_id.');
    return pollJob({
        jobUrl: baseUrl(endpoint) + interpolatePath(NAISTERA_DESCRIPTOR.endpoint.jobPath, { jobId }),
        token,
        transport,
        route,
        connection,
        signal,
        deadlineAt,
        diagnostic,
    });
}
