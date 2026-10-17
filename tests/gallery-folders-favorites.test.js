// @ts-check
// Избранное + папки галереи (2026-10-16): favorite/folders на карточках,
// хранилище определений папок (uris_gallery_folders.json), порядок «избранные
// сверху», лента чипов режима «Папки» и фильтр по папке на fake-dom рендере.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';
import { makeUserFileServer } from './_helpers.js';

let originalFetch;
let originalSt;
const fileServer = makeUserFileServer();

// Три карточки одного чата: monolith-порядок старые→новые (индекс отдаёт
// новые сверху). card-fav помечена избранным прямо в файле.
const SEED_CARDS = [
    { id: 'card-old', imagePath: 'user/images/Test/one.png', prompt: 'старый', provenance: { chatId: 'test-chat' }, status: 'ready', createdAt: 1 },
    { id: 'card-mid', imagePath: 'user/images/Test/two.png', prompt: 'средний', provenance: { chatId: 'test-chat' }, status: 'ready', createdAt: 2 },
    { id: 'card-fav', imagePath: 'user/images/Test/three.png', prompt: 'новый', provenance: { chatId: 'test-chat' }, status: 'ready', createdAt: 3, favorite: true },
];

function seedGallery(serverFiles) {
    serverFiles.clear();
    serverFiles.set('uris_gallery.json', JSON.stringify({ v: 1, cards: SEED_CARDS.map(c => ({ ...c })) }));
}

function installContext() {
    // Один стабильный объект контекста: prefs вида (view/filter) пишутся в
    // extensionSettings и должны переживать следующий getContext().
    const shared = {
        chatId: 'test-chat',
        extensionSettings: { ur_image_studio: {} },
        saveSettingsDebounced: () => {},
        saveMetadata: () => {},
        getRequestHeaders: () => ({}),
    };
    globalThis.SillyTavern = { getContext: () => shared };
}

beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalSt = globalThis.SillyTavern;
    seedGallery(fileServer.serverFiles);
    installContext();
    globalThis.fetch = fileServer.fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.SillyTavern = originalSt;
});

async function freshStores() {
    const gi = await import('../src/gallery-index.js');
    const gf = await import('../src/gallery-folders.js');
    gi.resetGalleryStoreForTests();
    gf.resetGalleryFoldersStoreForTests();
    return { gi, gf };
}

async function freshGalleryTab() {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const mod = await import('../src/ui/tab-gallery.js');
    return { document, root, mod };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// ── Чистые хелперы раскладки ──

test('orderGalleryItems: избранные сверху, внутри групп прежний порядок', async () => {
    const { mod } = await freshGalleryTab();
    const ordered = mod.orderGalleryItems([
        { id: 'a' }, { id: 'b', favorite: true }, { id: 'c' }, { id: 'd', favorite: true },
    ]);
    assert.deepEqual(ordered.map(it => it.id), ['b', 'd', 'a', 'c']);
    assert.deepEqual(mod.orderGalleryItems([]), []);
    assert.deepEqual(mod.orderGalleryItems(null), []);
    // Вход не мутируется
    const src = [{ id: 'a' }, { id: 'b', favorite: true }];
    mod.orderGalleryItems(src);
    assert.deepEqual(src.map(it => it.id), ['a', 'b']);
});

test('filterGalleryByFolder: all / none / конкретная папка', async () => {
    const { mod } = await freshGalleryTab();
    const items = [
        { id: 'a', folders: ['x'] },
        { id: 'b' },
        { id: 'c', folders: ['x', 'y'] },
        { id: 'd', folders: [] },
    ];
    assert.equal(mod.filterGalleryByFolder(items, 'all').length, 4);
    assert.deepEqual(mod.filterGalleryByFolder(items, 'none').map(it => it.id), ['b', 'd']);
    assert.deepEqual(mod.filterGalleryByFolder(items, 'x').map(it => it.id), ['a', 'c']);
    assert.deepEqual(mod.filterGalleryByFolder(items, 'y').map(it => it.id), ['c']);
});

test('galleryFolderCounts: счётчики по папкам и «без папки»', async () => {
    const { mod } = await freshGalleryTab();
    const { byId, none } = mod.galleryFolderCounts([
        { id: 'a', folders: ['x'] },
        { id: 'b' },
        { id: 'c', folders: ['x', 'y'] },
    ]);
    assert.equal(byId.get('x'), 2);
    assert.equal(byId.get('y'), 1);
    assert.equal(none, 1);
});

// ── Карточки: favorite/folders проходят sanitize и пишутся на сервер ──

test('updateCard хранит favorite и folders; дефолт — false и пустой массив', async () => {
    const { gi } = await freshStores();
    await gi.updateCard('card-old', { favorite: true });
    await gi.updateCard('card-mid', { folders: ['f1', 'f2', 5, null] });
    const cards = await gi.listCards({ reconcile: false });
    assert.equal(cards.find(c => c.id === 'card-old').favorite, true);
    assert.deepEqual(cards.find(c => c.id === 'card-mid').folders, ['f1', 'f2'], 'не-строки отфильтрованы');
    assert.equal(cards.find(c => c.id === 'card-fav').favorite, true, 'favorite из файла переживает sanitize');
    assert.equal(cards.find(c => c.id === 'card-old').folders.length, 0, 'папки по умолчанию пустые');
    // Снятие избранного
    await gi.updateCard('card-old', { favorite: false });
    assert.equal((await gi.listCards({ reconcile: false })).find(c => c.id === 'card-old').favorite, false);
    await gi.flushGalleryWrites();
    const shards = [...fileServer.serverFiles.entries()].filter(([name]) => name.startsWith('uris_gallery_shard'));
    assert.ok(shards.some(([, text]) => text.includes('"favorite":true')), 'избранное записано в шард');
});

// ── Определения папок: CRUD + отстегивание id от карточек ──

test('gallery-folders: create/rename/delete; удаление отстёгивает папку от карточек', async () => {
    const { gi, gf } = await freshStores();
    assert.deepEqual(await gf.listGalleryFolders(), []);

    const folder = await gf.createGalleryFolder('Мемуары');
    assert.ok(folder?.id, 'папка создана в file-режиме');
    assert.equal(folder.name, 'Мемуары');
    assert.match(folder.color, /^#[0-9a-f]{6}$/i);
    assert.equal((await gf.createGalleryFolder('')).name, 'Папка', 'пустое имя → дефолт');

    await gi.updateCard('card-mid', { folders: [folder.id, 'other'] });

    const renamed = await gf.updateGalleryFolder(folder.id, { name: 'Архив' });
    assert.equal(renamed.name, 'Архив');
    assert.equal(await gf.updateGalleryFolder('nope', { name: 'X' }), null);

    await gf.flushGalleryFolderWrites();
    assert.ok(fileServer.serverFiles.has('uris_gallery_folders.json'), 'определения папок лежат в своём файле');

    await gf.deleteGalleryFolder(folder.id);
    await gi.flushGalleryWrites();
    const left = await gf.listGalleryFolders();
    assert.equal(left.length, 1, 'удалено только определение первой папки');
    assert.equal(left[0].name, 'Папка', 'вторая папка не тронута');
    const cards = await gi.listCards({ reconcile: false });
    assert.deepEqual(cards.find(c => c.id === 'card-mid').folders, ['other'], 'id папки отстёгнут от карточки, остальное на месте');
    assert.equal(await gf.deleteGalleryFolder(folder.id), false, 'повторное удаление — no-op');
});

// ── Рендер вкладки: звезда, порядок, переключатель, лента чипов ──

test('рендер: избранная карточка первая, со звездой и подсветкой; тумблер «Все/Папки» на месте', async () => {
    await freshStores();
    const { root, mod } = await freshGalleryTab();
    root.__urisTabId = 'gallery';
    await mod.render(root);

    const cards = [...root.querySelectorAll('.uris-card')];
    assert.equal(cards.length, 3);
    assert.equal(cards[0].dataset.id, 'card-fav', 'избранная карточка закреплена наверху');
    assert.ok(cards[0].querySelector('.uris-fav-badge'), 'звезда-бейдж на миниатюре');
    assert.ok(cards[0].classList.contains('uris-card-fav'), 'карточка подсвечена');
    const favBtn = cards[0].querySelector('[data-act="fav"]');
    assert.ok(favBtn, 'кнопка избранного на карточке');
    assert.match(favBtn.getAttribute('title'), /Убрать из избранного/);

    const viewBtns = [...root.querySelectorAll('.uris-viewswitch-btn')];
    assert.deepEqual(viewBtns.map(b => b.textContent.trim()), ['Все', 'Папки']);
    assert.equal(root.querySelector('#urisGalleryFolderbar'), null, 'в режиме «Все» ленты папок нет');
});

test('клик по звёздочке карточки переключает favorite и перерисовывает сетку', async () => {
    const { gi } = await freshStores();
    const { root, mod } = await freshGalleryTab();
    root.__urisTabId = 'gallery';
    await mod.render(root);

    // card-mid — вторая карточка; клик по её звёздочке поднимает её наверх.
    const midCard = [...root.querySelectorAll('.uris-card')].find(c => c.dataset.id === 'card-mid');
    midCard.querySelector('[data-act="fav"]').click();
    await settle();
    await settle();

    const stored = (await gi.listCards({ reconcile: false })).find(c => c.id === 'card-mid');
    assert.equal(stored.favorite, true, 'favorite сохранён в индексе');
    const first = root.querySelector('.uris-card');
    assert.equal(first.dataset.id, 'card-mid', 'карточка перерисована наверху ленты');
});

test('режим «Папки»: лента чипов, фильтр по папке, счётчики', async () => {
    const { gi, gf } = await freshStores();
    const { root, mod } = await freshGalleryTab();
    root.__urisTabId = 'gallery';

    const city = await gf.createGalleryFolder('Город');
    await gi.updateCard('card-mid', { folders: [city.id] });

    await mod.render(root);
    root.querySelector('[data-view="folders"]').click();
    await settle();
    await settle();

    const bar = root.querySelector('#urisGalleryFolderbar');
    assert.ok(bar, 'лента папок появилась');
    // fake-dom не понимает селекторы атрибутов — фильтруем по dataset вручную.
    const chips = [...bar.querySelectorAll('.uris-gf-chip')].filter(c => c.dataset.gfolder);
    assert.deepEqual(chips.map(c => c.dataset.gfolder), ['all', 'none', city.id]);
    const counts = chips.map(c => c.querySelector('.uris-gf-count').textContent);
    assert.deepEqual(counts, ['3', '2', '1'], 'Все=3, без папки=2, в «Городе»=1');

    // Фильтр по папке: остаётся одна карточка, счётчик тулбара согласован.
    chips.find(c => c.dataset.gfolder === city.id).click();
    await settle();
    await settle();
    const visible = [...root.querySelectorAll('.uris-card')];
    assert.deepEqual(visible.map(c => c.dataset.id), ['card-mid']);
    assert.equal(root.querySelector('#urisGalleryCount').textContent, '1');
    assert.match(root.querySelector('#urisGalleryCount').closest('.uris-gallery-toolbar').textContent, /1/);

    // «Без папки»: избранный card-fav и card-old, избранный — сверху.
    const noneChip = [...root.querySelectorAll('.uris-gf-chip')].filter(c => c.dataset.gfolder).find(c => c.dataset.gfolder === 'none');
    noneChip.click();
    await settle();
    await settle();
    assert.deepEqual([...root.querySelectorAll('.uris-card')].map(c => c.dataset.id), ['card-fav', 'card-old']);

    // Обратно в «Все»: лента исчезает, фильтр сброшен — видны все три.
    root.querySelector('[data-view="all"]').click();
    await settle();
    await settle();
    assert.equal(root.querySelector('#urisGalleryFolderbar'), null);
    assert.equal(root.querySelectorAll('.uris-card').length, 3);
});
