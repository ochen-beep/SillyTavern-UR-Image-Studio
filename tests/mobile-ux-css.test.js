// @ts-check
// CSS-контракты мобильного UX-прохода (docs/2026-10-03-mobile-ux-pass-design.md):
// правила живут внутри мобильных @media и не утекают на десктоп.
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

/**
 * Тело правила селектора ВНУТРИ @media с заданным условием. Файлов несколько
 * блоков с одним условием (705 и 799) — каскадно побеждает ПОСЛЕДНЕЕ правило,
 * его и возвращаем.
 */
function mobileRuleBody(selector, mediaPattern = /max-width:\s*768px/) {
    let found = null;
    let from = 0;
    for (;;) {
        const idx = css.indexOf(`${selector} {`, from);
        if (idx === -1) break;
        const mediaStart = css.lastIndexOf('@media', idx);
        const mediaText = css.slice(mediaStart, css.indexOf('{', mediaStart));
        if (mediaPattern.test(mediaText)) found = ruleBodyAt(idx);
        from = idx + 1;
    }
    assert.notEqual(found, null, `мобильное правило ${selector} не найдено`);
    return found;
}

function ruleBodyAt(idx) {
    const open = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
}

test('галерея: кнопочные строки карточек спрятаны на мобильном', () => {
    assert.match(mobileRuleBody('.uris-card-actions'), /display:\s*none/);
});

test('галерея: тулбар липкий и компактный, подписи спрятаны', () => {
    const body = mobileRuleBody('.uris-gallery-toolbar');
    assert.match(body, /position:\s*sticky/);
    assert.match(body, /top:\s*0/);
    assert.match(mobileRuleBody('.uris-gallery-toolbar .uris-btn-label'), /display:\s*none/);
    assert.match(mobileRuleBody('.uris-gallery-toolbar .uris-btn'), /min-height:\s*44px/);
});

test('карточное меню: шит снизу <768px, поповер без шита ≥768px', () => {
    const idx = css.indexOf('.uris-action-menu-overlay { align-items: flex-end; }');
    assert.notEqual(idx, -1, 'правило нижнего шита не найдено');
    const mediaStart = css.lastIndexOf('@media', idx);
    const brace = css.indexOf('{', mediaStart);
    assert.match(css.slice(mediaStart, brace), /max-width:\s*767px/);
    assert.match(ruleBody('.uris-action-menu-grip'), /display:\s*none/, 'на десктопе грипа нет');
});

test('карточное меню: поповер абсолютен на десктопе, шит на мобиле — статичен', () => {
    // Регресс 2026-10-04: без position у .uris-action-menu инлайн left/top из
    // card-action-menu.js инертны — flex оверлея центрировал меню, и поповер
    // «у курсора» (как и клэмп к краю) не работал вовсе.
    assert.match(ruleBody('.uris-action-menu'), /position:\s*absolute/,
        'inline left/top работает только у позиционированного элемента');
    const mobile = mobileRuleBody('.uris-action-menu', /max-width:\s*76[78]px/);
    assert.match(mobile, /position:\s*static/, 'шит снизу позиционируется флексом, не абсолютом');
});

test('пункты меню не меньше 44px — зона пальца', () => {
    assert.match(ruleBody('.uris-action-menu-item'), /min-height:\s*44px/);
});

test('референсы: коллаж 2×2 в строках папок, чип-переключатель и липкий футер', () => {
    // Эти классы встречаются только в мобильном render-пути (tab-references,
    // _renderMobile*), поэтому скоупятся DOM-путём, а не @media.
    assert.match(ruleBody('.uris-mobile-folder-collage'), /grid-template-columns:\s*1fr 1fr/);
    assert.match(ruleBody('.uris-mobile-folder-switch'), /cursor:\s*pointer/);
    assert.match(ruleBody('.uris-mobile-card-scroll .uris-ed-footer'), /position:\s*sticky/);
    assert.match(ruleBody('.uris-mobile-card-scroll .uris-ed-footer .uris-btn'), /min-height:\s*44px/);
});
