// @ts-check
// Тесты вкладки «Медиа» (src/ui/tab-media.js): мастер-тумблер инлайна,
// слова-триггеры юзера, реестр триггер-профилей, плюс общий рантайм-хелпер
// applyInlineRuntime (сканер/рендер). Паттерн: tests/settings-tab.test.js
// (fake-dom + SillyTavern mock). Лента чата и тестовый стенд удалены как
// дубли функционала галереи/чата — вкладка не должна их рендерить.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

let fakeDoc = makeFakeDocument();
globalThis.document = fakeDoc.document;
globalThis.window = makeWindowMock();
globalThis.toastr = { success: () => {}, error: () => {}, info: () => {}, warning: () => {} };

let extensionSettings = {};
let saveCalls = 0;
let chatMetadata = {};

globalThis.SillyTavern = makeStMock();

const { state, loadSettings, MODULE_NAME } = await import('../src/core.js');
const { render, applyInlineRuntime } = await import('../src/ui/tab-media.js');
const { getConfig } = await import('../src/inline/store.js');
const { scannerActive } = await import('../src/inline/scanner.js');

function makeWindowMock() {
    return {
        location: { origin: 'http://localhost:8000' },
        dispatchEvent: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
    };
}

function makeStMock({ events = false } = {}) {
    const ctx = {
        extensionSettings,
        saveSettingsDebounced: () => { saveCalls++; },
        chatMetadata,
        saveMetadataDebounced: () => {},
        getRequestHeaders: () => ({}),
    };
    if (events) {
        ctx.event_types = {
            GENERATION_ENDED: 'GENERATION_ENDED',
            MESSAGE_SWIPED: 'MESSAGE_SWIPED',
            MESSAGE_EDITED: 'MESSAGE_EDITED',
            MESSAGE_SENT: 'MESSAGE_SENT',
            MESSAGE_DELETED: 'MESSAGE_DELETED',
            CHAT_CHANGED: 'CHAT_CHANGED',
        };
        ctx.eventSource = {
            makeLast: () => {},
            on: () => {},
            removeListener: () => {},
        };
    }
    return { getContext: () => ctx };
}

beforeEach(() => {
    fakeDoc = makeFakeDocument();
    globalThis.document = fakeDoc.document;
    extensionSettings = {};
    saveCalls = 0;
    chatMetadata = {};
    globalThis.SillyTavern = makeStMock();
    state.settings = { inlineEnabled: false, inlineListenUser: false, inlineTriggers: null };
});

function makeRoot() {
    const root = globalThis.document.createElement('div');
    root.id = 'root';
    return root;
}

// ── core.js дефолты и нормализация ──

test('loadSettings: inlineEnabled/inlineListenUser строгие booleans, inlineTriggers:null → DEFAULT_TRIGGERS', () => {
    extensionSettings[MODULE_NAME] = { inlineEnabled: 'yes', inlineListenUser: true, inlineTriggers: null };
    loadSettings();
    assert.equal(state.settings.inlineEnabled, false, 'строка не считается включённой');
    assert.equal(state.settings.inlineListenUser, true);
    assert.deepEqual(
        state.settings.inlineTriggers.map(t => t.id),
        ['img', 'selfie', 'scene'],
        'null-профили разворачиваются в полный дефолт, а не только img',
    );

    // Мусор фильтруется, img гарантирован, порядок пользовательских сохранён.
    extensionSettings[MODULE_NAME] = {
        inlineTriggers: [{ id: 'scene', aliases: ['scene'], aspect: '16:9' }, { aliases: [] }, 'junk'],
    };
    loadSettings();
    assert.deepEqual(state.settings.inlineTriggers.map(t => t.id), ['img', 'scene']);
});

// ── Рендер вкладки ──

test('render создаёт тумблеры и карточки триггеров; enabled отражает настройки', () => {
    state.settings.inlineEnabled = true;
    state.settings.inlineTriggers = null; // → DEFAULT_TRIGGERS
    const root = makeRoot();
    render(root);
    assert.equal(root.querySelector('#urisMediaEnabled').checked, true);
    assert.equal(root.querySelector('#urisMediaListen').checked, false, 'chat-cfg listenUser по умолчанию выключен');
    const box = root.querySelector('#urisMediaTriggers');
    assert.ok(box, 'блок триггеров');
    assert.equal(box.querySelectorAll('details').length, 3, 'три дефолтных профиля карточками');
});

test('лента чата и тестовый стенд удалены — секций нет, unstable-бейджи есть', () => {
    state.settings.inlineEnabled = true;
    const root = makeRoot();
    render(root);
    assert.equal(root.querySelector('#urisMediaFeed'), null, 'лента чата удалена (дубль галереи)');
    assert.equal(root.querySelector('#urisMediaBenchRun'), null, 'тестовый стенд удалён');
    assert.equal(root.querySelector('#urisMediaBenchType'), null);
    assert.ok(root.querySelector('.uris-badge-unstable'), 'пометка unstable на вкладке');
    assert.match(root.textContent, /unstable/);
});

test('render без загруженных настроек показывает подсказку', () => {
    state.settings = null;
    const root = makeRoot();
    render(root);
    assert.match(root.textContent, /не загружены/);
});

// ── Мастер-тумблер и listenUser ──

test('тумблер enabled сохраняет inlineEnabled (и не роняет рантайм в тестовом окружении)', async () => {
    const root = makeRoot();
    render(root);
    const toggle = root.querySelector('#urisMediaEnabled');
    toggle.checked = true;
    await toggle.change();
    assert.equal(state.settings.inlineEnabled, true);
    assert.ok(saveCalls > 0, 'переключение сохраняется');

    toggle.checked = false;
    await toggle.change();
    assert.equal(state.settings.inlineEnabled, false);
});

test('тумблер listenUser пишет chat-cfg через setConfig', async () => {
    const root = makeRoot();
    render(root);
    const listen = root.querySelector('#urisMediaListen');
    listen.checked = true;
    await listen.change();
    assert.equal(getConfig().listenUser, true);
    listen.checked = false;
    await listen.change();
    assert.equal(getConfig().listenUser, false);
});

// ── Триггер-профили ──

test('правка карточки триггера пересобирает список через sanitize и сохраняет', async () => {
    state.settings.inlineTriggers = [{ id: 'img', name: 'Картинка', aliases: ['img'], aspect: '1:1', prefix: '', suffix: '', refsPolicy: 'auto' }];
    const root = makeRoot();
    render(root);
    const card = root.querySelector('#urisMediaTriggers').querySelector('details');
    assert.equal(card.getAttribute('data-trigger-id'), 'img');
    const nameInput = card.querySelector('[data-field="name"]');
    nameInput.value = 'Фото';
    await nameInput.change();
    assert.equal(state.settings.inlineTriggers.length, 1);
    assert.equal(state.settings.inlineTriggers[0].id, 'img');
    assert.equal(state.settings.inlineTriggers[0].name, 'Фото');
    assert.ok(saveCalls > 0, 'правка профиля сохраняется');
});

test('«Свой тип» добавляет карточку custom-<N> с копией профиля img', async () => {
    state.settings.inlineTriggers = null; // дефолт: img, selfie, scene
    const root = makeRoot();
    render(root);
    const box = root.querySelector('#urisMediaTriggers');
    assert.equal(box.querySelectorAll('details').length, 3);
    await root.querySelector('#urisMediaTriggerAdd').click();
    assert.equal(box.querySelectorAll('details').length, 4, 'карточка добавлена на вкладку');
    const custom = state.settings.inlineTriggers.find(t => t.id.startsWith('custom-'));
    assert.ok(custom, 'профиль custom-<N> сохранён в настройках');
    assert.ok(custom.aliases.length > 0, 'копия img: алиасы не пустые (иначе sanitize выбросил бы)');

    // Повторный клик — ещё один уникальный id (иначе sanitize по «первый wins» выбросил копию).
    await root.querySelector('#urisMediaTriggerAdd').click();
    const ids = state.settings.inlineTriggers.filter(t => t.id.startsWith('custom-')).map(t => t.id);
    assert.equal(new Set(ids).size, 2, 'id повторных профилей уникальны');
});

// ── Общий рантайм-хелпер (tab-media + tab-settings + index.init) ──

test('applyInlineRuntime подключает и отключает сканер по inlineEnabled', () => {
    globalThis.SillyTavern = makeStMock({ events: true });
    state.settings.inlineEnabled = true;
    applyInlineRuntime();
    assert.equal(scannerActive(), true, 'включено: сканер подписан');

    state.settings.inlineEnabled = false;
    applyInlineRuntime();
    assert.equal(scannerActive(), false, 'выключено: сканер отписан');
});
