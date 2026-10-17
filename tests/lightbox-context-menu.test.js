// @ts-check
// Контекстное меню лайтбокса (ПКМ + long-press по картинке): wiring-контракт
// на уровне исходников — конвенция lightbox-тестов (живой pswp в fake-dom не
// инстанцируется, см. lightbox-open-race.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui');
const lbSrc = readFileSync(join(uiDir, 'lightbox.js'), 'utf8');
const gaSrc = readFileSync(join(uiDir, 'gallery-actions.js'), 'utf8');

test('lightbox вешает card-жест на корень pswp после init', () => {
    const bindIdx = lbSrc.indexOf('bindCardContextMenu(pswp.element');
    assert.notEqual(bindIdx, -1, 'жест биндится на корень просмотрщика');
    const initIdx = lbSrc.indexOf('pswp.init();');
    const callIdx = lbSrc.indexOf('registerContextMenu(pswp');
    assert.ok(initIdx !== -1 && callIdx !== -1 && callIdx > initIdx, 'биндинг после init — element уже создан');
});

test('меню открывается только по картинке и не для референсов', () => {
    assert.match(lbSrc, /\.pswp__img/, 'гвард: жест только по самой картинке');
    assert.match(lbSrc, /__actions === 'ref'/, 'у референсов промпта/регена нет — меню не открывается');
});

test('меню содержит «Отредактировать промпт» и «Сгенерировать ещё»', () => {
    assert.match(lbSrc, /Отредактировать промпт/);
    assert.match(lbSrc, /editPromptAndRegenerate\(item/);
    assert.match(lbSrc, /Сгенерировать ещё/);
    // Контракт тулбара соблюдён: вьювер закрывается только при успехе.
    assert.match(lbSrc, /closeOnOk/);
});

test('regenerate принимает overrides.prompt; правка промпта — одна постановка', () => {
    assert.match(gaSrc, /overrides = \{\}\)/, '4-й параметр опционален — старые вызовы не тронуты');
    assert.match(gaSrc, /overrides\.prompt \|\| item\.prompt/);
    assert.match(gaSrc, /editPromptAndRegenerate/);
    // Отмена/пустой/неизменённый ввод — без платной постановки.
    assert.match(gaSrc, /if \(edited == null\) return false;/);
    assert.match(gaSrc, /if \(!prompt \|\| prompt === current\) return false;/);
});
