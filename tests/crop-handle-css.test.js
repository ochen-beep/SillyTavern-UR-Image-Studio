// @ts-check
// Ручки кропа: тач-таргеты. У вендорного Croppr ручка 10×10 px — палец
// промахивается, тап рядом с углом стартует новый кроп и уничтожает рамку.
// Регресс-тест держит расширенные хит-зоны (элемент) с визуальным ::after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rawCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'), 'utf8');
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBodyFor(selector) {
    const idx = css.indexOf(selector);
    assert.notEqual(idx, -1, `селектор ${selector} не найден в style.css`);
    const open = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
}

test('ручки кропа: расширенный элемент-таргет и touch-action none', () => {
    const handle = ruleBodyFor('.uris-crop-stage .croppr-handle');
    assert.match(handle, /width\s*:\s*30px/, 'хит-зона ручки минимум 30px (вендор 10px)');
    assert.match(handle, /height\s*:\s*30px/);
    assert.match(handle, /touch-action\s*:\s*none/, 'жест на ручке не должен отдаваться скроллу');
    assert.match(handle, /background\s*:\s*transparent/, 'визуальный квадрат рисует ::after, не фон элемента');
});

test('ручки кропа: визуальный квадрат через ::after по центру', () => {
    const after = ruleBodyFor('.uris-crop-stage .croppr-handle::after');
    assert.match(after, /content\s*:\s*''/, 'пустой content не рисует квадрат');
    assert.match(after, /translate\(-50%,\s*-50%\)/, 'квадрат отцентрован — redraw центрирует ручку по offsetWidth');
});

test('на тач-устройствах хит-зона 44px (pointer: coarse)', () => {
    assert.match(css, /@media \(pointer: coarse\)[\s\S]*?\.uris-crop-stage \.croppr-handle \{[^}]*width:\s*44px/,
        'правило 44px для coarse-указателя не найдено');
});

test('stage не срезает хит-зоны ручек у краёв картинки', () => {
    const stage = ruleBodyFor('.uris-crop-stage');
    assert.doesNotMatch(stage, /overflow\s*:\s*hidden/, 'overflow: hidden обрезает половину ручки у края картинки');
    assert.match(stage, /overflow\s*:\s*visible/);
});
