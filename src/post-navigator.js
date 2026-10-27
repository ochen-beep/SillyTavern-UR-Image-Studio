// @ts-check
/**
 * Post navigator: single source of truth for selecting the current message
 * and filtering which messages are eligible for generation.
 *
 * Responsibilities:
 *   - filter eligible posts (ai-only / user-only / all / manual)
 *   - ←/→ navigation through filtered posts
 *   - resolving the "last matching post"
 *   - validation and migration of state.currentMsgId
 *
 * Does not mutate message.mes and does not depend on the DOM.
 */
import { state, getCtx, sanitizePrompt, log, warn } from './core.js';

export const POST_FILTER = {
    AI_ONLY: 'ai-only',      // only !is_user
    USER_ONLY: 'user-only',  // only is_user
    ALL: 'all',              // any messages
    MANUAL: 'manual',        // any messages, but auto-generation is disabled
};

const VALID_FILTERS = new Set(Object.values(POST_FILTER));

// Reasoning (CoT) block tags treated as invisible content. `<think>` is the
// prefix of ST's default "Think XML" template and of the DeepSeek/Gemini ones;
// the rest cover common wrappers. ST's configured template is not exposed to
// extensions via getContext(), so this stays a constant: it guards against
// empty content, it does not replicate ST's parser. An UNCLOSED block (stream
// aborted mid-thinking) hides everything after its opening tag — ST's
// auto-parse requires the closing suffix and leaves the raw text in msg.mes.
const REASONING_TAGS = ['think', 'thinking', 'reasoning', 'thought', 'scratchpad'];
const CLOSED_REASONING_RE = new RegExp(`<(${REASONING_TAGS.join('|')})>[\\s\\S]*?</\\1>`, 'g');
const OPEN_REASONING_RE = new RegExp(`<(${REASONING_TAGS.join('|')})>`);
const EMPTY_BODY_PLACEHOLDER = '...';

/**
 * Message text as visible to generation: reasoning blocks removed (including
 * an unterminated one from an aborted stream) and ST's empty-body placeholder
 * folded to ''. Deliberately NOT part of matchesFilter: content-based
 * navigation filtering would make getLastPostIndex() fall back to an OLDER
 * post and silently generate for it — callers skip instead.
 * @param {object|null} msg ST chat message
 * @returns {string} trimmed visible content ('' when none)
 */
export function visiblePostContent(msg) {
    let text = String(msg?.mes ?? '');
    text = text.replace(CLOSED_REASONING_RE, '');
    const open = text.search(OPEN_REASONING_RE);
    if (open !== -1) text = text.slice(0, open);
    text = text.trim();
    return text === EMPTY_BODY_PLACEHOLDER ? '' : text;
}

/**
 * Generation eligibility on top of the role filter: system/hidden posts never
 * generate, and a post without visible content (empty, '...' placeholder, or
 * reasoning-only from an aborted stream) must not start a paid run.
 * @param {object|null} msg ST chat message
 * @returns {boolean}
 */
export function isGenerationEligible(msg) {
    return !!msg && !msg.is_system && !msg.is_hidden && visiblePostContent(msg).length > 0;
}

function getChat() {
    return getCtx().chat || [];
}

function matchesFilter(msg, filter) {
    if (!msg) return false;
    if (filter === POST_FILTER.ALL || filter === POST_FILTER.MANUAL) return true;
    if (filter === POST_FILTER.AI_ONLY) return !msg.is_user;
    if (filter === POST_FILTER.USER_ONLY) return !!msg.is_user;
    return false;
}

export function setFilter(filter) {
    if (!VALID_FILTERS.has(filter)) {
        warn('post-navigator: invalid filter', filter, '— falling back to ai-only');
        filter = POST_FILTER.AI_ONLY;
    }
    state.generationFlow = filter;
    if (!isValidTarget(state.currentMsgId)) {
        state.currentMsgId = getLastPostIndex();
        log('post-navigator: filter changed, currentMsgId updated to', state.currentMsgId);
    }
}

export function getFilter() {
    return state.generationFlow || POST_FILTER.AI_ONLY;
}

export function getFilteredIndexes() {
    const chat = getChat();
    const filter = getFilter();
    const out = [];
    for (let i = 0; i < chat.length; i++) {
        if (matchesFilter(chat[i], filter)) out.push(i);
    }
    return out;
}

export function isValidTarget(msgId) {
    const chat = getChat();
    if (msgId == null || msgId === -1 || !chat[msgId]) return false;
    return matchesFilter(chat[msgId], getFilter());
}

export function setCurrentMsgId(msgId) {
    if (isValidTarget(msgId)) {
        state.currentMsgId = msgId;
        return msgId;
    }
    const fallback = getLastPostIndex();
    state.currentMsgId = fallback;
    return fallback;
}

export function getCurrentMsgId() {
    return state.currentMsgId ?? getLastPostIndex();
}

export function navigatePosts(direction) {
    const indexes = getFilteredIndexes();
    if (!indexes.length) {
        state.currentMsgId = null;
        return null;
    }
    const current = state.currentMsgId ?? indexes[indexes.length - 1];
    let pos = indexes.indexOf(current);
    if (pos === -1) pos = indexes.length - 1;
    pos = Math.max(0, Math.min(indexes.length - 1, pos + direction));
    state.currentMsgId = indexes[pos];
    return state.currentMsgId;
}

export function getLastPostIndex() {
    const chat = getChat();
    const filter = getFilter();
    for (let i = chat.length - 1; i >= 0; i--) {
        if (matchesFilter(chat[i], filter)) return i;
    }
    return null;
}

export function getPostInfo() {
    const ctx = getCtx();
    const msgId = getCurrentMsgId();
    const msg = ctx.chat?.[msgId];
    if (!msg) return 'Нет поста';
    const preview = sanitizePrompt(msg.mes || '').slice(0, 50);
    const label = msg.is_user ? 'user' : 'AI';
    return `Пост #${msgId} (${label}): ${preview}…`;
}
