// @ts-check
/**
 * Chat-scoped generation configuration (schema v5).
 * chatMetadata.uris_binding = { schemaVersion: 5, config, refs }.
 */
import {
    state, getCtx, log,
    META_KEY, defaultSettings,
    getDefaultChatConfigEnvelope, DEFAULT_CHAT_CONFIG_ENVELOPE,
    deepClone, VALID_ASPECT_RATIOS, VALID_IMAGE_SIZES,
} from './core.js';
import { POST_FILTER, setFilter } from './post-navigator.js';

// ── schema-v5 defaults and normalization ──

const VALID_AUTOMATION_MODES = new Set(['manual', 'build-prompt', 'full-pipeline']);
const VALID_GENERATION_FLOWS = new Set(['ai-only', 'user-only', 'all', 'manual']);

export function createDefaultChatConfig() {
    return getDefaultChatConfigEnvelope();
}

export function getBinding() {
    const ctx = getCtx();
    const meta = ctx.chatMetadata?.[META_KEY];
    return meta && typeof meta === 'object' ? meta : null;
}

export function setBinding(binding) {
    const ctx = getCtx();
    if (!ctx.chatMetadata) ctx.chatMetadata = {};
    ctx.chatMetadata[META_KEY] = binding;
    try { ctx.saveMetadata?.(); } catch { /* non-critical */ }
    log('Привязка обновлена', binding);
}

function normalizeId(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    return s || null;
}

function normalizeEnum(value, allowed, fallback) {
    const s = String(value || '').trim();
    return allowed.has(s) ? s : fallback;
}

function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map(v => (v == null ? null : String(v).trim()))
        .filter(v => v);
}

function normalizeOptionalEnum(value, allowed) {
    const s = String(value || '').trim();
    return allowed.includes(s) ? s : null;
}

function normalizeGenerationDefaults(value) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        modelId: normalizeId(input.modelId),
        aspectRatio: normalizeOptionalEnum(input.aspectRatio, VALID_ASPECT_RATIOS),
        imageSize: normalizeOptionalEnum(input.imageSize, VALID_IMAGE_SIZES),
        // Quality values vary by model family; preserve a non-empty user value
        // and let the provider/dispatch layer validate it for the selected model.
        quality: normalizeId(input.quality),
    };
}

/**
 * Return a defensive, schema-v5-normalized copy of any chat binding.
 * Non-object / null input returns fixed defaults.
 * Migrates v4 → v5 by dropping dead copyToStGallery/galleryMode fields.
 */
export function normalizeChatBinding(binding) {
    if (!binding || typeof binding !== 'object') {
        return createDefaultChatConfig();
    }

    const config = binding.config && typeof binding.config === 'object'
        ? binding.config
        : {};
    const refs = binding.refs && typeof binding.refs === 'object'
        ? binding.refs
        : {};

    return {
        schemaVersion: 5,
        config: {
            imageProfileId: normalizeId(config.imageProfileId) ?? DEFAULT_CHAT_CONFIG_ENVELOPE.config.imageProfileId,
            templateId: normalizeId(config.templateId) ?? DEFAULT_CHAT_CONFIG_ENVELOPE.config.templateId,
            generationDefaults: normalizeGenerationDefaults(config.generationDefaults),
            automationMode: normalizeEnum(config.automationMode, VALID_AUTOMATION_MODES, DEFAULT_CHAT_CONFIG_ENVELOPE.config.automationMode),
            generationFlow: normalizeEnum(config.generationFlow, VALID_GENERATION_FLOWS, DEFAULT_CHAT_CONFIG_ENVELOPE.config.generationFlow),
        },
        refs: {
            referenceIds: normalizeStringArray(refs.referenceIds),
            folderIds: normalizeStringArray(refs.folderIds),
        },
    };
}

// ── persistence ──

/**
 * Load the current chat's schema-v5 config. Missing bindings receive fixed
 * defaults and are initialized for the current chat. Non-schema-v4/v5 records are
 * ignored without reading or mutating non-current metadata.
 */
export async function loadChatConfig() {
    const binding = getBinding();
    if (binding?.schemaVersion >= 4) {
        return normalizeChatBinding(binding);
    }
    const cfg = createDefaultChatConfig();
    if (!binding) await saveChatConfig(cfg);
    return cfg;
}

/**
 * Persist a full schema-v5 binding to the current chat metadata only.
 * Returns a defensive normalized copy.
 */
export async function saveChatConfig(binding) {
    const normalized = normalizeChatBinding(binding);
    setBinding(normalized);
    return normalized;
}

/**
 * Deep-merge only known config fields of the current chat and persist.
 * Preserves refs and unknown metadata fields. Returns the new binding.
 *
 * A pre-v4 legacy binding is migrated to v5 defaults with the patch applied
 * on top; the original record is kept under `legacy` (next normalizeChatBinding
 * drops it again, but a silent total discard — the old behavior — destroyed
 * caller data with no trace and no error).
 */
export async function patchChatConfig(patch) {
    const existing = getBinding();
    const isLegacy = !!(existing && existing.schemaVersion < 4);
    const current = isLegacy ? createDefaultChatConfig() : await loadChatConfig();
    const next = deepClone(current);
    if (patch && typeof patch === 'object') {
        for (const key of Object.keys(patch)) {
            if (!Object.hasOwn(next.config, key)) continue;
            if (key === 'generationDefaults' && patch[key] && typeof patch[key] === 'object') {
                next.config.generationDefaults = {
                    ...next.config.generationDefaults,
                    ...patch[key],
                };
            } else {
                next.config[key] = patch[key];
            }
        }
    }
    const normalized = await saveChatConfig(next);
    if (isLegacy) {
        log('patchChatConfig: pre-v4 binding migrated to v5 (original kept under `legacy`)');
        setBinding({ ...normalized, legacy: existing });
    }
    return normalized;
}

/**
 * Apply a loaded schema-v5 chat config to the runtime state.
 * This is a read-only projection: it does not mutate persisted chat metadata.
 *
 * @param {ReturnType<normalizeChatBinding>} cfg
 */
export function applyChatConfigToState(cfg) {
    if (!cfg || typeof cfg !== 'object' || cfg.schemaVersion < 4) return;
    const config = cfg.config;
    state.activeImageProfileId = config.imageProfileId ?? null;
    state.activeTemplateId = config.templateId ?? null;
    const chatDefaults = deepClone(config.generationDefaults || {});
    const globalDefaults = state.settings?.useParametersForAllChats === true
        ? (state.settings.globalGenerationDefaults || {}) : {};
    state.generationDefaults = {
        modelId: chatDefaults.modelId ?? globalDefaults.modelId ?? null,
        aspectRatio: chatDefaults.aspectRatio ?? globalDefaults.aspectRatio ?? null,
        imageSize: chatDefaults.imageSize ?? globalDefaults.imageSize ?? null,
        quality: chatDefaults.quality ?? globalDefaults.quality ?? null,
    };
    // Runtime projection only. automationMode/generationFlow MUST NOT go into
    // state.settings: that object is persisted globally by ST, so the last
    // visited chat's mode leaked into settings.json and came back as the next
    // session's startup default for every other chat.
    state.chatAutomationMode = config.automationMode ?? defaultSettings.automationMode;
    state.chatGenerationFlow = config.generationFlow ?? defaultSettings.generationFlow;
    setFilter(state.chatGenerationFlow || POST_FILTER.AI_ONLY);
}
