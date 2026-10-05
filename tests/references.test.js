// @ts-check
// Unit-тесты для утилит src/references.js, не требующих DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.SillyTavern = {
    getContext: () => ({
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
    }),
    libs: { localforage: { getItem: () => '', setItem: () => {}, removeItem: () => {} } },
};
globalThis.toastr = undefined;

globalThis.File ??= class File {
    /**
     * @param {BlobPart[]} parts
     * @param {string} name
     * @param {Object} [options]
     */
    constructor(parts, name, options = {}) {
        this.parts = parts;
        this.name = name;
        this.type = options.type || '';
    }
};

// FileReader нужен для imageToDataUrl (читает blob → data URL по MIME из blob.type).
globalThis.FileReader ??= class FileReader {
    readAsDataURL(blob) {
        setTimeout(() => {
            const mime = (blob && blob.type) || 'application/octet-stream';
            this.result = `data:${mime};base64,ZmFrZQ==`;
            this.onloadend?.();
        }, 0);
    }
};

import {
    dataUrlToBase64,
    dataUrlMimeType,
    dataUrlToBlob,
    dataUrlToFile,
    optimizeReferenceImage,
    normalizeReferenceDataUrl,
    __testOnly,
    MAX_EDGE,
    MAX_INPUT_BYTES,
    OPTIMIZATION_VERSION,
    uploadReferenceImage,
    imageToDataUrl,
    loadReferenceImage,
    summarizeReference,
} from '../src/references.js';
import { ingestReferenceImage } from '../src/references.js';

test('summarizeReference reports name, MIME and approximate KB for a data URL', () => {
    // 8 base64 chars = 6 decoded bytes.
    const ref = { id: 'r1', name: 'Aria', dataUrl: 'data:image/webp;base64,' + 'A'.repeat(8) };
    assert.deepEqual(summarizeReference(ref), { name: 'Aria', mime: 'image/webp', kb: 0 });
    // ~10 KB of base64 (10240*3/4 = 7680 bytes -> 8 KB). Use a larger block.
    const big = { name: 'Big', dataUrl: 'data:image/png;base64,' + 'A'.repeat(10240) };
    const s = summarizeReference(big);
    assert.equal(s.mime, 'image/png');
    assert.ok(s.kb >= 7 && s.kb <= 8, `expected ~7-8 KB, got ${s.kb}`);
});

test('summarizeReference flags missing or non-data URLs as invalid', () => {
    assert.deepEqual(summarizeReference({ name: 'X', dataUrl: 'user/images/a/b.png' }), { name: 'X', mime: 'invalid', kb: 0 });
    assert.deepEqual(summarizeReference({ id: 'r2' }), { name: 'r2', mime: 'invalid', kb: 0 });
    assert.deepEqual(summarizeReference(null), { name: '(unnamed)', mime: 'invalid', kb: 0 });
});

test('dataUrlToBase64 strips prefix', () => {
    assert.equal(dataUrlToBase64('data:image/png;base64,abc'), 'abc');
    assert.equal(dataUrlToBase64('abc'), 'abc');
    assert.equal(dataUrlToBase64(''), '');
});

test('dataUrlMimeType detects MIME types', () => {
    assert.equal(dataUrlMimeType('data:image/png;base64,abc'), 'image/png');
    assert.equal(dataUrlMimeType('data:image/jpeg;base64,abc'), 'image/jpeg');
    assert.equal(dataUrlMimeType('data:application/json;base64,abc'), 'application/json');
    assert.equal(dataUrlMimeType('not-a-data-url'), 'image/png');
});

test('dataUrlToBlob fetches data URL and returns blob', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    const fakeBlob = { type: 'image/png', size: 3 };
    globalThis.fetch = async (url) => {
        calls.push(url);
        return { blob: async () => fakeBlob };
    };
    try {
        const blob = await dataUrlToBlob('data:image/png;base64,abc');
        assert.equal(blob, fakeBlob);
        assert.equal(calls.length, 1);
        assert.equal(calls[0], 'data:image/png;base64,abc');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('dataUrlToFile returns File with correct name and type', async () => {
    const originalFetch = globalThis.fetch;
    const fakeBlob = new Blob(['abc'], { type: 'image/webp' });
    globalThis.fetch = async () => ({ blob: async () => fakeBlob });
    try {
        const file = await dataUrlToFile('data:image/webp;base64,abc', 'my file.webp');
        assert.ok(file instanceof File);
        assert.equal(file.name, 'my file.webp');
        assert.equal(file.type, 'image/webp');
        assert.equal(file.size, fakeBlob.size);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

function createOptimizerSeam({
    width = 1600,
    height = 800,
    alpha = false,
    encodings = {},
    sourceDecode = true,
} = {}) {
    const calls = [];
    return {
        calls,
        sourceBlob: new Blob(['source-image'], { type: 'image/png' }),
        async decode(blob) {
            if (blob._decodable === false) throw new Error('candidate is not decodable');
            return { width: blob._width ?? width, height: blob._height ?? height, close() {} };
        },
        createCanvas(canvasWidth, canvasHeight) {
            return {
                width: canvasWidth,
                height: canvasHeight,
                getContext() {
                    return {
                        drawImage() {},
                        getImageData() { return { data: alpha ? new Uint8ClampedArray([0, 0, 0, 0]) : new Uint8ClampedArray([0, 0, 0, 255]) }; },
                    };
                },
                toBlob(callback, mime, quality) {
                    calls.push([mime, quality]);
                    const candidate = encodings[mime];
                    if (!candidate) return callback(null);
                    const blob = new Blob([candidate.data ?? 'encoded'], { type: candidate.type ?? mime });
                    blob._width = candidate.width ?? canvasWidth;
                    blob._height = candidate.height ?? canvasHeight;
                    blob._decodable = candidate.decodable !== false;
                    callback(blob);
                },
            };
        },
        async blobToDataUrl(blob) { return `data:${blob.type};base64,ZmFrZQ==`; },
    };
}

test('optimizeReferenceImage returns canonical result without upscaling', async () => {
    const seam = createOptimizerSeam({
        width: 320,
        height: 240,
        encodings: { 'image/jpeg': { data: 'larger-than-source-jpeg' } },
    });
    const result = await optimizeReferenceImage(seam.sourceBlob, { _test: seam });
    assert.deepEqual(Object.keys(result).sort(), ['blob', 'dataUrl', 'height', 'mime', 'optimizationVersion', 'optimizedBytes', 'sourceBytes', 'width']);
    assert.equal(result.width, 320);
    assert.equal(result.height, 240);
    assert.equal(result.mime, 'image/png');
    assert.equal(result.blob, seam.sourceBlob);
    assert.equal(result.optimizedBytes, seam.sourceBlob.size);
    assert.equal(result.optimizationVersion, OPTIMIZATION_VERSION);
    assert.equal(MAX_EDGE, 1024);
});

test('optimizeReferenceImage enforces edge limit and rejects oversize or non-images', async () => {
    const seam = createOptimizerSeam({
        width: 2048,
        height: 1024,
        encodings: { 'image/jpeg': { data: 'jpeg' } },
    });
    const result = await optimizeReferenceImage(seam.sourceBlob, { _test: seam });
    assert.deepEqual([result.width, result.height], [1024, 512]);
    await assert.rejects(optimizeReferenceImage(new Blob(['not image'], { type: 'text/plain' }), { _test: seam }), /image input/);
    const tooLarge = new Blob([new Uint8Array(MAX_INPUT_BYTES + 1)], { type: 'image/png' });
    await assert.rejects(optimizeReferenceImage(tooLarge, { _test: seam }), /too large/);
});

test('optimizeReferenceImage: opaque reference encodes JPEG only — webp is not a candidate', async () => {
    const seam = createOptimizerSeam({
        encodings: {
            'image/webp': { data: 'tiny-webp', type: 'image/webp' },
            'image/jpeg': { data: 'valid-jpeg', type: 'image/jpeg' },
        },
    });
    const result = await optimizeReferenceImage(seam.sourceBlob, { _test: seam });
    assert.equal(result.mime, 'image/jpeg');
    // webp не кодируется вовсе: релейные апстримы (adobe2banana, инцидент
    // 2026-09-08) отвергают его контент-валидатором с 400 "does not match
    // its declared MIME type", хотя браузер кодирует webp корректно.
    assert.deepEqual(seam.calls, [['image/jpeg', 0.85]]);
});

test('optimizeReferenceImage: alpha reference encodes PNG only', async () => {
    const seam = createOptimizerSeam({
        alpha: true,
        encodings: {
            'image/webp': { data: 'tiny-webp', type: 'image/webp' },
            'image/png': { data: 'valid-png', type: 'image/png' },
        },
    });
    const result = await optimizeReferenceImage(seam.sourceBlob, { _test: seam });
    assert.equal(result.mime, 'image/png');
    assert.deepEqual(seam.calls, [['image/png', undefined]]);
});

test('optimizeReferenceImage: webp source does not pass through sourceCanWin', async () => {
    const seam = createOptimizerSeam({
        width: 320,
        height: 240,
        encodings: { 'image/jpeg': { data: 'reencoded-jpeg', type: 'image/jpeg' } },
    });
    const webpSource = new Blob(['source-webp'], { type: 'image/webp' });
    const result = await optimizeReferenceImage(webpSource, { _test: seam });
    assert.equal(result.mime, 'image/jpeg');
    assert.notEqual(result.blob, webpSource);
});

test('optimizeReferenceImage: formats option pins webp (thumbnail contract)', async () => {
    const seam = createOptimizerSeam({
        encodings: { 'image/webp': { data: 'thumb-webp', type: 'image/webp' } },
    });
    const result = await optimizeReferenceImage(seam.sourceBlob, { _test: seam, formats: ['image/webp'] });
    assert.equal(result.mime, 'image/webp');
    assert.deepEqual(seam.calls, [['image/webp', 0.82]]);
});

test('OPTIMIZATION_VERSION bumps to ref-v3-1024 (invalidates cached webp results)', () => {
    assert.equal(OPTIMIZATION_VERSION, 'ref-v3-1024');
});

test('optimizeReferenceImage accepts callback-based toBlob', async () => {
    const seam = createOptimizerSeam({
        encodings: { 'image/jpeg': { data: 'valid-jpeg', type: 'image/jpeg' } },
    });
    const result = await optimizeReferenceImage(seam.sourceBlob, { _test: seam });
    assert.equal(result.mime, 'image/jpeg');
    assert.deepEqual(seam.calls, [['image/jpeg', 0.85]]);
});

function createNormalizeSeam({ alpha = false, fail = false } = {}) {
    const calls = [];
    return {
        calls,
        seam: {
            async decode() {
                if (fail) throw new Error('decode exploded');
                return { width: 1024, height: 1024, close() {} };
            },
            createCanvas(w, h) {
                return {
                    width: w,
                    height: h,
                    getContext() {
                        return {
                            drawImage() {},
                            getImageData() { return { data: alpha ? new Uint8ClampedArray([1, 2, 3, 128]) : new Uint8ClampedArray([1, 2, 3, 255]) }; },
                        };
                    },
                    toBlob(callback, mime) {
                        calls.push(mime);
                        if (fail) return callback(null);
                        callback(new Blob(['x'], { type: mime }));
                    },
                };
            },
            async blobToDataUrl(blob) { return `data:${blob.type};base64,eA==`; },
        },
    };
}

test('normalizeReferenceDataUrl: webp reference is re-encoded to jpeg for sending', async () => {
    const { seam, calls } = createNormalizeSeam();
    const out = await normalizeReferenceDataUrl('data:image/webp;base64,ZmFrZQ==', { _test: seam });
    assert.equal(out, 'data:image/jpeg;base64,eA==');
    assert.deepEqual(calls, ['image/jpeg']);
});

test('normalizeReferenceDataUrl: alpha webp is re-encoded to png', async () => {
    const { seam, calls } = createNormalizeSeam({ alpha: true });
    const out = await normalizeReferenceDataUrl('data:image/webp;base64,ZmFrZQ==', { _test: seam });
    assert.equal(out, 'data:image/png;base64,eA==');
    assert.deepEqual(calls, ['image/png']);
});

test('normalizeReferenceDataUrl: non-webp passes through untouched', async () => {
    const { seam, calls } = createNormalizeSeam();
    const original = 'data:image/png;base64,ZmFrZQ==';
    assert.equal(await normalizeReferenceDataUrl(original, { _test: seam }), original);
    assert.deepEqual(calls, []);
});

test('normalizeReferenceDataUrl: encoder failure returns the original webp (graceful)', async () => {
    const { seam } = createNormalizeSeam({ fail: true });
    const original = 'data:image/webp;base64,ZmFrZQ==';
    assert.equal(await normalizeReferenceDataUrl(original, { _test: seam }), original);
});

test('decodeBrowserBlob retries HTMLImage after createImageBitmap rejects and closes fallback image', async () => {
    const previousBitmap = globalThis.createImageBitmap;
    const previousImage = globalThis.Image;
    const previousUrl = globalThis.URL;
    const calls = [];
    globalThis.createImageBitmap = async () => { throw new Error('bitmap rejection'); };
    globalThis.URL = { createObjectURL: () => 'blob:test', revokeObjectURL: url => calls.push(['revoke', url]) };
    globalThis.Image = class Image {
        set src(value) {
            this._src = value;
            if (value) queueMicrotask(() => this.onload?.());
        }
        get src() { return this._src; }
        constructor() { this.naturalWidth = 10; this.naturalHeight = 20; }
    };
    try {
        const decoded = await __testOnly.decodeBrowserBlob(new Blob(['x'], { type: 'image/png' }));
        assert.deepEqual([decoded.width, decoded.height], [10, 20]);
        decoded.close();
        assert.equal(decoded.image.src, '');
        assert.equal(decoded.image.onload, null);
        assert.equal(decoded.image.onerror, null);
        assert.deepEqual(calls, [['revoke', 'blob:test']]);
    } finally {
        globalThis.createImageBitmap = previousBitmap;
        globalThis.Image = previousImage;
        globalThis.URL = previousUrl;
    }
});

test('optimizeReferenceImage cleans bitmap and canvas after output errors', async () => {
    let sourceClosed = 0;
    const seam = createOptimizerSeam({ encodings: { 'image/jpeg': { data: 'candidate' } } });
    seam.decode = async blob => ({ width: blob._width ?? 400, height: blob._height ?? 200, close() { sourceClosed++; } });
    let canvas;
    const originalCanvas = seam.createCanvas;
    seam.createCanvas = (width, height) => {
        canvas = originalCanvas(width, height);
        return canvas;
    };
    seam.blobToDataUrl = async () => { throw new Error('read failed'); };
    await assert.rejects(optimizeReferenceImage(seam.sourceBlob, { _test: seam }), /read failed/);
    assert.equal(sourceClosed, 2);
    assert.deepEqual([canvas.width, canvas.height], [0, 0]);
});

test('optimizeReferenceImage rejects malformed image data URLs', async () => {
    await assert.rejects(
        optimizeReferenceImage('data:image/png;base64,%%%'),
        /fetch failed|input must be an image input/
    );
});


// ── Регрессия: imageToDataUrl возвращает null на 404 / не-картинке ──
// Баг: fetch без проверки resp.ok → 404 возвращал blob (HTML-страница ошибки)
// → data:text/html → «битый» референс проходил дальше → crash в compressDataUrl.

test('imageToDataUrl returns null on 404 response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, blob: async () => new Blob(['<h1>404</h1>'], { type: 'text/html' }) });
    try {
        const result = await imageToDataUrl('/User Avatars/nonexistent');
        assert.equal(result, null);  // НЕ должен возвращать data:text/html
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('imageToDataUrl returns null on non-image blob (HTML error page)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob(['<h1>error</h1>'], { type: 'text/html' }) });
    try {
        const result = await imageToDataUrl('/some/path');
        assert.equal(result, null);  // НЕ должен возвращать data:text/html
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('imageToDataUrl returns data URL for valid image blob', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob(['fake'], { type: 'image/png' }) });
    try {
        const result = await imageToDataUrl('/valid.png');
        assert.ok(result);
        assert.match(result, /^data:image\/png;base64,/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('ingestReferenceImage optimizes once, uploads optimizer data, and returns metadata', async () => {
    const calls = [];
    const optimized = {
        dataUrl: 'data:image/webp;base64,optimized',
        mime: 'image/webp', width: 640, height: 480,
        sourceBytes: 1200, optimizedBytes: 400, optimizationVersion: 'ref-test',
    };
    const result = await ingestReferenceImage(new Blob(['source'], { type: 'image/png' }), 'ref_test', {
        optimize: async input => { calls.push(['optimize', input]); return optimized; },
        upload: async (...args) => { calls.push(['upload', ...args]); return '/user/images/URIS_Refs/ref_test.webp'; },
    });
    assert.equal(result.imagePath, '/user/images/URIS_Refs/ref_test.webp');
    assert.deepEqual(result.metadata, {
        mime: 'image/webp', width: 640, height: 480,
        sourceBytes: 1200, optimizedBytes: 400, optimizationVersion: 'ref-test',
    });
    assert.deepEqual(calls, [
        ['optimize', calls[0]?.[1]],
        ['upload', 'data:image/webp;base64,optimized', 'ref_test', 'URIS_Refs'],
    ]);
});

test('uploadReferenceImage posts to /api/images/upload', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ path: '/user/images/URIS_Refs/test.png' }) };
    };
    try {
        const path = await uploadReferenceImage('data:image/png;base64,abc', 'test');
        // Canonicalized once here, so the value is root-relative and encoded
        // exactly one time no matter what raw spelling ST answered with.
        assert.equal(path, 'user/images/URIS_Refs/test.png');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, '/api/images/upload');
        const body = JSON.parse(calls[0].options.body);
        assert.equal(body.format, 'png');
        assert.equal(body.ch_name, 'URIS_Refs');
        assert.equal(body.image, 'abc');
        assert.equal(body.filename, 'test');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('uploadReferenceImage throws on HTTP error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'server boom' }),
    });
    try {
        await assert.rejects(
            async () => await uploadReferenceImage('data:image/png;base64,abc', 'test'),
            /server boom/
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('uploadReferenceImage sanitizes filename', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ path: '/user/images/URIS_Refs/ref.png' }) };
    };
    try {
        await uploadReferenceImage('data:image/png;base64,abc', '../../my file name.png');
        assert.equal(calls.length, 1);
        const body = JSON.parse(calls[0].options.body);
        // Traversal and separators are gone, and the dot is folded too: ST runs
        // removeFileExtension() on this field, so a surviving dot would silently
        // truncate the name to "my_file_name".
        assert.equal(body.filename, 'my_file_name_png');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('uploadReferenceImage falls back to ref when filename is empty', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ path: '/user/images/URIS_Refs/ref.png' }) };
    };
    try {
        await uploadReferenceImage('data:image/png;base64,abc', '   ');
        assert.equal(calls.length, 1);
        const body = JSON.parse(calls[0].options.body);
        assert.equal(body.filename, 'ref');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('loadReferenceImage reads a canonical native path without the CORS proxy', async () => {
    // Canonical paths carry no leading slash, so a slash-only same-origin test
    // sent them to autoFetch, where hostnameOf() treats the whole relative
    // string as a hostname and proxy machinery is applied to a local file.
    const originalFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async url => {
        urls.push(String(url));
        return { ok: true, blob: async () => new Blob(['x'], { type: 'image/png' }) };
    };
    try {
        const dataUrl = await loadReferenceImage('user/images/URIS_Refs/ref.png');
        assert.ok(String(dataUrl).startsWith('data:image/png'));
        assert.deepEqual(urls, ['user/images/URIS_Refs/ref.png']);
        assert.ok(!urls.some(u => u.startsWith('/proxy/')));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

