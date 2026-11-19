// @ts-check
// [hidden] против display-правил автора: UA-стиль `[hidden] { display: none }`
// проигрывает любому авторскому `display`, поэтому `.uris-btn { display:
// inline-flex }` делал красную «Остановить» видимой даже в покое (атрибут
// hidden стоял, кнопка рисовалась). Тест держит явное правило-спасатель.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readAllStyles } from './_helpers.js';

const rawCss = readAllStyles();
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBodyFor(selector) {
    const idx = css.indexOf(selector);
    assert.notEqual(idx, -1, `селектор ${selector} не найден в style.css`);
    const open = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
}

test('.uris-btn[hidden] глушит display: скрытые кнопки не отрисовываются', () => {
    const body = ruleBodyFor('.uris-btn[hidden]');
    assert.match(body, /display\s*:\s*none/, 'без display:none атрибут hidden бессилен против .uris-btn { display: inline-flex }');
});
