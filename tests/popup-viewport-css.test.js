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

/** Значение числовой переменной слоёв --uris-z-* из :root (единственный источник слоёв). */
function zVar(name) {
    const rootIdx = css.indexOf(':root');
    const open = css.indexOf('{', rootIdx);
    const close = css.indexOf('}', open);
    const m = css.slice(open, close).match(new RegExp(`--uris-z-${name}:\\s*(\\d+)`));
    assert.ok(m, `в :root не объявлена --uris-z-${name}`);
    return Number(m[1]);
}

test('слои URIS: строгий порядок, ниже хрома и легаси-диалогов SillyTavern', () => {
    // Договорённость см. :root в style.css. Ориентиры ST (public/style.css):
    // дроверы #left-nav-panel/.fillRight 3000, #nav-toggle/#bg_menu 3001,
    // топ-бар и шелл настроек 3005, легаси-диалоги #dialogue_popup 9999
    // (<dialog>-попапы — top layer, выше любого z-index, их не учитываем).
    // Чужие панели и FAB (Glosses / DS Comments) живут на 2998–2999.
    const fab = zVar('fab');
    const win = zVar('window');
    const ghost = zVar('ghost');
    const modal = zVar('modal');
    const lightbox = zVar('lightbox');
    const modalTop = zVar('modal-top');
    assert.ok(win < ghost, 'drag-ghost выше окна — иначе клон не виден при перетаскивании');
    assert.ok(ghost < fab, 'FAB остаётся верхним из «постоянных» слоёв URIS');
    assert.ok(win < fab, 'FAB над окном (как в DSC): остаётся тогглом поверх открытого окна');
    assert.ok(fab > 2998, 'FAB ВЫШЕ панелей чужих расширений (2998 у Glosses/DS Comments) — иначе кнопка исчезает, когда панель накрывает её точку');
    assert.ok(fab < 3000, 'FAB НИЖЕ nav-drawer ST (3000): кнопка не может перекрыть настройки таверны');
    assert.ok(ghost < modal, 'модальные оверлеи (пикеры) выше ghost');
    assert.ok(modal < lightbox, 'лайтбокс выше модалок (строго, не полагаемся на DOM-порядок)');
    assert.ok(lightbox < modalTop, 'кроп/копи-меню должны открываться поверх лайтбокса');
    assert.ok(win < 3000, 'окно ниже nav-drawer ST (3000): не перекрывает таверну и чужие расширения');
    assert.ok(modalTop < 9999, 'всё хозяйство URIS ниже легаси-диалогов ST (#dialogue_popup 9999)');
});

test('pswp-лайтбокс: явные высоты и слой --uris-z-lightbox', () => {
    // Вендорный photoswipe.css ставит .pswp { position: fixed; height: 100% }.
    // В ST mobile (body fixed, html вырожден) height: 100% ненадёжна — наш
    // адаптационный блок переопределяет высоту рецептом 100vh → 100dvh и
    // фиксирует z-index на --uris-z-lightbox (вендорный дефолт 100000 — над
    // всей таверной; см. тест слоёв выше).
    const block = ruleBlock('.pswp.uris-pswp {');
    assert.match(block, /height:\s*100vh[^;]*;\s*height:\s*100dvh/, 'нужны явные height 100vh/100dvh (dvh — progressive enhancement после vh)');
    assert.match(block, /--pswp-root-z-index:\s*var\(--uris-z-lightbox\)/, 'вендорная переменная должна быть перенаправлена на наш слой');
    assert.match(block, /z-index:\s*var\(--uris-z-lightbox\)/, 'просмотрщик должен жить на слое --uris-z-lightbox');
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

test('панель бейджа выше sticky-тулбара галереи (мобильная регрессия наложения)', () => {
    // Регрессия 2026-10-04: на мобиле .uris-gallery-toolbar — sticky с z-index: 5,
    // а панель бейджа была z-index: 3. Оба живут в stacking-контексте .uris-window,
    // поэтому тулбар рисовался поверх открытой QUEUE/INFO-панели и перехватывал
    // её тапы. Панель — транзиентный оверлей: обязана быть выше ЛЮБОГО содержимого
    // вкладок, каким бы оно ни было позиционированным.
    const panelBlock = ruleBlock('.uris-error-panel {');
    const panelZ = Number(panelBlock.match(/z-index:\s*(\d+)/)?.[1]);
    assert.ok(panelZ > 0, 'у панели должен быть явный положительный z-index');
    const stickyToolbars = [...css.matchAll(/\.uris-gallery-toolbar\s*\{([^}]*)\}/g)]
        .map(m => m[1])
        .filter(body => /position:\s*sticky/.test(body));
    assert.ok(stickyToolbars.length > 0, 'мобильный sticky-тулбар галереи не найден');
    for (const body of stickyToolbars) {
        const toolbarZ = Number(body.match(/z-index:\s*(\d+)/)?.[1] ?? 0);
        assert.ok(panelZ > toolbarZ, `панель (z=${panelZ}) обязана быть выше sticky-тулбара галереи (z=${toolbarZ})`);
    }
});

test('uris-drag-ghost: слой --uris-z-ghost (выше окна — см. тест слоёв)', () => {
    const block = ruleBlock('.uris-drag-ghost {');
    assert.match(block, /z-index:\s*var\(--uris-z-ghost\)/, 'призрак должен жить на слое --uris-z-ghost');
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
