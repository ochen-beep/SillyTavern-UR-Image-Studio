// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalizeNativeImagePath, nativeImagePathFromBasename } from '../src/native-image-path.js';

const legacy = 'user/images/UR%20Image%20Studio/literal%20name.png';

test('canonicalizes legacy folder paths (literal or encoded spaces)', () => {
    for (const value of [
        'user/images/UR Image Studio/literal name.png',
        '/user/images/UR%20Image%20Studio/literal%20name.png',
        legacy,
    ]) {
        assert.equal(canonicalizeNativeImagePath(value), legacy);
    }
});

test('canonicalizes arbitrary single-segment character folder paths', () => {
    assert.equal(canonicalizeNativeImagePath('user/images/Alice/portrait.png'), 'user/images/Alice/portrait.png');
    assert.equal(canonicalizeNativeImagePath('user/images/Group%201/scene.webp'), 'user/images/Group%201/scene.webp');
    assert.equal(canonicalizeNativeImagePath('user/images/Bob%20the%20Cat/f.jpg'), 'user/images/Bob%20the%20Cat/f.jpg');
    assert.equal(canonicalizeNativeImagePath('/user/images/Алиса/портрет.png'), 'user/images/%D0%90%D0%BB%D0%B8%D1%81%D0%B0/%D0%BF%D0%BE%D1%80%D1%82%D1%80%D0%B5%D1%82.png');
});

test('nativeImagePathFromBasename builds a path for a given folder', () => {
    assert.equal(nativeImagePathFromBasename('literal name.png'), legacy);
    assert.equal(nativeImagePathFromBasename('pic.png', 'Alice'), 'user/images/Alice/pic.png');
    assert.equal(nativeImagePathFromBasename('pic.png', 'Group 1'), 'user/images/Group%201/pic.png');
});

test('rejects unsafe, malformed, nested, or non-native image path values', () => {
    const invalid = [
        '', 'https://images.example/file.png', 'data:image/png;base64,aGVsbG8=',
        'user/images/Alice/file\\name.png',
        'user/images/Alice/bad%2',
        'user/images/Alice/../file.png',
        'user/images/Alice/%2E%2E/file.png',
        'user/images/Alice/file%2Fname.png',
        'user/images/Alice/file%252Fname.png',
        'user/images/Alice/file.png?x=1',
        'user/images/Alice/file.png#part',
        'user/images/Alice/nested/file.png',
        'user/images/Alice/',
        'user/images//file.png',
        'user/images/Alice',
        'file.png',
        'user/images/Alice/file\nname.png',
    ];
    for (const value of invalid) {
        assert.equal(canonicalizeNativeImagePath(value), null, value);
    }
    for (const value of ['nested/file.png', '../file.png', 'file%2Fname.png', 'file%252Fname.png', '']) {
        assert.equal(nativeImagePathFromBasename(value), null, value);
    }
});
