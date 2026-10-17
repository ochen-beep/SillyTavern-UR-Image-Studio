// @ts-check
// Регрессия v0.8.0: клик по картинке карточки молча падал с
// «ReferenceError: root is not defined» (параметр bindCards переименовали в
// scopeEl, а обработчики продолжали ссылаться на root) — просмотр не
// открывался ни на мобильном, ни на десктопе. Тест прогоняет реальный рендер
// галереи на fake-dom и кликает по картинке: showLightbox должен вызваться,
// причём с корнем вкладки (root), а не с контейнером сетки.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';
import { makeUserFileServer } from './_helpers.js';

let originalFetch;
let originalSt;
let listCalls;
const fileServer = makeUserFileServer({
    fallback(u, options) {
        if (u === '/api/images/list') {
            listCalls.push(u);
            const body = JSON.parse(options.body);
            return { ok: true, json: async () => (body.folder === 'Test' ? ['one.png', 'two.png'] : []) };
        }
        return { ok: true, json: async () => ({}) };
    },
});
const serverFiles = fileServer.serverFiles;

beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalSt = globalThis.SillyTavern;
    listCalls = [];
    globalThis.SillyTavern = {
        getContext: () => ({
            chatId: 'test-chat',
            extensionSettings: {
                ur_image_studio: {
                    imageConnections: {
                        schemaVersion: 1,
                        galleryIndex: [
                            { id: 'card-1', imagePath: 'user/images/Test/one.png', prompt: 'первый', provenance: { chatId: 'test-chat' }, status: 'ready', createdAt: 1 },
                            { id: 'card-2', imagePath: 'user/images/Test/two.png', prompt: 'второй', provenance: { chatId: 'test-chat' }, status: 'ready', createdAt: 2 },
                        ],
                    },
                },
            },
            saveSettingsDebounced: () => {},
            saveMetadata: () => {},
            getRequestHeaders: () => ({}),
        }),
    };
    // A fresh server namespace per test: the gallery store is sharded now, so a
    // previous test's manifest + shards would otherwise win over the re-seeded
    // monolith below (the monolith is only the migration source).
    serverFiles.clear();
    serverFiles.set('uris_gallery.json', JSON.stringify({ v: 1, cards: [
        { id: 'card-1', imagePath: 'user/images/Test/one.png', prompt: 'первый', provenance: { chatId: 'test-chat' }, status: 'ready', createdAt: 1 },
        { id: 'card-2', imagePath: 'user/images/Test/two.png', prompt: 'второй', provenance: { chatId: 'test-chat' }, status: 'ready', createdAt: 2 },
    ] }));
    globalThis.fetch = fileServer.fetch;
    import('../src/gallery-index.js').then(m => m.resetGalleryStoreForTests());
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.SillyTavern = originalSt;
});

test('клик по картинке карточки открывает просмотрщик с корнем вкладки', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const mod = await import('../src/ui/tab-gallery.js');

    const calls = [];
    mod.setViewerForTests({ showLightbox: (...args) => calls.push(args) });

    root.__urisTabId = 'gallery';
    await mod.render(root);
    assert.equal(root.querySelectorAll('.uris-card').length, 2, 'карточки отрендерены');

    root.querySelector('.uris-card-img').click();
    assert.equal(calls.length, 1, 'showLightbox вызван ровно один раз');
    const [items, index, opts] = calls[0];
    assert.equal(items.length, 2);
    assert.equal(items[0].src, 'user/images/Test/one.png');
    assert.equal(index, 0);
    assert.equal(opts.chatId, 'test-chat');
    assert.equal(opts.root, root, 'обработчик должен передавать КОРЕНЬ вкладки (refreshRoot и анимация от миниатюры ломаются иначе)');

    mod.resetViewerForTests();
});

// v0.9.4: рендер галереи больше не сканирует ФС сервера — reconcile только
// по явной кнопке. С v0.9.5 кнопка живёт в «Настройки → Данные и диагностика».
test('рендер галереи не сканирует сервер; скан — кнопка «Обновить галерею» в настройках', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const mod = await import('../src/ui/tab-gallery.js');

    root.__urisTabId = 'gallery';
    await mod.render(root);
    assert.equal(root.querySelectorAll('.uris-card').length, 2, 'карточки приходят из индекса без скана');
    assert.deepEqual(listCalls, [], 'рендер не должен вызывать /api/images/list');
    assert.equal(root.querySelector('#urisGalleryRefresh'), null, 'кнопки «Обновить» в тулбаре галереи больше нет');

    // Кнопка переехала на вкладку настроек — скан запускается оттуда.
    const { state } = await import('../src/core.js');
    if (!state.settings) state.settings = { uiScale: 1, fontScale: 1 };
    const settings = await import('../src/ui/tab-settings.js');
    const sroot = document.createElement('div');
    settings.render(sroot);
    sroot.querySelector('#urisTabGalleryRefresh').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(listCalls.length >= 1, 'кнопка «Обновить галерею» в настройках запускает reconcile-скан');
});

// Подпись модели на миниатюре: карточка с modelId рендерит .uris-model-badge,
// карточка без модели (legacy / reconcile чужих файлов) — не рендерит ничего.
test('миниатюра показывает модель генерации, только если она известна', async () => {
    // Fresh namespace again: the monolith re-seed below must be the migration
    // source, not be shadowed by the previous test's manifest + shards.
    serverFiles.clear();
    serverFiles.set('uris_gallery.json', JSON.stringify({ v: 1, cards: [
        { id: 'm-1', imagePath: 'user/images/Test/m1.png', prompt: 'с моделью', modelId: 'gemini-2.5-flash-image', provenance: { chatId: 'test-chat' }, status: 'ready', createdAt: 1 },
        { id: 'm-2', imagePath: 'user/images/Test/m2.png', prompt: 'без модели', provenance: { chatId: 'test-chat' }, status: 'ready', createdAt: 2 },
    ] }));
    const { resetGalleryStoreForTests } = await import('../src/gallery-index.js');
    resetGalleryStoreForTests();
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const mod = await import('../src/ui/tab-gallery.js');

    root.__urisTabId = 'gallery';
    await mod.render(root);
    assert.equal(root.querySelectorAll('.uris-card').length, 2, 'обе карточки отрендерены');

    const badges = root.querySelectorAll('.uris-model-badge');
    assert.equal(badges.length, 1, 'подпись только у карточки с известной моделью');
    assert.equal(badges[0].textContent, 'gemini-2.5-flash-image');
    assert.equal(badges[0].getAttribute('title'), 'Модель: gemini-2.5-flash-image', 'полное имя модели доступно в tooltip');
    // Клик по подписи открывает просмотр силами bubbling до кнопки .uris-card-img
    // (обработчик висит на ней). fake-dom не всплывает события к родителю,
    // поэтому кликовая регрессия здесь невоспроизводима — покрытие клика
    // остаётся в первом тесте (клик по самой кнопке).
});

// Мобильный проход 2026-10-03: долгий тап / ПКМ по плитке открывает карточное
// меню (card-action-menu.js); сами кнопочные строки на мобиле прячет CSS.
test('contextmenu по карточке открывает меню действий с пунктами карточки', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const mod = await import('../src/ui/tab-gallery.js');
    delete globalThis.matchMedia;   // мобильная презентация — не важно для ассертов

    root.__urisTabId = 'gallery';
    await mod.render(root);
    const card = root.querySelector('.uris-card');
    let pd = false;
    card.dispatchEvent({ type: 'contextmenu', clientX: 30, clientY: 40, preventDefault: () => { pd = true; } });

    const overlay = document.body.children.find(n => n.querySelector?.('.uris-action-menu'));
    assert.ok(overlay, 'меню открыто');
    // fake-dom не понимает составных селекторов — берём пункты и читаем текст целиком
    const labels = [...overlay.querySelectorAll('.uris-action-menu-item')].map(b => b.textContent.trim());
    assert.deepEqual(labels, ['В избранное', 'Регенерировать', 'Копировать промпт', 'Папки…', 'Сохранить как референс', 'Удалить…'],
        'без «К посту-источнику»: у тестовых карточек нет sourceMsgId');
    const del = overlay.querySelectorAll('.uris-action-menu-item').find(b => b.dataset.id === 'del');
    assert.ok(del.classList.contains('uris-action-menu-item-danger'), 'удаление помечено опасным');

    // Фоновый тап закрывает
    overlay.dispatchEvent({ type: 'click', target: overlay, preventDefault() {} });
    assert.equal(overlay.parentNode, null, 'меню закрылось');
});

test('galleryMenuItems: «К посту-источнику» появляется только при sourceMsgId', async () => {
    const { document, root } = makeFakeDocument();
    const mod = await import('../src/ui/tab-gallery.js');
    const without = mod.galleryMenuItems({ id: 'x' }, { chatId: 'c', root });
    const withMsg = mod.galleryMenuItems({ id: 'x', sourceMsgId: 7 }, { chatId: 'c', root });
    assert.equal(without.some(i => i.id === 'goto'), false);
    assert.equal(withMsg.some(i => i.id === 'goto'), true);
    // Избранное и папки — всегда в меню; подпись избранного зависит от состояния.
    assert.equal(without.some(i => i.id === 'fav'), true);
    assert.equal(without.some(i => i.id === 'folders'), true);
    assert.equal(without.find(i => i.id === 'fav').label, 'В избранное');
    assert.equal(mod.galleryMenuItems({ id: 'x', favorite: true }, { chatId: 'c', root }).find(i => i.id === 'fav').label,
        'Убрать из избранного');
    assert.equal(withMsg.at(-1).danger, true, 'удаление — последнее и опасное');
});
