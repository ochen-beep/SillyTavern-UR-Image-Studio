// @ts-check
// Контракт масштаба интерфейса (--uris-scale) в style.css:
// зум вкладок/тела действует на ОБЕИХ платформах (включая мобильный
// fullscreen .uris-mobile), а fullscreen-геометрия окна остаётся
// zoom-нейтральной — заполнение даёт сама модель zoom (containing block
// делится на zoom), ручная компенсация ширин запрещена.
// Регресс: возврат селектора :not(.uris-mobile) или появление
// var(--uris-scale) в fullscreen-блоке собирается красным.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readAllStyles } from './_helpers.js';

const rawCss = readAllStyles();
// Комментарии вырезаем (та же причина, что в popup-viewport-css.test.js).
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

/** Первый блок правил селектора (без вложенных @media-скобок). */
function ruleBlock(selector) {
    const idx = css.indexOf(selector);
    assert.notEqual(idx, -1, `селектор ${selector} не найден в style.css`);
    const open = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    return { block: css.slice(open + 1, close), idx };
}

test('зум вкладок/тела действует и в мобильном fullscreen (без :not(.uris-mobile))', () => {
    assert.doesNotMatch(
        css,
        /:not\(\.uris-mobile\)[^{]*\.uris-(tabs|body)/,
        'зум не должен выключаться в мобильном режиме — слайдер крутится вхолостую',
    );
    // Обе части правила на месте и несут именно var(--uris-scale, 1).
    const tabsIdx = css.indexOf('.uris-window .uris-tabs,');
    assert.notEqual(tabsIdx, -1, 'нет зум-правила для .uris-tabs');
    const selectorEnd = css.indexOf('{', tabsIdx);
    const selector = css.slice(tabsIdx, selectorEnd);
    assert.match(selector, /\.uris-window \.uris-body/, 'зум должен покрывать и .uris-body');
    const open = css.indexOf('{', tabsIdx);
    const close = css.indexOf('}', open);
    assert.match(css.slice(open + 1, close), /zoom:\s*var\(--uris-scale,\s*1\)/);
});

test('зум-правило стоит ПОСЛЕ канонического .uris-body (контракт CSS-парсеров тестов)', () => {
    const canonical = css.indexOf('.uris-body {');
    assert.notEqual(canonical, -1);
    const zoomRule = css.indexOf('.uris-window .uris-tabs,');
    assert.ok(zoomRule > canonical, 'парсеры тестов берут первое вхождение `.uris-body {` — зум-правило не должно его предшествовать');
});

test('fullscreen-геометрия .uris-mobile не компенсирует зум вручную', () => {
    const { block } = ruleBlock('#urisWindow.uris-mobile {');
    assert.match(block, /width:\s*100%/, 'фуллскрин тянется на 100% ширины');
    assert.doesNotMatch(
        block,
        /--uris-scale/,
        'в fullscreen-геометрии не должно быть делений/умножений на --uris-scale: заполнение окна при любом зуме даёт сама модель zoom',
    );
});
