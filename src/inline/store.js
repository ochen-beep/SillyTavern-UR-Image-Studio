// @ts-check
/**
 * Слоты инлайн-результатов в chatMetadata текущего чата:
 *   chatMetadata.uris_inline = { v: 1, cfg: {enabled, listenUser}, msgs: { [msgId]: {messageHash, items[]} } }
 * Идемпотентность: перезагрузка находит item по (idx,type,descHash) и не
 * перегенерирует. chatMetadata уезжает с экспортом чата; на машине без файлов
 * картинок оболочка покажет «файл недоступен — перегенерировать?» (рендер).
 */

const KEY = 'uris_inline';
const SCHEMA_V = 1;

function meta() {
    const ctx = globalThis.SillyTavern?.getContext?.() || {};
    const md = ctx.chatMetadata;
    if (!md || typeof md !== 'object') return null;
    if (!md[KEY] || typeof md[KEY] !== 'object') md[KEY] = { v: SCHEMA_V, cfg: { enabled: false, listenUser: false }, msgs: {} };
    const store = md[KEY];
    if (!store.msgs || typeof store.msgs !== 'object') store.msgs = {};
    if (!store.cfg || typeof store.cfg !== 'object') store.cfg = { enabled: false, listenUser: false };
    return store;
}

function persist() {
    try { globalThis.SillyTavern?.getContext?.()?.saveMetadataDebounced?.(); } catch { /* тесты */ }
}

/** Слот сообщения (или пустой). msgId приводится к строке-ключу. */
export function getSlot(msgId) {
    const store = meta();
    const slot = store?.msgs?.[String(msgId)];
    if (!slot) return { messageHash: null, items: [] };
    return {
        messageHash: slot.messageHash ?? null,
        items: Array.isArray(slot.items) ? slot.items : [],
    };
}

/**
 * Вставить/обновить item по ключу (idx,type,descHash); опционально обновить
 * messageHash слота. Возвращает сохранённый item.
 */
export function upsertItem(msgId, item, { messageHash } = {}) {
    const store = meta();
    if (!store) return null;
    const key = String(msgId);
    const slot = store.msgs[key] || (store.msgs[key] = { messageHash: messageHash ?? null, items: [] });
    if (messageHash != null) slot.messageHash = messageHash;
    const k = itemKey(item);
    const existing = slot.items.find(i => itemKey(i) === k);
    if (existing) Object.assign(existing, item);
    else slot.items.push({ ...item });
    persist();
    return existing || slot.items[slot.items.length - 1];
}

/** Ключ сопоставления item'ов. */
export function itemKey(item) {
    return `${item.idx}|${item.type}|${item.descHash}`;
}

export function getConfig() {
    const store = meta();
    return { enabled: false, listenUser: false, ...(store?.cfg || {}) };
}

export function setConfig(patch) {
    const store = meta();
    if (!store) return getConfig();
    store.cfg = { ...store.cfg, ...patch };
    persist();
    return { ...store.cfg };
}

/** Удалить слот сообщения (MESSAGE_DELETED). */
export function dropMessage(msgId) {
    const store = meta();
    if (!store?.msgs) return;
    delete store.msgs[String(msgId)];
    persist();
}
