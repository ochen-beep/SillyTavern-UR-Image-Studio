// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runReferenceCheck } = await import('../src/reference-check.js');

test('success path sends one tiny reference and records user-confirmed evidence', async () => {
    const generations = [];
    const records = [];
    const outcome = await runReferenceCheck({ connectionId: 'conn-1' }, {
        generate: async (connectionId, request) => {
            generations.push({ connectionId, request });
            request.editDialect = 'json';
            return { galleryEntry: { id: 'entry-1' } };
        },
        record: async input => { records.push(input); return { refs: 'confirmed' }; },
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.galleryEntry.id, 'entry-1');
    assert.equal(outcome.dialect, 'json');
    assert.equal(generations.length, 1);
    assert.equal(generations[0].connectionId, 'conn-1');
    assert.match(generations[0].request.requestId, /^refcheck_[a-z0-9]+$/);
    assert.equal(generations[0].request.references.length, 1);
    assert.match(generations[0].request.references[0].dataUrl, /^data:image\/png;base64,/);
    assert.deepEqual(records, [{
        connectionId: 'conn-1', modelId: null, dialect: 'json', refCount: 1, userConfirmed: true,
    }]);
});

test('failure path records the rejection evidence and rethrows', async () => {
    const records = [];
    const failure = new Error('Image editing is only supported for compatible providers.');
    await assert.rejects(
        () => runReferenceCheck({ connectionId: 'conn-2' }, {
            generate: async () => { throw failure; },
            record: async input => { records.push(input); return { refs: 'rejected' }; },
        }),
        error => error === failure,
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].refCount, 1);
    assert.equal(records[0].userConfirmed, true);
});

test('missing connection id throws before any paid request', async () => {
    let calls = 0;
    await assert.rejects(
        () => runReferenceCheck({}, { generate: async () => { calls++; return {}; }, record: async () => null }),
        /Connection is required/,
    );
    assert.equal(calls, 0);
});
