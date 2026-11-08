// @ts-check
/**
 * Custom-endpoint API key (localforage-backed; NOT in settings JSON — spec §10
 * like DS Comments). Leaf module: imports only the shared serialize mutex.
 * core.js re-exports getApiKey/setApiKey/LF_API_KEY for existing consumers.
 */
import { serialize } from './serialize.js';

export const LF_API_KEY = 'uris_custom_apikey';

// Writes go through the shared serialize() mutex. The revision guard stays: it
// is what makes the ordering meaningful. A read that started before a write
// resolves only after it, and without the guard it would publish that stale
// value back over the newer one. A superseded write bails out instead of
// landing an older value after a newer one.
const apiKeyState = { revision: 0, value: null };
const API_KEY_LOCK = 'uris-api-key';

export async function getApiKey() {
    const revision = apiKeyState.revision;
    try {
        const value = (await SillyTavern.libs.localforage.getItem(LF_API_KEY)) || '';
        if (revision === apiKeyState.revision) apiKeyState.value = value;
        return value;
    } catch { return ''; }
}

export function setApiKey(value) {
    const v = (value || '').trim();
    const revision = ++apiKeyState.revision;
    apiKeyState.value = v;
    return serialize(API_KEY_LOCK, async () => {
        if (revision !== apiKeyState.revision) return;
        try {
            if (v) await SillyTavern.libs.localforage.setItem(LF_API_KEY, v);
            else await SillyTavern.libs.localforage.removeItem(LF_API_KEY);
        } catch { /* non-critical */ }
    });
}
