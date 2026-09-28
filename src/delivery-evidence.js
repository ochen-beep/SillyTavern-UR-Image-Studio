// @ts-check
/**
 * Delivery experience: what real, already-dispatched generation POSTs proved
 * about a connection's direct-delivery health.
 *
 * «Авто» delivery used to mean "direct, always" for the paid image POST: a
 * CORS-masked failure threw IMAGE_DELIVERY_AMBIGUOUS and left no trace, so
 * every later generation repeated the same doomed direct attempt until the
 * user manually switched the card to «Через прокси». This module gives «Авто»
 * the memory autoFetch already has for the text path (proxy.js _hostStrategy),
 * but persisted per connection so it survives a page reload and feeds both the
 * dispatch ladder (image-api.browserDeliveryRoute) and the card facts line.
 *
 * Facts and their only writers:
 *   - direct POST finished ambiguous (IMAGE_DELIVERY_AMBIGUOUS) → directBrokenAt
 *   - direct POST returned any HTTP response (even 4xx/5xx — the path works)
 *                                                                  → cleared + directOkAt
 *   - preflight oracle proved the POST never left the browser
 *     (image-transport.js safe proxy rescue)                       → directBrokenAt
 * A proxy-delivered success writes nothing: the direct path was not exercised,
 * and the broken TTL must keep expiring so «Авто» self-heals back to the fast
 * path when the network recovers.
 *
 * Every persisted field has a live reader — the dispatch ladder and the card
 * facts line. An earlier persisted-but-unread observation store was removed
 * from this codebase once already (capability-observer.js header); do not add
 * fields nobody consumes.
 *
 * Writes are best-effort telemetry: they never throw into the generation flow,
 * and an unknown connection id degrades to the in-memory cache only.
 */
import { saveConnection } from './connections.js';
import { serialize } from './serialize.js';

/** How long a broken-direct verdict keeps routing «Авто» through the proxy. */
export const DIRECT_BROKEN_TTL_MS = 30 * 60 * 1000;
/** How long a proven-working direct path outweighs a stale probe verdict. */
export const DIRECT_OK_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long a learned edit dialect (which wire shape an /images/edits-capable
 * gateway actually accepts) steers the reference chain. Same window as the
 * delivery verdict: when it expires the chain re-probes from multipart, so a
 * provider that gained CORS (or fixed its JSON dialect) self-heals.
 */
export const EDIT_DIALECT_TTL_MS = 30 * 60 * 1000;

// Session write-through cache: deliveryHintFor is synchronous (it reads the
// already-normalized connection record), so the cache only accelerates writes
// and lets the transport record a fact without awaiting persistence.
const memory = new Map();

/**
 * Hostname of an endpoint URL, or '' when the value is not a URL.
 * @param {string|undefined} endpoint
 * @returns {string}
 */
export function hostOfEndpoint(endpoint) {
    try { return new URL(String(endpoint || '').trim()).hostname.toLowerCase(); }
    catch { return ''; }
}

function fresh(iso, ttlMs, now) {
    if (!iso) return false;
    const at = Date.parse(iso);
    return Number.isFinite(at) && now - at >= 0 && now - at < ttlMs;
}

/**
 * Delivery hint from the connection's POST experience, for the «Авто» ladder.
 * Pure and synchronous: reads the already-loaded record, never touches storage.
 *
 * @param {{endpoint?: string, deliveryEvidence?: {host?: string, directBrokenAt?: string|null, directOkAt?: string|null}|null}|null|undefined} conn
 * @param {number} [nowMs]
 * @returns {'proxy'|'direct'|null} 'proxy' — route «Авто» through the ST proxy;
 *   'direct' — a recent direct success overrides even a probe verdict;
 *   null — no usable experience (ladder falls through to detected.delivery).
 */
export function deliveryHintFor(conn, nowMs = Date.now()) {
    const evidence = conn?.deliveryEvidence;
    if (!evidence?.host) return null;
    if (hostOfEndpoint(conn?.endpoint) !== evidence.host) return null;
    if (fresh(evidence.directBrokenAt, DIRECT_BROKEN_TTL_MS, nowMs)) return 'proxy';
    if (fresh(evidence.directOkAt, DIRECT_OK_TTL_MS, nowMs)) return 'direct';
    return null;
}

async function writeEvidence(connId, endpoint, mutate, now) {
    if (!connId || !endpoint) return null;
    const host = hostOfEndpoint(endpoint);
    if (!host) return null;
    return serialize(`delivery-evidence:${connId}`, async () => {
        const previous = memory.get(connId) || {};
        const next = mutate({
            host,
            directBrokenAt: previous.host === host ? (previous.directBrokenAt || null) : null,
            directOkAt: previous.host === host ? (previous.directOkAt || null) : null,
        }, now);
        memory.set(connId, next);
        try {
            await saveConnection({ id: connId, deliveryEvidence: next });
        } catch { /* telemetry must not break the generation flow */ }
        return next;
    });
}

/**
 * Record the outcome of a real generation POST. `delivery` is the path the
 * dispatcher actually used (the dispatcher's stamp, not the plan): only a
 * 'direct' outcome proves anything about the direct path. Best-effort.
 *
 * @param {{connId?: string|null, endpoint?: string, delivery?: string, ok: boolean, now?: number}} input
 * @returns {Promise<object|null>}
 */
export function noteDeliveryPostOutcome({ connId, endpoint, delivery, ok, now = Date.now() }) {
    if (delivery !== 'direct') return Promise.resolve(null);
    return writeEvidence(
        connId,
        endpoint,
        evidence => ok
            ? { ...evidence, directBrokenAt: null, directOkAt: new Date(now).toISOString(), ts: new Date(now).toISOString() }
            : { ...evidence, directBrokenAt: new Date(now).toISOString(), ts: new Date(now).toISOString() },
        now,
    );
}

/**
 * The preflight oracle proved a direct POST could not leave the browser
 * (image-transport.js safe proxy rescue). Same verdict as an ambiguous
 * direct failure: the direct path is broken right now. Best-effort.
 *
 * @param {string|null|undefined} connId
 * @param {string|undefined} endpoint
 * @param {{now?: number}} [options]
 * @returns {Promise<object|null>}
 */
export function notePreflightOracleDead(connId, endpoint, { now = Date.now() } = {}) {
    return writeEvidence(
        connId,
        endpoint,
        evidence => ({ ...evidence, directBrokenAt: new Date(now).toISOString(), ts: new Date(now).toISOString() }),
        now,
    );
}

/** Drop the stored experience (card «Сбросить знания о шлюзе»). */
export async function clearDeliveryEvidenceFor(connId) {
    memory.delete(connId);
    editMemory.delete(connId);
    if (!connId) return;
    try { await saveConnection({ id: connId, deliveryEvidence: null, editDialectEvidence: null }); } catch { /* best-effort */ }
}

// ── Edit-dialect experience (openai-images references) ─────────────────────
//
// A second wire experience next to delivery: WHICH dialect accepts references
// on this gateway. The default chain is multipart (OpenAI classic) → JSON
// /edits (proxy-traversable variant) → generations+image (img2img extension,
// observed on apihub.agnes-ai.com 2026-09-28). Each failed rung is provably
// harmless before the next one fires: multipart dies on the preflight
// (nothing sent), the JSON/img2img rungs start after an HTTP response proved
// the previous dialect was rejected rather than rendered. The memory lets the
// next generation skip straight to the working dialect instead of re-paying
// the discovery round trips.

const editMemory = new Map();

/**
 * Which edit dialect «Авто» should start with, from the connection's edit
 * experience. Pure and synchronous. Host mismatch (endpoint edited) → null.
 *
 * @param {{endpoint?: string, editDialectEvidence?: {host?: string, img2imgOkAt?: string|null, jsonOkAt?: string|null}|null}|null|undefined} conn
 * @param {number} [nowMs]
 * @returns {'img2img-proxy'|'json-proxy'|null}
 */
export function editDialectHintFor(conn, nowMs = Date.now()) {
    const evidence = conn?.editDialectEvidence;
    if (!evidence?.host) return null;
    if (hostOfEndpoint(conn?.endpoint) !== evidence.host) return null;
    if (fresh(evidence.img2imgOkAt, EDIT_DIALECT_TTL_MS, nowMs)) return 'img2img-proxy';
    if (fresh(evidence.jsonOkAt, EDIT_DIALECT_TTL_MS, nowMs)) return 'json-proxy';
    return null;
}

async function writeEditEvidence(connId, endpoint, mutate, now) {
    if (!connId || !endpoint) return null;
    const host = hostOfEndpoint(endpoint);
    if (!host) return null;
    return serialize(`edit-dialect-evidence:${connId}`, async () => {
        const previous = editMemory.get(connId) || {};
        const base = previous.host === host
            ? { ...previous }
            : { host };
        const next = mutate(base, now);
        if (!next) return null; // мутатор решил, что факта нет — не пишем ничего
        next.host = host;
        next.ts = new Date(now).toISOString();
        editMemory.set(connId, next);
        try {
            await saveConnection({ id: connId, editDialectEvidence: next });
        } catch { /* telemetry must not break the generation flow */ }
        return next;
    });
}

/**
 * Record the outcome of one edit-dialect attempt on this gateway.
 *   multipart + ok        → the classic path works; clear all learned skips.
 *   multipart + preflight → multipartBlockedAt (chain skips it for the TTL).
 *   json      + ok        → jsonOkAt (next edits go JSON proxy-first).
 *   json      + !ok       → jsonRejectedAt (chain skips to img2img).
 *   img2img   + ok        → img2imgOkAt (fastest path next time).
 * Best-effort telemetry: never throws into the generation flow.
 *
 * @param {{connId?: string|null, endpoint?: string, dialect?: 'multipart'|'json'|'img2img', ok: boolean, rejectKind?: 'preflight'|null, now?: number}} input
 * @returns {Promise<object|null>}
 */
export function noteEditDialectOutcome({ connId, endpoint, dialect, ok, rejectKind = null, now = Date.now() }) {
    const iso = new Date(now).toISOString();
    return writeEditEvidence(connId, endpoint, evidence => {
        if (dialect === 'multipart') {
            if (ok) return { ts: evidence.ts ?? iso };
            if (rejectKind === 'preflight') return { ...evidence, multipartBlockedAt: iso };
            return null; // неизвестный исход — не факт
        }
        if (dialect === 'json') {
            return ok
                ? { ...evidence, jsonOkAt: iso, jsonRejectedAt: undefined }
                : { ...evidence, jsonRejectedAt: iso };
        }
        if (dialect === 'img2img' && ok) {
            return { ...evidence, img2imgOkAt: iso };
        }
        return null; // отказ img2img не пишет: терминальная правда — в ошибке
    }, now).catch(() => null);
}

/** Test seam: drop the in-memory caches (persistence is per-test-store). */
export function _resetDeliveryEvidenceForTests() {
    memory.clear();
    editMemory.clear();
}
