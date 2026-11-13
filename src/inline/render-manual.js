// @ts-check
/**
 * Карусель поста — DOM-слой ручных оболочек (2026-11-13). Вынесено из
 * render.js (потолок ~700 строк): все manual-items (idx<0) поста собираются
 * в ОДНУ оболочку (ключ 'manual') — обложка (последняя готовая) + счётчик
 * версий + pending-строки «Рисую ✦» + error-строки с retry по origin.
 * Digest-инвариант: готовый item с чужим digest показывается как «текст
 * изменился», просроченные ошибки снимаются. Позиция — placementRef по
 * настройке shellPosition (context/start/middle/end).
 *
 * Циклический импорт с render.js — сознательно: render.js вызывает
 * reconcileManualShells в рантайме, этот модуль вызывает reconcileVisible и
 * DOM-утилиты render.js тоже только в рантайме (hoisted function
 * declarations обоих модулей к моменту любого вызова разрешены).
 */

import { state, getCtx, resolveShellPosition, resolveShellClickAction } from '../core.js';
import { upsertItem, deleteItem, itemKey } from './store.js';
import { queueInlineJob, DEFAULT_GRACE } from './runner.js';
import { hashMessage } from '../generation-drafts.js';
import { collectManualView, manualStatus, manualItems, placementRef } from './carousel.js';
import {
    SHELL_ATTR, STATUS_ATTR, FORM_ATTR, _expanded, getReroll, getRerollStory,
    openMessageLightbox, reconcileVisible, insertAfter, removeNode, isShellEl,
} from './render.js';

export const MANUAL_KEY = 'manual';

/** Художественный разделитель (флерон): линия — ромбы — большой ромб — линия.
 * currentColor — следует цвету текста темы. */
const ORNAMENT_VIEWBOX = '0 0 240 14';
/** Узел орнамента: createElementNS в браузере, обычный createElement в fake-dom. */
function ornNode(tag) {
    const el = typeof document.createElementNS === 'function'
        ? document.createElementNS('http://www.w3.org/2000/svg', tag)
        : document.createElement(tag);
    return el;
}

function buildOrnamentSvg() {
    const svg = ornNode('svg');
    svg.setAttribute('class', 'uris-inl-orn-svg');
    svg.setAttribute('viewBox', ORNAMENT_VIEWBOX);
    svg.setAttribute('aria-hidden', 'true');
    const line = (x1, x2) => {
        const l = ornNode('line');
        l.setAttribute('x1', String(x1)); l.setAttribute('y1', '7');
        l.setAttribute('x2', String(x2)); l.setAttribute('y2', '7');
        l.setAttribute('stroke', 'currentColor'); l.setAttribute('stroke-width', '1');
        svg.appendChild(l);
    };
    const diamond = (cx, r) => {
        const d = ornNode('path');
        d.setAttribute('d', `M${cx - r} 7 L${cx} ${7 - r} L${cx + r} 7 L${cx} ${7 + r} Z`);
        d.setAttribute('fill', 'currentColor');
        svg.appendChild(d);
    };
    line(0, 88);
    diamond(96, 3);
    diamond(106, 3);
    diamond(120, 6.5);
    diamond(134, 3);
    diamond(144, 3);
    line(152, 240);
    return svg;
}

/** ⌃-сворачивание карусели поста без чип-режима (сессия, не metadata). */
const _folded = new Set();

// ── Ручные оболочки: одна карусель на пост-вариант (2026-11-13) ──
//
// Все manual-items (idx<0) поста собираются в ОДНУ оболочку (ключ 'manual'):
// обложка (последняя готовая) + счётчик версий + pending-строки «Рисую ✦» +
// error-строки с retry по origin. Digest-инвариант: готовый item с чужим
// digest показывается как «текст изменился», просроченные ошибки снимаются.
// Позиция — placementRef по настройке shellPosition (context/start/middle/end).

function currentVariantDigest(msgId) {
    const msg = getCtx()?.chat?.[Number(msgId)];
    if (!msg) return null;
    const swipes = Array.isArray(msg.swipes) ? msg.swipes : null;
    const current = Number(msg.swipe_id ?? 0);
    const text = swipes && swipes[current] !== undefined
        ? swipes[current]
        : String(msg.mes || '');
    try { return hashMessage(String(text || '')); } catch { return null; }
}

/** Прямые блоки .mes_text (p/div/значимый текст), не оболочки. */
function manualBlocks(textEl) {
    let children = [];
    try { children = Array.from(textEl.childNodes); } catch { return []; }
    return children.filter(node => {
        const isElement = node.nodeType === 1;
        const isText = node.nodeType === 3 && String(node.textContent ?? '').trim();
        if (!isElement && !isText) return false;
        if (isElement && isShellEl(node)) return false;
        return true;
    });
}

function latestAnchorText(view) {
    for (const item of [...view.items].reverse()) {
        if (item.anchorText) return item.anchorText;
    }
    return null;
}

function positionManualShell(textEl, shell, view, position = resolveShellPosition()) {
    const blocks = manualBlocks(textEl);
    // «В начало» — ПЕРЕД первым блоком (insertAfter первого абзаца ставил бы
    // оболочку после первого абзаца — живой QA 2026-11-13).
    if (position === 'start' && blocks.length) {
        try {
            blocks[0].parentNode.insertBefore(shell, blocks[0]);
            return;
        } catch { /* узел ушёл — фолбэк ниже */ }
    }
    const ref = placementRef(blocks, {
        position,
        anchorText: latestAnchorText(view),
    });
    if (ref) {
        try { if (insertAfter(ref, shell)) return; } catch { /* узел ушёл */ }
    }
    textEl.appendChild(shell);
}

/** Ручные items с вычисленными статусами: осиротевший pending (requestId вне
 * inFlight, грейс истёк) → error; digest-инвариант — ready с чужим digest →
 * «изменилось», просроченные ошибки уходят. */
function computedManualItems(msgId, items, { inFlight = null, now = Date.now, grace = DEFAULT_GRACE } = {}) {
    const digestNow = currentVariantDigest(msgId);
    const out = [];
    for (const item of manualItems(items)) {
        if (item.status === 'pending') {
            const live = !!(inFlight && item.requestId != null && inFlight.has(item.requestId));
            const fresh = (now() - (item.createdAt || 0)) < grace;
            if (!live && !fresh) {
                out.push({ ...item, status: 'error', error: item.error || 'Генерация прервана', orphaned: true });
                continue;
            }
            out.push(item);
            continue;
        }
        if (digestNow && item.digest && item.digest !== digestNow) {
            if (item.status === 'error') continue; // просроченная ошибка — убрать
            out.push({ ...item, status: 'changed' });
            continue;
        }
        out.push(item);
    }
    return out;
}

export function reconcileManualShells(mesEl, textEl, items, { inFlight = null, now = Date.now, grace = DEFAULT_GRACE } = {}) {
    if (!textEl) return;
    const msgId = Number(mesEl.getAttribute('mesid'));
    const view = collectManualView(computedManualItems(msgId, items, { inFlight, now, grace }));
    let el = null;
    try { el = mesEl.querySelector('[data-manual="1"]') || null; } catch { return; }
    if (view.empty) {
        if (el) removeNode(el);
        return;
    }
    const status = manualStatus(view);
    const form = manualFormFor(view);
    const position = resolveShellPosition();
    // Позиция входит в keep-гейт: смена настройки должна переставить уже
    // смонтированную оболочку (живой QA 2026-11-13 — без этого shellPosition
    // применялся только при первом монтировании).
    const sig = [
        status, form, position, view.cover?.imagePath || '', view.count,
        view.pendings.length,
        view.errors.map(e => `${e.descHash}:${e.error || ''}`).join(','),
        view.changed.map(e => e.descHash).join(','),
    ].join('|');
    if (el && el.getAttribute(SHELL_ATTR) === MANUAL_KEY && el.getAttribute('data-uris-sig') === sig) return;
    const shell = buildManualShell(msgId, view, status, form, sig);
    shell.setAttribute('data-manual', '1');
    if (el) removeNode(el);
    positionManualShell(textEl, shell, view, position);
}

function manualFormFor(view) {
    const status = manualStatus(view);
    if (status !== 'ready' && status !== 'pending') return 'full';
    if (state.settings?.inlineChips === true) return _expanded.has(MANUAL_KEY) ? 'full' : 'chip';
    return _folded.has(MANUAL_KEY) ? 'chip' : 'full';
}

function buildManualShell(msgId, view, status, form, sig) {
    const el = document.createElement('div');
    el.classList.add('uris-inl-shell', 'uris-inl-manual');
    el.setAttribute(SHELL_ATTR, MANUAL_KEY);
    el.setAttribute(STATUS_ATTR, status);
    el.setAttribute(FORM_ATTR, form);
    el.setAttribute('data-uris-image', String(view.cover?.imagePath || ''));
    el.setAttribute('data-uris-sig', sig);
    if (form === 'chip') {
        const chip = document.createElement('button');
        chip.setAttribute('title', view.count > 1 ? `Показать картинки (${view.count})` : 'Показать картинку');
        chip.addEventListener('click', () => {
            _folded.delete(MANUAL_KEY);
            _expanded.add(MANUAL_KEY);
            try { reconcileVisible({ only: new Set([msgId]) }); } catch { /* fake-dom */ }
        });
        if (status === 'pending') {
            // Свернутый pending сохраняет словесный статус — там важен прогресс.
            chip.classList.add('uris-inl-chip');
            chip.textContent = 'Рисую…';
            el.appendChild(chip);
            return el;
        }
        // Готовый свернутый вид — художественный разделитель без эмодзи и слов
        // (решение 2026-11-13); количество версий — малой цифрой рядом.
        chip.classList.add('uris-inl-chip', 'uris-inl-orn');
        chip.setAttribute('aria-label', chip.getAttribute('title'));
        chip.appendChild(buildOrnamentSvg());
        if (view.count > 1) {
            const count = document.createElement('span');
            count.classList.add('uris-inl-orn-count');
            count.textContent = String(view.count);
            chip.appendChild(count);
        }
        el.appendChild(chip);
        return el;
    }
    if (status === 'ready' || status === 'mixed') el.appendChild(coverEl(msgId, view));
    for (const pending of view.pendings) el.appendChild(pendingRow(msgId, pending));
    for (const err of view.errors) el.appendChild(errorRow(msgId, err));
    for (const changed of view.changed || []) el.appendChild(changedRow(msgId, changed));
    return el;
}

function coverEl(msgId, view) {
    const wrap = document.createElement('div');
    wrap.classList.add('uris-inl-cover');
    const img = document.createElement('img');
    img.setAttribute('src', `/${String(view.cover.imagePath).replace(/^\/+/, '')}`);
    img.setAttribute('loading', 'lazy');
    img.setAttribute('alt', 'Картинка');
    img.setAttribute('title', `Картинка — клик: просмотр всех (${view.count})`);
    img.addEventListener('click', () => {
        const action = resolveShellClickAction();
        if (action === 'none') return;
        if (action === 'tab') {
            try { window.open(`/${String(view.cover.imagePath).replace(/^\/+/, '')}`, '_blank'); } catch { /* fake-dom */ }
            return;
        }
        void openMessageLightbox(msgId, { cardId: view.cover.cardId, imagePath: view.cover.imagePath });
    });
    wrap.appendChild(img);
    if (view.count > 1) {
        const count = document.createElement('div');
        count.classList.add('uris-inl-count');
        count.textContent = `×${view.count}`;
        count.setAttribute('title', `Версий картинки: ${view.count}`);
        wrap.appendChild(count);
    }
    const fold = document.createElement('button');
    fold.classList.add('uris-inl-collapse');
    fold.setAttribute('title', 'Свернуть в чип');
    fold.textContent = '⌃';
    fold.addEventListener('click', (ev) => {
        try { ev?.stopPropagation?.(); } catch { /* fake-dom */ }
        _folded.add(MANUAL_KEY);
        _expanded.delete(MANUAL_KEY);
        try { reconcileVisible({ only: new Set([msgId]) }); } catch { /* fake-dom */ }
    });
    wrap.appendChild(fold);
    return wrap;
}

function pendingRow(msgId, item) {
    const row = document.createElement('div');
    row.classList.add('uris-inl-pending');
    const star = document.createElement('span');
    star.classList.add('uris-inl-plate-star');
    star.textContent = '✦';
    row.appendChild(star);
    const text = document.createElement('span');
    text.textContent = 'Рисую…';
    row.appendChild(text);
    const cancel = document.createElement('button');
    cancel.classList.add('uris-inl-cancel');
    cancel.setAttribute('data-uris-cancel', '1');
    cancel.setAttribute('title', 'Отменить генерацию');
    cancel.textContent = '✕';
    cancel.addEventListener('click', (ev) => {
        try { ev?.stopPropagation?.(); } catch { /* fake-dom */ }
        cancelManualPending(msgId, item);
    });
    row.appendChild(cancel);
    return row;
}

function errorRow(msgId, item) {
    const row = document.createElement('div');
    row.classList.add('uris-inl-error-row');
    const btn = document.createElement('button');
    btn.classList.add('uris-inl-btn');
    btn.textContent = item.orphaned
        ? 'Генерация прервана — клик: retry'
        : `Ошибка: ${item.error || 'неизвестно'} — клик: retry`;
    btn.addEventListener('click', () => retryManual(msgId, item));
    row.appendChild(btn);
    row.appendChild(dismissRowButton(msgId, item));
    return row;
}

function changedRow(msgId, item) {
    const row = document.createElement('div');
    row.classList.add('uris-inl-error-row');
    const btn = document.createElement('button');
    btn.classList.add('uris-inl-btn');
    btn.textContent = 'Текст изменился — клик: перерисовать';
    btn.addEventListener('click', () => retryManual(msgId, item));
    row.appendChild(btn);
    row.appendChild(dismissRowButton(msgId, item));
    return row;
}

function dismissRowButton(msgId, item) {
    const dismiss = document.createElement('button');
    dismiss.classList.add('uris-inl-cancel');
    dismiss.setAttribute('title', 'Убрать');
    dismiss.textContent = '✕';
    dismiss.addEventListener('click', (ev) => {
        try { ev?.stopPropagation?.(); } catch { /* fake-dom */ }
        try { deleteItem(msgId, itemKey(item)); } catch { /* нет чата */ }
        reconcileVisible();
    });
    return dismiss;
}

/** Retry ручной строки: story — полный пайплайн (force), inline/legacy —
 * прежний инлайн-путь по живому тексту поста. */
function retryManual(msgId, item) {
    const notify = (e) => { try { toastr?.error(e?.message || e, 'URIS'); } catch { /* node */ } };
    try {
        if (item.origin === 'story' && typeof _rerollStory === 'function') {
            getRerollStory()(msgId);
            return;
        }
        const desc = String(getCtx()?.chat?.[Number(msgId)]?.mes || '').slice(0, 4000);
        Promise.resolve((getReroll() || queueInlineJob)({
            msgId: Number(msgId), idx: Number(item.idx) || -1, type: item.type || 'img', desc,
        })).catch(notify);
    } catch (e) { notify(e); }
}

/** Отмена ручной pending: живой requestId → abort (processJob запишет error);
 * мёртвый → error-item «Отменено». Store-гард не даёт погасить ready. */
function cancelManualPending(msgId, item) {
    const rid = item?.requestId || null;
    if (rid) {
        let controller = null;
        try { controller = state.activeGenerations?.get(rid) || null; } catch { controller = null; }
        if (controller) {
            try { controller.abort(); } catch { /* уже отменено */ }
            return;
        }
    }
    try {
        upsertItem(msgId, {
            idx: -1, type: 'img', origin: item.origin || 'story', status: 'error',
            descHash: item.descHash, digest: item.digest, error: 'Отменено',
        });
    } catch { /* нет чата — узел заменит следующий reconcile */ }
    reconcileVisible();
}

/** Реролл из DOM: job + catch с toastr (аменда 3: ошибка инициирована здесь —
 * показываем здесь; готовый item защищён store-гардом). */
function startReroll(job) {
    const notify = (e) => { try { toastr?.error(e?.message || e, 'URIS'); } catch { /* node */ } };
    try {
        Promise.resolve((getReroll() || queueInlineJob)(job)).catch(notify);
    } catch (e) {
        notify(e);
    }
}

/** Отмена pending (аменда 2): живой requestId → abort (processJob запишет
 * error и пришлёт uris:inline-end → reconcile покажет error-оболочку);
 * мёртвый requestId → item в error, чтобы реконсиляция не пересоздала
 * спиннер. Пишем только по действительно pending-item: гонка «клик ✕ в тик
 * после готовности» не должна гасить оплаченный результат в error (второй,
 * store-уровневый гард — ready не откатывается в upsertItem). */
function cancelPending(entry) {
    const rid = entry.item?.requestId || null;
    if (rid) {
        let controller = null;
        try { controller = state.activeGenerations?.get(rid) || null; } catch { controller = null; }
        if (controller) {
            try { controller.abort(); } catch { /* уже отменено */ }
            return;
        }
    }
    const itemStatus = entry.item?.status || 'pending';
    if (itemStatus !== 'pending') { reconcileVisible(); return; }
    try {
        upsertItem(entry.msgId, {
            idx: entry.idx, type: entry.type, descHash: entry.descHash,
            status: 'error', requestId: null, error: 'cancelled',
        });
    } catch { /* нет chatMetadata — узел заменит следующий reconcile */ }
    reconcileVisible();
}
