// @ts-check
/**
 * Evidence write-back: record what a real, already-paid generation proved
 * about (connection, model, reference delivery).
 *
 * Facts come from two sources only:
 *   - a generation with N>0 references that SUCCEEDED  → refs: 'confirmed', n
 *   - a generation whose failure carries a reference-shaped rejection
 *     (capability-observer.referenceRejectionReason) → refs: 'rejected'
 * Any other error proves nothing about references and is ignored.
 *
 * Writes are serialized per connection (promise-chain mutex): concurrent
 * generations finishing out of order must not lose each other's entries.
 */
import { getConnection, saveConnection } from './connections.js';
import { referenceRejectionReason } from './capability-observer.js';
import { serialize } from './serialize.js';

function withLock(key, fn) {
    return serialize(key, fn);
}

/**
 * Record one attempt's reference fact. Never throws — evidence is diagnostic
 * and must not break the generation flow.
 *
 * @param {{connectionId:string, modelId:string, dialect:string|null,
 *          refCount?:number, error?:Error|null, userConfirmed?:boolean}} input
 * @returns {Promise<object|null>} the written evidence entry, or null
 */
export async function recordReferenceEvidence(input = {}) {
    const { connectionId, modelId, dialect, refCount = 0, error = null, userConfirmed = false } = input;
    if (!connectionId || !modelId) return null;
    try {
        return await withLock(`evidence:${connectionId}`, async () => {
            const conn = await getConnection(connectionId);
            if (!conn) return null;
            const reason = error ? referenceRejectionReason(error) : null;
            const outcome = error
                ? (reason ? 'rejected' : null)
                : (refCount > 0 ? 'confirmed' : null);
            if (!outcome) return null;
            const effectiveDialect = dialect || conn.evidence?.[modelId]?.dialect || null;
            if (!effectiveDialect) return null;

            const evidence = { ...(conn.evidence || {}) };
            // Newest paid attempt wins: a later confirmation overrides an
            // earlier rejection and vice versa — including the stale reason.
            const { reason: _staleReason, ...previous } = evidence[modelId] || {};
            evidence[modelId] = {
                ...previous,
                dialect: effectiveDialect,
                refs: outcome,
                ...(outcome === 'confirmed' ? { n: refCount } : {}),
                ...(reason ? { reason: reason.slice(0, 200) } : {}),
                ...(userConfirmed ? { userConfirmed: true } : {}),
                ts: new Date().toISOString(),
            };
            await saveConnection({ id: connectionId, evidence });
            return evidence[modelId];
        });
    } catch {
        return null;
    }
}

// ── Wire body budget (learned from HTTP 413) ──
//
// 413 от nginx/CDN — отказ ДО приложения: шлюз роняет тело раньше, чем
// провайдер успевает что-то сгенерировать или списать (наблюдено байт-в-байт
// на apiddt.com 2026-10-06). Факт принадлежит СОЕДИНЕНИЮ (фронтящий шлюз), а
// не модели, поэтому живёт отдельным полем записи, а не в evidence[modelId],
// у которого своя семантика dialect/refs.

/** Запас под измеренным упавшим размером тела. */
const WIRE_LIMIT_MARGIN = 0.9;

/**
 * Запомнить, что тело размером `bodyBytes` отвергнуто этим соединением с
 * HTTP 413. Сохраняется 90 % упавшего размера как бюджет диспетча; бюджет
 * только уменьшается: 413 — верхняя граница лимита провода, и повторное
 * выучивание того же отказа не должно двигать бюджет вверх.
 * Никогда не бросает — evidence не должен ломать генерацию.
 */
export async function noteWireBodyLimit(connectionId, bodyBytes) {
    if (!connectionId || !Number.isSafeInteger(bodyBytes) || bodyBytes <= 0) return null;
    try {
        return await withLock(`evidence:${connectionId}`, async () => {
            const conn = await getConnection(connectionId);
            if (!conn) return null;
            const limit = Math.floor(bodyBytes * WIRE_LIMIT_MARGIN);
            const existing = conn.wireBodyLimitBytes;
            if (Number.isSafeInteger(existing) && existing <= limit) return existing;
            await saveConnection({ id: connectionId, wireBodyLimitBytes: limit });
            return limit;
        });
    } catch {
        return null;
    }
}

/** Выученный бюджет тела для соединения, или null, если лимита нет. */
export async function wireBodyBudget(connectionId) {
    if (!connectionId) return null;
    try {
        const conn = await getConnection(connectionId);
        const budget = conn?.wireBodyLimitBytes;
        return Number.isSafeInteger(budget) && budget > 0 ? budget : null;
    } catch {
        return null;
    }
}
