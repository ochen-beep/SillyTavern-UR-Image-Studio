// @ts-check
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals } from './_helpers.js';

installStGlobals();

const debugStore = new Map();
globalThis.SillyTavern.libs.localforage = {
    async getItem(key) { return debugStore.has(key) ? structuredClone(debugStore.get(key)) : null; },
    async setItem(key, value) { debugStore.set(key, structuredClone(value)); },
    async removeItem(key) { debugStore.delete(key); },
};

const core = await import('../src/core.js');
const journal = await import('../src/diagnostic-events.js');
const { buildDiagnosticDump, exportDiagnosticDump } = await import('../src/diagnostic-dump.js');

beforeEach(() => {
    debugStore.clear();
    journal.resetDiagnosticEventsForTests();
    core.clearDebugLog();
    core.state.settings = { debugMode: false };
});

afterEach(() => {
    core.clearDebugLog();
    core.state.settings = { debugMode: false };
});

test('trace is silent and empty when debug mode is disabled', () => {
    const calls = [];
    const originalLog = console.log;
    console.log = (...args) => calls.push(args);
    try { core.trace('hidden trace'); } finally { console.log = originalLog; }
    assert.equal(calls.length, 0);
    assert.equal(core.dumpDebugLog(), '(дебаг-лог пуст: Debug-режим выключен)');
});

test('trace records bounded diagnostics without console output when enabled', () => {
    core.state.settings.debugMode = true;
    const calls = [];
    const originalLog = console.log;
    console.log = (...args) => calls.push(args);
    try {
        const circular = { name: 'route' };
        circular.self = circular;
        core.trace('payload', circular, { apiKey: 'secret', body: 'x'.repeat(4000) });
    } finally { console.log = originalLog; }
    const dump = core.dumpDebugLog();
    assert.equal(calls.length, 0);
    assert.match(dump, /\[DEBUG\]/);
    assert.match(dump, /\[Circular\]/);
    assert.match(dump, /<redacted>/);
    assert.match(dump, /truncated/);
    assert.doesNotMatch(dump, /secret/);
});

test('loadSettings strictly normalizes debugMode to boolean', async () => {
    const settings = { debugMode: 'true', apiSource: 'invalid' };
    globalThis.SillyTavern.getContext = () => ({ extensionSettings: { ur_image_studio: settings } });
    await core.loadSettings();
    assert.equal(core.state.settings.debugMode, false);
    assert.equal(core.state.settings.apiSource, 'profile');
    settings.debugMode = true;
    await core.loadSettings();
    assert.equal(core.state.settings.debugMode, true);
});

test('warn and error remain console-visible while debug is disabled', () => {
    const warnings = [];
    const errors = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args) => warnings.push(args);
    console.error = (...args) => errors.push(args);
    try {
        core.warn('warning');
        core.error('failure');
    } finally {
        console.warn = originalWarn;
        console.error = originalError;
    }
    assert.equal(warnings.length, 1);
    assert.equal(errors.length, 1);
    assert.match(core.dumpLog(), /warning/);
    assert.match(core.dumpLog(), /failure/);
});

test('diagnostic journal persists metadata-only events and reloads them', async () => {
    await journal.loadDiagnosticEvents();
    journal.recordDiagnosticEvent({
        event: 'dispatch-response',
        requestId: 'req-1',
        chatHash: 'h123',
        modelId: 'image-model',
        status: 503,
        details: { prompt: 'secret prompt', provider: 'gateway' },
    });
    await journal.flushDiagnosticEvents();
    assert.equal(debugStore.has(journal.LF_DIAGNOSTIC_EVENTS), true);

    journal.resetDiagnosticEventsForTests();
    const loaded = await journal.loadDiagnosticEvents();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].requestId, 'req-1');
    assert.equal(loaded[0].details.prompt.chars, 13);
    assert.equal(loaded[0].details.provider, 'gateway');
});

test('diagnostic dump carries only WARN/ERROR log lines, not INFO', async () => {
    core.state.settings = { debugMode: false };
    journal.resetDiagnosticEventsForTests();
    core.log('info: обычный успех — не должен попадать в дамп');
    core.warn('warn: предупреждение должно попасть');
    core.error('error: ошибка должна попасть');
    const payload = await buildDiagnosticDump({ exportedAt: '2026-08-22T00:00:00.000Z' });
    assert.match(payload.log, /warn: предупреждение должно попасть/);
    assert.match(payload.log, /error: ошибка должна попасть/);
    assert.doesNotMatch(payload.log, /info: обычный успех/);
});

test('diagnostic dump is metadata-only and includes pending/error summaries', async () => {
    core.state.settings = { debugMode: true, apiSource: 'profile', profileId: 'profile-1' };
    core.state.currentChatId = 'private-chat';
    journal.resetDiagnosticEventsForTests();
    await journal.loadDiagnosticEvents();
    journal.recordDiagnosticEvent({ event: 'stage1-start', requestId: 'req-1', details: { prompt: 'private prompt' } });
    debugStore.set('uris_pending_images', [{ kind: 'browserRequest', id: 'pending-1', requestId: 'pending-1', status: 'dispatchingUnknown', prompt: 'private prompt', error: 'timeout' }]);
    const payload = await buildDiagnosticDump({ exportedAt: '2026-08-22T00:00:00.000Z' });
    const serialized = JSON.stringify(payload);
    assert.equal(payload.probe, 'UR Image Studio diagnostic');
    assert.equal(payload.pendingRecovery[0].id, 'pending-1');
    assert.ok(payload.eventLog.length >= 1);
    assert.equal(typeof payload.log, 'string');
    assert.doesNotMatch(serialized, /private prompt/);
    assert.doesNotMatch(serialized, /currentChatId/);
});

test('diagnostic journal clear keeps post-clear events persistable', async () => {
    await journal.loadDiagnosticEvents();
    journal.recordDiagnosticEvent('before-clear');
    await journal.flushDiagnosticEvents();
    await journal.clearDiagnosticEvents();
    journal.recordDiagnosticEvent('after-clear');
    await journal.flushDiagnosticEvents();
    journal.resetDiagnosticEventsForTests();
    const loaded = await journal.loadDiagnosticEvents();
    assert.deepEqual(loaded.map(item => item.event), ['after-clear']);
});

test('diagnostic journal clear removes persisted events without touching pending storage', async () => {
    await journal.loadDiagnosticEvents();
    journal.recordDiagnosticEvent('session-start');
    await journal.flushDiagnosticEvents();
    debugStore.set('uris_pending_images', [{ kind: 'browserRequest', id: 'pending-1' }]);
    await journal.clearDiagnosticEvents();
    assert.equal(debugStore.has(journal.LF_DIAGNOSTIC_EVENTS), false);
    assert.deepEqual(debugStore.get('uris_pending_images'), [{ kind: 'browserRequest', id: 'pending-1' }]);
    assert.deepEqual(journal.listDiagnosticEvents(), []);
});

test('journal eviction prefers log-level entries; warn/error outlive FIFO', () => {
    journal.resetDiagnosticEventsForTests();
    for (let i = 0; i < 3; i++) journal.recordDiagnosticEvent({ event: `warn-keep-${i}`, level: 'warn' });
    for (let i = 0; i < journal.MAX_DIAGNOSTIC_EVENTS; i++) journal.recordDiagnosticEvent({ event: `log-${i}` });
    journal.recordDiagnosticEvent({ event: 'warn-last', level: 'warn' });
    const events = journal.listDiagnosticEvents();
    assert.equal(events.length, journal.MAX_DIAGNOSTIC_EVENTS, 'capacity is bounded');
    assert.ok(events.some(e => e.event === 'warn-keep-0'), 'the oldest warn survives eviction');
    assert.ok(events.some(e => e.event === 'warn-last'), 'a fresh warn is present');
    assert.equal(events.some(e => e.event === 'log-0'), false, 'the oldest log is evicted first');
});

test('flushDiagnosticEvents writes even before any timer fired (исход генерации)', async () => {
    await journal.loadDiagnosticEvents();
    journal.recordDiagnosticEvent({ event: 'dispatch-start', requestId: 'req-flush-1' });
    // Принудительный флаш из image-api.js (stage2-end/error): не ждём ни
    // дебаунса 500 мс, ни throttle-потолка.
    await journal.flushDiagnosticEvents();
    const persisted = debugStore.get(journal.LF_DIAGNOSTIC_EVENTS);
    assert.ok(Array.isArray(persisted));
    assert.ok(persisted.some(e => e.event === 'dispatch-start' && e.requestId === 'req-flush-1'));
});

test('diagnostic journal: throttle 5с гарантирует запись при непрерывном потоке (дебаунс голодает)', async (t) => {
    await journal.loadDiagnosticEvents();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    journal.recordDiagnosticEvent({ event: 'dispatch-start', requestId: 'req-throttle' });
    for (let i = 0; i < 10; i++) {
        journal.recordDiagnosticEvent({ event: 'dispatch-stream', requestId: 'req-throttle' });
        // 400 мс < 500 мс дебаунса: каждая запись сбрасывает быстрый путь —
        // именно так выглядел «вечный» лаг журнала при потоке событий.
        t.mock.timers.tick(400);
    }
    assert.equal(debugStore.has(journal.LF_DIAGNOSTIC_EVENTS), false, 'младше 5 с запись не обязательна');
    t.mock.timers.tick(1000); // суммарно 5 с от первого «грязного» события — потолок
    await journal.flushDiagnosticEvents();
    const persisted = debugStore.get(journal.LF_DIAGNOSTIC_EVENTS);
    assert.ok(persisted.some(e => e.event === 'dispatch-start'));
    assert.ok(persisted.some(e => e.event === 'dispatch-stream'));
});
