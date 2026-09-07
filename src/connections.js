// @ts-check
/** Shared browser-owned image connection facade. */
import { normalizeReferenceCap } from './reference-limits.js';
import {
    createConnection as createStoredConnection,
    deleteConnection as deleteStoredConnection,
    getConnection as getStoredConnection,
    getConnectionApiKey,
    listConnections as listStoredConnections,
    updateConnection as updateStoredConnection,
} from './connection-store.js';

const REFERENCE_MODES = new Set(['auto', 'off', 'custom']);
const REFERENCE_PROTOCOLS = new Set(['multipart-edits', 'multimodal-chat', 'inline-data', 'url-param']);

export function isServerOwnedConnection(value) {
    const input = value && typeof value === 'object' ? value : {};
    // Existing server records precede browser ownership metadata and often only
    // contain the plugin route projection. Preserve that durable compatibility.
    return input.executionOwner === 'server'
        || input.serverOwned === true
        || input.legacyServer === true
        || input.kind === 'server-image';
}

export function normalizeReferenceOptions(value) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const mode = REFERENCE_MODES.has(input.mode) ? input.mode : 'auto';
    const protocol = typeof input.protocol === 'string' && REFERENCE_PROTOCOLS.has(input.protocol)
        ? input.protocol
        : null;
    const numericMax = Number(input.maxRefs);
    const maxRefs = Number.isInteger(numericMax) && numericMax >= 0
        ? normalizeReferenceCap(numericMax)
        : null;
    return { mode, protocol: mode === 'custom' ? protocol : null, maxRefs };
}

/**
 * Project the v2 model field. The explicit `model` object wins; a legacy
 * record without one is projected from its persisted route so `model.id`
 * consumers (dispatch-plan, Generate dropdown, the connection card) always
 * see the same shape. A stale legacy route must never clobber the model the
 * user picked on the card.
 */
function projectConnectionModel(input, selectedRoute) {
    if (input.model && typeof input.model === 'object' && !Array.isArray(input.model) && typeof input.model.id === 'string' && input.model.id) {
        return {
            id: input.model.id,
            ...(typeof input.model.label === 'string' && input.model.label ? { label: input.model.label } : {}),
            source: input.model.source === 'manual' ? 'manual' : 'list',
        };
    }
    const legacyId = typeof selectedRoute?.modelId === 'string' && selectedRoute.modelId
        ? selectedRoute.modelId
        : (typeof input.model === 'string' && input.model ? input.model : '');
    return legacyId ? { id: legacyId, source: 'list' } : null;
}

/** Compatibility export for callers that still use the old projection name. */
export function normalizeServerProjection(value) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const selectedRoute = input.selectedRoute && typeof input.selectedRoute === 'object' && !Array.isArray(input.selectedRoute)
        ? input.selectedRoute
        : null;
    return {
        ...input,
        kind: 'image',
        executionOwner: isServerOwnedConnection(input) ? 'server' : 'legacy-browser',
        apiType: typeof selectedRoute?.apiFamily === 'string' ? selectedRoute.apiFamily : input.apiType || 'auto',
        model: projectConnectionModel(input, selectedRoute),
        providerOptions: input.providerOptions && typeof input.providerOptions === 'object' ? input.providerOptions : {},
        referenceOptions: normalizeReferenceOptions(input.referenceOptions),
    };
}

export async function listConnections() {
    return listStoredConnections();
}

export async function listImageConnections() {
    const connections = await listStoredConnections();
    return connections
        .filter(connection => !connection.kind || connection.kind === 'image')
        .map(normalizeServerProjection);
}

export async function getConnection(id) {
    const connection = await getStoredConnection(id);
    return connection ? normalizeServerProjection(connection) : null;
}

export async function createConnection(data = {}) {
    const connection = await createStoredConnection(data);
    return normalizeServerProjection(connection);
}

export async function saveConnection(patch) {
    if (!patch?.id) return null;
    const connection = await updateStoredConnection(patch.id, patch);
    return connection ? normalizeServerProjection(connection) : null;
}

export async function deleteConnection(id) {
    return deleteStoredConnection(id);
}

export async function resolveConnection(id) {
    const conn = await getConnection(id);
    return conn ? { conn, apiKey: await getConnectionApiKey(id) } : null;
}
