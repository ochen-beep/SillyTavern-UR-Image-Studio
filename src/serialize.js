// @ts-check
/**
 * serialize(key, fn) — the canonical promise-chain mutex of the codebase
 * (v0.9.4 consolidated the per-module copies in connection-evidence,
 * browser-image-recovery, generation-drafts and autolane onto this helper).
 *
 * Concurrent calls with the same key queue behind each other; different keys
 * run in parallel. A task starts whether the previous one resolved or
 * rejected. The chain entry is forgotten once idle, so keys do not leak.
 */

const chains = new Map();

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>} the task's own promise (rejections propagate to the
 * caller — the chain itself stays healthy).
 */
export function serialize(key, fn) {
    const next = (chains.get(key) || Promise.resolve()).then(fn, fn);
    const queued = next.catch(() => {});
    chains.set(key, queued);
    return next.finally(() => {
        if (chains.get(key) === queued) chains.delete(key);
    });
}
