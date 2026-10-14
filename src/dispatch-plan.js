// @ts-check
/**
 * Dispatch plan: dialect selection without persisted route contracts.
 *
 * The wire dialect ("contract") is a derived fact about (endpoint × model
 * family × observed evidence), not a user setting. This module owns the
 * static knowledge tables and the resolution that turns a connection plus a
 * model id into the route object the provider adapters already accept:
 * { contractVersion, generationContract, modelId, capabilities, transport }.
 *
 * Layers of truth, in ascending priority:
 *   1. Static tables below (per model family / endpoint shape).
 *   2. `connection.evidence[modelId]` — facts from already-paid attempts.
 *   3. `connection.overrides.dialect` — explicit user pin (advanced section).
 *
 * See docs: the card UI never asks for a dialect; it may only display the
 * resolved one and offer an override when auto-resolution misfires.
 */
import { CONTRACTS, CHAT_COMPLETIONS_IMAGE_CONFIGS } from './image-connection-schema.js';
import { effectiveReferenceCap } from './reference-limits.js';

// ── Model families ──

export const MODEL_FAMILIES = Object.freeze({
    GEMINI_IMAGE: 'gemini-image',
    GPT_IMAGE: 'gpt-image',
    DALL_E: 'dall-e',
    FLUX_KONTEXT: 'flux-kontext',
    GROK_IMAGINE: 'grok-imagine',
    UNKNOWN: 'unknown',
});

// Ordered: first match wins. nano-banana aliases resolve to gemini-image.
const FAMILY_PATTERNS = [
    [MODEL_FAMILIES.GEMINI_IMAGE, /gemini[^/\s]*image|nano[-_. ]?banana/i],
    [MODEL_FAMILIES.GPT_IMAGE, /gpt-image/i],
    [MODEL_FAMILIES.FLUX_KONTEXT, /flux[^/\s]*kontext/i],
    [MODEL_FAMILIES.GROK_IMAGINE, /grok[^/\s]*(?:imagine|image)/i],
    [MODEL_FAMILIES.DALL_E, /dall[-_. ]?e/i],
];

/** @returns {string} one of MODEL_FAMILIES */
export function detectModelFamily(modelId) {
    const model = String(modelId || '');
    if (!model) return MODEL_FAMILIES.UNKNOWN;
    for (const [family, pattern] of FAMILY_PATTERNS) {
        if (pattern.test(model)) return family;
    }
    return MODEL_FAMILIES.UNKNOWN;
}

// ── Reference limits (static prior per family; evidence refines later) ──

// Gemini image generations accept many reference images on the wire, but
// adherence degrades quickly: vendor-documented total ceilings per
// generation (ai.google.dev/gemini-api/docs/image-generation, 2026-09 —
// 3.1 Flash: 10 objects + 4 characters; 3 Pro: 6 objects + 5 characters
// + 3 style refs; 2.5 Flash: 3). Matched against the model id inside the
// gemini-image family.
const GEMINI_IMAGE_REF_LIMITS = [
    [/3[._-]?1[^/]*flash|nano[-_. ]?banana[-_. ]?2/i, 14],
    [/3[^/]*pro|nano[-_. ]?banana[-_. ]?pro/i, 14],
    [/2[._-]?5|(?<![\w-])nano[-_. ]?banana(?![\w-])/i, 3],
];

/**
 * Wire-level maximum reference count for a model. 0 means the model cannot
 * use references at all (dall-e-3).
 * @param {string} modelId
 * @returns {number|null}
 */
export function maxReferencesFor(modelId) {
    const family = detectModelFamily(modelId);
    const model = String(modelId || '');
    switch (family) {
        case MODEL_FAMILIES.GEMINI_IMAGE: {
            for (const [pattern, limit] of GEMINI_IMAGE_REF_LIMITS) {
                if (pattern.test(model)) return limit;
            }
            return null;
        }
        case MODEL_FAMILIES.GPT_IMAGE: return 5;
        case MODEL_FAMILIES.FLUX_KONTEXT: return 1;
        case MODEL_FAMILIES.GROK_IMAGINE: return 3;
        case MODEL_FAMILIES.DALL_E:
            if (/dall[-_. ]?e[-_. ]?2/i.test(model)) return 1;
            if (/dall[-_. ]?e[-_. ]?3/i.test(model)) return 0;
            return 1;
        default: return null;
    }
}

// ── Endpoint shape ──

export const API_SHAPES = Object.freeze({
    OPENAI: 'openai',
    GEMINI: 'gemini',
    OPENROUTER: 'openrouter',
    POLLINATIONS: 'pollinations',
    NAISTERA: 'naistera',
    COMFYUI: 'comfyui',
    CLOUDFLARE: 'cloudflare',
    UNKNOWN: 'unknown',
});

/**
 * Shape inferred from the endpoint host when «Проверить» has not run (or ran
 * before the endpoint was edited). OpenAI-compatible is the default: it is by
 * far the most common gateway shape and chat-completions is the most widely
 * implemented dialect on it.
 * @param {string} endpoint
 * @returns {string} one of API_SHAPES
 */
export function inferApiShape(endpoint) {
    const value = String(endpoint || '').toLowerCase();
    if (/gen\.pollinations\.ai|pollinations\.ai/.test(value)) return API_SHAPES.POLLINATIONS;
    if (/naistera\.org/.test(value)) return API_SHAPES.NAISTERA;
    if (/api\.cloudflare\.com/.test(value)) return API_SHAPES.CLOUDFLARE;
    if (/:8188(?:\/|$)/.test(value)) return API_SHAPES.COMFYUI; // дефолтный порт ComfyUI
    if (/openrouter\.ai/.test(value)) return API_SHAPES.OPENROUTER;
    if (/generativelanguage\.googleapis\.com/.test(value)) return API_SHAPES.GEMINI;
    return API_SHAPES.OPENAI;
}

// ── Dialect priority ──

const D = CONTRACTS;

// Ordered fallback chains per (endpoint shape, model family). The first entry
// is what «auto» dispatches; evidence may promote a later entry after a
// structured rejection, an override pins any entry explicitly.
const DIALECT_ORDER = {
    pollinations: { default: [CONTRACTS.POLLINATIONS_IMAGES] },
    [API_SHAPES.NAISTERA]: { default: [CONTRACTS.NAISTERA] },
    [API_SHAPES.COMFYUI]: { default: [D.COMFYUI] },
    [API_SHAPES.CLOUDFLARE]: { default: [D.CLOUDFLARE_WORKERS_AI] },
    [API_SHAPES.GEMINI]: {
        // Interactions — второй рунг (документированная поверхность NB 2.1+).
        // Первый диспатч всегда gemini-native: generateContent остаётся
        // поддерживаемым Google, а рунг ниже достижим только через evidence
        // после структурного отказа первого или явный override пользователя.
        default: [D.GEMINI_NATIVE, D.GEMINI_INTERACTIONS],
    },
    [API_SHAPES.OPENROUTER]: {
        default: [D.OPENROUTER_IMAGES],
    },
    [API_SHAPES.OPENAI]: {
        // Gemini image models behind an OpenAI-compatible gateway: the
        // chat-completions multimodal path is the most widely implemented
        // on relay gateways (new-api family); the native
        // :generateContent path is exposed by several gateways under the same
        // base; /images/edits JSON is the long tail.
        [MODEL_FAMILIES.GEMINI_IMAGE]: [D.CHAT_COMPLETIONS, D.GEMINI_NATIVE, D.OPENAI_IMAGES],
        default: [D.OPENAI_IMAGES, D.CHAT_COMPLETIONS],
    },
    [API_SHAPES.UNKNOWN]: {
        default: [D.CHAT_COMPLETIONS, D.OPENAI_IMAGES, D.GEMINI_NATIVE],
    },
};

/** Ordered dialect chain for an endpoint shape and model family. */
export function dialectOrder(apiShape, family) {
    const byShape = DIALECT_ORDER[apiShape] || DIALECT_ORDER[API_SHAPES.UNKNOWN];
    return byShape[family] || byShape.default;
}

// ── Valid parameter values (feeds UI dropdowns; Phase 4 consumer) ──

export const VALID_PARAMS = Object.freeze({
    quality: Object.freeze({
        [MODEL_FAMILIES.GPT_IMAGE]: ['auto', 'low', 'medium', 'high'],
        [MODEL_FAMILIES.DALL_E]: ['auto', 'standard', 'hd'],
        default: ['auto', 'low', 'medium', 'high'],
    }),
});

// ── Resolution ──

const DIALECTS = new Set(Object.values(CONTRACTS));

/**
 * Resolve the model id a connection should generate with. The projected
 * `connection.model` (schema v2) is authoritative; raw legacy records without
 * it return null so callers can fall back to their persisted route.
 * @param {object} connection
 * @returns {string|null}
 */
export function connectionModelId(connection) {
    const id = String(connection?.model?.id || '').trim();
    return id || null;
}

/**
 * Build the dispatch plan: which dialect to speak and the synthesized route
 * object for the provider adapters. Pure and synchronous; never throws for a
 * missing model (returns null — the caller decides how to surface it).
 *
 * @param {object} connection normalized connection record (schema v2 fields)
 * @param {object} [options]
 * @param {boolean} [options.hasRefs] reserved for future per-operation tuning
 * @returns {{dialect:string, family:string, apiShape:string, alternatives:string[], route:object}|null}
 */
export function resolveDispatchPlan(connection, options = {}) {
    const modelId = connectionModelId(connection);
    if (!modelId) return null;

    const family = detectModelFamily(modelId);
    assertImageModelEligible(connection, modelId);
    const detected = connection?.detected || {};
    const apiShape = detected.apiShape && detected.apiShape !== API_SHAPES.UNKNOWN
        ? detected.apiShape
        : inferApiShape(connection?.endpoint);
    const nanoGptCompatibility = detected.catalogSource === 'nanogpt-image-models';
    const alternatives = nanoGptCompatibility
        ? [CONTRACTS.OPENAI_IMAGES, CONTRACTS.CHAT_COMPLETIONS]
        : dialectOrder(apiShape, family);

    const evidence = connection?.evidence?.[modelId];
    const override = connection?.overrides?.dialect;
    let dialect;
    if (override && DIALECTS.has(override)) {
        dialect = override;
    } else if (evidence?.dialect && DIALECTS.has(evidence.dialect)) {
        dialect = evidence.dialect;
    } else {
        dialect = alternatives[0];
    }

    const detectedModel = Array.isArray(detected.modelMetadata)
        ? detected.modelMetadata.find(item => item?.modelId === modelId)
            || detected.modelMetadata.find(item => String(item?.modelId || '').toLowerCase() === String(modelId).toLowerCase())
        : null;
    const pollinationsRoute = dialect === CONTRACTS.POLLINATIONS_IMAGES;
    const naisteraRoute = dialect === CONTRACTS.NAISTERA;
    const providerMax = detectedModel && Number.isSafeInteger(detectedModel.maxReferences)
        ? detectedModel.maxReferences
        : (naisteraRoute ? null : maxReferencesFor(modelId));
    const overrides = connection?.overrides || {};
    // Reference policy: explicit maxRefs override tightens (never widens) the
    // family limit; refs:'never' turns references off for this connection.
    const effectiveMax = effectiveReferenceCap({
        providerCap: providerMax,
        connectionCap: overrides.maxRefs,
        disabled: overrides.refs === 'never',
    });
    const refsBlocked = effectiveMax === 0;
    const refsState = refsBlocked
        ? 'unsupported'
        : (detectedModel?.references === 'supported' || detectedModel?.references === 'unsupported'
            ? detectedModel.references
            : (evidence?.refs === 'confirmed' || naisteraRoute ? 'supported' : 'unknown'));
    // Gateway parameter dialect for image params on chat-completions: which
    // non-standard member the adapter may send ('openrouter' → top-level
    // image_config + modalities, 'new-api' → extra_body.google.image_config).
    // Absent = send nothing and warn about dropped aspect/size instead.
    const chatCompletionsImageConfig = dialect === CONTRACTS.CHAT_COMPLETIONS
        && CHAT_COMPLETIONS_IMAGE_CONFIGS.has(overrides.chatCompletionsImageConfig)
        ? overrides.chatCompletionsImageConfig
        : null;

    return {
        dialect,
        family,
        apiShape,
        alternatives,
        route: {
            // Synthesized route: the adapters read modelId / generationContract
            // / capabilities / transport; contractVersion satisfies the
            // registry guard. `id` is diagnostic-only (logs, gallery
            // provenance) — it is not persisted or looked up.
            id: `plan:${dialect}:${modelId}`,
            contractVersion: 1,
            generationContract: dialect,
            apiFamily: dialect,
            source: 'dispatch-plan',
            modelId,
            label: String(connection?.model?.label || modelId),
                capabilities: {
                    generate: detectedModel?.imageGeneration === true ? 'supported' : 'unknown',
                    references: pollinationsRoute ? 'unsupported' : refsState,
                    edit: pollinationsRoute || naisteraRoute ? 'unsupported' : 'unknown',
                    ...(detectedModel?.supportedParameters?.length ? { supportedParameters: detectedModel.supportedParameters } : {}),
                    ...(detectedModel?.imageSizes?.length ? { imageSizes: detectedModel.imageSizes } : {}),
                    ...(detectedModel?.qualityValues?.length ? { qualityValues: detectedModel.qualityValues } : {}),
                    ...(chatCompletionsImageConfig ? { chatCompletionsImageConfig } : {}),
                    ...(pollinationsRoute || refsBlocked || effectiveMax === null ? {} : { maxReferences: effectiveMax }),
                },

            transport: {
                bodyKind: 'json',
                directCors: 'preferred',
                ...(pollinationsRoute ? { providerId: 'pollinations', authStrategy: 'bearer' } : {}),
                ...(naisteraRoute ? { providerId: 'naistera', authStrategy: 'bearer' } : {}),
            },
        },
    };
}

// ── Human-readable reference encoding (references panel) ──

const REFERENCE_ENCODINGS = Object.freeze({
    [CONTRACTS.GEMINI_NATIVE]: 'inlineData (gemini-native)',
    [CONTRACTS.GEMINI_INTERACTIONS]: 'input[] image (gemini-interactions)',
    [CONTRACTS.CHAT_COMPLETIONS]: 'image_url-части (chat-completions)',
    [CONTRACTS.OPENAI_IMAGES]: 'images[] (openai-images)',
    [CONTRACTS.OPENROUTER_IMAGES]: 'input_references (openrouter)',
    [CONTRACTS.POLLINATIONS_IMAGES]: 'references unsupported (pollinations)',
    [CONTRACTS.NAISTERA]: 'reference_objects (naistera)',
    [CONTRACTS.COMFYUI]: 'LoadImage (upload/image)',
    [CONTRACTS.CLOUDFLARE_WORKERS_AI]: 'image_b64 (cloudflare)',
});

/** How references travel on the wire for a dialect, e.g. for the panel label. */
export function referenceEncoding(dialect) {
    return REFERENCE_ENCODINGS[dialect] || dialect;
}

// ── Image-model classification (model dropdown filtering) ──
//
// A model id is not a capability manifest. The classifier therefore keeps
// three states: confirmed image metadata, a conservative family/name prior,
// and unknown. Unknown models remain available through an explicit "show all"
// or manual choice, but are never promoted into the default image list.
const LIKELY_IMAGE_MODEL = /(?:^|[\/_-])(?:gpt-image|dall-e|imagen|gemini[^/]*image|image)(?:[\/_-]|$)/i;
const IMAGE_FAMILY_ALIAS = /(?:^|[\/_-])(?:nano[-_. ]?banana|gptimage(?:[-_. ]?(?:large|mini))?|flux(?:[-_. ]?(?:kontext|dev|schnell|pro))?|(?:^|[\/_-])kontext|seedream(?:\d+(?:[-_. ]?(?:pro|lite))?)?|hidream|recraft|ideogram|stable[-_. ]?diffusion|sdxl|sd3(?:[._-]?5)?|qwen[-_. ]?image|grok[-_. ]?imagine|krea|dreamshaper|nova[-_. ]?canvas|klein|zimage|playground|kandinsky|pixart|auraflow|kolors|hunyuan[-_. ]?image|lumina[-_. ]?image|firefly[-_. ]?image|titan[-_. ]?image|midjourney|nai[-_. ]?diffusion)(?:[\/_-]|$)/i;

function normalizedModelId(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizedMetadata(metadata) {
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
}

function metadataForModel(modelId, metadata) {
    const list = Array.isArray(metadata) ? metadata : [];
    const wanted = String(modelId).toLowerCase();
    return list.find(item => String(item?.modelId || item?.id || '').trim().toLowerCase() === wanted) || {};
}

function outputModalities(metadata) {
    const input = normalizedMetadata(metadata);
    const direct = input.outputModalities || input.output_modalities;
    const architecture = normalizedMetadata(input.architecture);
    const nested = architecture.outputModalities || architecture.output_modalities;
    return (Array.isArray(direct) ? direct : Array.isArray(nested) ? nested : [])
        .map(value => String(value || '').trim().toLowerCase())
        .filter(Boolean);
}

/**
 * Classify one catalog entry without treating an unknown id as text-only.
 * @param {string|object} model
 * @param {object} [metadata]
 * @returns {{modelId:string, kind:'image'|'non-image'|'unknown', confidence:'confirmed'|'likely'|'explicit'|'unknown', reason:string}}
 */
export function classifyModelCapability(model, metadata = {}) {
    const modelId = normalizedModelId(typeof model === 'string' ? model : model?.modelId || model?.id || model?.name);
    if (!modelId) return { modelId: '', kind: 'unknown', confidence: 'unknown', reason: 'empty-id' };
    const item = typeof model === 'object'
        ? normalizedMetadata(model)
        : (Array.isArray(metadata) ? metadataForModel(modelId, metadata) : normalizedMetadata(metadata));
    const capabilities = normalizedMetadata(item.capabilities);
    const category = String(item.category || item.mediaKind || item.media_kind || item.kind || '').trim().toLowerCase();
    const modalities = outputModalities(item);

    if (category === 'video') return { modelId, kind: 'non-image', confidence: 'explicit', reason: 'media-kind-video' };
    if (category === 'text' || category === 'chat' || category === 'embedding' || category === 'audio') {
        return { modelId, kind: 'non-image', confidence: 'explicit', reason: `media-kind-${category}` };
    }
    if (category === 'image' || item.imageGeneration === true || item.image_generation === true || capabilities.image_generation === true || capabilities.imageGeneration === true) {
        return { modelId, kind: 'image', confidence: 'confirmed', reason: 'catalog-metadata' };
    }
    if (modalities.includes('image') || modalities.includes('images')) {
        return { modelId, kind: 'image', confidence: 'confirmed', reason: 'output-modality-image' };
    }
    if (modalities.length && !modalities.includes('image') && !modalities.includes('images')) {
        return { modelId, kind: 'non-image', confidence: 'explicit', reason: `output-modality-${modalities[0]}` };
    }
    if (detectModelFamily(modelId) !== MODEL_FAMILIES.UNKNOWN || LIKELY_IMAGE_MODEL.test(modelId) || IMAGE_FAMILY_ALIAS.test(modelId)) {
        return { modelId, kind: 'image', confidence: 'likely', reason: 'model-family-or-name' };
    }
    return { modelId, kind: 'unknown', confidence: 'unknown', reason: 'no-capability-evidence' };
}

/** Classify a selected connection model using its bounded probe metadata. */
function classifyConnectionModel(connection, modelId = connectionModelId(connection)) {
    const detected = connection?.detected || {};
    const metadata = Array.isArray(detected.modelMetadata) ? detected.modelMetadata : [];
    return classifyModelCapability(modelId, metadataForModel(modelId, metadata));
}

/**
 * Reject only models explicitly declared as non-image. Unknown IDs remain
 * allowed for private gateways and new image families that have no metadata.
 */
export function assertImageModelEligible(connection, modelId = connectionModelId(connection)) {
    const classification = classifyConnectionModel(connection, modelId);
    if (classification.kind === 'non-image') {
        const error = new Error(`Модель «${classification.modelId}» явно не поддерживает генерацию изображений (${classification.reason}).`);
        error.code = 'MODEL_NOT_IMAGE';
        error.modelId = classification.modelId;
        error.classification = classification;
        throw error;
    }
    return classification;
}

/**
 * Split a model list into image candidates and everything else. The full
 * catalog is deliberately retained in `otherModels`; callers decide whether
 * it is visible. Metadata is optional for compatibility with old callers.
 * @param {Array<string|object>} modelIds
 * @param {Array<object>} [metadata]
 * @returns {{imageModels:string[], otherModels:string[], classifications:Array<object>}}
 */
export function partitionLikelyImageModels(modelIds, metadata = []) {
    const imageModels = [];
    const otherModels = [];
    const classifications = [];
    const seen = new Set();
    for (const entry of Array.isArray(modelIds) ? modelIds : []) {
        const modelId = normalizedModelId(typeof entry === 'string' ? entry : entry?.modelId || entry?.id || entry?.name);
        if (!modelId || seen.has(modelId.toLowerCase())) continue;
        seen.add(modelId.toLowerCase());
        const classification = classifyModelCapability(entry, metadataForModel(modelId, metadata));
        classifications.push(classification);
        (classification.kind === 'image' ? imageModels : otherModels).push(modelId);
    }
    const sort = (a, b) => a.localeCompare(b);
    imageModels.sort(sort);
    otherModels.sort(sort);
    classifications.sort((a, b) => a.modelId.localeCompare(b.modelId));
    return { imageModels, otherModels, classifications };
}

/** Apply the shared visibility policy used by both model selectors. */
export function getVisibleModelChoices(modelIds, { showAll = false, metadata = [] } = {}) {
    const partition = partitionLikelyImageModels(modelIds, metadata);
    return {
        ...partition,
        ids: showAll ? [...partition.imageModels, ...partition.otherModels] : partition.imageModels,
        showAll: showAll === true,
        hasHiddenModels: partition.otherModels.length > 0,
    };
}
