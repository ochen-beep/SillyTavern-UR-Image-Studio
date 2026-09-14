// @ts-check
/**
 * Слоты инлайн-результатов в chatMetadata текущего чата:
 *   chatMetadata.uris_inline = { v: 1, cfg: {enabled, listenUser}, msgs: { [msgId]: {messageHash, sourceText, items[]} } }
 * Идемпотентность: item'ы сопоставляются по (idx,type,descHash); готовый
 * (оплаченный) результат не откатывается в pending/error. Правка текста
 * сообщения НЕ сбрасывает слот: готовые item'ы остаются (совпадение по
 * idx|type с другим descHash DOM-слой покажет как «changed» — перерисовка
 * вручную), чужие текущим маркерам item'ы просто не рендерятся. Стирать
 * оплаченные результаты за правку слова нельзя — платная автогенерация
 * поверх правки была бы двойным списанием.
 * sourceText хранится ТОЛЬКО для reconcileMessageSlots (rebind после
 * реиндексации ST при удалении сообщения) и на чтение не влияет.
 * chatMetadata уезжает с экспортом чата; на машине без файлов картинок
 * оболочка покажет ошибку с retry (рендер: ready без файла → error).
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

/** Слот сообщения (или пустой). msgId приводится к строке-ключу.
 * Гейта по sourceText нет сознательно: правка текста — не причина прятать
 * оплаченные item'ы. */
export function getSlot(msgId) {
    const store = meta();
    const slot = store?.msgs?.[String(msgId)];
    if (!slot) return { messageHash: null, items: [] };
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
 * результат не откатывается ни в pending (идемпотентность сканера), ни в
 * error (гонка cancelPending против только что завершившейся задачи; второй
 * такой же гард — wasReady в runner.processJob).
 */
export function upsertItem(msgId, item, { messageHash } = {}) {
    const store = meta();
    if (!store) return null;
    const key = String(msgId);
    let slot = store.msgs[key];
    if (!slot) slot = store.msgs[key] = { messageHash: messageHash ?? null, items: [] };
    if (messageHash != null) slot.messageHash = messageHash;
    // Свежий текст сообщения — исключительно для reconcileMessageSlots.
    const sourceText = globalThis.SillyTavern?.getContext?.()?.chat?.[Number(msgId)]?.mes;
    if (typeof sourceText === 'string') slot.sourceText = sourceText;
    const patch = Object.fromEntries(
        Object.entries(item).filter(([k, v]) => v !== undefined && FIELDS.has(k)));
    const k = itemKey(item);
    let existing = slot.items.find(i => itemKey(i) === k);
    if (!existing) {
        existing = { ...patch };
        slot.items.push(existing);
    } else {
        if (existing.status === 'ready' && patch.status && patch.status !== 'ready') delete patch.status;
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

/** Rebind stored slots after ST reindexes messages (MESSAGE_DELETED). Matching
 * по сохранённому sourceText: точное совпадение на месте → остаётся; ровно
 * одно совпадение в другом сообщении → переносится; иначе слот ОСТАЁТСЯ на
 * своём ключе — выбрасывать оплаченные item'ы из-за неоднозначности нельзя
 * (не совпавшие с маркерами item'ы рендер не показывает). */
export function reconcileMessageSlots() {
    const ctx = globalThis.SillyTavern?.getContext?.();
    const store = ctx?.chatMetadata?.[KEY];
    if (!store?.msgs || !Array.isArray(ctx.chat)) return;
    const moved = {};
    for (const [key, slot] of Object.entries(store.msgs)) {
        if (typeof slot?.sourceText !== 'string') { if (!moved[key]) moved[key] = slot; continue; }
        if (ctx.chat[Number(key)]?.mes === slot.sourceText) { if (!moved[key]) moved[key] = slot; continue; }
        const matches = ctx.chat.flatMap((msg, index) => msg.mes === slot.sourceText ? [index] : []);
        if (matches.length === 1 && !moved[String(matches[0])]) moved[String(matches[0])] = slot;
        else if (!moved[key]) moved[key] = slot;
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
