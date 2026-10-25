// @ts-check
// card-drag.js: drag-to-reorder карточек на Pointer Events (мышь + тач
// long-press). fake-dom не диспетчеризирует document-события — указатель
// эмулируем вызовом сохранённых document-слушателей вручную.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

let fakeDoc;
let docListeners; // [{type, fn, capture}] — перехват document-уровня

beforeEach(() => {
    fakeDoc = makeFakeDocument();
    globalThis.document = fakeDoc.document;
    fakeDoc.document.body = fakeDoc.root;
    docListeners = [];
    globalThis.window = {
        location: { origin: 'http://localhost' },
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => {},
        scrollBy: () => {},
    };
    globalThis.requestAnimationFrame = undefined;
    globalThis.cancelAnimationFrame = undefined;
});

function makeCard(id, top, height = 60) {
    const card = document.createElement('div');
    card.className = 'uris-preset-card';
    card.dataset.id = id;
    card.innerHTML = `<div class="uris-preset-card-header"><span class="uris-name">${id}</span><button>btn</button></div><div class="uris-preset-card-body">body</div>`;
    card.getBoundingClientRect = () => ({ top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top });
    return card;
}

function mount(cards) {
    const container = document.createElement('div');
    container.id = 'list';
    for (const c of cards) container.appendChild(c);
    document.body.appendChild(container);
    return container;
}

/** Вызвать document-слушатели (pointermove/pointerup), как это сделал бы браузер. */
function fireDoc(type, ev) {
    for (const l of docListeners) if (l.type === type) l.fn(ev);
}

async function setup() {
    // Подменяем document.addEventListener ДО импорта модуля: card-drag вешает
    // слушатели на document при pointerdown.
    const origAdd = fakeDoc.document.addEventListener.bind(fakeDoc.document);
    const origRemove = fakeDoc.document.removeEventListener.bind(fakeDoc.document);
    fakeDoc.document.addEventListener = (type, fn, opts) => { origAdd(type, fn, opts); docListeners.push({ type, fn, capture: opts?.capture === true }); };
    fakeDoc.document.removeEventListener = (type, fn, opts) => { origRemove(type, fn, opts); docListeners = docListeners.filter(l => !(l.type === type && l.fn === fn && !!opts?.capture === l.capture)); };
    return await import('../src/ui/card-drag.js');
}

test('мышь: drag карточки вниз через середину соседа → onReorder(0,1)', async () => {
    const { makeCardReorderable } = await setup();
    const container = mount([makeCard('a', 0), makeCard('b', 100), makeCard('c', 200)]);
    const calls = [];
    makeCardReorderable(container, { selector: '.uris-preset-card', onReorder: (from, to) => calls.push([from, to]) });

    const cardA = container.children[0];
    // pointerdown по header карточки a (не по кнопке)
    cardA.dispatchEvent({ type: 'pointerdown', button: 0, pointerType: 'mouse', clientX: 10, clientY: 10, target: cardA.querySelector('.uris-name') });
    // сдвиг за порог → drag стартует; курсор ниже центра карточки b (центр 130)
    fireDoc('pointermove', { clientX: 10, clientY: 160, preventDefault: () => {} });
    fireDoc('pointerup', { clientX: 10, clientY: 160, preventDefault: () => {} });

    assert.deepEqual(calls, [[0, 1]], 'a переставлена после b');
});

test('pointerdown отменяется для мыши (запрет нативного выделения), но не для тача', async () => {
    const { makeCardReorderable } = await setup();
    const container = mount([makeCard('a', 0), makeCard('b', 100)]);
    makeCardReorderable(container, { selector: '.uris-preset-card', onReorder: () => {} });

    const cardA = container.children[0];
    let mousePrevented = false;
    cardA.dispatchEvent({
        type: 'pointerdown', button: 0, pointerType: 'mouse', clientX: 10, clientY: 10,
        target: cardA.querySelector('.uris-name'), preventDefault: () => { mousePrevented = true; },
    });
    assert.equal(mousePrevented, true, 'у мыши default гасится — выделение не начнётся');

    let touchPrevented = false;
    cardA.dispatchEvent({
        type: 'pointerdown', button: 0, pointerType: 'touch', clientX: 10, clientY: 10,
        target: cardA.querySelector('.uris-name'), preventDefault: () => { touchPrevented = true; },
    });
    assert.equal(touchPrevented, false, 'тач сохраняет default — жест может стать скроллом');
});

test('клик без сдвига не reorder\'ит (порог 6px)', async () => {
    const { makeCardReorderable } = await setup();
    const container = mount([makeCard('a', 0), makeCard('b', 100)]);
    const calls = [];
    makeCardReorderable(container, { selector: '.uris-preset-card', onReorder: (f, t) => calls.push([f, t]) });

    const cardA = container.children[0];
    cardA.dispatchEvent({ type: 'pointerdown', button: 0, pointerType: 'mouse', clientX: 10, clientY: 10, target: cardA.querySelector('.uris-name') });
    fireDoc('pointermove', { clientX: 11, clientY: 12, preventDefault: () => {} });
    fireDoc('pointerup', { clientX: 11, clientY: 12, preventDefault: () => {} });
    assert.deepEqual(calls, [], 'порог не пройден — это клик');
});

test('тач: drag стартует только после long-press, раннее движение остаётся скроллом', async () => {
    const { makeCardReorderable } = await setup();
    const container = mount([makeCard('a', 0), makeCard('b', 100)]);
    const calls = [];
    makeCardReorderable(container, { selector: '.uris-preset-card', onReorder: (f, t) => calls.push([f, t]) });

    const cardA = container.children[0];
    cardA.dispatchEvent({ type: 'pointerdown', button: 0, pointerType: 'touch', clientX: 10, clientY: 10, target: cardA.querySelector('.uris-name') });
    // движение до long-press: drag не начался
    fireDoc('pointermove', { clientX: 10, clientY: 160, preventDefault: () => {} });
    fireDoc('pointerup', { clientX: 10, clientY: 160, preventDefault: () => {} });
    assert.deepEqual(calls, [], 'без long-press тач-жест не перетаскивает');

    // с long-press: down, ждём таймер (220мс), потом move+up
    cardA.dispatchEvent({ type: 'pointerdown', button: 0, pointerType: 'touch', clientX: 10, clientY: 10, target: cardA.querySelector('.uris-name') });
    await new Promise(r => setTimeout(r, 260));
    fireDoc('pointermove', { clientX: 10, clientY: 160, preventDefault: () => {} });
    fireDoc('pointerup', { clientX: 10, clientY: 160, preventDefault: () => {} });
    assert.deepEqual(calls, [[0, 1]], 'после long-press drag работает');
});

test('pointerdown на кнопке карточки не начинает drag', async () => {
    const { makeCardReorderable } = await setup();
    const container = mount([makeCard('a', 0), makeCard('b', 100)]);
    const calls = [];
    makeCardReorderable(container, { selector: '.uris-preset-card', onReorder: (f, t) => calls.push([f, t]) });

    const cardA = container.children[0];
    cardA.dispatchEvent({ type: 'pointerdown', button: 0, pointerType: 'mouse', clientX: 250, clientY: 10, target: cardA.querySelector('button') });
    fireDoc('pointermove', { clientX: 250, clientY: 160, preventDefault: () => {} });
    fireDoc('pointerup', { clientX: 250, clientY: 160, preventDefault: () => {} });
    assert.deepEqual(calls, [], 'drag с кнопки запрещён (excluded)');
});
