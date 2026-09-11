import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline } from '../src/inline/grammar.js';

test('grammar: parses type and description', () => {
    const m = parseInline('го смотри [[img: чашка кофе, пепел от сигаретки]] ща скину');
    assert.equal(m.length, 1);
    assert.equal(m[0].type, 'img');
    assert.equal(m[0].desc, 'чашка кофе, пепел от сигаретки');
    assert.equal(m[0].raw, '[[img: чашка кофе, пепел от сигаретки]]');
    assert.ok(m[0].start < m[0].end);
});

test('grammar: fast-path returns empty array without [[', () => {
    assert.deepEqual(parseInline('обычный текст без маркеров'), []);
    assert.deepEqual(parseInline(''), []);
    assert.deepEqual(parseInline(null), []);
});

test('grammar: multiple markers with offsets', () => {
    const m = parseInline('[[selfie: beach at sunset]] и [[scene: rainy neon city]]');
    assert.equal(m.length, 2);
    assert.equal(m[0].type, 'selfie');
    assert.equal(m[1].type, 'scene');
    assert.ok(m[0].end <= m[1].start);
});

test('grammar: cyrillic and digits in type, case-insensitive', () => {
    const m = parseInline('[[СЕЛФИ: портрет]]');
    assert.equal(m[0].type, 'селфи');
});

test('grammar: negative cases produce no markers', () => {
    assert.deepEqual(parseInline('[[img нет двоеточия]]'), []);
    assert.deepEqual(parseInline('[[img:]]'), []);                    // пустое описание
    assert.deepEqual(parseInline('[[img:   ]]'), []);                 // trim-skip branch
    assert.deepEqual(parseInline('[[тип с пробелом: описание]]'), []);
    assert.deepEqual(parseInline('[[img: не закрыта'), []);
    assert.equal(parseInline('[[img:]][[scene: ok]]').length, 1);   // пустое описание пропущено
    assert.equal(parseInline('[[img:   ]][[scene: ok]]').length, 1);
});

test('grammar: hostile input does not hang (ReDoS guard)', () => {
    const t0 = Date.now();
    assert.deepEqual(parseInline('[[img: ' + 'x'.repeat(100_000)), []);
    // пробелы — реальный триггер квадратичного бэктрекинга (x-и не воспроизводят)
    assert.deepEqual(parseInline('[[a:' + ' '.repeat(10_000)), []);
    assert.ok(Date.now() - t0 < 1000);
});

test('grammar: markers inside code fences are ignored', () => {
    const text = 'текст\n```\n[[img: в коде]]\n```\n[[scene: настоящий]]';
    const m = parseInline(text);
    assert.equal(m.length, 1);
    assert.equal(m[0].type, 'scene');
});

test('grammar: description length guard (600 chars)', () => {
    const long = 'x'.repeat(601);
    assert.deepEqual(parseInline(`[[img: ${long}]]`), []);
    assert.equal(parseInline(`[[img: ${'x'.repeat(600)}]]`).length, 1);
});
