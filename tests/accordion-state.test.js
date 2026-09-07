// @ts-check
// Unit-тесты для src/ui/accordion-state.js — persistent open/close гармошек.
// state.settings.accordionState: Map<sectionId, boolean> (true = открыто).
// Дефолт отсутствующего ключа = открыто (defaultOpen=true).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ST-context stub. MODULE_NAME = 'ur_image_studio' (см. src/core.js:11).
let savedSettings = null;
let saveCalls = 0;
beforeEach(() => {
    savedSettings = null;
    saveCalls = 0;
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: {
                ur_image_studio: savedSettings,
            },
            saveSettingsDebounced: () => { saveCalls++; },
            saveSettings: () => { saveCalls++; },
        }),
        libs: {},
    };
});

// Необходимо импортировать после установки stub'а, но node ESM кэширует модули.
// Поэтому загружаем core/loadSettings и accordion-state в каждом тесте через
// динамический import с invalidation кэша — но проще: манипулируем state напрямую
// через API.

import { state, loadSettings, saveSettings, defaultSettings } from '../src/core.js';
import {
    getAccordionOpen, setAccordionOpen, forgetAccordion,
    bindHeaderToggle, bindDetailsToggle,
} from '../src/ui/accordion-state.js';

function resetState(accordionState) {
    // Имитируем loadSettings + пользовательскую правку accordionState.
    state.settings = { ...defaultSettings, accordionState: accordionState || {} };
    saveCalls = 0;
}

test('getAccordionOpen: возвращает true (дефолт) при отсутствии ключа', () => {
    resetState({});
    assert.equal(getAccordionOpen('any-id'), true);
    assert.equal(getAccordionOpen('any-id', true), true);
});

test('getAccordionOpen: defaultOpen=false работает когда ключа нет', () => {
    resetState({});
    assert.equal(getAccordionOpen('any-id', false), false);
});

test('getAccordionOpen: читает сохранённое значение', () => {
    resetState({ 'api:text-llm': false, 'api:image-conn': true });
    assert.equal(getAccordionOpen('api:text-llm'), false);
    assert.equal(getAccordionOpen('api:image-conn'), true);
});

test('getAccordionOpen: защищён при не-объектном accordionState', () => {
    resetState(null);
    // Имитируем повреждённое значение state.settings.accordionState = null.
    state.settings.accordionState = null;
    assert.equal(getAccordionOpen('any-id'), true, 'null → дефолт true');
    assert.equal(getAccordionOpen('any-id', false), false, 'null + defaultOpen=false → false');
    state.settings.accordionState = 'bogus';
    assert.equal(getAccordionOpen('any-id'), true, 'string → дефолт true');
    assert.equal(getAccordionOpen('any-id', false), false, 'string + defaultOpen=false → false');
});

test('setAccordionOpen: пишет в state и вызывает saveSettings', () => {
    resetState({});
    setAccordionOpen('api:text-llm', false);
    assert.equal(state.settings.accordionState['api:text-llm'], false);
    assert.equal(saveCalls, 1);
    // повтор с тем же значением — no-op, не должен сохранять снова
    setAccordionOpen('api:text-llm', false);
    assert.equal(saveCalls, 1);
    setAccordionOpen('api:text-llm', true);
    assert.equal(state.settings.accordionState['api:text-llm'], true);
    assert.equal(saveCalls, 2);
});

test('setAccordionOpen: лечит не-объектный accordionState', () => {
    resetState({});
    state.settings.accordionState = null;
    setAccordionOpen('x', true);
    assert.deepEqual(state.settings.accordionState, { x: true });
});

test('forgetAccordion: удаляет ключ и persist', () => {
    resetState({ orphan: true, keep: false });
    forgetAccordion('orphan');
    assert.ok(!('orphan' in state.settings.accordionState));
    assert.equal(state.settings.accordionState.keep, false);
    assert.equal(saveCalls, 1);
    // no-op если ключа нет
    forgetAccordion('nonexistent');
    assert.equal(saveCalls, 1);
});

// ── bindHeaderToggle (custom .uris-acc-header + .uris-acc-body паттерн) ──

function fakeHeaderBody() {
    const body = { classList: {
        _hidden: false,
        toggle(cls, force) {
            if (cls !== 'hidden') return;
            if (force === undefined) this._hidden = !this._hidden;
            else this._hidden = Boolean(force);
        },
        contains(cls) { return cls === 'hidden' ? this._hidden : false; },
    }};
    let clickFn = null;
    const header = { addEventListener: (ev, fn) => { clickFn = fn; }, _click: (target) => clickFn({ target }) };
    return { header, body, click: (target) => clickFn({ target }) };
}

test('bindHeaderToggle: проставляет начальное .hidden из storage (false→hidden)', () => {
    resetState({ 'api:x': false });
    const { header, body } = fakeHeaderBody();
    bindHeaderToggle(header, body, 'api:x');
    assert.equal(body.classList._hidden, true, 'закрытое состояние → .hidden выставлен');
});

test('bindHeaderToggle: проставляет начальное .hidden из storage (true→not hidden)', () => {
    resetState({ 'api:x': true });
    const { header, body } = fakeHeaderBody();
    bindHeaderToggle(header, body, 'api:x');
    assert.equal(body.classList._hidden, false);
});

test('bindHeaderToggle: клик по header тогглят и persistит', () => {
    resetState({ 'api:x': true }); // открыто
    const { header, body, click } = fakeHeaderBody();
    bindHeaderToggle(header, body, 'api:x');
    assert.equal(body.classList._hidden, false);
    // Клик по свободной зоне (target = header, без интерактива).
    click({ closest: () => null });
    assert.equal(body.classList._hidden, true, 'клик должен закрыть');
    assert.equal(state.settings.accordionState['api:x'], false);
    assert.equal(saveCalls, 1);
    // Повторный клик — открывает.
    click({ closest: () => null });
    assert.equal(body.classList._hidden, false);
    assert.equal(state.settings.accordionState['api:x'], true);
    assert.equal(saveCalls, 2);
});

test('bindHeaderToggle: клик по input/button внутри header не тогглят', () => {
    resetState({ 'api:x': true });
    const { header, body, click } = fakeHeaderBody();
    bindHeaderToggle(header, body, 'api:x');
    // target.closest возвращает truthy → интерактивный элемент → игнор.
    click({ closest: () => 'input' });
    assert.equal(body.classList._hidden, false, 'осталось открыто');
    assert.equal(saveCalls, 0);
});

test('bindHeaderToggle: null-элементы — no-op', () => {
    resetState({});
    bindHeaderToggle(null, {}, 'x');
    bindHeaderToggle({}, null, 'x');
    assert.equal(saveCalls, 0);
});

// ── bindDetailsToggle (нативный <details>) ──

function fakeDetails(initialOpen = false) {
    const el = {
        open: initialOpen,
        _listeners: {},
        set open(v) { this._open = v; },
        get open() { return this._open; },
        addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
        fire(ev) { (this._listeners[ev] || []).forEach(fn => fn.call(this)); },
    };
    // корректный initial-open — реальный DOM сеттер用于 details.open
    el._open = initialOpen;
    return el;
}

test('bindDetailsToggle: выставляет начальный open из storage (true→open)', () => {
    resetState({ 'gen:adv': true });
    const el = fakeDetails(false);
    bindDetailsToggle(el, 'gen:adv');
    assert.equal(el.open, true, 'storage=true должен выставить open=true');
    // Никакого пользовательского toggle ещё не было → persist не вызывается.
    assert.equal(saveCalls, 0);
});

test('bindDetailsToggle: выставляет начальный open из storage (false→closed)', () => {
    resetState({ 'gen:adv': false });
    const el = fakeDetails(true);
    bindDetailsToggle(el, 'gen:adv');
    assert.equal(el.open, false);
    assert.equal(saveCalls, 0);
});

test('bindDetailsToggle: дефолт true при отсутствии ключа', () => {
    resetState({});
    const el = fakeDetails(false);
    bindDetailsToggle(el, 'gen:adv');
    assert.equal(el.open, true, 'дефолт отсутствующего ключа — открыто');
});

test('bindDetailsToggle: deafult false работает', () => {
    resetState({});
    const el = fakeDetails(true);
    bindDetailsToggle(el, 'gen:adv', false);
    assert.equal(el.open, false, 'defaultOpen=false для отсутствующего ключа');
});

test('bindDetailsToggle: toggle-событие persistит новое состояние', () => {
    resetState({ 'gen:adv': true });
    const el = fakeDetails(false);
    bindDetailsToggle(el, 'gen:adv');
    assert.equal(el.open, true);
    // Пользователь закрыл.
    el.open = false;
    el.fire('toggle');
    assert.equal(state.settings.accordionState['gen:adv'], false);
    assert.equal(saveCalls, 1);
    // Открыл обратно.
    el.open = true;
    el.fire('toggle');
    assert.equal(state.settings.accordionState['gen:adv'], true);
    assert.equal(saveCalls, 2);
});

test('bindDetailsToggle: null — no-op', () => {
    resetState({});
    bindDetailsToggle(null, 'x');
    assert.equal(saveCalls, 0);
});

// ── loadSettings нормализация ──

test('loadSettings: лечит не-объектный accordionState', () => {
    savedSettings = { ...defaultSettings, accordionState: 'bogus' };
    // Используем реальный loadSettings, чтобы проверить normalisation.
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings: { ur_image_studio: savedSettings },
        saveSettingsDebounced: () => {},
    });
    loadSettings();
    assert.deepEqual(state.settings.accordionState, {});
});

test('loadSettings: сохраняет корректный accordionState', () => {
    savedSettings = { ...defaultSettings, accordionState: { 'api:x': false } };
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings: { ur_image_studio: savedSettings },
        saveSettingsDebounced: () => {},
    });
    loadSettings();
    assert.deepEqual(state.settings.accordionState, { 'api:x': false });
});