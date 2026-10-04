// @ts-check
// Дерево папок (v4.1, docs/2026-10-04-refs-folders-nesting-design.md):
// parentId в модели, кап глубины 2, lift подпапок при удалении, рекурсивные
// фильтры/раскрытие id для генерации, prefs.collapsed.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeReferenceStore } from './_helpers.js';
import {
    resetRefStoreForTests, setRefStoreForTests,
    normalizeFolder, folderMoveError,
    folderChildrenMap, folderChildFolders, folderHasChildren,
    folderDescendantIds, folderSubtreeIds,
    filterRefsByFolderTree, expandFolderIdsToSubtrees,
    createFolder, updateFolder, deleteFolder, listFolders,
    createRef, getFolderPrefs, saveFolderPrefs, normalizeFolderPrefs,
} from '../src/refs-library.js';

const _ctx = {
    extensionSettings: {},
    saveSettingsDebounced: () => {},
    saveMetadata: () => {},
    getRequestHeaders: () => ({}),
};
globalThis.SillyTavern = { getContext: () => _ctx };
globalThis.toastr = undefined;

let store;
beforeEach(() => {
    _ctx.extensionSettings = {};
    resetRefStoreForTests();
    store = makeReferenceStore();
    setRefStoreForTests(store);
});

const FOLDERS = [
    { id: 'faces', name: 'Лица', color: '#4a90d9' },
    { id: 'mimic', name: 'Мимика', color: '#c94090', parentId: 'faces' },
    { id: 'rada', name: 'Лицо Рады', color: '#4a90d9', parentId: 'faces' },
    { id: 'youth', name: 'Юность', color: '#c9a030' },
];

// ── normalizeFolder ──

test('normalizeFolder: parentId по умолчанию null, валидная строка сохраняется', () => {
    assert.equal(normalizeFolder({ id: 'a', name: 'A' }).parentId, null);
    assert.equal(normalizeFolder({ id: 'a', name: 'A', parentId: 'top' }).parentId, 'top');
    assert.equal(normalizeFolder({ id: 'a', name: 'A', parentId: 42 }).parentId, null);
    assert.equal(normalizeFolder({ id: 'a', name: 'A', parentId: '' }).parentId, null);
});

// ── folderMoveError (кап глубины) ──

test('folderMoveError: валидные и невалидные перемещения', () => {
    const folders = [
        { id: 'g1', name: 'Группа 1', parentId: null },
        { id: 'g2', name: 'Группа 2', parentId: null },
        { id: 'leaf', name: 'Лист', parentId: 'g1' },
        { id: 'top', name: 'Верхняя', parentId: null },
        { id: 'leaf2', name: 'Лист 2', parentId: 'g1' },
    ];
    // верхняя без детей → в другую группу ок
    assert.equal(folderMoveError(folders, folders[1], 'g1'), null);
    // верхний лист → в группу ок
    assert.equal(folderMoveError(folders, folders[3], 'g1'), null);
    // подпапка → в другую группу ок (глубина остаётся 2)
    assert.equal(folderMoveError(folders, folders[2], 'g2'), null);
    // верхняя → корень всегда ок
    assert.equal(folderMoveError(folders, folders[0], null), null);
    // сам в себя
    assert.match(folderMoveError(folders, folders[0], 'g1'), /в саму себя/i);
    // родитель — подпапка (получилась бы глубина 3)
    assert.match(folderMoveError(folders, folders[3], 'leaf'), /двумя уровнями/);
    // подпапка → в подпапку (родитель не верхнего уровня)
    assert.match(folderMoveError(folders, folders[4], 'leaf'), /двумя уровнями/);
    // группа с детьми → в другую группу
    assert.match(folderMoveError(folders, folders[0], 'g2'), /с подпапками/);
    // несуществующий родитель
    assert.match(folderMoveError(folders, folders[3], 'ghost'), /не найдена/);
});

// ── createFolder / updateFolder с parentId ──

test('createFolder: подпапка получает parentId; создание в подпапке запрещено', async () => {
    const group = await createFolder('Лица');
    const child = await createFolder('Мимика', { parentId: group.id });
    assert.equal(child.parentId, group.id);
    const sub = createFolder('Мимика-злость', { parentId: child.id });
    await assert.rejects(sub, /двумя уровнями/);
    await assert.rejects(createFolder('X', { parentId: 'ghost' }), /не найдена/);
});

test('updateFolder: перемещение листа/подпапки; незаконное бросает и не мутирует', async () => {
    const g1 = await createFolder('Лица');
    const g2 = await createFolder('Сцены');
    const leaf = await createFolder('Фон');
    const moved = await updateFolder(leaf.id, { parentId: g1.id });
    assert.equal(moved.parentId, g1.id);
    const lifted = await updateFolder(leaf.id, { parentId: null });
    assert.equal(lifted.parentId, null);
    // переименование не трогает parentId
    const renamed = await updateFolder(leaf.id, { name: 'Фон 2' });
    assert.equal(renamed.parentId, null);
    assert.equal(renamed.name, 'Фон 2');

    const group = await createFolder('Персонажи');
    const child = await createFolder('Мимика', { parentId: group.id });
    // подпапка переезжает в другую группу — законно (глубина остаётся 2)
    const movedChild = await updateFolder(child.id, { parentId: g2.id });
    assert.equal(movedChild.parentId, g2.id);
    // группа с детьми не может вложиться в другую группу
    await assert.rejects(updateFolder(g2.id, { parentId: group.id }), /с подпапками/);
    await assert.rejects(updateFolder(child.id, { parentId: 'нет' }), /не найдена/);
    const after = await listFolders();
    assert.equal(after.find(f => f.id === child.id).parentId, g2.id);
    assert.equal(after.find(f => f.id === g2.id).parentId, null);
});

// ── deleteFolder: lift детей ──

test('deleteFolder: подпапки поднимаются на верхний уровень, референсы детей не тронуты', async () => {
    const group = await createFolder('Лица');
    const child = await createFolder('Мимика', { parentId: group.id });
    const ref = await createRef({ name: 'Рада', imagePath: '/a.png', folders: [child.id, 'другая'] });
    await createRef({ name: 'Юни', imagePath: '/b.png', folders: [group.id] });

    saveFolderPrefs({ pinned: [group.id], collapsed: [group.id] });
    await deleteFolder(group.id);

    const folders = await listFolders();
    assert.equal(folders.some(f => f.id === group.id), false);
    const lifted = folders.find(f => f.id === child.id);
    assert.ok(lifted, 'подпапка не удаляется вместе с группой');
    assert.equal(lifted.parentId, null, 'подпапка поднята на верхний уровень');

    const prefs = getFolderPrefs();
    assert.equal(prefs.pinned.includes(group.id), false);
    assert.equal(prefs.collapsed.includes(group.id), false);

    // референс группы удалён из её folders, ссылка на ребёнка и чужая папка целы
    const pool = await (await import('../src/refs-library.js')).listRefs();
    const rada = pool.find(r => r.id === ref.id);
    assert.deepEqual(rada.folders, [child.id, 'другая']);
});

// ── чистые хелперы дерева ──

test('folderChildrenMap/ChildFolders/HasChildren: группировка по родителю', () => {
    const kids = folderChildrenMap(FOLDERS);
    assert.deepEqual(kids.get('').map(f => f.id), ['faces', 'youth']);
    assert.deepEqual(kids.get('faces').map(f => f.id), ['mimic', 'rada']);
    assert.deepEqual(folderChildFolders(FOLDERS, 'youth'), []);
    assert.equal(folderHasChildren(FOLDERS, 'faces'), true);
    assert.equal(folderHasChildren(FOLDERS, 'youth'), false);
});

test('folderSubtreeIds: потомки в порядке обхода; цикл не зависает', () => {
    assert.deepEqual(folderSubtreeIds(FOLDERS, 'faces'), ['faces', 'mimic', 'rada']);
    assert.deepEqual(folderSubtreeIds(FOLDERS, 'mimic'), ['mimic']);
    assert.deepEqual(folderSubtreeIds(FOLDERS, 'ghost'), ['ghost']);
    // цикл parentId: a → b → a
    const cyclic = [
        { id: 'a', name: 'A', parentId: 'b' },
        { id: 'b', name: 'B', parentId: 'a' },
    ];
    assert.deepEqual(folderDescendantIds(cyclic, 'a').length <= 1, true);
});

test('filterRefsByFolderTree: union поддерева без дублей, refs-порядок', () => {
    const refs = [
        { id: '1', folders: ['mimic'] },
        { id: '2', folders: ['faces'] },      // в группе напрямую
        { id: '3', folders: ['rada'] },
        { id: '4', folders: ['youth'] },      // мимо поддерева
        { id: '5', folders: ['mimic', 'youth'] },
    ];
    const out = filterRefsByFolderTree(refs, FOLDERS, 'faces');
    assert.deepEqual(out.map(r => r.id), ['1', '2', '3', '5']);
    assert.deepEqual(filterRefsByFolderTree(refs, FOLDERS, 'youth').map(r => r.id), ['4', '5']);
});

test('expandFolderIdsToSubtrees: раскрытие групп + дедупликация пересечений', () => {
    const out = expandFolderIdsToSubtrees(FOLDERS, ['faces', 'mimic', 'youth']);
    assert.deepEqual(out, ['faces', 'mimic', 'rada', 'youth']);
    assert.deepEqual(expandFolderIdsToSubtrees(FOLDERS, []), []);
    assert.deepEqual(expandFolderIdsToSubtrees(FOLDERS, ['ghost']), ['ghost']);
});

// ── prefs.collapsed ──

test('normalizeFolderPrefs: collapsed — уникальные id, переживает сохранение', () => {
    const prefs = normalizeFolderPrefs({ collapsed: ['a', 'a', 'b'], sort: 'name' });
    assert.deepEqual(prefs.collapsed, ['a', 'b']);
    saveFolderPrefs({ collapsed: ['g1'] });
    assert.deepEqual(getFolderPrefs().collapsed, ['g1']);
    assert.deepEqual(getFolderPrefs().pinned, []);
});
