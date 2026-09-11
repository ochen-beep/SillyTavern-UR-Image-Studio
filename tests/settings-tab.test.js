// @ts-check
// Tests for the Settings tab: uiScale normalization/persistence, tab rendering
// and its live-apply controls.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

// Module-scope bootstrap: the import chain (core → tab-settings → data-port →
// refs-library / diagnostic-dump → netdump) needs ST globals before first load.
let fakeDoc = makeFakeDocument();
globalThis.document = fakeDoc.document;
globalThis.document.documentElement = makeScaleRoot();
globalThis.window = { location: { origin: 'http://localhost:8000' }, dispatchEvent: () => {} };
globalThis.toastr = { success: () => {}, error: () => {}, info: () => {}, warning: () => {} };
globalThis.SillyTavern = makeStMock();

const { state, loadSettings, applyUiScale, applyFontScale, normalizeUiScale, normalizeFontScale, MODULE_NAME } = await import('../src/core.js');
const { render } = await import('../src/ui/tab-settings.js');

function makeScaleRoot() {
    return { style: { _props: {}, setProperty(k, v) { this._props[k] = String(v); } } };
}

function makeStMock() {
    return {
        getContext: () => ({
            extensionSettings: extensionSettings,
            saveSettingsDebounced: () => { saveCalls++; },
            getRequestHeaders: () => ({}),
        }),
        libs: { localforage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } },
    };
}

let extensionSettings = {};
let saveCalls = 0;

beforeEach(() => {
    fakeDoc = makeFakeDocument();
    globalThis.document = fakeDoc.document;
    globalThis.document.documentElement = makeScaleRoot();
    extensionSettings = {};
    saveCalls = 0;
    globalThis.SillyTavern = makeStMock();
    state.settings = {
        uiScale: 1,
        fontScale: 1,
        debugMode: false,
        useParametersForAllChats: false,
    };
});

function makeRoot() {
    const root = globalThis.document.createElement('div');
    root.id = 'root';
    return root;
}

test('normalizeUiScale clamps, snaps to step and collapses float noise', () => {
    assert.equal(normalizeUiScale(3), 1.5);
    assert.equal(normalizeUiScale(0.1), 0.75);
    assert.equal(normalizeUiScale('abc'), 1);
    assert.equal(normalizeUiScale(undefined), 1);
    assert.equal(normalizeUiScale(1.234), 1.25);
    assert.equal(normalizeUiScale(1), 1);
});

test('normalizeFontScale clamps to its own narrower range', () => {
    assert.equal(normalizeFontScale(2), 1.4);
    assert.equal(normalizeFontScale(0.1), 0.85);
    assert.equal(normalizeFontScale('oops'), 1);
    assert.equal(normalizeFontScale(undefined), 1);
    assert.equal(normalizeFontScale(1.234), 1.25);
    assert.equal(normalizeFontScale(1), 1);
});

test('loadSettings clamps persisted scales and fills missing ones', () => {
    extensionSettings[MODULE_NAME] = { uiScale: 4, fontScale: 3 };
    loadSettings();
    assert.equal(state.settings.uiScale, 1.5);
    assert.equal(state.settings.fontScale, 1.4);

    delete extensionSettings[MODULE_NAME];
    loadSettings();
    assert.equal(state.settings.uiScale, 1);
    assert.equal(state.settings.fontScale, 1);
});

test('applyUiScale publishes --uris-scale on documentElement', () => {
    state.settings.uiScale = 1.25;
    applyUiScale();
    assert.equal(globalThis.document.documentElement.style._props['--uris-scale'], '1.25');
});

test('applyFontScale publishes --uris-font-scale on documentElement', () => {
    state.settings.fontScale = 1.15;
    applyFontScale();
    assert.equal(globalThis.document.documentElement.style._props['--uris-font-scale'], '1.15');
});

test('render reflects stored scale and toggles', () => {
    state.settings.uiScale = 1.25;
    state.settings.fontScale = 1.15;
    state.settings.debugMode = true;
    const root = makeRoot();
    render(root);
    const slider = root.querySelector('#urisUiScale');
    assert.equal(slider.value, '125');
    assert.equal(root.querySelector('#urisUiScaleValue').textContent, '125%');
    assert.equal(slider.getAttribute('min'), '75');
    assert.equal(slider.getAttribute('max'), '150');
    assert.equal(slider.getAttribute('step'), '5');

    const fontSlider = root.querySelector('#urisFontScale');
    assert.equal(fontSlider.value, '115');
    assert.equal(root.querySelector('#urisFontScaleValue').textContent, '115%');
    assert.equal(fontSlider.getAttribute('min'), '85');
    assert.equal(fontSlider.getAttribute('max'), '140');
    assert.equal(fontSlider.getAttribute('step'), '5');

    assert.equal(root.querySelector('#uris_debug_mode').checked, true);
    assert.equal(root.querySelector('#uris_use_all_params').checked, false);
});

test('slider input applies the scale live: state, CSS var and debounced save', async () => {
    const root = makeRoot();
    render(root);
    const slider = root.querySelector('#urisUiScale');
    slider.value = '125';
    await slider.dispatchEvent({ type: 'input', target: slider });
    assert.equal(state.settings.uiScale, 1.25);
    assert.equal(globalThis.document.documentElement.style._props['--uris-scale'], '1.25');
    assert.equal(root.querySelector('#urisUiScaleValue').textContent, '125%');
    assert.ok(saveCalls > 0);
});

test('font slider input applies the font scale live', async () => {
    const root = makeRoot();
    render(root);
    const slider = root.querySelector('#urisFontScale');
    slider.value = '110';
    await slider.dispatchEvent({ type: 'input', target: slider });
    assert.equal(state.settings.fontScale, 1.1);
    assert.equal(globalThis.document.documentElement.style._props['--uris-font-scale'], '1.1');
    assert.equal(root.querySelector('#urisFontScaleValue').textContent, '110%');
    assert.ok(saveCalls > 0);
});

test('reset buttons restore both scales to 100%', async () => {
    state.settings.uiScale = 1.4;
    state.settings.fontScale = 1.3;
    const root = makeRoot();
    render(root);
    await root.querySelector('#urisUiScaleReset').click();
    assert.equal(state.settings.uiScale, 1);
    assert.equal(globalThis.document.documentElement.style._props['--uris-scale'], '1');
    assert.equal(root.querySelector('#urisUiScaleValue').textContent, '100%');

    await root.querySelector('#urisFontScaleReset').click();
    assert.equal(state.settings.fontScale, 1);
    assert.equal(globalThis.document.documentElement.style._props['--uris-font-scale'], '1');
    assert.equal(root.querySelector('#urisFontScaleValue').textContent, '100%');
});

test('behavior toggles persist debug mode and global params flags', async () => {
    const root = makeRoot();
    render(root);
    const debug = root.querySelector('#uris_debug_mode');
    debug.checked = true;
    await debug.change();
    assert.equal(state.settings.debugMode, true);
    debug.checked = false;
    await debug.change();
    assert.equal(state.settings.debugMode, false);

    const allParams = root.querySelector('#uris_use_all_params');
    allParams.checked = true;
    await allParams.change();
    assert.equal(state.settings.useParametersForAllChats, true);
});

test('render without loaded settings shows a fallback hint', () => {
    state.settings = null;
    const root = makeRoot();
    render(root);
    assert.match(root.textContent, /не загружены/);
});

test('uiScale slider is disabled with a hint when the engine has no CSS zoom', () => {
    // Firefox Android <126 / старые WebView: zoom-правило в style.css там
    // игнорируется, слайдер без гейта крутился бы вхолостую.
    const hadCss = 'CSS' in globalThis;
    const originalCss = globalThis.CSS;
    globalThis.CSS = { supports: () => false };
    try {
        const root = makeRoot();
        render(root);
        assert.equal(root.querySelector('#urisUiScale').disabled, true, 'слайдер масштаба должен быть задизейблен');
        assert.equal(root.querySelector('#urisUiScaleReset').disabled, true, 'кнопка сброса тоже');
        assert.match(root.textContent, /CSS zoom/, 'подсказка объясняет причину');
        assert.match(root.textContent, /Размер шрифта/, 'подсказка уводит на работающий регулятор');
        // Слайдер шрифта остаётся живым — он не зависит от zoom.
        assert.equal(root.querySelector('#urisFontScale').disabled, false);
    } finally {
        if (hadCss) globalThis.CSS = originalCss;
        else delete globalThis.CSS;
    }
});

test('uiScale slider stays enabled when CSS zoom is supported', () => {
    const hadCss = 'CSS' in globalThis;
    const originalCss = globalThis.CSS;
    globalThis.CSS = { supports: (prop, val) => prop === 'zoom' && val === '1.5' };
    try {
        const root = makeRoot();
        render(root);
        assert.equal(root.querySelector('#urisUiScale').disabled, false);
        assert.equal(root.querySelector('#urisUiScaleReset').disabled, false);
        // Старая оговорка «мобильный полноэкранный режим остаётся 100%» удалена:
        // подсказка теперь сообщает, что fullscreen масштабируется.
        assert.match(root.textContent, /Работает и в мобильном полноэкранном режиме/);
        assert.doesNotMatch(root.textContent, /остаются 100%/);
    } finally {
        if (hadCss) globalThis.CSS = originalCss;
        else delete globalThis.CSS;
    }
});

test('launcher mode select: reflects stored mode, persists and notifies via uris:launcher-mode-changed', async () => {
    // launchMode отсутствует в settings (старые saves) — рендер дефолтит в bar.
    delete state.settings.launcherMode;
    const root = makeRoot();
    render(root);
    const sel = root.querySelector('#uris_launcher_mode_tab');
    assert.ok(sel, 'селект «Кнопка запуска» должен рендериться во вкладке «Настройки»');
    assert.equal(sel.value, 'bar');

    const events = [];
    const origDispatch = globalThis.window.dispatchEvent;
    globalThis.window.dispatchEvent = (ev) => { events.push(ev?.type); };
    try {
        sel.value = 'floating';
        await sel.dispatchEvent({ type: 'change', target: sel });
    } finally {
        globalThis.window.dispatchEvent = origDispatch;
    }
    assert.equal(state.settings.launcherMode, 'floating');
    assert.ok(saveCalls > 0, 'изменение должно сохраняться');
    assert.ok(events.includes('uris:launcher-mode-changed'), 'index.js перемонтирует лаунчеры по этому событию');
});

test('external bridge section: toggles render, persist and switch the lab tab', async () => {
    // bridgeEnabled/bridgeTab отсутствуют (старые saves) — секция рендерится, мост включён, вкладка скрыта.
    delete state.settings.bridgeEnabled;
    delete state.settings.bridgeTab;
    const root = makeRoot();
    render(root);
    const toggle = root.querySelector('#uris_bridge_enabled');
    assert.ok(toggle, 'тумблер «Разрешить генерацию другим расширениям» должен рендериться');
    assert.equal(toggle.checked, true, 'по умолчанию мост включён');
    // Ручные вызовы переехали на вкладку «Мост» — в настройках только тумблеры.
    assert.equal(root.querySelector('#urisBridgeRun'), null, 'кнопки ручного вызова в настройках быть не должно');
    assert.equal(root.querySelector('#uris_bridge_tab')?.checked, false, 'вкладка «Мост» по умолчанию скрыта');

    toggle.checked = false;
    await toggle.dispatchEvent({ type: 'change', target: toggle });
    assert.equal(state.settings.bridgeEnabled, false);

    const tabToggle = root.querySelector('#uris_bridge_tab');
    tabToggle.checked = true;
    await tabToggle.dispatchEvent({ type: 'change', target: tabToggle });
    assert.equal(state.settings.bridgeTab, true);
    assert.ok(saveCalls > 0, 'переключения должны сохраняться');
});
