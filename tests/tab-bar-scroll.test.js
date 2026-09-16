// @ts-check
// Регрессионный тест поведения: колесо мыши и drag-to-scroll на таб-баре
// #urisTabs (src/ui/tab-bar-scroll.js).
//
// Контекст бага: на десктопе при узком плавающем окне вкладки переполняли бар
// (overflow был visible, скроллбара нет) — колесо уходило в body, drag по
// кнопкам ничего не делал, хвостовые вкладки были недостижимы.
//
// Тест гоняет binder на fake-dom: scrollWidth/clientWidth/scrollLeft задаются
// как plain-свойства, doc-уровневые mousemove/mouseup диспатчатся вручную
// через _docListeners (fake-dom их только хранит).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';
import { bindTabBarScroll } from '../src/ui/tab-bar-scroll.js';

function makeBar(doc) {
    const bar = doc.document.createElement('div');
    bar.id = 'urisTabs';
    // Скроллимое состояние по умолчанию: контент шире видимой области.
    bar.scrollWidth = 800;
    bar.clientWidth = 400;
    bar.scrollLeft = 0;
    return bar;
}

/** @param {Record<string, unknown>} extra */
function wheelEv(extra) {
    const ev = { type: 'wheel', deltaY: 0, deltaX: 0, deltaMode: 0, defaultPrevented: false, ...extra };
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    return ev;
}

/** @param {Record<string, unknown>} extra */
function mouseEv(type, extra) {
    const ev = { type, button: 0, clientX: 0, defaultPrevented: false, propagationStopped: false, ...extra };
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    ev.stopPropagation = () => { ev.propagationStopped = true; };
    ev.stopImmediatePropagation = () => { ev.propagationStopped = true; };
    return ev;
}

function fireDoc(doc, ev) {
    for (const l of [...doc._docListeners]) if (l.type === ev.type) l.fn(ev);
}

test('колесо: вертикальный deltaY скроллит бар горизонтально и глотает событие', () => {
    const fake = makeFakeDocument();
    const bar = makeBar(fake);
    bindTabBarScroll(bar, fake.document);
    const ev = wheelEv({ deltaY: 240 });
    bar.dispatchEvent(ev);
    assert.equal(bar.scrollLeft, 240);
    assert.equal(ev.defaultPrevented, true);
});

test('колесо: deltaX тачпада тоже работает, берётся доминирующая ось', () => {
    const fake = makeFakeDocument();
    const bar = makeBar(fake);
    bindTabBarScroll(bar, fake.document);
    bar.dispatchEvent(wheelEv({ deltaX: -120, deltaY: 10 }));
    assert.equal(bar.scrollLeft, 0, 'от левого края назад — кламп в 0');
    bar.scrollLeft = 200;
    bar.dispatchEvent(wheelEv({ deltaX: -120, deltaY: 10 }));
    assert.equal(bar.scrollLeft, 80);
});

test('колесо: в крайнем положении событие не глотается — его получает скролл выше', () => {
    const fake = makeFakeDocument();
    const bar = makeBar(fake);
    bindTabBarScroll(bar, fake.document);
    // scrollLeft=0, крутим назад — бар не может, событие должно уйти наверх.
    const ev = wheelEv({ deltaY: -100 });
    bar.dispatchEvent(ev);
    assert.equal(bar.scrollLeft, 0);
    assert.equal(ev.defaultPrevented, false);
    // scrollLeft=max, крутим вперёд — то же самое.
    bar.scrollLeft = 400; // scrollWidth - clientWidth
    const ev2 = wheelEv({ deltaY: 100 });
    bar.dispatchEvent(ev2);
    assert.equal(bar.scrollLeft, 400);
    assert.equal(ev2.defaultPrevented, false);
});

test('колесо: когда бар не переполнен, событие вообще не трогаем', () => {
    const fake = makeFakeDocument();
    const bar = makeBar(fake);
    bar.scrollWidth = 400; // == clientWidth: скроллить нечего
    bindTabBarScroll(bar, fake.document);
    const ev = wheelEv({ deltaY: 240 });
    bar.dispatchEvent(ev);
    assert.equal(bar.scrollLeft, 0);
    assert.equal(ev.defaultPrevented, false);
});

test('drag: перетаскивание за порогом скроллит бар и подавляет следующий click', () => {
    const fake = makeFakeDocument();
    const bar = makeBar(fake);
    bindTabBarScroll(bar, fake.document);
    bar.dispatchEvent(mouseEv('mousedown', { clientX: 300 }));
    fireDoc(fake.document, mouseEv('mousemove', { clientX: 300 })); // без движения
    assert.equal(bar.scrollLeft, 0);
    fireDoc(fake.document, mouseEv('mousemove', { clientX: 180 })); // -120px
    assert.equal(bar.scrollLeft, 120);
    fireDoc(fake.document, mouseEv('mousemove', { clientX: 100 })); // -200px
    assert.equal(bar.scrollLeft, 200);
    fireDoc(fake.document, mouseEv('mouseup', { clientX: 100 }));
    // Click после реального драга должен быть подавлен (capture-обработчик).
    const click = mouseEv('click');
    bar.dispatchEvent(click);
    assert.equal(click.propagationStopped, true, 'click после drag не должен доходить до кнопок вкладок');
});

test('click без движения (обычное переключение вкладки) не подавляется', () => {
    const fake = makeFakeDocument();
    const bar = makeBar(fake);
    bindTabBarScroll(bar, fake.document);
    bar.dispatchEvent(mouseEv('mousedown', { clientX: 300 }));
    fireDoc(fake.document, mouseEv('mousemove', { clientX: 302 })); // 2px < порога 5px
    fireDoc(fake.document, mouseEv('mouseup', { clientX: 302 }));
    const click = mouseEv('click');
    bar.dispatchEvent(click);
    assert.equal(click.propagationStopped, false);
    assert.equal(bar.scrollLeft, 0);
});

test('подавление одноразовое: следующий честный click после съеденного работает', () => {
    const fake = makeFakeDocument();
    const bar = makeBar(fake);
    bindTabBarScroll(bar, fake.document);
    bar.dispatchEvent(mouseEv('mousedown', { clientX: 300 }));
    fireDoc(fake.document, mouseEv('mousemove', { clientX: 150 }));
    fireDoc(fake.document, mouseEv('mouseup', { clientX: 150 }));
    bar.dispatchEvent(mouseEv('click')); // съеден
    // Новый цикл: mousedown сбрасывает флаг, чистый click проходит.
    bar.dispatchEvent(mouseEv('mousedown', { clientX: 300 }));
    fireDoc(fake.document, mouseEv('mouseup', { clientX: 300 }));
    const click2 = mouseEv('click');
    bar.dispatchEvent(click2);
    assert.equal(click2.propagationStopped, false);
});

test('mousedown не трогает бар без переполнения и игнорирует не-левую кнопку', () => {
    const fake = makeFakeDocument();
    const bar = makeBar(fake);
    bindTabBarScroll(bar, fake.document);
    // Правая кнопка — не начинаем драг.
    bar.dispatchEvent(mouseEv('mousedown', { button: 2, clientX: 300 }));
    fireDoc(fake.document, mouseEv('mousemove', { clientX: 100 }));
    assert.equal(bar.scrollLeft, 0);
    // Без переполнения mousedown прозрачен (preventDefault не вызываем).
    bar.scrollWidth = 400;
    const down = mouseEv('mousedown', { clientX: 300 });
    bar.dispatchEvent(down);
    assert.equal(down.defaultPrevented, false);
});

test('cleanup снимает все обработчики', () => {
    const fake = makeFakeDocument();
    const bar = makeBar(fake);
    const unbind = bindTabBarScroll(bar, fake.document);
    unbind();
    const ev = wheelEv({ deltaY: 240 });
    bar.dispatchEvent(ev);
    assert.equal(bar.scrollLeft, 0);
    assert.equal(ev.defaultPrevented, false);
});
