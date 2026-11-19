// @ts-check
// Гонка двойного открытия лайтбокса (регресс 2026-10-03): два быстрых вызова
// showLightbox оба проходили `_active?.close()` до создания инстанса, оба
// await'или пробу размеров, и МЕДЛЕННЫЙ вызов потом монтировал свой viewer
// поверх живого — «зомби-просмотрщик». Контракт: у showLightbox есть
// монотонный seq-гард, и устаревший вызов выходит ПОСЛЕ await'ов и ДО
// создания PhotoSwipe.
// Конвенция lightbox-тестов: живой pswp в fake-dom не инстанцируется —
// проверка на уровне исходников (как lightbox-closing-hit-test.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'lightbox.js'), 'utf8');

test('showLightbox берёт seq до первого await и проверяет его после — до new PhotoSwipe', () => {
    const seqAssign = src.indexOf('const seq = ++_openSeq;');
    assert.notEqual(seqAssign, -1, 'seq берётся синхронно при входе');
    const createIdx = src.indexOf('new PhotoSwipe(');
    assert.notEqual(createIdx, -1);
    const guard = src.lastIndexOf('seq !== _openSeq', createIdx);
    assert.notEqual(guard, -1, 'проверка seq есть до создания PhotoSwipe');
    const lastAwait = src.lastIndexOf('await ensureCardDimensions', guard);
    assert.notEqual(lastAwait, -1, 'гард стоит ПОСЛЕ await\'ов пробы размеров (иначе он ничего не ловит)');
});
