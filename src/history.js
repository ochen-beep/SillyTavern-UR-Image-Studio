// @ts-check
/**
 * History of recently edited prompts (dropdown in the editor).
 * v2: rich record support {prompt, ts, style, sourceMsgId} instead of strings.
 * Enable/disable via state.settings.historyRich.
 */
import { LF_HISTORY_PREFIX, state } from './core.js';

function key(chatId) { return LF_HISTORY_PREFIX + chatId; }
function lf() { return SillyTavern.libs.localforage; }

export async function getHistory(chatId) {
    const arr = await lf().getItem(key(chatId));
    return Array.isArray(arr) ? arr : [];
}

/**
 * Add a prompt to the history.
 * @param {string} chatId
 * @param {string} promptText
 * @param {object} [meta] — {style?, sourceMsgId?} for rich mode
 */
export async function pushHistory(chatId, promptText, meta = {}) {
    if (!promptText) return;
    let arr = await getHistory(chatId);
    const rich = state.settings.historyRich;

    if (rich) {
        // Rich entry: deduplicate by prompt, keep ts/style/sourceMsgId
        const item = {
            prompt: promptText,
            ts: Date.now(),
            style: meta.style || '',
            sourceMsgId: meta.sourceMsgId ?? null,
        };
        arr = arr.filter(x => (typeof x === 'string' ? x : x.prompt) !== promptText);
        arr.unshift(item);
    } else {
        // Plain entry: deduplicate by prompt text.
        arr = arr.filter(x => (typeof x === 'string' ? x : x.prompt) !== promptText);
        arr.unshift(promptText);
    }

    // ?? keeps 0 as "no limit" (intended), || — doesn't.
    const limit = state.settings.historyLimit ?? 20;
    arr = arr.slice(0, limit);
    await lf().setItem(key(chatId), arr);
}

export async function clearHistory(chatId) {
    await lf().removeItem(key(chatId));
}
