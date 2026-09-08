// @ts-check
// Контракт анимационных длительностей PhotoSwipe (src/ui/lightbox.js).
//
// Вендорные дефолты — 333 мс на всё. При drag/pinch-закрытии пользователь уже
// завершил движение сам, и запущенная ПОСЛЕ жеста вторая фаза уезжания читается
// как лаг. Договорённость: дисмисс ≤150 мс, показ/зум ≤300 мс, всё выше 50 мс —
// порога вендора, ниже которого анимация отключается вовсе (≤50 = мгновенно).
//
// Живой pswp в fake-dom не инстанцируется (тяжёлый DOM/matchMedia в init) —
// конвенция «проверка на уровне исходников», как у dead-tap фикса v0.8.5.
// Регресс на вендорные дефолты собирается красным.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'lightbox.js'), 'utf8');

test('длительности PhotoSwipe: быстрое закрытие, умеренные показ и зум', () => {
    assert.match(src, /hideAnimationDuration:\s*100\b/, 'закрытие 100 мс (вендорный дефолт 333 — лаг после жеста; ≤150 договорились)');
    assert.match(src, /showAnimationDuration:\s*250\b/, 'открытие 250 мс — траектория от миниатюры сохраняется, но поживее дефолта');
    assert.match(src, /zoomAnimationDuration:\s*250\b/, 'зум двойным тапом поживее дефолта');
});

test('длительности заданы именно в опциях конструктора PhotoSwipe', () => {
    const ctorIdx = src.indexOf('new PhotoSwipe({');
    assert.notEqual(ctorIdx, -1, 'нет вызова new PhotoSwipe({');
    const options = src.slice(ctorIdx, src.indexOf('});', ctorIdx));
    for (const [name, value] of [['hideAnimationDuration', 100], ['showAnimationDuration', 250], ['zoomAnimationDuration', 250]]) {
        assert.match(options, new RegExp(`${name}:\\s*${value}\\b`), `${name} должен передаваться в опции конструктора`);
    }
});
