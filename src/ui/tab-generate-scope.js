// @ts-check
/**
 * Scope identity of the Generate tab: the (chatId, msgId, messageText) triple
 * being edited, plus the module-level root ref used by the singleton abort-UI
 * listeners. Extracted from tab-generate.js (v0.9.5 split) so the refs panel
 * and lifecycle modules can share it without a cycle through the tab itself.
 */
import { state, getCtx } from '../core.js';
import { isStudioActive, STUDIO_CHAT_ID, STUDIO_MSG_ID } from '../studio-scope.js';

// Module-level ref to the Generate tab root, so the singleton abort-UI listeners
// (bindAbortUI) can refresh the in-flight "Остановить" button and queue status
// without a full re-render (which would tear down the editor).
let _generateRoot = null;

/** Test/UI seam: remember the rendered Generate tab root. */
export function setGenerateRoot(root) { _generateRoot = root; }

/** Current rendered Generate tab root (null before the first render). */
export function getGenerateRoot() { return _generateRoot; }

/**
 * Identity of the draft the Generate tab is currently editing: the real
 * (chatId, msgId) pair in a chat, the single studio draft on the welcome
 * screen. messageText is the Stage 1 scene source — the chat message text, or
 * the live content of the studio scene textarea.
 * @param {HTMLElement} [root]
 */
export function activeScope(root) {
    if (isStudioActive()) {
        const sceneText = root?.querySelector('#urisScene')?.value || '';
        return { studio: true, chatId: STUDIO_CHAT_ID, msgId: STUDIO_MSG_ID, messageText: sceneText };
    }
    const ctx = getCtx();
    const msgId = state.currentMsgId;
    return {
        studio: false,
        chatId: ctx.chatId,
        msgId,
        messageText: msgId != null ? (ctx.chat?.[msgId]?.mes || '') : '',
    };
}
