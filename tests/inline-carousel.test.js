// @ts-check
// Карусель поста (2026-11-13): чистые функции представления ручных items.
// DOM не трогается — render.js рисует view. Спека: docs/2026-11-13-inline-carousel-design.md §7.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectManualView, manualStatus, carouselLightboxItems, placementRef } from '../src/inline/carousel.js';
import { normalizeAnchorText } from '../src/inline/runner.js';

const item = (over = {}) => ({
    idx: -1, type: 'img', origin: 'story', status: 'ready',
    descHash: 'aa', digest: 'd1', imagePath: 'p.png', cardId: 'c1',
    cardIds: ['c1'], createdAt: 1, ...over,
});

test('collectManualView: обложка — последний ready, count, маркерные не попадают', () => {
    const view = collectManualView([
        item({ status: 'pending', createdAt: 5, imagePath: undefined, cardId: null }),
        { idx: 0, type: 'img', origin: 'marker', status: 'ready', descHash: 'm', imagePath: 'marker.png', createdAt: 0 },
        item({ imagePath: 'first.png', cardId: 'c1', cardIds: ['c1'], createdAt: 1 }),
        item({ imagePath: 'second.png', cardId: 'c2', cardIds: ['c1', 'c2'], createdAt: 2 }),
    ]);
    assert.equal(view.count, 3, 'версии: 1 + 2 cardIds двух itemов');
    assert.equal(view.cover.imagePath, 'second.png');
    assert.equal(view.pendings.length, 1);
    assert.equal(view.errors.length, 0);
    assert.equal(view.ready.length, 2);
});

test('collectManualView: счётчик версий — по cardIds, а не по числу items', () => {
    const view = collectManualView([
        item({ cardId: 'c1', cardIds: ['c1', 'c2', 'c3'], imagePath: 'p.png' }),
    ]);
    assert.equal(view.count, 3, 'один item с тремя карточками → ×3');
    assert.equal(view.cover.imagePath, 'p.png');
});

test('collectManualView: ready без файла → error (показывать нечего)', () => {
    const view = collectManualView([item({ imagePath: undefined, cardId: null, cardIds: [] })]);
    assert.equal(view.cover, null);
    assert.equal(view.errors.length, 1);
    assert.equal(view.count, 0);
});

test('manualStatus: матрица ready/mixed/pending/error/empty', () => {
    const ready = collectManualView([item()]);
    assert.equal(manualStatus(ready), 'ready');
    const mixed = collectManualView([item(), item({ status: 'pending', descHash: 'bb', createdAt: 9 })]);
    assert.equal(manualStatus(mixed), 'mixed');
    const pending = collectManualView([item({ status: 'pending' })]);
    assert.equal(manualStatus(pending), 'pending');
    const error = collectManualView([item({ status: 'error', error: 'boom' })]);
    assert.equal(manualStatus(error), 'error');
    assert.equal(manualStatus(collectManualView([])), 'empty');
});

test('carouselLightboxItems: встроенные cardIds раскрываются карточками, дубли исчезают', () => {
    const cards = new Map([
        ['c1', { id: 'c1', prompt: 'один', sourceMsgId: 3, imagePath: 'p.png' }],
        ['c2', { id: 'c2', prompt: 'два', sourceMsgId: 3, imagePath: 'q.png' }],
    ]);
    const slotItems = [item({ imagePath: 'second.png', cardId: 'c2', cardIds: ['c1', 'c2'] })];
    const out = carouselLightboxItems({ slotItems, cards });
    assert.deepEqual(out.map(i => i.id), ['c1', 'c2']);
    assert.equal(out[0].src, '/p.png', 'не-обложечная карточка авторитетна сама');
    assert.equal(out[1].src, '/second.png', 'обложка использует путь item\'а');
    assert.equal(out[0].prompt, 'один');
});

test('carouselLightboxItems: карточки нет в галерее → слайд по пути item\'а', () => {
    const slotItems = [item({ cardId: 'gone', cardIds: ['gone'], imagePath: 'only-item-path.png' })];
    const out = carouselLightboxItems({ slotItems, cards: new Map() });
    assert.equal(out.length, 1);
    assert.equal(out[0].src, '/only-item-path.png');
    assert.equal(out[0].id, 'gone');
});

test('carouselLightboxItems: все версии поста добавляются без дублей', () => {
    const cards = new Map([['c1', { id: 'c1', imagePath: 'p.png' }]]);
    const slotItems = [item()];
    const extra = [{ id: 'c1', imagePath: 'p.png' }, { id: 'c9', imagePath: 'z.png' }];
    const out = carouselLightboxItems({ slotItems, cards, allVersionsCards: extra });
    assert.deepEqual(out.map(i => i.id), ['c1', 'c9']);
});

test('placementRef: start/middle/end/context', () => {
    const blocks = [{ textContent: 'первый абзац' }, { textContent: 'второй длинный абзац' }, { textContent: 'третий абзац' }];
    assert.equal(placementRef(blocks, { position: 'start' }), blocks[0]);
    assert.equal(placementRef(blocks, { position: 'middle' }), blocks[1]);
    assert.equal(placementRef(blocks, { position: 'end' }), null);
    assert.equal(
        placementRef(blocks, { position: 'context', anchorText: 'третий абзац', normalizeAnchorText }),
        blocks[2],
    );
    // середина при <=2 блоках — в конец (нет осмысленной середины)
    assert.equal(placementRef(blocks.slice(0, 2), { position: 'middle' }), null);
    // context без якоря/без совпадения → null (fallback в конец)
    assert.equal(placementRef(blocks, { position: 'context', anchorText: '', normalizeAnchorText }), null);
    assert.equal(
        placementRef(blocks, { position: 'context', anchorText: 'совсем другая тема', normalizeAnchorText }),
        null,
    );
});
