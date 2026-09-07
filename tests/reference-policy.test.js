// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveServerOwnedReferencePolicy } from '../src/reference-policy.js';

const policy = (capabilities) => resolveServerOwnedReferencePolicy({ selectedRoute: { capabilities } });

test('server route without reference support disables references', () => {
    assert.deepEqual(policy({ references: 'unsupported' }), {
        supported: false,
        status: 'unsupported',
        protocol: null,
        maxRefs: 0,
        reason: 'Выбранный маршрут не принимает референсы.',
        source: 'server-route',
    });
    assert.equal(policy({ maxReferences: 0 }).supported, false);
});

test('server route reference cap uses provider metadata ceiling without a product-wide cap', () => {
    assert.equal(policy({ references: 'supported', maxReferences: 2 }).maxRefs, 2);
    assert.equal(policy({ references: 'supported', maxReferences: 999 }).maxRefs, 64);
});

test('server route without an explicit cap remains unknown', () => {
    assert.deepEqual(policy({ references: 'unknown' }), {
        supported: true,
        status: 'unknown',
        protocol: null,
        maxRefs: null,
        reason: '',
        source: 'server-route',
    });
    assert.equal(resolveServerOwnedReferencePolicy({}).maxRefs, null);
});
