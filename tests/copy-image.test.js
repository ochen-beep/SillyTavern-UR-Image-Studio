// @ts-check
// Image-to-clipboard: PNG goes as-is, webp/jpeg are re-encoded via canvas,
// failures (fetch/clipboard) end in a toast + false. All external effects
// are injected via deps — no browser needed.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

let toasts;
beforeEach(() => {
    const fake = makeFakeDocument();
    globalThis.document = fake.document;
    globalThis.toastr = { success: (m) => toasts.push(['success', m]), error: (m) => toasts.push(['error', m]), info: (m) => toasts.push(['info', m]), warning: () => {} };
    toasts = [];
    // navigator в node только для чтения — подменяем перезаписываемым объектом
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
    globalThis.ClipboardItem = undefined;
});

const PNG_BLOB = { type: 'image/png' };
const WEBP_BLOB = { type: 'image/webp' };
const PNG_OUT = { type: 'image/png' };

function makeDeps({ blob = PNG_BLOB, ok = true, status = 200, clipboard } = {}) {
    return {
        fetch: async () => ({ ok, status, blob: async () => blob }),
        write: clipboard,
        ClipboardItem: class { constructor(assets) { this.assets = assets; } },
        createImageBitmap: async (b) => ({ width: 10, height: 20, blob: b }),
        canvas: () => ({
            width: 0, height: 0,
            getContext: () => ({ drawImage: () => {} }),
            toBlob: (resolve, type) => resolve(type === 'image/png' ? PNG_OUT : null),
        }),
    };
}

test('PNG копируется напрямую одним ClipboardItem', async () => {
    const { copyImageToClipboard } = await import('../src/ui/gallery-actions.js');
    const written = [];
    const ok = await copyImageToClipboard(
        { imagePath: 'user/images/Zagreus/a.png' },
        makeDeps({ clipboard: async (items) => { written.push(items); } }),
    );
    assert.equal(ok, true);
    assert.equal(written.length, 1);
    assert.equal(written[0][0].assets['image/png'], PNG_BLOB, 'PNG не перегоняется через canvas');
    assert.match(toasts.map(t => t[1]).join(' '), /скопирована/);
});

test('webp конвертируется в PNG перед записью', async () => {
    const { copyImageToClipboard } = await import('../src/ui/gallery-actions.js');
    const written = [];
    const ok = await copyImageToClipboard(
        { imagePath: 'a.webp' },
        makeDeps({ blob: WEBP_BLOB, clipboard: async (items) => { written.push(items); } }),
    );
    assert.equal(ok, true);
    assert.equal(written[0][0].assets['image/png'], PNG_OUT, 'в буфер ушёл перегнанный PNG');
});

test('путь без слэша получает префикс "/", ошибка fetch — тост и false', async () => {
    const { copyImageToClipboard } = await import('../src/ui/gallery-actions.js');
    let requested;
    const deps = makeDeps({ ok: false, status: 404 });
    deps.fetch = async (url) => { requested = url; return { ok: false, status: 404, blob: async () => PNG_BLOB }; };
    const ok = await copyImageToClipboard({ imagePath: 'user/images/x.png' }, deps);
    assert.equal(requested, '/user/images/x.png');
    assert.equal(ok, false);
    assert.match(toasts.map(t => t[1]).join(' '), /Не удалось скопировать картинку/);
});

test('нет Clipboard API — понятная ошибка', async () => {
    const { copyImageToClipboard } = await import('../src/ui/gallery-actions.js');
    const ok = await copyImageToClipboard({ imagePath: 'a.png' }, makeDeps({ clipboard: undefined }));
    assert.equal(ok, false);
});

test('карточка без файла — info-тост, без попытки записи', async () => {
    const { copyImageToClipboard } = await import('../src/ui/gallery-actions.js');
    let wrote = false;
    const deps = makeDeps({ clipboard: async () => { wrote = true; } });
    const ok = await copyImageToClipboard({}, deps);
    assert.equal(ok, false);
    assert.equal(wrote, false);
    assert.match(toasts.map(t => t[1]).join(' '), /нет файла/);
});
