// @ts-check
/**
 * Studio scope: a virtual generation context for the SillyTavern welcome
 * screen, where no chat is open (ctx.chatId is null).
 *
 * The generation pipeline is scoped by chatId everywhere (schema-v5 config
 * envelope, reference binding, draft keys, gallery provenance, image folder).
 * That scope routes through resolveActiveChatId(): the real chatId when a chat
 * is open, STUDIO_CHAT_ID otherwise. Paths that genuinely need messages
 * (auto-generation, inline scanner, post navigator) keep reading ctx.chatId
 * directly and stay inert in the studio.
 *
 * The studio config persists in its own server file (uris_studio.json):
 * chatMetadata does not exist without an open chat, so a chat-scoped write on
 * the welcome screen would land in a transient object and vanish. The file
 * holds the same schema-v5 envelope as the chat binding, so chat-binding.js
 * normalization applies unchanged.
 */
import { getCtx, getDefaultChatConfigEnvelope } from './core.js';
import { createFileStore } from './file-store.js';

/**
 * Reserved scope id. Real chat ids look like «Char - 3» / group ids; a
 * leading double underscore cannot collide with either. It surfaces in draft
 * keys (encodeURIComponent-safe) and gallery provenance.chatId.
 */
export const STUDIO_CHAT_ID = '__uris_studio__';
/** The studio owns a single draft; draft keys need a non-negative integer msgId. */
export const STUDIO_MSG_ID = 0;
/** Native-storage folder for images generated outside a chat. */
export const STUDIO_IMAGE_FOLDER = 'URIS Studio';

export const STUDIO_FILE_NAME = 'uris_studio.json';
export const STUDIO_STORE_VERSION = 1;

/** True when the extension UI runs without an open chat (welcome screen). */
export function isStudioActive() {
    try { return !getCtx()?.chatId; } catch { return false; }
}

/** The chatId the generation pipeline should scope its data to right now. */
export function resolveActiveChatId() {
    return isStudioActive() ? STUDIO_CHAT_ID : getCtx().chatId;
}

const studioStore = createFileStore({
    label: 'studio',
    name: STUDIO_FILE_NAME,
    version: STUDIO_STORE_VERSION,
    key: 'data',
    // A scalar config envelope, not a record collection: the generic union
    // merge would be meaningless here, and the studio is edited from one
    // device at a time.
    mergeWithServer: false,
    empty: () => getDefaultChatConfigEnvelope(),
    countEntries: value => (value && typeof value === 'object' && value.config ? 1 : 0),
});

/** Resolve the studio store (probe / load) exactly once per session. */
export function ensureStudioStoreReady() {
    return studioStore.ready();
}

export function studioStoreMode() { return studioStore.mode(); }

/** Await durability of queued studio writes. */
export function flushStudioWrites() {
    return studioStore.flush();
}

/**
 * Raw schema-v5 envelope read for the routing in chat-binding.js and
 * refs-library.js. Null before the first save (callers then apply defaults);
 * also null when the store has not finished probing, which is why every async
 * entry point awaits ensureStudioStoreReady() before reading.
 */
export function getStudioBinding() {
    const snapshot = studioStore.snapshot();
    return snapshot && typeof snapshot === 'object' ? snapshot : null;
}

/**
 * Replace the studio envelope and schedule the persist. `replace` (not
 * `mutate`): the store's mutator edits its mirror in place, so a whole-value
 * write must go through the replace path. The persistence is fire-and-forget
 * (writes coalesce into one upload) — durability is awaited via
 * flushStudioWrites() on unload / disable, like the other stores.
 */
export function saveStudioBinding(binding) {
    try {
        void studioStore.replace(binding).catch(() => {});
    } catch { /* the mirror write must never break a render path */ }
    return binding;
}

/** Test-only: drop all session state so a fresh probe can run. */
export function resetStudioStoreForTests() {
    studioStore.reset();
}
