// @ts-check
// Контракт бейджей шапки (QUEUE и INFO) в style.css.
//
// Единый вид (решение 2026-10-02): оба бейджа всегда видны — пустое состояние
// это приглушённый idle, а не отсутствие элемента; чуть крупнее прежнего;
// одно idle-правило на двоих, цифра в покое не показывается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rawCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'), 'utf8');
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

/** Тело правила по селектору (первое вхождение). */
function ruleBody(selector) {
    const idx = css.indexOf(`${selector} {`);
    assert.notEqual(idx, -1, `правило ${selector} не найдено`);
    const open = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
}

test('бейдж чуть крупнее прежнего: 12px и паддинг 2px 8px', () => {
    const body = ruleBody('.uris-error-badge');
    assert.match(body, /font-size:\s*calc\(12px \* var\(--uris-font-scale, 1\)\)/);
    assert.match(body, /padding:\s*2px 8px/);
});

test('единое idle-состояние: приглушённый бейдж остаётся в шапке', () => {
    const body = ruleBody('.uris-error-badge--idle');
    assert.match(body, /opacity:\s*0\.45/);
    const hover = ruleBody('.uris-error-badge--idle:hover');
    assert.match(hover, /opacity:\s*0\.8/);
});

test('в idle цифра скрыта: ноль не несёт информации', () => {
    const body = ruleBody('.uris-error-badge--idle .uris-error-count');
    assert.match(body, /display:\s*none/);
});

test('старое раздельное состояние --seen удалено (не осталось второго языка)', () => {
    assert.equal(css.includes('--seen'), false, 'класс uris-error-badge--seen не должен остаться');
});

test('точка серьёзности INFO на месте (язык внимания не потерян)', () => {
    const body = ruleBody('.uris-badge-dot');
    assert.match(body, /background:\s*var\(--uris-err/);
});

test('шапка без заголовка: правило .uris-title удалено, actions прижаты вправо', () => {
    assert.equal(css.includes('.uris-title'), false, 'заголовок шапки удалён — правило не должно оставаться');
    const actions = ruleBody('.uris-header-actions');
    assert.match(actions, /margin-left:\s*auto/, 'actions держатся у правого края независимо от того, что появится слева');
});
