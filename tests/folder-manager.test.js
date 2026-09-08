// @ts-check
// Менеджер папок: переименование/цвет на месте, merge (строчный и bulk),
// удаление, подтверждения через showConfirmModal (callGenericPopup-стаб).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeReferenceStore } from './_helpers.js';
import { makeFakeDocument } from './fake-dom.js';
import { resetRefStoreForTests, setRefStoreForTests } from '../src/refs-library.js';

// Управляемый результат confirm'ов: 1 = подтверждено, 0 = отмена.
let confirmResult = 1;
const _ctx = {
    extensionSettings: {},
    saveSettingsDebounced: () => {},
    saveMetadata: () => {},
    getRequestHeaders: () => ({}),
    callGenericPopup: async () => confirmResult,
    POPUP_TYPE: { CONFIRM: 'confirm' },
};
globalThis.SillyTavern = { getContext: () => _ctx };
globalThis.toastr = undefined;

beforeEach(() => {
    confirmResult = 1;
    _ctx.extensionSettings = {};
    resetRefStoreForTests();
    setRefStoreForTests(makeReferenceStore());
});

async function openManagerWithFolders() {
    const { createFolder, createRef } = await import('../src/refs-library.js');
    const f1 = await createFolder('Персонажи');
    const f2 = await createFolder('Ростовые');
    const f3 = await createFolder('Пустая');
    const r1 = await createRef({ name: 'R1', imagePath: '/r1.png', folders: [f1.id] });
    const r2 = await createRef({ name: 'R2', imagePath: '/r2.png', folders: [f1.id, f2.id] });

    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const { showFolderManager } = await import('../src/ui/folder-manager.js');
    const changes = [];
    showFolderManager({ onChanged: () => changes.push(1) });
    await new Promise(resolve => setTimeout(resolve, 0));

    const rows = () => [...document.querySelectorAll('.uris-fm-row')];
    const rowBy = (id) => rows().find(row => row.dataset.id === id);
    return { f1, f2, f3, r1, r2, rows, rowBy, changes };
}

test('менеджер: строки со счётчиками; переименование и цвет сохраняются сразу', async () => {
    const { f1, f2, f3, rowBy, changes } = await openManagerWithFolders();
    const { listFolders, FOLDER_COLOR_PALETTE } = await import('../src/refs-library.js');

    assert.equal(rowBy(f1.id).querySelector('.uris-fm-count').textContent, '2', 'счётчик f1 = 2 референса');
    assert.equal(rowBy(f2.id).querySelector('.uris-fm-count').textContent, '1');
    assert.equal(rowBy(f3.id).querySelector('.uris-fm-count').textContent, '0');

    // Переименование: change на инпуте → updateFolder.
    const nameInput = rowBy(f1.id).querySelector('.uris-fm-name');
    nameInput.value = 'Герои';
    await nameInput.change();
    assert.equal((await listFolders()).find(f => f.id === f1.id).name, 'Герои');
    assert.ok(changes.length >= 1, 'onChanged вызван после мутации');

    // Цвет: клик по свотчу циклит палитру.
    const swatch = rowBy(f2.id).querySelector('.uris-fm-swatch');
    const before = (await listFolders()).find(f => f.id === f2.id).color;
    await swatch.click();
    const after = (await listFolders()).find(f => f.id === f2.id).color;
    assert.equal(after, FOLDER_COLOR_PALETTE[(FOLDER_COLOR_PALETTE.indexOf(before) + 1) % FOLDER_COLOR_PALETTE.length]);
});

test('менеджер: строчный merge переносит референсы и удаляет источник', async () => {
    const { f1, f2, r1, r2, rowBy } = await openManagerWithFolders();
    const { listFolders, getRef } = await import('../src/refs-library.js');

    const mergeSelect = rowBy(f1.id).querySelector('.uris-fm-merge');
    mergeSelect.value = f2.id;
    await mergeSelect.change();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual((await getRef(r1.id)).folders, [f2.id], 'r1 переехал в цель');
    assert.deepEqual((await getRef(r2.id)).folders, [f2.id], 'дубликат цели схлопывается');
    const folders = await listFolders();
    assert.equal(folders.some(f => f.id === f1.id), false, 'источник удалён');
    assert.ok(folders.find(f => f.id === f2.id), 'цель на месте');
});

test('менеджер: отмена confirm не меняет ничего', async () => {
    const { f1, f2, r1, rowBy } = await openManagerWithFolders();
    const { listFolders, getRef } = await import('../src/refs-library.js');

    confirmResult = 0;
    const mergeSelect = rowBy(f1.id).querySelector('.uris-fm-merge');
    mergeSelect.value = f2.id;
    await mergeSelect.change();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.ok((await listFolders()).find(f => f.id === f1.id), 'источник на месте');
    assert.deepEqual((await getRef(r1.id)).folders, [f1.id], 'референс не тронут');
});

test('менеджер: bulk merge двух папок в третью', async () => {
    const { f1, f2, f3, r1, r2, rowBy } = await openManagerWithFolders();
    const { listFolders, getRef } = await import('../src/refs-library.js');

    const checkRow = async (folderId) => {
        const checkbox = rowBy(folderId).querySelector('.uris-fm-check');
        checkbox.checked = true;
        await checkbox.change();
    };
    await checkRow(f1.id);
    await checkRow(f3.id);
    const bulkbar = document.querySelector('.uris-fm-bulkbar');
    assert.equal(bulkbar.hidden, false, 'bulkbar показан при выборе');
    assert.equal(document.querySelector('.uris-fm-bulk-count').textContent, 'Выбрано: 2');

    // Цель — f2 (не в выборе → доступна в списке).
    const bulkTarget = document.querySelector('.uris-fm-bulk-target');
    const options = [...bulkTarget.querySelectorAll('option')].map(option => option.getAttribute('value'));
    assert.ok(options.includes(f2.id), 'цель вне выбора доступна');
    assert.ok(!options.includes(f1.id), 'выбранная папка не может быть целью');
    bulkTarget.value = f2.id;
    await bulkTarget.change();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual((await getRef(r1.id)).folders, [f2.id], 'r1 из f1 переехал в f2');
    assert.deepEqual((await getRef(r2.id)).folders, [f2.id]);
    const folders = await listFolders();
    assert.equal(folders.some(f => f.id === f1.id), false, 'f1 удалена');
    assert.equal(folders.some(f => f.id === f3.id), false, 'f3 удалена');
    assert.ok(folders.find(f => f.id === f2.id), 'цель осталась');
});

test('менеджер: bulk delete удаляет выбранные, референсы остаются без папок', async () => {
    const { f1, f3, r1, rowBy } = await openManagerWithFolders();
    const { listFolders, getRef } = await import('../src/refs-library.js');

    const checkRow = async (folderId) => {
        const checkbox = rowBy(folderId).querySelector('.uris-fm-check');
        checkbox.checked = true;
        await checkbox.change();
    };
    await checkRow(f1.id);
    await checkRow(f3.id);
    await document.querySelector('.uris-fm-bulk-del').click();
    await new Promise(resolve => setTimeout(resolve, 0));

    const folders = await listFolders();
    assert.equal(folders.some(f => f.id === f1.id), false);
    assert.equal(folders.some(f => f.id === f3.id), false);
    assert.deepEqual((await getRef(r1.id)).folders, [], 'референс остался, папки сняты');
});

test('менеджер: удаление строки с confirm; поиск фильтрует строки', async () => {
    const { f1, f2, f3, rowBy, rows } = await openManagerWithFolders();
    const { listFolders } = await import('../src/refs-library.js');

    // Поиск не пересоздаёт инпут.
    const query = document.querySelector('.uris-fm-query');
    query.value = 'рост';
    await query.dispatchEvent({ type: 'input', target: query, currentTarget: query });
    assert.equal(document.querySelector('.uris-fm-query'), query);
    assert.equal(rows().length, 1, 'осталась только «Ростовые»');

    query.value = '';
    await query.dispatchEvent({ type: 'input', target: query, currentTarget: query });

    await rowBy(f2.id).querySelector('.uris-fm-del').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const folders = await listFolders();
    assert.equal(folders.some(f => f.id === f2.id), false, 'папка удалена');
    assert.ok(folders.find(f => f.id === f1.id), 'остальные на месте');
});
