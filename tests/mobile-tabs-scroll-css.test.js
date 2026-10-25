// @ts-check
// Регрессионный статический тест: горизонтальный скролл tab-бара (#urisTabs)
// на мобильном fullscreen-режиме (.uris-mobile, ≤768px).
//
// Контекст бага: в мобильном media query уже был объявлен overflow-x: auto для
// .uris-tabs, но глобальный guard
//     .uris-window button { touch-action: pan-y; }
// (защита от ST-тем с `button { touch-action: none }`) разрешает жестам
// ТОЛЬКО вертикальный пан. Пересечение touch-action вычисляется от элемента
// под пальцем, а бар почти целиком покрыт кнопками .uris-tab — горизонтальный
// свайп по вкладкам никуда не доходил, и хвостовые вкладки («Медиа»,
// «Настройки») оставались за краем экрана недостижимыми.
//
// Решение: на мобильном .uris-tab объявляет touch-action: pan-x — тапы остаются
// кликами, вертикальный свайп отдаётся скроллу .uris-body, горизонтальный
// листает сам таб-бар. Тест страхует регресс: если guard-правило опять поглотит
// tab-кнопки (например, при переезде на pan-y «для единообразия») — соберётся
// красным.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readAllStyles } from './_helpers.js';

const here = dirname(fileURLToPath(import.meta.url));

/** @returns {string} rawCSS */
function readCssRaw() { return readAllStyles(); }

/** Вырезает /* … *​/ комментарии, чтобы пояснения не матчились как декларации. */
function readCss() { return readCssRaw().replace(/\/\*[\s\S]*?\*\//g, ''); }

/**
 * Грубое извлечение rule-блока по индексу селектора (файл плоский, без nesting).
 * @param {string} css
 * @param {number} idx
 * @returns {string}
 */
function blockAt(css, idx) {
    const open = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
}

test('мобильный tab-бар: overflow-x auto со скрытым скроллбаром', () => {
    const css = readCss();
    const idx = css.indexOf('.uris-tabs { overflow-x: auto');
    assert.notEqual(idx, -1, 'мобильное правило .uris-tabs со скроллом не найдено');
    const block = blockAt(css, idx);
    assert.match(block, /-webkit-overflow-scrolling:\s*touch/, 'инерционный скролл на iOS');
    assert.match(block, /scrollbar-width:\s*none/, 'скроллбар должен быть скрыт');
});

test('мобильный .uris-tab: touch-action pan-x (горизонтальный свайп по кнопкам листает бар)', () => {
    const css = readCss();
    // Специфичность: guard `.uris-window button` = (0,1,1) ВЫШЕ, чем голый
    // `.uris-tab` (0,1,0) — каскад при равном источнике смотрит на специфичность,
    // а не на порядок в файле. Поэтому селектор обязан быть скоупнут как
    // `.uris-tabs .uris-tab` (0,2,0). Поиск точным префиксом ниже фиксирует
    // одновременно селектор И первые декларации: «упрощение» селектора до
    // `.uris-tab` даст idx === -1 и красный тест.
    const idx = css.indexOf('.uris-tabs .uris-tab { flex: 0 0 auto;');
    assert.notEqual(idx, -1,
        'мобильное правило должно быть селектором .uris-tabs .uris-tab (0,2,0) — иначе guard .uris-window button (0,1,1) выигрывает каскад');
    const block = blockAt(css, idx);
    assert.match(block, /touch-action:\s*pan-x/, 'кнопка вкладки должна разрешать горизонтальный пан');
    assert.doesNotMatch(block, /touch-action:\s*pan-y/, 'pan-y от guard-правила глушит горизонтальный свайп');
});

test('десктопный .uris-tab не задаёт touch-action (guard pan-y остаётся в силе вне мобильного блока)', () => {
    const css = readCss();
    const body = css.match(/\.uris-tab\s*\{([^}]*)\}/);
    assert.ok(body, 'базовое правило .uris-tab не найдено');
    assert.doesNotMatch(body[1], /touch-action/, 'базовая вкладка не должна переопределять guard вне мобильного режима');
});
