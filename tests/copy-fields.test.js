// @ts-check
// Тексты для копирования: textFieldsFor собирает поля сущности в порядке меню,
// copyItemText при одном поле копирует сразу, при нескольких — показывает меню
// (могло копировать только имя — поле, случайно попадавшее в prompt).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

let toastrCalls;
globalThis.toastr = undefined;
beforeEach(() => {
    toastrCalls = [];
    globalThis.toastr = {
        success: (m) => toastrCalls.push(['success', m]),
        error: (m) => toastrCalls.push(['error', m]),
        info: (m) => toastrCalls.push(['info', m]),
    };
});

test('textFieldsFor: карточка галереи — промпт/негатив/стиль, пустое не попадает', async () => {
    const { textFieldsFor } = await import('../src/ui/gallery-actions.js');
    const fields = textFieldsFor({
        prompt: 'a portrait of Aria',
        negativePrompt: 'blurry',
        style: '90s cinematic',
        description: '',
    });
    assert.deepEqual(fields.map(f => f.label), ['Промпт', 'Негативный промпт', 'Стиль']);
});

test('textFieldsFor: референс — описание/aliases/имя, aliases через запятую', async () => {
    const { textFieldsFor } = await import('../src/ui/gallery-actions.js');
    const fields = textFieldsFor({
        name: 'Мейсон',
        aliases: ['Мейсон', 'Mason'],
        description: 'высокий мужчина в очках',
    });
    assert.deepEqual(fields.map(f => f.label), ['Описание', 'Aliases', 'Имя']);
    assert.equal(fields[1].text, 'Мейсон, Mason');
    assert.deepEqual(textFieldsFor({ name: '' }), []);
});

test('copyItemText: одно поле — мгновенное копирование без меню', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const { copyItemText } = await import('../src/ui/gallery-actions.js');
    const written = [];
    await copyItemText({ prompt: 'only prompt' }, { write: async (t) => { written.push(t); } });
    assert.deepEqual(written, ['only prompt']);
    assert.equal(document.querySelector('.uris-copy-menu'), null, 'меню не открывается');
    assert.deepEqual(toastrCalls.filter(c => c[0] === 'success'), [['success', 'Скопировано: Промпт']]);
});

test('copyItemText: несколько полей — меню, клик по полю копирует его', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const { copyItemText } = await import('../src/ui/gallery-actions.js');
    const written = [];
    const done = copyItemText({
        name: 'Мейсон',
        aliases: ['Мейсон', 'Mason'],
        description: 'высокий мужчина',
    }, { write: async (t) => { written.push(t); } });

    const menu = document.querySelector('.uris-copy-menu');
    assert.ok(menu, 'меню открыто');
    const labels = [...document.querySelectorAll('.uris-copy-field-label')].map(e => e.textContent);
    assert.deepEqual(labels, ['Описание', 'Aliases', 'Имя']);

    document.querySelectorAll('.uris-copy-field')[1].click();
    await done;
    assert.deepEqual(written, ['Мейсон, Mason']);
    assert.equal(document.querySelector('.uris-copy-menu'), null, 'меню закрыто после выбора');
});

test('copyItemText: пустой текст — info вместо меню', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const { copyItemText } = await import('../src/ui/gallery-actions.js');
    await copyItemText({}, { write: async () => {} });
    assert.equal(document.querySelector('.uris-copy-menu'), null);
    assert.deepEqual(toastrCalls.filter(c => c[0] === 'info'), [['info', 'Нет текста для копирования']]);
});
