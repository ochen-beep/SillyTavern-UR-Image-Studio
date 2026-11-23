// @ts-check
// Theme contract of fixed dark surfaces: the extension window, the refs-add
// tile and the mobile picker dialog all keep an opaque DARK background by
// design, so their text color must come from URIS tokens — inheriting
// --SmartThemeBodyColor pulled light-theme colors (MEMO) onto dark surfaces
// and dropped text contrast to 4.0:1, below WCAG AA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAllStyles } from './_helpers.js';

const css = readAllStyles().replace(/\/\*[\s\S]*?\*\//g, '');

/** All rule bodies for a selector. */
function ruleBlocks(selector) {
    const blocks = [];
    let idx = css.indexOf(selector);
    while (idx !== -1) {
        const open = css.indexOf('{', idx);
        const close = css.indexOf('}', open);
        if (open === -1 || close === -1) break;
        blocks.push(css.slice(open + 1, close));
        idx = css.indexOf(selector, close);
    }
    return blocks;
}

test('окно не наследует цвет текста темы (контраст на светлых темах)', () => {
    const block = ruleBlocks('.uris-window {').at(0);
    assert.match(block, /color:\s*var\(--uris-text-strong\)/, 'text must use the constant dark-surface token');
    assert.doesNotMatch(block, /SmartThemeBodyColor/, 'theme body color is tuned for light backgrounds on light themes');
    // ST's .text_pole hardcodes --SmartThemeBodyColor; inside the dark window
    // that needs the same pin (selects/textarea values were 4.0:1 on MEMO).
    const overrides = ruleBlocks('.uris-window .text_pole {');
    assert.ok(overrides.some(b => /color:\s*var\(--uris-text-strong\)/.test(b)), 'text_pole inside the window must be pinned to the URIS token');
});

test('tile «+» референсов и picker-диалог — тоже токены URIS', () => {
    const tileBlocks = ruleBlocks('.uris-refs-add-tile {');
    assert.ok(tileBlocks.some(b => /color:\s*var\(--uris-text-mut/.test(b)), 'add-tile must pin its icon color to a URIS token');
    const pickerIdx = css.indexOf('.uris-picker-dialog {');
    assert.ok(pickerIdx !== -1);
    const pickerRegion = css.slice(pickerIdx, pickerIdx + 2500); // block + mobile override
    assert.doesNotMatch(pickerRegion, /SmartThemeBodyColor/, 'picker dialog must not inherit theme text color');
});
