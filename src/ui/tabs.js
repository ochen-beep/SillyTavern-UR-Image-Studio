// @ts-check
/**
 * Floating window tab framework: API, References, Generate, Gallery, Templates.
 * Each tab registers {id, label, render} and receives a root element on activation.
 */
import { state, saveSettings, error } from '../core.js';
import { reportFailure, URIS_SCOPES } from '../error-pool.js';

const registry = [];
let _active = null;
let _renderEpoch = 0;

export function registerTab({ id, label, render, visible }) {
    if (!registry.find(t => t.id === id)) registry.push({ id, label, render, visible });
}

/** A tab can hide itself (e.g. experimental labs behind a settings toggle). */
function tabVisible(tab) {
    if (!tab) return false;
    if (typeof tab.visible === 'function') return !!tab.visible();
    return tab.visible !== false;
}

/** Resolve a requested tab to a registered id, falling back to the supplied default. */
export function resolveInitialTab(fallback = 'generate') {
    const active = getActiveTab();
    if (registry.some(t => t.id === active && tabVisible(t))) return active;
    const stored = state.settings?.activeTab;
    if (registry.some(t => t.id === stored && tabVisible(t))) return stored;
    if (registry.some(t => t.id === fallback && tabVisible(t))) return fallback;
    return registry.filter(tabVisible)[0]?.id ?? fallback;
}

/** Activate a registered tab. Initialization can suppress persistence or rendering. */
export function setActiveTab(id, { persist = true, render = true } = {}) {
    if (!registry.some(t => t.id === id && tabVisible(t))) return false;
    _active = id;
    const renderEpoch = ++_renderEpoch;
    if (persist && state.settings && state.settings.activeTab !== id) {
        state.settings.activeTab = id;
        saveSettings();
    }
    renderTabs();
    const tab = registry.find(t => t.id === id);
    const body = document.getElementById('urisBody');
    if (render && body && tab) {
        // Rebuilding body.innerHTML drops the scroll position (browser resets
        // scrollTop to 0 on teardown). Snapshot it now and restore after the
        // tab's async render lays out new content. This is belt-and-suspenders
        // for callers that still go through setActiveTab (e.g. tab switches),
        // so a refresh on the SAME tab no longer teleports the user to top.
        const savedScrollY = body.scrollTop;
        const savedScrollX = body.scrollLeft;
        body.innerHTML = '';
        // Reset body modifiers from the previous tab (e.g. full-bleed on references).
        body.className = 'uris-body';
        body.__urisRenderEpoch = renderEpoch;
        body.__urisTabId = id;
        const result = tab.render(body);
        const restore = () => {
            if (!body || renderEpoch !== _renderEpoch || _active !== id) return;
            body.scrollTop = savedScrollY;
            body.scrollLeft = savedScrollX;
        };
        const raf = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : fn => setTimeout(fn, 0);
        if (result && typeof result.then === 'function') {
            // Async render: wait for layout to settle before restoring.
            result.then(() => raf(restore)).catch(e => {
                // A swallowed rejection left the user with an empty tab and no
                // trace of why. The pool is the durable record (the header INFO
                // badge); the console line stays for the developer.
                error(`render tab "${id}":`, e);
                reportFailure({ scope: URIS_SCOPES.ui, message: `Вкладка «${tab.label}» не отрисовалась: ${e?.message || e}` });
            });
        } else {
            raf(restore);
        }
    }
    return true;
}

export function getActiveTab() { return _active; }

export function renderTabs() {
    const host = document.getElementById('urisTabs');
    if (!host) return;
    host.innerHTML = '';
    let activeBtn = null;
    for (const t of registry.filter(tabVisible)) {
        const btn = document.createElement('button');
        btn.className = 'uris-tab' + (t.id === _active ? ' uris-tab-active' : '');
        btn.textContent = t.label;
        btn.addEventListener('click', () => setActiveTab(t.id));
        host.appendChild(btn);
        if (t.id === _active) activeBtn = btn;
    }
    scrollActiveTabIntoView(host, activeBtn);
}

// Узкий экран: tab-бар горизонтально скроллится, и активная вкладка после
// renderTabs может остаться за краем (сохранённый activeTab из настроек,
// переключение из JS: вкладка «Медиа» включается из «Настроек»/«Медиа»).
// Доскролливаем к активной кнопке, только если она не видна целиком — иначе
// каждый ререндер дёргал бы бар даже там, где всё помещается.
function scrollActiveTabIntoView(host, btn) {
    if (!btn || typeof btn.scrollIntoView !== 'function') return;
    const raf = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : fn => setTimeout(fn, 0);
    // rAF: layout после innerHTML (зум --uris-scale, шрифты ST-темы) ещё не устоялся.
    raf(() => {
        if (!btn.isConnected) return;
        const left = btn.offsetLeft, right = left + btn.offsetWidth;
        const viewL = host.scrollLeft, viewR = viewL + host.clientWidth;
        if (left >= viewL && right <= viewR) return;
        btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    });
}

// Re-render the active tab (after data changes).
export function refreshActive() {
    if (_active) setActiveTab(_active, { persist: false });
}
