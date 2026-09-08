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

beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalSt = globalThis.SillyTavern;
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
