// @ts-check
/**
 * Generate tab lifecycle chrome: the in-flight "Остановить" button (per-post
 * cancel) and the singleton window listeners fed by uris:stage{1,2}-start/end.
 * Queue-wide status and controls live in the floating window's QUEUE badge
 * panel (window.js + queue-log.js) — the old inline status line is gone.
 * Extracted from tab-generate.js (v0.9.5 split).
 */
import { state, abortGeneration } from '../core.js';
import { activeScope, getGenerateRoot } from './tab-generate-scope.js';

/**
 * Toggle the in-flight "Остановить" button without a full re-render. The editor
 * and action buttons are never disabled by generation state (fire-and-forget
 * submissions); the only live chrome this drives is the Stop button.
 * @param {HTMLElement|null} root
 * @param {string|null} requestId
 * @param {boolean} running
 */
export function setCancelState(root, requestId, running) {
    const btn = root?.querySelector?.('#urisCancelImage');
    if (!btn) return;
    btn.hidden = !running;
    if (running && requestId) btn.setAttribute('data-request-id', String(requestId));
}

// Singleton window listeners for the Stage 1/2 lifecycle. The pipeline drives
// the "Остановить" button (and queue status) from one place, so manual, auto
// and queue generations all show/hide it uniformly instead of each call site
// re-rendering the tab.
let _abortUIBound = false;
let _onStage2Start = null;
let _onStage2End = null;
let _onStage1Start = null;
let _onStage1End = null;
// Scope key (`chatId:msgId`) → Set of in-flight requestIds (Stage 1 and Stage 2
// tracked together). A Set — not a single value — so an interleaved Stage 1
// («Перестроить промпт») cannot clobber a still-running Stage 2 of the same
// post: the Stop button survives until the LAST in-flight request ends. Keyed
// by chatId too, so post #0 of a chat never collides with the studio draft
// (STUDIO_MSG_ID = 0). Source of truth for syncCancelState: a tab re-render
// rebuilds the button DOM and would otherwise lose the in-flight state.
const _inflightByScope = new Map();

/** Scope key of the in-flight map; same shape as the Stage 2 chain key. */
function inflightKey(chatId, msgId) {
    return `${chatId}:${msgId}`;
}

/** Latest-inserted id of an in-flight Set (Sets keep insertion order). */
function latestInflight(set) {
    if (!set || set.size === 0) return undefined;
    const ids = [...set];
    return ids[ids.length - 1];
}

/** Shared uris:stage{1,2}-start handling: show the Stop button, tag the queue item. */
function onGenerationStart(ev) {
    const detail = /** @type {CustomEvent} */ (ev).detail || {};
    const { requestId, msgId, chatId, source } = detail;
    if (!requestId) return;
    if (source === 'queue') state.runningQueueRequestId = requestId;
    if (chatId != null && msgId != null) {
        const key = inflightKey(chatId, msgId);
        const inflight = _inflightByScope.get(key) || new Set();
        inflight.add(requestId);
        _inflightByScope.set(key, inflight);
    }
    if (getGenerateRoot()) {
        const scope = activeScope(getGenerateRoot());
        if (msgId === scope.msgId && chatId === scope.chatId) {
            setCancelState(getGenerateRoot(), requestId, true);
        }
    }
}

/**
 * Shared uris:stage{1,2}-end handling. Hides the Stop button only when the last
 * in-flight request for the scope ended; while others remain (interleaved
 * Stage 1 under Stage 2), the button is retargeted to the remaining request.
 */
function onGenerationEnd(ev) {
    const detail = /** @type {CustomEvent} */ (ev).detail || {};
    const { requestId, msgId, chatId } = detail;
    if (!requestId) return;
    if (state.runningQueueRequestId === requestId) state.runningQueueRequestId = null;
    const key = (chatId != null && msgId != null) ? inflightKey(chatId, msgId) : null;
    const inflight = key ? _inflightByScope.get(key) : null;
    if (inflight) {
        inflight.delete(requestId);
        if (inflight.size === 0) _inflightByScope.delete(key);
    }
    if (getGenerateRoot()) {
        const scope = activeScope(getGenerateRoot());
        if (key === inflightKey(scope.chatId, scope.msgId)) {
            const btn = getGenerateRoot().querySelector('#urisCancelImage');
            if (btn && btn.getAttribute('data-request-id') === String(requestId)) {
                const remaining = latestInflight(inflight);
                if (remaining) setCancelState(getGenerateRoot(), remaining, true);
                else setCancelState(getGenerateRoot(), null, false);
            }
        }
    }
}

/**
 * Re-apply the in-flight "Остановить" state after a tab re-render. Rendering
 * rebuilds the button DOM (losing data-request-id / hidden state), so the
 * in-flight map (chatId:msgId → Set of running requestIds) tells whether a
 * generation is in flight for the current post; the button is tagged with the
 * latest remaining requestId. Action buttons stay enabled regardless —
 * submissions are fire-and-forget.
 * @param {HTMLElement} root
 */
export function syncCancelState(root) {
    const { chatId, msgId } = activeScope(root);
    const requestId = msgId != null ? latestInflight(_inflightByScope.get(inflightKey(chatId, msgId))) : undefined;
    setCancelState(root, requestId, Boolean(requestId));
}

export function bindAbortUI() {
    if (_abortUIBound || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    _onStage1Start = onGenerationStart;
    _onStage1End = onGenerationEnd;
    _onStage2Start = onGenerationStart;
    _onStage2End = onGenerationEnd;
    window.addEventListener('uris:stage1-start', _onStage1Start);
    window.addEventListener('uris:stage1-end', _onStage1End);
    window.addEventListener('uris:stage2-start', _onStage2Start);
    window.addEventListener('uris:stage2-end', _onStage2End);
    _abortUIBound = true;
}

export function unbindAbortUI() {
    if (!_abortUIBound) return;
    if (_onStage1Start) window.removeEventListener('uris:stage1-start', _onStage1Start);
    if (_onStage1End) window.removeEventListener('uris:stage1-end', _onStage1End);
    if (_onStage2Start) window.removeEventListener('uris:stage2-start', _onStage2Start);
    if (_onStage2End) window.removeEventListener('uris:stage2-end', _onStage2End);
    _onStage1Start = null;
    _onStage1End = null;
    _onStage2Start = null;
    _onStage2End = null;
    _inflightByScope.clear();
    _abortUIBound = false;
}
