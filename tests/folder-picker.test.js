// @ts-check
// Folder system at 50+ scale: чистые хелперы сортировки/фильтрации, folderPrefs,
// mergeFolders и DOM-поведение шита/поля (folder-picker.js) + сайдбарные кнопки.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeReferenceStore } from './_helpers.js';
import { makeFakeDocument } from './fake-dom.js';
import { resetRefStoreForTests, setRefStoreForTests } from '../src/refs-library.js';

// Стабильный контекст: folderPrefs живут в ctx.extensionSettings и обязаны
// переживать вызов getCtx() (в реальном приложении контекст один на сессию).
const _ctx = {
    extensionSettings: {},
    saveSettingsDebounced: () => {},
    saveMetadata: () => {},
    getRequestHeaders: () => ({}),
};
globalThis.SillyTavern = { getContext: () => _ctx };
globalThis.toastr = undefined;

beforeEach(() => {
    _ctx.extensionSettings = {};
    resetRefStoreForTests();
    setRefStoreForTests(makeReferenceStore());
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

test('filterFolders: substring, case-insensitive, trim; пустой запрос возвращает всё', async () => {
    const { filterFolders } = await import('../src/ui/folder-picker.js');
    const folders = [
        { id: 'a', name: 'Персонажи' },
        { id: 'b', name: 'Ростовые' },
        { id: 'c', name: 'Позы / Ростовые' },
    ];
    assert.deepEqual(filterFolders(folders, '  РОСТОВЫе ').map(f => f.id), ['b', 'c']);
    assert.deepEqual(filterFolders(folders, '').length, 3);
    assert.deepEqual(filterFolders(folders, 'нет такого'), []);
});

test('folderSheetRows: выбранное первым, canCreate только без точного совпадения', async () => {
    const { folderSheetRows } = await import('../src/ui/folder-picker.js');
    const folders = [
        { id: 'a', name: 'Alpha' },
        { id: 'b', name: 'Beta' },
        { id: 'c', name: 'Gamma' },
    ];
    let rows = folderSheetRows(folders, '', ['c']);
    assert.deepEqual(rows.chosen.map(f => f.id), ['c'], 'выбранное попадает в chosen');
    assert.deepEqual(rows.rest.map(f => f.id), ['a', 'b']);
    assert.equal(rows.canCreate, false, 'без запроса строка создания не показывается');

    rows = folderSheetRows(folders, 'alp', ['c']);
    assert.deepEqual(rows.chosen.map(f => f.id), []);
    assert.deepEqual(rows.rest.map(f => f.id), ['a'], 'поиск фильтрует обе группы');
    assert.equal(rows.canCreate, true, 'нет точного совпадения → можно создать');

    rows = folderSheetRows(folders, 'gamma', []);
    assert.equal(rows.canCreate, false, 'точное совпадение (без регистра) — создания нет');
});

test('orderSidebarFolders: избранное сначала (в порядке prefs), режимы name/count/manual', async () => {
    const { orderSidebarFolders } = await import('../src/ui/folder-picker.js');
    const folders = [
        { id: 'a', name: 'Charlie' },
        { id: 'b', name: 'alpha' },
        { id: 'c', name: 'bravo' },
        { id: 'd', name: 'delta' },
    ];
    const counts = new Map([['a', 5], ['b', 1], ['c', 9], ['d', 0]]);

    let out = orderSidebarFolders(folders, { pinnedIds: ['d', 'b'], sort: 'manual', countById: counts });
    assert.deepEqual(out.map(f => f.id), ['d', 'b', 'a', 'c'], 'избранное в порядке prefs, остальные — как были');

    out = orderSidebarFolders(folders, { pinnedIds: [], sort: 'name', countById: counts });
    assert.deepEqual(out.map(f => f.id), ['b', 'c', 'a', 'd'], 'по имени без регистра');

    out = orderSidebarFolders(folders, { pinnedIds: [], sort: 'count', countById: counts });
    assert.deepEqual(out.map(f => f.id), ['c', 'a', 'b', 'd'], 'по количеству убывание');

    out = orderSidebarFolders(folders, { pinnedIds: ['x'], sort: 'manual', countById: counts });
    assert.deepEqual(out.map(f => f.id), ['a', 'b', 'c', 'd'], 'неизвестный pin игнорируется');
});

test('nextFolderSortMode: цикл manual → name → count → manual', async () => {
    const { nextFolderSortMode } = await import('../src/ui/folder-picker.js');
    assert.equal(nextFolderSortMode('manual'), 'name');
    assert.equal(nextFolderSortMode('name'), 'count');
    assert.equal(nextFolderSortMode('count'), 'manual');
    assert.equal(nextFolderSortMode('мусор'), 'name', 'незнакомое значение трактуется как первый шаг');
});

// ── folderPrefs ───────────────────────────────────────────────────────────────

test('folderPrefs: roundtrip, нормализация мусора, кап избранного', async () => {
    const { getFolderPrefs, saveFolderPrefs, FOLDER_PREFS_MAX_PINNED } = await import('../src/refs-library.js');

    assert.deepEqual(getFolderPrefs(), { pinned: [], sort: 'manual', hideEmpty: false, collapsed: [] }, 'дефолты на пустых настройках');

    const many = Array.from({ length: FOLDER_PREFS_MAX_PINNED + 5 }, (_, i) => `f${i}`);
    saveFolderPrefs({ pinned: many, sort: 'чтопопало', hideEmpty: true });
    const saved = getFolderPrefs();
    assert.equal(saved.pinned.length, FOLDER_PREFS_MAX_PINNED, 'пины режутся до капа');
    assert.equal(saved.sort, 'manual', 'незнакомый sort откатывается в manual');
    assert.equal(saved.hideEmpty, true);

    saveFolderPrefs({ sort: 'count' });
    assert.equal(getFolderPrefs().sort, 'count', 'patch мержится, не затирая pinned');
    assert.equal(getFolderPrefs().pinned.length, FOLDER_PREFS_MAX_PINNED);
});

test('deleteFolder снимает папку с пина; mergeFolders переносит refs и удаляет источник', async () => {
    const { createFolder, createRef, deleteFolder, mergeFolders, listFolders, getRef, getFolderPrefs, saveFolderPrefs } = await import('../src/refs-library.js');

    const source = await createFolder('Старая');
    const target = await createFolder('Новая');
    const ref = await createRef({ name: 'R', imagePath: '/r.png', folders: [source.id] });
    const both = await createRef({ name: 'B', imagePath: '/b.png', folders: [source.id, target.id] });
    saveFolderPrefs({ pinned: [source.id] });

    const moved = await mergeFolders(source.id, target.id);
    assert.equal(moved, 2, 'оба референса затронуты');
    assert.deepEqual((await getRef(ref.id)).folders, [target.id], 'папка-источник заменена на цель');
    assert.deepEqual((await getRef(both.id)).folders, [target.id], 'дубликат id папки схлопывается');
    assert.equal((await listFolders()).some(f => f.id === source.id), false, 'источник удалён');
    assert.equal(getFolderPrefs().pinned.includes(source.id), false, 'пин источника снят');

    await mergeFolders(source.id, target.id); // повторный merge — no-op
    const targetFolder = (await listFolders()).find(f => f.id === target.id);
    assert.ok(targetFolder, 'повторный merge ничего не портит');

    const f3 = await createFolder('Третья');
    saveFolderPrefs({ pinned: [f3.id, target.id] });
    await deleteFolder(f3.id);
    assert.equal(getFolderPrefs().pinned.includes(f3.id), false, 'deleteFolder чистит prefs');
    assert.deepEqual((await getRef(ref.id)).folders, [target.id]);
});

// ── Sheet (DOM) ───────────────────────────────────────────────────────────────

test('folder sheet multi: клик переключает и сразу зовёт onToggle, «Готово» закрывает', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const { openFolderSheet } = await import('../src/ui/folder-picker.js');

    const folders = [
        { id: 'a', name: 'Alpha', color: '#4a90d9' },
        { id: 'b', name: 'Beta', color: '#c94040' },
    ];
    const toggles = [];
    let doneIds = null;
    let cancelled = false;
    const sheet = openFolderSheet({
        title: 'Папки референса',
        folders,
        selectedIds: ['b'],
        onToggle: (folder, isOn) => toggles.push([folder.id, isOn]),
        onDone: ids => { doneIds = ids; },
        onCancel: () => { cancelled = true; },
    });

    let rows = [...document.querySelectorAll('.uris-fs-row')].filter(row => row.dataset.folderId);
    assert.equal(rows.length, 2);
    const bRow = rows.find(row => row.dataset.folderId === 'b');
    assert.ok(bRow.classList.contains('uris-fs-row-on'), 'предвыбранная папка отмечена');

    await rows.find(row => row.dataset.folderId === 'a').click();
    assert.deepEqual(toggles, [['a', true]], 'клик по строке применяет выбор сразу');

    // повторный клик по a — снятие
    rows = [...document.querySelectorAll('.uris-fs-row')].filter(row => row.dataset.folderId);
    await rows.find(row => row.dataset.folderId === 'a').click();
    assert.deepEqual(toggles[1], ['a', false]);

    document.querySelector('.uris-folder-sheet-done').click();
    await sheet.result;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(doneIds, ['b'], '«Готово» передаёт выбранные ids');
    assert.equal(cancelled, false, 'подтверждение не вызывает onCancel');
    assert.equal(document.querySelector('.uris-folder-sheet'), null, '«Готово» закрывает шит');
});

test('folder sheet: поиск фильтрует строки не пересоздавая инпут; create-on-type создаёт и выбирает', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const { openFolderSheet } = await import('../src/ui/folder-picker.js');

    const folders = [{ id: 'a', name: 'Alpha', color: '#4a90d9' }];
    const toggles = [];
    openFolderSheet({
        folders,
        onToggle: (folder, isOn) => toggles.push([folder.id, isOn]),
        onCreate: async (name) => ({ id: 'new1', name, color: '#3ab09e' }),
    });

    const query = document.querySelector('.uris-folder-sheet-query');
    const inputBefore = query;
    query.value = 'альфа';
    await query.dispatchEvent({ type: 'input', target: query, currentTarget: query });

    assert.equal(document.querySelector('.uris-folder-sheet-query'), inputBefore, 'инпут поиска не пересоздаётся — каретка на месте');
    let rows = [...document.querySelectorAll('.uris-fs-row')].filter(row => row.dataset.folderId);
    assert.equal(rows.length, 0, 'совпадений нет');
    const createRow = document.querySelector('.uris-fs-create');
    assert.ok(createRow, 'появляется строка «Создать …»');

    await createRow.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(toggles, [['new1', true]], 'созданная папка сразу выбирается');

    // Точное совпадение после создания — строка создания исчезает.
    const rowsAfter = [...document.querySelectorAll('.uris-fs-row')].filter(row => row.dataset.folderId);
    assert.equal(rowsAfter.length, 1);
    assert.equal(document.querySelector('.uris-fs-create'), null);
});

// ── Field (DOM) ───────────────────────────────────────────────────────────────

test('folder field: чипы выбранных, × снимает с onChange, «+ Папка» открывает шит', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const { createFolderField } = await import('../src/ui/folder-picker.js');

    const folders = [
        { id: 'a', name: 'Alpha', color: '#4a90d9' },
        { id: 'b', name: 'Beta', color: '#c94040' },
    ];
    const changes = [];
    const field = createFolderField({
        folders,
        selected: ['a', 'b'],
        onChange: (ids) => changes.push(ids),
    });
    document.body.appendChild(field.el);

    let chips = [...field.el.querySelectorAll('.uris-fp-chip')];
    assert.equal(chips.length, 2, 'два чипа для двух выбранных папок');

    await field.el.querySelectorAll('.uris-fp-chip-x')[0].click();
    assert.deepEqual(changes, [['b']], '× убирает папку и коммитит остаток');

    field.el.querySelector('.uris-fp-add').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const sheetRow = [...document.querySelectorAll('.uris-fs-row')].filter(row => row.dataset.folderId)
        .find(row => row.dataset.folderId === 'a');
    await sheetRow.click();
    assert.deepEqual(changes[1], ['a', 'b'], 'выбор в шите коммитит полный список');

    field.sync(['b']);
    chips = [...field.el.querySelectorAll('.uris-fp-chip')];
    assert.equal(chips.length, 1, 'sync перерисовывает чипы (после внешнего updateRef)');
});

// ── Sidebar integration ───────────────────────────────────────────────────────

test('sidebar: поиск фильтрует папки не трогая инпут; пин, сортировка, скрытие пустых', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const { createFolder, createRef } = await import('../src/refs-library.js');

    const f1 = await createFolder('Персонажи');
    const f2 = await createFolder('Ростовые');
    const f3 = await createFolder('Позы');
    await createRef({ name: 'R', imagePath: '/r.png', folders: [f1.id] });
    await createRef({ name: 'R2', imagePath: '/r2.png', folders: [f2.id] });
    await createRef({ name: 'R3', imagePath: '/r3.png', folders: [f2.id] });

    const { render } = await import('../src/ui/tab-references.js');
    const el = document.createElement('div');
    el.__urisTabId = 'references';
    Object.defineProperty(el, 'clientWidth', { value: 600, configurable: true });
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    root.appendChild(el);
    await render(el);

    const customFolders = () => [...el.querySelectorAll('.uris-folder-item')]
        .filter(item => item.dataset.folder !== 'all' && item.dataset.folder !== 'none')
        .map(item => item.dataset.folder);

    // Пин f3 → секция «Избранное» сверху.
    await [...el.querySelectorAll('.uris-folder-pin')].find(btn => btn.dataset.folderId === f3.id).click();
    const section = el.querySelector('.uris-folder-section-label');
    assert.ok(section, 'секция «Избранное» появилась');
    assert.equal(section.textContent, 'Избранное');
    assert.deepEqual(customFolders(), [f3.id, f1.id, f2.id], 'папки: pinned первой, остальные как были');

    // Поиск: инпут не пересоздаётся, список фильтруется.
    const search = el.querySelector('.uris-folder-search-input');
    search.value = 'рост';
    await search.dispatchEvent({ type: 'input', target: search, currentTarget: search });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(el.querySelector('.uris-folder-search-input'), search, 'инпут на месте');
    const names = [...el.querySelectorAll('.uris-folder-item')].map(item => item.querySelector('.uris-folder-name').textContent);
    assert.deepEqual(names, ['Все карточки', 'Без папки', 'Ростовые'], 'поиск оставляет только совпавшую папку');

    search.value = 'ничего';
    await search.dispatchEvent({ type: 'input', target: search, currentTarget: search });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(el.querySelector('.uris-folder-empty'), 'пустой результат поиска подписан');

    // Сброс поиска; сортировка: клик 1 → по имени, клик 2 → по количеству.
    search.value = '';
    await search.dispatchEvent({ type: 'input', target: search, currentTarget: search });
    await new Promise(resolve => setTimeout(resolve, 0));
    await el.querySelector('#urisFolderSortBtn').click();
    assert.deepEqual(customFolders(), [f3.id, f1.id, f2.id], 'по имени: Персонажи < Ростовые');
    await el.querySelector('#urisFolderSortBtn').click();
    assert.deepEqual(customFolders(), [f3.id, f2.id, f1.id], 'по количеству: 2 > 1');

    // hideEmpty прячет только пустые (pinned f3 пуст — скрывается тоже).
    await el.querySelector('#urisFolderHideEmptyBtn').click();
    assert.deepEqual(customFolders(), [f2.id, f1.id], 'пустая папка скрыта, непустые на месте');
});
