// @ts-check
/**
 * Shared reference-cap semantics.
 *
 * `null` means the route has not declared a wire-level ceiling; `0` means
 * references are explicitly disabled. Positive values are provider/model
 * capabilities, not a product-wide default. The metadata ceiling only bounds
 * persisted untrusted capability data and must not be presented as a provider
 * limit.
 */
export const MAX_REFERENCE_CAPABILITY = 64;
// Resource budgets are memory/request safeguards, not provider capabilities.
export const MAX_REFERENCE_BYTES_PER_IMAGE = 25 * 1024 * 1024;
export const MAX_REFERENCE_BYTES_TOTAL = 50 * 1024 * 1024;

export function normalizeReferenceCap(value) {
    if (value === null || value === undefined || value === '') return null;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return Math.min(value, MAX_REFERENCE_CAPABILITY);
}

export function tightenReferenceCap(providerCap, connectionCap) {
    const provider = normalizeReferenceCap(providerCap);
    const connection = normalizeReferenceCap(connectionCap);
    if (provider === 0 || connection === 0) return 0;
    if (provider === null) return connection;
    if (connection === null) return provider;
    return Math.min(provider, connection);
}

/** Resolve a delivery cap without turning unknown into a fake default. */
export function effectiveReferenceCap({ providerCap = null, connectionCap = null, disabled = false } = {}) {
    if (disabled) return 0;
    return tightenReferenceCap(providerCap, connectionCap);
}

export function decodedDataUrlBytes(dataUrl) {
    const value = typeof dataUrl === 'string' ? dataUrl : '';
    const comma = value.indexOf(',');
    if (comma < 0) return null;
    const encoded = value.slice(comma + 1).replace(/\s/g, '');
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(encoded.length * 3 / 4) - padding);
}

export function assertReferenceByteBudget(references = []) {
    let total = 0;
    for (const reference of references) {
        const bytes = decodedDataUrlBytes(reference?.dataUrl || reference);
        if (!Number.isSafeInteger(bytes)) continue;
        if (bytes > MAX_REFERENCE_BYTES_PER_IMAGE) {
            const error = new Error('Reference image exceeds the per-image materialization budget.');
            error.code = 'REFERENCE_TOO_LARGE';
            error.bytes = bytes;
            error.limit = MAX_REFERENCE_BYTES_PER_IMAGE;
            throw error;
        }
        total += bytes;
        if (total > MAX_REFERENCE_BYTES_TOTAL) {
            const error = new Error('Reference images exceed the aggregate materialization budget.');
            error.code = 'REFERENCE_BYTE_BUDGET_EXCEEDED';
            error.bytes = total;
            error.limit = MAX_REFERENCE_BYTES_TOTAL;
            throw error;
        }
    }
    return total;
}
