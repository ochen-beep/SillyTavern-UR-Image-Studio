// @ts-check
/**
 * UR Image Studio — floating launcher (FAB) tests.
 *
 * Позиционная математика — pure-функции (перенос из DS Comments
 * floating-launcher.test.mjs): дефолтные якоря (десктоп/мобайл), клэмпы
 * (включая inset топ-бара ST, который рисуется ПОВЕРХ FAB — позиция в верхней
 * полосе обязана выталкиваться вниз), валидация restore. localStorage-пейлоад
 * недоверенный — протухшие координаты с большего вьюпорта откатываются к
 * дефолту угла, а не оставляют кнопку за экраном.
 *
 * DOM/drag-обвязка (ensureFloatingLauncher, Pointer Events, resize) не
 * тестируется — та же политика, что у DSC; слои закреплены в
 * popup-viewport-css.test.js, CSS-инварианты FAB — внизу этого файла.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { _testFloatingLauncher, makePulseStateMachine } from '../src/ui/floating-launcher.js';

const { defaultPosition, clampPosition, clampFabPosition, computeRestoredPosition, FAB_SIZE, DRAG_THRESHOLD_PX } = _testFloatingLauncher;

const VP = { width: 1920, height: 1080 };

// ── defaultPosition ──

test('defaultPosition anchors to the bottom-right corner (desktop)', () => {
    assert.deepEqual(defaultPosition(VP, FAB_SIZE, false), { left: 1920 - 36 - 20, top: 1080 - 36 - 80 });
});

test('defaultPosition mobile offset clears #send_form', () => {
    assert.deepEqual(defaultPosition(VP, FAB_SIZE, true), { left: 1920 - 36 - 16, top: 1080 - 36 - 120 });
});

// ── clampPosition ──

test('clampPosition keeps the FAB fully inside the viewport', () => {
    assert.deepEqual(clampPosition({ left: -50, top: -50 }, VP, FAB_SIZE), { left: 0, top: 0 });
    assert.deepEqual(clampPosition({ left: 5000, top: 5000 }, VP, FAB_SIZE), { left: 1920 - 36, top: 1080 - 36 });
    assert.deepEqual(clampPosition({ left: 100, top: 100 }, VP, FAB_SIZE), { left: 100, top: 100 });
});

// ── clampFabPosition (chrome-aware) ──

test('clampFabPosition pushes positions out of the ST top-bar strip', () => {
    // Топ-бар (3005) рисуется поверх FAB (2989): кнопка, запаркованная в
    // верхней полосе, уезжает под бар и становится некликабельной.
    const topInset = 40;
    assert.deepEqual(clampFabPosition({ left: 100, top: 10 }, VP, FAB_SIZE, topInset), { left: 100, top: 40 });
    // Клэмп верха не двигает валидные позиции ниже инset'а.
    assert.deepEqual(clampFabPosition({ left: 100, top: 500 }, VP, FAB_SIZE, topInset), { left: 100, top: 500 });
});

test('clampFabPosition with zero inset is a plain viewport clamp', () => {
    // Вне ST бара нет → inset 0 → клэмп верха не применяется вовсе.
    assert.deepEqual(clampFabPosition({ left: 100, top: 10 }, VP, FAB_SIZE, 0), { left: 100, top: 10 });
});

test('clampFabPosition still honours the viewport on absurdly tiny windows', () => {
    // Вырожденный случай (бар выше vh - size): inset приоритетен над «низом на
    // экране» — паритет с clampWindowGeometry в window.js. Кнопка уходит за
    // нижний край, но НЕ парковется целиком под баром (3005 рисует поверх):
    // раньше min(…, vh - size) закатывал её под бар намертво.
    const tiny = { width: 200, height: 30 };
    const pos = clampFabPosition({ left: 0, top: 0 }, tiny, FAB_SIZE, 50);
    // inset клэмпится к vh-1: максимум 1px гарантированно остаётся видимым.
    assert.equal(pos.top, Math.min(50, tiny.height - 1));
    assert.ok(pos.top >= Math.min(50, tiny.height - 1), 'top ниже бара-инsetа');
});

// ── Пульс генерации (счётчик активных запускów) ──

test('пульс: гаснет только после ПОСЛЕДНЕЙ параллельной генерации', () => {
    // Stage 2 сериализован per-post, auto-поток цепочку обходит — ручная
    // генерация может идти параллельно очереди. Булево от первого end
    // гасило пульс под живую генерацию (доказано вживую, см. ревью).
    const states = [];
    const pulse = makePulseStateMachine(on => states.push(on));
    pulse.start();
    pulse.start();               // вторая генерация стартовала параллельно
    pulse.end();                 // первая закончилась — пульс ещё ЖИВ
    assert.deepEqual(states, [true], 'пульс не должен гаснуть, пока идёт другая генерация');
    pulse.end();                 // закончилась последняя — гаснет
    assert.deepEqual(states, [true, false]);
});

test('пульс: лишний end без start не гасит и не уводит счётчик в минус', () => {
    const states = [];
    const pulse = makePulseStateMachine(on => states.push(on));
    pulse.end();
    pulse.end();
    assert.deepEqual(states, [], 'end без start — ничего не делает');
    pulse.start();
    pulse.end();
    assert.deepEqual(states, [true, false], 'после мусорных end честная пара работает');
});

// ── Биндинг пульса: безусловно, для любого launcherMode ──

const indexSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8');
const flSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'floating-launcher.js'), 'utf8');

test('пульс биндится из ensureLauncher безусловно — работает и в bar-режиме', () => {
    // Регресс: bindStage2Pulse вызывался только при создании FAB
    // (ensureFloatingLauncher, ветка if (!icon)), а FAB в дефолтном
    // launcherMode 'bar' не монтируется вовсе → пульс мёртв (доказано
    // вживую синтетическими uris:stage2-start на 127.0.0.1:8001).
    assert.match(flSrc, /export function bindStage2Pulse/, 'bindStage2Pulse должен быть экспортирован');
    const ensureIdx = indexSrc.indexOf('function ensureLauncher()');
    assert.notEqual(ensureIdx, -1, 'не найден ensureLauncher в index.js');
    const nextFn = indexSrc.indexOf('\nfunction ', ensureIdx + 1);
    const ensureBody = indexSrc.slice(ensureIdx, nextFn === -1 ? indexSrc.length : nextFn);
    assert.match(ensureBody, /bindStage2Pulse\(\)/, 'ensureLauncher должен звать bindStage2Pulse() безусловно');
    // Старая точка биндинга удалена: ensureFloatingLauncher больше не вешает
    // слушатели только при первом монтировании FAB.
    const ensureFlIdx = flSrc.indexOf('export function ensureFloatingLauncher');
    const flTail = flSrc.slice(ensureFlIdx);
    assert.doesNotMatch(flTail, /bindStage2Pulse\(\)/, 'биндинг не должен жить в FAB-ветке');
});

// ── computeRestoredPosition (untrusted localStorage payload) ──

test('computeRestoredPosition keeps a still-valid saved position', () => {
    const saved = { left: 1200, top: 900 };
    assert.deepEqual(computeRestoredPosition(saved, VP, FAB_SIZE, false), saved);
});

test('computeRestoredPosition falls back to the corner for off-screen garbage', () => {
    const corner = defaultPosition(VP, FAB_SIZE, false);
    assert.deepEqual(computeRestoredPosition({ left: 5000, top: 100 }, VP, FAB_SIZE, false), corner);
    assert.deepEqual(computeRestoredPosition({ left: -10, top: 100 }, VP, FAB_SIZE, false), corner);
    assert.deepEqual(computeRestoredPosition(null, VP, FAB_SIZE, false), corner);
    assert.deepEqual(computeRestoredPosition({ left: NaN, top: undefined }, VP, FAB_SIZE, false), corner);
});

// ── Threshold ──

test('drag threshold is small enough for a click, large enough for a drag', () => {
    assert.ok(DRAG_THRESHOLD_PX > 0 && DRAG_THRESHOLD_PX < 15);
});

// ── CSS-инварианты FAB ──

const rawCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'), 'utf8');
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBlock(selector) {
    const idx = css.indexOf(selector);
    assert.notEqual(idx, -1, `селектор ${selector} не найден в style.css`);
    const open = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
}

test('uris_fab CSS: fixed-слой --uris-z-fab, touch-action none (перетаскивание пальцем)', () => {
    const block = ruleBlock('.uris_fab {');
    assert.match(block, /position:\s*fixed/);
    assert.match(block, /z-index:\s*var\(--uris-z-fab\)/, 'FAB должен жить на слое --uris-z-fab (лестница слоёв — в popup-viewport-css.test.js)');
    // touch-action: none обязателен — иначе палец скроллит чат вместо драга.
    assert.match(block, /touch-action:\s*none/);
});

test('uris_fab CSS: пульс генерации с opt-out prefers-reduced-motion', () => {
    assert.match(css, /\.uris_fab\.uris_generating[^{]*\{[^}]*animation:\s*uris-pulse/);
    assert.match(css, /@keyframes uris-pulse\s*\{/);
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*uris_generating[^}]*\}/);
    assert.ok(reduced, 'пульс должен отключаться при prefers-reduced-motion');
});
