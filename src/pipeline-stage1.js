// @ts-check
/**
 * Scene-first Stage 1: builds a prompt from a chat message via scene-context snapshot.
 * Extracted from pipeline.js (see docs/archive/specs/2026-07-18-remove-descrefs-and-split-pipeline-design.md).
 *
 * runFullPipelineForDraft orchestrates Stage 1 + Stage 2; it lives here
 * (entry point is Stage 1) and imports Stage 2 to avoid circular dependencies.
 */
import { state, fnv1aHex, getCtx } from './core.js';
import { buildStage1ContextParts } from './stage1-context.js';
import { recordDiagnosticEvent, hashDiagnosticId } from './diagnostic-events.js';
import { generatePromptText } from './text-api.js';
import { getTemplate } from './prompt-templates.js';
import {
    getGenerationDraft,
    updateGenerationDraft,
    startStage1Run,
    applyStage1Result,
    resolveDraftTemplateId,
} from './generation-drafts.js';
import { buildSceneContextSnapshot } from './scene-context.js';
import { executeStage1 } from './template-runtime.js';
import { createChatConfigSnapshot, buildCandidates } from './pipeline-config.js';
import { playStageSound } from './notify.js';
import { runStage2ForDraft } from './pipeline-stage2.js';

// Automatic callbacks are keyed by immutable source identity so duplicate
// SillyTavern completion events cannot create duplicate paid generations.
const autoFlights = new Map();

// ── Scene-first Stage 1 API ──

/**
 * Fire a Stage 1 lifecycle event for the UI (per-request Stop button toggle,
 * queue "skip current"). Guarded so the pipeline stays testable in node (no
 * window); in the browser the Generate tab / queue status listen for it.
 * @param {string} type
 * @param {object} detail
 */
function emitStage1Event(type, detail) {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try { window.dispatchEvent(new CustomEvent(type, { detail })); } catch { /* ignore */ }
    }
}

/**
 * Resolve a template record for a draft.
 *
 * @param {string|null} templateId
 * @returns {Promise<any|null>}
 */
async function resolveTemplateForDraft(templateId) {
    if (!templateId) return null;
    return await getTemplate(templateId);
}

/**
 * Fingerprint of an AUTO run's identity inputs: scene text + effective
 * template + image route/params. Stored on the draft (autoPromptFp /
 * autoDoneFp) so repeat automation for unchanged content+settings is free.
 * Manual and queue runs never compute or match it.
 */
function computeAutoFp({ messageText, templateId, configSnapshot }) {
    const d = configSnapshot?.generationDefaults || {};
    return fnv1aHex([
        String(messageText || ''),
        templateId || 'base',
        configSnapshot?.imageProfileId || '',
        d.modelId || '',
        d.aspectRatio || '',
        d.imageSize || '',
        d.quality || '',
    ].join('|'));
}

/**
 * Run Stage 1 for an explicit message draft. Captures identity once, builds one
 * shared snapshot, executes the template runtime, and applies the result only
 * if the run token and prompt revision still match.
 *
 * `input.templateId` is an operation-level override. When it is null the
 * pipeline resolves the effective template from the draft (override) or falls
 * back to `state.activeTemplateId` (default).
 *
 * @param {{chatId:string,msgId:number,messageText:string,templateId:string|null,chatConfig?:object}} input
 * @param {(status:string) => void} [onStatus]
 * @param {AbortSignal} [signal]
 * @param {object} [opts]
 * @param {boolean} [opts.isAuto] - true for the auto full-pipeline flow (event source tag).
 * @returns {Promise<{applied:boolean, reason:null|'superseded'|'prompt-edited', result:object|null, snapshot:import('./scene-context.js').SceneContextSnapshot|null, draft:object}>}
 */
export async function runStage1ForDraft(input, onStatus = () => {}, signal, opts = {}) {
    const { chatId, msgId, messageText, templateId, chatConfig } = input;
    const startedAt = performance.now();
    const stage1RequestId = crypto.randomUUID();
    recordDiagnosticEvent({ requestId: stage1RequestId, event: 'stage1-start', stage: 'stage1', chatHash: hashDiagnosticId(chatId), msgId, details: { source: state.settings.apiSource || null } });

    // Every Stage 1 owns a controller registered in activeGenerations, so it is
    // individually cancellable via abortGeneration(requestId) — manual and auto
    // alike. An external (queue) signal is linked to it so stopQueue still
    // cascades, while a per-request cancel stops only this run.
    const ownController = new AbortController();
    if (signal) {
        if (signal.aborted) ownController.abort();
        else signal.addEventListener('abort', () => ownController.abort(), { once: true });
    }
    const useSignal = ownController.signal;
    state.activeGenerations.set(stage1RequestId, ownController);
    emitStage1Event('uris:stage1-start', {
        requestId: stage1RequestId, chatId, msgId,
        source: opts.isAuto ? 'auto' : (signal ? 'queue' : 'manual'),
    });

    try {
        return await runStage1Inner();
    } finally {
        state.activeGenerations.delete(stage1RequestId);
        recordDiagnosticEvent({ event: 'stage1-end', stage: 'stage1', requestId: stage1RequestId, msgId });
        emitStage1Event('uris:stage1-end', { requestId: stage1RequestId, chatId, msgId });
    }

    async function runStage1Inner() {
        const throwIfAborted = () => { if (useSignal.aborted) throw new DOMException('Aborted', 'AbortError'); };
        throwIfAborted();
        // Capture the chat-scoped generation snapshot at Stage 1 start so the
        // default template used for this run cannot be replaced by a later chat switch.
        const configSnapshot = chatConfig || createChatConfigSnapshot();

        const draft = await getGenerationDraft(chatId, msgId, messageText);
        throwIfAborted();

        // Operation-level id (from manual/queue snapshots) wins; otherwise resolve
        // from the draft/default so automatic payloads with null follow the active template.
        // When an explicit chat config snapshot is present, default drafts use the
        // snapshot's templateId instead of mutable runtime state.
        const effectiveTemplateId = templateId != null
            ? templateId
            : resolveDraftTemplateId(draft, configSnapshot.templateId ?? state.activeTemplateId);

        // Auto fingerprint skip: identical scene text + identical generation
        // settings already built this prompt (repeat event, swipe back) — no
        // second LLM call. Manual and queue runs never skip.
        const autoFp = opts.isAuto ? computeAutoFp({ messageText, templateId: effectiveTemplateId, configSnapshot }) : null;
        if (autoFp && draft.autoPromptFp === autoFp && String(draft.prompt || '').trim()) {
            recordDiagnosticEvent({
                event: 'stage1-result', stage: 'stage1', requestId: stage1RequestId,
                chatHash: hashDiagnosticId(chatId), msgId, outcome: 'auto-fingerprint-match',
                durationMs: performance.now() - startedAt,
            });
            return { requestId: stage1RequestId, applied: false, reason: 'auto-fingerprint-match', result: null, snapshot: null, draft };
        }

        const candidates = await buildCandidates(chatId);
        throwIfAborted();
        const snapshot = await buildSceneContextSnapshot({
            chatId,
            msgId,
            messageText,
            contextRevision: draft.references?.revision || 0,
            candidates,
            corrections: draft.references || { includedIds: [], excludedIds: [], revision: 0 },
        });

        const template = await resolveTemplateForDraft(effectiveTemplateId);
        throwIfAborted();

        // Опциональный контекст Stage 1 (персона/карточка/лорбук/история):
        // тумблеры выключены по умолчанию — с пустым списком поведение прежнее.
        throwIfAborted();
        const contextParts = await buildStage1ContextParts(getCtx(), { msgId });

        let runToken = null;
        let runPromptRevision = null;
        try {
            ({ token: runToken, promptRevision: runPromptRevision } = await startStage1Run(draft, messageText));
            const result = await executeStage1({
                template,
                messageText,
                snapshot,
                generateText: (system, user, sig, status) => generatePromptText(system, user, status, sig, stage1RequestId, contextParts),
                signal: useSignal,
                onStatus,
            });
            if (useSignal.aborted) throw new DOMException('Aborted', 'AbortError');

            const apply = await applyStage1Result(draft, runToken, runPromptRevision, result, messageText, snapshot);
            // Success-only notification (superseded runs stay silent — the
            // newer run will notify). Cancel/error paths below never ring.
            if (apply.applied) playStageSound('stage1');
            if (apply.applied && autoFp) {
                try {
                    // Bookkeeping only: a failed write must not fail the run.
                    await updateGenerationDraft(chatId, msgId, messageText, d => ({ ...d, autoPromptFp: autoFp }));
                } catch { /* ignore */ }
            }
            recordDiagnosticEvent({
                event: 'stage1-result', stage: 'stage1', requestId: stage1RequestId, chatHash: hashDiagnosticId(chatId), msgId,
                outcome: apply.applied ? 'applied' : apply.reason || 'superseded',
                durationMs: performance.now() - startedAt,
                details: {
                    resultChars: typeof result === 'string' ? result.length : null,
                    templateId: effectiveTemplateId || null,
                    // Which pool references the resolver matched against the source
                    // post — the Stage 1 context block sent to the text LLM.
                    matchedReferences: Array.isArray(snapshot?.matchedReferences)
                        ? snapshot.matchedReferences.map(ref => ({
                            name: ref?.name || null,
                            matchedPhrases: Array.isArray(ref?.matchedPhrases) ? ref.matchedPhrases.slice(0, 8) : [],
                            effective: ref?.effective !== false,
                        }))
                        : [],
                    effectiveReferences: Array.isArray(snapshot?.entities) ? snapshot.entities.length : null,
                },
            });
            return {
                requestId: stage1RequestId,
                applied: apply.applied,
                reason: apply.reason,
                result,
                snapshot,
                draft: apply.draft,
            };
        } catch (e) {
            // Persist error/cancelled state without overwriting manual prompt.
            const isCancelled = useSignal?.aborted || e?.name === 'AbortError';
            recordDiagnosticEvent({
                event: isCancelled ? 'stage1-cancel' : 'stage1-error',
                level: isCancelled ? 'log' : 'error', stage: 'stage1', requestId: stage1RequestId, chatHash: hashDiagnosticId(chatId), msgId,
                outcome: isCancelled ? 'cancelled' : 'error',
                durationMs: performance.now() - startedAt,
                details: { errorCode: e?.code || null, httpStatus: e?.httpStatus || null },
            });
            await updateGenerationDraft(chatId, msgId, messageText, current => {
                if (runToken == null || (current.stage1?.runToken && current.stage1.runToken !== runToken)) return current;
                return {
                    ...current,
                    stage1: {
                        ...current.stage1,
                        status: isCancelled ? 'cancelled' : 'error',
                        error: isCancelled ? null : e.message,
                        runToken,
                        runPromptRevision,
                    },
                };
            });
            throw e;
        }
    }
}

/**
 * Run the full scene-first pipeline (Stage 1 + Stage 2) for an explicit message.
 *
 * @param {{chatId:string,msgId:number,messageText:string,templateId:string|null,chatConfig?:object}} input
 * @param {(status:string) => void} [onStatus]
 * @param {AbortSignal} [signal]
 * @returns {Promise<object|null>}
 */
export async function runFullPipelineForDraft(input, onStatus = () => {}, signal) {
    const chatConfig = input.chatConfig || createChatConfigSnapshot();
    const runInput = { ...input, chatConfig };
    const flightKey = `${input.chatId}:${input.msgId}:${fnv1aHex(input.messageText)}`;
    const existing = autoFlights.get(flightKey);
    if (existing) return await raceFlightWithSignal(existing, signal);
    const flight = (async () => {
        // Auto fingerprint: identical content+settings that already produced a
        // card are free; a built-but-unimaged prompt jumps straight to Stage 2.
        const fpDraft = await getGenerationDraft(input.chatId, input.msgId, input.messageText);
        const autoFp = computeAutoFp({
            messageText: input.messageText,
            templateId: input.templateId != null
                ? input.templateId
                : resolveDraftTemplateId(fpDraft, chatConfig.templateId ?? state.activeTemplateId),
            configSnapshot: chatConfig,
        });
        if (fpDraft.autoDoneFp === autoFp) {
            return { applied: false, reason: 'auto-fingerprint-match', result: null, snapshot: null, draft: fpDraft };
        }
        const run = await runStage1ForDraft(runInput, onStatus, signal, { isAuto: true });
        // Re-read the done-fingerprint between the paid stages: a parallel
        // trigger can complete the same run while this Stage 1 was in flight —
        // its Stage 2 already paid, this one must not run again.
        const settled = await getGenerationDraft(input.chatId, input.msgId, input.messageText);
        if (settled.autoDoneFp === autoFp) {
            return { applied: false, reason: 'auto-fingerprint-match', result: null, snapshot: null, draft: settled };
        }
        const promptReady = run.reason === 'auto-fingerprint-match'
            ? String(run.draft?.prompt || '').trim()
            : run.applied;
        if (!promptReady) return null;
        const card = await runStage2ForDraft(runInput, onStatus, signal, { isAuto: true });
        if (card) {
            try {
                await updateGenerationDraft(input.chatId, input.msgId, input.messageText, d => ({ ...d, autoDoneFp: autoFp }));
            } catch { /* bookkeeping only */ }
        }
        return card;
    })();
    autoFlights.set(flightKey, flight);
    try { return await flight; }
    finally { if (autoFlights.get(flightKey) === flight) autoFlights.delete(flightKey); }
}

/**
 * Присоединение к чужому полёту не наследует его сигнал: полёт выполняется с
 * сигналом первого вызывающего, и его отмена (Stop в его UI-контексте) раньше
 * завершала и «чужой» await при живом сигнале второго участника. Гонка против
 * СВОЕГО сигнала: собственный аборт отклоняет await этого вызывающего, но полёт
 * продолжается для владельца и остальных присоединившихся.
 */
function raceFlightWithSignal(flight, signal) {
    if (!signal) return flight;
    if (signal.aborted) return Promise.reject(new DOMException('Aborted by user', 'AbortError'));
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException('Aborted by user', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        flight.then(
            value => { signal.removeEventListener('abort', onAbort); resolve(value); },
            error => { signal.removeEventListener('abort', onAbort); reject(error); },
        );
    });
}

/** Шов для node-тестов: семантика присоединения к чужому полёту. */
export { raceFlightWithSignal as _raceFlightWithSignal };
