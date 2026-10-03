// @ts-check
// CSS-контракты мобильного UX-прохода (docs/2026-10-03-mobile-ux-pass-design.md):
// правила живут внутри мобильных @media и не утекают на десктоп.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rawCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'), 'utf8');
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

/** Тело правила по селектору (первое вхождение). */
function ruleBody(selector) {
    const idx = css.indexOf(`${selector} {`);
    assert.notEqual(idx, -1, `правило ${selector} не найдено`);
    const open = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
}

/** Тело ближайшего @media, в котором находится селектор. */
function mediaOf(selector) {
    const idx = css.indexOf(`${selector} {`);
    assert.notEqual(idx, -1, `правило ${selector} не найдено`);
    const mediaStart = css.lastIndexOf('@media', idx);
    assert.notEqual(mediaStart, -1, `${selector} должен жить внутри @media`);
    const brace = css.indexOf('{', mediaStart);
    return css.slice(mediaStart, brace);
}

test('галерея: кнопочные строки карточек спрятаны на мобильном', () => {
    assert.match(mediaOf('.uris-card-actions'), /max-width:\s*768px/);
    assert.match(ruleBody('.uris-card-actions'), /display:\s*none/);
});

test('галерея: тулбар липкий и компактный, подписи спрятаны', () => {
    assert.match(mediaOf('.uris-gallery-toolbar'), /max-width:\s*768px/);
    const body = ruleBody('.uris-gallery-toolbar');
    assert.match(body, /position:\s*sticky/);
    assert.match(body, /top:\s*0/);
    assert.match(ruleBody('.uris-gallery-toolbar .uris-btn-label'), /display:\s*none/);
    assert.match(ruleBody('.uris-gallery-toolbar .uris-btn'), /min-height:\s*44px/);
});

test('карточное меню: шит снизу <768px, поповер без шита ≥768px', () => {
    const idx = css.indexOf('.uris-action-menu-overlay { align-items: flex-end; }');
    assert.notEqual(idx, -1, 'правило нижнего шита не найдено');
    const mediaStart = css.lastIndexOf('@media', idx);
    const brace = css.indexOf('{', mediaStart);
    assert.match(css.slice(mediaStart, brace), /max-width:\s*767px/);
    assert.match(ruleBody('.uris-action-menu-grip'), /display:\s*none/, 'на десктопе грипа нет');
});

test('пункты меню не меньше 44px — зона пальца', () => {
    assert.match(ruleBody('.uris-action-menu-item'), /min-height:\s*44px/);
});
