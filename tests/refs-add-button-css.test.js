// @ts-check
// Регрессионный статический тест на «клеверный» стиль кнопки «+ Референс»
// (#urisRefsAddBtn, класс .uris-refs-add в src/ui/tab-references.js).
//
// Контекст: кнопка добавления референса была нейтрально-серой и визуально
// терялась рядом с поиском. По требованию она должна быть «немного
// прозрачно зеленоватой, цвета клевера» — т.е. использовать зелёную
// гамму акцента темы: полупрозрачный фон var(--uris-accent-soft)
// (rgba(90,158,58,.18), тот же приём, что у .uris-proxy-ok) и зелёный
// текст var(--uris-accent). Тест страхует регресс: если правило
// случайно вернут к серому — соберётся красным.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, '..', 'style.css');

/** @returns {string} CSS без /* … *​/ комментариев (как в tab-interactive-css.test.js) */
function readCss() { return readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''); }

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

test('.uris-refs-add has translucent clover-green background (accent-soft)', () => {
    const body = ruleBodyFor(readCss(), '.uris-refs-add');
    assert.ok(body, '.uris-refs-add rule not found in style.css');
    assert.match(body, /background\s*:\s*var\(--uris-accent-soft\)/,
        '.uris-refs-add must declare background: var(--uris-accent-soft) — translucent clover green');
});

test('.uris-refs-add uses clover-green accent for text color', () => {
    const body = ruleBodyFor(readCss(), '.uris-refs-add');
    assert.ok(body, '.uris-refs-add rule not found in style.css');
    assert.match(body, /color\s*:\s*var\(--uris-accent\)/,
        '.uris-refs-add must declare color: var(--uris-accent) — clover green text');
});

// Мобильный аналог кнопки «+ Референс» (тулбар мобильных экранов) должен
// выглядеть так же — тот же «клевер».
test('.uris-mobile-add-ref has translucent clover-green background (accent-soft)', () => {
    const body = ruleBodyFor(readCss(), '.uris-mobile-add-ref');
    assert.ok(body, '.uris-mobile-add-ref rule not found in style.css');
    assert.match(body, /background\s*:\s*var\(--uris-accent-soft\)/,
        '.uris-mobile-add-ref must declare background: var(--uris-accent-soft) — translucent clover green');
});

test('.uris-mobile-add-ref uses clover-green accent for text color', () => {
    const body = ruleBodyFor(readCss(), '.uris-mobile-add-ref');
    assert.ok(body, '.uris-mobile-add-ref rule not found in style.css');
    assert.match(body, /color\s*:\s*var\(--uris-accent\)/,
        '.uris-mobile-add-ref must declare color: var(--uris-accent) — clover green text');
});

test('.uris-folder-editor-swatch palette wraps', () => {
    const body = ruleBodyFor(readCss(), '.uris-folder-editor-palette');
    assert.ok(body, '.uris-folder-editor-palette rule not found in style.css');
    assert.match(body, /flex-wrap\s*:\s*wrap/,
        'folder editor palette must wrap swatches');
});

test('.uris-editor-preview-wrap positions preview actions at bottom-right', () => {
    const css = readCss();
    const wrap = ruleBodyFor(css, '.uris-editor-preview-wrap');
    assert.ok(wrap, '.uris-editor-preview-wrap rule not found in style.css');
    assert.match(wrap, /position\s*:\s*relative/, 'preview wrapper must establish positioning context');

    // Обрезка и замена живут в общем контейнере поверх угла превью.
    const actions = ruleBodyFor(css, '.uris-editor-preview-actions');
    assert.ok(actions, 'preview actions container rule not found in style.css');
    assert.match(actions, /position\s*:\s*absolute/, 'actions must be positioned over the preview');
    assert.match(actions, /right\s*:\s*[^;]+/, 'actions must set a right offset');
    assert.match(actions, /bottom\s*:\s*[^;]+/, 'actions must set a bottom offset');
});

test('.uris-folder-editor-swatch-on has an active state', () => {
    const body = ruleBodyFor(readCss(), '.uris-folder-editor-swatch.uris-folder-editor-swatch-on');
    assert.ok(body, 'active folder editor swatch rule not found in style.css');
    assert.match(body, /border-color\s*:\s*var\(--uris-text-strong\)/,
        'active swatch must visibly change its border');
});

test('the main content body has an opaque themed surface', () => {
    const body = ruleBodyFor(readCss(), '.uris-body');
    assert.ok(body, '.uris-body rule not found in style.css');
    assert.match(body, /background\s*:\s*var\(--uris-bg\)/,
        'main content must not let chat text show through transparent theme surfaces');
});

test('reference policy notices have an opaque themed surface', () => {
    const body = ruleBodyFor(readCss(), '.uris-refs-policy-info');
    assert.ok(body, '.uris-refs-policy-info rule not found in style.css');
    assert.match(body, /background\s*:\s*var\(--uris-surface-card\)/,
        'reference policy notices must not let chat text show through');
    assert.match(body, /border\s*:\s*1px\s+solid\s+var\(--uris-border-soft\)/,
        'reference policy notices need a visible boundary');
});

test('rejected reference dialect action is a readable themed button', () => {
    const body = ruleBodyFor(readCss(), '.uris-refs-dialect-switch');
    assert.ok(body, '.uris-refs-dialect-switch rule not found in style.css');
    assert.match(body, /background\s*:\s*var\(--uris-surface-btn\)/,
        'rejected reference action must not inherit a white/transparent theme surface');
    assert.match(body, /color\s*:\s*var\(--uris-warn\)/,
        'rejected reference action must retain warning emphasis');
    assert.match(body, /border\s*:\s*1px\s+solid\s+var\(--uris-warn-line\)/,
        'rejected reference action needs a visible boundary');
});
