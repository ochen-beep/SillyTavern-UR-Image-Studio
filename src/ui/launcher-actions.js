// @ts-check
/**
 * Launcher long-press menu (bar button + FAB): quick paid actions without
 * opening the window. Replaces the per-message 📷 buttons removed from chat.
 *
 * Split: the gesture decision and the action dispatch are pure/unit-tested
 * (tests/launcher-actions.test.js); attachHold is the pointer glue shared by
 * the bar button (index.js), the FAB integrates the same constants inside its
 * own drag pipeline (floating-launcher.js). The menu itself is the generic
 * openCardActionMenu — the same component the pool chips use.
 *
 * Actions:
 *   - story-last: full pipeline (Stage 1 text LLM + Stage 2 paid image) on the
 *     last eligible AI post, result embedded as a manual inline shell in the
 *     post (pending spinner → collapsed chip/image → shared lightbox).
 *   - inline-last: the old 📷 action — trigger-profile reroll of the post text.
 *   - gallery: open the window straight on the gallery tab.
 */

import { getCtx, state } from '../core.js';
import { isGenerationEligible } from '../post-navigator.js';
import { rerollInline, stableHash, normalizeAnchorText } from '../inline/runner.js';
import { upsertItem } from '../inline/store.js';
import { runFullPipelineForDraft } from '../pipeline-stage1.js';
import { reconcileVisible } from '../inline/render.js';
import { openCardActionMenu } from './card-action-menu.js';
import { setActiveTab } from './tabs.js';

// Hold duration (ms) separating a click from the menu; pointer travel (px)
// separating any press from a drag. One source for bar + FAB.
export const HOLD_MS = 550;
export const DRAG_THRESHOLD_PX = 6;

/**
 * Classify one press. Pure: tests pin the boundaries (release before the hold
 * → click; hold past it without movement → menu; travel past the threshold →
 * drag, even on a long press).
 * @param {{heldMs: number, maxMovePx: number, holdMs?: number, dragThresholdPx?: number}} g
 * @returns {'click'|'menu'|'drag'}
 */
export function evaluateGesture({ heldMs, maxMovePx, holdMs = HOLD_MS, dragThresholdPx = DRAG_THRESHOLD_PX }) {
    if (maxMovePx > dragThresholdPx) return 'drag';
    return heldMs >= holdMs ? 'menu' : 'click';
}

/**
 * Target for the draw actions: the last post that is an AI message with
 * visible content (system/hidden/empty/reasoning-only posts never generate —
 * same eligibility the RENDERED automation uses).
 * @param {Array<{mes?: string, is_user?: boolean, is_system?: boolean, is_hidden?: boolean}>|null} chat
 * @returns {number|null} message index or null when nothing qualifies
 */
export function resolveLastAiPostId(chat) {
    const list = Array.isArray(chat) ? chat : [];
    for (let i = list.length - 1; i >= 0; i--) {
        const msg = list[i];
        if (msg && !msg.is_user && isGenerationEligible(msg)) return i;
    }
    return null;
}

/**
 * Pipeline card → inline store item (idx -1 = manual shell, keyed by desc).
 * Same key shape the old 📷 button used, so pending → ready upgrades in place.
 * @param {{card: {id?: string, imagePath?: string, prompt?: string}, desc: string, anchorText?: string|null}} input
 */
export function buildEmbedItem({ card, desc, anchorText = null }) {
    return {
        idx: -1,
        type: 'img',
        desc,
        descHash: stableHash(`img|${desc}`),
        status: 'ready',
        imagePath: String(card?.imagePath || ''),
        cardId: card?.id || null,
        anchorText: anchorText || undefined,
    };
}

// ── Story-shell anchor: which post paragraph the picture illustrates ──

/**
 * First Cyrillic quote in the Stage 1 prompt. Primary source: the base
 * template's `Subtitle: … "Exact short quote in Russian"` line (the quote is
 * rendered into the image as a caption, so it names the exact moment); falls
 * back to any other quoted Cyrillic phrase. English-only quotes (character
 * names in the Characters section) are ignored. Pure, unit-tested.
 * @param {string} prompt
 * @returns {string|null}
 */
export function extractAnchorQuote(prompt) {
    const text = String(prompt || '');
    const candidates = [];
    const subtitle = text.match(/Subtitle:[^\n]*?"([^"\n]{2,120})"/i);
    if (subtitle) candidates.push(subtitle[1]);
    for (const m of text.matchAll(/"([^"\n]{2,120})"/g)) candidates.push(m[1]);
    for (const quote of candidates) {
        const words = quote.trim().split(/\s+/).filter(Boolean);
        if (words.length > 12) continue;
        if (/\p{Script=Cyrillic}/u.test(quote)) return quote.trim();
    }
    return null;
}

/**
 * Best post paragraph for an anchor quote: token overlap (same language —
 * the base template asks for a Russian quote while the post is Russian).
 * Ties → the FIRST paragraph; below the threshold → null (caller falls back
 * to append-at-end). Returns the paragraph's normalized text (not a hash):
 * the DOM side matches by containment, because ST regroups markdown lines
 * into its own <p> blocks when rendering. Pure, unit-tested.
 * @param {string} postText
 * @param {string|null} quote
 * @returns {{index: number, anchorText: string}|null}
 */
export function pickAnchorParagraph(postText, quote) {
    const normalizedQuote = normalizeAnchorText(quote);
    if (!normalizedQuote) return null;
    const quoteTokens = new Set(normalizedQuote.split(' ').filter(t => t.length >= 2));
    if (!quoteTokens.size) return null;
    const paragraphs = String(postText || '')
        .split(/\n{2,}|\n/)
        .map(p => p.trim())
        .filter(Boolean);
    let best = null;
    for (let index = 0; index < paragraphs.length; index++) {
        const norm = normalizeAnchorText(paragraphs[index]);
        if (!norm) continue;
        const tokens = new Set(norm.split(' '));
        let hits = 0;
        for (const t of quoteTokens) if (tokens.has(t)) hits += 1;
        const ratio = hits / quoteTokens.size;
        const qualifies = hits >= 2 || ratio >= 0.3;
        if (!qualifies) continue;
        // Strictly greater: ties keep the earlier paragraph.
        if (!best || hits > best.hits) best = { index, hits, norm };
    }
    if (!best) return null;
    return { index: best.index, anchorText: best.norm.slice(0, 160) };
}

/** Anchor for a finished story pipeline (null when the end-placement toggle
 * is on, the prompt has no usable quote, or nothing matched). */
function resolveStoryAnchor(messageText, prompt) {
    if (state.settings?.launcherShellAtEnd === true) return null;
    const quote = extractAnchorQuote(prompt);
    if (!quote) return null;
    return pickAnchorParagraph(messageText, quote);
}

/**
 * Dispatch one menu action against injected deps (prod wiring in
 * makeLauncherDeps; tests pass fakes). Unknown actions and an empty target
 * fail loudly — a silent no-op would hide a missed paid run.
 * @param {'gallery'|'inline-last'|'story-last'|string} id
 * @param {{getChat?: Function, getChatId?: Function, rerollInline?: Function, runFullPipeline?: Function, embedCard?: Function, openGalleryTab?: Function}} deps
 */
export async function runLauncherAction(id, deps = {}) {
    if (id === 'gallery') {
        await deps.openGalleryTab?.();
        return;
    }
    const chat = await deps.getChat?.();
    const msgId = resolveLastAiPostId(chat);
    if (msgId == null) throw new Error('Нет подходящего AI-сообщения для генерации');
    if (id === 'inline-last') {
        const desc = String(chat[msgId].mes || '').slice(0, 4000);
        await deps.rerollInline?.({ msgId, idx: -1, type: 'img', desc });
        return;
    }
    if (id === 'story-last') {
        const messageText = String(chat[msgId].mes || '');
        const desc = messageText.slice(0, 4000);
        const card = await deps.runFullPipeline?.({ chatId: await deps.getChatId?.(), msgId, messageText });
        if (!card || !card.imagePath) throw new Error('Пайплайн не вернул картинку');
        await deps.embedCard?.(card, msgId, desc, messageText);
        return;
    }
    throw new Error(`Неизвестное действие лаунчера: ${id}`);
}

// ── Prod wiring (not unit-tested; graph-covered by integration suites) ──

let _togglePanel = null;

/** One-time wiring from index.js: the panel toggle reused by «Открыть галерею». */
export function initLauncherActions({ togglePanel } = {}) {
    if (typeof togglePanel === 'function') _togglePanel = togglePanel;
}

function launcherDeps() {
    return {
        getChat: () => { try { return getCtx()?.chat || []; } catch { return []; } },
        getChatId: () => state.currentChatId ?? null,
        rerollInline: (job) => {
            // queueInlineJob writes the pending item itself; one reconcile
            // mounts the shell without waiting for the inline event.
            rerollInline(job);
            reconcileVisible();
        },
        runFullPipeline: async (input) => {
            const desc = String(input.messageText || '').slice(0, 4000);
            upsertItem(input.msgId, {
                idx: -1, type: 'img', desc,
                descHash: stableHash(`img|${desc}`),
                status: 'pending', createdAt: Date.now(),
            });
            reconcileVisible();
            try {
                const card = await runFullPipelineForDraft(input);
                if (!card || !card.imagePath) {
                    // Fingerprint match etc.: nothing new was paid — say so on
                    // the shell instead of a forever-spinner.
                    throw new Error('Картинка для этого текста уже сгенерирована');
                }
                const anchor = resolveStoryAnchor(input.messageText, card?.prompt);
                upsertItem(input.msgId, buildEmbedItem({ card, desc, anchorText: anchor?.anchorText || null }));
                reconcileVisible();
                return card;
            } catch (e) {
                upsertItem(input.msgId, {
                    idx: -1, type: 'img', desc,
                    descHash: stableHash(`img|${desc}`),
                    status: 'error', error: String(e?.message || e).slice(0, 200),
                });
                reconcileVisible();
                throw e;
            }
        },
        embedCard: (card, msgId, desc, messageText = '') => {
            const anchor = resolveStoryAnchor(messageText, card?.prompt);
            upsertItem(msgId, buildEmbedItem({ card, desc, anchorText: anchor?.anchorText || null }));
            reconcileVisible();
        },
        openGalleryTab: async () => {
            if (state.settings.collapsed !== false && _togglePanel) await _togglePanel();
            setActiveTab('gallery');
        },
    };
}

function safeRun(id) {
    Promise.resolve(runLauncherAction(id, launcherDeps())).catch((e) => {
        try { toastr?.error(e?.message || e, 'URIS'); } catch { /* node */ }
    });
}

/** Menu shown by the hold gesture on either launcher button. */
export function showLauncherMenu(anchorEl) {
    const r = (anchorEl && typeof anchorEl.getBoundingClientRect === 'function')
        ? anchorEl.getBoundingClientRect()
        : { left: 40, width: 0, bottom: 40 };
    openCardActionMenu({
        title: 'UR Image Studio',
        x: r.left + (r.width || 0) / 2,
        y: r.bottom + 6,
        items: [
            { id: 'story', icon: 'fa-wand-magic-sparkles', label: 'Нарисовать по истории',
                onSelect: () => safeRun('story-last') },
            { id: 'inline', icon: 'fa-camera', label: 'Нарисовать инлайн',
                onSelect: () => safeRun('inline-last') },
            { id: 'gallery', icon: 'fa-images', label: 'Открыть галерею',
                onSelect: () => safeRun('gallery') },
        ],
    });
}

/**
 * Pointer hold binding for the bar launcher button. Menu gesture: hold (touch,
 * pen and mouse-left alike) OR plain right-click on the desktop — the same
 * pairing the pool chips use via bindCardContextMenu. Owns the full left
 * click too: the caller must NOT add a separate click listener (a fired menu
 * suppresses the trailing click through this binding, not through the
 * caller's).
 * @param {HTMLElement} el
 * @param {{onClick?: Function, onMenu?: Function, holdMs?: number, dragThresholdPx?: number}} opts
 */
export function attachHold(el, { onClick, onMenu, holdMs = HOLD_MS, dragThresholdPx = DRAG_THRESHOLD_PX } = {}) {
    let active = false;
    let menuShown = false;
    let downAt = 0;
    let downType = '';
    let startX = 0;
    let startY = 0;
    let maxMove = 0;
    let timer = null;

    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const buzz = () => { try { navigator?.vibrate?.(30); } catch { /* unsupported */ } };

    el.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        active = true;
        menuShown = false;
        downType = e.pointerType || '';
        downAt = Date.now();
        startX = e.clientX;
        startY = e.clientY;
        maxMove = 0;
        clearTimer();
        timer = setTimeout(() => {
            timer = null;
            menuShown = true;
            buzz();
            onMenu?.(el);
        }, holdMs);
    });

    el.addEventListener('pointermove', (e) => {
        if (!active) return;
        maxMove = Math.max(maxMove, Math.hypot(e.clientX - startX, e.clientY - startY));
        if (maxMove > dragThresholdPx) clearTimer();
    });

    // contextmenu is a MouseEvent (no pointerType): right-click on the desktop
    // opens the menu directly; a touch/pen long-press also synthesizes it —
    // there the hold timer owns the opening, so the event is only silenced
    // (Android fires it ~500ms, just before our holdMs threshold).
    el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const holdOwnsIt = active || menuShown || (downType && downType !== 'mouse');
        if (holdOwnsIt) return;
        menuShown = true;
        setTimeout(() => { menuShown = false; }, 400);
        onMenu?.(el);
    });

    el.addEventListener('pointerup', (e) => {
        if (!active) return;
        active = false;
        const heldMs = Date.now() - downAt;
        const wasMenu = menuShown;
        menuShown = false;
        clearTimer();
        const gesture = wasMenu ? 'menu' : evaluateGesture({ heldMs, maxMovePx: maxMove, holdMs, dragThresholdPx });
        if (gesture === 'menu') {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (gesture === 'click') onClick?.(el);
        // 'drag' on a non-draggable bar button: nothing.
    });

    el.addEventListener('pointercancel', () => {
        active = false;
        menuShown = false;
        clearTimer();
    });
}
