// @ts-check
/**
 * Сканер: подписки на события ST, дедуп (_scanInFlight по msgId), planScan →
 * store/queue. DOM не трогает — рендер подписан на uris:inline-* события.
 */
import { state, getCtx } from '../core.js';
import { hashMessage } from '../generation-drafts.js';
import { recordDiagnosticEvent } from '../diagnostic-events.js';
import { parseInline } from './grammar.js';
import { buildAliasIndex, sanitizeTriggerList, triggerAliases } from './triggers.js';
import { getSlot, upsertItem, getConfig, dropMessage } from './store.js';
import { planScan, queueInlineJob } from './runner.js';

let _handlers = null;
const _scanInFlight = new Set();

function inlineActive() {
    return state.settings?.inlineEnabled === true && getConfig().enabled === true;
}

export async function scanMessage(msgId) {
    if (!inlineActive()) return;
    const ctx = getCtx();
    const mes = ctx.chat?.[msgId]?.mes;
    if (typeof mes !== 'string') return;
    const key = String(msgId);
    if (_scanInFlight.has(key)) return;
    _scanInFlight.add(key);
    try {
        const markers = parseInline(mes);
        const registry = sanitizeTriggerList(state.settings?.inlineTriggers || []);
        const knownTypes = new Set(registry.map(t => t.id));
        const messageHash = hashMessage(mes);
        const stored = getSlot(msgId);
        const actions = planScan({
            msgId, messageHash, markers, stored, auto: true,
            knownTypes,
            inFlight: new Set(state.activeGenerations.keys()),
        });
        let dirty = false;
        for (const a of actions) {
            if (a.action === 'store-pending') {
                upsertItem(msgId, { ...a.item }, { messageHash });
                dirty = true;
            } else if (a.action === 'queue') {
                queueInlineJob({ msgId: Number(msgId), idx: a.item.idx, type: a.item.type, desc: a.marker.desc })
                    .catch(() => { /* статус в store; рендер подхватит */ });
                dirty = true;
            } else if (a.action === 'skip-unknown') {
                recordSkip(a.marker);
            }
        }
        if (dirty) notifyUpdate(msgId);
    } finally {
        _scanInFlight.delete(key);
    }
}

function recordSkip(marker) {
    try {
        recordDiagnosticEvent({ event: 'inline-skip-unknown', details: { type: marker.type } });
    } catch { /* диагностика не должна ронять сканер */ }
}

function notifyUpdate(msgId) {
    try { window.dispatchEvent(new CustomEvent('uris:inline-update', { detail: { msgId: Number(msgId) } })); } catch { /* node */ }
}

export function scannerActive() { return _handlers != null; }

export function bindScanner() {
    if (_handlers) return;
    const ctx = getCtx();
    if (!ctx?.eventSource || !ctx?.event_types) return;
    const et = ctx.event_types;
    _handlers = {
        ended: () => { const i = ctx.chat?.length ? ctx.chat.length - 1 : null; if (i != null) scanMessage(i); },
        swiped: (i) => scanMessage(typeof i === 'number' ? i : (ctx.chat?.length ? ctx.chat.length - 1 : null)),
        edited: (i) => scanMessage(typeof i === 'number' ? i : null),
        deleted: (i) => dropMessage(typeof i === 'number' ? i : null),
        chatChanged: () => { try { window.dispatchEvent(new CustomEvent('uris:inline-update', {})); } catch { /* node */ } },
        userSent: (i) => {
            if (!inlineActive() || !getConfig().listenUser) return;
            const text = String(ctx.chat?.[i]?.mes || '');
            const idx = buildAliasIndex(sanitizeTriggerList(state.settings?.inlineTriggers || []));
            const hit = triggerAliases(idx, text);
            if (!hit) return;
            const desc = text.replace(new RegExp(hit.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu'), '').replace(/\s+/g, ' ').trim() || '{{char}} photo';
            queueInlineJob({ msgId: Number(i), idx: 0, type: hit.profile.id, desc }).catch(() => {});
        },
    };
    ctx.eventSource.makeLast(et.GENERATION_ENDED, _handlers.ended);
    ctx.eventSource.on(et.MESSAGE_SWIPED, _handlers.swiped);
    ctx.eventSource.on(et.MESSAGE_EDITED, _handlers.edited);
    ctx.eventSource.on(et.MESSAGE_SENT, _handlers.userSent);
    ctx.eventSource.on(et.MESSAGE_DELETED, _handlers.deleted);
    ctx.eventSource.on(et.CHAT_CHANGED, _handlers.chatChanged);
}

export function unbindScanner() {
    const ctx = getCtx();
    if (_handlers && ctx?.eventSource) {
        const et = ctx.event_types;
        try { ctx.eventSource.removeListener(et.GENERATION_ENDED, _handlers.ended); } catch { /* ignore */ }
        try { ctx.eventSource.removeListener(et.MESSAGE_SWIPED, _handlers.swiped); } catch { /* ignore */ }
        try { ctx.eventSource.removeListener(et.MESSAGE_EDITED, _handlers.edited); } catch { /* ignore */ }
        try { ctx.eventSource.removeListener(et.MESSAGE_SENT, _handlers.userSent); } catch { /* ignore */ }
        try { ctx.eventSource.removeListener(et.MESSAGE_DELETED, _handlers.deleted); } catch { /* ignore */ }
        try { ctx.eventSource.removeListener(et.CHAT_CHANGED, _handlers.chatChanged); } catch { /* ignore */ }
    }
    _handlers = null;
}
