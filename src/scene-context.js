// @ts-check
/**
 * Scene context resolver.
 *
 * Builds one deterministic, immutable snapshot of the entities present in a
 * selected message. The resolver is local: it performs strict explicit-alias
 * matching only and never calls an LLM. Display names remain labels unless they
 * are also listed as aliases.
 */

import { hashMessage } from './generation-drafts.js';

/**
 * @typedef {object} SceneEntity
 * @property {string} id
 * @property {string} name
 * @property {string[]} aliases
 * @property {string} description
 * @property {string} imagePath
 * @property {'image'|'description'} bindingMode
 */

/**
 * Escape a string for use inside a RegExp.
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize a scene matching phrase so that internal whitespace matches any
 * whitespace run and regex-special characters are escaped.
 * @param {string} phrase
 * @returns {string}
 */
function normalizePhrase(phrase) {
    const parts = String(phrase || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '';
    return parts.map(escapeRegex).join('\\s+');
}

/**
 * Test whether a phrase (full canonical name or explicit alias) appears in text
 * as a whole Unicode alphanumeric token.
 *
 * @param {string} phrase
 * @param {string} text
 * @returns {boolean}
 */
export function matchesScenePhrase(phrase, text) {
    const normalized = normalizePhrase(phrase);
    if (!normalized) return false;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${normalized}(?![\\p{L}\\p{N}])`, 'giu');
    return re.test(String(text || ''));
}

/**
 * Normalize a reference record or character/persona descriptor into a SceneEntity.
 *
 * @param {object} record
 * @returns {SceneEntity}
 */
export function normalizeSceneEntity(record) {
    const name = String(record.name || '').trim();
    const aliases = normalizeAliases(record.aliases);
    return {
        id: String(record.id || ''),
        name,
        aliases,
        description: String(record.description || ''),
        imagePath: String(record.imagePath || ''),
        ...(record.bindingMode === 'description' ? { bindingMode: 'description' } : {}),
    };
}

/**
 * Normalize aliases from an array or comma/newline-separated value.
 *
 * @param {string|string[]|null|undefined} value
 * @returns {string[]}
 */
export function normalizeAliases(value) {
    if (Array.isArray(value)) {
        return value
            .map(s => String(s ?? '').trim())
            .filter(Boolean)
            .filter((v, i, a) => a.indexOf(v) === i);
    }
    if (value == null || String(value).trim() === '') return [];
    return String(value)
        .split(/[,\n]/)
        .map(s => s.trim())
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i);
}

/**
 * Detect mentions of an entity in scene text using aliases only.
 * Returns an array of matched phrases (one per matching phrase, not per occurrence).
 *
 * @param {SceneEntity} entity
 * @param {string} text
 * @returns {string[]}
 */
export function detectEntityMentions(entity, text) {
    const phrases = [entity.name, ...entity.aliases].filter(Boolean);
    const matched = new Set();
    for (const phrase of phrases) {
        if (matchesScenePhrase(phrase, text)) {
            matched.add(phrase);
        }
    }
    return Array.from(matched);
}

/**
 * @typedef {object} SceneContextSnapshot
 * @property {string} chatId
 * @property {number} msgId
 * @property {string} messageHash
 * @property {number} contextRevision
 * @property {SceneEntity[]} entities
 * @property {Array<{id:string,name:string,description:string}>} stage1Descriptions
 * @property {Array<{id:string,name:string,imagePath:string,description:string,bindingMode:'image'|'description',matchedLabel:string}>} stage2Refs
 * @property {Array<{mention:string,candidateIds:string[]}>} ambiguities
 * @property {Array<{id:string,name:string,matchedPhrases:string[],effective:boolean}>} matchedReferences
 */

/**
 * @typedef {object} BuildSceneContextInput
 * @property {string} chatId
 * @property {number} msgId
 * @property {string} messageText
 * @property {number} contextRevision
 * @property {SceneEntity[]} candidates
 * @property {{includedIds:string[],excludedIds:string[],revision:number}} corrections
 */

/**
 * Recursively freeze arrays and plain objects.
 * @param {any} value
 * @returns {any}
 */
function deepFreeze(value) {
    if (value == null) return value;
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) deepFreeze(value[i]);
    } else if (Object.getPrototypeOf(value) === Object.prototype) {
        for (const key of Object.keys(value)) deepFreeze(value[key]);
    } else {
        return value;
    }
    return Object.freeze(value);
}

/**
 * Shared entity resolver for scene text and prompt text.
 *
 * Detects aliases, applies corrections, resolves ambiguities,
 * and returns the ordered effective entities plus ambiguities.
 *
 * @param {object} input
 * @param {string} input.text
 * @param {SceneEntity[]} input.candidates
 * @param {{includedIds?:string[],excludedIds?:string[],revision?:number}} [input.corrections]
 * @returns {{entities:SceneEntity[],ambiguities:Array<{mention:string,candidateIds:string[]}>,matchedReferences:Array<{id:string,name:string,matchedPhrases:string[],effective:boolean}>}}
 */
function resolveEntitiesFromText({ text, candidates, corrections }) {
    const excluded = new Set((corrections?.excludedIds || []).map(String));
    const included = (corrections?.includedIds || []).map(String);
    const searchText = String(text || '');

    /** @type {Map<string, {entity:SceneEntity,index:number,phrase:string,matched:string}[]>} */
    const mentionGroups = new Map();
    /** @type {Map<string, number>} */
    const firstMentionIndex = new Map();
    /** @type {Map<string, {entity:SceneEntity,index:number,phrase:string,matched:string}[]>} */
    const matchedByEntity = new Map();

    for (const entity of candidates) {
        const phrases = entity.aliases.filter(Boolean);
        let entityFirstIndex = Infinity;
        for (const phrase of phrases) {
            const re = phraseRegex(phrase);
            const match = re.exec(searchText);
            if (match) {
                const index = match.index;
                const matched = match[0];
                entityFirstIndex = Math.min(entityFirstIndex, index);
                const detail = { entity, index, phrase, matched };
                const key = matched.toLocaleLowerCase();
                const group = mentionGroups.get(key) || [];
                group.push(detail);
                mentionGroups.set(key, group);
                const entityMatches = matchedByEntity.get(entity.id) || [];
                entityMatches.push(detail);
                matchedByEntity.set(entity.id, entityMatches);
            }
        }
        if (entityFirstIndex !== Infinity) {
            firstMentionIndex.set(entity.id, entityFirstIndex);
        }
    }

    /** @type {Set<string>} */
    const ambiguousIds = new Set();
    /** @type {Array<{mention:string,candidateIds:string[]}>} */
    const ambiguities = [];

    for (const [mention, group] of mentionGroups) {
        const effectiveIds = new Set();
        for (const { entity } of group) {
            if (!excluded.has(entity.id)) {
                effectiveIds.add(entity.id);
            }
        }
        if (effectiveIds.size > 1) {
            for (const id of effectiveIds) ambiguousIds.add(id);
            ambiguities.push({ mention, candidateIds: Array.from(effectiveIds) });
        }
    }

    /** @type {Map<string, SceneEntity>} */
    const effectiveById = new Map();

    // 1. Manual includes in supplied order, unless excluded.
    for (const id of included) {
        if (excluded.has(id)) continue;
        const entity = candidates.find(c => c.id === id);
        if (entity) effectiveById.set(id, entity);
    }

    // 2. Auto-detected entities, excluding ambiguous and excluded unless manually included.
    for (const entity of candidates) {
        if (effectiveById.has(entity.id)) continue;
        if (excluded.has(entity.id)) continue;
        if (ambiguousIds.has(entity.id) && !included.includes(entity.id)) continue;
        if (firstMentionIndex.has(entity.id)) {
            effectiveById.set(entity.id, entity);
        }
    }

    // Build ordered list: manual corrections first, then every auto-detected
    // entity by first mention.
    const orderedIds = orderEffectiveEntities(effectiveById, candidates, included, firstMentionIndex);
    const orderedEntities = orderedIds.map(id => effectiveById.get(id)).filter(Boolean);

    const matchedReferences = candidates
        .filter(entity => matchedByEntity.has(entity.id))
        .sort((a, b) => {
            const ai = firstMentionIndex.get(a.id) ?? Infinity;
            const bi = firstMentionIndex.get(b.id) ?? Infinity;
            if (ai !== bi) return ai - bi;
            return a.id.localeCompare(b.id);
        })
        .map(entity => ({
            id: entity.id,
            name: entity.name,
            matchedPhrases: Array.from(new Map(
                matchedByEntity.get(entity.id)
                    .sort((a, b) => a.index - b.index)
                    .map(detail => [detail.matched.toLocaleLowerCase(), detail.matched])
            ).values()),
            effective: effectiveById.has(entity.id),
        }));

    return { entities: orderedEntities, ambiguities, matchedReferences };
}

/**
 * Build one deterministic, immutable snapshot of the entities present in a
 * selected message. Applies corrections and resolves ambiguities.
 *
 * @param {BuildSceneContextInput} input
 * @returns {Promise<SceneContextSnapshot>}
 */
export async function buildSceneContextSnapshot(input) {
    const {
        chatId,
        msgId,
        messageText,
        contextRevision,
        candidates,
        corrections,
    } = input;

    const { entities: orderedEntities, ambiguities, matchedReferences } = resolveEntitiesFromText({
        text: messageText,
        candidates,
        corrections,
    });

    const stage1Descriptions = orderedEntities
        .filter(e => e.description && String(e.description).trim())
        .map(e => ({ id: e.id, name: e.name, description: String(e.description) }));

    const stage2Refs = orderedEntities
        .filter(e => e.bindingMode === 'description' ? (e.description && String(e.description).trim()) : (e.imagePath && String(e.imagePath).trim()))
        .map((e, index) => ({
            id: e.id,
            name: e.name,
            ...(e.bindingMode !== 'description' ? { imagePath: String(e.imagePath) } : {}),
            ...(e.bindingMode === 'description' ? { description: String(e.description || '') } : {}),
            ...(e.bindingMode === 'description' ? { bindingMode: 'description' } : {}),
            ...(e.bindingMode === 'description' ? { matchedLabel: matchedReferences.find(ref => ref.id === e.id)?.matchedPhrases?.[0] || e.name || `reference ${index + 1}` } : {}),
        }));

    /** @type {SceneContextSnapshot} */
    const snapshot = {
        chatId,
        msgId,
        messageHash: hashMessage(messageText),
        contextRevision,
        entities: orderedEntities,
        stage1Descriptions,
        stage2Refs,
        ambiguities,
        matchedReferences,
    };

    return deepFreeze(snapshot);
}

/**
 * Resolve the Stage 2 reference set from the current generation prompt.
 * Only entities whose explicit alias appears in the prompt are auto-detected.
 *
 * @param {object} input
 * @param {string} input.prompt
 * @param {SceneEntity[]} input.candidates
 * @param {{includedIds?:string[],excludedIds?:string[],revision?:number}} [input.corrections]
 * @returns {Promise<{promptHash:string,referencesRevision:number,entities:SceneEntity[],stage2Refs:Array<{id:string,name:string,imagePath:string}>,ambiguities:Array<{mention:string,candidateIds:string[]}>,matchedReferences:Array<{id:string,name:string,matchedPhrases:string[],effective:boolean}>}>}
 */
export async function resolvePromptReferenceContext({ prompt, candidates, corrections }) {
    const { entities: orderedEntities, ambiguities, matchedReferences } = resolveEntitiesFromText({
        text: prompt,
        candidates,
        corrections,
    });

    const stage2Refs = orderedEntities
        .filter(e => e.bindingMode === 'description' ? (e.description && String(e.description).trim()) : (e.imagePath && String(e.imagePath).trim()))
        .map((e, index) => ({
            id: e.id,
            name: e.name,
            ...(e.bindingMode !== 'description' ? { imagePath: String(e.imagePath) } : {}),
            ...(e.bindingMode === 'description' ? { description: String(e.description || '') } : {}),
            ...(e.bindingMode === 'description' ? { bindingMode: 'description' } : {}),
            ...(e.bindingMode === 'description' ? { matchedLabel: matchedReferences.find(ref => ref.id === e.id)?.matchedPhrases?.[0] || e.name || `reference ${index + 1}` } : {}),
        }));

    return deepFreeze({
        promptHash: hashMessage(prompt),
        referencesRevision: corrections?.revision ?? 0,
        entities: orderedEntities,
        stage2Refs,
        ambiguities,
        matchedReferences,
    });
}

/**
 * @param {string} phrase
 * @returns {RegExp}
 */
function phraseRegex(phrase) {
    const parts = String(phrase || '').trim().split(/\s+/).filter(Boolean);
    const normalized = parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    return new RegExp(`(?<![\\p{L}\\p{N}])${normalized}(?![\\p{L}\\p{N}])`, 'giu');
}

/**
 * @param {Map<string, SceneEntity>} effectiveById
 * @param {SceneEntity[]} candidates
 * @param {string[]} included
 * @param {Map<string, number>} firstMentionIndex
 * @returns {string[]}
 */
function orderEffectiveEntities(effectiveById, candidates, included, firstMentionIndex) {
    const manual = included.filter(id => effectiveById.has(id));
    const manualSet = new Set(manual);

    const autoDetected = candidates
        .filter(c => effectiveById.has(c.id) && !manualSet.has(c.id))
        .sort((a, b) => {
            const ai = firstMentionIndex.get(a.id) ?? Infinity;
            const bi = firstMentionIndex.get(b.id) ?? Infinity;
            if (ai !== bi) return ai - bi;
            return a.id.localeCompare(b.id);
        });

    return [...manual, ...autoDetected.map(entity => entity.id)];
}
