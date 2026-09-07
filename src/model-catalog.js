// @ts-check
/** Provider-neutral, bounded model catalog normalization. */

const MAX_MODELS = 500;
const MAX_STRING = 256;
const MAX_LIST = 64;
const MAX_LIST_STRING = 128;
const SECRET_KEY = /(?:api[_-]?key|authorization|token|secret|password|credential|private[_-]?key)/i;

function text(value, max = MAX_STRING) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function list(value) {
    return Array.isArray(value)
        ? value.slice(0, MAX_LIST).map(item => text(item, MAX_LIST_STRING)).filter(Boolean)
        : [];
}

function supportedParameters(item) {
    const raw = item.supported_parameters || item.supportedParameters;
    if (Array.isArray(raw)) return list(raw);
    const object = safeObject(raw);
    const keys = Object.keys(object).filter(key => !SECRET_KEY.test(key));
    return keys.slice(0, MAX_LIST).map(key => text(key, MAX_LIST_STRING)).filter(Boolean);
}

function parameterValues(item, key, fallback = []) {
    const raw = item.supported_parameters || item.supportedParameters;
    const nested = safeObject(raw)[key];
    return list(item[key] || item[key === 'resolutions' ? 'imageSizes' : 'qualityValues'] || nested);
}


function safeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function modelList(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.models)) return payload.models;
    return null;
}

function rawModelId(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
    return text(item.id || item.name).replace(/^models\//, '');
}

function outputModalities(item) {
    const architecture = safeObject(item.architecture);
    return list(item.output_modalities || item.outputModalities || architecture.output_modalities || architecture.outputModalities)
        .map(value => value.toLowerCase());
}

function mediaKind(item) {
    const value = text(item.mediaKind || item.media_kind || item.category || item.kind).toLowerCase();
    if (value === 'image' || value === 'video' || value === 'text' || value === 'chat' || value === 'audio' || value === 'embedding') return value;
    return null;
}

function imageGeneration(item) {
    const capabilities = safeObject(item.capabilities);
    const value = item.imageGeneration ?? item.image_generation ?? capabilities.imageGeneration ?? capabilities.image_generation;
    return typeof value === 'boolean' ? value : null;
}

function referenceState(item) {
    const capabilities = safeObject(item.capabilities);
    const parameters = safeObject(item.supported_parameters || item.supportedParameters);
    const imageToImage = item.imageToImage ?? item.image_to_image ?? capabilities.imageToImage ?? capabilities.image_to_image;
    const value = item.references ?? item.supports_references ?? item.supportsReferences
        ?? item.reference_images_supported ?? item.referenceImagesSupported
        ?? item.references_supported ?? item.referencesSupported;
    if (value === true || value === 'supported') return 'supported';
    if (value === false || value === 'unsupported' || imageToImage === false) return 'unsupported';
    if (Number.isSafeInteger(parameters.max_input_images) && parameters.max_input_images > 0) return 'supported';
    return 'unknown';
}

function maxReferences(item) {
    const parameters = safeObject(item.supported_parameters || item.supportedParameters);
    const value = item.maxReferences ?? item.max_reference_images ?? parameters.max_input_images;
    return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 64) : null;
}

function imageDeclared(item) {
    const input = safeObject(item);
    const kind = mediaKind(input);
    const modalities = outputModalities(input);
    const generated = imageGeneration(input);
    return kind === 'image' || modalities.includes('image') || modalities.includes('images') || generated === true;
}

function boundedEntry(item, { source = 'generic-models', provider = 'generic', forceImage = false } = {}) {
    const input = safeObject(item);
    const modelId = rawModelId(input);
    if (!modelId) return null;
    const modalities = outputModalities(input);
    const kind = forceImage ? 'image' : mediaKind(input);
    const generated = forceImage ? true : imageGeneration(input);
    const capabilities = safeObject(input.capabilities);
    const entry = {
        modelId,
        ...(text(input.displayName || input.title || input.label) ? { label: text(input.displayName || input.title || input.label) } : {}),
        ...(kind ? { mediaKind: kind } : {}),
        ...(modalities.length ? { outputModalities: modalities } : {}),
        ...(generated !== null ? { imageGeneration: generated } : {}),
        references: referenceState(input),
        ...(maxReferences(input) !== null ? { maxReferences: maxReferences(input) } : {}),
        ...(supportedParameters(input).length ? { supportedParameters: supportedParameters(input) } : {}),
        ...(parameterValues(input, 'resolutions').length ? { imageSizes: parameterValues(input, 'resolutions').map(value => value.toLowerCase()) } : {}),
        ...(parameterValues(input, 'quality').length ? { qualityValues: parameterValues(input, 'quality').map(value => value.toLowerCase()) } : {}),
        source: text(source, 96),
        provider: text(provider, 64),
    };
    // Never copy arbitrary provider fields: this is the persistence boundary.
    for (const key of Object.keys(entry)) {
        if (SECRET_KEY.test(key)) delete entry[key];
    }
    // Keep explicit capability hints that the classifier understands.
    if (Object.hasOwn(capabilities, 'image_generation') && typeof capabilities.image_generation === 'boolean') entry.imageGeneration = capabilities.image_generation;
    return entry;
}

/**
 * Normalize a provider response while retaining every valid model entry.
 * `imageOnly` is reserved for a provider endpoint whose contract guarantees
 * image models, not for generic model-list discovery.
 */
export function normalizeModelCatalog(payload, options = {}) {
    const values = modelList(payload);
    if (!values) return { shape: null, entries: [], modelIds: [] };
    const { imageOnly = false, excludeVideo = false, source, provider } = options;
    const entries = [];
    const seen = new Set();
    for (const item of values) {
        const id = rawModelId(item);
        if (!id || seen.has(id.toLowerCase())) continue;
        const metadata = boundedEntry(item, { source, provider, forceImage: imageOnly });
        if (!metadata) continue;
        if (imageOnly && !imageDeclared(item)) continue;
        if (excludeVideo && metadata.mediaKind === 'video') continue;
        if (seen.has(metadata.modelId.toLowerCase())) continue;
        seen.add(metadata.modelId.toLowerCase());
        entries.push(metadata);
        if (entries.length >= MAX_MODELS) break;
    }
    const shape = Array.isArray(payload) ? 'pollinations' : Array.isArray(payload?.models) ? 'gemini' : 'openai';
    return { shape, entries, modelIds: entries.map(entry => entry.modelId) };
}

export const MODEL_CATALOG_LIMIT = MAX_MODELS;
