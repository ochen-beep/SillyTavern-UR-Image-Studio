// @ts-check
/**
 * Карусель поста (2026-11-13, spec docs/2026-11-13-inline-carousel-design.md §7).
 * Чистые функции представления ручных items поста (idx<0): одна оболочка на
 * пост-вариант — обложка (последняя ready) + счётчик + pending/error-строки.
 * DOM не трогается: render.js рисует view. Лайтбокс собирает слайды из
 * встроенных cardIds (карточка авторитетна) и опционально всех версий поста.
 */

import { normalizeAnchorText } from './runner.js';

/** Ручные items поста (idx<0), порядок по createdAt. */
export function manualItems(items) {
    return (Array.isArray(items) ? items : [])
        .filter(i => i && Number(i.idx) < 0)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/**
 * View карусели: обложка — последний готовый с файлом; ready без файла
 * классифицируется как error (файл потерян — показывать нечего).
 * @returns {{items: Array, ready: Array, pendings: Array, errors: Array,
 *   cover: object|null, count: number, empty: boolean}}
 */
export function collectManualView(items) {
    const all = manualItems(items).map(item => {
        if (item.status === 'ready' && !item.imagePath) {
            return { ...item, status: 'error', error: item.error || 'Файл картинки недоступен' };
        }
        return item;
    });
    const ready = all.filter(i => i.status === 'ready' && i.imagePath);
    // Счётчик версий = суммарное число встроенных карточек (cardIds), не item'ов:
    // один item может нести несколько версий (attach-хук приклеивает каждую
    // платную карточку поста в его cardIds — живой QA 2026-11-13).
    const count = ready.reduce((n, i) => n
        + (Array.isArray(i.cardIds) && i.cardIds.length
            ? i.cardIds.length
            : (i.cardId ? 1 : 0)), 0);
    return {
        items: all,
        ready,
        pendings: all.filter(i => i.status === 'pending'),
        errors: all.filter(i => i.status === 'error'),
        // «Текст изменился» (digest-инвариант): готовые, чей вариант текста уехал.
        changed: all.filter(i => i.status === 'changed'),
        cover: ready.length ? ready[ready.length - 1] : null,
        count,
        empty: !all.length,
    };
}

/**
 * Агрегированный статус оболочки поста: 'ready' — только обложка (чип
 * разрешён), 'mixed' — обложка + pending/error-строки (полная форма),
 * 'pending' / 'error' — без готовых, 'empty' — нечего показывать.
 */
export function manualStatus(view) {
    if (view.cover) {
        return (view.pendings.length || view.errors.length || view.changed.length) ? 'mixed' : 'ready';
    }
    if (view.pendings.length) return 'pending';
    if (view.errors.length || view.changed.length) return 'error';
    return 'empty';
}

/**
 * Слайды лайтбокса поста: встроенные cardIds раскрываются карточками
 * (порядок хронологический, обложка — путь item'а, остальные — путь
 * карточки), затем опциональные «все версии поста» без дублей.
 * @param {{slotItems: Array, cards?: Map|Array, allVersionsCards?: Array|null}} input
 */
export function carouselLightboxItems({ slotItems, cards = null, allVersionsCards = null }) {
    const view = collectManualView(slotItems);
    const cardMap = new Map(
        (cards instanceof Map ? [...cards.values()] : Array.isArray(cards) ? cards : [])
            .filter(c => c?.id).map(c => [c.id, c]));
    const out = [];
    const seen = new Set();
    for (const entry of view.ready) {
        const ids = Array.isArray(entry.cardIds) && entry.cardIds.length
            ? entry.cardIds
            : [entry.cardId].filter(Boolean);
        if (!ids.length && entry.imagePath) {
            // Карточки нет (удалена из галереи или карточный путь не писался) —
            // слайд по пути item'а, без действий галереи.
            out.push({
                id: null,
                src: `/${String(entry.imagePath).replace(/^\/+/, '')}`,
                imagePath: entry.imagePath,
                prompt: '',
                sourceMsgId: null,
                __inlineKey: `${entry.idx}|${entry.type}|${entry.descHash}|nocard`,
            });
            continue;
        }
        for (const cardId of ids) {
            if (!cardId || seen.has(cardId)) continue;
            seen.add(cardId);
            const card = cardMap.get(cardId) || null;
            // Путь item'а — путь обложки (entry.cardId); остальные карточки
            // авторитетны сами (карточка без записи в галерее — не показывается).
            const path = cardId === entry.cardId
                ? (entry.imagePath || card?.imagePath || '')
                : (card?.imagePath || '');
            if (!path) continue;
            out.push({
                ...(card || {}),
                id: card?.id || cardId,
                src: `/${String(path).replace(/^\/+/, '')}`,
                imagePath: path,
                prompt: card?.prompt || '',
                sourceMsgId: card?.sourceMsgId ?? null,
                __inlineKey: `${entry.idx}|${entry.type}|${entry.descHash}|${cardId}`,
            });
        }
    }
    for (const card of (Array.isArray(allVersionsCards) ? allVersionsCards : [])) {
        if (!card?.id || seen.has(card.id)) continue;
        seen.add(card.id);
        out.push({
            ...card,
            src: `/${String(card.imagePath || '').replace(/^\/+/, '')}`,
            __inlineKey: `gal|${card.id}`,
        });
    }
    return out;
}

/**
 * Блок .mes_text для позиции оболочки (spec §10, настройка shellPosition).
 * 'context' — по anchorText (вхождение нормализованного текста); 'start' —
 * первый блок; 'middle' — середина (осмысленная при >2 блоках); 'end' → null
 * (append). Ничего не нашли → null (fallback в конец).
 * @param {Array<{textContent?: string}>} blocks прямые блоки .mes_text без оболочек
 * @param {{position?: string, anchorText?: string|null, normalizeAnchorText?: Function}} opts
 * @returns {object|null} узел-привязка (вставка ПОСЛЕ него) или null
 */
export function placementRef(blocks, { position = 'context', anchorText = null, normalizeAnchorText: norm = normalizeAnchorText } = {}) {
    const list = Array.isArray(blocks) ? blocks : [];
    if (position === 'start') return list[0] || null;
    if (position === 'middle') return list.length > 2 ? list[Math.floor(list.length / 2)] : null;
    if (position === 'end') return null;
    const anchor = norm(anchorText || '');
    if (!anchor) return null;
    for (const node of list) {
        const text = norm(node?.textContent || '');
        if (text && text.includes(anchor)) return node;
    }
    return null;
}
