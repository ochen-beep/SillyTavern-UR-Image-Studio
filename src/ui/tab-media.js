// @ts-check
/**
 * Вкладка «Медиа»: инлайн-генерация в текущем чате. Видима только при
 * settings.inlineEnabled (мастер-тумблер — здесь и на вкладке «Настройки»).
 * Четыре блока: тумблер чата + слова-триггеры юзера, реестр триггер-профилей
 * (общий с мостом: bridge generate({trigger}) резолвится сюда), тестовый стенд
 * (очередь через автолейн с msgId=-1) и лента готовых картинок чата
 * (chatMetadata.uris_inline, только ready-результаты).
 */
import { state, getCtx, saveSettings, escapeHtml, error, DISPLAY_NAME, VALID_ASPECT_RATIOS } from '../core.js';
import { getConfig, setConfig } from '../inline/store.js';
import { sanitizeTriggerList, DEFAULT_TRIGGERS } from '../inline/triggers.js';
import { queueInlineJob } from '../inline/runner.js';
import { bindScanner, unbindScanner } from '../inline/scanner.js';
import { initRender, shutdownRender } from '../inline/render.js';
import { showSingleImage } from './lightbox.js';
import { renderTabs } from './tabs.js';

/** Лимит ленты: последние готовые картинки чата. */
const FEED_LIMIT = 20;

// Счётчик пользовательских профилей: id custom-<N> не должен повторяться,
// иначе sanitizeTriggerList (первый wins) молча выбросит копию.
let _customSeq = 0;

/** Профили из настроек; null/мусор (дефолт до loadSettings) → DEFAULT_TRIGGERS. */
function currentTriggers() {
    const stored = state.settings?.inlineTriggers;
    return sanitizeTriggerList(Array.isArray(stored) ? stored : DEFAULT_TRIGGERS);
}

/**
 * Общий рантайм-хелпер: применяет settings.inlineEnabled к сканеру и DOM-рендеру.
 * Вызывается из вкладки «Медиа», вкладки «Настройки» и index.init(); обе
 * выключающие ветки идемпотентны (unbind/shutdown на неподключённом — no-op).
 */
export function applyInlineRuntime() {
    setConfig({ enabled: state.settings?.inlineEnabled === true });
    if (state.settings?.inlineEnabled === true) {
        bindScanner();
        initRender({ reroll: queueInlineJob });
    } else {
        unbindScanner();
        shutdownRender();
    }
}

/** @param {HTMLElement} root */
export function render(root) {
    if (!state.settings) {
        root.innerHTML = '<div class="uris-settings"><small class="uris-hint">Настройки не загружены.</small></div>';
        return;
    }
    const cfg = getConfig();
    const triggers = currentTriggers();
    root.innerHTML = `
        <div class="uris-settings">
            <small class="uris-hint">Инлайн: URIS распознаёт [[тип: описание]] в ответах персонажа
            и кнопку 📷 у сообщений. Профили триггеров общие с мостом (generate({trigger})).</small>
            <section class="uris-settings-section">
                <h3>Инлайн в этом чате</h3>
                <label class="checkbox_label"><input type="checkbox" id="urisMediaEnabled" ${state.settings.inlineEnabled ? 'checked' : ''}><span>Включить инлайн-генерацию</span></label>
                <label class="checkbox_label"><input type="checkbox" id="urisMediaListen" ${cfg.listenUser ? 'checked' : ''}><span>Реагировать на мои сообщения (слова-триггеры)</span></label>
                <small class="uris-hint">Слова-триггеры: ${triggers.flatMap(t => t.aliases).slice(0, 8).map(escapeHtml).join(', ')}…</small>
            </section>
            <section class="uris-settings-section">
                <h3>Триггеры</h3>
                <div id="urisMediaTriggers"></div>
                <div class="uris-settings-actions">
                    <button type="button" class="uris-btn uris-btn-ghost" id="urisMediaTriggerAdd"><i class="fa-solid fa-plus"></i> Свой тип</button>
                </div>
                <small class="uris-hint">Профиль: алиасы — слова в тексте и типы [[маркеров]]; префикс/суффикс дописываются к описанию ({{char}}/{{user}} разворачиваются).</small>
            </section>
            <section class="uris-settings-section">
                <h3>Тестовый стенд</h3>
                <div class="uris-field">
                    <label for="urisMediaBenchType">Триггер</label>
                    <select class="text_pole" id="urisMediaBenchType">${triggers.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('')}</select>
                    <label for="urisMediaBenchDesc">Описание</label>
                    <textarea class="text_pole" id="urisMediaBenchDesc" rows="2">на пляже на закате</textarea>
                </div>
                <div class="uris-settings-actions">
                    <button type="button" class="uris-btn uris-btn-outline" id="urisMediaBenchRun"><i class="fa-solid fa-image"></i> Сгенерировать</button>
                </div>
                <div id="urisMediaBenchOut"><small class="uris-hint">Ровно та оболочка, что появится в чате.</small></div>
            </section>
            <section class="uris-settings-section">
                <h3>Лента чата</h3>
                <div id="urisMediaFeed"></div>
            </section>
        </div>`;
    bindMedia(root);
    renderTriggersBlock(root);
    renderFeed(root);
}

function bindMedia(root) {
    root.querySelector('#urisMediaEnabled')?.addEventListener('change', e => {
        state.settings.inlineEnabled = e.target.checked === true;
        saveSettings();
        applyInlineRuntime();
        // Мастер-тумблер управляет видимостью самой вкладки «Медиа».
        renderTabs();
    });
    root.querySelector('#urisMediaListen')?.addEventListener('change', e => {
        setConfig({ listenUser: e.target.checked === true });
    });
    root.querySelector('#urisMediaTriggerAdd')?.addEventListener('click', () => {
        const triggers = currentTriggers();
        const base = triggers.find(t => t.id === 'img') || DEFAULT_TRIGGERS[0];
        triggers.push({ ...base, id: nextCustomId(triggers), name: 'Свой тип' });
        state.settings.inlineTriggers = sanitizeTriggerList(triggers);
        saveSettings();
        renderTriggersBlock(root);
    });
    root.querySelector('#urisMediaBenchRun')?.addEventListener('click', () => { runBench(root); });
}

/** Уникальный id пользовательского профиля в пределах сессии. */
function nextCustomId(triggers) {
    const ids = new Set(triggers.map(t => t.id));
    let n = _customSeq + 1;
    while (ids.has(`custom-${n}`)) n++;
    _customSeq = n;
    return `custom-${n}`;
}

// ── Триггер-профили: свёрнутые карточки ──

function renderTriggersBlock(root) {
    const box = root?.querySelector?.('#urisMediaTriggers');
    if (!box) return;
    box.innerHTML = currentTriggers().map(triggerCardHtml).join('');
    // Слушатель на каждом контроле (не делегирование): change в карточке
    // пересобирает весь список из DOM и сохраняет.
    for (const control of Array.from(box.querySelectorAll('[data-field]'))) {
        control.addEventListener('change', () => { commitTriggers(box); });
    }
}

function triggerCardHtml(t) {
    const aspectOptions = VALID_ASPECT_RATIOS
        .map(ar => `<option value="${ar}"${ar === t.aspect ? ' selected' : ''}>${ar}</option>`).join('');
    return `
        <details class="uris-trigger-card" data-trigger-id="${escapeHtml(t.id)}">
            <summary>${escapeHtml(t.name)} <small class="uris-hint">(${escapeHtml(t.aliases.join(', '))})</small></summary>
            <div class="uris-field">
                <label>Название</label>
                <input type="text" class="text_pole" data-field="name" value="${escapeHtml(t.name)}">
            </div>
            <div class="uris-field">
                <label>Алиасы (через запятую)</label>
                <input type="text" class="text_pole" data-field="aliases" value="${escapeHtml(t.aliases.join(', '))}">
            </div>
            <div class="uris-field">
                <label>Формат</label>
                <select class="text_pole" data-field="aspect">${aspectOptions}</select>
            </div>
            <div class="uris-field">
                <label>Префикс промпта</label>
                <textarea class="text_pole" data-field="prefix" rows="1">${escapeHtml(t.prefix)}</textarea>
            </div>
            <div class="uris-field">
                <label>Суффикс промпта</label>
                <textarea class="text_pole" data-field="suffix" rows="2">${escapeHtml(t.suffix)}</textarea>
            </div>
            <div class="uris-field">
                <label>Референсы</label>
                <select class="text_pole" data-field="refsPolicy">
                    <option value="auto"${t.refsPolicy === 'auto' ? ' selected' : ''}>auto — подбирать по сцене</option>
                    <option value="off"${t.refsPolicy === 'off' ? ' selected' : ''}>off — не использовать</option>
                </select>
            </div>
        </details>`;
}

/** Собрать список профилей из DOM → sanitize → настройки + save. */
function commitTriggers(box) {
    const raw = [];
    for (const card of Array.from(box.querySelectorAll('details'))) {
        // textarea в фейковом DOM не заполняет value из содержимого — читаем
        // textContent как fallback (в браузере value всегда приоритетен).
        const read = (field) => {
            const el = card.querySelector(`[data-field="${field}"]`);
            if (!el) return '';
            return String(el.value ?? '') || String(el.textContent || '');
        };
        raw.push({
            id: card.getAttribute('data-trigger-id') || '',
            name: read('name'),
            aliases: read('aliases').split(',').map(s => s.trim()).filter(Boolean),
            aspect: read('aspect') || '1:1',
            prefix: read('prefix'),
            suffix: read('suffix'),
            refsPolicy: read('refsPolicy') || 'auto',
        });
    }
    state.settings.inlineTriggers = sanitizeTriggerList(raw);
    saveSettings();
}

// ── Тестовый стенд: платная генерация вне чата (msgId=-1) ──

async function runBench(root) {
    const out = root?.querySelector?.('#urisMediaBenchOut');
    const type = String(root?.querySelector?.('#urisMediaBenchType')?.value || 'img');
    const descEl = root?.querySelector?.('#urisMediaBenchDesc');
    const desc = (String(descEl?.value ?? '') || String(descEl?.textContent || '')).trim();
    if (!desc) {
        toastr?.error('Введите описание для тестовой генерации.', DISPLAY_NAME);
        return;
    }
    if (out) out.innerHTML = '<small class="uris-hint">Генерация…</small>';
    try {
        const res = await queueInlineJob({ msgId: -1, idx: 0, type, desc });
        if (out) {
            out.innerHTML = `<img src="/${escapeHtml(res?.imagePath || '')}" alt="" style="max-width:100%;max-height:240px;border-radius:8px;border:1px solid var(--SmartThemeBorderColor,#444)">`
                + '<small class="uris-hint">Готово — ровно та оболочка, что появится в чате.</small>';
        }
    } catch (e) {
        if (out) out.innerHTML = `<small class="uris-hint">Ошибка: ${escapeHtml(String(e?.message || e))}</small>`;
        toastr?.error('Тестовая генерация не удалась: ' + (e?.message || e), DISPLAY_NAME);
        error('media bench:', e);
    }
}

// ── Лента чата: готовые инлайн-картинки из chatMetadata ──

function collectFeedItems() {
    let msgs = null;
    try { msgs = getCtx()?.chatMetadata?.uris_inline?.msgs || null; } catch { return []; }
    if (!msgs || typeof msgs !== 'object') return [];
    const items = [];
    for (const [msgId, slot] of Object.entries(msgs)) {
        const list = Array.isArray(slot?.items) ? slot.items : [];
        for (const item of list) {
            if (item && item.status === 'ready' && item.imagePath) items.push({ ...item, msgId });
        }
    }
    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return items.slice(0, FEED_LIMIT);
}

function renderFeed(root) {
    const box = root?.querySelector?.('#urisMediaFeed');
    if (!box) return;
    const items = collectFeedItems();
    if (!items.length) {
        box.innerHTML = '<small class="uris-hint">Пока пусто: готовые инлайн-картинки этого чата появятся здесь.</small>';
        return;
    }
    box.innerHTML = `<div class="uris-media-feed">${items.map((it, i) => `<img class="uris-media-feed-item" src="/${escapeHtml(it.imagePath)}" data-feed-idx="${i}" alt="" title="${escapeHtml(`${it.type || 'img'} · ${new Date(it.createdAt || Date.now()).toLocaleString()}`)}" style="max-height:96px;max-width:96px;border-radius:8px;border:1px solid var(--SmartThemeBorderColor,#444);cursor:pointer">`).join('')}</div>`;
    for (const img of Array.from(box.querySelectorAll('img'))) {
        img.addEventListener('click', () => {
            const it = items[Number(img.getAttribute('data-feed-idx')) || 0];
            if (it) showSingleImage({ src: `/${it.imagePath}` });
        });
    }
}
