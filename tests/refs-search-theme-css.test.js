// @ts-check
// Регрессионный статический тест: поисковые инпуты референсов должны быть
// оформлены в тему расширения, а не браузерным дефолтом.
//
// Контекст бага: .uris-folder-search-input (сайдбар «Референсы», десктоп) и
// .uris-mobile-folder-search (мобильный экран папок) не имели ни background,
// ни color — на тёмной теме они оставались белыми браузерными полями.
// Соседние поиски (.uris-refs-search input, .uris-mobile-search) давно
// оформлены через var(--uris-surface-btn)/var(--uris-text-strong).
//
// Тест страхует регресс: «упрощение» правил обратно до box-sizing/width
// соберётся красным.
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

test('десктопный поиск папок (.uris-folder-search-input) оформлен в тему', () => {
    const css = readCss();
    const m = css.match(/\.uris-folder-search-input\s*\{([^}]*)\}/);
    assert.ok(m, 'правило .uris-folder-search-input не найдено');
    assert.match(m[1], /background:\s*var\(--uris-surface-btn\)/, 'фон — тематическая поверхность, не браузерный белый');
    assert.match(m[1], /color:\s*var\(--uris-text-strong\)/, 'цвет текста — из палитры расширения');
    assert.match(m[1], /border:\s*1px solid var\(--uris-border\)/, 'рамка — из палитры расширения');
});

test('десктопный поиск папок: focus-подсветка рамки акцентом', () => {
    const css = readCss();
    const m = css.match(/\.uris-folder-search-input:focus\s*\{([^}]*)\}/);
    assert.ok(m, 'нет :focus-правила для .uris-folder-search-input');
    assert.match(m[1], /border-color:\s*var\(--uris-accent\)/);
});

test('мобильный поиск папок (.uris-mobile-folder-search) делит тематическое правило с .uris-mobile-search', () => {
    const css = readCss();
    const m = css.match(/\.uris-mobile-search\s*,\s*\.uris-mobile-folder-search\s*\{([^}]*)\}/);
    assert.ok(m, 'общее правило .uris-mobile-search + .uris-mobile-folder-search не найдено');
    assert.match(m[1], /background:\s*var\(--uris-surface-btn\)/, 'фон — тематическая поверхность');
    assert.match(m[1], /color:\s*var\(--uris-text-strong\)/, 'цвет текста — из палитры расширения');
});
