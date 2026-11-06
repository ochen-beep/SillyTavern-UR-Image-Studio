// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalizeUserFilePath, canonicalizeStoredPath } from '../src/native-image-path.js';

test('canonicalizeUserFilePath: flat user/files paths, both slash spellings', () => {
    assert.equal(canonicalizeUserFilePath('user/files/uris_ref_cat_a1b2c3.png'), 'user/files/uris_ref_cat_a1b2c3.png');
    assert.equal(canonicalizeUserFilePath('/user/files/uris_thumb_x%20y.webp'), 'user/files/uris_thumb_x%20y.webp');
});

test('canonicalizeUserFilePath: rejects traversal, nesting, schemes, other roots', () => {
    for (const bad of [
        'user/files/../secret.png',
        'user/files/sub/dir.png',
        'user/images/URIS_Refs/x.png',
        'https://evil.example/user/files/x.png',
        'user/files/',
        '',
        null,
        'user/files/..%2f..%2fsettings.json',
    ]) {
        assert.equal(canonicalizeUserFilePath(/** @type {any} */ (bad)), null, String(bad));
    }
});

test('canonicalizeStoredPath accepts both storage generations', () => {
    assert.equal(canonicalizeStoredPath('user/images/URIS_Refs/a.png'), 'user/images/URIS_Refs/a.png');
    assert.equal(canonicalizeStoredPath('user/files/uris_ref_a.png'), 'user/files/uris_ref_a.png');
    assert.equal(canonicalizeStoredPath('etc/passwd'), null);
});
