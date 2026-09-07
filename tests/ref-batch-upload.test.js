// @ts-check
// Tests for src/ui/ref-batch-upload.js: pure helpers + dialog flow
// (review/rename → sequential ingest with per-item status isolation).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

// ── ST context stubs (same shape as tab-references.test.js) ──
const memoryStore = new Map();
function makeLocalforage() {
    return {
        async getItem(key) { return memoryStore.has(key) ? memoryStore.get(key) : []; },
        async setItem(key, value) { memoryStore.set(key, value); },
        async removeItem(key) { memoryStore.delete(key); },
    };
}
let _chatMetadata = {};
globalThis.SillyTavern = {
    getContext: () => ({
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        saveMetadata: () => {},
        getRequestHeaders: () => ({}),
        get chatMetadata() { return _chatMetadata; },
    }),
    libs: { localforage: makeLocalforage() },
};

let toastrCalls;
globalThis.toastr = undefined;

beforeEach(() => {
    memoryStore.clear();
    _chatMetadata = {};
    toastrCalls = [];
    globalThis.toastr = {
        success: (m) => toastrCalls.push(['success', m]),
        warning: (m) => toastrCalls.push(['warning', m]),
        error: (m) => toastrCalls.push(['error', m]),
        info: (m) => toastrCalls.push(['info', m]),
    };
});

const png = (name) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

async function loadModule() {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const mod = await import('../src/ui/ref-batch-upload.js');
    return { document, root, mod };
}

function makeDeps() {
    const created = [];
    const errors = [];
    return {
        created,
        errors,
        deps: {
            ingest: async (file, id) => ({ imagePath: `/user/images/URIS_Refs/${id}.png`, metadata: { mime: file.type } }),
            createRef: async (data) => { created.push(data); return { id: `ref_${created.length}`, ...data }; },
            recordUrisError: (e) => errors.push(e),
        },
    };
}

// ── Pure helpers ──

test('defaultNameFor: имя файла без расширения, фолбэк для пустых', async () => {
    const { mod } = await loadModule();
    assert.equal(mod.defaultNameFor(png('hero.png'), 0), 'hero');
    assert.equal(mod.defaultNameFor(png('a.b.c.webp'), 1), 'a.b.c');
    assert.equal(mod.defaultNameFor(png('.png'), 2), 'Референс 3');
    assert.equal(mod.defaultNameFor(png(''), 4), 'Референс 5');
});

test('uniqueNames: дедуп внутри партии (без учёта регистра), пустые → «Референс»', async () => {
    const { mod } = await loadModule();
    // Суффикс подбирается по ходу: дубликат получает первый свободный « (N)»,
    // даже если исходно-«b (2)» встретится позже — он тоже дедуплицируется.
    const items = [{ name: 'A' }, { name: 'a' }, { name: 'b' }, { name: '' }, { name: 'b' }, { name: 'b (2)' }];
    mod.uniqueNames(items);
    assert.deepEqual(items.map(i => i.name), ['A', 'a (2)', 'b', 'Референс', 'b (2)', 'b (2) (2)']);
});

test('applyNumbering: перенумеровывает только незагруженные, пустая база — no-op', async () => {
    const { mod } = await loadModule();
    const items = [
        { name: 'done', status: 'ok' },
        { name: 'x', status: 'pending' },
        { name: 'y', status: 'pending' },
        { name: 'failed', status: 'error' },
    ];
    mod.applyNumbering(items, 'Герой');
    assert.deepEqual(items.map(i => i.name), ['done', 'Герой 1', 'Герой 2', 'failed']);
    mod.applyNumbering(items, '   ');
    assert.equal(items[1].name, 'Герой 1', 'пустая база не меняет имена');
});

// ── Dialog flow ──

test('диалог: рендерит строки с именами из файлов, счётчик и кнопку с количеством', async () => {
    const { document, mod } = await loadModule();
    mod.openBatchUploadDialog({ files: [png('alpha.png'), png('beta.png')], deps: makeDeps().deps });
    assert.ok(document.querySelector('.uris-batch-overlay'), 'оверлей добавлен на body');
    const rows = document.querySelectorAll('.uris-batch-item');
    assert.equal(rows.length, 2);
    const names = [...document.querySelectorAll('.uris-batch-name')].map(i => i.value);
    assert.deepEqual(names, ['alpha', 'beta']);
    assert.equal(document.querySelector('#urisBatchCount').textContent, '2');
    assert.equal(document.querySelector('#urisBatchOk').textContent, 'Загрузить (2)');
});

test('диалог: «Пронумеровать» переименовывает строки по базовому имени', async () => {
    const { document, mod } = await loadModule();
    mod.openBatchUploadDialog({ files: [png('one.png'), png('two.png')], deps: makeDeps().deps });
    document.querySelector('#urisBatchBase').value = 'Герой';
    document.querySelector('#urisBatchNumber').click();
    const names = [...document.querySelectorAll('.uris-batch-name')].map(i => i.value);
    assert.deepEqual(names, ['Герой 1', 'Герой 2']);
});

test('диалог: удаление строки убирает файл из партии', async () => {
    const { document, mod } = await loadModule();
    mod.openBatchUploadDialog({ files: [png('one.png'), png('two.png')], deps: makeDeps().deps });
    document.querySelectorAll('.uris-batch-del')[0].click();
    assert.equal(document.querySelectorAll('.uris-batch-item').length, 1);
    assert.equal(document.querySelector('#urisBatchCount').textContent, '1');
    assert.equal(document.querySelector('#urisBatchOk').textContent, 'Загрузить (1)');
});

test('диалог: «Добавить ещё» докидывает файлы к партии', async () => {
    const { document, mod } = await loadModule();
    mod.openBatchUploadDialog({ files: [png('one.png')], deps: makeDeps().deps });
    const fileInput = document.querySelector('#urisBatchFile');
    fileInput.files = [png('one.png')]; // то же имя — должен получить суффикс
    fileInput.change();
    assert.equal(document.querySelectorAll('.uris-batch-item').length, 2);
    const names = [...document.querySelectorAll('.uris-batch-name')].map(i => i.value);
    assert.deepEqual(names, ['one', 'one (2)'], 'дубликат внутри партии получает суффикс');
});

test('загрузка: последовательная, с folderIds; успех закрывает по «Готово» и зовёт onFinish', async () => {
    const { document, mod } = await loadModule();
    const { deps, created } = makeDeps();
    let finished = 0;
    mod.openBatchUploadDialog({
        files: [png('alpha.png'), png('beta.png')],
        folderIds: ['folder1'],
        onFinish: () => { finished += 1; },
        deps,
    });
    await document.querySelector('#urisBatchOk').click();

    assert.equal(created.length, 2);
    assert.deepEqual(created.map(c => c.name), ['alpha', 'beta']);
    assert.ok(created.every(c => Array.isArray(c.folders) && c.folders.length === 1 && c.folders[0] === 'folder1'));
    assert.ok(created.every(c => typeof c.imagePath === 'string' && c.imagePath.includes('URIS_Refs')));

    const rows = document.querySelectorAll('.uris-batch-item');
    assert.deepEqual([...rows].map(r => r.classList.contains('uris-batch-ok')), [true, true]);
    assert.equal(document.querySelector('#urisBatchOk').textContent, 'Готово');
    assert.deepEqual(toastrCalls.filter(c => c[0] === 'success'), [['success', 'Загружено референсов: 2']]);

    // «Готово» закрывает диалог
    await document.querySelector('#urisBatchOk').click();
    assert.equal(finished, 1);
    assert.ok(!document.querySelector('.uris-batch-overlay'), 'диалог удалён из DOM');
});

test('загрузка: ошибка одного файла не роняет остальные (изоляция по строкам)', async () => {
    const { document, mod } = await loadModule();
    const { deps, created, errors } = makeDeps();
    const realCreate = deps.createRef;
    deps.createRef = async (data) => {
        if (data.name === 'bad') throw new Error('store exploded');
        return realCreate(data);
    };
    mod.openBatchUploadDialog({ files: [png('bad.png'), png('good.png')], deps });
    await document.querySelector('#urisBatchOk').click();

    assert.equal(created.length, 1, 'второй файл загружен несмотря на падение первого');
    assert.equal(created[0].name, 'good');
    const rows = document.querySelectorAll('.uris-batch-item');
    assert.ok(rows[0].classList.contains('uris-batch-error'), 'первая строка помечена ошибкой');
    assert.ok(rows[0].getAttribute('title').includes('store exploded'), 'текст ошибки виден в title строки');
    assert.ok(rows[1].classList.contains('uris-batch-ok'));
    assert.equal(errors.length, 1, 'ошибка записана в пул');
    assert.deepEqual(toastrCalls.filter(c => c[0] === 'warning'), [['warning', 'Загружено 1, с ошибками 1 — детали в строках и в ERR-панели']]);
});

test('загрузка: правка имени в строке попадает в createRef', async () => {
    const { document, mod } = await loadModule();
    const { deps, created } = makeDeps();
    mod.openBatchUploadDialog({ files: [png('screenshot 2026.png')], deps });
    const input = document.querySelector('.uris-batch-name');
    input.value = 'Произвольное имя';
    input.dispatchEvent({ type: 'input', target: input });
    await document.querySelector('#urisBatchOk').click();
    assert.equal(created[0].name, 'Произвольное имя');
});
