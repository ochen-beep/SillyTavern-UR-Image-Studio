// @ts-check
/**
 * Chat-scoped generation config snapshot + active presets resolution.
 * Extracted from pipeline.js for modular structure (see docs/archive/specs/2026-07-18-remove-descrefs-and-split-pipeline-design.md).
 */
import { state } from './core.js';
import { getConnection } from './connections.js';
import { resolveDispatchPlan, assertImageModelEligible } from './dispatch-plan.js';
import { loadChatConfig } from './chat-binding.js';
import { getChatRefs, getRefSync, listRefs, filterRefsByFolders } from './refs-library.js';
import { normalizeSceneEntity } from './scene-context.js';
import { resolveSTMacros } from './template-runtime.js';

function effectiveGenerationDefaults(chatDefaults = {}) {
    const local = chatDefaults || {};
    if (state.settings?.useParametersForAllChats !== true) return structuredClone(local);
    const global = state.settings?.globalGenerationDefaults || {};
    return {
        modelId: local.modelId ?? global.modelId ?? null,
        aspectRatio: local.aspectRatio ?? global.aspectRatio ?? null,
        imageSize: local.imageSize ?? global.imageSize ?? null,
        quality: local.quality ?? global.quality ?? null,
    };
}


/**
 * Build a snapshot of the current chat's generation configuration from runtime
 * state. Used by manual generation calls and as the default capture for queue
 * items when the caller does not supply an explicit snapshot.
 *
 * @returns {import('./core.js').ChatConfigSnapshot}
 */
export function createChatConfigSnapshot() {
    return {
        imageProfileId: state.activeImageProfileId ?? null,
        templateId: state.activeTemplateId ?? null,
        generationDefaults: effectiveGenerationDefaults(state.generationDefaults || {}),
    };
}

/** Capture the current chat's schema-v5 config and the resolved image route. */
export async function resolveChatConfigSnapshot() {
    const binding = await loadChatConfig();
    const config = binding.config;
    const connection = config.imageProfileId ? await getConnection(config.imageProfileId) : null;
    const generationDefaults = effectiveGenerationDefaults(config.generationDefaults || {});
    const detectedModels = Array.isArray(connection?.detected?.modelIds) ? connection.detected.modelIds : [];
    const validOverride = generationDefaults.modelId
        && (!detectedModels.length || detectedModels.includes(generationDefaults.modelId));
    if (validOverride && connection) {
        assertImageModelEligible(connection, generationDefaults.modelId);
    }
    const selectedModel = validOverride && connection
        ? { ...connection, model: { ...(connection.model || {}), id: generationDefaults.modelId, source: 'list' } }
        : connection;
    // Snapshot the fully synthesized route (dialect resolved from model family
    // × evidence × overrides) so an enqueued generation keeps speaking the
    // dialect it started with even if the connection is edited mid-flight.
    // Legacy records without a model fall back to their persisted route.
    const plan = selectedModel ? resolveDispatchPlan(selectedModel) : null;
    const route = plan?.route
        || (connection?.selectedRoute?.generationContract ? structuredClone(connection.selectedRoute) : null);
    return {
        imageProfileId: config.imageProfileId ?? null,
        templateId: config.templateId ?? null,
        generationDefaults,
        imageRoute: route,
    };
}

// ── Active presets resolution (chat-scoped snapshot) ──

/**
 * @returns {Promise<{imageConnId: string|null, template:object|null}>}
 */
export async function resolveActivePresets(chatConfig) {
    const snapshot = chatConfig || createChatConfigSnapshot();
    const imageConn = snapshot.imageProfileId ? await getConnection(snapshot.imageProfileId) : null;
    return {
        imageConnId: imageConn?.id || snapshot.imageProfileId || null,
        template: null,
    };
}

// ── Reference candidates ──

/**
 * Expand SillyTavern macros ({{char}}, {{user}}, …) in a scene entity's name
 * and aliases. Stage 1/2 scene matching compares aliases against the chat text
 * literally, so a reference alias like `{{char}}` would never match the actual
 * character name unless it is resolved here first. Re-dedup keeps the result
 * stable when name and an alias collapse to the same value (e.g. both `{{char}}`).
 *
 * @param {import('./scene-context.js').SceneEntity} entity
 * @returns {import('./scene-context.js').SceneEntity}
 */
function expandMacros(entity) {
    const name = resolveSTMacros(entity.name);
    const aliases = entity.aliases
        .map(a => resolveSTMacros(a))
        .filter((v, i, a) => v && a.indexOf(v) === i);
    return { ...entity, name, aliases };
}

/**
 * Build scene entities from current ST context and reference pool.
 * Shared infrastructure for Stage 1 (snapshot) and Stage 2 (re-resolve by prompt).
 *
 * @param {string} chatId
 * @returns {Promise<import('./scene-context.js').SceneEntity[]>}
 */
export async function buildCandidates(chatId) {
    const chatRefs = getChatRefs();
    const directRefs = chatRefs.referenceIds
        .map(refId => getRefSync(refId))
        .filter(Boolean);
    const folderRefs = chatRefs.folderIds?.length
        ? filterRefsByFolders(await listRefs(), chatRefs.folderIds)
        : [];

    const seen = new Set();
    const candidates = [];
    for (const ref of [...directRefs, ...folderRefs]) {
        if (!ref || seen.has(ref.id)) continue;
        seen.add(ref.id);
        candidates.push(expandMacros(normalizeSceneEntity(ref)));
    }
    return candidates;
}
