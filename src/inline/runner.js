// @ts-check
/**
 * Оркестрация инлайн-задач. Чистые функции (planScan) покрыты тестами;
 * побочные эффекты (generateImageRequest, store, DOM) — в Task 7.
 *
 * Словарь действий planScan:
 *   skip-unknown   — тип маркера вне knownTypes: диагностика, ничего не рендерим
 *   render-ready   — готовый (оплаченный) результат с файлом; перезагрузка бесплатна
 *   render-pending — генерация ещё в работе (живой requestId или в грейс-окне)
 *   render-changed — desc изменился после генерации: старая картинка + признак изменений
 *   render-error   — ошибка генерации / осиротевший pending / ready без файла → retry
 *   render-button  — ручной режим, либо cap и нужна НОВАЯ генерация
 *   store-pending  — новый маркер: сохранить pending-item до старта генерации
 *   queue          — поставить платную генерацию в очередь (auto-режим)
 *
 * msgId/messageHash — контракт вызова: их читает сканер (upsert слота), не planScan.
 */
import { itemKey } from './store.js';

/** Окно «генерация ещё возможно стартует» для pending без живого requestId, мс. */
const DEFAULT_GRACE = 120_000;

/**
 * FNV-1a 32-bit, hex — дедуп desc, не криптография.
 * ЗОЛОТОЕ ЗНАЧЕНИЕ: stableHash('img|d') === '6998fd64' зафиксировано тестом —
 * смена алгоритма тихо осиротит все сохранённые descHash и перегенерирует всё.
 * @param {string} str
 * @returns {string}
 */
export function stableHash(str) {
    let h = 0x811c9dc5;
    const bytes = new TextEncoder().encode(String(str || ''));
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return (h >>> 0).toString(16);
}

/**
 * Решение по одному сообщению. Чистая: время и живые requestId внедряются.
 * @param {{
 *   msgId:number|string,
 *   messageHash:string,
 *   markers:Array,
 *   stored:{messageHash:string|null, items:Array},
 *   auto:boolean,
 *   hashFn?:(s:string) => string,
 *   cap?:number,
 *   knownTypes?:Set<string>|null,
 *   inFlight?:Set<string>|null,
 *   now?:() => number,
 *   grace?:number
 * }} input
 * @returns {Array<{action:string, marker:object, item:object|null}>}
 */
export function planScan({ msgId, messageHash, markers, stored, auto, hashFn = stableHash, cap = 3, knownTypes = null, inFlight = null, now = Date.now, grace = DEFAULT_GRACE }) {
    const actions = [];
    const items = stored.items || [];
    markers.forEach((marker, idx) => {
        if (knownTypes && !knownTypes.has(marker.type)) { actions.push({ action: 'skip-unknown', marker, item: null }); return; }
        const descHash = hashFn(`${marker.type}|${marker.desc}`);
        const key = itemKey({ idx, type: marker.type, descHash });
        // Lookup РАНЬШЕ cap: существующий (оплаченный) результат рендерится
        // бесплатно, даже если маркер уехал за лимит после правки выше.
        const item = items.find(i => itemKey(i) === key);
        if (item && item.status === 'ready') {
            // Файл не материализовался (потерян/не сохранён) → retry, а не мёртвый рендер.
            actions.push({ action: item.imagePath ? 'render-ready' : 'render-error', marker, item });
            return;
        }
        if (item && item.status === 'error') { actions.push({ action: 'render-error', marker, item }); return; }
        if (item && item.status === 'pending') {
            // Осиротевший pending (перезагрузка/краш) не должен крутить спиннер вечно:
            // живой requestId или грейс-окно «ещё стартует», иначе — ошибка с retry.
            const live = !!(inFlight && item.requestId != null && inFlight.has(item.requestId));
            const fresh = (now() - (item.createdAt || 0)) < grace;
            actions.push({ action: live || fresh ? 'render-pending' : 'render-error', marker, item });
            return;
        }
        // item нет, либо desc изменился → changed поверх старой картинки (вне cap)
        const changed = items.some(i => `${i.idx}|${i.type}` === `${idx}|${marker.type}` && i.descHash !== descHash);
        if (changed) {
            actions.push({ action: 'render-changed', marker, item: items.find(i => `${i.idx}|${i.type}` === `${idx}|${marker.type}`) });
            return;
        }
        // Нужна НОВАЯ платная генерация — только здесь действуют cap и ручной режим.
        if (idx >= cap || !auto) { actions.push({ action: 'render-button', marker, item: null }); return; }
        const pendingItem = { idx, type: marker.type, descHash, status: 'pending', imagePath: null, cardId: null, requestId: null, error: null, createdAt: now() };
        actions.push({ action: 'store-pending', marker, item: pendingItem });
        actions.push({ action: 'queue', marker, item: pendingItem });
    });
    return actions;
}
