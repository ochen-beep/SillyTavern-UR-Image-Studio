// @ts-check
/**
 * Batch generation queue: createQueueItem → enqueueGeneration → processQueue.
 * Extracted from pipeline.js (see docs
 * docs/archive/specs/2026-07-18-remove-descrefs-and-split-pipeline-design.md).
 *
 * processQueue orchestrates both stages, so it imports Stage 1 and Stage 2.
 */
import { state, getCtx, log, error } from './core.js';
import { recordDiagnosticEvent, hashDiagnosticId } from './diagnostic-events.js';
import { hashMessage } from './generation-drafts.js';
import { resolveChatConfigSnapshot } from './pipeline-config.js';
import { runStage1ForDraft } from './pipeline-stage1.js';
import { runStage2ForDraft } from './pipeline-stage2.js';
import { STUDIO_CHAT_ID } from './studio-scope.js';

// ── Queue: explicit source identity and action ──

/**
 * Build a queue item with captured source identity.
 *
 * @param {{chatId:string,msgId:number,messageText:string,requestedAction:'full-pipeline'|'current-prompt-stage2',templateId:string|null,submission?:object|null,now?:()=>string}} input
 * `submission` (current-prompt-stage2 only) is the submit-time snapshot
 * `{prompt, aspectRatio?, imageSize?, quality?, references?}` captured at
 * click time; the queue deep-freezes a copy so later draft edits cannot
 * change what a queued Stage 2 will submit.
 * @returns {import('./core.js').GenerationQueueItem}
 */
export async function createQueueItem({ chatId, msgId, messageText, requestedAction, templateId, submission = null, now = () => new Date().toISOString() }) {
    if (!['full-pipeline', 'current-prompt-stage2'].includes(requestedAction)) {
        throw new Error(`Unknown requestedAction: ${requestedAction}`);
    }
    if (submission != null && requestedAction !== 'current-prompt-stage2') {
        throw new Error('submission is only valid for current-prompt-stage2');
    }
    // Validate before copying: a non-string prompt (e.g. a number) must not
    // pass coercion and fail loudly later at paid-dispatch time.
    if (submission != null && (typeof submission.prompt !== 'string' || !submission.prompt.trim())) {
        throw new Error('submission.prompt must be a non-empty string');
    }
    // Explicit field copy: the snapshot must not alias (or freeze) the caller's
    // object, and its shape is validated here rather than at paid-dispatch time.
    const submissionSnapshot = submission == null ? null : deepFreeze({
        prompt: submission.prompt,
        aspectRatio: submission.aspectRatio ?? null,
        imageSize: submission.imageSize ?? null,
        quality: submission.quality ?? null,
        references: {
            includedIds: [...(submission.references?.includedIds || [])],
            excludedIds: [...(submission.references?.excludedIds || [])],
            revision: submission.references?.revision || 0,
        },
    });
    // Resolve schema-v5 binding and route together at enqueue time. The route is
    // deep-cloned so later connection edits cannot change a queued Stage 2 call.
    const chatConfig = deepFreeze(await resolveChatConfigSnapshot());
    // Studio items carry their scene text: there is no chat message to re-read
    // at execution time, and the studio scope survives chat switches.
    // Submission items deliberately do NOT: per the deferred-queue contract they
    // keep re-reading the live chat and are rejected on stale state before any
    // paid request.
    const item = {
        chatId,
        msgId,
        messageHash: hashMessage(messageText),
        requestedAction,
        templateId: templateId || null,
        chatConfig,
        enqueuedAt: now(),
        ...(chatId === STUDIO_CHAT_ID ? { messageText: String(messageText || '') } : {}),
        ...(submissionSnapshot ? { submission: submissionSnapshot } : {}),
    };
    recordDiagnosticEvent({
        event: 'queue-enqueue', stage: 'queue', chatHash: hashDiagnosticId(chatId), msgId,
        details: { requestedAction, submission: submissionSnapshot != null },
    });
    return item;
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

/**
 * Enqueue a generation action. Returns a promise resolved when the item is processed.
 *
 * @param {import('./core.js').GenerationQueueItem} item
 * @returns {Promise<object|null>}
 */
export function enqueueGeneration(item) {
    return new Promise((resolve, reject) => {
        state.queue.push({ item, resolve, reject });
        processQueue();
    });
}

/**
 * Compatibility wrapper: enqueue full-pipeline for the current message.
 *
 * @param {number|string} msgId
 * @returns {Promise<object|null>}
 */
export async function enqueue(msgId) {
    const ctx = getCtx();
    const chatId = ctx.chatId;
    const messageText = ctx.chat?.[msgId]?.mes || '';
    return enqueueGeneration(await createQueueItem({
        chatId,
        msgId,
        messageText,
        requestedAction: 'full-pipeline',
        templateId: null,
    }));
}

async function processQueue() {
    if (state.queueRunning) return;
    state.queueRunning = true;
    state.queueAbort = new AbortController();

    try {
        while (state.queue.length && !state.queueAbort.signal.aborted) {
            const { item, resolve, reject } = state.queue.shift();
            try {
                const ctx = getCtx();
                // Studio items keep the text captured at enqueue time: there is
                // no source message, and their scope does not go stale when the
                // user opens another chat while the queue runs.
                const isStudioItem = item.chatId === STUDIO_CHAT_ID;
                const messageText = isStudioItem
                    ? (item.messageText || '')
                    : (ctx.chat?.[item.msgId]?.mes || '');
                if (!isStudioItem && state.currentChatId && state.currentChatId !== item.chatId) {
                    recordDiagnosticEvent({ event: 'queue-reject-stale-chat', level: 'warn', stage: 'queue', chatHash: hashDiagnosticId(item.chatId), msgId: item.msgId });
                    throw new Error('Queued item belongs to another chat');
                }
                if (!isStudioItem && hashMessage(messageText) !== item.messageHash) {
                    recordDiagnosticEvent({ event: 'queue-reject-message-changed', level: 'warn', stage: 'queue', chatHash: hashDiagnosticId(item.chatId), msgId: item.msgId });
                    throw new Error('Queued source message changed');
                }
                const input = {
                    chatId: item.chatId,
                    msgId: item.msgId,
                    messageText,
                    templateId: item.templateId,
                    chatConfig: item.chatConfig,
                };
                let entry;
                if (item.requestedAction === 'current-prompt-stage2') {
                    entry = await runStage2ForDraft(input, (s) => { log('Q:', s); }, state.queueAbort.signal,
                        item.submission ? { submission: item.submission } : {});
                } else {
                    const run = await runStage1ForDraft(input, (s) => { log('Q:', s); }, state.queueAbort.signal);
                    if (run.applied && run.draft?.prompt) {
                        entry = await runStage2ForDraft(input, (s) => { log('Q:', s); }, state.queueAbort.signal);
                    } else {
                        entry = null;
                    }
                }
                recordDiagnosticEvent({ event: 'queue-complete', stage: 'queue', chatHash: hashDiagnosticId(item.chatId), msgId: item.msgId, outcome: 'completed' });
                resolve(entry);
            } catch (e) {
                if (e.name === 'AbortError') {
                    reject(new DOMException('Aborted by user', 'AbortError'));
                    // A whole-queue stop aborts the shared controller; a per-item
                    // cancel (abortGeneration on this item's ownController) does
                    // not, so the queue continues with the next item.
                    if (state.queueAbort?.signal.aborted) break;
                    continue;
                }
                error('Q item failed:', e.message);
                recordDiagnosticEvent({ event: e.name === 'AbortError' ? 'queue-abort' : 'queue-error', level: e.name === 'AbortError' ? 'log' : 'error', stage: 'queue', chatHash: hashDiagnosticId(item.chatId), msgId: item.msgId, outcome: e.name === 'AbortError' ? 'cancelled' : 'error', details: { errorName: e?.name || null } });
                reject(e);
            }
        }
    } finally {
        state.queueRunning = false;
        state.queueAbort = null;
        // Reject remaining tasks
        for (const remaining of state.queue) {
            remaining.reject(new DOMException('Queue stopped', 'AbortError'));
        }
        state.queue = [];
    }
}

/**
 * Stop the batch queue. Aborting the shared queue controller cascades to every
 * queued Stage 2 (each links its own controller to this signal) and aborts the
 * in-flight Stage 1 directly, so the queue stops without touching unrelated
 * manual generations. Per-item cancellation uses abortGeneration(requestId).
 * @returns {void}
 */
export function stopQueue() {
    state.queueAbort?.abort();
}
