// @ts-check
// Backup export promises "no API keys": isSecretKey is the single gate that
// decides which connection fields survive portability. Bare key names and
// suffixed custom fields must both be caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSecretKey } from '../src/image-connection-schema.js';

test('isSecretKey catches bare key names', () => {
    assert.equal(isSecretKey('key'), true);
    assert.equal(isSecretKey('secretkey'), true);
    assert.equal(isSecretKey('apikey'), true);
});

test('isSecretKey catches suffixed custom fields after separator stripping', () => {
    assert.equal(isSecretKey('my_api_key'), true);
    assert.equal(isSecretKey('x-auth-token'), true);
    assert.equal(isSecretKey('openrouterSecret'), true);
});

test('isSecretKey does not flag ordinary field names', () => {
    assert.equal(isSecretKey('endpoint'), false);
    assert.equal(isSecretKey('monkey'), false);
    assert.equal(isSecretKey('tokenizer'), false);
    assert.equal(isSecretKey('modelId'), false);
});
