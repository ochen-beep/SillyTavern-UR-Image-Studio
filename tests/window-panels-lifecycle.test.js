// @ts-check
// Жизненный цикл бейдж-панелей окна (src/ui/window.js):
//   - слушатели QUEUE-бейджа (uris:queue + document click + keydown) обязаны
//     сниматься в removePanel() — раньше анонимные версии переживали цикл
//     disable→enable и держали слушатели на отсоединённом окне;
//   - Esc с открытой бейдж-панелью закрывает только панель: capture-фаза окна
//     и bubble-фаза панели больше не срабатывают оба раза (регресс 2026-10-03:
//     одно нажатие закрывало панель И сворачивало окно; QUEUE-панель Esc не
//     закрывала вовсе, оставляя висеть над свёрнутым окном).
// Тесты идут через _testWindowLifecycle + fake-dom: полный mountPanel тянет
// getComputedStyle/matchMedia/restoreGeometry, которых в стабе нет.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

const ctxSettings = {};
globalThis.SillyTavern = {
    getContext: () => ({
        extensionSettings: { ur_image_studio: ctxSettings },
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
    }),
    libs: { localforage: { async getItem() { return null; }, async setItem() {}, async removeItem() {} } },
};
globalThis.toastr = undefined;

// Стаб window с подсчётом слушателей: bindQueueBadge вешает 'uris:queue' на window.
const winListeners = [];
globalThis.window = {
    addEventListener(type, fn) { winListeners.push({ type, fn }); },
    removeEventListener(type, fn) {
        const i = winListeners.findIndex(l => l.type === type && l.fn === fn);
        if (i >= 0) winListeners.splice(i, 1);
    },
    innerWidth: 1920,
    innerHeight: 1080,
    dispatchEvent: () => {},
};

const { _testWindowMarkup, _testWindowLifecycle } = await import('../src/ui/window.js');
const core = await import('../src/core.js');

let documentRef = null;

function mount() {
    const { document, root } = makeFakeDocument();
    documentRef = document;
    globalThis.document = document;
    globalThis.document.body = root;
    const el = document.createElement('div');
    el.id = 'urisWindow';
    el.innerHTML = _testWindowMarkup.WINDOW_TEMPLATE;
    root.appendChild(el);
    return el;
}

beforeEach(() => {
    core.loadSettings();
    core.state.settings.collapsed = false;
});

test('QUEUE-бейдж: слушатели uris:queue и document снимаются в removePanel', () => {
    const el = mount();
    const before = { win: winListeners.length, doc: documentRef._docListeners.length };
    _testWindowLifecycle.bindQueueBadge(el);
    const bound = { win: winListeners.length, doc: documentRef._docListeners.length };
    assert.ok(bound.win > before.win, 'uris:queue-слушатель навешан на window');
    assert.ok(bound.doc > before.doc, 'click/keydown-слушатели навешаны на document');

    _testWindowLifecycle.removePanel();
    const after = { win: winListeners.length, doc: documentRef._docListeners.length };
    assert.deepEqual(after, before, 'removePanel снимает ВСЕ слушатели бейджа (раньше текали)');
});

test('Esc с открытой QUEUE-панелью закрывает панель, окно не сворачивает', () => {
    const el = mount();
    _testWindowLifecycle.bindQueueBadge(el);
    _testWindowLifecycle.bindWindowEscape(el);
    const panel = el.querySelector('#urisQueuePanel');
    const badge = el.querySelector('#urisQueueBadge');
    panel.hidden = false;

    const keydownHandlers = documentRef._docListeners.filter(l => l.type === 'keydown');
    assert.ok(keydownHandlers.length >= 2, 'слушатели keydown панели и окна навешаны');
    // Порядок фаз как в браузере: capture (окно) раньше bubble (панель).
    const inPhaseOrder = [...keydownHandlers.filter(h => h.capture), ...keydownHandlers.filter(h => !h.capture)];

    const ev = { key: 'Escape', target: badge, preventDefault() {} };
    for (const h of inPhaseOrder) h.fn(ev);
    assert.equal(panel.hidden, true, 'панель закрыта одним Esc');
    assert.equal(core.state.settings.collapsed, false, 'окно НЕ сворачивается, пока панель открыта');

    // Повторный Esc при закрытых панелях — прежнее поведение: свернуть окно.
    const ev2 = { key: 'Escape', target: badge, preventDefault() {} };
    for (const h of inPhaseOrder) h.fn(ev2);
    assert.equal(core.state.settings.collapsed, true, 'без открытых панелей Esc сворачивает окно');

    _testWindowLifecycle.removePanel();
});

test('Esc с открытой INFO-панелью: окно уступает, панель закрывается своей bubble-фазой', () => {
    const el = mount();
    _testWindowLifecycle.bindErrorPool(el);
    _testWindowLifecycle.bindWindowEscape(el);
    const panel = el.querySelector('#urisErrorPanel');
    const badge = el.querySelector('#urisErrorBadge');
    panel.hidden = false;

    const keydownHandlers = documentRef._docListeners.filter(l => l.type === 'keydown');
    const ev = { key: 'Escape', target: badge, preventDefault() {} };
    // Порядок фаз: capture (окно) раньше bubble (панель) — оба получают событие.
    for (const h of [...keydownHandlers.filter(x => x.capture), ...keydownHandlers.filter(x => !x.capture)]) h.fn(ev);
    assert.equal(panel.hidden, true, 'панель INFO закрыта');
    assert.equal(core.state.settings.collapsed, false, 'окно НЕ сворачивается одновременно с панелью');

    _testWindowLifecycle.removePanel();
});

test('Esc при открытом карточном меню закрывает только меню — окно не сворачивается', async () => {
    // Регресс 2026-10-04: capture-обработчик Esc окна зарегистрирован раньше
    // менюшного и не знал об оверлеях в body — одно нажатие закрывало меню И
    // прятало всё окно (uris-hidden). Оверлей диалога теперь сам заставляет
    // окно уступить, как QUEUE/INFO-панели.
    const el = mount();
    _testWindowLifecycle.bindWindowEscape(el);
    const { openCardActionMenu } = await import('../src/ui/card-action-menu.js');
    const menu = openCardActionMenu({ title: 'T', items: [] });
    const target = el.querySelector('#urisTabs') || el;   // фокус внутри окна

    const keydownHandlers = documentRef._docListeners.filter(l => l.type === 'keydown');
    // Порядок фаз как в браузере: capture в порядке регистрации — окно первым.
    const inPhaseOrder = [...keydownHandlers.filter(h => h.capture), ...keydownHandlers.filter(h => !h.capture)];
    const ev = { key: 'Escape', target, preventDefault() {}, stopPropagation() {} };
    for (const h of inPhaseOrder) h.fn(ev);
    assert.equal(core.state.settings.collapsed, false, 'окно НЕ сворачивается при открытом меню');
    assert.equal(menu.overlay.parentNode, null, 'меню закрыто своим capture-обработчиком');
});
