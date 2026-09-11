import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planScan, stableHash, buildJobPlan } from '../src/inline/runner.js';
import { parseInline } from '../src/inline/grammar.js';
import { normalizeTrigger } from '../src/inline/triggers.js';

test('planScan: new marker in auto mode → queue', () => {
    const markers = parseInline('ответ [[img: чашка кофе]]');
    const actions = planScan({ msgId: 5, messageHash: 'h1', markers, stored: { messageHash: null, items: [] }, auto: true });
    assert.deepEqual(actions.map(a => a.action), ['store-pending', 'queue']);
});

test('planScan: same marker+hash ready → render only (перезагрузка бесплатна)', () => {
    const markers = parseInline('ответ [[img: чашка кофе]]');
    const stored = { messageHash: 'h1', items: [{ idx: 0, type: 'img', descHash: 'h2', status: 'ready', imagePath: 'p.png' }] };
    // descHash = hash('img|чашка кофе') — считается внутри planScan; здесь подменяем согласованно:
    const actions = planScan({ msgId: 5, messageHash: 'h1', markers, stored, auto: true, hashFn: (s) => s === 'img|чашка кофе' ? 'h2' : s });
    assert.deepEqual(actions.map(a => a.action), ['render-ready']);
});

test('planScan: desc changed → render-changed, no auto generation', () => {
    const markers = parseInline('ответ [[img: новое описание]]');
    const stored = { messageHash: 'h1', items: [{ idx: 0, type: 'img', descHash: 'old', status: 'ready', imagePath: 'p.png' }] };
    const actions = planScan({ msgId: 5, messageHash: 'h1', markers, stored, auto: true, hashFn: (s) => s });
    assert.deepEqual(actions.map(a => a.action), ['render-changed']);
});

test('planScan: manual mode → render-button for new markers', () => {
    const markers = parseInline('ответ [[img: чашка]]');
    const actions = planScan({ msgId: 5, messageHash: 'h1', markers, stored: { messageHash: null, items: [] }, auto: false, hashFn: (s) => s });
    assert.deepEqual(actions.map(a => a.action), ['render-button']);
});

test('planScan: cap markers per message (default 3)', () => {
    const markers = parseInline('[[img: a]] [[img: b]] [[img: c]] [[img: d]]');
    const actions = planScan({ msgId: 1, messageHash: 'h', markers, stored: { messageHash: null, items: [] }, auto: true, hashFn: (s) => s, cap: 3 });
    assert.equal(actions.filter(a => a.action === 'queue').length, 3);
    assert.equal(actions.filter(a => a.action === 'render-button').length, 1); // сверх лимита — кнопки
});

// — Issue 2: lookup item'а раньше cap — маркер, уехавший за cap после правки
// выше, не должен превращать готовую (оплаченную) картинку в платную кнопку.

test('planScan: over-cap marker с существующим ready item → render-ready, не кнопка', () => {
    const markers = parseInline('[[img: a]] [[img: b]] [[img: c]] [[img: d]]');
    const stored = { messageHash: 'h', items: [{ idx: 3, type: 'img', descHash: 'img|d', status: 'ready', imagePath: 'p.png' }] };
    const actions = planScan({ msgId: 1, messageHash: 'h', markers, stored, auto: true, hashFn: (s) => s, cap: 3 });
    assert.deepEqual(actions.filter(a => a.marker.desc === 'd').map(a => a.action), ['render-ready']); // готовый результат — бесплатный рендер, cap не важен
});

// — Issue 1: pending не крутит спиннер вечно (осиротел после перезагрузки/краша).

test('planScan: fresh pending (в грейс-окне) → render-pending', () => {
    const markers = parseInline('[[img: чашка]]');
    const stored = { messageHash: null, items: [{ idx: 0, type: 'img', descHash: 'img|чашка', status: 'pending', requestId: 'r1', createdAt: 0 }] };
    const actions = planScan({ msgId: 1, messageHash: 'h', markers, stored, auto: true, hashFn: (s) => s, now: () => 60_000 });
    assert.deepEqual(actions.map(a => a.action), ['render-pending']);
});

test('planScan: live requestId in inFlight → render-pending даже за грейсом', () => {
    const markers = parseInline('[[img: чашка]]');
    const stored = { messageHash: null, items: [{ idx: 0, type: 'img', descHash: 'img|чашка', status: 'pending', requestId: 'r1', createdAt: 0 }] };
    const actions = planScan({ msgId: 1, messageHash: 'h', markers, stored, auto: true, hashFn: (s) => s, inFlight: new Set(['r1']), now: () => 1_000_000 });
    assert.deepEqual(actions.map(a => a.action), ['render-pending']); // inFlight важнее грейса
});

test('planScan: orphaned pending (за грейсом, не inFlight) → render-error (retry, не спиннер)', () => {
    const markers = parseInline('[[img: чашка]]');
    const stored = { messageHash: null, items: [{ idx: 0, type: 'img', descHash: 'img|чашка', status: 'pending', requestId: 'r1', createdAt: 0 }] };
    const actions = planScan({ msgId: 1, messageHash: 'h', markers, stored, auto: true, hashFn: (s) => s, now: () => 1_000_000 });
    assert.deepEqual(actions.map(a => a.action), ['render-error']);
});

// — Fold: готовый item без файла — ошибка материализации, оболочке нужен retry.

test('planScan: ready без imagePath → render-error', () => {
    const markers = parseInline('[[img: чашка]]');
    const stored = { messageHash: null, items: [{ idx: 0, type: 'img', descHash: 'img|чашка', status: 'ready', imagePath: null }] };
    const actions = planScan({ msgId: 1, messageHash: 'h', markers, stored, auto: true, hashFn: (s) => s });
    assert.deepEqual(actions.map(a => a.action), ['render-error']);
});

// — Ветка ошибки: сохранённая ошибка генерации показывается с retry.

test('planScan: error item → render-error с item', () => {
    const markers = parseInline('[[img: чашка]]');
    const stored = { messageHash: null, items: [{ idx: 0, type: 'img', descHash: 'img|чашка', status: 'error', error: 'boom' }] };
    const actions = planScan({ msgId: 1, messageHash: 'h', markers, stored, auto: true, hashFn: (s) => s });
    assert.deepEqual(actions.map(a => a.action), ['render-error']);
});

// — knownTypes: мусорные типы от LLM не доходят до движка (TRIGGER_NOT_FOUND).

test('planScan: unknown type → skip-unknown', () => {
    const markers = parseInline('ответ [[бред: суп]] [[img: чашка]]');
    const actions = planScan({ msgId: 1, messageHash: 'h', markers, stored: { messageHash: null, items: [] }, auto: true, hashFn: (s) => s, knownTypes: new Set(['img']) });
    assert.deepEqual(actions.map(a => a.action), ['skip-unknown', 'store-pending', 'queue']);
});

// — Золотое значение хеша: смена stableHash тихо осиротит все сохранённые
// descHash и вызовет перегенерацию всего; значение зафиксировано тестом.

test('stableHash: golden FNV-1a hex для img|d', () => {
    assert.equal(stableHash('img|d'), '6998fd64');
});

// — buildJobPlan: чистая сборка плана (промпт/аспект/политика рефов).

test('buildJobPlan: prompt = shell + macros, refs policy off → без резолвера', () => {
    const trigger = normalizeTrigger({ id: 'scene', name: 'Сцена', aliases: ['scene'],
        aspect: '16:9', prefix: 'cinematic shot, ', suffix: '', refsPolicy: 'off' });
    const plan = buildJobPlan({ trigger, desc: 'ночной город', macros: { charName: 'Илюха' } });
    assert.equal(plan.prompt, 'cinematic shot, ночной город');
    assert.equal(plan.aspect, '16:9');
    assert.equal(plan.refs, null);                 // refsPolicy off → авторефов нет
});

test('buildJobPlan: refs auto → флаг авто-референсов', () => {
    const trigger = normalizeTrigger({ id: 'img', name: 'К', aliases: ['img'], aspect: '1:1',
        prefix: '', suffix: '', refsPolicy: 'auto' });
    const plan = buildJobPlan({ trigger, desc: 'чашка кофе' });
    assert.equal(plan.refs, 'auto');
});
