// @ts-check
// Контракт «минимум движения» при prefers-reduced-motion: reduce.
//
// Регресс: под reduce гасились пульс и спиннеры pending-server, но продолжали
// крутиться .uris-fetch-models.loading i, .uris-server-probe.loading::before
// и прелоадер лайтбокса (pswp-clockwise) — WCAG 2.3.3 / техника C39 требуют
// единообразно гасить несущественную анимацию. Консолидированный блок стоит
// в КОНЦЕ style.css: правила-источники (uris-spin / pswp-clockwise) стоят
// выше, и при равной специфичности каскад без этой позиции отдал бы им
// animation обратно.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readAllStyles } from './_helpers.js';

const rawCss = readAllStyles();
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Пары [селектор в reduce-блоке, селектор правила-источника].
 * У pswp-прелоадера источник вендорский, без префикса .uris-pswp
 * (усиление специфичности нашего глушителя — сознательное).
 * 2026-10-06: записи pending-server удалены вместе с их мёртвыми классами
 * (ponytail #31) — UI «ожидание сервера» больше не существует.
 */
const SPINNERS = [
    ['.uris-fetch-models.loading i', '.uris-fetch-models.loading i'],
    ['.uris-server-probe.uris-server-loading::before', '.uris-server-probe.uris-server-loading::before'],
    ['.uris-server-probe.loading::before', '.uris-server-probe.loading::before'],
    ['.uris-pswp .pswp__preloader .pswp__icn', '.pswp__preloader .pswp__icn'],
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Последний @media (prefers-reduced-motion) блок в файле (консолидированный). */
function consolidatedReduceBlock() {
    const idx = css.lastIndexOf('@media (prefers-reduced-motion: reduce)');
    assert.notEqual(idx, -1, 'консолидированный reduce-блок не найден');
    const open = css.indexOf('{', idx);
    // media-блок содержит вложенные { } — ищем парную закрывающую скобку.
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') { depth -= 1; if (depth === 0) return { idx, body: css.slice(open + 1, i) }; }
    }
    assert.fail('reduce-блок не закрыт');
}

test('reduce-блок глушит КАЖДЫЙ спиннер расширения', () => {
    const { body } = consolidatedReduceBlock();
    for (const [reduceSelector] of SPINNERS) {
        assert.match(body, new RegExp(esc(reduceSelector)), `reduce-блок должен глушить ${reduceSelector}`);
    }
});

test('правила-источники живы: uris-spin у спиннеров, pswp-clockwise у прелоадера', () => {
    // Если источник исчез (правило переименовали/удалили), глушить становится
    // нечего — контракт обязан заалармовать вместе с источником.
    for (const [, sourceSelector] of SPINNERS) {
        const sourceIdx = css.indexOf(sourceSelector);
        assert.notEqual(sourceIdx, -1, `правило-источник ${sourceSelector} не найдено (переименовали?)`);
        const block = css.slice(sourceIdx, css.indexOf('}', sourceIdx));
        assert.match(block, /animation:\s*(uris-spin|pswp-clockwise)/, `${sourceSelector}: источник должен крутить спиннер`);
    }
});

test('reduce-блок стоит ПОСЛЕ всех правил-источников — каскад отдаёт ему animation', () => {
    const { idx } = consolidatedReduceBlock();
    for (const [, sourceSelector] of SPINNERS) {
        const sourceIdx = css.indexOf(sourceSelector);
        assert.ok(idx > sourceIdx, `reduce-блок должен идти после правила-источника ${sourceSelector} (равная специфичность — выигрывает позднее правило)`);
    }
});

test('uris_fab_dragging: бесполезный will-change: left, top удалён', () => {
    // will-change оптимизирует только композитные свойства; left/top —
    // layout-свойства, хинт лишь впустую выделяет слой. transform занят
    // пульсом uris-pulse, поэтому драг ведётся left/top — без хинта.
    const idx = css.indexOf('.uris_fab.uris_fab_dragging');
    assert.notEqual(idx, -1, 'правило uris_fab_dragging не найдено');
    const block = css.slice(idx, css.indexOf('}', idx));
    assert.doesNotMatch(block, /will-change/, 'will-change: left, top не работает — убрать');
});

test('uris-error-badge: смена opacity на hover анимируется в общей системе .12s', () => {
    const idx = css.indexOf('.uris-error-badge {');
    const block = css.slice(idx, css.indexOf('}', idx));
    assert.match(block, /transition:\s*opacity \.12s/);
});
