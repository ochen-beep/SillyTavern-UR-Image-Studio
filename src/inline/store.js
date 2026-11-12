// @ts-check
/**
 * Состояние картинок поста (spec docs/2026-11-13-inline-carousel-design.md):
 *   msg.extra.uris = { v: 1, items: Item[] } — на ОБЪЕКТЕ сообщения.
 * ST 1.19 чекаутит extra per-свайп (script.js:6939/:7015): снапшот варианта
 * хранит свои items, переключение свайпа подменяет extra целиком; удаление
 * сообщения уносит состояние вместе с объектом — rebind/GC не нужны.
 * chatMetadata.uris_inline хранит только cfg (enabled/listenUser) и legacy-слоты
 * (читаются до миграции / для отката версии; migratedAt → новым кодом игнорируются).
 * Digest-инвариант: item.digest = hashMessage(текст варианта на момент генерации);
 * расхождение рендер показывает как «текст изменился», никогда — тихое устаревание.
 * Записи в extra сохраняются saveChat (свой дебаунс + flushChatSave на выгрузке).
 */

import { fnv1aHex } from '../core.js';
import { hashMessage } from '../generation-drafts.js';

const URIS_KEY = 'uris';
const LEGACY_KEY = 'uris_inline';
const SCHEMA_V = 1;

/** Белый список полей item'а — мусор из сырых данных не попадает в файл чата. */
const FIELDS = new Set([
    'idx', 'type', 'origin', 'status', 'descHash', 'digest',
    'imagePath', 'cardId', 'cardIds', 'anchorText', 'requestId', 'error', 'createdAt',
]);

function chatCtx() {
    try { return globalThis.SillyTavern?.getContext?.() || {}; } catch { return {}; }
}

function msgOf(msgId) {
    return chatCtx().chat?.[Number(msgId)] || null;
}

/** Контейнер extra.uris на объекте (создаёт при записи). */
function ensureContainer(obj) {
    if (!obj.extra || typeof obj.extra !== 'object') obj.extra = {};
    if (!obj.extra[URIS_KEY] || typeof obj.extra[URIS_KEY] !== 'object') {
        obj.extra[URIS_KEY] = { v: SCHEMA_V, items: [] };
    }
    if (!Array.isArray(obj.extra[URIS_KEY].items)) obj.extra[URIS_KEY].items = [];
    return obj.extra[URIS_KEY];
}

/** Текст варианта i по правилам самого ST (swipes[i] ?? mes для текущего). */
function variantTextAt(msg, i) {
    const swipes = Array.isArray(msg.swipes) ? msg.swipes : null;
    if (swipes && swipes[i] !== undefined) return String(swipes[i] ?? '');
    const current = Number(msg.swipe_id ?? 0);
    if ((!swipes || !swipes.length) && i === 0) return String(msg.mes ?? '');
    if (i === current) return String(msg.mes ?? '');
    return null;
}

/**
 * Контейнер для записи: variantIdx по умолчанию — текущий свайп (live).
 * Чужой существующий вариант → снапшот swipe_info[variantIdx].extra.
 * Несуществующий вариант → null (запись отклоняется).
 */
function targetFor(msg, variantIdx) {
    const swipes = Array.isArray(msg.swipes) ? msg.swipes : [];
    const want = Number(variantIdx ?? msg.swipe_id ?? 0);
    if (!Number.isInteger(want) || want < 0) return null;
    if (swipes.length && want !== Number(msg.swipe_id ?? 0)) {
        if (want >= swipes.length) return null;
        const snap = Array.isArray(msg.swipe_info) ? msg.swipe_info[want] : null;
        if (!snap || typeof snap !== 'object') return null;
        return ensureContainer(snap);
    }
    return ensureContainer(msg);
}

/** Ключ сопоставления item'ов. */
export function itemKey(item) {
    return `${item.idx}|${item.type}|${item.descHash}`;
}

// ── Дебаунс saveChat: записи в extra сохраняются чатом, не metadata ──

let saveTimer = null;

function scheduleChatSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try { chatCtx().saveChat?.(); } catch { /* node-тесты */ }
    }, 800);
}

/** Немедленный флеш отложенной записи чата (выгрузка страницы, тесты). */
export function flushChatSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { chatCtx().saveChat?.(); } catch { /* node-тесты */ }
}

// ── Чтение ──

/**
 * Items поста: live extra.uris; до миграции — legacy-слот uris_inline
 * (migratedAt-слоты новым кодом игнорируются, читаются только старой версией).
 * @returns {{messageHash: null, items: Array}}
 */
export function getSlot(msgId) {
    const msg = msgOf(msgId);
    const cont = msg?.extra?.[URIS_KEY];
    if (Array.isArray(cont?.items)) return { messageHash: null, items: cont.items };
    const legacy = chatCtx().chatMetadata?.[LEGACY_KEY]?.msgs?.[String(msgId)];
    if (legacy && !legacy.migratedAt && Array.isArray(legacy.items)) {
        return { messageHash: null, items: legacy.items };
    }
    return { messageHash: null, items: [] };
}

// ── Запись ──

/**
 * Вставить/обновить item по ключу (idx,type,descHash) в контейнер варианта.
 * Гард v1 сохранён: готовый (оплаченный) ready не откатывается в pending/error;
 * requestId стирается при выходе из pending. undefined-значения не затирают.
 * @returns {object|null} сохранённый item (null — нет поста/варианта)
 */
export function upsertItem(msgId, item, { variantIdx } = {}) {
    const msg = msgOf(msgId);
    if (!msg || !item || typeof item !== 'object') return null;
    const container = targetFor(msg, variantIdx);
    if (!container) return null;
    const patch = Object.fromEntries(
        Object.entries(item).filter(([k, v]) => v !== undefined && FIELDS.has(k)));
    const key = itemKey(patch);
    let existing = container.items.find(i => itemKey(i) === key);
    if (!existing) {
        existing = { ...patch };
        container.items.push(existing);
    } else {
        if (existing.status === 'ready' && patch.status && patch.status !== 'ready') delete patch.status;
        Object.assign(existing, patch);
        if (existing.status && existing.status !== 'pending') delete existing.requestId;
    }
    scheduleChatSave();
    return existing;
}

/** Удалить item по ключу из контейнера варианта. */
export function deleteItem(msgId, key, { variantIdx } = {}) {
    const msg = msgOf(msgId);
    if (!msg || !key) return false;
    const container = targetFor(msg, variantIdx);
    if (!container) return false;
    const index = container.items.findIndex(i => itemKey(i) === key);
    if (index === -1) return false;
    container.items.splice(index, 1);
    scheduleChatSave();
    return true;
}

/**
 * Приклеить платную карточку к карусели поста (attach-хук Stage 2). Вариант
 * ищется по digest (текст варианта, из которого генерировали); карточка
 * добавляется в cardIds item'а с этим digest (или создаёт story-item),
 * обложка ← последняя. Идемпотентно по cardId.
 * @returns {object|null} затронутый item
 */
export function attachCard(msgId, digest, cardId, imagePath) {
    const msg = msgOf(msgId);
    if (!msg || !cardId || !digest) return null;
    const swipes = Array.isArray(msg.swipes) ? msg.swipes : [];
    let variantIdx = Number(msg.swipe_id ?? 0);
    let matched = false;
    for (let i = 0; i < swipes.length; i++) {
        const text = variantTextAt(msg, i);
        if (text != null && hashMessage(text) === digest) { variantIdx = i; matched = true; break; }
    }
    if (!matched) {
        const text = variantTextAt(msg, variantIdx);
        if (text == null || hashMessage(text) !== digest) return null; // текст изменился
    }
    const container = targetFor(msg, variantIdx);
    if (!container) return null;
    // Несколько story-запусков на одном варианте — валидно (повторы): карточка
    // клеится к САМОМУ СВЕЖЕМУ item'у с этим digest.
    let item = container.items        .filter(i => Number(i.idx) < 0 && i.digest === digest)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
    if (!item) {
        item = {
            idx: -1, type: 'img', origin: 'story', status: 'ready',
            descHash: fnv1aHex(`story|${digest}`), digest,
            imagePath: String(imagePath || ''), cardId, cardIds: [cardId],
            createdAt: Date.now(),
        };
        container.items.push(item);
    } else {
        if (!Array.isArray(item.cardIds)) item.cardIds = [];
        if (!item.cardIds.includes(cardId)) item.cardIds.push(cardId);
        item.cardId = cardId;
        item.imagePath = String(imagePath || '');
        if (item.status !== 'ready' && item.imagePath) item.status = 'ready';
    }
    scheduleChatSave();
    return item;
}

/**
 * Вычеркнуть карточку из всех items текущего чата (live + снапшоты). Обложка,
 * у которой ушла карточка, ← последняя из оставшихся (imagePath резолвит
 * caller по карточке галереи); пустой список → item удаляется вовсе.
 * @returns {Array<{msgId:number, key:string, needsCover:boolean, newCoverCardId?:string}>}
 */
export function removeCardFromItems(cardId) {
    const chat = chatCtx().chat || [];
    const touched = [];
    for (let mi = 0; mi < chat.length; mi++) {
        const msg = chat[mi];
        if (!msg) continue;
        const containers = [];
        const live = msg.extra?.[URIS_KEY];
        if (Array.isArray(live?.items)) containers.push(live);
        if (Array.isArray(msg.swipe_info)) {
            for (const snap of msg.swipe_info) {
                const cont = snap?.extra?.[URIS_KEY];
                if (Array.isArray(cont?.items) && cont !== live) containers.push(cont);
            }
        }
        for (const cont of containers) {
            for (const item of [...cont.items]) {
                if (!Array.isArray(item.cardIds) || !item.cardIds.includes(cardId)) continue;
                item.cardIds = item.cardIds.filter(id => id !== cardId);
                if (!item.cardIds.length) {
                    cont.items.splice(cont.items.indexOf(item), 1);
                    touched.push({ msgId: mi, key: itemKey(item), needsCover: false });
                    continue;
                }
                if (item.cardId === cardId) {
                    item.cardId = item.cardIds[item.cardIds.length - 1];
                    item.imagePath = '';
                    touched.push({ msgId: mi, key: itemKey(item), needsCover: true, newCoverCardId: item.cardId });
                } else {
                    touched.push({ msgId: mi, key: itemKey(item), needsCover: false });
                }
            }
        }
    }
    if (touched.length) scheduleChatSave();
    return touched;
}

// ── Миграция legacy-слотов (один раз, идемпотентно) ──

/**
 * Разложить legacy uris_inline.msgs на объекты сообщений. Точное совпадение
 * sourceText на своём индексе → остаётся; единственное совпадение в другом
 * посте → переносится; иначе слот помечается migratedAt и остаётся для отката.
 * @returns {number} число перенесённых item'ов
 */
export function migrateLegacySlots() {
    const ctx = chatCtx();
    const store = ctx.chatMetadata?.[LEGACY_KEY];
    if (!store?.msgs || !Array.isArray(ctx.chat)) return 0;
    let moved = 0;
    for (const [key, slot] of Object.entries(store.msgs)) {
        if (!slot || slot.migratedAt) continue;
        slot.migratedAt = Date.now();
        if (!Array.isArray(slot.items) || !slot.items.length) continue;
        let idx = Number(key);
        if (!Number.isInteger(idx) || idx < 0 || ctx.chat[idx]?.mes !== slot.sourceText) {
            const matches = ctx.chat.flatMap((m, i) => m?.mes === slot.sourceText ? [i] : []);
            idx = matches.length === 1 ? matches[0] : -1;
        }
        if (idx < 0) continue;
        const msg = ctx.chat[idx];
        const current = Number(msg.swipe_id ?? 0);
        const container = targetFor(msg, current);
        if (!container) continue;
        const text = variantTextAt(msg, current) ?? '';
        const digest = hashMessage(text);
        for (const legacy of slot.items) {
            if (!legacy || typeof legacy !== 'object') continue;
            const item = {
                ...legacy,
                origin: Number(legacy.idx) < 0 ? 'inline' : 'marker',
                digest,
            };
            if (!Array.isArray(item.cardIds) && item.cardId) item.cardIds = [item.cardId];
            if (!item.digest) item.digest = digest;
            const k = itemKey(item);
            if (!container.items.some(i => itemKey(i) === k)) {
                container.items.push(item);
                moved++;
            }
        }
    }
    if (moved) scheduleChatSave();
    try { ctx.saveMetadataDebounced?.(); } catch { /* node-тесты */ }
    return moved;
}

// ── cfg чата (остаётся в uris_inline) ──

function meta() {
    const ctx = chatCtx();
    const md = ctx.chatMetadata;
    if (!md || typeof md !== 'object') return null;
    if (!md[LEGACY_KEY] || typeof md[LEGACY_KEY] !== 'object') {
        md[LEGACY_KEY] = { v: SCHEMA_V, cfg: { enabled: false, listenUser: false }, msgs: {} };
    }
    const store = md[LEGACY_KEY];
    if (!store.msgs || typeof store.msgs !== 'object') store.msgs = {};
    if (!store.cfg || typeof store.cfg !== 'object') store.cfg = { enabled: false, listenUser: false };
    return store;
}

export function getConfig() {
    const store = meta();
    return { enabled: false, listenUser: false, ...(store?.cfg || {}) };
}

export function setConfig(patch) {
    const store = meta();
    if (!store) return getConfig();
    store.cfg = { ...store.cfg, ...patch };
    try { chatCtx().saveMetadataDebounced?.(); } catch { /* node-тесты */ }
    return { ...store.cfg };
}
