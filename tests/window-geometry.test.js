// @ts-check
// Геометрия плавающего окна (src/ui/window.js, находка 2.1 deep-review 2026-09-25).
//
// SillyTavern ставит на <html> `-webkit-transform: translateZ(0)` (public/style.css),
// и это делает <html> содержащим блоком для position:fixed. Замерено в headless
// Chrome 2026-09-25: элемент с top:80px после scrollY=500 оказывается на -420px,
// а без transform остаётся на 80px. Поэтому окно, открытое при ненулевом скролле
// чата, уезжает вместе со страницей, и шапка с кнопками может уйти за вьюпорт.
// Кламп раньше выполнялся только при восстановлении сохранённой геометрии.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { _testWindowGeometry } from '../src/ui/window.js';

const { clampWindowGeometry, MIN_VISIBLE_PX, MIN_WIDTH, MIN_HEIGHT } = _testWindowGeometry;

const VP = { width: 1280, height: 800 };

test('clampWindowGeometry возвращает окно, уехавшее со скроллом, во вьюпорт', () => {
    // scrollY=500 сдвинул окно (top 80) на -420 — шапка целиком за верхним краем.
    const clamped = clampWindowGeometry(
        { left: 20, top: -420, width: 460, height: 560 },
        VP,
        { topInset: 40 },
    );
    assert.ok(clamped.top >= 40, 'шапка не должна уезжать под топ-бар ST');
    assert.ok(clamped.top + MIN_VISIBLE_PX <= VP.height, 'шапка остаётся достижимой снизу');
    assert.ok(clamped.left + MIN_VISIBLE_PX <= VP.width, 'окно остаётся достижимым справа');
    assert.ok(clamped.left + clamped.width >= MIN_VISIBLE_PX, 'окно остаётся достижимым слева');
});

test('clampWindowGeometry не трогает окно, которое и так на экране', () => {
    const onScreen = { left: 200, top: 120, width: 460, height: 560 };
    assert.deepEqual(clampWindowGeometry(onScreen, VP, { topInset: 40 }), onScreen);
});

test('clampWindowGeometry выталкивает окно из-под топ-бара ST', () => {
    // Топ-бар (z 3005) рисуется поверх окна — шапка в верхней полосе некликабельна.
    const clamped = clampWindowGeometry(
        { left: 100, top: 5, width: 460, height: 560 },
        VP,
        { topInset: 40 },
    );
    assert.equal(clamped.top, 40);
    assert.equal(clamped.left, 100, 'валидная горизонталь не двигается');
});

test('clampWindowGeometry с нулевым inset не поднимает окно от верхнего края', () => {
    // Вне SillyTavern топ-бара нет — окно может стоять вплотную к краю.
    const clamped = clampWindowGeometry(
        { left: 100, top: 0, width: 460, height: 560 },
        VP,
        { topInset: 0 },
    );
    assert.equal(clamped.top, 0);
});

test('clampWindowGeometry не даёт окну стать меньше минимума и шире вьюпорта', () => {
    const clamped = clampWindowGeometry(
        { left: -900, top: -900, width: 5000, height: 5000 },
        { width: 600, height: 500 },
        { topInset: 0 },
    );
    assert.equal(clamped.width, 600);
    assert.equal(clamped.height, 500);
    assert.ok(clamped.width >= Math.min(MIN_WIDTH, 600));
    assert.ok(clamped.height >= Math.min(MIN_HEIGHT, 500));
    assert.ok(clamped.left >= 0 && clamped.top >= 0);
});

// ── Жест перетаскивания не отдаётся скроллу страницы ──

const rawCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'), 'utf8');
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBlock(selector) {
    const idx = css.indexOf(selector);
    assert.notEqual(idx, -1, `селектор ${selector} не найден в style.css`);
    const open = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
}

test('шапка и ресайзер забирают жест себе (touch-action: none)', () => {
    // Иначе палец на шапке листает чат под окном, а ресайз пальцем невозможен.
    assert.match(ruleBlock('.uris-header {'), /touch-action:\s*none/);
    assert.match(ruleBlock('.uris-resizer {'), /touch-action:\s*none/);
});
