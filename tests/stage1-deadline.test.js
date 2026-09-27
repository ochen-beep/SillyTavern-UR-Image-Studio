// @ts-check
// Дедлайн профильного пути Stage 1: sendRequest идёт через ST-сервер мимо
// fetchWithTimeout (text-connection.js документирует это), зависший профильный
// запрос висел вечно — «отмена только по таймауту» его не покрывала.
// withDeadline даёт ему дедлайн той же формы, что у fetchWithTimeout
// (обычный Error('Timeout (Ns)'), НЕ AbortError), не ломая внешнюю отмену.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals } from './_helpers.js';

beforeEach(() => installStGlobals());

/** Мок «зависшего» запроса: отвечает только на аборт, как настоящий fetch. */
function hangingRun(signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
        // иначе — не разрешается никогда
    });
}

test('withDeadline отдаёт значение, если run успел до дедлайна', async () => {
    const { withDeadline } = await import('../src/core.js');
    const value = await withDeadline(1000, null, (signal) => {
        assert.ok(signal instanceof AbortSignal, 'run получает собственный сигнал дедлайна');
        return Promise.resolve('ok');
    });
    assert.equal(value, 'ok');
});

test('withDeadline роняет зависший run по таймауту и абортит его сигнал', async () => {
    const { withDeadline } = await import('../src/core.js');
    let runSignal = null;
    await assert.rejects(
        withDeadline(20, null, (signal) => { runSignal = signal; return hangingRun(signal); }),
        (e) => {
            assert.equal(e?.name, 'Error', `таймаут — обычная ошибка, не AbortError (иначе лента/статусы примут его за отмену): ${e?.name}`);
            assert.match(e?.message || '', /^Timeout \(/);
            return true;
        },
    );
    assert.equal(runSignal?.aborted, true, 'сигнал run-а абортнут по дедлайну');
});

test('внешняя отмена сильнее дедлайна: AbortError доходит как есть', async () => {
    const { withDeadline } = await import('../src/core.js');
    const ctrl = new AbortController();
    const pending = withDeadline(20_000, ctrl.signal, (signal) => hangingRun(signal));
    ctrl.abort();
    await assert.rejects(pending, (e) => {
        assert.equal(e?.name, 'AbortError', `ожидали AbortError, получили: ${e?.name}: ${e?.message}`);
        return true;
    });
});

test('generateWithProfile: зависший sendRequest роняется по дедлайну, сигнал абортится', async () => {
    const settings = { connectionManager: { profiles: [{ id: 'p1', name: 'Profile One' }] } };
    let sendSignal = null;
    let sendCalls = 0;
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings: settings,
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
        ConnectionManagerRequestService: {
            sendRequest: (profileId, messages, _unused, opts) => {
                sendCalls += 1;
                sendSignal = opts?.signal;
                return hangingRun(opts?.signal);
            },
        },
    });
    const { generateWithProfile } = await import('../src/text-connection.js');
    await assert.rejects(
        generateWithProfile('p1', 's', 'u', null, null, { timeoutMs: 20 }),
        (e) => {
            assert.match(e?.message || '', /Timeout \(/);
            assert.ok(!/недоступен/i.test(e?.message || ''), 'таймаут не должен выглядеть как «недоступен»');
            return true;
        },
    );
    assert.equal(sendCalls, 1, 'запрос был отправлен ровно один раз');
    assert.equal(sendSignal?.aborted, true, 'sendRequest получил аборт по дедлайну');
});

test('generateWithProfile: успешный sendRequest до дедлайна отдаёт текст', async () => {
    const settings = { connectionManager: { profiles: [{ id: 'p2', name: 'Profile Two' }] } };
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings: settings,
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
        ConnectionManagerRequestService: {
            sendRequest: async () => ({ choices: [{ message: { content: 'prompt text' } }] }),
        },
    });
    const { generateWithProfile } = await import('../src/text-connection.js');
    const text = await generateWithProfile('p2', 's', 'u', null, null, { timeoutMs: 1000 });
    assert.equal(text, 'prompt text');
});
