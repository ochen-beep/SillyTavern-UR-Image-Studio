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
import { runStage2ForDraft } from './pipeline-stage2.js';
import { STUDIO_CHAT_ID } from './studio-scope.js';
import { noteQueued, noteRunning, noteFinished } from './ui/queue-log.js';

// ── Queue: explicit source identity and action ──

/**
 * Build a queue item with captured source identity. The queue only carries
 * submission snapshots (current-prompt-stage2): the auto full-pipeline runs in
 * the autolane, not here.
 *
 * @param {{chatId:string,msgId:number,messageText:string,requestedAction:'current-prompt-stage2',templateId:string|null,submission?:object|null,now?:()=>string}} input
 * `submission` is the submit-time snapshot
 * `{prompt, aspectRatio?, imageSize?, quality?, references?}` captured at
 * click time; the queue deep-freezes a copy so later draft edits cannot
 * change what a queued Stage 2 will submit.
 * @returns {import('./core.js').GenerationQueueItem}
 */
export async function createQueueItem({ chatId, msgId, messageText, requestedAction, templateId, submission = null, now = () => new Date().toISOString() }) {
    if (requestedAction !== 'current-prompt-stage2') {
        throw new Error(`Unknown requestedAction: ${requestedAction}`);
    }
    if (submission == null || typeof submission.prompt !== 'string' || !submission.prompt.trim()) {
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
        const entry = { item, resolve, reject, queueId: uid() };
        state.queue.push(entry);
        // retry-снапшот для кнопки «Повторить» в ленте: поля пересборки item.
        // messageText для обычного поста сюда не попадает (item его не хранит) —
        // resubmitQueueRow читает живой чат, чтобы хэш-гвард осталась честной;
        // студийный текст сцены хранится в самом item. Тот же снапшот получает
        // строка авто-повтора (autoRetryAmbiguous), если задача упадёт доставкой.
        const retrySnapshot = Object.freeze({
            chatId: item.chatId,
            msgId: item.msgId,
            messageText: item.messageText ?? '',
            templateId: item.templateId,
            submission: item.submission,
        });
        noteQueued({
            id: entry.queueId,
            label: queueLabel(item),
            lane: 'queue',
            retry: retrySnapshot,
        });
        state.queueRetrySnapshots = state.queueRetrySnapshots || new Map();
        state.queueRetrySnapshots.set(entry.queueId, retrySnapshot);
        processQueue();
    });
}

let _queueSeq = 0;

function uid() {
    _queueSeq += 1;
    return `q${_queueSeq}`;
}

/** Подпись строки очереди: пост, из которого пришла генерация. */
function queueLabel(item) {
    return item?.chatId === STUDIO_CHAT_ID ? 'Студия' : `Пост #${Number(item?.msgId) + 1}`;
}

async function processQueue() {
    if (state.queueRunning) return;
    state.queueRunning = true;
    state.queueAbort = new AbortController();

    try {
        while (state.queue.length && !state.queueAbort.signal.aborted) {
            const { item, resolve, reject, queueId } = state.queue.shift();
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
                // The queue only carries submission snapshots; the auto
                // full-pipeline runs in the autolane (pipeline-stage1.js).
                // onStart fires when the run truly starts (past the per-post
                // chain): the лента row flips waiting → running then, not at
                // dequeue — a queued item may still wait behind a manual
                // generation on the same post.
                entry = await runStage2ForDraft(input, (s) => { log('Q:', s); }, state.queueAbort.signal,
                    {
                        ...(item.submission ? { submission: item.submission } : {}),
                        onStart: () => noteRunning(queueId),
                    });
                recordDiagnosticEvent({ event: 'queue-complete', stage: 'queue', chatHash: hashDiagnosticId(item.chatId), msgId: item.msgId, outcome: 'completed' });
                noteFinished(queueId, 'success');
                resolve(entry);
            } catch (e) {
                if (e.name === 'AbortError') {
                    noteFinished(queueId, 'cancelled');
                    reject(new DOMException('Aborted by user', 'AbortError'));
                    // A whole-queue stop aborts the shared controller; a per-item
                    // cancel (abortGeneration on this item's ownController) does
                    // not, so the queue continues with the next item.
                    if (state.queueAbort?.signal.aborted) break;
                    continue;
                }
                // Opt-in auto-retry (2026-09-28): one automatic resubmission for
                // IMAGE_DELIVERY_AMBIGUOUS only. By then the «Авто» ladder has
                // recorded the broken direct path, so the retry goes through the
                // ST proxy with no doomed direct attempt. Strictly once per item
                // (retriedAmbiguous marker), queue-lane only (these carry the
                // resubmit snapshot), and never for user aborts.
                const { autoRetryAmbiguous } = state.settings;
                if (autoRetryAmbiguous === true && e?.code === 'IMAGE_DELIVERY_AMBIGUOUS' && item.retriedAmbiguous !== true) {
                    const retriedItem = { ...item, retriedAmbiguous: true };
                    const retryQueueId = uid();
                    state.queue.push({ item: retriedItem, resolve, reject, queueId: retryQueueId });
                    noteFinished(queueId, 'error', `${e.message || ''} · авто-повтор поставлен в очередь`.trim());
                    // Строке авто-повтора — тот же снапшот «Повторить»: если
                    // откажется и она, у пользователя останется ручная кнопка.
                    noteQueued({ id: retryQueueId, label: `${queueLabel(item)} · авто-повтор`, lane: 'queue', retry: state.queueRetrySnapshots?.get(queueId) || null });
                    state.queueRetrySnapshots?.delete(queueId);
                    recordDiagnosticEvent({
                        event: 'queue-auto-retry', stage: 'queue', chatHash: hashDiagnosticId(item.chatId), msgId: item.msgId,
                        details: { reason: 'IMAGE_DELIVERY_AMBIGUOUS', retryQueueId },
                    });
                    continue;
                }
                error('Q item failed:', e.message);
                noteFinished(queueId, 'error', e.message || '');
                recordDiagnosticEvent({ event: 'queue-error', level: 'error', stage: 'queue', chatHash: hashDiagnosticId(item.chatId), msgId: item.msgId, outcome: 'error', details: { errorName: e?.name || null } });
                reject(e);
            }
        }
    } finally {
        state.queueRunning = false;
        state.queueAbort = null;
        // Reject remaining tasks
        for (const remaining of state.queue) {
            noteFinished(remaining.queueId, 'cancelled');
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

/**
 * Снять одну ожидающую задачу очереди (крестик в ленте панели QUEUE).
 * Выполняющийся или неизвестный id — no-op: выполняющийся уже вне state.queue,
 * его отмена — «Пропустить»-семантика через abortGeneration(requestId).
 * @param {string} queueId
 * @returns {boolean} true, если ожидающий элемент был найден и снят
 */
export function cancelQueuedItem(queueId) {
    const index = state.queue.findIndex(entry => entry.queueId === queueId);
    if (index === -1) return false;
    const [entry] = state.queue.splice(index, 1);
    noteFinished(entry.queueId, 'cancelled');
    entry.reject(new DOMException('Queue stopped', 'AbortError'));
    return true;
}

/**
 * Гасить ожидающие элементы чужого чата одним действием — вызов из
 * CHAT_CHANGED: одно уведомление вместо N ошибок stale-гварда по мере прогона.
 * Выполняющийся элемент не трогается (его проверка уже пройдена, платный
 * запрос в полёте), студийные элементы не привязаны к чату и переживают
 * переключение. Отклонение — 'Queue stopped' AbortError: сабмиттер молчит,
 * общий тост делает вызывающий код.
 * @param {string} currentChatId чат, в который переключился пользователь
 * @returns {number} сколько ожидающих элементов отменено
 */
export function cancelForeignQueueItems(currentChatId) {
    const foreign = state.queue.filter(({ item }) =>
        item.chatId !== STUDIO_CHAT_ID && item.chatId !== currentChatId);
    if (!foreign.length) return 0;
    const ids = new Set(foreign.map(entry => entry.queueId));
    state.queue = state.queue.filter(entry => !ids.has(entry.queueId));
    for (const { queueId, reject } of foreign) {
        noteFinished(queueId, 'cancelled');
        reject(new DOMException('Queue stopped', 'AbortError'));
    }
    recordDiagnosticEvent({
        event: 'queue-cancel-foreign-chat', level: 'warn', stage: 'queue',
        chatHash: hashDiagnosticId(currentChatId),
        details: { count: foreign.length },
    });
    return foreign.length;
}

/**
 * Повторить упавшую задачу из ленты: пересобрать item из сохранённого снапшота
 * строки и поставить в очередь. Конфиг чата резолвится заново на момент
 * повтора (актуальное подключение), текст сообщения для обычного поста читается
 * живым — гварды stale-chat/message-changed работают как у первой отправки.
 * @param {{chatId:string,msgId:number,messageText:string,templateId:string|null,submission:object}} retry
 * @returns {Promise<object|null>}
 */
export async function resubmitQueueRow(retry) {
    const messageText = retry.chatId === STUDIO_CHAT_ID
        ? String(retry.messageText || '')
        : (getCtx().chat?.[retry.msgId]?.mes || '');
    const item = await createQueueItem({
        chatId: retry.chatId,
        msgId: retry.msgId,
        messageText,
        requestedAction: 'current-prompt-stage2',
        templateId: retry.templateId,
        submission: retry.submission,
    });
    return enqueueGeneration(item);
}
