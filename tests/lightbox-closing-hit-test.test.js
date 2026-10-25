// @ts-check
// Контракт «мёртвого тапа»: закрывающийся просмотрщик не перехватывает тапы.
//
// Механика (по вендорному коду): pswp.close() первой строкой снимает свои
// DOM-слушатели, но корень .pswp живёт всю closing animation и остаётся целью
// hit-теста; при этом вендорный CSS ЯВНО возвращает pointer-events:auto
// потомкам — .pswp__content > * (картинка) и .pswp--ui-visible .pswp__hide-on-close
// (UI-бар в момент закрытия) — так что корневого pointer-events:none мало,
// а установка на closingAnimationStart опаздывает на setTimeout(0|30).
//
// Живой pswp в fake-dom не инстанцируется — проверка на уровне исходников
// (конвенция, см. lightbox-animation.test.js). Регресс (возврат на
// closingAnimationStart или потеря CSS-правила) собирается красным.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readAllStyles } from './_helpers.js';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'lightbox.js'), 'utf8');
const rawCss = readAllStyles();
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

test('hit-transparent ставится на самом раннем событии закрытия (close, не closingAnimationStart)', () => {
    const closeIdx = src.indexOf("pswp.on('close'");
    assert.notEqual(closeIdx, -1, "нет обработчика pswp.on('close')");
    const handler = src.slice(closeIdx, src.indexOf('});', closeIdx));
    assert.match(handler, /pointerEvents\s*=\s*'none'/, 'корень должен стать прозрачным для hit-теста');
    assert.match(handler, /classList\.add\('uris-pswp-closing'\)/, 'класс нужен, чтобы перекрыть вендорные дыры в CSS');
    // Регресс: установка на closingAnimationStart оставляла 1-2 кадра мёртвого окна.
    const legacy = src.indexOf("pswp.on('closingAnimationStart'");
    const legacyBlock = legacy === -1 ? '' : src.slice(legacy, src.indexOf('});', legacy));
    assert.doesNotMatch(legacyBlock, /pointerEvents/, 'pointer-events должен ставиться в close(), не позже');
});

test('CSS глушит ВЕСЬ hit-тест поддерева закрывающегося pswp', () => {
    // Перечислять дыры вендора (.pswp__content > *, .pswp__top-bar > *,
    // .pswp--ui-visible .pswp__hide-on-close, ...) хрупко — у каждой версии
    // вендора свой набор явных pointer-events:auto. Контракт: универсальное
    // правило на всё поддерево.
    const idx = css.indexOf('.uris-pswp-closing,');
    assert.notEqual(idx, -1, 'нет универсального правила прозрачности для закрывающегося pswp');
    const open = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    const selector = css.slice(idx, open);
    assert.match(selector, /\.uris-pswp-closing \*/, 'правило должно глушить всех потомков, а не отдельные дыры');
    const block = css.slice(open + 1, close);
    assert.match(block, /pointer-events:\s*none\s*!important/, 'нужен !important против вендорных правил');
    // Каскад: правило стоит после вендорных pointer-events-правил (равная специфичность).
    const vendorHole = css.indexOf('.pswp__top-bar > *');
    assert.notEqual(vendorHole, -1, 'вендорное правило-дыра не найдено — сравнение позиции невозможно');
    assert.ok(idx > vendorHole, 'правило должно идти ПОСЛЕ вендорных pointer-events-правил');
});

test('watchdog принудительно доуничтожает зависший закрывающийся корень', () => {
    // Вендорная развязка висит на transitionend с каскадом setTimeout(0 → 30)
    // и фолбэком duration+500: корень .pswp может легально жить до ~1.2с после
    // close(), под нагрузкой дольше. Хит-тест он прозрачен, но квирк движка или
    // чужой !important возвращают «мёртвое окно». Контракт: в обработчике
    // 'close' стоит принудительный destroy по таймауту, короче вендорного
    // худшего случая и длиннее здоровой развязки (~250мс).
    const closeIdx = src.indexOf("pswp.on('close'");
    assert.notEqual(closeIdx, -1, "нет обработчика pswp.on('close')");
    const handler = src.slice(closeIdx, src.indexOf('});', closeIdx));
    assert.match(handler, /setTimeout/, 'в close-обработчике должен быть watchdog-таймер');
    assert.match(handler, /isConnected/, 'destroy только если корень ещё в DOM (гонка со здоровой развязкой)');
    assert.match(handler, /pswp\.destroy\(\)/, 'watchdog вызывает destroy()');
    const timeoutMatch = handler.match(/},\s*(\d+)\)/);
    assert.notEqual(timeoutMatch, null, 'не найдено значение таймаута watchdog');
    const ms = Number(timeoutMatch[1]);
    assert.ok(ms >= 350 && ms <= 600, `watchdog ${ms}мс вне окна 350–600: короче — режет здоровую анимацию, дольше — вендорный фолбэк (600+мс) успевает сам`);
});
