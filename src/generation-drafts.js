// @ts-check
/**
 * Message-scoped generation drafts.
 *
 * A generation draft is keyed by (chatId, msgId) so every chat message owns
 * exactly one editable draft. The record is immutable when read back via
 * `deepFreezeSnapshot` to prevent accidental mutation of stored snapshots.
 */

import { LF_GENERATION_DRAFT_PREFIX } from './core.js';
import { STUDIO_CHAT_ID } from './studio-scope.js';
import { serialize } from './serialize.js';

/**
 * Run `fn` serialized by draft key. Concurrent calls for the same key queue
 * behind each other; calls for different keys run independently.
 *
 * @param {string} chatId
 * @param {number} msgId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
function withDraftLock(chatId, msgId, fn) {
    return serialize(`draft:${generationDraftKey(chatId, msgId)}`, fn);
}

/**
 * @typedef {object} GenerationDraft
 * @property {string} chatId
 * @property {number} msgId
 * @property {string} messageHash
 * @property {'default'|'override'} templateSelection
 *   - 'default' means the draft follows `state.activeTemplateId` as its template source.
 *   - 'override' means `templateId` (which may be `null` for the base mode) is authoritative.
 * @property {string|null} templateId
 *   Authoritative only when `templateSelection === 'override'`. For default drafts this
 *   stays `null` even after Stage 1 produces a result with a concrete template id.
 * @property {string} prompt
 * @property {'empty'|'stage1'|'manual'} promptOrigin
 * @property {string} aspectRatio
 * @property {string} imageSize
 * @property {string} quality
 * @property {{includedIds:string[],excludedIds:string[],revision:number}} references
 * @property {'idle'|'running'|'ready'|'error'|'cancelled',structuredDraft:object|null,contextSnapshot:object|null,builtAt:string|null,error:string|null}} stage1
 * @property {{status:'idle'|'running'|'ready'|'error'|'cancelled',lastSubmittedSnapshot:object|null,error:string|null}} stage2
 * @property {string} [sceneText]
 *   Studio-only: the editable scene text the draft was built from. Chat drafts
 *   don't carry it — their source text lives in the chat and is hash-checked.
 * @property {string} [updatedAt]
 *   ISO timestamp of the last write. Feeds the retention sweep; drafts written
 *   before it existed have none and are never expired on age alone.
 */

/**
 * Compute a stable, lower-case hex digest from UTF-8 text.
 *
 * Формат зафиксирован: messageHash сохранённых черновиков сравнивается при
 * каждом чтении (loadDraftForStage2/getGenerationDraft), и любое изменение
 * алгоритма или ширины разойдётся со всеми черновиками — пользователь потеряет
 * построенные промпты Stage 1. Поэтому хэш НЕ перенесён на общее ядро
 * core.fnv1a32: та же схема FNV, но другое расширение (64-битная пара, где
 * старшая половина — детерминированная функция младшей, т.е. 32 бита
 * энтропии) и float-умножение вместо Math.imul в цикле. Честное описание
 * вместо прежнего «lower collision chance»: энтропия здесь 32 бита, форма —
 * исторический контракт хранения.
 * @param {string} messageText
 * @returns {string}
 */
export function hashMessage(messageText) {
    const text = String(messageText == null ? '' : messageText);
    const bytes = new TextEncoder().encode(text);
    let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = (h * 0x01000193) >>> 0;
    }
    // Расширение до 16 hex-разрядов детерминировано из 32-битного состояния.
    const lo = h >>> 0;
    const hi = Math.imul(h, 0x9e3779b9) >>> 0;
    return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/**
 * Build the localforage storage key for a generation draft.
 *
 * @param {string} chatId
 * @param {number} msgId
 * @returns {string}
 */
export function generationDraftKey(chatId, msgId) {
    if (chatId == null || chatId === '') {
        throw new Error('chatId is required');
    }
    if (!Number.isInteger(msgId) || msgId < 0) {
        throw new Error('msgId must be a non-negative integer');
    }
    return `${LF_GENERATION_DRAFT_PREFIX}${encodeURIComponent(chatId)}:${msgId}`;
}

/**
 * Create a fresh generation draft with all defaults.
 *
 * @param {string} chatId
 * @param {number} msgId
 * @param {string} messageText
 * @returns {GenerationDraft}
 */
export function createGenerationDraft(chatId, msgId, messageText) {
    // Validate identity before building anything.
    generationDraftKey(chatId, msgId);

    return {
        chatId,
        msgId,
        messageHash: hashMessage(messageText),
        templateSelection: 'default',
        templateId: null,
        prompt: '',
        promptOrigin: 'empty',
        promptRevision: 0,
        // Auto-run fingerprints (events-driven automation): the content+settings
        // hash of the last successful auto Stage 1 prompt build / full pipeline.
        autoPromptFp: null,
        autoDoneFp: null,
        aspectRatio: '1:1',
        imageSize: '1K',
        quality: 'auto',
        references: { includedIds: [], excludedIds: [], revision: 0 },
        stage1: {
            status: 'idle',
            structuredDraft: null,
            contextSnapshot: null,
            builtAt: null,
            error: null,
            runToken: 0,
            runPromptRevision: 0,
        },
        stage2: {
            status: 'idle',
            lastSubmittedSnapshot: null,
            error: null,
        },
    };
}

/**
 * Normalize the template selection mode on a current draft copy.
 *
 * @param {Partial<GenerationDraft>} draft
 * @returns {Partial<GenerationDraft>}
 */
export function normalizeTemplateSelection(draft) {
    if (draft?.templateSelection === 'override' || draft?.templateSelection === 'default') {
        return { ...draft };
    }
    return { ...draft, templateSelection: 'default', templateId: null };
}

/**
 * Resolve the effective template id for a draft.
 *
 * `activeTemplateId` is the generation default from the chat's schema-v5 config.
 * It is only used when the draft itself does not have an explicit override.
 *
 * @param {Partial<GenerationDraft>} draft
 * @param {string|null} activeTemplateId
 * @returns {string|null}
 */
export function resolveDraftTemplateId(draft, activeTemplateId) {
    const normalized = normalizeTemplateSelection(draft || {});
    return normalized.templateSelection === 'override'
        ? (normalized.templateId ?? null)
        : (activeTemplateId ?? null);
}

/**
 * Load the existing generation draft for a message or create and persist the default.
 * If the source message hash changed, discard the stale draft and start fresh.
 *
 * @param {string} chatId
 * @param {number} msgId
 * @param {string} messageText
 * @returns {Promise<GenerationDraft>}
 */
export async function getGenerationDraft(chatId, msgId, messageText) {
    const key = generationDraftKey(chatId, msgId);
    const lf = SillyTavern.libs.localforage;
    const existing = await lf.getItem(key);
    const hasCurrentTemplateSelection = existing?.templateSelection === 'default'
        || existing?.templateSelection === 'override';
    // The studio's scene text is an editable input, not an immutable source
    // message: a changed text must not discard the draft — the built prompt is
    // the source of truth, and the current text itself lives in draft.sceneText.
    const textStable = chatId === STUDIO_CHAT_ID
        || (existing && existing.messageHash === hashMessage(messageText));
    if (existing && textStable && hasCurrentTemplateSelection) {
        return deepFreezeSnapshot(withLiveParams(chatId, msgId, messageText, existing));
    }
    const draft = createGenerationDraft(chatId, msgId, messageText);
    if (!existing || hasCurrentTemplateSelection) {
        await lf.setItem(key, draft);
    }
    return deepFreezeSnapshot(withLiveParams(chatId, msgId, messageText, draft));
}

/**
 * Update a message-scoped generation draft with a pure updater function.
 * Reloads the current message draft, applies the updater, validates identity,
 * persists it, and returns the saved draft.
 *
 * @param {string} chatId
 * @param {number} msgId
 * @param {string} messageText
 * @param {(draft: GenerationDraft) => GenerationDraft} updater
 * @returns {Promise<GenerationDraft>}
 */
export async function updateGenerationDraft(chatId, msgId, messageText, updater) {
    return withDraftLock(chatId, msgId, async () => {
        const draft = await getGenerationDraft(chatId, msgId, messageText);
        const updated = updater(draft);
        if (updated.chatId !== chatId) {
            throw new Error('chatId cannot be changed');
        }
        if (updated.msgId !== msgId) {
            throw new Error('msgId cannot be changed');
        }
        if (updated.prompt !== draft.prompt) {
            updated.promptRevision = (draft.promptRevision || 0) + 1;
        }
        await saveGenerationDraft(updated);
        return deepFreezeSnapshot(updated);
    });
}

/**
 * Mark Stage 1 as started for a draft. Reloads the current draft, increments
 * the run token, and records the prompt revision at the time of the start.
 * Returns the captured token and prompt revision needed to apply a result later.
 *
 * @param {GenerationDraft} draft
 * @param {string} messageText
 * @returns {Promise<{draft:GenerationDraft, token:number, promptRevision:number}>}
 */
export async function startStage1Run(draft, messageText) {
    return withDraftLock(draft.chatId, draft.msgId, async () => {
        const current = await getGenerationDraft(draft.chatId, draft.msgId, messageText);
        const updated = {
            ...current,
            stage1: {
                ...current.stage1,
                status: 'running',
                runToken: (current.stage1?.runToken || 0) + 1,
                runPromptRevision: current.promptRevision || 0,
                error: null,
            },
        };
        await saveGenerationDraft(updated);
        return {
            draft: deepFreezeSnapshot(updated),
            token: updated.stage1.runToken,
            promptRevision: updated.stage1.runPromptRevision,
        };
    });
}

/**
 * Apply a Stage 1 result to a draft only if the run token and prompt revision
 * still match the captured values. Returns whether the result was applied and
 * the current draft.
 *
 * @param {GenerationDraft} draft
 * @param {number} token
 * @param {number} promptRevision
 * @param {object} result
 * @param {string} messageText
 * @param {import('./scene-context.js').SceneContextSnapshot|null} [contextSnapshot]
 * @returns {Promise<{applied:boolean, reason:null|'superseded'|'prompt-edited', draft:GenerationDraft}>}
 */
export async function applyStage1Result(draft, token, promptRevision, result, messageText, contextSnapshot = null) {
    // Same lock as updateGenerationDraft/startStage1Run: this is a
    // read-check-write against the live draft, and an unlocked concurrent user
    // edit (prompt/reference correction) could be clobbered by the result
    // application landing after it.
    return withDraftLock(draft.chatId, draft.msgId, async () => {
        const current = await getGenerationDraft(draft.chatId, draft.msgId, messageText);
        if ((current.stage1?.runToken || 0) !== token) {
            return { applied: false, reason: 'superseded', draft: current };
        }
        if ((current.promptRevision || 0) !== promptRevision) {
            return { applied: false, reason: 'prompt-edited', draft: current };
        }
        // Preserve the draft's template selection mode: only override drafts keep
        // an explicit templateId; default drafts stay defaulted to the active template.
        const selection = current.templateSelection === 'override' ? 'override' : 'default';
        const updated = {
            ...current,
            templateSelection: selection,
            templateId: selection === 'override'
                ? (result.templateId ?? current.templateId)
                : current.templateId,
            prompt: result.prompt ?? current.prompt,
            promptOrigin: result.prompt ? 'stage1' : current.promptOrigin,
            stage1: {
                ...current.stage1,
                status: 'ready',
                structuredDraft: result.structuredDraft ?? null,
                contextSnapshot,
                builtAt: new Date().toISOString(),
                error: null,
                runToken: token,
                runPromptRevision: promptRevision,
            },
        };
        await saveGenerationDraft(updated);
        return { applied: true, reason: null, draft: deepFreezeSnapshot(updated) };
    });
}

/**
 * Build an immutable Stage 2 submission snapshot from the current draft,
 * shared context snapshot, and materialized references.
 *
 * @param {{draft:GenerationDraft, contextSnapshot:import('./core.js').SceneContextSnapshot, refs:Array<import('./core.js').Stage2Reference>, prompt?:string, effectivePrompt?:string, now?:()=>string}} input
 * @returns {import('./core.js').Stage2Snapshot}
 */
export function createStage2Snapshot({ draft, contextSnapshot, refs, effectivePrompt, now = () => new Date().toISOString() }) {
    /** @type {import('./core.js').Stage2Snapshot} */
    const snapshot = {
        sourceMsgId: draft.msgId,
        messageHash: draft.messageHash,
        prompt: draft.prompt,
        ...(effectivePrompt && effectivePrompt !== draft.prompt ? { effectivePrompt } : {}),
        aspectRatio: draft.aspectRatio,
        imageSize: draft.imageSize,
        quality: draft.quality,
        refs: refs.map(r => ({
            id: r.id,
            name: r.name,
            ...(r.label ? { label: r.label } : {}),
            ...(r.description ? { description: r.description } : {}),
            ...(r.bindingMode === 'description' ? { bindingMode: r.bindingMode } : {}),
            ...(r.dataUrl ? { dataUrl: r.dataUrl } : {}),
            ...(r.url ? { url: r.url } : {}),
        })),
        templateId: draft.templateId,
        contextRevision: contextSnapshot.contextRevision,
        submittedAt: now(),
    };
    return deepFreezeSnapshot(snapshot);
}


// ── Живой оверлей параметров (пункт 1.1 плана 2026-10-05) ──────────────────
//
// Изменение селектов (Стороны/Размер/Quality) доезжает до черновика
// асинхронно: сначала chat-конфиг на сервер (сетевой раунд-трип в
// saveGenerationDefault), затем черновик в localforage. В этом окне любой
// перерендер (смена активной карточки на «API», автосейв Stage 1) читал
// старую запись — селекты «слетали», платные прогоны уходили с чужими
// параметрами. Оверлей хранит последнее значение, ВИДЕННОЕ В UI:
// getGenerationDraft вмерживает его в возвращаемый черновик, а рендер в
// tab-generate отдаёт ему приоритет над перечитанным chat-конфигом. Поля
// стираются после успешной персистенции того же значения — когда диск
// догнал UI, оверлей больше не нужен. Быстрое следующее изменение
// перезаписывает поле оверлея и потому не теряется при очистке.

const LIVE_PARAM_FIELDS = ['aspectRatio', 'imageSize', 'quality'];
const liveParamsOverlay = new Map();

/**
 * Запомнить параметры, выставленные пользователем в UI, синхронно ДО любой
 * асинхронной записи. Вызывается из обработчика change в tab-generate.js.
 *
 * @param {string} chatId
 * @param {number} msgId
 * @param {string} messageText
 * @param {{aspectRatio?: string, imageSize?: string, quality?: string}} params
 */
export function noteLiveGenerationParams(chatId, msgId, messageText, params) {
    const key = generationDraftKey(chatId, msgId);
    const next = { ...liveParamsOverlay.get(key) };
    for (const field of LIVE_PARAM_FIELDS) {
        if (params && typeof params[field] === 'string' && params[field]) next[field] = params[field];
    }
    // Хэш-гейт не даёт значения утечь на пересозданный черновик другого поста
    // с тем же (chat, msgId); текст студии редактируемый и не хэшируется — там
    // черновик к тексту не привязан.
    next.messageHash = chatId === STUDIO_CHAT_ID ? null : hashMessage(messageText);
    liveParamsOverlay.set(key, next);
}

function liveParamsFor(chatId, msgId, messageText) {
    const overlay = liveParamsOverlay.get(generationDraftKey(chatId, msgId));
    if (!overlay) return null;
    if (chatId !== STUDIO_CHAT_ID && overlay.messageHash !== hashMessage(messageText)) return null;
    const params = {};
    for (const field of LIVE_PARAM_FIELDS) {
        if (typeof overlay[field] === 'string' && overlay[field]) params[field] = overlay[field];
    }
    return Object.keys(params).length ? params : null;
}

/** Последние параметры, виденные в UI и ещё не догнавшие диск (для рендера). */
export function getLiveGenerationParams(chatId, msgId, messageText) {
    return liveParamsFor(chatId, msgId, messageText);
}

function withLiveParams(chatId, msgId, messageText, draft) {
    const params = liveParamsFor(chatId, msgId, messageText);
    return params ? { ...draft, ...params } : draft;
}

/**
 * Persist a generation draft. Rejects invalid identities.
 *
 * @param {GenerationDraft} draft
 * @returns {Promise<void>}
 */
export async function saveGenerationDraft(draft) {
    const key = generationDraftKey(draft.chatId, draft.msgId);
    const serialized = serializeGenerationDraft(draft);
    // Stamp every write so the retention sweep can tell a live draft from one
    // abandoned months ago. Readers compare the stored object by identity-stable
    // fields only, so an extra timestamp never invalidates a draft.
    serialized.updatedAt = new Date().toISOString();
    await SillyTavern.libs.localforage.setItem(key, serialized);
    // Параметры, доехавшие до диск, из оверлея стираются; более свежие
    // (быстрое следующее изменение) остаются — очистка только по совпадению.
    const overlay = liveParamsOverlay.get(key);
    if (overlay) {
        for (const field of LIVE_PARAM_FIELDS) {
            if (overlay[field] !== undefined && serialized[field] === overlay[field]) delete overlay[field];
        }
        if (LIVE_PARAM_FIELDS.every(field => overlay[field] === undefined)) {
            liveParamsOverlay.delete(key);
        }
    }
}

// A draft is written for every post the Generation tab is opened on, and
// nothing used to remove one. Two bounds keep IndexedDB from growing without
// limit: a draft untouched for this long is forgotten, and a single chat keeps
// at most this many of its most recently touched drafts.
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DRAFTS_PER_CHAT = 100;

/**
 * Best-effort "last touched" instant for a draft. `updatedAt` is stamped on
 * every save; drafts persisted before that existed fall back to the Stage 1
 * build time. No timestamp at all means "unknown", and those are kept — expiry
 * must not wipe the whole store on the first run after the upgrade.
 *
 * @param {object} raw
 * @returns {number|null} epoch ms
 */
function draftTouchedAt(raw) {
    for (const candidate of [raw?.updatedAt, raw?.stage1?.builtAt]) {
        const ms = Date.parse(candidate || '');
        if (Number.isFinite(ms)) return ms;
    }
    return null;
}

/**
 * Reset every persisted draft whose Stage 1 or Stage 2 was left "running" when
 * the extension (or the page) was unloaded mid-generation. A "running" status
 * that survives a reload can never resolve on its own, so it is folded back to
 * "idle"; every other status (ready / error / cancelled) is preserved. Only
 * status and error are touched - refs, prompt and snapshots are left intact.
 *
 * The same pass enforces retention: drafts untouched for longer than
 * {@link DRAFT_TTL_MS} are removed, and each chat keeps at most `maxPerChat`
 * of its newest drafts. Both bounds are best-effort — a failed read or delete
 * skips that one key.
 *
 * @param {{now?: () => number, ttlMs?: number, maxPerChat?: number}} [options]
 * @returns {Promise<void>}
 */
export async function sweepStaleRunningDrafts({ now = Date.now, ttlMs = DRAFT_TTL_MS, maxPerChat = DRAFTS_PER_CHAT } = {}) {
    const lf = SillyTavern.libs.localforage;
    if (!lf?.keys) return;
    let keys;
    try { keys = await lf.keys(); } catch { return; }
    const nowMs = now();
    /** @type {Map<string, {key: string, touched: number}[]>} */
    const keptByChat = new Map();
    for (const key of keys) {
        if (typeof key !== 'string' || !key.startsWith(LF_GENERATION_DRAFT_PREFIX)) continue;
        let raw;
        try { raw = await lf.getItem(key); } catch { continue; }
        if (!raw) continue;
        const touched = draftTouchedAt(raw);
        if (touched !== null && Number.isFinite(nowMs) && nowMs - touched > ttlMs) {
            try { await lf.removeItem(key); } catch { /* ignore individual delete failures */ }
            continue;
        }
        let stage1 = raw.stage1;
        let stage2 = raw.stage2;
        let changed = false;
        if (stage1?.status === 'running') {
            stage1 = { ...stage1, status: 'idle', error: null };
            changed = true;
        }
        if (stage2?.status === 'running') {
            stage2 = { ...stage2, status: 'idle', error: null };
            changed = true;
        }
        if (changed) {
            // A reload-recovery rewrite is not a user edit: keep the original
            // timestamp so the retention clock keeps running from the last real
            // write instead of restarting on every page load.
            try { await lf.setItem(key, { ...raw, stage1, stage2 }); } catch { /* ignore individual write failures */ }
        }
        const chatId = typeof raw.chatId === 'string' ? raw.chatId : '';
        if (!chatId) continue;
        const bucket = keptByChat.get(chatId) || [];
        bucket.push({ key, touched: touched ?? Number.POSITIVE_INFINITY });
        keptByChat.set(chatId, bucket);
    }
    for (const bucket of keptByChat.values()) {
        if (bucket.length <= maxPerChat) continue;
        // Unknown-age drafts sort last, so a cap never evicts them ahead of
        // drafts whose age is actually known.
        bucket.sort((a, b) => b.touched - a.touched);
        for (const stale of bucket.slice(maxPerChat)) {
            try { await lf.removeItem(stale.key); } catch { /* ignore individual delete failures */ }
        }
    }
}

/**
 * Serialize the ordinary persisted draft without retaining reference payloads.
 * The in-flight Stage 2 snapshot passed to the server is never modified.
 *
 * @param {GenerationDraft} draft
 * @returns {GenerationDraft}
 */
export function serializeGenerationDraft(draft) {
    const serialized = { ...draft };
    if (draft.stage2) {
        serialized.stage2 = { ...draft.stage2 };
        const snapshot = draft.stage2.lastSubmittedSnapshot;
        if (snapshot) {
            serialized.stage2.lastSubmittedSnapshot = { ...snapshot };
            for (const key of ['refs', 'references']) {
                if (Array.isArray(snapshot[key])) {
                    serialized.stage2.lastSubmittedSnapshot[key] = snapshot[key].map(sanitizeReferenceValue);
                }
            }
        }
    }
    return serialized;
}

/**
 * Clone reference metadata while dropping payload-bearing fields at every depth.
 *
 * @param {any} value
 * @returns {any}
 */
function sanitizeReferenceValue(value) {
    if (Array.isArray(value)) return value.map(sanitizeReferenceValue);
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== 'dataUrl' && key !== 'base64')
        .map(([key, child]) => [key, sanitizeReferenceValue(child)]));
}

/**
 * Recursively freeze arrays and plain objects.
 *
 * @param {any} value
 * @returns {any}
 */
export function deepFreezeSnapshot(value) {
    if (value == null) return value;
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            deepFreezeSnapshot(value[i]);
        }
    } else if (isPlainObject(value)) {
        for (const key of Object.keys(value)) {
            deepFreezeSnapshot(value[key]);
        }
    } else {
        return value;
    }
    return Object.freeze(value);
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    return typeof value === 'object'
        && Object.getPrototypeOf(value) === Object.prototype;
}
