// @ts-check
// Регрессионный статический тест на garantizar кликабельности вкладок
// `#urisTabs > button.uris-tab` поверх глобальных CSS-ресетов SillyTavern-тем.
//
// Контекст бага: некоторые кастомные ST-темы делают глобальный ресет вроде
//     button { pointer-events: none; cursor: default; }
//     button.menu_button, button.view_button { pointer-events: auto; }
// чтобы пробрасывать клики только к bekannt ST-классам. Наша кнопка вкладки
// (src/ui/tabs.js) создаётся с единственным классом `uris-tab` — без `menu_button`
// и без `pointer-events: auto`. На таких темах клик по вкладке никогда не доходит
// до addEventListener('click', …), и переключение на «Шаблоны» (а значит, и
// создание шаблона) не срабатывает. На нативной теме — срабатывает, потому что
// `button` там кликабелен по умолчанию. Отсюда «в некоторых браузерах/темах».
//
// Решение: фиксировать в style.css, что у `.uris-tab` выставлен `pointer-events:auto`
// (перебивает родительский ресет). Этот тест страхует регресс: если правило
// случайно удалят/переопределят — соберётся красным.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, '..', 'style.css');

/** @returns {string} rawCSS */
function readCssRaw() { return readFileSync(cssPath, 'utf8'); }

/**
 * Вырезает `/* … *​/` комментарии прежде, чем тесты матчят декларации.
 * Без этого поясняющие комментарии (напр., «ST-темы с ресетом
 * `pointer-events: none`») сами триггерят реге́кспы-фолс—позитив.
 * @returns {string}
 */
function readCss() { return readCssRaw().replace(/\/\*[\s\S]*?\*\//g, ''); }

/**
 * Извлечь декларации первого rule для селектора. Грубо, но для нашего файла
 * (плоский CSS, нет nesting/@layer) — работает.
 * @param {string} css
 * @param {string} selector
 * @returns {string|null}
 */
function ruleBodyFor(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm');
    const m = css.match(re);
    return m ? m[1] : null;
}

test('.uris-tab explicitly sets pointer-events:auto (ST global button reset guard)', () => {
    const css = readCss();
    const body = ruleBodyFor(css, '.uris-tab');
    assert.ok(body, '.uris-tab rule not found in style.css');
    assert.match(body, /pointer-events\s*:\s*auto(?:\s*!important)?\s*;?/i,
        '.uris-tab must declare pointer-events:auto to survive global ST-theme button resets');
});

test('.uris-tab does not disable pointer-events', () => {
    const css = readCss();
    const body = ruleBodyFor(css, '.uris-tab');
    assert.ok(body, '.uris-tab rule not found in style.css');
    assert.doesNotMatch(body, /pointer-events\s*:\s*none/i,
        '.uris-tab must not disable pointer-events');
});