// @ts-check
// Действия кропа просмотрщика: обрезка галерейной картинки → НОВАЯ карточка
// (история не переписывается, provenance хранит источник), обрезка референса →
// новый файл + обновление записи. Отмена кропа ничего не меняет.
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

const CROP_BLOB = { fake: 'blob' };
const cropOk = async () => ({ blob: CROP_BLOB, width: 100, height: 100 });

function baseDeps() {
    const calls = { crop: [], upload: [], add: [], thumb: [] };
    return {
        calls,
        deps: {
            crop: async (opts) => { calls.crop.push(opts.source); return cropOk(); },
            dataUrl: async (blob) => { calls.dataUrl = blob; return 'data:image/png;base64,QQ=='; },
            upload: async (dataUrl, opts) => { calls.upload.push(opts); return 'user/images/Alice/crop.png'; },
            add: async (chatId, entry) => { calls.add.push([chatId, entry]); return { id: 'new-card' }; },
            thumb: async (imagePath, opts) => { calls.thumb.push([imagePath, opts]); return 'user/images/URIS_Thumbs/crop_thumb'; },
        },
    };
}

test('cropGalleryImage: обрезанная копия — новая карточка с источником и миниатюрой', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const { cropGalleryImage } = await import('../src/ui/gallery-actions.js');
    const { deps, calls } = baseDeps();

    const item = { id: 'card-1', src: 'user/images/Alice/full.png', prompt: 'portrait', style: 'cinematic', sourceMsgId: 7 };
    const created = await cropGalleryImage(item, 'chat-1', root, deps);

    assert.equal(created, true, 'просмотрщик можно закрывать');
    assert.equal(calls.crop[0], 'user/images/Alice/full.png', 'кроп идёт от полного файла');
    assert.equal(calls.upload[0].ch_name, 'UR Image Studio', 'кроп грузится в native-папку галереи, не в URIS_Refs');
    const [chatId, entry] = calls.add[0];
    assert.equal(chatId, 'chat-1');
    assert.equal(entry.imagePath, 'user/images/Alice/crop.png');
    assert.equal(entry.prompt, 'portrait', 'промпт наследуется');
    assert.equal(entry.provenance.croppedFrom, 'card-1', 'связь с оригиналом');
    assert.equal(entry.provenance.sourceMsgId, 7);
    assert.deepEqual(calls.thumb[0][0], 'user/images/Alice/crop.png', 'миниатюра для новой карточки');
    assert.deepEqual(toastrCalls.filter(c => c[0] === 'success'), [['success', 'Обрезанная копия добавлена в галерею']]);
});

test('cropGalleryImage: отмена кропа ничего не создаёт и не грузит', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const { cropGalleryImage } = await import('../src/ui/gallery-actions.js');
    const { deps, calls } = baseDeps();
    deps.crop = async () => null;

    const created = await cropGalleryImage({ id: 'card-1', src: 'p.png' }, 'chat-1', root, deps);

    assert.equal(created, false);
    assert.equal(calls.upload.length, 0);
    assert.equal(calls.add.length, 0);
});

test('cropReference: новый файл и обновление записи по id', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const { cropReference } = await import('../src/ui/gallery-actions.js');
    const updates = [];
    const deps = {
        crop: async () => cropOk(),
        ingest: async (blob, name) => ({ imagePath: 'user/images/URIS_Refs/ref_crop.png', metadata: { width: 100, height: 100 } }),
        update: async (id, patch) => { updates.push([id, patch]); return { id, ...patch }; },
    };

    const done = await cropReference({ __refId: 'ref-9', src: 'user/images/URIS_Refs/ref-9.png' }, deps);

    assert.equal(done, true);
    assert.deepEqual(updates, [['ref-9', { imagePath: 'user/images/URIS_Refs/ref_crop.png', width: 100, height: 100 }]]);
    assert.deepEqual(toastrCalls.filter(c => c[0] === 'success'), [['success', 'Референс обрезан']]);
});

test('cropReference: отмена кропа не трогает запись; без refId — отказ', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const { cropReference } = await import('../src/ui/gallery-actions.js');
    const updates = [];
    const deps = {
        crop: async () => null,
        ingest: async () => { throw new Error('не должен вызываться'); },
        update: async (id, patch) => { updates.push([id, patch]); },
    };

    assert.equal(await cropReference({ __refId: 'ref-9', src: 'p.png' }, deps), false);
    assert.equal(await cropReference({ src: 'p.png' }, deps), false, 'без refId референс не определить');
    assert.deepEqual(updates, []);
});
