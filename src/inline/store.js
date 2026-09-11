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
    const currentText = globalThis.SillyTavern?.getContext?.()?.chat?.[Number(msgId)]?.mes;
    if (!slot || (typeof slot.sourceText === 'string' && typeof currentText === 'string' && slot.sourceText !== currentText)) {
        return { messageHash: null, items: [] };
    }
    return {
        messageHash: slot.messageHash ?? null,
        items: Array.isArray(slot.items) ? slot.items : [],
    };
}

/** Белый список полей item'а — мусор из сырых данных не попадает в chatMetadata. */
const FIELDS = new Set(['idx', 'type', 'descHash', 'desc', 'status', 'imagePath', 'cardId', 'requestId', 'error', 'createdAt']);

/**
 * Вставить/обновить item по ключу (idx,type,descHash); опционально обновить
 * messageHash слота. Возвращает сохранённый item. Мерж защищён: белый список
 * полей, undefined-значения не затирают сохранённые, готовый (оплаченный)
 * результат не откатывается в pending (идемпотентность сканера).
 */
export function upsertItem(msgId, item, { messageHash } = {}) {
    const store = meta();
    if (!store) return null;
    const key = String(msgId);
    const sourceText = globalThis.SillyTavern?.getContext?.()?.chat?.[Number(msgId)]?.mes;
    let slot = store.msgs[key];
    if (!slot || (typeof sourceText === 'string' && typeof slot.sourceText === 'string' && sourceText !== slot.sourceText)) {
        slot = store.msgs[key] = { messageHash: messageHash ?? null, items: [] };
    }
    if (typeof sourceText === 'string') slot.sourceText = sourceText;
    if (messageHash != null) slot.messageHash = messageHash;
    const patch = Object.fromEntries(
        Object.entries(item).filter(([k, v]) => v !== undefined && FIELDS.has(k)));
    const k = itemKey(item);
    let existing = slot.items.find(i => itemKey(i) === k);
    if (!existing) {
        existing = { ...patch };
        slot.items.push(existing);
    } else {
        if (existing.status === 'ready' && patch.status === 'pending') delete patch.status;
        Object.assign(existing, patch);
    }
    persist();
    return existing;
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

/** Rebind stored results after ST reindexes messages. Ambiguous matches stay detached. */
export function reconcileMessageSlots() {
    const ctx = globalThis.SillyTavern?.getContext?.();
    const store = ctx?.chatMetadata?.[KEY];
    if (!store?.msgs || !Array.isArray(ctx.chat)) return;
    const moved = {};
    for (const [key, slot] of Object.entries(store.msgs)) {
        if (typeof slot?.sourceText !== 'string') continue;
        if (ctx.chat[Number(key)]?.mes === slot.sourceText && !moved[key]) {
            moved[key] = slot;
            continue;
        }
        const matches = ctx.chat.flatMap((msg, index) => msg.mes === slot.sourceText ? [index] : []);
        if (matches.length === 1 && !moved[String(matches[0])]) moved[String(matches[0])] = slot;
    }
    store.msgs = moved;
    persist();
}

/** Remove an explicitly identified slot; ST MESSAGE_DELETED supplies length, not this id. */
export function dropMessage(msgId) {
    const store = meta();
    if (!store?.msgs) return;
    delete store.msgs[String(msgId)];
    persist();
}
