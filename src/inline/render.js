// @ts-check
/**
 * DOM-слой инлайна: оболочки в сообщениях (реконсиляция по data-uris-inl),
 * ручная 📷-кнопка в .mes_buttons, клик по готовой картинке → общий лайтбокс
 * по всем картинкам сообщения (showLightbox, с рабочими галерейными
 * действиями), реролл = замена (старая остаётся в галерее).
 *
 * Реконсиляция идемпотентна: оболочка помечена data-uris-inl="<key>"
 * (idx|type|descHash) и data-uris-status; при том же ключе и статусе — keep,
 * при смене статуса (pending→ready/error, аменда 1) — замена узла. Оболочки,
 * чей ключ не покрыт текущими маркерами (маркер убрали/описание изменилось),
 * снимаются — «реролл = замена»; ручные (data-manual="1") и готовые результаты
 * ручной генерации (idx<0) переживают чистку.
 */
import { state, getCtx } from '../core.js';
import { parseInline } from './grammar.js';
import { getSlot, upsertItem, itemKey } from './store.js';
import { sanitizeTriggerList, buildAliasIndex, resolveProfile } from './triggers.js';
import { stableHash, queueInlineJob, DEFAULT_GRACE } from './runner.js';
import { showSingleImage, showLightbox } from '../ui/lightbox.js';

const SHELL_ATTR = 'data-uris-inl';
const STATUS_ATTR = 'data-uris-status';
const HIDDEN_ATTR = 'data-uris-inl-hidden';
const DEBOUNCE_MS = 250;

let _observer = null;
let _onInlineEvent = null;
let _onManual = null;
let _reroll = null;
let _debounceId = null;

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
 * reroll сохраняется в модульную переменную (по умолчанию — автолейн). */
export function initRender({ reroll, onManual } = {}) {
    if (typeof reroll === 'function') _reroll = reroll;
    if (typeof onManual === 'function') _onManual = onManual;
    if (_onInlineEvent) return; // слушатели уже стоят; reroll/onManual обновлены выше
    _onInlineEvent = () => { try { reconcileVisible(); } catch { /* рендер не роняет обработчик */ } };
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('uris:inline-update', _onInlineEvent);
        window.addEventListener('uris:inline-end', _onInlineEvent);
    }
    ensureObserver();
    try { reconcileVisible(); } catch { /* первая проводка не критична */ }
}

/** Отписка (выгрузка расширения) и выключение инлайна (applyInlineRuntime).
 * Обязана снимать и ручные 📷-кнопки: reconcile, который их ставит, при
 * выключенной функции не работает — без явной уборки кнопка оставалась бы
 * в чате мёртвым следом. */
export function shutdownRender() {
    if (_observer) { try { _observer.disconnect(); } catch { /* уже снят */ } _observer = null; }
    if (_debounceId) { clearTimeout(_debounceId); _debounceId = null; }
    if (_onInlineEvent && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('uris:inline-update', _onInlineEvent);
        window.removeEventListener('uris:inline-end', _onInlineEvent);
    }
    _onInlineEvent = null;
    _reroll = null;
    _onManual = null;
    removeManualButtons();
}

/** Снять все 📷-кнопки из чата. */
function removeManualButtons() {
    if (typeof document === 'undefined') return;
    let scope = document;
    try { scope = (typeof document.getElementById === 'function' && document.getElementById('chat')) || document; } catch { /* fake без getElementById */ }
    let btns = [];
    try { btns = Array.from(scope.querySelectorAll('[data-uris-manual]')); } catch { return; }
    for (const btn of btns) removeNode(btn);
}

function ensureObserver() {
    if (_observer || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    const chatEl = typeof document.getElementById === 'function' ? document.getElementById('chat') : null;
    if (!chatEl) return;
    _observer = new MutationObserver(onChatMutated);
    _observer.observe(chatEl, { childList: true, subtree: true });
}

function onChatMutated() {
    if (_debounceId) clearTimeout(_debounceId);
    _debounceId = setTimeout(() => {
        _debounceId = null;
        try { reconcileVisible(); ensureObserver(); } catch { /* реконсиляция не роняет чат */ }
    }, DEBOUNCE_MS);
}

/**
 * Обход .mes[mesid] в #chat: план по маркерам → mount/keep; заодно ручные
 * 📷-кнопки. Дешёвый fast-path: нет маркеров, items и существующих оболочек — skip.
 */
export function reconcileVisible() {
    if (typeof document === 'undefined') return;
    if (state.settings?.inlineEnabled !== true) return;
    ensureObserver();
    let ctx = null;
    try { ctx = getCtx(); } catch { /* ST недоступен (тесты/ранняя инициализация) */ }
    const chat = ctx?.chat || null;
    let scope = document;
    try { scope = (typeof document.getElementById === 'function' && document.getElementById('chat')) || document; } catch { /* fake без getElementById */ }
    let mesEls = [];
    try { mesEls = Array.from(scope.querySelectorAll('.mes')); } catch { return; }
    for (const mesEl of mesEls) {
        const msgIdRaw = mesEl.getAttribute('mesid');
        if (msgIdRaw == null || msgIdRaw === '') continue;
        const msgId = Number(msgIdRaw);
        const mes = chat?.[msgId]?.mes;
        const markers = typeof mes === 'string' ? parseInline(mes) : [];
        let shellEls = [];
        try { shellEls = Array.from(mesEl.querySelectorAll(`[${SHELL_ATTR}]`)); } catch { shellEls = []; }
        // 📷-кнопка нужна каждому AI-сообщению — до fast-path (chat передан,
        // getCtx() на сообщение не зовётся; getSlot ниже не затрагивается).
        ensureManualButton(mesEl, msgId, chat);
        // Fast-path ДО getSlot: без маркеров и оболочек store не читаем — иначе
        // каждый проход материализует uris_inline-скелет в chatMetadata чатов,
        // где инлайн не использовался. Ручные оболочки несут data-uris-inl, так
        // что shellEls покрывает все сообщения, которым нужны данные слота.
        if (!markers.length && !shellEls.length) continue;
        const items = getSlot(msgId).items;
        const textEl = mesEl.querySelector('.mes_text');
        if (!textEl) continue;
        const existingKeys = new Set(shellEls.map(el => el.getAttribute(SHELL_ATTR)).filter(Boolean));
        const inFlight = state.activeGenerations instanceof Map ? new Set(state.activeGenerations.keys()) : null;
        const plan = computeShellPlan({ msgId, markers, items, hashFn: stableHash, existingKeys, inFlight });
        for (const entry of plan) {
            const cur = shellEls.find(el => el.getAttribute(SHELL_ATTR) === entry.key) || null;
            // keep только при совпадении и статуса: pending→ready обновится (аменда 1)
            if (entry.domAction === 'keep' && cur && cur.getAttribute(STATUS_ATTR) === entry.status
                && cur.getAttribute('data-uris-image') === String(entry.item?.imagePath || '')) continue;
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

/** DOM по статусу (см. план задачи: ready/pending/button/changed/error). */
function shellFor(msgId, entry) {
    const el = document.createElement('div');
    el.classList.add('uris-inl-shell');
    el.setAttribute(SHELL_ATTR, entry.key);
    el.setAttribute(STATUS_ATTR, entry.status);
    el.setAttribute('data-uris-image', String(entry.item?.imagePath || ''));
    if (entry.status === 'ready') {
        const profile = profileFor(entry.type);
        const img = document.createElement('img');
        img.setAttribute('src', `/${String(entry.item?.imagePath || '').replace(/^\/+/, '')}`);
        img.setAttribute('loading', 'lazy');
        img.setAttribute('alt', entry.desc || profile?.name || entry.type);
        img.setAttribute('title', `${profile?.name || entry.type} — клик: просмотр всех картинок поста`);
        img.addEventListener('click', () => { void openMessageLightbox(msgId, entry); });
        el.appendChild(img);
        el.appendChild(badge(profile?.name || entry.type));
        return el;
    }
    if (entry.status === 'pending') {
        const profile = profileFor(entry.type);
        const frame = document.createElement('div');
        frame.setAttribute('style', 'aspect-ratio:' + aspectRatioCss(profile?.aspect || '1:1') + ';max-width:100%;border:1px dashed var(--SmartThemeBorderColor,#666);border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:12px;color:var(--SmartThemeEmColor,inherit);font-size:small;line-height:1.4');
        const spin = document.createElement('i');
        spin.classList.add('fa-solid');
        spin.classList.add('fa-spinner');
        spin.classList.add('fa-spin');
        frame.appendChild(spin);
        const label = document.createElement('span');
        label.textContent = `Генерирую ${profile?.name || entry.type}…`;
        frame.appendChild(label);
        const cancel = document.createElement('button');
        cancel.classList.add('uris-inl-cancel');
        cancel.setAttribute('data-uris-cancel', '1');
        cancel.setAttribute('title', 'Отменить генерацию');
        cancel.setAttribute('style', 'margin-top:2px;padding:2px 10px;border-radius:8px;border:1px solid var(--SmartThemeBorderColor,#666);background:transparent;color:inherit;cursor:pointer;font-size:small');
        cancel.textContent = '✕';
        cancel.addEventListener('click', (ev) => {
            try { ev?.stopPropagation?.(); } catch { /* fake-dom */ }
            cancelPending(entry);
        });
        frame.appendChild(cancel);
        el.appendChild(frame);
        el.appendChild(badge(profile?.name || entry.type));
        return el;
    }
    // button / changed / error — кликабельная строка
    const btn = document.createElement('button');
    btn.classList.add('uris-inl-btn');
    btn.setAttribute('style', 'display:inline-flex;align-items:center;gap:6px;margin:4px 0;padding:4px 10px;border-radius:8px;border:1px solid var(--SmartThemeBorderColor,#666);background:transparent;color:inherit;cursor:pointer;font-size:small;line-height:1.4');
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
 * Чистое: items для лайтбокса по слоту сообщения. Берём готовые результаты с
 * файлом, порядок — по idx (затем по createdAt: у ручных idx=-1, их несколько).
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
        .filter(item => item && item.status === 'ready' && item.imagePath)
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

/** Открыть общий просмотрщик по всем готовым картинкам сообщения. */
async function openMessageLightbox(msgId, entry) {
    const slot = getSlot(msgId);
    const cards = await cardsByIds((slot.items || []).map(item => item?.cardId));
    const items = messageLightboxItems(slot.items, cards, msgId);
    if (!items.length) return;
    const clicked = items.findIndex(item => item.__inlineKey === entry.key);
    try {
        await _viewer.showLightbox(items, clicked < 0 ? 0 : clicked, { chatId: getCtx()?.chatId ?? null });
    } catch {
        // Просмотрщик недоступен (нет PhotoSwipe) — деградируем к одиночному.
        try {
            void showSingleImage({ src: `/${String(entry.item?.imagePath || '').replace(/^\/+/, '')}`, prompt: entry.desc || '' });
        } catch { /* и одиночный не поднялся */ }
    }
}

function profileFor(type) {
    try {
        return resolveProfile(buildAliasIndex(sanitizeTriggerList(state.settings?.inlineTriggers || [])), type);
    } catch { return null; }
}

/** '9:16' → '9 / 16' (синтаксис CSS aspect-ratio). */
function aspectRatioCss(aspect) {
    return String(aspect || '1:1').split(':').map(p => p.trim() || '1').join(' / ');
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

/** mount: спрятать raw маркера + создать/заменить оболочку (в конец .mes_text). */
function mountShell(textEl, entry, cur) {
    if (!textEl) return;
    hideMarkerText(textEl, entry.marker?.raw);
    const shell = shellFor(entry.msgId, entry);
    if (cur && cur.parentNode) {
        try { cur.replaceWith(shell); } catch { textEl.appendChild(shell); }
    } else {
        textEl.appendChild(shell);
    }
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

function removeNode(el) {
    try {
        if (typeof el.remove === 'function') el.remove();
        else el.parentNode?.removeChild(el);
    } catch { /* узел уже снят */ }
}

/** Ручные оболочки (data-manual): pending → ready/error из store (аменда 1).
 * Осиротевший pending (requestId вне inFlight, грейс истёк) → error: ручная
 * генерация, убитая перезагрузкой, не должна крутить спиннер вечно.
 * Гард сходимости — как в marker-пути: тот же ключ и статус → узел уже
 * актуален, безгардовая replaceWith() создавала бы новый DOM-узел каждый
 * проход (чурн ~4 Гц через MutationObserver на error-оболочках). */
function reconcileManualShells(mesEl, textEl, items, { inFlight = null, now = Date.now, grace = DEFAULT_GRACE } = {}) {
    if (!textEl) return;
    let manualEls = [];
    try { manualEls = Array.from(mesEl.querySelectorAll('[data-manual="1"]')); } catch { return; }
    const msgId = Number(mesEl.getAttribute('mesid'));
    for (const el of manualEls) {
        const key = el.getAttribute(SHELL_ATTR);
        if (!key) continue;
        const item = (items || []).find(i => itemKey(i) === key) || null;
        if (!item) continue;
        let computedStatus = (item.status === 'ready' && !item.imagePath) ? 'error' : item.status;
        let orphaned = false;
        if (computedStatus === 'pending') {
            const live = !!(inFlight && item.requestId != null && inFlight.has(item.requestId));
            const fresh = (now() - (item.createdAt || 0)) < grace;
            if (!live && !fresh) { computedStatus = 'error'; orphaned = true; }
        }
        if (computedStatus !== 'ready' && computedStatus !== 'error') continue; // живой/свежий pending — оболочка уже показана
        if (el.getAttribute(SHELL_ATTR) === key && el.getAttribute(STATUS_ATTR) === computedStatus) continue;
        const desc = el.getAttribute('data-uris-desc') || '';
        const entry = {
            msgId, idx: item.idx, type: item.type, desc, descHash: item.descHash,
            key, item, status: computedStatus, orphaned,
            marker: { raw: null },
        };
        const shell = shellFor(msgId, entry);
        if (computedStatus !== 'ready') {
            // error остаётся ручной оболочкой (retry кликом)
            shell.setAttribute('data-manual', '1');
            shell.setAttribute('data-uris-desc', desc);
        }
        try { el.replaceWith(shell); } catch { removeNode(el); }
    }
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

// ── Ручная 📷-кнопка (меню дополнительных действий сообщения) ──

/** Для каждого .mes[mesid] AI-сообщения с .mes_buttons, где ещё нет кнопки.
 * chat можно передать (реконсиляция уже зовёт getContext один раз на проход). */
export function ensureManualButtons(rootEl, chat = null) {
    if (typeof document === 'undefined') return;
    const scope = rootEl || (typeof document.getElementById === 'function' && document.getElementById('chat')) || document;
    let mesEls = [];
    try { mesEls = Array.from(scope.querySelectorAll('.mes')); } catch { return; }
    if (chat == null) {
        try { chat = getCtx()?.chat || null; } catch { chat = null; }
    }
    for (const mesEl of mesEls) {
        const msgId = mesEl.getAttribute('mesid');
        if (msgId == null || msgId === '') continue;
        ensureManualButton(mesEl, Number(msgId), chat);
    }
}

function ensureManualButton(mesEl, msgId, chat) {
    try {
        let isUser = false;
        try { isUser = !!chat?.[Number(msgId)]?.is_user; } catch { /* ST недоступен */ }
        if (isUser) return;
        const buttons = mesEl.querySelector('.mes_buttons');
        if (!buttons || buttons.querySelector('[data-uris-manual]')) return;
        const btn = document.createElement('div');
        btn.classList.add('mes_button');
        btn.classList.add('fa-solid');
        btn.classList.add('fa-camera');
        btn.setAttribute('data-uris-manual', String(msgId));
        btn.setAttribute('title', 'URIS: нарисовать по сообщению');
        btn.addEventListener('click', (ev) => {
            try { ev?.stopPropagation?.(); } catch { /* fake-dom */ }
            onManualClick(msgId, mesEl);
        });
        // Место кнопки — меню дополнительных действий ST (.extraMesButtons, как
        // translate/REGULATE); на старых шаблонах без него — фолбэк в .mes_buttons.
        const extra = buttons.querySelector('.extraMesButtons');
        (extra || buttons).appendChild(btn);
    } catch { /* кнопка не критична */ }
}

/** M1: reroll({msgId, idx:-1, type:'img', desc: первые 4000 символов}) +
 * ручная pending-оболочка (data-manual="1") в конец .mes_text. */
function onManualClick(msgId, mesEl) {
    let text = '';
    try { text = String(getCtx()?.chat?.[Number(msgId)]?.mes || ''); } catch { /* ST недоступен */ }
    const desc = text.slice(0, 4000);
    if (typeof _onManual === 'function') {
        try { _onManual({ msgId: Number(msgId), idx: -1, type: 'img', desc }); } catch (e) { startRerollErrorToast(e); }
        return;
    }
    try {
        const textEl = mesEl?.querySelector('.mes_text');
        if (textEl) {
            const entry = {
                msgId: Number(msgId), idx: -1, type: 'img', desc,
                descHash: stableHash(`img|${desc}`),
                key: `-1|img|${stableHash(`img|${desc}`)}`,
                status: 'pending', item: { requestId: null }, marker: { raw: null },
            };
            const shell = shellFor(entry.msgId, entry);
            shell.setAttribute('data-manual', '1');
            shell.setAttribute('data-uris-desc', desc);
            const cur = textEl.querySelector(`[${SHELL_ATTR}="${entry.key}"]`);
            if (cur && cur.parentNode) {
                try { cur.replaceWith(shell); } catch { textEl.appendChild(shell); }
            } else {
                textEl.appendChild(shell);
            }
        }
    } catch { /* DOM недоступен — job всё равно уйдёт */ }
    startReroll({ msgId: Number(msgId), idx: -1, type: 'img', desc });
}

function startRerollErrorToast(e) {
    try { toastr?.error(e?.message || e, 'URIS'); } catch { /* node */ }
}
