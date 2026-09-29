// @ts-check
/**
 * Export / import of safe browser-local URIS data.
 *
 * Browser image connections are stored in shared extension settings. Legacy
 * plugin records are intentionally absent from normal backup operations.
 *
 * SECURITY:
 * - The literal `LF_API_KEY` key and the `IMAGE_CONNECTION_KEY_PREFIX` image-key namespace never enter exports or imports.
 * - Gallery (uris_gallery_*) is not transferred.
 * - Nested secret fields are recursively stripped.
 */
import {
    MODULE_NAME, DISPLAY_NAME,
    LF_IMAGE_PARAMS, LF_TEXT_PARAMS,
    LF_TEMPLATES, LF_GALLERY_PREFIX, LF_HISTORY_PREFIX,
    LF_API_KEY, LF_REFS_POOL, LF_REFS_FOLDERS,
    LF_GENERATION_DRAFT_PREFIX, META_KEY, IMAGE_CONNECTION_SETTINGS_KEY,
    IMAGE_CONNECTION_KEY_PREFIX,
    log, warn, error, getCtx, showConfirmModal,
} from './core.js';
import { ALLOWED_CONTRACTS, isSecretKey, normalizeRouteContract } from './image-connection-schema.js';
import { invalidateTemplateCache, replaceTemplateStoreRecords, getTemplateRecordsForExport } from './prompt-templates.js';
import { reportFailure, URIS_SCOPES } from './error-pool.js';
import { invalidatePoolCache, getRefsForExport, replaceRefsRecords } from './refs-library.js';
import { getParamPresetsForExport, replaceParamPresetRecords } from './param-presets.js';
import { recordDiagnosticEvent } from './diagnostic-events.js';

const BACKUP_VERSION = 9;
const BACKUP_MODULE = MODULE_NAME;

/**
 * Lowest backup format still accepted on import. v2-v5 are intentionally retired
 * (see tests/data-port.test.js "rejects retired v2 through v5 backup formats").
 * v6 is structurally identical to v7 - that bump was a version-tag change only -
 * so a v6 backup (one release behind) migrates forward via an identity step
 * instead of being rejected. v9 is the single-format generation: the retired
 * browser-local collection keys fold into `shared` on the way in.
 */
const MIN_BACKUP_VERSION = 6;

/**
 * Project one legacy (v7) connection record onto the v2 connection read model:
 * the selected route's model becomes `model`, the discovered route catalog
 * collapses into `detected.modelIds`, and the explicit contract/proxy choices
 * become `overrides`. Heavy persisted route objects are dropped — the dialect
 * is derived at dispatch time now (src/dispatch-plan.js).
 */
function migrateConnectionV7(connection) {
    if (!connection || typeof connection !== 'object') return connection;
    const manualId = typeof connection.manualModelId === 'string' ? connection.manualModelId.trim() : '';
    const routeModelId = typeof connection.selectedRoute?.modelId === 'string' ? connection.selectedRoute.modelId.trim() : '';
    const model = manualId
        ? { id: manualId, source: 'manual' }
        : routeModelId
            ? { id: routeModelId, source: 'list' }
            : null;
    const modelIds = (Array.isArray(connection.routes) ? connection.routes : [])
        .map(route => (typeof route?.modelId === 'string' ? route.modelId.trim() : ''))
        .filter(Boolean);
    const dialect = typeof connection.apiFamilyOverride === 'string'
        && connection.apiFamilyOverride && connection.apiFamilyOverride !== 'auto'
        ? connection.apiFamilyOverride
        : null;
    const overrides = {
        ...(dialect ? { dialect } : {}),
        ...(connection.editProtocol === 'json' ? { editProtocol: 'json' } : {}),
        ...(connection.useCorsProxy === true ? { delivery: 'proxy' } : {}),
    };
    const {
        routes: _routes, catalog: _catalog, selectedRoute: _selectedRoute, selectedRouteId: _selectedRouteId,
        modelRoute: _modelRoute, manualModelId: _manualModelId, apiFamilyOverride: _apiFamilyOverride,
        routeFilter: _routeFilter, useCorsProxy: _useCorsProxy, editProtocol: _editProtocol,
        ...rest
    } = connection;
    return {
        ...rest,
        ...(model ? { model } : {}),
        detected: {
            apiShape: 'unknown',
            auth: 'unknown',
            delivery: connection.useCorsProxy === true ? 'proxy' : 'unknown',
            modelIds,
            checkedAt: null,
        },
        overrides,
    };
}

/**
 * Forward-only backup-format migrators keyed by source version.
 * @type {Record<number, (data: object) => object>}
 */
const BACKUP_MIGRATORS = {
    // v6 -> v7: structural no-op (version tag bump only).
    6: data => ({ ...data, version: 7 }),
    // v7 -> v8: connection records move to the derived-dialect read model.
    7: data => ({
        ...data,
        version: 8,
        shared: data.shared && typeof data.shared === 'object' && Array.isArray(data.shared.connections)
            ? { ...data.shared, connections: data.shared.connections.map(migrateConnectionV7) }
            : data.shared,
    }),
    // v8 -> v9: the browser-local collection keys (uris_prompt_templates,
    // uris_refs_pool, uris_refs_folders) fold into `shared` — the single backup
    // format. A section the backup carries in `shared` wins (the server file
    // was migrated FROM those localforage keys back in the day); the ancient
    // param-preset keys (uris_image_params/uris_text_params) predate
    // param-presets.js and have no reliable mapping — they are dropped.
    8: data => {
        const lf = data?.data?.localforage;
        const shared = data.shared && typeof data.shared === 'object' ? { ...data.shared } : {};
        const fold = (key, target) => {
            if (!Array.isArray(lf?.[key]) || !lf[key].length) return;
            if (!Array.isArray(shared[target])) shared[target] = lf[key];
        };
        fold(LF_TEMPLATES, 'templates');
        fold(LF_REFS_POOL, 'refs');
        fold(LF_REFS_FOLDERS, 'folders');
        // Do not fabricate a data envelope for malformed backups: a v8 file
        // without one must still fail the 'Invalid data section' validation.
        if (!data.data) return { ...data, version: 9, shared };
        return { ...data, version: 9, shared, data: { ...data.data, localforage: {} } };
    },
};

/**
 * Step a backup forward to BACKUP_VERSION via the migrator ladder.
 * - newer than current -> reject (the file is from a future release);
 * - older than MIN_BACKUP_VERSION or unknown step -> reject as unsupported;
 * - otherwise run each migrator until the version matches.
 * @param {object} data
 * @returns {object}
 */
function migrateBackupVersion(data) {
    const v = data.version;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error('Unsupported backup version: ' + v);
    }
    if (v > BACKUP_VERSION) {
        throw new Error('Backup file is from a newer version: ' + v);
    }
    if (v < MIN_BACKUP_VERSION) {
        throw new Error('Unsupported backup version: ' + v);
    }
    let current = data;
    let steps = 0;
    while (current.version !== BACKUP_VERSION) {
        if (steps++ > 100) throw new Error('Backup migration diverged');
        const migrator = BACKUP_MIGRATORS[current.version];
        if (!migrator) throw new Error('Unsupported backup version: ' + current.version);
        current = migrator(current);
    }
    return current;
}
// Gallery files and metadata are intentionally not portable: native files remain
// on the source SillyTavern installation and cards would otherwise restore as
// broken entries. Keep this list aligned with summarizeBackup/import UI.
const PORTABLE_KEYS = ['connections', 'templates', 'presets', 'refs', 'folders', 'selectedRouteId'];
const TRANSIENT_FIELDS = new Set(['pendingOperation', 'pending', 'recovery', 'recoveryState', 'requestJournal', 'journal', 'dataUrl', 'imageUrl', 'imageBytes', 'rawBytes', 'blob', 'base64']);

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function cloneExact(value) {
    if (value === null || value === undefined) return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}
function portable(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(portable);
    const out = {};
    for (const [key, child] of Object.entries(value)) {
        if (isSecretKey(key) || TRANSIENT_FIELDS.has(key)) continue;
        if (typeof child === 'string' && /^data:/i.test(child)) continue;
        out[key] = portable(child);
    }
    return out;
}
function normalizeRoute(route) {
    const out = portable(route);
    if (!plain(out)) return out;
    const legacyContracts = { openai: 'openai-images', gemini: 'gemini-native' };
    const aliases = ['generationContract', 'contract', 'apiFamily', 'contractId'];
    const contracts = aliases
        .map(key => typeof out[key] === 'string' ? out[key].trim() : '')
        .filter(Boolean)
        .map(contract => legacyContracts[contract] || contract);
    const ambiguous = new Set(contracts).size > 1;
    const contract = contracts[0] || '';
    for (const key of aliases) delete out[key];
    if (!ambiguous && ALLOWED_CONTRACTS.has(contract)) {
        try {
            return normalizeRouteContract({ ...out, generationContract: contract });
        } catch {
            // The portable projection does not contain enough route metadata to be usable.
        }
    }
    out.resolutionState = 'unresolved';
    out.unresolved = true;
    return out;
}
function normalizeConnection(connection) {
    const out = portable(connection);
    if (!plain(out)) return out;
    for (const key of ['selectedRoute', 'modelRoute']) {
        if (plain(out[key])) out[key] = normalizeRoute(out[key]);
    }
    if (Array.isArray(out.routes)) out.routes = out.routes.map(normalizeRoute);
    return out;
}

function nonEmptyId(value, label) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id) throw new TypeError(`${label} is required`);
    return id;
}

function normalizePortableConnections(value) {
    if (!Array.isArray(value)) return [];
    const connectionIds = new Set();
    const routeIdMap = new Map();
    const connections = value.map(connection => {
        const original = portable(connection);
        const connectionId = nonEmptyId(original?.id, 'Connection ID');
        if (connectionIds.has(connectionId)) throw new TypeError(`Duplicate connection ID: ${connectionId}`);
        connectionIds.add(connectionId);

        const normalized = normalizeConnection(original);
        let routes = Array.isArray(normalized.routes) ? normalized.routes : [];
        const originalRoutes = Array.isArray(original.routes) ? original.routes : [];
        const retainedRoutes = [];
        const routeIds = new Set();
        for (let index = 0; index < routes.length; index++) {
            const route = routes[index];
            const routeId = nonEmptyId(route?.id, 'Route ID');
            const oldId = typeof originalRoutes[index]?.id === 'string' ? originalRoutes[index].id.trim() : '';
            if (oldId) routeIdMap.set(oldId, routeId);
            if (routeIds.has(routeId)) continue;
            routeIds.add(routeId);
            retainedRoutes.push(route);
        }
        if (Array.isArray(normalized.routes)) {
            normalized.routes = retainedRoutes;
            routes = retainedRoutes;
        }

        const oldSelectedId = typeof original.selectedRouteId === 'string' ? original.selectedRouteId.trim() : '';
        const selectedRoute = normalized.selectedRoute || normalized.modelRoute || null;
        const migratedSelectedId = oldSelectedId && routeIdMap.get(oldSelectedId);
        if (migratedSelectedId) {
            normalized.selectedRouteId = migratedSelectedId;
            const matchingRoute = routes.find(route => route.id === migratedSelectedId);
            if (matchingRoute) {
                normalized.selectedRoute = matchingRoute;
                normalized.modelRoute = matchingRoute;
            }
        } else if (selectedRoute?.id) {
            normalized.selectedRouteId = selectedRoute.id;
        }
        return normalized;
    });
    return { connections, routeIdMap };
}

function normalizeShared(shared) {
    if (!plain(shared)) return {};
    const out = {};
    const portableConnections = normalizePortableConnections(shared.connections);
    for (const key of PORTABLE_KEYS) {
        const sourceKey = key === 'galleryCards' ? 'galleryIndex' : key;
        if (shared[sourceKey] === undefined && shared[key] === undefined) continue;
        const value = shared[sourceKey] ?? shared[key];
        if (key === 'connections') {
            out.connections = portableConnections.connections;
        } else if (key === 'selectedRouteId') {
            const selectedId = typeof value === 'string' ? value.trim() : '';
            out.selectedRouteId = portableConnections.routeIdMap.get(selectedId) || selectedId || null;
        } else {
            out[key] = portable(value);
        }
    }
    return out;
}

function lf() { return SillyTavern.libs.localforage; }

/**
 * Union two arrays of records by `id`. Incoming wins on id conflicts; records
 * without an id are appended. Order: current first (preserved), then new ids.
 * @param {Array} current
 * @param {Array} incoming
 * @returns {Array}
 */
function mergeById(current, incoming) {
    if (!Array.isArray(current) || current.length === 0) return Array.isArray(incoming) ? incoming.slice() : [];
    if (!Array.isArray(incoming) || incoming.length === 0) return current.slice();
    const byId = new Map();
    const ordered = [];
    const push = (item) => {
        if (item && typeof item === 'object' && item.id != null) {
            const key = String(item.id);
            if (byId.has(key)) { byId.set(key, item); return; } // incoming overrides
            byId.set(key, item);
        }
        ordered.push(item);
    };
    for (const item of current) push(item);
    for (const item of incoming) push(item);
    // Rebuild in original order, with incoming overriding same-id records.
    const seen = new Set();
    const out = [];
    for (const item of ordered) {
        if (item && typeof item === 'object' && item.id != null) {
            const key = String(item.id);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(byId.get(key));
        } else {
            out.push(item);
        }
    }
    return out;
}

/**
 * Merge incoming shared image-connection settings into current: scalar/object
 * fields are overridden (shallow), but collection arrays (connections, templates,
 * presets, refs, folders) are unioned by id. This is what "merge"
 * mode promises - importing refs/folders no longer replaces the whole pool.
 * @param {object} current
 * @param {object} incoming
 * @returns {object}
 */
function mergeSharedSettings(current, incoming) {
    const out = { ...current };
    for (const [key, value] of Object.entries(incoming || {})) {
        out[key] = (Array.isArray(value) && Array.isArray(out[key]))
            ? mergeById(out[key], value)
            : value;
    }
    return out;
}

/** Does this localforage key store a secret (API key)? Never exported/imported. */
export function isSecretLfKey(key) {
    return key === LF_API_KEY || (typeof key === 'string' && key.startsWith(IMAGE_CONNECTION_KEY_PREFIX));
}

/** Fields recursively stripped from any backup object. */
const SECRET_FIELD_NAMES = new Set([
    'apiKey', 'api_key', 'token', 'password', 'secret', 'secretId',
]);

/**
 * Recursively copy a value, removing nested secret fields.
 * Does not mutate the original.
 * @param {*} value
 * @returns {*}
 */
export function sanitizeBackupValue(value) {
    return portable(value);
}

/**
 * Collect a full snapshot of safe URIS data from localforage.
 * @param {Object} [options]
 * @param {boolean} [options.includeSettings=true] — include extensionSettings
 * @returns {Promise<Object>}
 */
export async function exportUrisData(options = {}) {
    const startedAt = Date.now();
    const includeSettings = options.includeSettings !== false;
    const data = {
        version: BACKUP_VERSION,
        module: BACKUP_MODULE,
        exportedAt: new Date().toISOString(),
        data: {
            localforage: {},
            extensionSettings: null,
            chatMetadata: {},
        },
        shared: {},
        secrets: {
            excluded: true,
            excludedKeys: [LF_API_KEY],
        },
    };

    if (includeSettings) {
        const settings = getCtx().extensionSettings[MODULE_NAME] || null;
        // The settings blob may hold nothing — overlay the LIVE contents of
        // every file store before projecting. Each accessor returns null while
        // the store is not in file mode (readonly, still probing) — the exporter
        // then falls back to the blob and behaves exactly as before.
        const sharedSource = settings?.imageConnections ? cloneExact(settings.imageConnections) : {};
        const freshTemplates = await getTemplateRecordsForExport();
        if (freshTemplates) sharedSource.templates = freshTemplates;
        const freshPool = await getRefsForExport();
        if (freshPool) {
            sharedSource.refs = freshPool.refs;
            sharedSource.folders = freshPool.folders;
        }
        const freshPresets = await getParamPresetsForExport();
        if (freshPresets) sharedSource.presets = freshPresets;
        data.shared = normalizeShared(sharedSource);
        data.data.extensionSettings = settings
            ? sanitizeBackupValue(Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'imageConnections' && key !== 'recoveryState')))
            : null;
    }

    // Export only the current schema-v5 chat configuration and references.
    const ctx = getCtx();
    const chatId = ctx.chatId;
    const binding = ctx.chatMetadata?.[META_KEY];
    if (chatId && binding?.schemaVersion >= 4) {
        data.data.chatMetadata[chatId] = sanitizeBackupValue(binding);
    }

    log('Exported: shared collections + current chat binding');
    // An export is the recovery instrument for everything else — the journal
    // must show when it ran and what it carried.
    recordDiagnosticEvent({
        event: 'export-run', stage: 'data', outcome: 'ok',
        durationMs: Date.now() - startedAt,
        details: {
            includeSettings,
            refs: Array.isArray(data.shared?.refs) ? data.shared.refs.length : 0,
            presets: Array.isArray(data.shared?.presets) ? data.shared.presets.length : 0,
            templates: Array.isArray(data.shared?.templates) ? data.shared.templates.length : 0,
        },
    });
    return data;
}

/**
 * Validate and sanitize a current-version backup.
 * @param {Object} data
 * @returns {Object}
 */
export function normalizeBackup(data) {
    if (!data || typeof data !== 'object') throw new Error('Invalid backup file');
    if (data.module !== BACKUP_MODULE) throw new Error('Backup file belongs to a different extension');
    data = migrateBackupVersion(data);
    if (!data.data || typeof data.data !== 'object' || Array.isArray(data.data)) {
        throw new Error('Invalid data section');
    }

    const incomingLf = data.data.localforage;
    if (incomingLf !== undefined && (incomingLf === null || typeof incomingLf !== 'object' || Array.isArray(incomingLf))) {
        throw new Error('Invalid localforage section');
    }
    const incomingSettings = data.data.extensionSettings;
    if (incomingSettings !== undefined && incomingSettings !== null && typeof incomingSettings !== 'object') {
        throw new Error('Invalid extensionSettings section');
    }
    const incomingChatMeta = data.data.chatMetadata;
    if (incomingChatMeta !== undefined && (incomingChatMeta === null || typeof incomingChatMeta !== 'object' || Array.isArray(incomingChatMeta))) {
        throw new Error('Invalid chatMetadata section');
    }

    // v9: the localforage section is retired. v8-and-older backups arrive here
    // through the migrator ladder, which folds their collection keys into
    // `shared` and empties this section; anything left is ignored.
    const normalized = {
        version: BACKUP_VERSION,
        module: BACKUP_MODULE,
        exportedAt: data.exportedAt || new Date().toISOString(),
        data: {
            localforage: {},
            extensionSettings: incomingSettings && typeof incomingSettings === 'object'
                ? sanitizeBackupValue(incomingSettings)
                : null,
            chatMetadata: Object.fromEntries(
                Object.entries(incomingChatMeta || {})
                    .filter(([, binding]) => binding?.schemaVersion >= 4)
                    .map(([chatId, binding]) => [chatId, sanitizeBackupValue(binding)])
            ),
        },
        shared: normalizeShared(data.shared),
        secrets: {
            excluded: true,
            excludedKeys: [LF_API_KEY],
        },
    };

    return normalized;
}

/**
 * Take an in-memory snapshot of safe current data for rollback.
 * @returns {Promise<{keys: Map<string, *>, extensionSettings: Object}>}
 */
export class ImportRollbackError extends Error {
    constructor(cause, rollbackErrors) {
        super(`Rollback failed after import error: ${cause?.message || 'unknown error'}`, { cause });
        this.name = 'ImportRollbackError';
        this.rollbackErrors = rollbackErrors;
    }
}

async function snapshotSafeData() {
    const ctx = getCtx();
    const extensionSettings = ctx.extensionSettings?.[MODULE_NAME]
        ? cloneExact(ctx.extensionSettings[MODULE_NAME])
        : null;
    const chatMetadata = ctx.chatMetadata;
    const hasChatBinding = Boolean(ctx.chatId && chatMetadata && Object.hasOwn(chatMetadata, META_KEY));
    // In file-store mode templates live outside extensionSettings — capture them
    // separately so a failed import can roll the file store back too. Same for
    // the refs pool and presets: a rollback that restores settings but leaves
    // imported file-store content behind would end in a half-rolled-back state.
    const templateRecords = await getTemplateRecordsForExport();
    const refsRecords = await getRefsForExport();
    const presetRecords = await getParamPresetsForExport();
    return {
        extensionSettings,
        templateRecords,
        refsRecords,
        presetRecords,
        chatMetadata,
        hasChatBinding,
        chatBinding: hasChatBinding ? cloneExact(chatMetadata[META_KEY]) : undefined,
    };
}

/**
 * Restore the safe data snapshot on import error.
 * @param {{keys: Map<string, *>, extensionSettings: Object}} snapshot
 */
async function restoreSafeSnapshot(snapshot) {
    const rollbackErrors = [];
    const recordError = (source, cause, details = {}) => rollbackErrors.push({ source, cause, ...details });
    const ctx = getCtx();
    if (ctx.extensionSettings) {
        try {
            if (snapshot.extensionSettings) {
                ctx.extensionSettings[MODULE_NAME] = cloneExact(snapshot.extensionSettings);
            } else {
                delete ctx.extensionSettings[MODULE_NAME];
            }
            ctx.saveSettingsDebounced();
        } catch (cause) {
            recordError('settings', cause, { operation: 'restore' });
        }
    }
    if (snapshot.chatMetadata) {
        try {
            if (snapshot.hasChatBinding) {
                snapshot.chatMetadata[META_KEY] = cloneExact(snapshot.chatBinding);
            } else {
                delete snapshot.chatMetadata[META_KEY];
            }
            ctx.saveMetadata?.();
        } catch (cause) {
            recordError('chatMetadata', cause, { operation: 'restore' });
        }
    }
    if (Array.isArray(snapshot.templateRecords)) {
        try {
            await replaceTemplateStoreRecords(snapshot.templateRecords);
        } catch (cause) {
            recordError('templateFileStore', cause, { operation: 'restore' });
        }
    }
    if (snapshot.refsRecords) {
        try {
            await replaceRefsRecords(snapshot.refsRecords);
        } catch (cause) {
            recordError('refsFileStore', cause, { operation: 'restore' });
        }
    }
    if (Array.isArray(snapshot.presetRecords)) {
        try {
            await replaceParamPresetRecords(snapshot.presetRecords);
        } catch (cause) {
            recordError('presetFileStore', cause, { operation: 'restore' });
        }
    }
    log('Rollback: snapshot restored');
    return rollbackErrors;
}

/**
 * Restore URIS data from a backup.
 * @param {Object} data — object from exportUrisData
 * @param {Object} [options]
 * @param {'merge'|'replace'} [options.mode='merge'] — merge with current or full replace
 * @returns {Promise<{importedKeys: number, importedChatBindings: number, summary: Object}>}
 */
export async function importUrisData(data, options = {}) {
    const startedAt = Date.now();
    const normalized = normalizeBackup(data);
    const mode = options.mode === 'replace' ? 'replace' : 'merge';
    const incomingSettings = normalized.data.extensionSettings;
    const incomingShared = normalized.shared || {};
    const incomingChatMeta = normalized.data.chatMetadata || {};

    log('importUrisData: mode=', mode);

    const snapshot = await snapshotSafeData();

    try {
        // Settings: merge — merge, replace — full replace.
        const ctx = getCtx();
        if (incomingSettings && typeof incomingSettings === 'object') {
            ctx.extensionSettings[MODULE_NAME] = mode === 'replace'
                ? { ...incomingSettings }
                : { ...(ctx.extensionSettings[MODULE_NAME] || {}), ...incomingSettings };
        }
        if (Object.keys(incomingShared).length > 0) {
            const current = ctx.extensionSettings[MODULE_NAME] || {};
            const currentConnections = current[IMAGE_CONNECTION_SETTINGS_KEY] || {};
            current[IMAGE_CONNECTION_SETTINGS_KEY] = mode === 'replace'
                ? incomingShared
                : mergeSharedSettings(currentConnections, incomingShared);
            ctx.extensionSettings[MODULE_NAME] = current;
        }
        if (incomingSettings && typeof incomingSettings === 'object') {
            try { ctx.saveSettingsDebounced(); } catch { /* non-critical */ }
            log('extensionSettings restored');
        } else if (Object.keys(incomingShared).length > 0) {
            try { ctx.saveSettingsDebounced(); } catch { /* non-critical */ }
            log('Portable shared settings restored');
        } else if (mode === 'replace' && ctx.extensionSettings[MODULE_NAME]) {
            // If the backup has no settings, on replace delete current URIS settings.
            delete ctx.extensionSettings[MODULE_NAME];
            try { ctx.saveSettingsDebounced(); } catch { /* non-critical */ }
        }

        // Current chat binding, if chatId matches.
        let importedChatBindings = 0;
        const chatId = ctx.chatId;
        if (chatId && incomingChatMeta[chatId]?.schemaVersion >= 4) {
            if (!ctx.chatMetadata) ctx.chatMetadata = {};
            ctx.chatMetadata[META_KEY] = incomingChatMeta[chatId];
            ctx.saveMetadata?.();
            importedChatBindings = 1;
            log('Chat binding restored', chatId);
        } else if (mode === 'replace' && chatId && ctx.chatMetadata) {
            delete ctx.chatMetadata[META_KEY];
            ctx.saveMetadata?.();
            log('Replace mode: removed current chat binding', chatId);
        }

        // Mirror the restored records into the server file stores so they stay
        // in lockstep with what the import produced (the settings sections stay
        // in the blob for old-backup format compatibility only — nothing reads
        // them anymore). Awaited: a fresh import must not depend on a
        // debounced/unload write to survive. The records are cloned BEFORE any
        // store call so the store can never see a half-restored blob.
        try {
            const sharedCarries = section => Object.hasOwn(incomingShared, section);
            const restoredShared = ctx.extensionSettings[MODULE_NAME]?.[IMAGE_CONNECTION_SETTINGS_KEY];
            const restoredTemplates = cloneExact(restoredShared?.templates);
            const restoredPool = {
                refs: cloneExact(restoredShared?.refs),
                folders: cloneExact(restoredShared?.folders),
            };
            const restoredPresets = cloneExact(restoredShared?.presets);

            if (Array.isArray(restoredTemplates)) await replaceTemplateStoreRecords(restoredTemplates);
            // Only a backup that CARRIES a section may overwrite that file
            // store. Reading the (stripped, post-migration) settings copy for a
            // section the backup never had would replace live data with empty
            // arrays — "absent" must not mean "wipe".
            if (sharedCarries('refs') || sharedCarries('folders')) await replaceRefsRecords(restoredPool);
            if (sharedCarries('presets')) await replaceParamPresetRecords(restoredPresets);
        } catch (cause) {
            warn('importUrisData: file store sync failed', cause?.message);
        }

        // External mutation bypassed per-module caches; drop them so the next
        // read reflects the imported data (prompt-templates cache, refs pool cache).
        // Sync invalidation only - no store reads, so no settings side effects.
        try { invalidateTemplateCache(); } catch (e) { warn('importUrisData: template cache invalidation failed', e?.message); }
        try { invalidatePoolCache(); } catch (e) { warn('importUrisData: refs pool cache invalidation failed', e?.message); }

        const importedRecords = ['connections', 'templates', 'presets', 'refs', 'folders']
            .reduce((sum, key) => sum + (Array.isArray(incomingShared[key]) ? incomingShared[key].length : 0), 0);
        log('Imported records:', importedRecords, 'chat bindings:', importedChatBindings);
        recordDiagnosticEvent({
            event: 'import-run', stage: 'data', outcome: 'ok',
            durationMs: Date.now() - startedAt,
            details: { mode, importedRecords, importedChatBindings },
        });
        return {
            importedRecords,
            importedChatBindings,
            summary: summarizeBackup(normalized),
        };
    } catch (e) {
        error('importUrisData: write error, performing rollback:', e.message);
        const rollbackErrors = await restoreSafeSnapshot(snapshot);
        recordDiagnosticEvent({
            event: 'import-run', stage: 'data', level: 'error',
            outcome: rollbackErrors.length > 0 ? 'rollback-failed' : 'rolled-back',
            durationMs: Date.now() - startedAt,
            details: { mode, error: String(e?.message || e), rollbackErrors: rollbackErrors.length },
        });
        if (rollbackErrors.length > 0) {
            throw new ImportRollbackError(e, rollbackErrors);
        }
        throw e;
    }
}

/**
 * Build a backup summary for the UI.
 * Current backups carry the collections in `shared`; pre-v8 backups kept them
 * in localforage keys — count whichever section actually holds the data.
 * @param {Object} data
 * @returns {Object}
 */
export function summarizeBackup(data) {
    const chatMetadata = data?.data?.chatMetadata || {};
    const shared = data?.shared || {};
    const chatMetaEntries = Object.values(chatMetadata);
    const chatConfigs = chatMetaEntries.filter(m => m && typeof m === 'object' && m.schemaVersion >= 4).length;
    // v9 carries the collections in `shared`; older versions are migrated there
    // by the ladder before this runs.
    return {
        refs: Array.isArray(shared.refs) ? shared.refs.length : 0,
        folders: Array.isArray(shared.folders) ? shared.folders.length : 0,
        templates: Array.isArray(shared.templates) ? shared.templates.length : 0,
        chatConfigs,
        galleryIncluded: false,
        secretsIncluded: false,
    };
}

/**
 * Download an object as a JSON file.
 * @param {Object} data
 * @param {string} filename
 */
export function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/**
 * Show a JSON file picker dialog and return the parsed content.
 * @returns {Promise<Object>}
 */
export function uploadJson() {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            input.remove();
            if (!file) return reject(new Error('No file selected'));
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                resolve(data);
            } catch (e) {
                reject(new Error('Failed to parse JSON: ' + e.message));
            }
        });
        document.body.appendChild(input);
        input.click();
    });
}

/**
 * Export data and trigger a file download.
 */
export async function runExport() {
    try {
        const data = await exportUrisData();
        const filename = `uris-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        downloadJson(data, filename);
        const sharedRecords = ['connections', 'templates', 'presets', 'refs', 'folders']
            .reduce((sum, key) => sum + (Array.isArray(data.shared?.[key]) ? data.shared[key].length : 0), 0);
        const total = Object.keys(data.data.localforage).length + sharedRecords;
        toastr?.success(`Экспортировано ${total} записей и текущая конфигурация чата`, DISPLAY_NAME);
    } catch (e) {
        error('runExport:', e);
        reportFailure({ scope: URIS_SCOPES.dataPort, message: 'Ошибка экспорта: ' + (e?.message || e), toast: true, toastText: 'Ошибка экспорта: ' + e.message, toastTitle: DISPLAY_NAME });
    }
}

/**
 * Import data from a file.
 * @param {'merge'|'replace'} [mode='merge']
 * @param {Function} [onSuccess] — callback after successful import (e.g. UI update)
 */
export async function runImport(mode = 'merge', onSuccess) {
    try {
        const data = await uploadJson();
        const result = await importUrisData(data, { mode });
        toastr?.success(
            `Импортировано ${result.importedKeys} записей, конфигураций чата: ${result.importedChatBindings}`,
            DISPLAY_NAME
        );
        if (typeof onSuccess === 'function') {
            try { onSuccess(result); } catch (e) { warn('runImport: onSuccess callback error', e.message); }
        }
        return result;
    } catch (e) {
        error('runImport:', e);
        reportFailure({ scope: URIS_SCOPES.dataPort, message: 'Ошибка импорта: ' + (e?.message || e), toast: true, toastText: 'Ошибка импорта: ' + e.message, toastTitle: DISPLAY_NAME });
        throw e;
    }
}

/** Backup summary → 'merge' | 'replace' | null (user dismissed a dialog). */
async function pickBackupImportMode(summary) {
    const lines = [
        'Содержимое бэкапа URIS:',
        `Шаблоны: ${summary.templates}`,
        `Референсы: ${summary.refs}`,
        `Папки: ${summary.folders}`,
        `Конфигурации чатов: ${summary.chatConfigs}`,
        'Галерея: не включена',
        'API-ключи: не включены',
        '',
        '⚠️ API-ключи не переносятся — их нужно ввести заново.',
        '⚠️ Галерея не переносится.',
        '⚠️ Конфигурации чатов используют исходный chatId.',
        '',
        'Нажмите ОК для замены (replace), Отмена для слияния (merge).',
    ];
    const useReplace = await showConfirmModal(lines.join('\n'));
    if (useReplace) {
        const confirmed = await showConfirmModal(
            'ВНИМАНИЕ: режим replace удалит текущие безопасные данные URIS (кроме галереи и API-ключей) и заменит их содержимым бэкапа.\n\nНажмите ОК для подтверждения замены.'
        );
        return confirmed ? 'replace' : null;
    }
    return 'merge';
}

/**
 * Full interactive import used by both entry points (ST settings panel and the
 * Settings tab): file picker → normalize → backup summary with merge/replace
 * choice → import. Resolves null when the user dismissed the picker or the
 * mode dialog; import errors are recorded and toasted, not rethrown.
 * @returns {Promise<Object|null>} import result or null
 */
export async function runImportInteractive() {
    try {
        const data = await uploadJson();
        const normalized = normalizeBackup(data);
        const mode = await pickBackupImportMode(summarizeBackup(normalized));
        if (!mode) return null;
        const result = await importUrisData(normalized, { mode });
        toastr?.success(`Импортировано ${result.importedKeys} записей.`, DISPLAY_NAME);
        return result;
    } catch (e) {
        error('runImportInteractive:', e);
        reportFailure({ scope: URIS_SCOPES.dataPort, message: e?.message || String(e), toast: true, toastText: 'Ошибка импорта: ' + (e?.message || e), toastTitle: DISPLAY_NAME });
        return null;
    }
}
