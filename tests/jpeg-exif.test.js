// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jpegExifRotated } from '../src/jpeg-exif.js';

// APP0 "JFIF", the segment that usually precedes EXIF in camera output.
const JFIF_HEADER = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
const TIFF_LITTLE = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00];
const TIFF_BIG = [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08];
const ORIENTATION_LITTLE = orientation => [0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00];
const ORIENTATION_BIG = orientation => [0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, 0x00, 0x00];
const jpeg = (...segments) => new Uint8Array([0xff, 0xd8, ...segments.flat(), 0xff, 0xd9]).buffer;
const exif = (tiff, orientation) => [0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff, ...orientation];

test('jpegExifRotated reports only a non-upright EXIF orientation', () => {
    assert.equal(jpegExifRotated(jpeg(exif(TIFF_LITTLE, ORIENTATION_LITTLE(1)))), false);
    assert.equal(jpegExifRotated(jpeg(exif(TIFF_BIG, ORIENTATION_BIG(1)))), false);
    assert.equal(jpegExifRotated(jpeg(JFIF_HEADER, exif(TIFF_BIG, ORIENTATION_BIG(1)))), false);
    assert.equal(jpegExifRotated(jpeg(JFIF_HEADER, exif(TIFF_LITTLE, ORIENTATION_LITTLE(6)))), true);
    assert.equal(jpegExifRotated(jpeg(exif(TIFF_BIG, ORIENTATION_BIG(3)))), true);
});

test('jpegExifRotated treats undecodable input as rotated', () => {
    // No EXIF at all: nothing to rotate.
    assert.equal(jpegExifRotated(jpeg(JFIF_HEADER)), false);
    // Not a JPEG, and an EXIF segment cut off inside its directory.
    assert.equal(jpegExifRotated(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer), true);
    const truncated = new Uint8Array(jpeg(exif(TIFF_LITTLE, ORIENTATION_LITTLE(6)))).slice(0, 24).buffer;
    assert.equal(jpegExifRotated(truncated), true);
});
