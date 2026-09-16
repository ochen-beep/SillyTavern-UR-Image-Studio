// @ts-check
// Регрессионный статический тест: горизонтальный скролл tab-бара (#urisTabs)
// на ДЕСКТОПНОМ плавающем окне (вне мобильного media query).
//
// Контекст бага: базовое правило .uris-tabs не объявляло overflow-x — вкладки
// (flex:1) не сжимаются ниже min-content, при узком ресайзнутом окне бар
// переполнялся, а .uris-window { overflow: hidden } обрезал хвостовые вкладки
// («Мост», «Медиа», «Настройки»). Скроллбара не было, колесо мыши и drag бар
// не двигали — вкладки были недостижимы. Мобильный режим имел overflow-x: auto
// только внутри @media (max-width: 768px), которая на десктопном вьюпорте не
// срабатывает, даже если само окно сужено до 320px.
//
// Решение: базовый .uris-tabs — скролл-контейнер (overflow-x: auto) со скрытым
// скроллбаром; колесо/drag добавляет src/ui/tab-bar-scroll.js. Тест страхует
// регресс: «упрощение» базового правила обратно до overflow: visible соберётся
// красным.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, '..', 'style.css');

/** @returns {string} CSS без /* … *​/ комментариев, чтобы пояснения не матчились. */
function readCss() {
    return readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

test('десктопный tab-бар: базовое правило объявляет overflow-x auto со скрытым скроллбаром', () => {
    const css = readCss();
    // Первое вхождение `.uris-tabs {` в файле — базовое правило; мобильный блок
    // с тем же селектором идёт позже внутри @media.
    const m = css.match(/\.uris-tabs\s*\{([^}]*)\}/);
    assert.ok(m, 'базовое правило .uris-tabs не найдено');
    assert.match(m[1], /overflow-x:\s*auto/, 'бар должен скроллиться и вне мобильного media query');
    assert.match(m[1], /overflow-y:\s*hidden/, 'вертикального скролла у бара быть не должно');
    assert.match(m[1], /scrollbar-width:\s*none/, 'скроллбар скрыт, как на мобильном');
});

test('десктопный tab-бар: webkit-скроллбар скрыт на базовом уровне', () => {
    const css = readCss();
    const m = css.match(/\.uris-tabs::-webkit-scrollbar\s*\{([^}]*)\}/);
    assert.ok(m, 'правило .uris-tabs::-webkit-scrollbar не найдено');
    assert.match(m[1], /display:\s*none/, 'webkit-скроллбар должен быть скрыт');
});

test('десктопная .uris-tab: white-space nowrap (подпись не переносится, излишек уходит в скролл)', () => {
    const css = readCss();
    // `.uris-tab {` (без «s» перед скобкой) — базовое правило кнопки вкладки.
    const m = css.match(/\.uris-tab\s*\{([^}]*)\}/);
    assert.ok(m, 'базовое правило .uris-tab не найдено');
    assert.match(m[1], /white-space:\s*nowrap/,
        'без nowrap min-content вкладки — самое длинное слово, подпись переносится в две строки');
});
