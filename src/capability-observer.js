// @ts-check
/**
 * Diagnostic logging for one image-generation dispatch attempt.
 *
 * This module is DELIBERATELY diagnostic-only: it classifies what a real,
 * user-paid generation actually did and writes a single grep-able line to the
 * panel log. It persists nothing, reads nothing back, and never influences
 * routing, payload building, or capability gating.
 *
 * That is a deliberate narrowing. An earlier iteration persisted observation
 * records on the route and offered `getCapabilityProfile` to read them back.
 * Nothing ever read them, and the code that *does* gate behaviour reads
 * `route.capabilities.*` — a different field this module never wrote. Keeping a
 * second, invisible source of truth about "what this route supports" would let
 * the connection card silently disagree with actual behaviour, so the write
 * path was removed rather than wired up: confirming a capability requires a
 * billed attempt, connections are few, and the user already sets the protocol
 * explicitly on the card. The card stays the single visible source of truth.
 *
 * Nothing here issues provider requests or retries a paid POST.
 *
 * Outcome taxonomy deliberately separates concerns:
 *   - capability       success / unsupported-feature
 *   - auth/key state   auth / quota
 *   - runtime health   rate-limit / provider-error / timeout
 *   - not a capability invalid-request / content-policy / missing-image /
 *                      malformed / materialize
 *   - unprovable       network-unknown  (CORS/abort/transport ambiguity —
 *                      never reported as unsupported)
 */
import { log, warn } from './core.js';
import { recordDiagnosticEvent } from './diagnostic-events.js';
import { CONTRACTS } from './image-connection-schema.js';

const CONTRACTS_SET = new Set(Object.values(CONTRACTS));

// ── Operation / reference-mode / delivery inference ────────────────────────
//
// `classifyOperation` maps the persisted route + the actual outgoing request
// to a stable `(operation, referenceMode)` pair, so an «edit with one
// reference» success cannot be misread in the log as proof that «generate
// without references» works.

// The /images/edits dialect is an explicit property of the connection, never
// inferred from the model ID: the same gpt-image-2 wants multipart on one
// gateway and JSON on another, so a name-based guess is wrong somewhere by
// construction. This mirrors `editProtocol` in providers/image-openai.js and
// must stay in sync with it, otherwise the log names a dialect that was never
// actually used on the wire. The provider stamps the dialect it actually
// dispatched onto the request (image-openai.js sets `request.editDialect`
// before an edit goes out; the multipart→JSON proxy fallback re-stamps it),
// and that stamp wins over the persisted connection value — exactly like the
// `request.delivery` stamp below.
function editsDialect(connection, request = {}) {
  const stamped = request?.editDialect;
  if (stamped === 'json' || stamped === 'multipart' || stamped === 'img2img') return stamped;
  return connection?.editProtocol === 'json' ? 'json' : 'multipart';
}

const REFERENCE_MODE_BY_CONTRACT = {
  // OpenAI Images: JSON edits carry images[].image_url data URLs; multipart
  // edits carry repeated binary `image` parts; the img2img dialect carries
  // generations+image[] data URLs (gateway extension, last chain rung).
  'openai-images': (refs, _route, connection, request) => {
    if (!refs.length) return 'none';
    const dialect = editsDialect(connection, request);
    return dialect === 'json' ? 'json-data-url' : dialect === 'img2img' ? 'generations-image' : 'multipart';
  },
  // Chat Completions: references are multimodal image_url parts with data URLs.
  'chat-completions': refs => refs.length ? 'multimodal-data-url' : 'none',
  // Gemini: references are inlineData inline base64.
  'gemini-native': refs => refs.length ? 'inline-data' : 'none',
  // Gemini Interactions: references are input[] image items (base64).
  'gemini-interactions': refs => refs.length ? 'inline-data' : 'none',
  // OpenRouter: references are input_references image_url with data URLs.
  'openrouter-images': refs => refs.length ? 'multimodal-data-url' : 'none',
  'pollinations-images': refs => refs.length ? 'unsupported' : 'none',
  // Naistera: reference_objects carry data URLs plus optional descriptions.
  'naistera': refs => refs.length ? 'json-reference-objects' : 'none',
};

const OPERATION_BY_CONTRACT = {
  // OpenAI Images splits by reference presence: bare generation vs edit.
  // The edit dialect comes from the connection, not the model ID.
  'openai-images': (refs, _route, connection, request) => {
    if (!refs.length) return 'generate';
    const dialect = editsDialect(connection, request);
    return dialect === 'json' ? 'edit-json' : dialect === 'img2img' ? 'edit-img2img' : 'edit-multipart';
  },
  'chat-completions': () => 'chat-image',
  'gemini-native': () => 'gemini-inline',
  'gemini-interactions': () => 'gemini-interactions',
  'openrouter-images': () => 'openrouter-generate',
  'pollinations-images': () => 'pollinations-generate',
  'naistera': () => 'naistera-generate',
};

/**
 * Infer the stable (operation, referenceMode) descriptor and the actually-used
 * delivery path from the route + outgoing request. `delivery` records the
 * transport that was *observed* by the dispatcher, not the route declaration:
 * when the dispatcher stamped `request.delivery` (image-api.js) that value
 * wins; otherwise it is inferred — multipart is always direct (the ST /proxy/
 * cannot forward multipart — it re-serializes the body as JSON); JSON routes
 * today go direct first, so a JSON route is recorded as 'direct' here unless
 * the route is marked proxy-first. This stays in sync with
 * `image-transport.js` `fetchImageRoute`.
 *
 * @param {object} route Normalized route contract.
 * @param {object} request Outgoing image request (carries `references`; may
 *   also carry the provider stamps `editDialect` and `delivery` set by
 *   image-openai.js/image-api.js, which override the connection-declared
 *   dialect/delivery — see editsDialect and the delivery logic below).
 * @param {{ editProtocol?: string }} [connection] Connection whose explicit
 *   `editProtocol` selects the /images/edits dialect.
 * @returns {{operation:string, referenceMode:string, delivery:'direct'|'proxy'}}
 */
export function classifyOperation(route, request, connection = {}) {
  const contract = route?.generationContract;
  const refs = Array.isArray(request?.references) ? request.references : [];
  if (!CONTRACTS_SET.has(contract)) {
    // Unknown contract -> fold into a stable neutral bucket so we never crash
    // the generation path over a malformed route; observers become no-ops.
    return { operation: 'unknown', referenceMode: refs.length ? 'unknown' : 'none', delivery: 'direct' };
  }
  const referenceMode = REFERENCE_MODE_BY_CONTRACT[contract](refs, route, connection, request);
  const operation = OPERATION_BY_CONTRACT[contract](refs, route, connection, request);
  // Prefer the dispatcher's stamp (image-api.js sets request.delivery from the
  // browserDeliveryRoute decision, which already folds in the connection-level
  // useCorsProxy override and the multipart guard; the multipart→JSON proxy
  // fallback re-stamps it to 'proxy' because the retry actually went through
  // /proxy/). Route-only inference stays as the fallback for observations
  // without a dispatched request.
  const stamped = request?.delivery === 'proxy' || request?.delivery === 'direct' ? request.delivery : null;
  const transport = route?.transport || {};
  // Multipart is never proxied (SillyTavern /proxy/ is JSON-only). A multipart
  // edit stays direct even though the catalog marks the route bodyKind:'json'
  // (the provider switches per-request), so treat it as direct-only here too.
  const isMultipartEdit = contract === 'openai-images' && refs.length && editsDialect(connection, request) === 'multipart';
  const delivery = stamped
    || (transport.bodyKind === 'multipart' || isMultipartEdit
      ? 'direct'
      : (transport.initialDelivery === 'proxy' ? 'proxy' : 'direct'));
  return { operation, referenceMode, delivery };
}

// ── Outcome classification ─────────────────────────────────────────────────

const NETWORK_ERROR_CODES = new Set([
  'MULTIPART_CORS_REQUIRED',
  'IMAGE_DELIVERY_AMBIGUOUS',
  // Текстовый собрат (proxy.js autoFetch) — единая семантика «исход неизвестен».
  'DELIVERY_AMBIGUOUS',
  'CATALOG_CORS_BLOCK',
  // The ST /proxy/ itself is off or unreachable (proxy.js). Delivery failure,
  // not materialize: classifying it as "generation succeeded, storage failed"
  // would lie about a paid POST that may never have been sent.
  'CORS_PROXY_UNAVAILABLE',
]);
const INVALID_REQUEST_CODES = new Set([
  'INVALID_IMAGE_REQUEST',
  'INVALID_ENDPOINT',
  'INVALID_ROUTE',
  'INVALID_TRANSPORT',
  'INVALID_REFERENCE',
  'ROUTE_SELECTION_REQUIRED',
  'REFERENCES_UNSUPPORTED',
  'TOO_MANY_REFERENCES',
  'MISSING_API_KEY',
  'POLLINATIONS_TOKEN_REQUIRED',
  'POLLINATIONS_TOKEN_INVALID',
  'NAISTERA_TOKEN_REQUIRED',
  'NAISTERA_TOKEN_INVALID',
  'NAISTERA_VIDEO_UNSUPPORTED',
  'AUTH_REQUIRED',
  'AUTH_INVALID',
  'AUTH_EXPIRED',
  'REFERENCE_TOO_LARGE',
  'REFERENCE_BYTE_BUDGET_EXCEEDED',
  'UNSUPPORTED_CONTRACT_VERSION',
  'UNSUPPORTED_GENERATION_CONTRACT',
]);

const UPSTREAM_FEATURE_DISSENT = [
  // Editing restriction — provider/service masks edit support behind a
  // «compatible providers» allowlist.
  /image editing is only supported/i,
  // The /images/* endpoint only serves image models; a text/chat model is rejected.
  /\bimages? endpoint (?:requires|only supports) an? ?image model/i,
  /only imagen models are supported/i,
  // The model is not on this contract/path at all.
  /model .* is not (?:supported|available)/i,
  /\bmodel not supported\b/i,
  // Parameter nitpicks ⇒ constraints, not full unsupported.
  /response_format is unsupported/i,
  /multipart is unsupported/i,
  /\bimage_url is required\b/i,
  // Reference-count ceilings.
  /maximum (\d+) (?:image|reference|input)/i,
];
const CONTENT_POLICY_RE = /content|safety|policy/i;
const QUOTA_RE = /quota|exhausted|insufficient_quota|billing|баланс|биллинг/i;

function isCorsOrNetworkFailure(error) {
  return (error instanceof TypeError && /Failed to fetch|Load failed|NetworkError/i.test(error?.message || ''))
    || NETWORK_ERROR_CODES.has(error?.code);
}
function isAbort(error) {
  return error?.name === 'AbortError'
    || error?.code === 20 // DOMException AbortError
    || /timeout/i.test(error?.message || '');
}

/**
 * Classify the outcome of one dispatch attempt. Pure function; never throws.
 *
 * @param {Error|null} error  Null on success. May carry `.code` and `.httpStatus`
 *                             (ImageProviderError with httpStatus enrichment;
 *                             materialize failures have neither).
 * @param {number|null} [httpStatus] Fallback upstream status when not on error.
 * @returns {string} One of the outcome codes listed in the module header.
 */
export function classifyOutcome(error, httpStatus = null) {
  if (!error) return 'success';
  const code = error.code || null;
  const status = Number.isSafeInteger(error.httpStatus) ? error.httpStatus : (Number.isSafeInteger(httpStatus) ? httpStatus : null);
  const message = error.message || '';

  // Transport / cancel: never capability/unsupported.
  if (isAbort(error)) return 'timeout';
  if (isCorsOrNetworkFailure(error)) return 'network-unknown';

  // Image provider sends a structured `UPSTREAM_RESPONSE_INVALID`. Two sub-cases:
  //   missing-image — 200 OK, JSON parsed, but the image was not found; this
  //     is a parse/contract gap, NOT a capability statement.
  //   malformed    — JSON.body parse / compression-recovery failure.
  if (code === 'UPSTREAM_RESPONSE_INVALID') {
    return /without an image/i.test(message) ? 'missing-image' : 'malformed';
  }

  // Pre-flight client errors (bad reference, route incomplete, unsupported
  // contract version, references-exceed-policy). These are surfaced via
  // ImageProviderError but are request-shape problems, not capability.
  if (code === 'AUTH_REQUIRED' || code === 'AUTH_INVALID' || code === 'AUTH_EXPIRED'
    || code === 'POLLINATIONS_TOKEN_REQUIRED' || code === 'POLLINATIONS_TOKEN_INVALID'
    || code === 'NAISTERA_TOKEN_REQUIRED' || code === 'NAISTERA_TOKEN_INVALID') return 'auth';
  if (INVALID_REQUEST_CODES.has(code)) return 'invalid-request';

  if (code === 'UPSTREAM_HTTP_ERROR' || status != null) {
    const s = status ?? null;
    // Auth-shaped upstream responses. ST /proxy/ remaps 401->400, so a 400
    // under proxy delivery with an auth-flavoured message is auth, not
    // invalid-request; we still let explicit `MISSING_API_KEY` win above.
    if (s === 401 || s === 403) return 'auth';
    if (s === 402 || (s === 429 && QUOTA_RE.test(message))) return 'quota';
    if (s === 429) return 'rate-limit';
    if (s != null && s >= 500 && s < 600) return 'provider-error';

    // 400/404 split: feature-dissent message ⇒ unsupported-feature (capability
    // fact); content/safety ⇒ content-policy (capability exists); otherwise
    // the response is invalid-request.
    if (s === 400 || s === 404) {
      for (const re of UPSTREAM_FEATURE_DISSENT) {
        if (re.test(message)) return 'unsupported-feature';
      }
      if (CONTENT_POLICY_RE.test(message)) return 'content-policy';
      return 'invalid-request';
    }
    // Generic upstream HTTP error with no status captured (shouldn't normally
    // happen since readJsonResponse now sets .httpStatus) — be conservative.
    return 'provider-error';
  }

  // No structured code, no status, not a network failure, not abort: most
  // likely a materialize/storage error out of `materializeImageResult` or
  // a plain Error thrown outside the provider layer. Materialization fails
  // AFTER the provider POST succeeded and was billed, so the log must say so
  // explicitly rather than blaming the model.
  return 'materialize';
}

/**
 * Short machine-usable reason when an upstream error is specifically about
 * the reference mechanism (the gateway rejecting how images are passed), or
 * null when the error proves nothing about references. Used by the evidence
 * write-back to decide between `refs: 'rejected'` and "no fact learned".
 *
 * @param {Error|null} error
 * @returns {string|null}
 */
export function referenceRejectionReason(error) {
    if (!error) return null;
    const message = String(error?.message || '');
    const patterns = [
        [/image editing is only supported/i, 'edit не поддерживается этим шлюзом'],
        [/\bimages? endpoint (?:requires|only supports)/i, 'images-эндпоинт не принимает эту модель'],
        [/only imagen models are supported/i, 'эндпоинт принимает только imagen-модели'],
        [/\bimage_url is required\b/i, 'шлюз ждёт другое поле для картинок'],
        [/multipart is unsupported/i, 'multipart не принимается'],
        [/maximum (\d+) (?:image|reference|input)/i, 'превышен лимит референсов'],
        [/failed to parse (?:the )?(?:multipart )?edit request/i, 'шлюз не смог разобрать edit-запрос'],
        // Наша типизированная исчерпанность диалектов (image-openai.js chain):
        // доказанный факт «этот шлюз не принимает референсы из браузера».
        [/Референсы на этом шлюзе недоступны из браузера/i, 'ни один диалект редактирования не принят шлюзом'],
    ];
    for (const [pattern, label] of patterns) {
        if (pattern.test(message)) return label;
    }
    return null;
}

// ── human-readable log line ─────────────────────────────────────────────────

const OUTCOME_LABELS = {
  'success': 'confirmed',
  'unsupported-feature': 'unsupported-feature',
  'auth': 'auth (key state, not capability)',
  'quota': 'quota (key state, not capability)',
  'rate-limit': 'runtime: rate-limited (not unsupported)',
  'provider-error': 'runtime: provider error (not unsupported)',
  'timeout': 'runtime: timeout (not unsupported)',
  'invalid-request': 'invalid request (not capability)',
  'content-policy': 'content policy (capability exists)',
  'missing-image': 'parser gap: 200 OK without image (not capability)',
  'malformed': 'malformed upstream response (not capability)',
  'materialize': 'materialization failed (generation succeeded)',
  'network-unknown': 'network-unknown (no resubmit; not reported as unsupported)',
};

/**
 * Format one dispatch attempt as a single in-panel log line. The line is
 * concise and stable so users can grep `capability:` in the URIS panel log.
 *
 * @param {{outcome:string, operation?:string, referenceMode?:string,
 *          delivery?:string, refCount?:number, evidenceCode?:string|null}} attempt
 * @param {object} [meta] Optional `{ modelId, contract }` for human context.
 * @returns {string}
 */
export function formatObservationLog(attempt, meta = {}) {
  if (!attempt || typeof attempt !== 'object') return 'capability: (no observation)';
  const label = OUTCOME_LABELS[attempt.outcome] || attempt.outcome || 'unknown';
  const model = meta.modelId || '?';
  const contract = meta.contract || '?';
  const op = attempt.operation || '?';
  const delivery = attempt.delivery || '?';
  const parts = [
    `capability: route ${model} / ${contract} / ${op} / ${delivery}`,
    `-> ${label}`,
  ];
    const refs = Number.isSafeInteger(attempt.refCount) ? attempt.refCount : 0;
    if (attempt.outcome === 'success' && refs > 0) {
        parts.push(`(${refs} ref${refs === 1 ? '' : 's'} accepted)`);
    }
    if (attempt.outcome !== 'success' && attempt.evidenceCode) parts.push(`[code ${attempt.evidenceCode}]`);
    // Trailing correlation/diagnostic tokens only — the line prefix must stay
    // `capability: route MODEL / ...` verbatim so panel greps and anchored
    // tests keep matching. The request tag ties this line to the
    // `pipeline: собраны референсы [rid]` / `materialized [rid]` lines of the
    // same attempt; the connection editProtocol is the *persisted* value, so a
    // mismatch with the inferred `edit-*` operation exposes a card/persist drift
    // or the multipart→JSON proxy fallback (op edit-json, conn multipart).
    if (meta.requestId) parts.push(`[rid ${String(meta.requestId).slice(0, 8)}]`);
    if (meta.editProtocol != null && String(op).startsWith('edit-')) parts.push(`[conn ${meta.editProtocol}]`);
    return parts.join(' ');
}

// ── Failure streak (пункт 3.1 плана 2026-10-05) ─────────────────────────────
// Сессионный счётчик «эта модель падает» per (connId, modelId): ≥ 2 подряд
// provider-error/missing-image — признак устаревшего каталога шлюза. In-memory
// без персистенции: после перезагрузки страницы история начинается заново —
// факту «модель была мертва час назад» доверять нельзя. Любой другой исход
// сбрасывает счётчик; «Проверить» сбрасывает принудительно.
const FAILURE_STREAK_OUTCOMES = new Set(['provider-error', 'missing-image']);
const failureStreaks = new Map(); // `${connId}\u0000${modelId}` → { count, lastStatus }

export function modelFailureStreak(connId, modelId) {
    return failureStreaks.get(`${connId}\u0000${modelId}`) || null;
}

/** Сброс «Проверить» / ручной смены модели: факты каталога перечитаны. */
export function resetModelFailureStreak(connId) {
    if (!connId) return;
    for (const key of failureStreaks.keys()) {
        if (key.startsWith(`${connId}\u0000`)) failureStreaks.delete(key);
    }
}

function noteOutcomeForStreak(connId, modelId, attempt) {
    if (!connId || !modelId) return;
    const key = `${connId}\u0000${modelId}`;
    if (FAILURE_STREAK_OUTCOMES.has(attempt.outcome)) {
        const previous = failureStreaks.get(key) || { count: 0, lastStatus: null };
        failureStreaks.set(key, {
            count: previous.count + 1,
            lastStatus: Number.isSafeInteger(attempt.evidenceStatus) ? attempt.evidenceStatus : previous.lastStatus,
        });
    } else {
        failureStreaks.delete(key);
    }
}

// ── top-level convenience for the pipeline hook ────────────────────────────

/**
 * Classify and log one dispatch attempt. Returns the classified descriptor so
 * callers can inspect it; persists nothing. Never throws — diagnostic failures
 * are logged and swallowed so the generation flow is unaffected.
 *
 * @param {object} args `{ route, request, connection?, httpStatus?, error?, notify? }`
 * @returns {object|null}
 */
export function observeCapabilityAttempt({ route, request, connection = {}, httpStatus = null, error = null, notify = null, connId = null } = {}) {
  try {
    if (!route?.generationContract) return null;
    const { operation, referenceMode, delivery } = classifyOperation(route, request, connection);
    if (operation === 'unknown') return null;
    const refs = Array.isArray(request?.references) ? request.references : [];
    const attempt = {
      outcome: classifyOutcome(error, httpStatus),
      operation,
      referenceMode,
      delivery,
      refCount: refs.length,
      evidenceCode: error?.code || null,
      evidenceStatus: Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : (Number.isSafeInteger(httpStatus) ? httpStatus : null),
    };
    noteOutcomeForStreak(connId, route?.modelId, attempt);
    const line = formatObservationLog(attempt, {
        modelId: route?.modelId,
        contract: route?.generationContract,
        requestId: request?.requestId,
        editProtocol: connection?.editProtocol,
    });
    log(line);
    recordDiagnosticEvent({
      event: 'capability-observation',
      level: attempt.outcome === 'success' ? 'log' : 'warn',
      requestId: request?.requestId || null,
      modelId: route?.modelId || null,
      generationContract: route?.generationContract || null,
      operation,
      delivery,
      referenceCount: refs.length,
      outcome: attempt.outcome,
      details: { referenceMode, evidenceCode: attempt.evidenceCode || null },
    });
    try { notify?.(line); } catch { /* swallow UI hook errors */ }
    return attempt;
  } catch (e) {
    warn('capability-observer: observeCapabilityAttempt failed', e?.message || e);
    return null;
  }
}
