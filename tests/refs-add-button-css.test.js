// @ts-check
// Статический контракт поверхностей и редактора папок в refs-UI:
// непрозрачные тематические поверхности (читаемость на тёмных темах
// SillyTavern) и позиции действий поверх превью.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readAllStyles } from './_helpers.js';

const here = dirname(fileURLToPath(import.meta.url));

/** @returns {string} CSS без /* … *​/ комментариев (как в tab-interactive-css.test.js) */
function readCss() { return readAllStyles().replace(/\/\*[\s\S]*?\*\//g, ''); }

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
