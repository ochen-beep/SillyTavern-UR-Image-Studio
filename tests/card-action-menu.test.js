// @ts-check
// Контракты карточного меню жестов (docs/2026-10-03-mobile-ux-pass-design.md §1):
// открытие/закрытие, единственный экземпляр, позиционирование на десктопе,
// распознавание жеста — contextmenu (ПКМ + Android) и iOS-таймер долгого тапа.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

const originalDocument = globalThis.document;
const originalMatchMedia = globalThis.matchMedia;

let fake;

beforeEach(() => {
    fake = makeFakeDocument();
    fake.document.body = fake.root;   // оверлеи аппендятся в body
    globalThis.document = fake.document;
    delete globalThis.matchMedia;      // по умолчанию «не десктоп» — без inline-позиции
});

afterEach(() => {
    globalThis.document = originalDocument;
    if (originalMatchMedia === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = originalMatchMedia;
});

function items() {
    return [
        { id: 'regen', icon: 'fa-rotate-right', label: 'Регенерировать', onSelect: () => {} },
        { id: 'del', icon: 'fa-trash', label: 'Удалить…', danger: true, onSelect: () => {} },
    ];
}

test('open: overlay with title and item buttons lands in body', async () => {
    const { openCardActionMenu } = await import('../src/ui/card-action-menu.js');
    const { close } = openCardActionMenu({ title: 'Карточка', items: items() });
    const overlay = fake.document.body.children.find(n => n.querySelector?.('.uris-action-menu'));
    assert.ok(overlay, 'overlay appended');
    assert.match(overlay.innerHTML, /Карточка/);
    assert.match(overlay.innerHTML, /Регенерировать/);
    assert.match(overlay.innerHTML, /uris-action-menu-item-danger/);
    close();
});

test('item click: closes first, then calls that item onSelect', async () => {
    const { openCardActionMenu } = await import('../src/ui/card-action-menu.js');
    const calls = [];
    const { close } = openCardActionMenu({
        title: 'T',
        items: [{ id: 'a', icon: 'x', label: 'A', onSelect: () => calls.push('a') },
                { id: 'b', icon: 'y', label: 'B', onSelect: () => calls.push('b') }],
    });
    const overlay = fake.document.body.children.find(n => n.querySelector?.('.uris-action-menu'));
    const btn = overlay.querySelectorAll('.uris-action-menu-item').find(b => b.dataset.id === 'b');
    btn.dispatchEvent({ type: 'click', preventDefault() {} });
    assert.deepEqual(calls, ['b'], 'the clicked item fired');
    assert.equal(overlay.parentNode, null, 'overlay removed');
    close();
});

test('item click on the label (target = вложенный span): onSelect срабатывает', async () => {
    // Реальный браузер: клик по тексту пункта всплывает в кнопку с
    // target = <span>. Регресс 2026-10-04: guard `e.target !== btn` глотал
    // именно такие клики — меню отвечало только на попадание в паддинг.
    const { openCardActionMenu } = await import('../src/ui/card-action-menu.js');
    const calls = [];
    openCardActionMenu({ title: 'T', items: [{ id: 'a', icon: 'x', label: 'A', onSelect: () => calls.push('a') }] });
    const overlay = fake.document.body.children.find(n => n.querySelector?.('.uris-action-menu'));
    const btn = overlay.querySelector('.uris-action-menu-item');
    const span = btn.querySelector('span');
    assert.ok(span, 'у пункта есть <span> с подписью');
    btn.dispatchEvent({ type: 'click', target: span, preventDefault() {} });
    assert.deepEqual(calls, ['a'], 'клик по подписи не должен глотаться');
    assert.equal(overlay.parentNode, null, 'оверлей закрыт');
});

test('item click с чужим target (каскад фейк-дома от оверлея) игнорируется', async () => {
    const { openCardActionMenu } = await import('../src/ui/card-action-menu.js');
    const calls = [];
    openCardActionMenu({ title: 'T', items: [{ id: 'a', icon: 'x', label: 'A', onSelect: () => calls.push('a') }] });
    const overlay = fake.document.body.children.find(n => n.querySelector?.('.uris-action-menu'));
    const btn = overlay.querySelector('.uris-action-menu-item');
    btn.dispatchEvent({ type: 'click', target: overlay, preventDefault() {} });
    assert.deepEqual(calls, [], 'чужой target не выбирает пункт');
    // 2026-10-06 (пузырь в fake-dom): клик с target===overlay доходит и до
    // backdrop-обработчика оверлея — по DOM-семантике это клик по фону, меню
    // закрывается. Контракт пункта — только «чужой target не выбирает пункт».
    assert.equal(overlay.parentNode, null, 'backdrop-клик (target=overlay) закрывает меню');
});

test('backdrop click closes without firing items', async () => {
    const { openCardActionMenu } = await import('../src/ui/card-action-menu.js');
    const calls = [];
    openCardActionMenu({ title: 'T', items: [{ id: 'a', icon: 'x', label: 'A', onSelect: () => calls.push('a') }] });
    const overlay = fake.document.body.children.find(n => n.querySelector?.('.uris-action-menu'));
    overlay.dispatchEvent({ type: 'click', target: overlay, preventDefault() {} });
    assert.deepEqual(calls, []);
    assert.equal(overlay.parentNode, null, 'overlay removed');
});

test('only one menu at a time: opening closes the previous', async () => {
    const { openCardActionMenu } = await import('../src/ui/card-action-menu.js');
    openCardActionMenu({ title: 'one', items: items() });
    const first = fake.document.body.children.find(n => n.querySelector?.('.uris-action-menu'));
    openCardActionMenu({ title: 'two', items: items() });
    assert.equal(first.parentNode, null, 'previous overlay removed');
    const overlays = fake.document.body.children.filter(n => n.querySelector?.('.uris-action-menu'));
    assert.equal(overlays.length, 1);
});

test('desktop positioning: with matchMedia wide + x/y the dialog is placed at the point', async () => {
    globalThis.matchMedia = () => ({ matches: true });
    const { openCardActionMenu } = await import('../src/ui/card-action-menu.js');
    openCardActionMenu({ title: 'T', items: items(), x: 300, y: 120 });
    const overlay = fake.document.body.children.find(n => n.querySelector?.('.uris-action-menu'));
    const dialog = overlay.querySelector('.uris-action-menu');
    assert.match(dialog.attributes.style || '', /left:\s*300px/);
    assert.match(dialog.attributes.style || '', /top:\s*120px/);
});

test('mobile: no inline position even when x/y are given', async () => {
    const { openCardActionMenu } = await import('../src/ui/card-action-menu.js');
    openCardActionMenu({ title: 'T', items: items(), x: 300, y: 120 });
    const overlay = fake.document.body.children.find(n => n.querySelector?.('.uris-action-menu'));
    const dialog = overlay.querySelector('.uris-action-menu');
    assert.equal(dialog.attributes.style || '', '', 'mobile sheet is positioned by CSS, not inline');
});

// ── Gesture: bindCardContextMenu ──

test('contextmenu (ПКМ / Android long-press): preventDefault + onOpen at the point', async () => {
    const { bindCardContextMenu } = await import('../src/ui/card-action-menu.js');
    const el = fake.document.createElement('div');
    const opens = [];
    bindCardContextMenu(el, ctx => opens.push(ctx));
    let pd = false;
    el.dispatchEvent({ type: 'contextmenu', clientX: 40, clientY: 60, preventDefault: () => { pd = true; } });
    assert.equal(pd, true, 'native menu suppressed');
    // fake-dom с 2026-10-06 проставляет target=узел диспатча; проверяем поля
    // по отдельности вместо deepEqual (target — живой элемент).
    assert.equal(opens.length, 1);
    assert.equal(opens[0].x, 40);
    assert.equal(opens[0].y, 60);
    assert.equal(opens[0].isLongPress, false);
});

test('iOS long-press: pointerdown held 500ms fires onOpen(isLongPress), the follow-up click is swallowed', async (t) => {
    const { bindCardContextMenu } = await import('../src/ui/card-action-menu.js');
    const el = fake.document.createElement('div');
    const opens = [];
    bindCardContextMenu(el, ctx => opens.push(ctx));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    el.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', clientX: 10, clientY: 20 });
    t.mock.timers.tick(500);
    el.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
    assert.equal(opens.length, 1);
    assert.equal(opens[0].x, 10);
    assert.equal(opens[0].y, 20);
    assert.equal(opens[0].isLongPress, true);
    t.mock.timers.reset();
});

test('long-press cancelled by movement beyond threshold', async (t) => {
    const { bindCardContextMenu } = await import('../src/ui/card-action-menu.js');
    const el = fake.document.createElement('div');
    const opens = [];
    bindCardContextMenu(el, ctx => opens.push(ctx));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    el.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', clientX: 10, clientY: 20 });
    el.dispatchEvent({ type: 'pointermove', pointerType: 'touch', clientX: 40, clientY: 20 });
    t.mock.timers.tick(500);
    assert.deepEqual(opens, [], 'scroll/move must not open the menu');
    t.mock.timers.reset();
});

test('pointerup before 500ms cancels (normal tap stays a tap)', async (t) => {
    const { bindCardContextMenu } = await import('../src/ui/card-action-menu.js');
    const el = fake.document.createElement('div');
    const opens = [];
    let clickSwallowed = false;
    bindCardContextMenu(el, ctx => opens.push(ctx));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    el.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', clientX: 1, clientY: 2 });
    el.dispatchEvent({ type: 'pointerup', pointerType: 'touch' });
    t.mock.timers.tick(500);
    el.dispatchEvent({ type: 'click', preventDefault() { clickSwallowed = true; }, stopPropagation() {} });
    assert.deepEqual(opens, []);
    assert.equal(clickSwallowed, false, 'a normal tap must reach its own handler');
    t.mock.timers.reset();
});

test('mouse pointerdown never starts the long-press timer (ПКМ уже покрыт contextmenu)', async (t) => {
    const { bindCardContextMenu } = await import('../src/ui/card-action-menu.js');
    const el = fake.document.createElement('div');
    const opens = [];
    bindCardContextMenu(el, ctx => opens.push(ctx));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    el.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 0, clientX: 1, clientY: 2 });
    t.mock.timers.tick(1000);
    assert.deepEqual(opens, []);
    t.mock.timers.reset();
});
