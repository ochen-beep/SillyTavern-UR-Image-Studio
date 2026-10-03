// @ts-check
// Присоединение к чужому auto-flight (runFullPipelineForDraft dedup):
// регресс 2026-10-03 — дедуп возвращал второму вызывающему полёт первого,
// и Stop у первого завершал и «чужой» await с AbortError при живом сигнале
// второго. Контракт: await второго участника гоняется против ЕГО сигнала,
// сам полёт при этом живёт для владельца.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _raceFlightWithSignal } from '../src/pipeline-stage1.js';

test('abort первого не отклоняет await второго при его живом сигнале', async () => {
    let rejectFlight;
    const flight = new Promise((_, reject) => { rejectFlight = reject; });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const firstAwait = _raceFlightWithSignal(flight, firstController.signal);
    const secondAwait = _raceFlightWithSignal(flight, secondController.signal);

    firstController.abort(); // Stop в контексте первого
    await assert.rejects(() => firstAwait, { name: 'AbortError' }, 'владелец сигнала получает свою отмену');
    secondController.abort(); // и второй отменяет СВОЙ await своим сигналом
    await assert.rejects(() => secondAwait, { name: 'AbortError' });
});

test('результат полёта доезжает до присоединившегося при его живом сигнале', async () => {
    let resolveFlight;
    const flight = new Promise(resolve => { resolveFlight = resolve; });
    const controller = new AbortController();
    const joined = _raceFlightWithSignal(flight, controller.signal);
    resolveFlight({ prompt: 'done' });
    assert.deepEqual(await joined, { prompt: 'done' });
    controller.abort(); // аборт ПОСЛЕ результата не портит его
    assert.deepEqual(await joined, { prompt: 'done' });
});

test('уже aborted сигнал второго отклоняет await сразу, полёт не трогается', async () => {
    const controller = new AbortController();
    controller.abort();
    const flight = Promise.resolve('owner-result');
    await assert.rejects(() => _raceFlightWithSignal(flight, controller.signal), { name: 'AbortError' });
    assert.equal(await flight, 'owner-result', 'полёт владельца продолжает жить');
});

test('без сигнала — прямое присоединение (прежнее поведение)', async () => {
    assert.equal(await _raceFlightWithSignal(Promise.resolve(42), undefined), 42);
});
