import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planScan, stableHash, buildJobPlan, DEFAULT_GRACE } from '../src/inline/runner.js';
import { fnv1aHex } from '../src/core.js';
import { parseInline } from '../src/inline/grammar.js';
import { normalizeTrigger } from '../src/inline/triggers.js';

// planScan решает ТОЛЬКО постановку платных генераций (store-pending/queue).
// Отображение статусов (ready/pending/changed/error/button) — computeShellPlan
// в render.js; тесты pending/grace/orphan живут там же (tests/inline-render.test.js).

test('planScan: new marker in auto mode → store-pending + queue', () => {
    const markers = parseInline('ответ [[img: чашка кофе]]');
    const actions = planScan({ msgId: 5, messageHash: 'h1', markers, stored: { messageHash: null, items: [] }, auto: true });
    assert.deepEqual(actions.map(a => a.action), ['store-pending', 'queue']);
});

test('planScan: готовый item по ключу → постановки нет (рендер бесплатен)', () => {
    const markers = parseInline('ответ [[img: чашка кофе]]');
    const stored = { messageHash: 'h1', items: [{ idx: 0, type: 'img', descHash: 'h2', status: 'ready', imagePath: 'p.png' }] };
    const actions = planScan({ msgId: 5, messageHash: 'h1', markers, stored, auto: true, hashFn: (s) => s === 'img|чашка кофе' ? 'h2' : s });
    assert.deepEqual(actions, []);
});

// — Issue 2: lookup item'а раньше cap — маркер, уехавший за cap после правки
// выше, не должен превращать готовую (оплаченную) картинку в платную постановку.

test('planScan: over-cap marker с существующим ready item → без повторной постановки', () => {
    const markers = parseInline('[[img: a]] [[img: b]] [[img: c]] [[img: d]]');
    const stored = { messageHash: 'h', items: [{ idx: 3, type: 'img', descHash: 'img|d', status: 'ready', imagePath: 'p.png' }] };
    const actions = planScan({ msgId: 1, messageHash: 'h', markers, stored, auto: true, hashFn: (s) => s, cap: 3 });
    // Готовый результат не перегенерируется, cap не важен; новые маркеры a/b/c ставятся.
    assert.deepEqual(actions.filter(a => a.marker.desc === 'd'), []);
    assert.equal(actions.filter(a => a.action === 'queue').length, 3);
});

test('planScan: desc changed → постановки нет (перерисовка только вручную)', () => {
    const markers = parseInline('ответ [[img: новое описание]]');
    const stored = { messageHash: 'h1', items: [{ idx: 0, type: 'img', descHash: 'old', status: 'ready', imagePath: 'p.png' }] };
    const actions = planScan({ msgId: 5, messageHash: 'h1', markers, stored, auto: true, hashFn: (s) => s });
    assert.deepEqual(actions, []); // автогенерация за правку слова платила бы дважды
});

test('planScan: manual mode → постановки нет для новых маркеров', () => {
    const markers = parseInline('ответ [[img: чашка]]');
    const actions = planScan({ msgId: 5, messageHash: 'h1', markers, stored: { messageHash: null, items: [] }, auto: false, hashFn: (s) => s });
    assert.deepEqual(actions, []);
});

test('planScan: cap markers per message (default 3)', () => {
    const markers = parseInline('[[img: a]] [[img: b]] [[img: c]] [[img: d]]');
    const actions = planScan({ msgId: 1, messageHash: 'h', markers, stored: { messageHash: null, items: [] }, auto: true, hashFn: (s) => s, cap: 3 });
    assert.equal(actions.filter(a => a.action === 'queue').length, 3); // сверх лимита — без постановки (кнопку даст render.js)
});

// — Живой pending/error/ready-без-файла: повторной платной постановки нет ни в
// каком виде; что показывать — решает computeShellPlan по живым requestId.

test('planScan: pending item по ключу → повторной постановки нет (нет дубля в очереди)', () => {
    const markers = parseInline('[[img: чашка]]');
    const stored = { messageHash: null, items: [{ idx: 0, type: 'img', descHash: 'img|чашка', status: 'pending', requestId: 'r1', createdAt: 0 }] };
    const actions = planScan({ msgId: 1, messageHash: 'h', markers, stored, auto: true, hashFn: (s) => s });
    assert.deepEqual(actions, []);
});

test('planScan: error item → автопостановки нет (retry вручную)', () => {
    const markers = parseInline('[[img: чашка]]');
    const stored = { messageHash: null, items: [{ idx: 0, type: 'img', descHash: 'img|чашка', status: 'error', error: 'boom' }] };
    const actions = planScan({ msgId: 1, messageHash: 'h', markers, stored, auto: true, hashFn: (s) => s });
    assert.deepEqual(actions, []);
});

test('planScan: ready без imagePath → постановки нет (статус у render.js)', () => {
    const markers = parseInline('[[img: чашка]]');
    const stored = { messageHash: null, items: [{ idx: 0, type: 'img', descHash: 'img|чашка', status: 'ready', imagePath: null }] };
    const actions = planScan({ msgId: 1, messageHash: 'h', markers, stored, auto: true, hashFn: (s) => s });
    assert.deepEqual(actions, []);
});

// — knownTypes: мусорные типы от LLM не доходят до движка (TRIGGER_NOT_FOUND).

test('planScan: unknown type → skip-unknown, остальные ставятся', () => {
    const markers = parseInline('ответ [[бред: суп]] [[img: чашка]]');
    const actions = planScan({ msgId: 1, messageHash: 'h', markers, stored: { messageHash: null, items: [] }, auto: true, hashFn: (s) => s, knownTypes: new Set(['img']) });
    assert.deepEqual(actions.map(a => a.action), ['skip-unknown', 'store-pending', 'queue']);
});

// — Золотое значение хеша: смена stableHash тихо осиротит все сохранённые
// descHash и вызовет перегенерацию всего; значение зафиксировано тестом.

test('stableHash: golden FNV-1a hex для img|d и общий core primitive', () => {
    assert.equal(stableHash('img|d'), '6998fd64');
    assert.equal(stableHash('img|d'), fnv1aHex('img|d'));
    assert.equal(stableHash(''), fnv1aHex(''));
});

test('DEFAULT_GRACE: экспортируется для computeShellPlan (общее окно осиротевших pending)', () => {
    assert.equal(typeof DEFAULT_GRACE, 'number');
    assert.ok(DEFAULT_GRACE > 0);
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
