// @ts-check
// Контракт карточки шаблона в style.css: активный шаблон и кнопка-статус.
//
// Заливка активного шаблона (решение 2026-10-03): активная карточка оформлена
// как активный коннект во вкладке API — заливка, акцентная рамка и левый
// акцент-бар на всей карточке; кнопка-статус в шапке увеличена — она служит
// зоной активации, в том числе из свёрнутого состояния.
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

test('активный шаблон оформлен как активный коннект во вкладке API', () => {
    const body = ruleBody('.uris-template-instruction.uris-template-active');
    assert.match(body, /background:\s*var\(--uris-accent-soft\)/);
    assert.match(body, /border-color:\s*var\(--uris-accent-line\)/);
    assert.match(body, /box-shadow:\s*inset 3px 0 0 var\(--uris-accent\)/);
    // Прежнее правило с заливкой полосы шапки удалено.
    assert.equal(css.includes('.uris-template-instruction.uris-template-active .uris-preset-card-header {'), false,
        'отдельная заливка шапки больше не используется');
});

test('кнопка-статус — 20px: стандарт кликабельной зоны активации для карточек', () => {
    for (const selector of ['.uris-template-status', '.uris-server-status']) {
        const body = ruleBody(selector);
        assert.match(body, /width:\s*20px/, `${selector} width`);
        assert.match(body, /height:\s*20px/, `${selector} height`);
    }
});
