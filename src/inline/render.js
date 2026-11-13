// @ts-check
/**
 * DOM-слой инлайна: оболочки в сообщениях (реконсиляция по data-uris-inl),
 * клик по готовой картинке → общий лайтбокс по всем картинкам сообщения
 * (showLightbox, с рабочими галерейными действиями), реролл = замена
 * (старая остаётся в галерее).
 *
 * Позиция оболочки — сразу после абзаца, содержащего маркер (фото держится
 * у своей прозы); не нашли блок (plain-текст, markdown расщепил raw) — в
 * конец .mes_text.
 *
 * Реконсиляция идемпотентна: оболочка помечена data-uris-inl="<key>"
 * (idx|type|descHash) и data-uris-status; при том же ключе и статусе — keep,
 * при смене статуса (pending→ready/error, аменда 1) — замена узла. Оболочки,
 * чей ключ не покрыт текущими маркерами (маркер убрали/описание изменилось),
 * снимаются — «реролл = замена»; ручные (data-manual="1") и готовые результаты
 * ручной генерации (idx<0) переживают чистку.
 */
import { state, getCtx, resolveShellClickAction } from '../core.js';
import { parseInline } from './grammar.js';
import { getSlot, upsertItem, deleteItem, itemKey } from './store.js';
import { sanitizeTriggerList, buildAliasIndex, resolveProfile } from './triggers.js';
import { stableHash, queueInlineJob, DEFAULT_GRACE } from './runner.js';
import { hashMessage } from '../generation-drafts.js';
import { collectManualView, manualStatus, manualItems, carouselLightboxItems, placementRef } from './carousel.js';
import { showSingleImage, showLightbox } from '../ui/lightbox.js';
import { reconcileManualShells } from './render-manual.js';

export const SHELL_ATTR = 'data-uris-inl';
export const STATUS_ATTR = 'data-uris-status';
const HIDDEN_ATTR = 'data-uris-inl-hidden';
export const FORM_ATTR = 'data-uris-form';
const DEBOUNCE_MS = 250;

let _observer = null;
let _onInlineEvent = null;
let _reroll = null;
let _rerollStory = null;
let _debounceId = null;

/** Раскрытые из чипов оболочки (компакт-режим). Рантайм, не настройка:
 * переключение настройки перестраивает оболочки следующим проходом. */
export const _expanded = new Set();


/** Форма оболочки (компакт-режим state.settings.inlineChips): ready/pending —
 * чип, пока не раскрыт кликом; остальное и всегда при выключенном режиме —
 * полная. Входит в keep-гейт реконсиляции через FORM_ATTR. */
function formFor(status, key) {
    if (state.settings?.inlineChips !== true) return 'full';
    if (status !== 'ready' && status !== 'pending') return 'full';
    return _expanded.has(key) ? 'full' : 'chip';
}

// Test-only viewer seam (same pattern as tab-gallery.js): fake-dom tests cannot
// load PhotoSwipe, so the click regression test swaps the viewer for a stub.
let _viewer = { showLightbox };
export function setViewerForTests(viewer) { _viewer = viewer; }
export function resetViewerForTests() { _viewer = { showLightbox }; }

// Card lookup seam, mirroring setRefStoreForTests in refs-library.js. Null means
// "the real file-backed gallery store", imported lazily on click so the DOM
// layer does not pull it into its static graph for every page load.
let _loadCards = null;
export function setCardLookupForTests(fn) { _loadCards = fn; }
export function resetCardLookupForTests() { _loadCards = null; }

/** Подписка MutationObserver на #chat (debounce 250мс) + события uris:inline-*;
 * reroll — маркерный перезапуск, rerollStory — retry story-оболочки (по origin). */
/** Живые привязки reroll-колбэков для render-manual.js (циклический импорт). */
export function getReroll() { return _reroll; }
export function getRerollStory() { return _rerollStory; }

export function initRender({ reroll, rerollStory } = {}) {
    if (typeof reroll === 'function') _reroll = reroll;
    if (typeof rerollStory === 'function') _rerollStory = rerollStory;
    if (_onInlineEvent) return; // слушатели уже стоят; reroll обновлён выше
    _onInlineEvent = () => { try { reconcileVisible(); } catch { /* рендер не роняет обработчик */ } };
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('uris:inline-update', _onInlineEvent);
        window.addEventListener('uris:inline-queued', _onInlineEvent);
        window.addEventListener('uris:inline-start', _onInlineEvent);
        window.addEventListener('uris:inline-end', _onInlineEvent);
    }
    ensureObserver();
    try { reconcileVisible(); } catch { /* первая проводка не критична */ }
}

/** Отписка (выгрузка расширения) и выключение инлайна (applyInlineRuntime). */
export function shutdownRender() {
    if (_observer) { try { _observer.disconnect(); } catch { /* уже снят */ } _observer = null; }
    if (_debounceId) { clearTimeout(_debounceId); _debounceId = null; }
    if (_onInlineEvent && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('uris:inline-update', _onInlineEvent);
        window.removeEventListener('uris:inline-queued', _onInlineEvent);
        window.removeEventListener('uris:inline-start', _onInlineEvent);
        window.removeEventListener('uris:inline-end', _onInlineEvent);
    }
    _onInlineEvent = null;
    _reroll = null;
    _rerollStory = null;
    _expanded.clear();
}

function ensureObserver() {
    if (_observer || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    const chatEl = typeof document.getElementById === 'function' ? document.getElementById('chat') : null;
    if (!chatEl) return;
    _observer = new MutationObserver(onChatMutated);
    _observer.observe(chatEl, { childList: true, subtree: true });
}

function onChatMutated(mutations) {
    if (_debounceId) clearTimeout(_debounceId);
    _debounceId = setTimeout(() => {
        _debounceId = null;
        try {
            // Пункт 25: мутации обычно указывают на конкретные посты — полному
            // обходу чата есть замена. null = «вынести нельзя» (мутации вне
            // .mes) → старый полный проход.
            const targets = collectAffectedMes(mutations);
            if (targets === null) reconcileVisible();
            else if (targets.size) reconcileVisible({ only: targets });
            ensureObserver();
        } catch { /* реконсиляция не роняет чат */ }
    }, DEBOUNCE_MS);
}

/** Из пачки мутаций вынести затронутые mesid. null — нельзя (мутация вне
 * постов: перестройка контейнера чата и т.п.). Собственные вставки рендера
 * (оболочки/📷-кнопки внутри .mes_text) резолвятся в их пост — повторный
 * проход точечный и сходится. */
function collectAffectedMes(mutations) {
    const ids = new Set();
    for (const m of mutations || []) {
        for (const node of [...(m.addedNodes || []), ...(m.removedNodes || [])]) {
            let el = null;
            if (node && node.nodeType === 1 && node.closest) el = node.closest('.mes');
            if (!el && m.target && m.target.closest) el = m.target.closest('.mes');
            if (!el) return null;
            const idRaw = el.getAttribute('mesid');
            if (idRaw == null || idRaw === '') continue;
            ids.add(Number(idRaw));
        }
    }
    return ids;
}

/**
 * Обход .mes[mesid] в #chat: план по маркерам → mount/keep; заодно ручные
 * 📷-кнопки. Дешёвый fast-path: нет маркеров, items и существующих оболочек — skip.
 * `{ only: Set<msgId> }` (пункт 25) — точечный проход по постам, затронутым
 * мутацией; без фильтра — полный обход (старт, uris:inline-* события).
 */
export function reconcileVisible({ only = null } = {}) {
    if (typeof document === 'undefined') return;
    const inlineOn = state.settings?.inlineEnabled === true;
    ensureObserver();
    let ctx = null;
    try { ctx = getCtx(); } catch { /* ST недоступен (тесты/ранняя инициализация) */ }
    const chat = ctx?.chat || null;
    let scope = document;
    try { scope = (typeof document.getElementById === 'function' && document.getElementById('chat')) || document; } catch { /* fake без getElementById */ }
    let mesEls = [];
    try { mesEls = Array.from(scope.querySelectorAll('.mes')); } catch { return; }
    const inFlight = state.activeGenerations instanceof Map ? new Set(state.activeGenerations.keys()) : null;
    if (!inlineOn) {
        // Лаунчер-действия («Нарисовать по истории») пишут ручные оболочки в
        // store независимо от тумблера инлайна: выключенный инлайн глушит
        // только маркерные триггеры. Маркерные оболочки при этом не трогаем —
        // существующие картинки истории не исчезают.
        for (const mesEl of mesEls) {
            const msgIdRaw = mesEl.getAttribute('mesid');
            if (msgIdRaw == null || msgIdRaw === '') continue;
            if (only && !only.has(Number(msgIdRaw))) continue;
            const items = getSlot(Number(msgIdRaw)).items;
            const hasManual = items.some(item => item && Number(item.idx) < 0);
            let hasManualShell = false;
            try { hasManualShell = !!mesEl.querySelector('[data-manual="1"]'); } catch { /* fake-dom */ }
            // Пустой слот при живой оболочке тоже проходит: «Убрать из поста»
            // должно снести оболочку (2026-11-13), а не оставить зомби.
            if (!hasManual && !hasManualShell) continue;
            const textEl = mesEl.querySelector('.mes_text');
            if (!textEl) continue;
            reconcileManualShells(mesEl, textEl, items, { inFlight });
        }
        return;
    }
    for (const mesEl of mesEls) {
        const msgIdRaw = mesEl.getAttribute('mesid');
        if (msgIdRaw == null || msgIdRaw === '') continue;
        const msgId = Number(msgIdRaw);
        if (only && !only.has(msgId)) continue;
        const mes = chat?.[msgId]?.mes;
        const markers = typeof mes === 'string' ? parseInline(mes) : [];
        let shellEls = [];
        try { shellEls = Array.from(mesEl.querySelectorAll(`[${SHELL_ATTR}]`)); } catch { shellEls = []; }
        // getSlot — чистое чтение in-memory chatMetadata: материалы скелета
        // здесь не материализуются. Фаст-путь пропускает пост, которому нечего
        // показывать: ни маркеров, ни оболочек, ни ручных items (ляунчер-пайплайн
        // пишет результат в store без маркеров в тексте).
        const items = getSlot(msgId).items;
        if (!markers.length && !shellEls.length && !items.length) continue;
        const textEl = mesEl.querySelector('.mes_text');
        if (!textEl) continue;
        const existingKeys = new Set(shellEls.map(el => el.getAttribute(SHELL_ATTR)).filter(Boolean));
        const plan = computeShellPlan({ msgId, markers, items, hashFn: stableHash, existingKeys, inFlight });
        for (const entry of plan) {
            const cur = shellEls.find(el => el.getAttribute(SHELL_ATTR) === entry.key) || null;
            // keep только при совпадении статуса и формы (чип↔картинка):
            // pending→ready обновится (аменда 1), смена compact-режима — тоже.
            if (entry.domAction === 'keep' && cur && cur.getAttribute(STATUS_ATTR) === entry.status
                && cur.getAttribute('data-uris-image') === String(entry.item?.imagePath || '')
                && cur.getAttribute(FORM_ATTR) === formFor(entry.status, entry.key)) continue;
            mountShell(textEl, entry, cur);
        }
        pruneStaleShells(textEl, plan, items, shellEls);
        reconcileManualShells(mesEl, textEl, items, { inFlight });
    }
}

/**
 * Чистая реконсиляция: план оболочек по ключам. Для каждого маркера
 * key = `${idx}|${type}|${hashFn(type+'|'+desc)}`; status — из items
 * (ready/pending/error; ready без файла → error; pending с requestId вне
 * inFlight и за грейс-окном → error: осиротевшая генерация не должна крутить
 * спиннер вечно), при item с тем же idx|type, но другим descHash — changed,
 * без item вовсе — button. domAction: mount, если оболочки с таким ключом
 * ещё нет, иначе keep.
 */
export function computeShellPlan({ msgId, markers, items, hashFn = stableHash, existingKeys = [], inFlight = null, now = Date.now, grace = DEFAULT_GRACE }) {
    const existing = existingKeys instanceof Set ? existingKeys : new Set(existingKeys || []);
    const list = Array.isArray(items) ? items : [];
    const plan = [];
    (Array.isArray(markers) ? markers : []).forEach((marker, idx) => {
        if (!marker || !marker.type) return;
        const descHash = hashFn(`${marker.type}|${marker.desc}`);
        const key = `${idx}|${marker.type}|${descHash}`;
        let item = list.find(i => i && Number(i.idx) === idx && i.type === marker.type && i.descHash === descHash) || null;
        let status;
        let orphaned = false;
        if (item) {
            status = (item.status === 'ready' && !item.imagePath) ? 'error' : (item.status || 'pending');
            if (status === 'pending') {
                const live = !!(inFlight && item.requestId != null && inFlight.has(item.requestId));
                const fresh = (now() - (item.createdAt || 0)) < grace;
                if (!live && !fresh) { status = 'error'; orphaned = true; }
            }
        } else {
            // Тот же idx|type с другим descHash → changed (item — прежний);
            // item нет вовсе → button.
            const prev = list.find(i => i && Number(i.idx) === idx && i.type === marker.type);
            status = prev ? 'changed' : 'button';
            if (prev) item = prev;
        }
        plan.push({ msgId, idx, type: marker.type, desc: marker.desc, descHash, key, marker, item, status, orphaned, domAction: existing.has(key) ? 'keep' : 'mount' });
    });
    return plan;
}

/** DOM по статусу (см. план задачи: ready/pending/button/changed/error).
 * Компакт-режим (formFor): ready — чип «📷 тип», клик раскрывает картинку;
 * pending — компактный чип со спиннером и ✕; у раскрытой картинки — ⌃ свернуть. */
function shellFor(msgId, entry) {
    const el = document.createElement('div');
    el.classList.add('uris-inl-shell');
    el.setAttribute(SHELL_ATTR, entry.key);
    el.setAttribute(STATUS_ATTR, entry.status);
    el.setAttribute('data-uris-image', String(entry.item?.imagePath || ''));
    el.setAttribute(FORM_ATTR, formFor(entry.status, entry.key));
    if (entry.status === 'ready') {
        const profile = profileFor(entry.type);
        const label = profile?.name || entry.type;
        if (el.getAttribute(FORM_ATTR) === 'chip') {
            const chip = document.createElement('button');
            chip.classList.add('uris-inl-chip');
            chip.setAttribute('title', `Показать ${label}`);
            chip.textContent = `📷 ${label}`;
            chip.addEventListener('click', () => {
                _expanded.add(entry.key);
                try { el.replaceWith(shellFor(entry.msgId, entry)); } catch { /* узел уже снят */ }
            });
            el.appendChild(chip);
            return el;
        }
        const img = document.createElement('img');
        img.setAttribute('src', `/${String(entry.item?.imagePath || '').replace(/^\/+/, '')}`);
        img.setAttribute('loading', 'lazy');
        img.setAttribute('alt', entry.desc || label);
        img.setAttribute('title', `${label} — клик: просмотр всех картинок поста`);
        img.addEventListener('click', () => {
            const action = resolveShellClickAction();
            if (action === 'none') return;
            if (action === 'tab') {
                try { window.open(`/${String(entry.item?.imagePath || '').replace(/^\/+/, '')}`, '_blank'); } catch { /* fake-dom */ }
                return;
            }
            void openMessageLightbox(msgId, entry);
        });
        el.appendChild(img);
        el.appendChild(badge(label));
        if (state.settings?.inlineChips === true) {
            const fold = document.createElement('button');
            fold.classList.add('uris-inl-collapse');
            fold.setAttribute('title', 'Свернуть в чип');
            fold.textContent = '⌃';
            fold.addEventListener('click', (ev) => {
                try { ev?.stopPropagation?.(); } catch { /* fake-dom */ }
                _expanded.delete(entry.key);
                try { el.replaceWith(shellFor(entry.msgId, entry)); } catch { /* узел уже снят */ }
            });
            el.appendChild(fold);
        }
        return el;
    }
    if (entry.status === 'pending') {
        const profile = profileFor(entry.type);
        const label = profile?.name || entry.type;
        const cancel = document.createElement('button');
        cancel.classList.add('uris-inl-cancel');
        cancel.setAttribute('data-uris-cancel', '1');
        cancel.setAttribute('title', 'Отменить генерацию');
        cancel.textContent = '✕';
        cancel.addEventListener('click', (ev) => {
            try { ev?.stopPropagation?.(); } catch { /* fake-dom */ }
            cancelPending(entry);
        });
        if (el.getAttribute(FORM_ATTR) === 'chip') {
            const chip = document.createElement('span');
            chip.classList.add('uris-inl-chip');
            const spin = document.createElement('i');
            spin.classList.add('fa-solid');
            spin.classList.add('fa-spinner');
            spin.classList.add('fa-spin');
            chip.appendChild(spin);
            chip.appendChild(document.createTextNode(` ${label}`));
            chip.appendChild(cancel);
            el.appendChild(chip);
            return el;
        }
        const frame = document.createElement('div');
        frame.classList.add('uris-inl-pending');
        // Компактная плашка на всю ширину текста чата (геометрия в
        // .uris-inl-pending, overlays.css) — вместо аспект-бокса профиля.
        const star = document.createElement('span');
        star.classList.add('uris-inl-plate-star');
        star.textContent = '✦';
        frame.appendChild(star);
        const text = document.createElement('span');
        text.textContent = 'Рисую…';
        frame.appendChild(text);
        const labelEl = document.createElement('span');
        labelEl.classList.add('uris-inl-plate-label');
        labelEl.textContent = label;
        frame.appendChild(labelEl);
        frame.appendChild(cancel);
        el.appendChild(frame);
        el.appendChild(badge(label));
        return el;
    }
    // button / changed / error — кликабельная строка
    const btn = document.createElement('button');
    btn.classList.add('uris-inl-btn');
    if (entry.status === 'changed') {
        btn.textContent = 'Описание изменилось — клик: перерисовать';
    } else if (entry.status === 'error') {
        btn.textContent = entry.orphaned
            ? 'Генерация прервана — клик: retry'
            : `Ошибка: ${entry.item?.error || 'неизвестно'} — клик: retry`;
    } else {
        btn.textContent = '📷 Нарисовать';
    }
    btn.addEventListener('click', () => startReroll(jobOf(msgId, entry)));
    el.appendChild(btn);
    return el;
}

function jobOf(msgId, entry) {
    return { msgId: Number(msgId), idx: entry.idx, type: entry.type, desc: entry.desc };
}

function badge(text) {
    const b = document.createElement('div');
    b.classList.add('uris-inl-badge');
    b.textContent = text;
    return b;
}

// ── Просмотр: все готовые картинки поста в общем лайтбоксе ──
//
// Раньше клик отдавал showSingleImage({src, prompt}) — без cardId. Тулбар
// лайтбокса в галерейном режиме читает id/sourceMsgId, поэтому на инлайне
// «Перегенерировать» падало на msgId=undefined, а «Удалить» молча ничего не
// делало. Теперь оболочка открывает общий просмотрщик по ВСЕМ готовым
// результатам сообщения и обогащает каждый item его галерейной карточкой —
// действия работают ровно так же, как из сетки галереи.

/** Карточки галереи по id. Ошибка стораджа — не повод не открыть просмотр. */
async function cardsByIds(ids) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).filter(Boolean));
    if (!wanted.size) return new Map();
    try {
        const load = _loadCards || (async () => (await import('../gallery-index.js')).listCards({ reconcile: false }));
        const cards = await load();
        const byId = new Map();
        for (const card of Array.isArray(cards) ? cards : []) {
            if (card && wanted.has(card.id)) byId.set(card.id, card);
        }
        return byId;
    } catch { return new Map(); }
}

/**
 * Чистое: items для лайтбокса по слоту сообщения — только МАРКЕРНЫЕ
 * результаты (idx≥0). Ручные (idx<0) собираются отдельно через
 * carousel.carouselLightboxItems (openMessageLightbox объединяет оба списка).
 * Карточка авторитетна для промпта/параметров/размеров, item — для файла и
 * идентичности слайда.
 *
 * @param {Array} items элементы слота
 * @param {Map<string, object>|null} [cards] Map<cardId, card>
 * @param {number|string|null} [msgId]
 * @returns {Array<object>}
 */
export function messageLightboxItems(items, cards = null, msgId = null) {
    const list = Array.isArray(items) ? items : [];
    return list
        .filter(item => item && item.status === 'ready' && item.imagePath && Number(item.idx) >= 0)
        .slice()
        .sort((a, b) => (Number(a.idx) - Number(b.idx)) || ((a.createdAt || 0) - (b.createdAt || 0)))
        .map(item => {
            const card = (item.cardId && cards?.get?.(item.cardId)) || null;
            const msg = Number(msgId);
            return {
                ...(card || {}),
                id: card?.id || null,
                src: `/${String(item.imagePath).replace(/^\/+/, '')}`,
                imagePath: item.imagePath,
                prompt: card?.prompt || item.desc || '',
                sourceMsgId: card?.sourceMsgId ?? (msg >= 0 ? msg : null),
                // Ключ слайда: по нему обработчик выбирает открытую картинку.
                __inlineKey: `${item.idx}|${item.type}|${item.descHash}`,
            };
        });
}

/** Открыть общий просмотрщик по всем готовым картинкам сообщения:
 * маркерные + карусель поста (+ «все версии поста» по настройке). */
export async function openMessageLightbox(msgId, target = {}) {
    const slot = getSlot(msgId);
    const manualView = collectManualView(slot.items);
    const manualCardIds = manualView.ready.flatMap(i =>
        Array.isArray(i.cardIds) && i.cardIds.length ? i.cardIds : [i.cardId].filter(Boolean));
    const markerCardIds = (slot.items || [])
        .filter(i => i && Number(i.idx) >= 0 && i.cardId).map(i => i.cardId);
    const cards = await cardsByIds([...new Set([...markerCardIds, ...manualCardIds])]);
    let allVersionsCards = null;
    if (state.settings?.carouselAllVersions === true) {
        try {
            const load = _loadCards || (async () =>
                (await import('../gallery-index.js')).listCards({ reconcile: false }));
            const all = await load();
            const chatId = getCtx()?.chatId ?? null;
            allVersionsCards = (Array.isArray(all) ? all : [])
                .filter(c => c && c.provenance?.chatId === chatId
                    && Number(c.sourceMsgId) === Number(msgId));
        } catch { /* нет галереи — только встроенные */ }
    }
    const items = [
        ...messageLightboxItems(slot.items, cards, msgId),
        ...carouselLightboxItems({ slotItems: slot.items, cards, allVersionsCards }),
    ];
    if (!items.length) return;
    const clicked = target.cardId
        ? items.findIndex(i => i.id === target.cardId)
        : items.findIndex(i => i.__inlineKey === target.key);
    try {
        await _viewer.showLightbox(items, clicked < 0 ? 0 : clicked, { chatId: getCtx()?.chatId ?? null });
    } catch {
        // Просмотрщик недоступен (нет PhotoSwipe) — деградируем к одиночному.
        const fallbackPath = target.imagePath
            || (target.cardId ? manualView.cover?.imagePath : null)
            || items[0]?.imagePath || '';
        try {
            if (fallbackPath) void showSingleImage({ src: `/${String(fallbackPath).replace(/^\/+/, '')}`, prompt: '' });
        } catch { /* и одиночный не поднялся */ }
    }
}

function profileFor(type) {
    try {
        return resolveProfile(buildAliasIndex(sanitizeTriggerList(state.settings?.inlineTriggers || [])), type);
    } catch { return null; }
}

/** Спрятать raw маркера в тексте сообщения (обёртка display:none). */
function hideMarkerText(textEl, raw) {
    if (!textEl || !raw) return;
    for (const { parent, node } of collectTextNodes(textEl)) {
        const text = String(node.textContent ?? '');
        const at = text.indexOf(raw);
        if (at === -1) continue;
        if (insideHiddenWrapper(node)) continue; // аменда 4: идемпотентность
        const head = text.slice(0, at);
        const tail = text.slice(at + raw.length);
        const wrap = document.createElement('span');
        wrap.setAttribute(HIDDEN_ATTR, '1');
        wrap.setAttribute('style', 'display:none');
        wrap.textContent = raw;
        if (typeof parent.insertBefore === 'function') {
            // Реальный DOM: хвост остаётся в исходном узле, перед ним head + обёртка.
            node.textContent = tail;
            if (head) parent.insertBefore(document.createTextNode(head), node);
            parent.insertBefore(wrap, node);
        } else {
            // Деградация (fake-dom в тестах): пересборка списка детей узла.
            try {
                const parts = [];
                if (head) parts.push(document.createTextNode(head));
                parts.push(wrap);
                if (tail) parts.push(document.createTextNode(tail));
                const ci = parent.childNodes.indexOf(node);
                if (ci !== -1) parent.childNodes.splice(ci, 1, ...parts);
                const cci = parent.children.indexOf(node);
                if (cci !== -1) parent.children.splice(cci, 1, ...parts);
                for (const p of parts) p.parentNode = parent;
            } catch { /* лучше частично, чем уронить рендер */ }
        }
    }
}

/** Текстовые узлы под root; внутрь скрытых маркеров и оболочек не спускаемся. */
function collectTextNodes(root) {
    const out = [];
    const walk = (node) => {
        for (const child of (node.childNodes || [])) {
            if (!child) continue;
            if (child.nodeType === 3) { out.push({ parent: node, node: child }); continue; }
            if (child.nodeType !== 1) continue;
            if (skipsHide(child)) continue;
            walk(child);
        }
    };
    walk(root);
    return out;
}

function skipsHide(el) {
    try {
        if (typeof el.getAttribute !== 'function') return true;
        return !!(el.getAttribute(HIDDEN_ATTR) || el.getAttribute(SHELL_ATTR));
    } catch { return true; }
}

function insideHiddenWrapper(node) {
    let n = node;
    while (n && n.parentNode) {
        n = n.parentNode;
        if (n.nodeType === 1 && typeof n.getAttribute === 'function' && n.getAttribute(HIDDEN_ATTR)) return true;
    }
    return false;
}

/** mount: спрятать raw маркера + создать/заменить оболочку. Замена (смена
 * статуса) сохраняет позицию через replaceWith; новая оболочка встаёт сразу
 * после абзаца с маркером (markerContainer), иначе — в конец .mes_text. */
function mountShell(textEl, entry, cur) {
    if (!textEl) return;
    if (cur && cur.parentNode) {
        hideMarkerText(textEl, entry.marker?.raw);
        const shell = shellFor(entry.msgId, entry);
        try { cur.replaceWith(shell); } catch { textEl.appendChild(shell); }
        return;
    }
    // Ищем блок ДО hideMarkerText: спрятанный raw collectTextNodes не видит.
    const container = markerContainer(textEl, entry.marker?.raw);
    hideMarkerText(textEl, entry.marker?.raw);
    const shell = shellFor(entry.msgId, entry);
    if (!container || container === textEl) { textEl.appendChild(shell); return; }
    // Несколько маркеров в одном абзаце: встаём после уже стоящих там
    // оболочек, чтобы порядок совпадал с порядком маркеров в тексте.
    let tail = container;
    for (;;) {
        const next = nextElementOf(tail);
        if (!isShellEl(next)) break;
        tail = next;
    }
    if (!insertAfter(tail, shell)) textEl.appendChild(shell);
}

/**
 * Прямой ребёнок textEl, внутри которого лежит raw-маркер: текстовый узел
 * (raw ещё виден) или display:none-обёртка спрятанного. Сам textEl, если raw
 * не найден или лежит прямо в нём (plain-текст без абзацев) — оболочка тогда
 * идёт в конец, как раньше. Первое вхождение выигрывает: два одинаковых
 * маркера в посте ставят обе оболочки к первому.
 * # ponytail: nth-occurrence матч, если дубли когда-нибудь станут заметны.
 */
function markerContainer(textEl, raw) {
    if (!textEl || !raw) return textEl;
    const nodes = [];
    for (const { node } of collectTextNodes(textEl)) nodes.push(node);
    try {
        for (const wrap of textEl.querySelectorAll(`[${HIDDEN_ATTR}]`)) {
            if (String(wrap.textContent ?? '') === raw) nodes.push(wrap);
        }
    } catch { /* fake-dom без querySelectorAll */ }
    for (const node of nodes) {
        if (!String(node.textContent ?? '').includes(raw)) continue;
        let el = node;
        while (el && el.parentNode && el.parentNode !== textEl) el = el.parentNode;
        return (el && el.nodeType === 1 && el.parentNode === textEl) ? el : textEl;
    }
    return textEl;
}

export function isShellEl(el) {
    try { return !!el && typeof el.getAttribute === 'function' && el.getAttribute(SHELL_ATTR) != null; }
    catch { return false; }
}

/** Следующий элемент-сосед: в реальном DOM — nextElementSibling, в fake-dom
 * (children — массив) — вручную. */
function nextElementOf(el) {
    try {
        if (el && typeof el.nextElementSibling !== 'undefined') return el.nextElementSibling || null;
    } catch { /* fallthrough в ручной обход */ }
    const sibs = el?.parentNode?.children;
    if (!Array.isArray(sibs)) return null;
    const i = sibs.indexOf(el);
    return i >= 0 ? (sibs[i + 1] || null) : null;
}

/** Вставить el сразу после ref; false — вызывающий падает в appendChild.
 * Реальный DOM — insertAdjacentElement, fake-dom — splice (как в
 * hideMarkerText). */
export function insertAfter(ref, el) {
    try {
        if (ref && typeof ref.insertAdjacentElement === 'function') {
            ref.insertAdjacentElement('afterend', el);
            return true;
        }
    } catch { return false; }
    const parent = ref?.parentNode;
    if (!parent || !Array.isArray(parent.children) || !Array.isArray(parent.childNodes)) return false;
    const ci = parent.children.indexOf(ref);
    const cci = parent.childNodes.indexOf(ref);
    if (ci === -1 || cci === -1) return false;
    parent.children.splice(ci + 1, 0, el);
    parent.childNodes.splice(cci + 1, 0, el);
    el.parentNode = parent;
    return true;
}

/** Оболочки вне текущего плана снимаются («реролл = замена», маркер удалён —
 * оболочка тоже). Ручные (data-manual) и готовые результаты ручной генерации
 * (idx<0, вне marker-плана) остаются. */
function pruneStaleShells(textEl, plan, items, shellEls) {
    const planKeys = new Set(plan.map(e => e.key));
    for (const el of shellEls) {
        const key = el.getAttribute(SHELL_ATTR);
        if (!key || planKeys.has(key)) continue;
        if (el.getAttribute('data-manual') === '1') continue;
        const item = (items || []).find(i => itemKey(i) === key) || null;
        if (item && Number(item.idx) < 0) continue;
        removeNode(el);
    }
}

export function removeNode(el) {
    try {
        if (typeof el.remove === 'function') el.remove();
        else el.parentNode?.removeChild(el);
    } catch { /* узел уже снят */ }
}

/** Реролл из DOM: job + catch с toastr (аменда 3: ошибка инициирована здесь —
 * показываем здесь; готовый item защищён store-гардом). */
function startReroll(job) {
    const notify = (e) => { try { toastr?.error(e?.message || e, 'URIS'); } catch { /* node */ } };
    try {
        Promise.resolve((_reroll || queueInlineJob)(job)).catch(notify);
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
