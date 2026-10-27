// @ts-check
/**
 * crypto.getRandomValues-based random token for correlation/session ids.
 * Unlike crypto.randomUUID this exists on plain-HTTP too (ST over remote LAN
 * is not a secure context), so the Math.random fallback is gone entirely
 * (CodeQL "insecure randomness"). Leaf module on purpose: importable from
 * modules that must not pull core.js (diagnostic-events import cycle).
 */
export function randomToken(len = 12) {
    const bytes = new Uint8Array(len);
    globalThis.crypto.getRandomValues(bytes);
    let out = '';
    for (const b of bytes) out += (b % 36).toString(36);
    return out.slice(0, len);
}
