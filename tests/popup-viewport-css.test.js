// @ts-check
// Регрессионный статический тест геометрии полноэкранных попапов (lightbox,
// picker overlay, ERR-панель) в мобильном SillyTavern.
//
// Контекст: ST mobile (public/css/mobile-styles.css, @media ≤1000px) ставит
// `body { position: fixed; overflow: hidden }`. Из-за этого содержащий блок
// fixed-потомков вырождается (html теряет высоту): `inset: 0` даёт нулевой
// оверлей, а привязка `bottom:` уводит элемент ЗА верхний край экрана.
// Симптом: в портрете (≤768px, когда наш mobile-CSS включает bottom-sheet)
// пикеры выбора референсов, лайтбокс галереи и ERR-панель были не видны;
// в ландшафте (>768px, top/center-привязка десктопного CSS) — появлялись.
//
// Фикс: полноэкранные оверлеи используют явные `top: 0; left: 0; width: 100%;
// height: 100vh/100dvh` (растяжка по inset запрещена), мобильная ERR-панель
// привязана сверху (`top: calc(...)`), а не снизу. Тест страхует регресс:
// возврат к inset/bottom-привязке соберётся красным.
//
// Живая проверка окружения: tests/manual/popup-mobile-repro.html (портрет/ландшафт).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rawCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'), 'utf8');
// Комментарии вырезаем: они поясняют «почему», а для парсинга важны только декларации
// (иначе { } внутри комментария ломают поиск границ блока).
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

/** Достать блок правил селектора (первое совпадение, без вложенных @media). */
function ruleBlock(selector) {
    const idx = css.indexOf(selector);
    assert.notEqual(idx, -1, `селектор ${selector} не найден в style.css`);
    const open = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
}

test('pswp-лайтбокс: явные высоты и z-index уровня наших оверлеев', () => {
    // Вендорный photoswipe.css ставит .pswp { position: fixed; height: 100% }.
    // В ST mobile (body fixed, html вырожден) height: 100% ненадёжна — наш
    // адаптационный блок переопределяет высоту рецептом 100vh → 100dvh и
    // фиксирует z-index на уровне .uris-picker-overlay (100000; окно 99999).
    const block = ruleBlock('.pswp.uris-pswp {');
    assert.match(block, /height:\s*100vh[^;]*;\s*height:\s*100dvh/, 'нужны явные height 100vh/100dvh (dvh — progressive enhancement после vh)');
    assert.match(block, /z-index:\s*100000/, 'просмотрщик должен быть на уровне наших оверлеев (100000), иначе откроется под окном (99999)');
});

test('uris-picker-overlay: явные top/left/width/height вместо inset: 0', () => {
    const block = ruleBlock('.uris-picker-overlay {');
    assert.match(block, /top:\s*0/);
    assert.match(block, /left:\s*0/);
    assert.match(block, /height:\s*100vh[^;]*;\s*height:\s*100dvh/);
    assert.doesNotMatch(block, /inset:\s*0/, 'inset: 0 запрещён: в ST mobile bottom-sheet улетает за верх экрана');
});

test('мобильная ERR-панель: top-привязка, без bottom (ST mobile body fixed)', () => {
    // мобильный блок — последний @media (max-width: 768px) c .uris-error-panel
    const mediaIdx = css.lastIndexOf('.uris-error-panel');
    assert.notEqual(mediaIdx, -1, 'правила .uris-error-panel не найдены');
    const open = css.indexOf('{', mediaIdx);
    const close = css.indexOf('}', open);
    const block = css.slice(open + 1, close);
    assert.match(block, /top:\s*calc\(/, 'мобильная панель должна привязываться top: calc(...) — bottom уводит её за экран в ST mobile');
    assert.match(block, /bottom:\s*auto/, 'bottom должен быть явно отключён (auto)');
});

test('uris-drag-ghost: z-index выше окна расширения (99999)', () => {
    const block = ruleBlock('.uris-drag-ghost {');
    const m = block.match(/z-index:\s*(\d+)/);
    assert.ok(m, 'у .uris-drag-ghost должен быть числовой z-index');
    assert.ok(Number(m[1]) > 99999, `z-index ghost (${m[1]}) должен быть выше окна (99999), иначе призрак невидим за окном`);
});

test('uris-refs-grid-wrap: flex-контейнер, иначе сетка референсов не скроллится', () => {
    // .uris-pool-grid ограничивается высотой только как flex-item (flex:1 +
    // min-height:0). Если wrap — block, grid растёт до контента, а wrap с
    // overflow:hidden его обрезает: низ срезается, скролла нет вообще.
    // Симптом из баг-репорта: в Опере на Android (вкладка ≥480px в мобильном
    // окне ≤768 — десктоп-раскладка на телефоне) галерея не листалась; то же
    // на десктопе в низком окне. Воспроизведение: refs-real-render.html?cw=600.
    const block = ruleBlock('.uris-refs-grid-wrap {');
    assert.match(block, /display:\s*flex/, 'wrap должен быть display: flex — сетка-потомок ограничивается высотой только как flex-item');
    assert.match(block, /flex-direction:\s*column/);
    assert.match(block, /min-height:\s*0/);
    assert.match(block, /overflow:\s*hidden/);
});

test('кнопки окна и оверлеев: touch-action pan-y (скролл на тач-устройствах)', () => {
    // ST-темы с `button { touch-action: none }` гасят свайп, начатый на
    // тайле-кнопке: галерею референсов становится невозможно листать пальцем.
    // Наше правило должно перекрывать голый `button`-селектор темы.
    const idx = css.indexOf('.uris-window button, .uris-picker-overlay button');
    assert.notEqual(idx, -1, 'нет правила touch-action для кнопок окна/оверлеев');
    const open = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    const block = css.slice(open + 1, close);
    assert.match(block, /touch-action:\s*pan-y/, 'кнопки должны разрешать вертикальный пан');
    // Скролл-контейнеры — тоже явно pan-y.
    for (const sel of ['.uris-pool-grid {', '.uris-mobile-list {', '.uris-mobile-card-scroll {']) {
        assert.match(ruleBlock(sel), /touch-action:\s*pan-y/, `${sel} должен иметь touch-action: pan-y`);
    }
});
