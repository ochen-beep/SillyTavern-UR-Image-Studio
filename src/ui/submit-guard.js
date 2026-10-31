// @ts-check
/**
 * Shared duplicate-run guard for paid Stage 2 submissions. Both entry points —
 * the manual Generate-tab submit and the queue row retry — route through it:
 * the same generation queued or running twice means a second paid attempt.
 * An explicit bypass stays with the user in the confirmation.
 */
import { state, showConfirmModal } from '../core.js';
import { findQueuedDuplicate } from '../pipeline-queue.js';
import { recordDiagnosticEvent, hashDiagnosticId } from '../diagnostic-events.js';

/**
 * @param {object} item - queue item built by createQueueItem
 * @param {{chatId:string, msgId:number}} identity - source post for diagnostics
 * @param {{confirmDuplicate?:Function, confirmActiveGeneration?:Function}} [deps] - confirm injection for tests
 * @returns {Promise<boolean>} true — proceed with enqueue
 */
export async function guardDuplicateSubmission(item, identity, deps = {}) {
    if (!findQueuedDuplicate(item)) {
        // The queue dedup cannot see a generation already in flight outside
        // the queue (auto full-pipeline, bridge). A manual submit on the same
        // post would pay for the same scene twice — ask, like the queue path.
        if (identity?.msgId != null
            && (state.activeStage2ByPost.get(`${identity.chatId}:${identity.msgId}`) || 0) > 0) {
            const confirmActive = deps.confirmActiveGeneration || showConfirmModal;
            const proceed = await confirmActive('Этот пост сейчас генерируется вне очереди. Запустить ещё одну генерацию?');
            if (proceed) return true;
            toastr?.info('Генерация не добавлена — пост уже генерируется');
            return false;
        }
        return true;
    }
    const confirmDuplicate = deps.confirmDuplicate || showConfirmModal;
    const proceed = await confirmDuplicate('Такая генерация уже в очереди или выполняется. Запустить всё равно?');
    if (proceed) return true;
    recordDiagnosticEvent({ event: 'queue-duplicate-blocked', stage: 'queue', chatHash: hashDiagnosticId(identity.chatId), msgId: identity.msgId });
    toastr?.info('Генерация не добавлена — дубликат уже в очереди');
    return false;
}
