// @ts-check
/**
 * ST event handling: automation by automationMode + post navigator.
 * Automation uses the current chat's schema-v5 automationMode.
 *
 * ST eventSource does not return a subscription id and has no .off() —
 * removeListener(event, fn) works ONLY by function reference, so handlers
 * are stored in module-level vars and cleaned up in unbindEvents().
 */
import { state, getCtx, log, warn, error } from './core.js';
import { recordDiagnosticEvent, hashDiagnosticId } from './diagnostic-events.js';
import { loadChatConfig, applyChatConfigToState } from './chat-binding.js';
import { POST_FILTER, setFilter, getLastPostIndex, setCurrentMsgId } from './post-navigator.js';

let _bound = false;
let _onAutomation = null;      // callback: ({chatId,msgId,messageText,templateId,requestedAction}) => Promise<void>
                               // templateId is an operation-level snapshot; null lets the pipeline resolve
                               // the effective template from the draft/default active template.
let _onGenerationEnded = null; // reference for removeListener
let _onMessageSent = null;     // reference for removeListener
let _onChatChanged = null;     // reference for removeListener
let _onPostFollow = null;      // single function for GENERATION_ENDED/MESSAGE_SENT/MESSAGE_SWIPED
let _onStopAll = null;         // GENERATION_STOPPED → abort all in-flight extension generations

// Guard: automation and chat-changed events are suppressed until the new chat's
// config has been loaded and applied. A monotonically increasing token prevents
// stale async loads from overwriting a later chat switch.
let _chatConfigReady = true;
let _chatLoadToken = 0;

export function bindEvents(handlers) {
    const ctx = getCtx();
    if (!ctx.eventSource || _bound) return;
    _bound = true;

    _onAutomation = handlers?.onAutomation || null;

    // Sync the post-navigator filter with the saved setting.
    setFilter(state.settings?.generationFlow || POST_FILTER.AI_ONLY);

    const et = ctx.event_types;

    const triggerIfMatches = (msgId) => {
        if (!_chatConfigReady) return;
        if (msgId == null || msgId === -1) return;
        const filter = state.generationFlow || POST_FILTER.AI_ONLY;
        if (filter === POST_FILTER.MANUAL) return;
        const msg = ctx.chat?.[msgId];
        if (!msg) return;
        const isUser = !!msg.is_user;
        if (filter === POST_FILTER.AI_ONLY && isUser) return;
        if (filter === POST_FILTER.USER_ONLY && !isUser) return;
        const automationMode = state.settings.automationMode || 'manual';
        if (automationMode === 'manual') return;
        // getContext() returns a fresh snapshot per call — scalar fields like
        // chatId are frozen at call time, and the ctx captured by bindEvents()
        // predates the first chat load (its chatId is permanently empty).
        // Always re-read chatId from a fresh context. state.currentChatId (set
        // on CHAT_CHANGED) covers the window before the first CHAT_CHANGED.
        const chatId = state.currentChatId || getCtx().chatId;
        if (!chatId) {
            // Retry after a short delay — ST may need a moment to set ctx.chatId
            // if the extension initialized before the chat was opened.
            setTimeout(() => {
                if (!_chatConfigReady) return;
                const retryChatId = state.currentChatId || getCtx().chatId;
                if (!retryChatId) {
                    warn('Auto generation skipped: chatId is empty (chat not ready)');
                    return;
                }
                triggerIfMatches(msgId);
            }, 300);
            return;
        }
        state.currentMsgId = msgId;
        // templateId: null lets the pipeline resolve the effective template from
        // the current draft/default at processing time, rather than snapshotting it.
        _onAutomation?.({
            chatId,
            msgId,
            messageText: msg.mes || '',
            templateId: null,
            requestedAction: automationMode,
        });
    };

    // GENERATION_ENDED → dispatch automation only when enabled and not manual.
    // makeLast: run after ST handlers so the new post is already in ctx.chat.
    _onGenerationEnded = () => {
        if (!state.settings.enabled) return;
        const automationMode = state.settings.automationMode || 'manual';
        if (automationMode === 'manual') return;
        const filter = state.generationFlow || POST_FILTER.AI_ONLY;
        if (filter === POST_FILTER.USER_ONLY || filter === POST_FILTER.MANUAL) return;
        const i = getLastPostIndex();
        if (i != null) triggerIfMatches(i);
    };
    ctx.eventSource.makeLast(et.GENERATION_ENDED, _onGenerationEnded);

    // MESSAGE_SENT → dispatch automation when the flow includes user messages.
    _onMessageSent = (msgId) => {
        if (!state.settings.enabled) return;
        const automationMode = state.settings.automationMode || 'manual';
        if (automationMode === 'manual') return;
        const filter = state.generationFlow || POST_FILTER.AI_ONLY;
        if (filter === POST_FILTER.AI_ONLY || filter === POST_FILTER.MANUAL) return;
        const i = (typeof msgId === 'number' && msgId >= 0) ? msgId : getLastPostIndex();
        if (i != null) triggerIfMatches(i);
    };
    ctx.eventSource.on(et.MESSAGE_SENT, _onMessageSent);

    // FOLLOW-LAST-POST: when enabled, snap currentMsgId to the last matching post
    // and notify the UI. Works independently of automationMode — this is navigator
    // UI behavior, not the pipeline. Subscribed to 3 events with one function:
    // GENERATION_ENDED (new post), MESSAGE_SENT (new user post),
    // MESSAGE_SWIPED (current/last post content changed).
    _onPostFollow = () => {
        if (!state.settings.enabled) return;
        if (state.settings.followLastPost === false) return;
        // For MESSAGE_SWIPED the content of the same post changed — the tab should
        // re-read the draft/text. For GENERATION_ENDED/MESSAGE_SENT msgId usually
        // changes. So always snap to the last matching post and dispatch
        // as long as the post exists (the stream filter may return nothing → null).
        const next = setCurrentMsgId(getLastPostIndex());
        if (next != null) {
            window.dispatchEvent(new CustomEvent('uris:post-follow'));
        }
    };
    ctx.eventSource.on(et.GENERATION_ENDED, _onPostFollow);
    ctx.eventSource.on(et.MESSAGE_SENT, _onPostFollow);
    ctx.eventSource.on(et.MESSAGE_SWIPED, _onPostFollow);

    // CHAT_CHANGED: update currentMsgId + load and apply this chat's config.
    _onChatChanged = () => {
        const token = ++_chatLoadToken;
        _chatConfigReady = false;
        // Fresh snapshot — the ctx captured by bindEvents() has a permanently
        // stale (empty) chatId (see triggerIfMatches above).
        state.currentChatId = getCtx().chatId;
        const i = getLastPostIndex();
        if (i != null) setCurrentMsgId(i);
        log('CHAT_CHANGED, last post', state.currentMsgId);
        recordDiagnosticEvent({
            event: 'chat-changed',
            chatHash: hashDiagnosticId(state.currentChatId),
            msgId: state.currentMsgId,
            details: { lastPost: state.currentMsgId },
        });
        state.lastSentRefs = null;
        (async () => {
            try {
                const cfg = await loadChatConfig();
                if (token !== _chatLoadToken) {
                    log('CHAT_CHANGED: stale chat config load ignored', token);
                    return;
                }
                applyChatConfigToState(cfg);
                setFilter(state.settings?.generationFlow || POST_FILTER.AI_ONLY);
                _chatConfigReady = true;
                window.dispatchEvent(new CustomEvent('uris:chat-changed'));
            } catch (e) {
                error('CHAT_CHANGED: load/apply config:', e.message);
                // A failed config load must not leave automation permanently suppressed
                // for the current chat. Recover with the existing/default state and notify UI.
                _chatConfigReady = true;
                window.dispatchEvent(new CustomEvent('uris:chat-changed'));
            }
        })();
    };
    ctx.eventSource.on(et.CHAT_CHANGED, _onChatChanged);

    // GENERATION_STOPPED: the user pressed ST's global Stop button (stopGeneration
    // emits it unconditionally, even when nothing was generating). The handler
    // ("Stop stops everything") cancels all in-flight extension generations and
    // the batch queue; it is a no-op when idle.
    _onStopAll = handlers?.onStopAll || null;
    if (_onStopAll) ctx.eventSource.on(et.GENERATION_STOPPED, _onStopAll);

    log('Events bound.');
}

export function unbindEvents() {
    const ctx = getCtx();
    if (ctx?.eventSource) {
        const et = ctx.event_types;
        // removeListener does not throw if the function is not in the list — but we still try/catch
        // in case eventSource is already partially torn down.
        try { if (_onGenerationEnded) ctx.eventSource.removeListener(et.GENERATION_ENDED, _onGenerationEnded); } catch {}
        try { if (_onMessageSent) ctx.eventSource.removeListener(et.MESSAGE_SENT, _onMessageSent); } catch {}
        try { if (_onChatChanged) ctx.eventSource.removeListener(et.CHAT_CHANGED, _onChatChanged); } catch {}
        try { if (_onPostFollow) {
            ctx.eventSource.removeListener(et.GENERATION_ENDED, _onPostFollow);
            ctx.eventSource.removeListener(et.MESSAGE_SENT, _onPostFollow);
            ctx.eventSource.removeListener(et.MESSAGE_SWIPED, _onPostFollow);
        } } catch {}
        try { if (_onStopAll) ctx.eventSource.removeListener(et.GENERATION_STOPPED, _onStopAll); } catch {}
    }
    _onGenerationEnded = null;
    _onMessageSent = null;
    _onChatChanged = null;
    _onPostFollow = null;
    _onStopAll = null;
    _onAutomation = null;
    _chatConfigReady = true;
    _chatLoadToken = 0;
    _bound = false;
}

/**
 * Notify UI that Stage 1 produced a prompt. No automatic Stage 2 is started here —
 * the automation flow uses the captured message identity in index.js.
 */
export function notifyStage1Ready(instruction) {
    window.dispatchEvent(new CustomEvent('uris:stage1-ready', { detail: instruction }));
}

