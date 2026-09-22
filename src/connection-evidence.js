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
