import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planScan } from '../src/inline/runner.js';
import { parseInline } from '../src/inline/grammar.js';

const MODE = { auto: true };

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
