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
    getUrisErrorsSeenAt,
    reportFailure,
    URIS_SCOPES,
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
    // Пост 1-based, как в QUEUE-бейдже (msgId 42 — это «пост #43» для человека).
    assert.match(formatted, /пост #43/);
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

test('seen baseline is a single timestamp for the whole feed (pool + recovery)', () => {
    // Единая модель непрочитанности (2026-10-02): recovery-чеки сверяются с
    // тем же бейзлайном, что и пул сессии — окно.js берёт его через геттер.
    recordUrisError({ message: 'one' });
    markUrisErrorsSeen();
    const seenAt = getUrisErrorsSeenAt();
    assert.equal(Number.isFinite(seenAt), true);
    assert.ok(seenAt > 0, 'бейзлайн — реальный таймстамп, не ноль');
});

test('seen baseline persists to localStorage when available', () => {
    // Персистентность переживает перезагрузку страницы: без неё старые чеки
    // снова зажигали бы бейдж после каждого reload.
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => store.set(k, String(v)),
    };
    try {
        markUrisErrorsSeen();
        assert.match(store.get('uris_feed_seen_at'), /^\d+$/);
        const afterMark = Number(store.get('uris_feed_seen_at'));
        clearUrisErrors();
        const afterClear = Number(store.get('uris_feed_seen_at'));
        assert.ok(afterClear >= afterMark, 'clear фиксирует бейзлайн «сейчас», а не сбрасывает в ноль');
    } finally {
        delete globalThis.localStorage;
    }
});

test('seen baseline survives module reload with persisted value (guard no-op without localStorage)', () => {
    // Без localStorage (node-тесты, приватный режим) бейзлайн живёт в памяти:
    // все операции безопасны, ничего не падает.
    recordUrisError({ message: 'one' });
    markUrisErrorsSeen();
    assert.equal(countUnreadUrisErrors(), 0);
    assert.equal(Number.isFinite(getUrisErrorsSeenAt()), true);
});

test('reportFailure records and toasts the pool text once', () => {
    const toasts = [];
    globalThis.toastr = { error: (msg, title) => toasts.push(['error', msg, title]) };
    try {
        const entry = reportFailure({ scope: 'Генерация', message: 'boom', toast: true });
        assert.equal(listUrisErrors().at(-1), entry);
        assert.deepEqual(toasts, [['error', 'boom', undefined]]);
    } finally {
        delete globalThis.toastr;
    }
});

test('reportFailure without toast flag and with toastText override', () => {
    const toasts = [];
    globalThis.toastr = { error: (...args) => toasts.push(args) };
    try {
        reportFailure({ scope: 'Галерея', message: 'pool text', toastText: 'toast text' });
        assert.equal(listUrisErrors().at(-1).message, 'pool text');
        assert.deepEqual(toasts, []);

        reportFailure({ scope: 'Галерея', message: 'pool 2', toast: true, toastText: 'toast 2', toastTitle: 'URIS' });
        assert.deepEqual(toasts, [['toast 2', 'URIS']]);
    } finally {
        delete globalThis.toastr;
    }
});

test('reportFailure carries level and quiet into the entry', () => {
    reportFailure({ scope: 'Провайдер', message: 'hint', quiet: true, level: 'warn' });
    const entry = listUrisErrors().at(-1);
    assert.equal(entry.quiet, true);
    assert.equal(entry.level, 'warn');
    assert.equal(countUnreadUrisErrors(), 0);
});

test('URIS_SCOPES values are unique non-empty strings', () => {
    const values = Object.values(URIS_SCOPES);
    assert.equal(new Set(values).size, values.length);
    for (const value of values) assert.equal(typeof value, 'string');
    for (const value of values) assert.ok(value.length > 0);
});
