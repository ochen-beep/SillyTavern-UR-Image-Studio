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

let originalFetch;
let originalSt;
let listCalls;

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
    globalThis.fetch = async (url, options) => {
        if (String(url) === '/api/images/list') {
            listCalls.push(String(url));
            const body = JSON.parse(options.body);
            return { ok: true, json: async () => (body.folder === 'Test' ? ['one.png', 'two.png'] : []) };
        }
        return { ok: true, json: async () => ({}) };
    };
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
// по явной кнопке «Обновить». Иначе каждое открытие вкладки = F+1 POST
// /api/images/list (скан всех папок).
test('рендер галереи не сканирует сервер; скан только по кнопке «Обновить»', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const mod = await import('../src/ui/tab-gallery.js');

    root.__urisTabId = 'gallery';
    await mod.render(root);
    assert.equal(root.querySelectorAll('.uris-card').length, 2, 'карточки приходят из индекса без скана');
    assert.deepEqual(listCalls, [], 'рендер не должен вызывать /api/images/list');

    root.querySelector('#urisGalleryRefresh').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(listCalls.length >= 1, 'кнопка «Обновить» запускает reconcile-скан');
});

// Подпись модели на миниатюре: карточка с modelId рендерит .uris-model-badge,
// карточка без модели (legacy / reconcile чужих файлов) — не рендерит ничего.
test('миниатюра показывает модель генерации, только если она известна', async () => {
    const { resetGalleryStoreForTests } = await import('../src/gallery-index.js');
    resetGalleryStoreForTests();
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    globalThis.SillyTavern = {
        getContext: () => ({
            chatId: 'test-chat',
            extensionSettings: {
                ur_image_studio: {
                    imageConnections: {
                        schemaVersion: 1,
                        galleryIndex: [
                            { id: 'm-1', imagePath: 'user/images/Test/m1.png', prompt: 'с моделью', modelId: 'gemini-2.5-flash-image', provenance: { chatId: 'test-chat' }, status: 'ready', createdAt: 1 },
                            { id: 'm-2', imagePath: 'user/images/Test/m2.png', prompt: 'без модели', provenance: { chatId: 'test-chat' }, status: 'ready', createdAt: 2 },
                        ],
                    },
                },
            },
            saveSettingsDebounced: () => {},
            saveMetadata: () => {},
            getRequestHeaders: () => ({}),
        }),
    };
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
