// @ts-check
// Кнопка-лаунчер в quick-reply баре: квадрат задан явно.
//
// Регресс был визуальный и «плавающий»: ширина кнопки складывалась из
// advance-ширины эмодзи 🎨 (у разных эмодзи-шрифтов она разная — на стенде
// 25.33px при глифе 22px ink), паддингов 3px 5px и рамки ST, а высота — из
// строки и правил `.qr--button`. Квадрат получался случайно и уезжал при смене
// эмодзи-шрифта, зума или темы. Тест держит явную фиксацию размера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rawCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'), 'utf8');
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBodyFor(selector) {
    const idx = css.indexOf(selector);
    assert.notEqual(idx, -1, `селектор ${selector} не найден в style.css`);
    const open = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
}

test('лаунчер в квик-баре: размер задан явно, а не выведен из контента', () => {
    const body = ruleBodyFor('#qr--popout #uris_launcher {');
    assert.match(body, /width\s*:\s*36px/, 'ширина не зафиксирована — вернётся зависимость от шрифта эмодзи');
    assert.match(body, /height\s*:\s*36px/, 'высота не зафиксирована');
    assert.match(body, /min-width\s*:\s*36px/, 'без min-width кнопку может сжать flex-контейнер бара');
    assert.match(body, /min-height\s*:\s*36px/);
    assert.match(body, /padding\s*:\s*0/, 'паддинги ST (.qr--button: 3px 5px) не должны участвовать в размере');
    assert.match(body, /flex\s*:\s*0\s+0\s+auto/, 'кнопка не должна сжиматься в переносимом баре');
    assert.match(body, /align-items\s*:\s*center/);
    assert.match(body, /justify-content\s*:\s*center/);
});

test('паддинг перебивается специфичностью, а не !important', () => {
    // Правило ST `#qr--bar > .qr--buttons .qr--button` задаёт padding 3px 5px.
    // Обнулить его одиночным `#uris_launcher` нельзя — нужен селектор с двумя id.
    const head = css.slice(css.indexOf('/* ── Launcher в quick-reply bar') === -1 ? 0 : css.indexOf('#uris_launcher,'), css.indexOf('{', css.indexOf('#uris_launcher,')));
    assert.match(head, /#uris_launcher,/, 'основной селектор потерян');
    assert.match(head, /#qr--bar #uris_launcher/, 'нет id-скоупа для бара — паддинг ST победит по специфичности');
    assert.match(head, /#qr--popout #uris_launcher/, 'нет id-скоупа для попоаута');
    assert.doesNotMatch(css.slice(css.indexOf('#uris_launcher,'), css.indexOf('}', css.indexOf('#uris_launcher,'))), /!important/, 'проект предпочитает специфичность !important');
});

test('лаунчеры расширения одного размера: бар и FAB совпадают', () => {
    const bar = ruleBodyFor('#uris_launcher {');
    const fab = ruleBodyFor('.uris_fab {');
    const size = source => {
        const w = source.match(/width\s*:\s*(\d+)px/);
        const h = source.match(/height\s*:\s*(\d+)px/);
        return w && h ? { w: Number(w[1]), h: Number(h[1]) } : null;
    };
    const barSize = size(bar);
    const fabSize = size(fab);
    assert.ok(barSize && fabSize, 'у обеих кнопок размер должен быть задан в px');
    assert.deepEqual(barSize, fabSize, 'кнопка в баре и плавающая кнопка должны быть одного размера');
    assert.equal(barSize.w, barSize.h, 'лаунчер обязан быть квадратным');
});

test('активное состояние лаунчера по-прежнему подсвечивается акцентом', () => {
    const body = ruleBodyFor('#uris_launcher.uris_launcher_active');
    assert.match(body, /background\s*:\s*var\(--uris-accent\)/);
});
