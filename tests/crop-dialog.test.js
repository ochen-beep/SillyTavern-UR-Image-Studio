// @ts-check
// Tests for src/ui/crop-dialog.js pure helpers (the dialog itself needs a
// browser: Croppr is imported dynamically and touches `window` at module scope).
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('clampCropRegion: целочисленная область внутри изображения, минимум 1×1', async () => {
    const { clampCropRegion } = await import('../src/ui/crop-dialog.js');
    assert.deepEqual(
        clampCropRegion({ x: 10.4, y: 20.6, width: 100.2, height: 50.9 }, 800, 600),
        { x: 10, y: 21, width: 100, height: 51 },
    );
    assert.deepEqual(
        clampCropRegion({ x: -10, y: -10, width: 100, height: 100 }, 800, 600),
        { x: 0, y: 0, width: 100, height: 100 },
    );
    // Region hugging the bottom-right edge clamps to stay inside the source.
    assert.deepEqual(
        clampCropRegion({ x: 795, y: 595, width: 100, height: 100 }, 800, 600),
        { x: 795, y: 595, width: 5, height: 5 },
    );
    // Degenerate/absent values still produce a valid 1×1 region.
    assert.deepEqual(clampCropRegion({ x: NaN, y: NaN, width: 0, height: 0 }, 800, 600), { x: 0, y: 0, width: 1, height: 1 });
    assert.deepEqual(clampCropRegion(undefined, 10, 10), { x: 0, y: 0, width: 1, height: 1 });
});

test('clampCropRegion: пиксельные размеры источника всегда валидны', async () => {
    const { clampCropRegion } = await import('../src/ui/crop-dialog.js');
    assert.deepEqual(clampCropRegion({ x: 0, y: 0, width: 50, height: 50 }, 0, 0), { x: 0, y: 0, width: 1, height: 1 });
});

test('normalizeCropSource: строки проходят как есть, Blob получает object URL', async () => {
    const { normalizeCropSource } = await import('../src/ui/crop-dialog.js');
    const direct = normalizeCropSource('user/images/URIS_Refs/ref_1.webp');
    assert.equal(direct.src, 'user/images/URIS_Refs/ref_1.webp');
    direct.revoke();

    const blobSource = new Blob(['x'], { type: 'image/png' });
    const fromBlob = normalizeCropSource(blobSource);
    assert.match(fromBlob.src, /^blob:|^urn:/);
    assert.doesNotThrow(() => fromBlob.revoke());
});

test('normalizeCropSource: без object URL бросает понятную ошибку', async () => {
    const { normalizeCropSource } = await import('../src/ui/crop-dialog.js');
    const originalCreate = URL?.createObjectURL;
    const originalRevoke = URL?.revokeObjectURL;
    try {
        if (typeof URL !== 'undefined') {
            URL.createObjectURL = undefined;
            URL.revokeObjectURL = undefined;
        }
        assert.throws(() => normalizeCropSource(new Blob(['x'])), /File, Blob, or URL string/);
    } finally {
        if (typeof URL !== 'undefined' && originalCreate) {
            URL.createObjectURL = originalCreate;
            URL.revokeObjectURL = originalRevoke;
        }
    }
});

test('пресеты кропа: 3:4 соответствует тайлам пула референсов', async () => {
    const { CROP_PRESETS } = await import('../src/ui/crop-dialog.js');
    assert.equal(CROP_PRESETS.length, 3);
    assert.equal(CROP_PRESETS[0].ratio, null, 'первый пресет — свободный');
    // Croppr трактует aspectRatio как высота/ширина (height = width × ratio),
    // поэтому портретный 3:4 — это 4/3, иначе пресет даёт альбомную рамку.
    assert.ok(Math.abs(CROP_PRESETS[2].ratio - 4 / 3) < 1e-9, '3:4 (портрет) = 4/3 в конвенции Croppr');
});
