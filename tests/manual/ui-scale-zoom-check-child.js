// @ts-check
// Подопытный модуль ui-scale-zoom-check.html (загружается внутри iframe 390×800).
// Рендерит НАСТОЯЩУЮ вкладку «Референсы» со стабами SillyTavern и измеряет
// координатные пространства при разных --uris-scale. См. HTML-шапку для запуска.

// ── ST-стабы (как в tests/tab-references.test.js и refs-real-render.html) ──
const memoryStore = new Map();
const makeLocalforage = () => ({
    async getItem(key) { return memoryStore.has(key) ? memoryStore.get(key) : []; },
    async setItem(key, value) { memoryStore.set(key, value); },
    async removeItem(key) { memoryStore.delete(key); },
});
let _chatMetadata = {};
globalThis.SillyTavern = {
    getContext: () => ({
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        saveMetadata: () => {},
        getRequestHeaders: () => ({}),
        get chatMetadata() { return _chatMetadata; },
    }),
    libs: { localforage: makeLocalforage() },
};
globalThis.toastr = { info() {}, success() {}, warning() {}, error() {} };

const img = (i) => 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="#3a4a5a"/><text x="60" y="85" text-anchor="middle" fill="#fff" font-size="20">${i}</text></svg>`);

const { render } = await import('../../src/ui/tab-references.js');
const { setRefStoreForTests, resetRefStoreForTests } = await import('../../src/refs-library.js');

const collections = new Map();
const clone = (v) => JSON.parse(JSON.stringify(v));
const store = {
    async available() { return true; },
    async list(name) { return clone(collections.get(name) || []); },
    async create(name, payload) {
        const records = collections.get(name) || [];
        const persisted = { ...clone(payload), updatedAt: 'stub-time' };
        records.push(persisted);
        collections.set(name, records);
        return clone(persisted);
    },
    async update(name, id, payload) {
        const records = collections.get(name) || [];
        const idx = records.findIndex(r => r.id === id);
        if (idx === -1) throw new Error('not found');
        records[idx] = { ...records[idx], ...clone(payload), id };
        return clone(records[idx]);
    },
    async delete(name, id) {
        collections.set(name, (collections.get(name) || []).filter(r => r.id !== id));
    },
};

resetRefStoreForTests();
for (let i = 1; i <= 30; i++) {
    await store.create('refs', { id: `r${i}`, name: `Реф ${i}`, imagePath: img(i), folders: [] });
}
setRefStoreForTests(store);

const body = document.getElementById('urisBody');

async function rerender() {
    // Маркер активной вкладки: десктопная ветка _renderAll стережётся им
    // (isCurrent()), иначе сетка не рендерится вне tabs.js.
    body.__urisTabId = 'references';
    await render(body);
    // Экран «grid» — как после выбора папки (в десктоп-раскладке клика нет — ок).
    body.querySelector('.uris-mobile-folder-item')?.click();
    await new Promise(r => setTimeout(r, 100));
}

function collectMetrics() {
    const win = document.getElementById('urisWindow');
    const tabs = document.getElementById('urisTabs');
    const wRect = win.getBoundingClientRect();
    const bRect = body.getBoundingClientRect();
    const zoom = parseFloat(getComputedStyle(body).zoom) || 1;
    const ccz = 'currentCSSZoom' in body ? body.currentCSSZoom : null;
    const refsMode = body.classList.contains('uris-refs-mobile') ? 'mobile-stack' : 'desktop';
    const expectedRefsMode = body.clientWidth < 480 ? 'mobile-stack' : 'desktop';
    return {
        viewport: `${innerWidth}x${innerHeight}`,
        scaleNumber: scaleValue,
        scaleVar: document.documentElement.style.getPropertyValue('--uris-scale') || '(unset)',
        bodyComputedZoom: zoom,
        bodyCurrentCSSZoom: ccz,
        bodyClientWidth: body.clientWidth,
        bodyRectWidth: +bRect.width.toFixed(1),
        checks: {
            // clientWidth (layout-px) × zoom = визуальная ширина, и gBCR с ней согласен:
            visualMatchesClientTimesZoom: Math.abs(bRect.width - body.clientWidth * zoom) <= 2,
            // Fullscreen-окно не вылезает из вьюпорта:
            windowFitsViewport: wRect.right <= innerWidth + 0.5 && wRect.width <= innerWidth + 0.5,
            // Зумлённое тело не вылезает из окна (containing block / zoom — без компенсаций):
            bodyFitsWindow: bRect.right <= wRect.right + 0.5 && bRect.left >= wRect.left - 0.5,
            // И на уровне документа горизонтального скролла нет:
            pageNoHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 0.5,
            // Брейкпоинт референсов следует layout-px (визуал/zoom), одинаково на обеих платформах:
            refsModeMatchesLayoutPx: refsMode === expectedRefsMode,
        },
        refsMode,
        expectedRefsMode,
        tabsStripScrolls: tabs.scrollWidth > tabs.clientWidth + 1,
    };
}

let scaleValue = 1;
async function setScale(v) {
    scaleValue = v;
    document.documentElement.style.setProperty('--uris-scale', String(v));
    await rerender();
    window.__metrics = collectMetrics();
    window.dispatchEvent(new Event('metrics'));
}

window.__setScale = setScale;
await setScale(Number(new URLSearchParams(location.search).get('scale')) || 1);
console.log('ui-scale-zoom-check metrics', window.__metrics);
