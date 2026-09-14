// @ts-check
/**
 * Stage 2: immutable submission snapshot + image provider invocation.
 * Extracted from pipeline.js (see docs/archive/specs/2026-07-18-remove-descrefs-and-split-pipeline-design.md).
 *
 * runStage2 — positional compatibility adapter, used by tab-gallery.js for
 * "regenerate". runStage2ForDraft is the primary scene-first entry point.
 */
import { state, getCtx, trace, warn } from './core.js';
import { recordDiagnosticEvent, hashDiagnosticId } from './diagnostic-events.js';
import { generateImageRequest } from './image-api.js';
import { observeCapabilityAttempt } from './capability-observer.js';
import {
    createStage2Snapshot,
    updateGenerationDraft,
    hashMessage,
    generationDraftKey,
    createGenerationDraft,
} from './generation-drafts.js';
import { resolvePromptReferenceContext } from './scene-context.js';
import { materializeStage2References, summarizeReference } from './references.js';
import { resolveChatConfigSnapshot, resolveActivePresets, buildCandidates } from './pipeline-config.js';
import { resolveConnection } from './connections.js';
import { recordReferenceEvidence } from './connection-evidence.js';
import { playStageSound } from './notify.js';
import { composeReferencePrompt } from './reference-binding.js';

/**
 * Fire a Stage 2 lifecycle event for the UI (per-request Stop button toggle,
 * queue "skip current"). Guarded so the pipeline stays testable in node (no
 * window); in the browser the Generate tab / queue status listen for it.
 * @param {string} type
 * @param {object} detail
 */
function emitStage2Event(type, detail) {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try { window.dispatchEvent(new CustomEvent(type, { detail })); } catch { /* ignore */ }
    }
}

// ── Stage 2: immutable submission snapshot ──

/**
 * Load a draft without resetting it, verifying the message hash matches.
 *
 * @param {string} chatId
 * @param {number} msgId
 * @param {string} messageText
 * @returns {Promise<import('./generation-drafts.js').GenerationDraft>}
 */
async function loadDraftForStage2(chatId, msgId, messageText) {
    const key = generationDraftKey(chatId, msgId);
    const raw = await SillyTavern.libs.localforage.getItem(key);
    const currentHash = hashMessage(messageText);
    if (raw && raw.messageHash !== currentHash) {
        throw new Error('Source message changed; rebuild the prompt');
    }
    return raw || createGenerationDraft(chatId, msgId, messageText);
}

/**
 * Run Stage 2 for an explicit message draft using an immutable submission snapshot.
 *
 * @param {{chatId:string,msgId:number,messageText:string,templateId:string|null}} input
 * @param {(status:string) => void} [onStatus]
 * @param {AbortSignal} [signal]
 * @param {object} [opts]
 * @param {object} [opts.instruction] - compatibility override for positional wrapper.
 * @param {Array<{image:string,name?:string}>} [opts.refs] - compatibility override for references.
 * @param {(refs: Array<{image:string,name?:string}>) => void} [opts.onRefsSent]
 * @param {boolean} [opts.isAuto]
 * @returns {Promise<object|null>}
 */
export async function runStage2ForDraft(input, onStatus = () => {}, signal, opts = {}) {
    const { chatId, msgId, messageText, templateId, chatConfig } = input;

    // Capture the chat-scoped generation snapshot so this Stage 2 cannot observe
    // a different chat's config after a chat switch.
    const snapshot = chatConfig || await resolveChatConfigSnapshot();

    // Every Stage 2 owns a controller registered in activeGenerations BEFORE any
    // waiting, so abortAllGenerations (ST Stop button, cleanup) also covers runs
    // queued in the per-post chain: a chained run used to become cancellable only
    // at its turn, so Stop or extension-disable could let it start afterwards and
    // fire a paid request. An external (queue) signal is linked so stopQueue still
    // cascades; a per-request cancel stops only this one.
    let activeRequestId = null;
    let useSignal = null;

    // Per-post FIFO serialization state for manual Stage 2 calls (auto flow
    // bypasses the chain). releaseNext/myNext/chainKey live at function scope:
    // the finally must release the chain even when the run is aborted pre-start.
    let releaseNext = null;
    let myNext = null;
    let chainKey = null;

    // True once the run passed the abort gate; pairs uris:stage2-end with a
    // start (a pre-start abort emits neither).
    let started = false;

    let imageConnId = null;
    let effectiveRoute = null;
    let effectiveConnection = null;
    let request = null;
    // The catch classifies the failure; the finally close-out needs it too, so
    // stage2-end can state how the run ended instead of leaving the outcome to
    // be inferred from the absence of stage2-result.
    let failure = null;
    let startedAt = 0;

    try {
        const ownController = new AbortController();
        if (signal) {
            if (signal.aborted) ownController.abort();
            else signal.addEventListener('abort', () => ownController.abort(), { once: true });
        }
        useSignal = ownController.signal;
        activeRequestId = crypto.randomUUID();
        state.activeGenerations.set(activeRequestId, ownController);
        // Already dead (Stop pressed / cleanup before this call ran) — do not
        // even queue into the chain.
        if (useSignal.aborted) throw new DOMException('Aborted', 'AbortError');

        // Per-post FIFO serialization for manual Stage 2 calls. The key includes
        // chatId: a bare msgId made a generation in one chat silently wait for an
        // in-flight generation of the same index in another chat.
        if (!opts.isAuto && msgId != null) {
            chainKey = `${chatId}:${msgId}`;
            const prevPromise = state.stage2Chains.get(chainKey) || Promise.resolve();
            myNext = new Promise(r => { releaseNext = r; });
            state.stage2Chains.set(chainKey, myNext);
            await prevPromise.catch(() => {});
        }
        if (useSignal.aborted) throw new DOMException('Aborted', 'AbortError');
        started = true;
        startedAt = Date.now();

        recordDiagnosticEvent({
            event: 'stage2-start', stage: 'stage2', requestId: activeRequestId,
            chatHash: hashDiagnosticId(chatId), msgId,
            operation: opts.instruction ? 'edit' : 'generate',
            details: { source: opts.isAuto ? 'auto' : (signal ? 'queue' : 'manual') },
        });
        try { opts.onStart?.(activeRequestId); } catch { /* listener error must not break generation */ }
        emitStage2Event('uris:stage2-start', {
            requestId: activeRequestId, msgId,
            source: opts.isAuto ? 'auto' : (signal ? 'queue' : 'manual'),
        });

        let draft = await loadDraftForStage2(chatId, msgId, messageText);
        if (useSignal.aborted) throw new DOMException('Aborted', 'AbortError');
        const generationDefaults = snapshot.generationDefaults || {};
        if (!opts.instruction && Object.values(generationDefaults).some(Boolean)) {
            draft = {
                ...draft,
                aspectRatio: generationDefaults.aspectRatio || draft.aspectRatio,
                imageSize: generationDefaults.imageSize || draft.imageSize,
                quality: generationDefaults.quality || draft.quality,
            };
        }

        if (opts.instruction) {
            draft = await updateGenerationDraft(chatId, msgId, messageText, d => ({
                ...d,
                prompt: opts.instruction.prompt ?? d.prompt,
                aspectRatio: opts.instruction.aspectRatio ?? d.aspectRatio,
                imageSize: opts.instruction.imageSize ?? d.imageSize,
                quality: opts.instruction.quality ?? d.quality,
                promptOrigin: (opts.instruction.prompt || d.prompt) ? 'manual' : d.promptOrigin,
            }));
        }

        if (!draft.prompt) {
            throw new Error('Prompt is empty');
        }

        const submissionPromptRevision = draft.promptRevision || 0;
        const submissionReferenceRevision = draft.references?.revision || 0;

        // Resolve Stage 2 refs from the current prompt, not from the historical
        // Stage 1 snapshot. Provider capability/cap filtering stays downstream.
        const candidates = await buildCandidates(chatId);
        if (useSignal.aborted) throw new DOMException('Aborted', 'AbortError');
        const referenceResolution = await resolvePromptReferenceContext({
            prompt: draft.prompt,
            candidates,
            corrections: draft.references || { includedIds: [], excludedIds: [], revision: 0 },
        });

        const { imageConnId: resolvedImageConnId } = await resolveActivePresets(snapshot);
        imageConnId = resolvedImageConnId;
        const resolvedConnection = imageConnId ? await resolveConnection(imageConnId) : null;
        effectiveRoute = snapshot.imageRoute || resolvedConnection?.conn?.selectedRoute || null;
        // Kept for the diagnostic log line: `editProtocol` lives on the
        // connection, so without it the observer would report every edit as
        // multipart regardless of what the provider actually sent.
        effectiveConnection = resolvedConnection?.conn || null;

        let refs;
        if (Array.isArray(opts.refs)) {
            refs = opts.refs.map(r => ({
                id: r.id || '',
                name: r.name || '',
                dataUrl: r.image,
            }));
            trace('pipeline: используются готовые референсы (opts.refs)', { count: refs.length });
        } else {
            refs = await materializeStage2References(referenceResolution, {
                signal: useSignal,
                timeoutMs: effectiveConnection?.timeoutMs || 60000,
            });
        }
        // Short request tag ties this line to the capability: / materialized
        // lines for the same attempt; the per-ref summary shows what actually
        // got materialized (name/MIME/KB) instead of a bare count.
        trace(`pipeline: собраны референсы [${(activeRequestId || '').slice(0, 8)}]`, {
            count: refs.length,
            refs: refs.map(summarizeReference),
        });

        // Re-read the draft after awaited candidate/reference work. Manual
        // parameter edits made while references resolve must win before the
        // immutable paid-request snapshot is created.
        if (!opts.instruction) {
            const latest = await loadDraftForStage2(chatId, msgId, messageText);
            if ((latest.promptRevision || 0) !== submissionPromptRevision
                || (latest.references?.revision || 0) !== submissionReferenceRevision) {
                throw new Error('Generation inputs changed while references were loading; press Generate again.');
            }
            draft = {
                ...latest,
                aspectRatio: generationDefaults.aspectRatio || latest.aspectRatio,
                imageSize: generationDefaults.imageSize || latest.imageSize,
                quality: generationDefaults.quality || latest.quality,
            };
        }

        // UI mirror of sent refs.
        state.lastSentRefs = refs;
        try { opts.onRefsSent?.(refs); } catch (e) { warn('pipeline: onRefsSent threw', e.message); }

        const referenceEntries = [
            ...refs,
            ...((referenceResolution.stage2Refs || []).filter(ref => ref.bindingMode === 'description')),
        ];
        const composed = composeReferencePrompt(draft.prompt, referenceEntries);

        const submission = createStage2Snapshot({
            draft,
            contextSnapshot: {
                contextRevision: referenceResolution.referencesRevision,
            },
            refs,
            effectivePrompt: composed.effectivePrompt,
        });

        // Persist the immutable submission before any provider call.
        draft = await updateGenerationDraft(chatId, msgId, messageText, d => ({
            ...d,
            stage2: { ...d.stage2, status: 'running', requestId: activeRequestId, lastSubmittedSnapshot: submission, error: null },
        }));

        request = {
            requestId: activeRequestId,
            prompt: submission.effectivePrompt || submission.prompt,
            aspectRatio: submission.aspectRatio,
            imageSize: submission.imageSize,
            quality: submission.quality,
            references: submission.refs,
            referenceBindings: composed.bindings,
            chatId,
            sourceMsgId: msgId,
        };
        recordDiagnosticEvent({
            event: 'dispatch-start', stage: 'stage2', requestId: activeRequestId,
            chatHash: hashDiagnosticId(chatId), msgId, connId: imageConnId,
            routeId: effectiveRoute?.id || null, modelId: effectiveRoute?.modelId || null,
            generationContract: effectiveRoute?.generationContract || null,
            operation: refs.length ? 'edit' : 'generate', delivery: effectiveRoute?.transport?.initialDelivery || null,
            bodyKind: effectiveRoute?.transport?.bodyKind || null, referenceCount: refs.length,
            details: { aspectRatio: submission.aspectRatio, imageSize: submission.imageSize, quality: submission.quality, promptChars: (submission.effectivePrompt || submission.prompt || '').length },
        });
        const result = await generateImageRequest(imageConnId, request, onStatus, useSignal, { route: effectiveRoute });
        if (useSignal.aborted) throw new DOMException('Aborted', 'AbortError');

        // Log what this real user generation actually did. This is the only
        // hookpoint where the structured error object (with .code/.httpStatus)
        // and the exact operation/reference mode are still in scope before UI
        // layers flatten everything to .message. Diagnostic only: it persists
        // nothing and never blocks or reruns the paid POST.
        observeCapabilityAttempt({
            route: effectiveRoute, request, connection: effectiveConnection,
            httpStatus: 200, error: null,
        });

        recordDiagnosticEvent({
            event: 'stage2-result', stage: 'stage2', requestId: activeRequestId,
            chatHash: hashDiagnosticId(chatId), msgId, outcome: 'ready', referenceCount: refs.length,
            details: {
                galleryId: result?.galleryEntry?.id || null,
                // Which references were resolved from the prompt and sent as
                // images, plus which matched-but-excluded ones stayed out.
                sentReferenceNames: refs.map(ref => ref?.name || null),
                matchedExcluded: (referenceResolution?.matchedReferences || [])
                    .filter(ref => ref?.effective === false)
                    .map(ref => ref?.name || null),
            },
        });
        draft = await updateGenerationDraft(chatId, msgId, messageText, d => {
            if (d.stage2?.requestId && d.stage2.requestId !== activeRequestId) return d;
            return {
                ...d,
                stage2: { ...d.stage2, status: 'ready', error: null, requestId: activeRequestId },
            };
        });
        // Success-only notification; covers manual runs, the full pipeline and
        // the batch queue (all converge on runStage2ForDraft). Cancel/error
        // paths never ring.
        playStageSound('stage2');

        // Evidence write-back: this paid attempt proved the (connection,
        // model, dialect) triple accepts refCount references. Fire-and-forget
        // — evidence is diagnostic and never blocks the result.
        if (imageConnId && refs.length > 0) {
            recordReferenceEvidence({
                connectionId: imageConnId,
                modelId: effectiveRoute?.modelId,
                dialect: request?.editDialect || effectiveRoute?.generationContract || null,
                refCount: refs.length,
            }).catch(() => {});
        }

            trace(`Stage 2 browser result materialized [${(activeRequestId || '').slice(0, 8)}], entry`, result?.galleryEntry?.id);
        const entry = result?.galleryEntry || result;
        // Surface provider warnings (e.g. dropped size/quality) through the
        // entry so the Generate tab can toast them.
        if (result?.warnings?.length && entry && typeof entry === 'object') entry.warnings = result.warnings;
        return entry;
    } catch (e) {
        failure = e;
        // Log the failure BEFORE the draft wrapper flattens it to e.message.
        // A materialize failure (after the provider POST succeeded) classifies
        // to the `materialize` outcome (no .code/.httpStatus, not a network
        // error/abort), so the log says "generation succeeded" instead of
        // blaming the model. CORS/network ambiguity resolves to
        // `network-unknown`, never `unsupported`. This call never throws.
        observeCapabilityAttempt({
            route: effectiveRoute, request, connection: effectiveConnection,
            httpStatus: e?.httpStatus ?? null, error: e,
        });
        const isCancelled = useSignal?.aborted || e?.name === 'AbortError';
        recordDiagnosticEvent({
            event: isCancelled ? 'stage2-cancel' : 'stage2-error',
            level: isCancelled ? 'log' : 'error', stage: 'stage2', requestId: activeRequestId,
            chatHash: hashDiagnosticId(chatId), msgId,
            outcome: isCancelled ? 'cancelled' : 'error',
            status: e?.httpStatus ?? null,
            details: { errorCode: e?.code || null, errorName: e?.name || null },
        });
        // A reference-shaped rejection is a durable fact about the gateway —
        // record it for the references panel (fires only when the classifier
        // recognizes the rejection shape; other errors prove nothing).
        if (imageConnId && !isCancelled) {
            recordReferenceEvidence({
                connectionId: imageConnId,
                modelId: effectiveRoute?.modelId,
                dialect: request?.editDialect || effectiveRoute?.generationContract || null,
                refCount: (request?.references || []).length,
                error: e,
            }).catch(() => {});
        }
        try {
            await updateGenerationDraft(chatId, msgId, messageText, d => {
                if (d.stage2?.requestId && d.stage2.requestId !== activeRequestId) return d;
                return {
                    ...d,
                    stage2: { ...d.stage2, status: isCancelled ? 'cancelled' : 'error', error: isCancelled ? null : e.message, requestId: activeRequestId },
                };
            });
        } catch (_) {}
        throw e;
    } finally {
        if (activeRequestId) {
            state.activeGenerations.delete(activeRequestId);
            if (started) {
                const cancelled = useSignal?.aborted || failure?.name === 'AbortError';
                recordDiagnosticEvent({
                    event: 'stage2-end', stage: 'stage2', requestId: activeRequestId,
                    chatHash: hashDiagnosticId(chatId), msgId,
                    outcome: cancelled ? 'cancelled' : (failure ? 'error' : 'ready'),
                    durationMs: startedAt ? Date.now() - startedAt : null,
                });
                emitStage2Event('uris:stage2-end', { requestId: activeRequestId, msgId });
            }
        }
        if (releaseNext) {
            releaseNext();
            if (chainKey && myNext && state.stage2Chains.get(chainKey) === myNext) {
                state.stage2Chains.delete(chainKey);
            }
        }
    }
}

/**
 * Positional compatibility adapter around {@link runStage2ForDraft}.
 *
 * @param {number|string} msgId
 * @param {object} instruction
 * @param {(status: string) => void} [onStatus]
 * @param {AbortSignal} [signal]
 * @param {object} [opts]
 * @returns {Promise<object|null>}
 */
export async function runStage2(msgId, instruction, onStatus, signal, opts = {}) {
    const ctx = getCtx();
    const chatId = ctx.chatId;
    const messageText = ctx.chat?.[msgId]?.mes || '';
    state.pendingSourceMesHash = hashMessage(messageText);
    // Capture current chat config at the start of this manual Stage 2 so it
    // cannot be affected by a later chat switch.
    const chatConfig = opts.chatConfig || await resolveChatConfigSnapshot();
    return runStage2ForDraft(
        { chatId, msgId, messageText, templateId: null, chatConfig },
        onStatus,
        signal,
        { ...opts, instruction },
    );
}
