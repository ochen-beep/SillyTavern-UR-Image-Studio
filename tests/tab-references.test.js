// @ts-check
// Tests for src/ui/tab-references.js render layout: sidebar + grid + overlay-host.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeReferenceStore } from './_helpers.js';
import { makeFakeDocument } from './fake-dom.js';
import { resetRefStoreForTests, setRefStoreForTests } from '../src/refs-library.js';

const memoryStore = new Map();

// Async render steps in tab-references bail when the root is not marked as the
// current references tab (setActiveTab writes __urisTabId in the real app).
function makeTabEl(document, clientWidth) {
    const el = document.createElement('div');
    el.__urisTabId = 'references';
    Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
    return el;
}

function makeLocalforage() {
    return {
        async getItem(key) { return memoryStore.has(key) ? memoryStore.get(key) : []; },
        async setItem(key, value) { memoryStore.set(key, value); },
        async removeItem(key) { memoryStore.delete(key); },
    };
}

let _chatMetadata = {};
// Стабильный контекст: folderPrefs (extensionSettings) должны переживать вызов
// getCtx(), как в реальном приложении.
const _ctx = {
    extensionSettings: {},
    saveSettingsDebounced: () => {},
    saveMetadata: () => {},
    getRequestHeaders: () => ({}),
    get chatMetadata() { return _chatMetadata; },
};
globalThis.SillyTavern = {
    getContext: () => _ctx,
    libs: { localforage: makeLocalforage() },
};
globalThis.toastr = undefined;
globalThis.FileReader = class FileReader {
    readAsDataURL(blob) {
        setTimeout(() => {
            this.result = 'data:image/png;base64,ZmFrZQ==';
            this.onloadend?.();
        }, 0);
    }
};

beforeEach(() => {
    memoryStore.clear();
    _chatMetadata = {};
    _ctx.extensionSettings = {};
    resetRefStoreForTests();
    setRefStoreForTests(makeReferenceStore());
});

test('render: renders sidebar + grid-wrap + overlay-host for desktop width', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;

    // Set clientWidth > 480 so it's desktop mode
    Object.defineProperty(root, 'clientWidth', { value: 600, configurable: true });

    const { render } = await import('../src/ui/tab-references.js');
    const el = makeTabEl(document, 600);
    root.appendChild(el);

    await render(el);

    assert.ok(el.querySelector('.uris-refs-sidebar'), 'sidebar present');
    assert.ok(el.querySelector('.uris-refs-grid-wrap'), 'grid wrapper present');
    assert.ok(el.querySelector('.uris-refs-overlay-host'), 'overlay host present');

    root.removeChild(el);
});

test('render: mobile width < 480 sets mobile class + renders mobile screen', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;

    const { render } = await import('../src/ui/tab-references.js');
    const el = makeTabEl(document, 380);
    root.appendChild(el);

    await render(el);

    assert.ok(el.classList.contains('uris-refs-mobile'), 'mobile class set');
    assert.ok(el.querySelector('.uris-mobile-screen'), 'mobile screen rendered');

    root.removeChild(el);
});

test('render: sidebar contains All, Without folder, and existing folders', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;

    const { createFolder } = await import('../src/refs-library.js');
    await createFolder('NPC');
    await createFolder('User');

    const { render } = await import('../src/ui/tab-references.js');
    const el = makeTabEl(document, 600);
    root.appendChild(el);

    await render(el);

    const items = [...el.querySelectorAll('.uris-folder-item')].map(n => n.dataset.folder);
    assert.ok(items.includes('all'), 'has "all" folder item');
    assert.ok(items.includes('none'), 'has "none" folder item');
    const custom = items.filter(f => f !== 'all' && f !== 'none');
    assert.equal(custom.length, 2, 'two custom folders');

    root.removeChild(el);
});

test('render: desktop custom folders have sibling filters and pencils while pseudo folders do not', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;

    const { createFolder } = await import('../src/refs-library.js');
    const folder = await createFolder('NPC');
    const { render } = await import('../src/ui/tab-references.js');
    const el = makeTabEl(document, 600);
    root.appendChild(el);

    await render(el);

    const filter = [...el.querySelectorAll('.uris-folder-item')].find(item => item.dataset.folder === folder.id);
    const pencil = [...el.querySelectorAll('.uris-folder-edit')].find(button => button.dataset.folderId === folder.id);
    assert.ok(filter, 'custom folder has a filter button');
    assert.ok(pencil, 'custom folder has an edit button');
    assert.equal(filter.parentNode, pencil.parentNode, 'filter and pencil are siblings');
    assert.equal(el.querySelectorAll('.uris-folder-edit').length, 1, 'pseudo folders have no pencils');

    root.removeChild(el);
});

test('folder editor applies name and color, then cancel leaves saved values', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;

    const { createFolder, listFolders, FOLDER_COLOR_PALETTE } = await import('../src/refs-library.js');
    const folder = await createFolder('NPC');
    const { render } = await import('../src/ui/tab-references.js');
    const el = makeTabEl(document, 600);
    root.appendChild(el);

    await render(el);
    await [...el.querySelectorAll('.uris-folder-edit')].find(button => button.dataset.folderId === folder.id)?.click();
    const name = el.querySelector('.uris-folder-editor-name');
    name.value = 'Characters';
    await [...el.querySelectorAll('.uris-folder-editor-swatch')].find(button => button.dataset.color === FOLDER_COLOR_PALETTE[1])?.click();
    await el.querySelector('.uris-folder-editor-apply')?.click();

    let saved = (await listFolders()).find(item => item.id === folder.id);
    assert.equal(saved.name, 'Characters');
    assert.equal(saved.color, FOLDER_COLOR_PALETTE[1]);

    await [...el.querySelectorAll('.uris-folder-edit')].find(button => button.dataset.folderId === folder.id)?.click();
    el.querySelector('.uris-folder-editor-name').value = 'Discarded';
    await el.querySelector('.uris-folder-editor-cancel')?.click();
    saved = (await listFolders()).find(item => item.id === folder.id);
    assert.equal(saved.name, 'Characters', 'cancel does not persist draft name');
    assert.equal(saved.color, FOLDER_COLOR_PALETTE[1], 'cancel does not persist draft color');

    root.removeChild(el);
});

test('folder editor deletion clears active filter and exposes its reference', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings: {}, saveSettingsDebounced: () => {}, saveMetadata: () => {},
        getRequestHeaders: () => ({}), chatMetadata: _chatMetadata,
        callGenericPopup: async () => true,
        POPUP_TYPE: { CONFIRM: 'confirm' },
    });

    const { createFolder, createRef } = await import('../src/refs-library.js');
    const folder = await createFolder('NPC');
    const ref = await createRef({ name: 'In NPC', imagePath: '/npc.png', folders: [folder.id] });
    const { render } = await import('../src/ui/tab-references.js');
    const el = makeTabEl(document, 600);
    root.appendChild(el);

    await render(el);
    await [...el.querySelectorAll('.uris-folder-item')].find(item => item.dataset.folder === folder.id)?.click();
    assert.equal(el.querySelectorAll('.uris-pool-tile').length, 1, 'custom filter shows its reference');
    await [...el.querySelectorAll('.uris-folder-edit')].find(button => button.dataset.folderId === folder.id)?.click();
    await el.querySelector('.uris-folder-editor-delete')?.click();

    assert.ok(el.querySelector('.uris-folder-item-on').dataset.folder === 'none', 'deleted active filter resets to none');
    assert.equal(el.querySelectorAll('.uris-pool-tile').length, 1, 'reference is exposed under without-folder');
    assert.equal(el.querySelector('.uris-pool-tile').dataset.refId, ref.id);

    root.removeChild(el);
});

test('render: mobile folders screen contains All, Without folder, and existing folders', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;

    const { createFolder } = await import('../src/refs-library.js');
    await createFolder('NPC');

    const { render } = await import('../src/ui/tab-references.js');
    const el = makeTabEl(document, 380);
    root.appendChild(el);

    await render(el);

    const items = [...el.querySelectorAll('.uris-mobile-folder-item')].map(n => n.dataset.folder);
    assert.ok(items.includes('all'), 'has "all" folder item');
    assert.ok(items.includes('none'), 'has "none" folder item (refs without folder must stay reachable on mobile)');
    const custom = items.filter(f => f !== 'all' && f !== 'none');
    assert.equal(custom.length, 1, 'one custom folder');

    root.removeChild(el);
});

test('showPoolPicker: strip shows all/none + «Все папки», full list lives in the search sheet', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    // Предыдущие тесты подменяют getContext на нестабильную версию; здесь нужен
    // стабильный контекст — saveFolderPrefs обязан дожить до рендера пикера.
    globalThis.SillyTavern = {
        getContext: () => _ctx,
        libs: { localforage: makeLocalforage() },
    };
    // Patch remove() for fake DOM nodes (needed by showPoolPicker overlay)
    const origCreateElement = document.createElement.bind(document);
    document.createElement = (tag) => {
        const node = origCreateElement(tag);
        node.remove = () => { if (node.parentNode) node.parentNode.removeChild(node); };
        return node;
    };

    const { createFolder, createRef, saveFolderPrefs } = await import('../src/refs-library.js');

    const f1 = await createFolder('One');
    const f2 = await createFolder('Two');
    const multiRef = await createRef({ name: 'Multi', imagePath: '/m.png', folders: [f1.id, f2.id] });
    await createRef({ name: 'Only1', imagePath: '/o.png', folders: [f1.id] });
    // Избранное попадает чипом в ленту, обычные папки — только через шит.
    saveFolderPrefs({ pinned: [f1.id] });

    const mod = await import('../src/ui/tab-references.js');
    const p = mod.showPoolPicker({ title: 'Test', multi: true });
    await new Promise(resolve => setTimeout(resolve, 10));

    // Лента: Все / Без папки / f1 (избранное) / «Все папки». f2 в ленте нет.
    const chips = [...document.querySelectorAll('.uris-folder-chip')].filter(c => c.dataset.folder);
    assert.ok(chips.find(c => c.dataset.folder === f1.id), 'favorite folder is a strip chip');
    assert.ok(!chips.find(c => c.dataset.folder === f2.id), 'non-favorite folder is not in the strip');

    // Выбор f2 через шит: «Все папки» → строка с поиском → клик по папке.
    document.querySelector('.uris-picker-more')?.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const sheetRows = [...document.querySelectorAll('.uris-fs-row')].filter(row => row.dataset.folderId);
    assert.ok(sheetRows.find(row => row.dataset.folderId === f2.id), 'sheet lists the non-favorite folder');
    await sheetRows.find(row => row.dataset.folderId === f2.id).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(document.querySelector('.uris-folder-sheet'), null, 'pick-one sheet closes on pick');

    // Фильтр применился: сетка отфильтрована.
    const tiles2 = [...document.querySelectorAll('.uris-pick-tile')].map(t => t.dataset.refId);
    assert.ok(tiles2.includes(multiRef.id), 'f2 filter shows the multi-folder card');
    assert.equal(tiles2.length, 1, 'f2 filter shows only the multi-folder card');

    // Чип f1 в ленте по-прежнему работает как фильтр.
    const f1Chip = [...document.querySelectorAll('.uris-folder-chip')].filter(c => c.dataset.folder).find(c => c.dataset.folder === f1.id);
    await f1Chip?.click();
    const tiles1 = [...document.querySelectorAll('.uris-pick-tile')].map(t => t.dataset.refId);
    assert.equal(tiles1.length, 2, 'f1 filter shows both cards (multi + only1)');

    document.querySelector('.uris-pick-cancel')?.click();
    const result = await p;
    assert.deepStrictEqual(result, [], 'cancelled picker returns empty array');
});

test('hidden resize callbacks do not coerce zero width into a render width', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/ui/tab-references.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /root\.clientWidth \|\| 600/);
    assert.match(source, /if \(w <= 0\) return;/);
});

test('render: desktop layout has sidebar, main, and overlay-host as row siblings', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;

    // Patch ResizeObserver to no-op so _setupResize does nothing in fake DOM
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };

    const { render } = await import('../src/ui/tab-references.js');
    const el = makeTabEl(document, 600);
    root.appendChild(el);

    await render(el);

    const refs = el.querySelector('.uris-references');
    assert.ok(refs, '.uris-references exists');
    // Row layout: sidebar, main, overlay-host are direct children
    const sidebar = refs.querySelector('.uris-refs-sidebar');
    const main = refs.querySelector('.uris-refs-main');
    const overlayHost = refs.querySelector('.uris-refs-overlay-host');
    assert.ok(sidebar, 'sidebar is inside .uris-references');
    assert.ok(main, 'main is inside .uris-references');
    assert.ok(overlayHost, 'overlay-host is inside .uris-references');
    // All three are direct children (not nested inside each other)
    assert.equal(sidebar.parentNode, refs, 'sidebar is direct child');
    assert.equal(main.parentNode, refs, 'main is direct child');
    assert.equal(overlayHost.parentNode, refs, 'overlay-host is direct child');

    root.removeChild(el);
});

test('editor: папки — чип + шит; выбор и снятие персистятся в референс', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    globalThis.SillyTavern = { getContext: () => _ctx, libs: { localforage: makeLocalforage() } };

    const { createFolder, createRef, getRef } = await import('../src/refs-library.js');
    const f1 = await createFolder('NPC');
    const f2 = await createFolder('Misc');
    const char = await createRef({ name: 'Char', imagePath: '/char.png', folders: [f1.id] });
    const { render } = await import('../src/ui/tab-references.js');
    const el = makeTabEl(document, 600);
    root.appendChild(el);
    await render(el);

    // _activeFolderFilter — модульное состояние: предыдущие тесты оставляют
    // фильтр «none». Явно возвращаем «Все карточки».
    await [...el.querySelectorAll('.uris-folder-item')].find(item => item.dataset.folder === 'all').click();
    await new Promise(resolve => setTimeout(resolve, 0));

    const tile = [...el.querySelectorAll('.uris-pool-tile')].find(t => t.dataset.refId === char.id);
    await tile.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    const host = el.querySelector('.uris-fp-host');
    assert.ok(host, 'в редакторе есть folder field');
    assert.equal([...host.querySelectorAll('.uris-fp-chip')].length, 1, 'выбранная папка показана чипом');
    assert.equal(el.querySelectorAll('.uris-multifolder-toggle').length, 0, 'стены тогглов больше нет');

    // «+ Папка» → шит → выбор второй папки → персист в референс.
    host.querySelector('.uris-fp-add').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const row = [...document.querySelectorAll('.uris-fs-row')].filter(r => r.dataset.folderId)
        .find(r => r.dataset.folderId === f2.id);
    await row.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual([...(await getRef(char.id)).folders].sort(), [f1.id, f2.id].sort(), 'выбор в шите сохранён');
    document.querySelector('.uris-folder-sheet-done')?.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    // × на чипе снимает папку (после ре-рендера редактора).
    const chipX = [...el.querySelectorAll('.uris-fp-chip-x')].find(x => x.dataset.folderId === f2.id);
    assert.ok(chipX, 'чип второй папки в перерисованном редакторе');
    await chipX.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(await (await getRef(char.id)).folders, [f1.id], '× снял папку');

    root.removeChild(el);
});

test('render: editor text fields autosave on change (desktop)', async () => {    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;

    const { createRef, getRef } = await import('../src/refs-library.js');
    const char = await createRef({ name: 'Char', imagePath: '/char.png' });
    const { render } = await import('../src/ui/tab-references.js');
    const el = makeTabEl(document, 600);
    root.appendChild(el);

    await render(el);
    const tiles = [...el.querySelectorAll('.uris-pool-tile')];
    assert.ok(tiles.find(tile => tile.dataset.refId === char.id), 'tile renders for the pool ref');

    await tiles.find(tile => tile.dataset.refId === char.id).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const previewWrap = el.querySelector('.uris-editor-preview-wrap');
    assert.ok(previewWrap, 'desktop editor groups preview and replace control');
    assert.ok(previewWrap.querySelector('.uris-editor-preview'), 'preview is inside wrapper');
    assert.ok(previewWrap.querySelector('.uris-ed-replace'), 'replace control is inside wrapper');
    // No explicit Save button: text fields persist on change (autosave model).
    assert.ok(!el.querySelector('.uris-ed-save'), 'no explicit save button');
    assert.ok(el.querySelector('.uris-ed-autosave'), 'desktop editor shows autosave indicator');
    const name = el.querySelector('.uris-ed-name');
    name.value = 'Saved Char';
    await name.change();
    assert.equal((await getRef(char.id)).name, 'Saved Char', 'change on a text field persists via the editor update path');

    root.removeChild(el);
});

test('render: full re-entry closes a stale editor overlay (state reset)', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;

    const { createRef } = await import('../src/refs-library.js');
    const char = await createRef({ name: 'Char', imagePath: '/char.png' });
    const { render } = await import('../src/ui/tab-references.js');
    const el = makeTabEl(document, 600);
    root.appendChild(el);

    await render(el);
    const tile = [...el.querySelectorAll('.uris-pool-tile')].find(t => t.dataset.refId === char.id);
    await tile.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(el.querySelector('.uris-refs-overlay-panel'), 'editor overlay opens on tile click');

    // Re-entering the tab (full render) must not inherit the stale editor session.
    await render(el);
    assert.equal(el.querySelector('.uris-refs-overlay-panel'), null, 'overlay is closed after re-entry');
    assert.ok(el.querySelector('.uris-pool-grid'), 'grid still renders');

    root.removeChild(el);
});

test('render: mobile grid searches names and aliases without changing stored references', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;

    const { createRef, listRefs } = await import('../src/refs-library.js');
    const char = await createRef({ name: 'Mira', aliases: ['Captain'], imagePath: '/mira.png' });
    const npc = await createRef({ name: 'Guard', aliases: ['Sentry'], imagePath: '/guard.png' });
    const { render } = await import('../src/ui/tab-references.js');
    const el = makeTabEl(document, 380);
    root.appendChild(el);

    await render(el);
    await [...el.querySelectorAll('.uris-mobile-folder-item')].find(item => item.dataset.folder === 'all').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const search = el.querySelector('.uris-mobile-search');
    assert.ok(search, 'mobile grid has its own search input');
    assert.equal(search.getAttribute('aria-label'), 'Поиск референсов');
    const tiles = [...el.querySelectorAll('.uris-pool-tile')];
    assert.ok(tiles.find(tile => tile.dataset.refId === char.id), 'char tile renders');
    assert.ok(tiles.find(tile => tile.dataset.refId === npc.id), 'npc tile renders');

    search.value = 'cApTaIn';
    await search.dispatchEvent({ type: 'input', target: search, currentTarget: search });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual([...el.querySelectorAll('.uris-pool-tile')].map(tile => tile.dataset.refId), [char.id], 'alias search is case-insensitive');
    assert.equal((await listRefs()).length, 2, 'search does not persist any reference changes');

    root.removeChild(el);
});

test('showPoolPicker: renders pool tiles and cancels', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const origCreateElement = document.createElement.bind(document);
    document.createElement = (tag) => {
        const node = origCreateElement(tag);
        node.remove = () => { if (node.parentNode) node.parentNode.removeChild(node); };
        return node;
    };

    const { createRef } = await import('../src/refs-library.js');
    const char = await createRef({ name: 'Char', imagePath: '/char.png' });
    const { showPoolPicker } = await import('../src/ui/tab-references.js');

    const promise = showPoolPicker({ title: 'Test' });
    await new Promise(resolve => setTimeout(resolve, 10));
    const tiles = [...document.querySelectorAll('.uris-pick-tile')];
    assert.ok(tiles.find(tile => tile.dataset.refId === char.id), 'picker renders a tile per pool ref');
    document.querySelector('.uris-pick-cancel').click();
    await promise;
});

test('render: mobile screen survives re-render (refresh no longer kicks back to folders)', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;

    const { render, __resetMobileNavForTests } = await import('../src/ui/tab-references.js');
    __resetMobileNavForTests();
    const el = makeTabEl(document, 380);
    root.appendChild(el);

    // First render — mobile folders screen
    await render(el);
    assert.ok(el.querySelector('.uris-mobile-screen'), 'mobile screen on first render');
    assert.ok(el.querySelector('.uris-mobile-add-folder'), 'add-folder button present');
    assert.ok(el.querySelector('.uris-mobile-add-ref'), 'add-ref button present');
    assert.ok(!el.querySelector('.uris-mobile-toolbar-title'), 'no toolbar title on folders screen');

    // Navigate to the grid screen through the app's own handler (folder click)
    await [...el.querySelectorAll('.uris-mobile-folder-item')].find(item => item.dataset.folder === 'all').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(el.querySelector('.uris-mobile-toolbar-title'), 'grid screen shows the toolbar title');
    const search = el.querySelector('.uris-mobile-search');
    search.value = 'anything';
    await search.dispatchEvent({ type: 'input', target: search, currentTarget: search });
    await new Promise(resolve => setTimeout(resolve, 0));

    // Re-render (simulates refreshActive after e.g. an image replace): the
    // user's screen must survive — the old unconditional reset kicked mobile
    // users back to the folder list on every background refresh.
    await render(el);
    assert.ok(el.querySelector('.uris-mobile-toolbar-title'), 'still on the grid screen after re-render');
    assert.equal(el.querySelector('.uris-mobile-search').value, '', 'search query still resets on refresh');

    root.removeChild(el);
});

test('editor: «Клонировать» создаёт копию поверх того же файла и открывает её в редакторе', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;

    const { createRef, listRefs } = await import('../src/refs-library.js');
    const char = await createRef({ name: 'Char', imagePath: 'user/images/Refs/char.png' });
    const { render } = await import('../src/ui/tab-references.js');
    const el = makeTabEl(document, 600);
    root.appendChild(el);

    await render(el);
    const tile = [...el.querySelectorAll('.uris-pool-tile')].find(t => t.dataset.refId === char.id);
    await tile.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(el.querySelector('.uris-ed-clone'), 'кнопка «Клонировать» есть в теле редактора');

    await el.querySelector('.uris-ed-clone').click();
    await new Promise(resolve => setTimeout(resolve, 0));

    const refs = await listRefs();
    assert.equal(refs.length, 2, 'клон добавляет одну запись пула');
    const clone = refs.find(r => r.id !== char.id);
    assert.equal(clone.imagePath, char.imagePath, 'клон делит файл картинки с оригиналом');
    assert.equal(clone.name, 'Char (копия)');

    assert.equal(el.querySelector('.uris-ed-name').value, 'Char (копия)',
        'редактор переключается на клона — можно сразу переименовать');

    root.removeChild(el);
});

test('editor: «Клонировать» на мобильной карточке открывает клона, не выкидывая на сетку', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;

    const { createRef, listRefs } = await import('../src/refs-library.js');
    const char = await createRef({ name: 'Моб', imagePath: 'user/images/Refs/mob.png' });
    const { render, __resetMobileNavForTests } = await import('../src/ui/tab-references.js');
    __resetMobileNavForTests();
    const el = makeTabEl(document, 380);
    root.appendChild(el);

    await render(el);
    await [...el.querySelectorAll('.uris-mobile-folder-item')].find(i => i.dataset.folder === 'all').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    await el.querySelector('.uris-pool-tile').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(el.querySelector('.uris-ed-clone'), 'кнопка «Клонировать» есть на мобильной карточке');

    await el.querySelector('.uris-ed-clone').click();
    await new Promise(resolve => setTimeout(resolve, 0));

    const refs = await listRefs();
    assert.equal(refs.length, 2, 'клон добавлен в пул');
    const clone = refs.find(r => r.id !== char.id);
    assert.equal(clone.name, 'Моб (копия)');
    assert.ok(el.querySelector('.uris-mobile-card-scroll'), 'остались на экране карточки');
    assert.equal(el.querySelector('.uris-ed-name').value, 'Моб (копия)',
        'мобильный редактор показывает клона');

    root.removeChild(el);
});

// ── Мобильный проход 2026-10-03: коллаж папок, переключатель из сетки, жест ──

// Модуль tab-references держит _mobileScreen между тестами (state персистит
// импорт), а ранние тесты подменяют getContext — стабилизируем обе вещи.
async function openMobileGrid(el) {
    globalThis.SillyTavern = { getContext: () => _ctx, libs: { localforage: makeLocalforage() } };
    let guard = 0;
    while (!el.querySelector('.uris-mobile-folder-item') && guard++ < 4) {
        await el.querySelector('.uris-mobile-back')?.click();
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    await [...el.querySelectorAll('.uris-mobile-folder-item')].find(i => i.dataset.folder === 'all').click();
    await new Promise(resolve => setTimeout(resolve, 0));
}

test('mobileFolderCollageHtml: до 4 миниатюр, пустые ячейки добиваются плейсхолдерами', async () => {
    const { mobileFolderCollageHtml } = await import('../src/ui/tab-references.js');
    const four = mobileFolderCollageHtml([
        { imagePath: '/a.png' }, { imagePath: '/b.png' },
        { imagePath: '/c.png' }, { imagePath: '/d.png' },
        { imagePath: '/e.png' },
    ]);
    assert.equal((four.match(/uris-mobile-folder-thumb(?!\s*")|uris-mobile-folder-thumb"/g) || []).length >= 4, true);
    assert.equal((four.match(/background-image/g) || []).length, 4, 'ровно четыре миниатюры даже при пяти референсах');
    assert.equal(four.includes('uris-mobile-folder-thumb-empty'), false, 'все ячейки заняты');

    const one = mobileFolderCollageHtml([{ imagePath: '/a.png' }]);
    assert.equal((one.match(/uris-mobile-folder-thumb-empty/g) || []).length, 3, 'одна занята, три плейсхолдера');

    const empty = mobileFolderCollageHtml([]);
    assert.equal((empty.match(/uris-mobile-folder-thumb-empty/g) || []).length, 4, 'пустая папка — весь коллаж-плейсхолдер');
});

test('mobile folders screen: строки папок несут коллаж, а не точки', async () => {
    console.log('=== START folders-collage test');
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const { createRef } = await import('../src/refs-library.js');
    await createRef({ name: 'A', imagePath: '/a.png' });
    await createRef({ name: 'B', imagePath: '/b.png' });
    globalThis.SillyTavern = { getContext: () => _ctx, libs: { localforage: makeLocalforage() } };
    const { render } = await import('../src/ui/tab-references.js');
    const el = makeTabEl(document, 380);
    root.appendChild(el);

    await render(el);
    let guard = 0;
    while (!el.querySelector('.uris-mobile-folder-item') && guard++ < 4) {
        await el.querySelector('.uris-mobile-back')?.click();
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    const collages = [...el.querySelectorAll('.uris-mobile-folder-collage')];
    assert.ok(collages.length >= 1, `коллаж в строках списка папок; cw: ${el.clientWidth}, children: [${el.children.map(c => c.className || c.tagName).join(' | ')}], screen: ${(el.querySelector('.uris-mobile-screen')?.innerHTML || el.innerHTML || '').slice(0, 200)}`);
    // fake-dom: только простые селекторы — класс + dataset-фильтр
    const allRow = [...el.querySelectorAll('.uris-mobile-folder-item')].find(n => n.dataset.folder === 'all');
    assert.equal(allRow.querySelectorAll('.uris-mobile-folder-thumb').length, 4, '2×2 = четыре ячейки');
    assert.equal(allRow.querySelectorAll('.uris-mobile-folder-thumb-empty').length, 2, 'две референса — два плейсхолдера');

    root.removeChild(el);
});

test('mobile grid: тап по имени папки открывает лист переключения, выбор меняет сетку', async t => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const { createRef, createFolder } = await import('../src/refs-library.js');
    await createRef({ name: 'Mira', imagePath: '/mira.png' });
    const folder = await createFolder('Пейзажи');
    await createRef({ name: 'Hill', imagePath: '/hill.png', folders: [folder.id] });
    const { render } = await import('../src/ui/tab-references.js');
    const el = makeTabEl(document, 380);
    root.appendChild(el);

    await render(el);
    await openMobileGrid(el);

    // Открыть лист переключения папки
    el.querySelector('.uris-mobile-folder-switch').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const sheet = document.body.children.find(n => n.querySelector?.('.uris-folder-sheet-list'));
    assert.ok(sheet, 'лист папок открыт');
    const rowNames = [...sheet.querySelectorAll('.uris-fs-row')].map(r => r.textContent);
    assert.ok(rowNames.some(n => n.includes('Все референсы · 2')), 'строка «Все» со счётчиком');
    assert.ok(rowNames.some(n => n.includes('Пейзажи · 1')), 'папка со счётчиком');

    // Выбор папки: лист закрылся, заголовок обновился, сетка отфильтровалась
    const target = [...sheet.querySelectorAll('.uris-fs-row')].find(r => r.textContent.includes('Пейзажи'));
    target.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(sheet.parentNode, null, 'лист закрыт после выбора');
    assert.match(el.querySelector('.uris-mobile-toolbar-title').textContent, /Пейзажи/);
    const tiles = [...el.querySelectorAll('.uris-pool-tile')].map(tile => tile.dataset.refId);
    assert.equal(tiles.length, 1, 'сетка отфильтрована по папке');
    t.mock.timers.reset();
});

test('mobile grid: долгий тап/ПКМ по плитке открывает меню Правка/Клонировать/Удалить', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const { createRef } = await import('../src/refs-library.js');
    await createRef({ name: 'Mira', imagePath: '/mira.png' });
    const { render } = await import('../src/ui/tab-references.js');
    const el = makeTabEl(document, 380);
    root.appendChild(el);

    await render(el);
    await openMobileGrid(el);
    const tile = el.querySelector('.uris-pool-tile');
    let pd = false;
    tile.dispatchEvent({ type: 'contextmenu', clientX: 5, clientY: 6, preventDefault: () => { pd = true; } });

    const overlay = document.body.children.find(n => n.querySelector?.('.uris-action-menu'));
    assert.ok(pd, 'нативное меню подавлено');
    assert.ok(overlay, 'меню открыто');
    const labels = [...overlay.querySelectorAll('.uris-action-menu-item')].map(b => b.textContent.trim());
    assert.deepEqual(labels, ['Правка', 'Клонировать', 'Удалить…']);
    root.removeChild(el);
});

test('mobile render after a desktop pass falls back to the folder list (no blank tab)', async () => {
    const { document, root } = makeFakeDocument();
    globalThis.document = document;
    globalThis.document.body = root;
    const { render } = await import('../src/ui/tab-references.js');
    const el = makeTabEl(document, 600);   // desktop pass: resize handler parks _mobileScreen = null
    root.appendChild(el);
    await render(el);

    Object.defineProperty(el, 'clientWidth', { value: 380, configurable: true });
    await render(el);                       // back to portrait: must NOT be a blank tab

    const screen = el.querySelector('.uris-mobile-screen');
    assert.ok(screen?.children.length, 'портрет после ландшафта рендерит экран, а не пустоту');
    // Список папок — в одном тапе от любого экрана (нормализация остаточного
    // состояния в _renderMobileAll не оставляет тупика без выхода).
    let guard = 0;
    while (!el.querySelector('.uris-mobile-folder-item') && guard++ < 4) {
        await el.querySelector('.uris-mobile-back')?.click();
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.ok(el.querySelectorAll('.uris-mobile-folder-item').length >= 1,
        'список папок достижим с любого экрана');
    root.removeChild(el);
});
