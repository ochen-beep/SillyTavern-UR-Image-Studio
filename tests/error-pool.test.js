import test from 'node:test';
import assert from 'node:assert/strict';
import {
    recordUrisError,
    listUrisErrors,
    clearUrisErrors,
    formatUrisError,
    markUrisErrorsSeen,
    countUnreadUrisErrors,
    hasUnreadHardUrisErrors,
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

test('generation context is stored and rendered in the row', () => {
    const entry = recordUrisError({
        scope: 'Генерация',
        message: 'gateway 502',
        context: { post: 42, connection: 'Novita Card', model: 'sd-xl' },
    });

    assert.deepEqual(entry.context, { post: 42, connection: 'Novita Card', model: 'sd-xl' });
    const formatted = formatUrisError(entry);
    assert.match(formatted, /пост #42/);
    assert.match(formatted, /«Novita Card»/);
    assert.match(formatted, /sd-xl/);
});

test('context without usable fields is not stored', () => {
    const entry = recordUrisError({ scope: 'Генерация', message: 'x', context: {} });
    assert.equal(entry.context, undefined);
});

test('quiet flag is stored only when requested', () => {
    const quietEntry = recordUrisError({ scope: 'Провайдер', message: 'quality dropped', quiet: true });
    const loudEntry = recordUrisError({ scope: 'Генерация', message: 'boom' });
    assert.equal(quietEntry.quiet, true);
    assert.equal('quiet' in loudEntry, false);
});

test('dedup keeps post number in the key: same post collapses, different post does not', () => {
    const a = recordUrisError({ scope: 'Генерация', message: 'fail', context: { post: 1 } });
    const b = recordUrisError({ scope: 'Генерация', message: 'fail', context: { post: 1 } });
    assert.equal(a, b);
    assert.equal(a.count, 2);

    const c = recordUrisError({ scope: 'Генерация', message: 'fail', context: { post: 2 } });
    assert.notEqual(a, c);
    assert.equal(listUrisErrors().length, 2);
    assert.equal(c.context.post, 2);
});

test('level is stored only when warn', () => {
    const warn = recordUrisError({ scope: 'Провайдер', message: 'aspect adjusted', level: 'warn' });
    const hard = recordUrisError({ scope: 'Генерация', message: 'boom' });
    assert.equal(warn.level, 'warn');
    assert.equal('level' in hard, false);
});

test('unread counts entries recorded after the last markUrisErrorsSeen', () => {
    recordUrisError({ message: 'one' });
    recordUrisError({ message: 'two' });
    assert.equal(countUnreadUrisErrors(), 2);

    markUrisErrorsSeen();
    assert.equal(countUnreadUrisErrors(), 0);

    recordUrisError({ message: 'three' });
    assert.equal(countUnreadUrisErrors(), 1);
});

test('dedupe bump makes a seen entry unread again', () => {
    const entry = recordUrisError({ message: 'flaky' });
    markUrisErrorsSeen();
    assert.equal(countUnreadUrisErrors(), 0);

    const bumped = recordUrisError({ message: 'flaky' });
    assert.equal(bumped, entry);
    assert.equal(countUnreadUrisErrors(), 1);
});

test('quiet entries never count as unread', () => {
    recordUrisError({ message: 'provider hint', quiet: true });
    assert.equal(countUnreadUrisErrors(), 0);
    assert.equal(hasUnreadHardUrisErrors(), false);
});

test('hard flag distinguishes warn rows from errors', () => {
    recordUrisError({ message: 'aspect adjusted', level: 'warn' });
    assert.equal(countUnreadUrisErrors(), 1);
    assert.equal(hasUnreadHardUrisErrors(), false);

    recordUrisError({ message: 'boom' });
    assert.equal(hasUnreadHardUrisErrors(), true);

    markUrisErrorsSeen();
    assert.equal(hasUnreadHardUrisErrors(), false);
});

test('clearUrisErrors resets the seen baseline', () => {
    recordUrisError({ message: 'old' });
    markUrisErrorsSeen();
    clearUrisErrors();

    recordUrisError({ message: 'fresh' });
    assert.equal(countUnreadUrisErrors(), 1);
});
