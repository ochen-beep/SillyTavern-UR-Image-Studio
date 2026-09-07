import test from 'node:test';
import assert from 'node:assert/strict';
import {
    recordUrisError,
    listUrisErrors,
    clearUrisErrors,
    formatUrisError,
} from '../src/error-pool.js';

test.beforeEach(() => {
    clearUrisErrors();
});

test('error pool records entries and deduplicates recent identical errors', () => {
    const first = recordUrisError({ scope: 'Stage 2', message: 'provider failed' });
    const second = recordUrisError({ scope: 'Stage 2', message: 'provider failed' });

    assert.equal(first, second);
    assert.deepEqual(listUrisErrors(), [
        { scope: 'Stage 2', message: 'provider failed', ts: second.ts, firstAt: first.firstAt, count: 2 },
    ]);
});

test('error pool keeps different scopes or messages as separate entries', () => {
    recordUrisError({ scope: 'Stage 1', message: 'failed' });
    recordUrisError({ scope: 'Stage 2', message: 'failed' });
    recordUrisError({ scope: 'Stage 2', message: 'other' });

    assert.equal(listUrisErrors().length, 3);
});

test('error pool is bounded to the newest 50 entries', () => {
    for (let i = 0; i < 51; i++) {
        recordUrisError({ scope: 'test', message: `error-${i}` });
    }

    const errors = listUrisErrors();
    assert.equal(errors.length, 50);
    assert.equal(errors[0].message, 'error-1');
    assert.equal(errors.at(-1).message, 'error-50');
});

test('clearUrisErrors removes all entries', () => {
    recordUrisError({ message: 'one' });
    recordUrisError({ message: 'two' });
    clearUrisErrors();
    assert.deepEqual(listUrisErrors(), []);
});

test('formatUrisError includes time, scope, repeat count, and message', () => {
    const entry = recordUrisError({ scope: 'Проверка', message: 'bad gateway' });
    recordUrisError({ scope: 'Проверка', message: 'bad gateway' });
    const formatted = formatUrisError(entry);

    assert.match(formatted, /\d{2}:\d{2}:\d{2}/);
    assert.match(formatted, /Проверка ×2: bad gateway/);
});
