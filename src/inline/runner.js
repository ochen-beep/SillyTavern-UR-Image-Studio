// @ts-check
/**
 * Оркестрация инлайн-задач. Чистые функции (planScan) покрыты тестами;
 * побочные эффекты (generateImageRequest, store, DOM) — в Task 7.
 */
import { itemKey } from './store.js';

function stableHash(str) {
    // FNV-1a 32-bit, hex — дедуп desc, не криптография
    let h = 0x811c9dc5;
    const bytes = new TextEncoder().encode(String(str || ''));
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return (h >>> 0).toString(16);
}

/**
 * Решение по одному сообщению.
 * @param {{msgId:number|string, messageHash:string, markers:Array, stored:{messageHash:string|null, items:Array}, auto:boolean, hashFn?:Function, cap?:number}} input
 * @returns {Array<{action:string, marker:object, item:object|null}>}
 */
export function planScan({ msgId, messageHash, markers, stored, auto, hashFn = stableHash, cap = 3 }) {
    const actions = [];
    const items = stored.items || [];
    markers.forEach((marker, idx) => {
        if (idx >= cap) { actions.push({ action: 'render-button', marker, item: null }); return; }
        const descHash = hashFn(`${marker.type}|${marker.desc}`);
        const key = itemKey({ idx, type: marker.type, descHash });
        const item = items.find(i => itemKey(i) === key);
        if (item && item.status === 'ready') { actions.push({ action: 'render-ready', marker, item }); return; }
        if (item && item.status === 'error') { actions.push({ action: 'render-error', marker, item }); return; }
        if (item && item.status === 'pending') { actions.push({ action: 'render-ready', marker, item }); return; } // уже в работе
        // item нет, либо desc изменился → changed поверх старой картинки
        const changed = items.some(i => `${i.idx}|${i.type}` === `${idx}|${marker.type}` && i.descHash !== descHash);
        if (changed) {
            actions.push({ action: 'render-changed', marker, item: items.find(i => `${i.idx}|${i.type}` === `${idx}|${marker.type}`) });
            return;
        }
        if (!auto) { actions.push({ action: 'render-button', marker, item: null }); return; }
        const pendingItem = { idx, type: marker.type, descHash, status: 'pending', imagePath: null, cardId: null, requestId: null, error: null, createdAt: Date.now() };
        actions.push({ action: 'store-pending', marker, item: pendingItem });
        actions.push({ action: 'queue', marker, item: pendingItem });
    });
    return actions;
}
