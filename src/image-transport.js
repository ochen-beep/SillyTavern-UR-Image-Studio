// @ts-check
/**
 * Route-scoped browser transport for image requests.
 *
 * This module deliberately does not cache delivery strategy or modify the
 * persisted route. A paid image POST gets one direct request; after a
 * CORS/network failure there is exactly one safe escalation — the preflight
 * oracle: for an auto-policy JSON POST a CORS-masked failure is almost always
 * a preflight refusal (nothing was sent), and the oracle verifies that with a
 * free OPTIONS probe before re-dispatching through /proxy/. Anything less
 * provable throws the typed ambiguous error; delivery experience recording
 * goes through delivery-evidence.js as fire-and-forget telemetry, the same
 * category as recordDiagnosticEvent: the transport itself stays stateless.
 * (2026-09-28 cleanup: the legacy proxyEligible/allowProxyFallback/noResubmit
 * route flags and the never-reachable GET proxy fallback were removed —
 * downloads go through autoFetch, catalogs through catalogRequest, and no
 * adapter ever issued a JSON GET through this transport.)
 */
import { fetchWithTimeout, getCtx, trace } from './core.js'
import { recordDiagnosticEvent } from './diagnostic-events.js';
import { autoFetch, proxiedFetch, isCorsOrNetworkError, isCorsProxyAvailable } from './proxy.js';
import { notePreflightOracleDead, noteDeliveryPostOutcome } from './delivery-evidence.js';

/** Typed code for the multipart-over-direct-CORS rejection (no export of the string elsewhere). */
export const MULTIPART_CORS_REQUIRED = 'MULTIPART_CORS_REQUIRED';

function isAbortOrTimeout(error, signal) {
    return signal?.aborted
        || error?.name === 'AbortError'
        // code — типизированный путь; регэкс — легаси-фолбэк для сторонних
        // создателей таймаут-ошибок (tests, внешние вызовы fetchWithTimeout).
        || error?.code === 'FETCH_TIMEOUT'
        || /Таймаут/.test(error?.message || '');
}

function transportFor(route, options = {}) {
    const transport = route?.transport;
    if (!transport || typeof transport !== 'object') {
        throw new TypeError('Image routes require explicit transport metadata.');
    }

    const bodyKind = transport.bodyKind;
    const directCors = transport.directCors;
    // Who chose the initial delivery: browserDeliveryRoute stamps 'auto' when
    // the «Авто» ladder picked the path, 'explicit-direct'/'explicit-proxy'
    // when the user ordered it on the card. Absent (routes built outside the
    // dispatch flow — legacy records, tests) means explicit-direct: behavior
    // stays exactly as before the oracle existed.
    const deliveryPolicy = transport.deliveryPolicy === 'auto'
        || transport.deliveryPolicy === 'explicit-direct'
        || transport.deliveryPolicy === 'explicit-proxy'
        ? transport.deliveryPolicy
        : 'explicit-direct';
    // initialDelivery selects the transport a paid POST takes on its FIRST
    // attempt. 'proxy' is set by `browserDeliveryRoute` when the connection
    // opted into the ST CORS proxy (or «Авто» learned it) AND the route is
    // JSON-eligible; the request is dispatched through /proxy/ immediately,
    // with no direct attempt, so there is no ambiguous "did the POST reach
    // the provider?" state to reason about. Multipart routes can never go
    // proxy-first (the ST /proxy/ is JSON-only).
    const initialDelivery = transport.initialDelivery === 'proxy' ? 'proxy' : 'direct';
    const method = String(options.method || 'GET').toUpperCase();

    if (bodyKind !== 'json' && bodyKind !== 'multipart') {
        throw new TypeError('Image routes require transport.bodyKind to be json or multipart.');
    }
    if (typeof directCors !== 'string') {
        throw new TypeError('Image routes require explicit directCors transport metadata.');
    }

    if (bodyKind === 'multipart' && directCors !== 'required') {
        throw new TypeError('Multipart routes require direct CORS and cannot use the proxy.');
    }
    // Proxy-first delivery is a user opt-in or a learned «Авто» decision for
    // the FIRST attempt. The only hard constraint is bodyKind:json (the ST
    // /proxy/ is JSON-only and cannot forward multipart).
    if (initialDelivery === 'proxy' && bodyKind !== 'json') {
        throw new TypeError('Proxy-first delivery requires a JSON route (multipart cannot traverse the ST /proxy/).');
    }

    return { bodyKind, directCors, initialDelivery, deliveryPolicy, method };
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

/**
 * Пункт 2.2 плана 2026-10-05: транспорт возвращает факт доставки. Каждый
 * успешный возврат Response помечается несчётным свойством __urisAttempt —
 * обёртка реестра (image-provider-registry.js) переносит finalDelivery на
 * invocation.request.delivery, и image-api.js читает штамп в finally. Журнал
 * диагностики с этого момента никем не читается (write-only). defineProperty
 * с try/catch: тестовые двойники Response могут не переживать определение
 * свойства — тогда штампа просто нет (finalDelivery 'unknown' недопустим
 * молча ускользнуть: отсутствие штампа = поведение «как было»).
 */
function stampAttempt(response, info) {
    if (!response || typeof response !== 'object') return response;
    try {
        Object.defineProperty(response, '__urisAttempt', {
            value: Object.freeze({ ...info }),
            enumerable: false,
            configurable: true,
            writable: false,
        });
    } catch { /* свойство не поставилось — управление идёт через штампы адаптеров */ }
    return response;
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
 * Fetch an image route directly; the only escalation after a CORS/network
 * failure is the preflight-oracle rescue for auto-policy JSON POSTs.
 *
 * @param {string} url
 * @param {RequestInit & { signal?: AbortSignal }} [options]
 * @param {{ transport?: { bodyKind?: string, directCors?: string } }} route
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
    // proxy for a JSON-eligible route (provider sends no CORS headers at all).
    // Dispatch the paid POST through /proxy/ on the FIRST
    // attempt - no direct try, no ambiguous state, no double billing risk.
    // Multipart routes are rejected by transportFor before reaching here.
    if (transport.initialDelivery === 'proxy') {
        const attemptStartedAt = Date.now();
        try {
            const response = await proxiedFetch(url, proxyOptions(wireOptions), timeoutMs);
            if (method === 'POST') recordDiagnosticEvent({ event: 'dispatch-response', stage: diagnostic?.stage || 'stage2', requestId: diagnostic?.requestId || null, attemptId: rootAttemptId, attemptIndex: attemptDiagnostic.attemptIndex, delivery: 'proxy', bodyKind: transport.bodyKind, status: response?.status ?? null, outcome: 'response', durationMs: Date.now() - attemptStartedAt });
            return stampAttempt(response, { initialDelivery: 'proxy', finalDelivery: 'proxy', rescuedBy: null, attempts: 1 });
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
        // Delivery fact (2026-09-28): a direct POST answered — the «Авто» ladder
        // may clear its broken verdict. JSON POSTs only; multipart proves nothing
        // about the JSON path, and proxy-first dispatches say nothing about it.
        if (method === 'POST' && transport.bodyKind === 'json' && transport.initialDelivery !== 'proxy') {
            noteDeliveryPostOutcome({ connId: diagnostic?.connId, endpoint: url, delivery: 'direct', ok: true }).catch(() => {});
        }
        return stampAttempt(response, { initialDelivery: 'direct', finalDelivery: 'direct', rescuedBy: null, attempts: 1 });
    } catch (error) {
        if (isAbortOrTimeout(error, options.signal)) {
            if (method === 'POST') recordDiagnosticEvent({ event: 'dispatch-error', level: 'error', stage: diagnostic?.stage || 'stage2', requestId: diagnostic?.requestId || null, attemptId: rootAttemptId, attemptIndex: attemptDiagnostic.attemptIndex, delivery: 'direct', bodyKind: transport.bodyKind, outcome: error?.name === 'AbortError' ? 'abort' : 'timeout', durationMs: Date.now() - attemptStartedAt, details: { code: error?.code || null } });
            throw error;
        }

        if (transport.bodyKind === 'multipart') {
            if (isCorsOrNetworkError(error)) {
                if (method === 'POST') recordDiagnosticEvent({ event: 'dispatch-error', level: 'error', stage: diagnostic?.stage || 'stage2', requestId: diagnostic?.requestId || null, attemptId: rootAttemptId, attemptIndex: attemptDiagnostic.attemptIndex, delivery: 'direct', bodyKind: transport.bodyKind, outcome: 'preflight-cors', durationMs: Date.now() - attemptStartedAt, details: { code: MULTIPART_CORS_REQUIRED } });
                throw multipartCorsError(error);
            }
            if (method === 'POST') recordDiagnosticEvent({ event: 'dispatch-error', level: 'error', stage: diagnostic?.stage || 'stage2', requestId: diagnostic?.requestId || null, attemptId: rootAttemptId, attemptIndex: attemptDiagnostic.attemptIndex, delivery: 'direct', bodyKind: transport.bodyKind, outcome: 'network-unknown', durationMs: Date.now() - attemptStartedAt, details: { code: error?.code || null } });
            throw error;
        }

        if (!isCorsOrNetworkError(error)) throw error;

        // ── Preflight oracle (2026-09-28) ──────────────────────────────────
        // For an auto-policy JSON POST a CORS/network TypeError is almost
        // always a preflight refusal: the Authorization/Content-Type headers
        // force the browser to preflight, and a failed preflight means the
        // request body never left the browser — so re-dispatching through the
        // ST /proxy/ is provably free of double-billing. «Almost» is not
        // «always» (a half-CORS server can pass preflight and then withhold
        // ACAO from the POST response), so the assumption is verified with a
        // free OPTIONS probe before the retry instead of being trusted:
        //   dead   — OPTIONS itself failed or answered a readable non-2xx;
        //            the automatic preflight would fail the same way → safe.
        //   alive  — readable 2xx: preflight works, the POST died mid-flight;
        //            outcome genuinely unknown → ambiguous, no re-send.
        //   unknown— OPTIONS timed out or aborted → cannot decide → ambiguous.
        // User cancellation during the probe propagates as AbortError. A known
        // disabled ST proxy skips the rescue: a guaranteed proxy error helps
        // nobody, and the ambiguous path at least records the failure.
        if (method === 'POST' && transport.bodyKind === 'json' && transport.deliveryPolicy === 'auto') {
            const verdict = await probePreflightDelivery(url, options.signal, timeoutMs);
            if (verdict === 'dead' && isCorsProxyAvailable() !== false) {
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
                    delivery: 'proxy', bodyKind: 'json', outcome: 'dispatching',
                    details: { reason: 'preflight-oracle' },
                });
                // Telemetry for the «Авто» ladder: the direct path is broken
                // right now — the next generation should go proxy-first
                // without re-paying for this discovery. Fire-and-forget.
                if (diagnostic?.connId) {
                    notePreflightOracleDead(diagnostic.connId, url).catch(() => {});
                }
                try {
                    const fallbackStartedAt = Date.now();
                    const response = await proxiedFetch(url, proxyOptions(withDiagnostic({ ...options }, fallbackDiagnostic, diagnostic?.role || 'generation', 'json')), timeoutMs);
                    if (method === 'POST') recordDiagnosticEvent({ event: 'dispatch-response', stage: diagnostic?.stage || 'stage2', requestId: diagnostic?.requestId || null, attemptId: fallbackDiagnostic.attemptId, attemptIndex: fallbackDiagnostic.attemptIndex, parentAttemptId: fallbackDiagnostic.parentAttemptId, delivery: 'proxy', bodyKind: 'json', status: response?.status ?? null, outcome: 'response', durationMs: Date.now() - fallbackStartedAt, details: { reason: 'preflight-oracle' } });
                    return stampAttempt(response, { initialDelivery: 'direct', finalDelivery: 'proxy', rescuedBy: 'preflight-oracle', attempts: 2 });
                } catch (fallbackError) {
                    if (method === 'POST') recordDiagnosticEvent({ event: 'dispatch-error', level: 'error', stage: diagnostic?.stage || 'stage2', requestId: diagnostic?.requestId || null, attemptId: fallbackDiagnostic.attemptId, attemptIndex: fallbackDiagnostic.attemptIndex, parentAttemptId: fallbackDiagnostic.parentAttemptId, delivery: 'proxy', bodyKind: 'json', outcome: fallbackError?.name === 'AbortError' ? 'abort' : 'network-unknown', details: { code: fallbackError?.code || null, reason: 'preflight-oracle' } });
                    throw fallbackError;
                }
            }
        }

        // Каждый CORS/сетевой сбой после оракула — типизированный ambiguous:
        // доказательств «запрос не ушёл» нет, переотправка запрещена. Факты
        // для лестницы «Авто» пишет только JSON-POST (GET — скачивания/каталоги
        // через autoFetch/catalogRequest, сюда они не доходят).
        if (method === 'POST') recordDiagnosticEvent({ event: 'dispatch-error', level: 'error', stage: diagnostic?.stage || 'stage2', requestId: diagnostic?.requestId || null, attemptId: rootAttemptId, attemptIndex: attemptDiagnostic.attemptIndex, delivery: 'direct', bodyKind: transport.bodyKind, outcome: 'network-unknown', durationMs: Date.now() - attemptStartedAt, details: { code: 'IMAGE_DELIVERY_AMBIGUOUS' } });
        if (method === 'POST' && transport.bodyKind === 'json') {
            noteDeliveryPostOutcome({ connId: diagnostic?.connId, endpoint: url, delivery: 'direct', ok: false }).catch(() => {});
        }
        throw ambiguousDeliveryError(error, 'image', transport.deliveryPolicy);
    }
}

function multipartCorsError(cause) {
    const error = new Error('Multipart image requests require direct CORS. Enable CORS on the image provider or use a JSON image route.', { cause });
    error.code = MULTIPART_CORS_REQUIRED;
    return error;
}

/**
 * Manual CORS-preflight probe: would the browser's automatic preflight for a
 * POST to this URL succeed right now? A custom header makes the manual OPTIONS
 * itself non-simple, so a gateway without generic OPTIONS handling fails it —
 * exactly what the POST's preflight would do. Never billed; failures here
 * cost one round trip.
 *
 * 'alive' requires a READABLE 2xx (CORS-satisfiable): a bare 200 without ACAO
 * throws the same opaque TypeError as a dead route. A readable non-2xx means
 * ACAO is present but the status would still fail the automatic preflight
 * (browsers require ok) — that is 'dead'. A timeout or user abort must not
 * decide ('unknown'): transient slowness is not proof of a blocked preflight.
 *
 * Exported for the adapter-level dialect chain (image-openai.js): a multipart
 * edit that died on CORS may be retried as a different wire dialect only when
 * the same proof exists.
 *
 * @param {string} url
 * @param {AbortSignal|undefined} signal
 * @param {number} timeoutMs — caller budget; the probe caps itself at 8s
 * @returns {Promise<'dead'|'alive'|'unknown'>}
 */
export async function probePreflightDelivery(url, signal, timeoutMs) {
    try {
        const response = await fetchWithTimeout(url, {
            method: 'OPTIONS',
            headers: {
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'authorization, content-type',
            },
            ...(signal ? { signal } : {}),
        }, Math.min(timeoutMs, 8000));
        return response.ok ? 'alive' : 'dead';
    } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        if (error?.code === 'FETCH_TIMEOUT' || /Таймаут/.test(error?.message || '')) return 'unknown';
        return isCorsOrNetworkError(error) ? 'dead' : 'unknown';
    }
}

/**
 * Пункт 2.4: единая фабрика «неизвестный исход платного запроса» для
 * картинокного (image-transport) и текстового (proxy.autoFetch) путей —
 * раньше две копии с разными текстами и кодами. scope 'text' сохраняет
 * исторические текст/код/флаг noRetry прокси-пути (тесты без правок).
 */
export function ambiguousDeliveryError(cause, scope = 'image', policy = 'explicit-direct') {
    const message = scope === 'text'
        ? 'Запрос не получил ответ напрямую (CORS или обрыв связи) и мог быть уже обработан провайдером, поэтому автоматически не повторяется. Повторите действие — следующая попытка уйдёт через прокси SillyTavern (требуется enableCorsProxy в config.yaml).'
        : `Прямой запрос к провайдеру не получил ответа (CORS или обрыв связи), и его исход неизвестен — возможно, запрос уже обработан и будет оплачен, поэтому автоматически он не повторяется. ${policy === 'auto'
            ? 'Повторите генерацию (кнопка «Повторить» в ленте очереди) — следующая попытка уйдёт через прокси SillyTavern: прямая доставка помечена нерабочей на ~30 минут.'
            : 'Доставка ограничена настройкой «Только напрямую» — повтор пойдёт той же дорогой.'}`;
    const error = new Error(message, { cause });
    error.code = scope === 'text' ? 'DELIVERY_AMBIGUOUS' : 'IMAGE_DELIVERY_AMBIGUOUS';
    if (scope === 'text') error.noRetry = true;
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
