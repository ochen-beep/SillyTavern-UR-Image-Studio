// @ts-check
/**
 * Route-scoped browser transport for image requests.
 *
 * This module deliberately does not cache delivery strategy or modify the
 * persisted route. A paid image POST gets one direct request; explicitly safe
 * JSON routes may use proxy fallback after a no-response CORS/network failure.
 */
import { fetchWithTimeout, getCtx, trace } from './core.js'
import { recordDiagnosticEvent } from './diagnostic-events.js';
import { autoFetch, proxiedFetch, isCorsOrNetworkError } from './proxy.js';

function isAbortOrTimeout(error, signal) {
    return signal?.aborted
        || error?.name === 'AbortError'
        || /Таймаут/.test(error?.message || '');
}

function transportFor(route, options = {}) {
    const transport = route?.transport;
    if (!transport || typeof transport !== 'object') {
        throw new TypeError('Image routes require explicit transport metadata.');
    }

    const bodyKind = transport.bodyKind;
    const proxyEligible = transport.proxyEligible;
    const directCors = transport.directCors;
    const allowProxyFallback = transport.allowProxyFallback !== false;
    // initialDelivery selects the transport a paid POST takes on its FIRST
    // attempt. 'proxy' is set by `browserDeliveryRoute` when the connection
    // opted into the ST CORS proxy AND the route is JSON-eligible; the request
    // is dispatched through /proxy/ immediately, with no direct attempt, so
    // there is no ambiguous "did the POST reach the provider?" state to
    // reason about. Multipart routes can never go proxy-first (the ST /proxy/
    // is JSON-only).
    const initialDelivery = transport.initialDelivery === 'proxy' ? 'proxy' : 'direct';
    // This marker belongs to dispatch intent, not route discovery policy. A
    // browser-paid POST is never eligible for a second delivery attempt.
    const method = String(options.method || 'GET').toUpperCase();
    const noResubmit = method === 'POST'
        || route?.noResubmit === true
        || transport.noResubmit === true;

    if (bodyKind !== 'json' && bodyKind !== 'multipart') {
        throw new TypeError('Image routes require transport.bodyKind to be json or multipart.');
    }
    if (typeof proxyEligible !== 'boolean' || typeof directCors !== 'string') {
        throw new TypeError('JSON routes require explicit proxyEligible and directCors transport metadata.');
    }

    if (bodyKind === 'multipart' && (proxyEligible || directCors !== 'required')) {
        throw new TypeError('Multipart routes require direct CORS and cannot use the proxy.');
    }
    // Proxy-first delivery is an explicit user choice for the FIRST attempt
    // (connection useCorsProxy + JSON route). It must NOT be gated by the
    // route's `proxyEligible` flag, because catalog.js marks every route
    // proxyEligible:false to block the automatic direct->proxy fallback -
    // that protection belongs to the failure-retry branch below, not to the
    // initial delivery decision. The only hard constraint is bodyKind:json
    // (the ST /proxy/ is JSON-only and cannot forward multipart).
    if (initialDelivery === 'proxy' && bodyKind !== 'json') {
        throw new TypeError('Proxy-first delivery requires a JSON route (multipart cannot traverse the ST /proxy/).');
    }

    return { bodyKind, proxyEligible, directCors, allowProxyFallback, noResubmit, initialDelivery };
}

function proxyOptions(options) {
    const requestHeaders = getCtx().getRequestHeaders?.() ?? {};
    return {
        ...options,
        headers: { ...requestHeaders, ...(options.headers ?? {}) },
    };
}

function attemptId() {
    try { return globalThis.crypto?.randomUUID?.() || `attempt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
    catch { return `attempt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
}

function withDiagnostic(options, diagnostic, role = 'generation', bodyKind = null) {
    if (!diagnostic && !role && !bodyKind) return options;
    return {
        ...options,
        __urisDiagnostic: {
            ...(diagnostic || {}),
            role: diagnostic?.role || role,
            ...(bodyKind ? { bodyKind } : {}),
        },
    };
}

/**
 * Fetch an image route directly, using the SillyTavern proxy only for an
 * eligible JSON route after a direct browser network/CORS failure.
 *
 * @param {string} url
 * @param {RequestInit & { signal?: AbortSignal }} [options]
 * @param {{ transport?: { bodyKind?: string, proxyEligible?: boolean, directCors?: string } }} route
 * @param {number} [timeoutMs=120000]
 * @returns {Promise<Response>}
 */
export async function fetchImageRoute(url, options = {}, route, timeoutMs = 120000) {
    const transport = transportFor(route, options);
    const method = String(options.method || 'GET').toUpperCase();
    const diagnostic = options.__urisDiagnostic || null;
    const rootAttemptId = diagnostic?.attemptId || attemptId();
    const attemptDiagnostic = {
        ...(diagnostic || {}),
        attemptId: rootAttemptId,
        attemptIndex: Number.isFinite(diagnostic?.attemptIndex) ? diagnostic.attemptIndex : 0,
        parentAttemptId: diagnostic?.parentAttemptId || null,
        phase: 'post',
        postDispatchState: 'sent-unknown',
    };
    const wireOptions = withDiagnostic({ ...options }, attemptDiagnostic, diagnostic?.role || (method === 'POST' ? 'generation' : 'download'), transport.bodyKind);
    const noResubmit = method === 'POST' || transport.noResubmit;
    if (method === 'POST') {
        recordDiagnosticEvent({
            event: 'dispatch-attempt', stage: diagnostic?.stage || 'stage2',
            requestId: diagnostic?.requestId || null, attemptId: rootAttemptId,
            attemptIndex: attemptDiagnostic.attemptIndex, parentAttemptId: attemptDiagnostic.parentAttemptId,
            connId: diagnostic?.connId || null, routeId: diagnostic?.routeId || null,
            modelId: diagnostic?.modelId || null, generationContract: diagnostic?.generationContract || null,
            operation: diagnostic?.operation || null, delivery: transport.initialDelivery,
            bodyKind: transport.bodyKind, referenceCount: diagnostic?.referenceCount ?? null,
            outcome: 'dispatching', details: { phase: 'post' },
        });
    }
    // Diagnostic: the exact host+path a paid POST goes to and which delivery
    // path was chosen on the first attempt. Query string is stripped — it can
    // carry signed tokens. Logged only for POST so GET probes stay quiet.
    if (method === 'POST') trace(`transport: POST ${url.split('?')[0]} via ${transport.initialDelivery}`, {
        rid: diagnostic?.requestId ? String(diagnostic.requestId).slice(0, 8) : null,
        routeId: diagnostic?.routeId || null,
        contract: diagnostic?.generationContract || null,
        bodyKind: transport.bodyKind,
    });
    // Proxy-first delivery: the connection explicitly opted into the ST CORS
    // proxy for a JSON-eligible route (provider sends no CORS headers at all,
    // e.g. CloseAI). Dispatch the paid POST through /proxy/ on the FIRST
    // attempt - no direct try, no ambiguous state, no double billing risk.
    // Multipart routes are rejected by transportFor before reaching here.
    if (transport.initialDelivery === 'proxy') {
        const attemptStartedAt = Date.now();
        try {
            const response = await proxiedFetch(url, proxyOptions(wireOptions), timeoutMs);
            if (method === 'POST') recordDiagnosticEvent({ event: 'dispatch-response', stage: diagnostic?.stage || 'stage2', requestId: diagnostic?.requestId || null, attemptId: rootAttemptId, attemptIndex: attemptDiagnostic.attemptIndex, delivery: 'proxy', bodyKind: transport.bodyKind, status: response?.status ?? null, outcome: 'response', durationMs: Date.now() - attemptStartedAt });
            return response;
        } catch (error) {
            if (method === 'POST') recordDiagnosticEvent({ event: 'dispatch-error', level: 'error', stage: diagnostic?.stage || 'stage2', requestId: diagnostic?.requestId || null, attemptId: rootAttemptId, attemptIndex: attemptDiagnostic.attemptIndex, delivery: 'proxy', bodyKind: transport.bodyKind, outcome: error?.name === 'AbortError' ? 'abort' : 'network-unknown', durationMs: Date.now() - attemptStartedAt, details: { code: error?.code || null } });
            throw error;
        }
    }
    const attemptStartedAt = Date.now();
    try {
        // A Response, including a 4xx/5xx, proves the direct delivery path worked.
        const response = await fetchWithTimeout(url, wireOptions, timeoutMs);
        if (method === 'POST') recordDiagnosticEvent({ event: 'dispatch-response', stage: diagnostic?.stage || 'stage2', requestId: diagnostic?.requestId || null, attemptId: rootAttemptId, attemptIndex: attemptDiagnostic.attemptIndex, delivery: 'direct', bodyKind: transport.bodyKind, status: response?.status ?? null, outcome: 'response', durationMs: Date.now() - attemptStartedAt });
        return response;
    } catch (error) {
        if (isAbortOrTimeout(error, options.signal)) {
            if (method === 'POST') recordDiagnosticEvent({ event: 'dispatch-error', level: 'error', stage: diagnostic?.stage || 'stage2', requestId: diagnostic?.requestId || null, attemptId: rootAttemptId, attemptIndex: attemptDiagnostic.attemptIndex, delivery: 'direct', bodyKind: transport.bodyKind, outcome: error?.name === 'AbortError' ? 'abort' : 'timeout', durationMs: Date.now() - attemptStartedAt, details: { code: error?.code || null } });
            throw error;
        }

        if (transport.bodyKind === 'multipart') {
            if (isCorsOrNetworkError(error)) {
                if (method === 'POST') recordDiagnosticEvent({ event: 'dispatch-error', level: 'error', stage: diagnostic?.stage || 'stage2', requestId: diagnostic?.requestId || null, attemptId: rootAttemptId, attemptIndex: attemptDiagnostic.attemptIndex, delivery: 'direct', bodyKind: transport.bodyKind, outcome: 'preflight-cors', durationMs: Date.now() - attemptStartedAt, details: { code: 'MULTIPART_CORS_REQUIRED' } });
                throw multipartCorsError(error);
            }
            if (method === 'POST') recordDiagnosticEvent({ event: 'dispatch-error', level: 'error', stage: diagnostic?.stage || 'stage2', requestId: diagnostic?.requestId || null, attemptId: rootAttemptId, attemptIndex: attemptDiagnostic.attemptIndex, delivery: 'direct', bodyKind: transport.bodyKind, outcome: 'network-unknown', durationMs: Date.now() - attemptStartedAt, details: { code: error?.code || null } });
            throw error;
        }

        if (!isCorsOrNetworkError(error)) throw error;
        if (noResubmit || !transport.allowProxyFallback || !transport.proxyEligible || transport.directCors !== 'preferred') {
            if (method === 'POST') recordDiagnosticEvent({ event: 'dispatch-error', level: 'error', stage: diagnostic?.stage || 'stage2', requestId: diagnostic?.requestId || null, attemptId: rootAttemptId, attemptIndex: attemptDiagnostic.attemptIndex, delivery: 'direct', bodyKind: transport.bodyKind, outcome: 'network-unknown', durationMs: Date.now() - attemptStartedAt, details: { code: 'IMAGE_DELIVERY_AMBIGUOUS' } });
            throw ambiguousDeliveryError(error);
        }

        const fallbackDiagnostic = {
            ...attemptDiagnostic,
            attemptId: attemptId(),
            attemptIndex: attemptDiagnostic.attemptIndex + 1,
            parentAttemptId: attemptDiagnostic.attemptId,
            delivery: 'proxy',
            phase: 'post',
            postDispatchState: 'sent-unknown',
        };
        recordDiagnosticEvent({
            event: 'dispatch-fallback', stage: diagnostic?.stage || 'stage2',
            requestId: diagnostic?.requestId || null, attemptId: fallbackDiagnostic.attemptId,
            attemptIndex: fallbackDiagnostic.attemptIndex, parentAttemptId: fallbackDiagnostic.parentAttemptId,
            delivery: 'proxy', bodyKind: 'json', outcome: 'dispatching', details: { reason: 'multipart-or-direct-cors' },
        });
        try {
            const fallbackStartedAt = Date.now();
            const response = await proxiedFetch(url, proxyOptions(withDiagnostic({ ...options }, fallbackDiagnostic, diagnostic?.role || 'generation', 'json')), timeoutMs);
            if (method === 'POST') recordDiagnosticEvent({ event: 'dispatch-response', stage: diagnostic?.stage || 'stage2', requestId: diagnostic?.requestId || null, attemptId: fallbackDiagnostic.attemptId, attemptIndex: fallbackDiagnostic.attemptIndex, parentAttemptId: fallbackDiagnostic.parentAttemptId, delivery: 'proxy', bodyKind: 'json', status: response?.status ?? null, outcome: 'response', durationMs: Date.now() - fallbackStartedAt });
            return response;
        } catch (fallbackError) {
            if (method === 'POST') recordDiagnosticEvent({ event: 'dispatch-error', level: 'error', stage: diagnostic?.stage || 'stage2', requestId: diagnostic?.requestId || null, attemptId: fallbackDiagnostic.attemptId, attemptIndex: fallbackDiagnostic.attemptIndex, parentAttemptId: fallbackDiagnostic.parentAttemptId, delivery: 'proxy', bodyKind: 'json', outcome: fallbackError?.name === 'AbortError' ? 'abort' : 'network-unknown', details: { code: fallbackError?.code || null } });
            throw fallbackError;
        }
    }
}

function multipartCorsError(cause) {
    const error = new Error('Multipart image requests require direct CORS. Enable CORS on the image provider or use a JSON image route.', { cause });
    error.code = 'MULTIPART_CORS_REQUIRED';
    return error;
}

function ambiguousDeliveryError(cause) {
    const error = new Error('Direct image request failed and its outcome is uncertain; this request will not be resent automatically.', { cause });
    error.code = 'IMAGE_DELIVERY_AMBIGUOUS';
    return error;
}

/** Request a contract-declared JSON image route. */
export function requestJson(url, options = {}, route = {}, timeoutMs = 120000) {
    return fetchImageRoute(url, options, {
        ...route,
        transport: { ...(route.transport || {}), bodyKind: 'json' },
    }, timeoutMs);
}

/** Request a multipart image route directly; multipart is never proxied. */
export function requestMultipart(url, options = {}, route = {}, timeoutMs = 120000) {
    return fetchImageRoute(url, options, {
        ...route,
        transport: {
            ...(route.transport || {}),
            bodyKind: 'multipart',
            proxyEligible: false,
            directCors: 'required',
            // Multipart can never go proxy-first (ST /proxy/ is JSON-only).
            // Clear any inherited initialDelivery:'proxy' from browserDeliveryRoute
            // (catalog marks all routes bodyKind:'json', so proxy-first may be set
            // before the provider switches to multipart for non-gpt-image edits).
            initialDelivery: 'direct',
        },
    }, timeoutMs);
}

/**
 * Download a result image, falling back to the ST proxy when the host blocks a
 * direct cross-origin read.
 *
 * This runs AFTER the provider POST has already been billed, so a CORS failure
 * here loses an image the user paid for. autoFetch tries direct first (keeping
 * the fast path for CDNs that send CORS headers) and only then proxies, caching
 * the working strategy per host.
 */
export function downloadResult(url, options = {}, timeoutMs = 120000) {
    return autoFetch(url, options, timeoutMs);
}
