import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_TRIGGERS, REFS_POLICIES, normalizeTrigger, buildAliasIndex, resolveProfile,
    buildInlinePrompt, sanitizeTriggerList,
} from '../src/inline/triggers.js';

test('triggers: defaults include img/selfie/scene with correct shape', () => {
    const ids = DEFAULT_TRIGGERS.map(t => t.id);
    assert.deepEqual(ids, ['img', 'selfie', 'scene']);
    const selfie = DEFAULT_TRIGGERS.find(t => t.id === 'selfie');
    assert.equal(selfie.aspect, '9:16');
    assert.equal(selfie.refsPolicy, 'auto');
    assert.ok(selfie.prefix.includes('{{char}}'));
    assert.ok(Object.isFrozen(REFS_POLICIES));
});

test('triggers: normalizeTrigger clamps and defaults', () => {
    const t = normalizeTrigger({ id: ' X ', name: 'Тест', aliases: ['Алиас', '', 'алиас2'],
        aspect: '9:16', prefix: 'p ', suffix: ' s', refsPolicy: 'weird' });
    assert.equal(t.id, 'x');                       // id нормализуется в lower/trim
    assert.deepEqual(t.aliases, ['алиас', 'алиас2']);
    assert.equal(t.refsPolicy, 'auto');            // невалидная политика → auto
    assert.equal(t.prefix, 'p');
    assert.equal(t.suffix, 's');
    assert.throws(() => normalizeTrigger({ aliases: [] }), /aliases/);
    const ye = normalizeTrigger({ id: 'e', name: 'Е', aliases: ['ёж'], aspect: '1:1', prefix: '', suffix: '', refsPolicy: 'auto' });
    assert.ok(ye.aliases.includes('еж'));          // ё→е в алиасах, как и в типах
    assert.equal(normalizeTrigger({ id: 'w', aliases: ['w'], aspect: 'not an aspect ;; drop table' }).aspect, '1:1');
    assert.equal(normalizeTrigger({ id: 'w', aliases: ['w'], aspect: ' 9:16 ' }).aspect, '9:16');
    assert.throws(() => normalizeTrigger({ aliases: ['x'.repeat(65)] }), /aliases/);   // алиас >64 отброшен
    assert.equal(normalizeTrigger({ id: 'w', aliases: ['x'.repeat(64)] }).aliases[0].length, 64);
});

test('triggers: alias index resolves type→profile, ё/регистр', () => {
    const idx = buildAliasIndex(DEFAULT_TRIGGERS);
    assert.equal(resolveProfile(idx, 'СЕЛФИ').id, 'selfie');
    assert.equal(resolveProfile(idx, 'img').id, 'img');
    assert.equal(resolveProfile(idx, 'неизвестный'), null);
});

test('triggers: buildInlinePrompt = prefix + macros(desc) + suffix', () => {
    const selfie = DEFAULT_TRIGGERS.find(t => t.id === 'selfie');
    const prompt = buildInlinePrompt(selfie, 'на пляже', { charName: 'Илюха' });
    assert.ok(prompt.startsWith('candid phone selfie of Илюха'));
    assert.ok(prompt.includes('на пляже'));
    // склейка: запятая на стыке читается «…, на пляже», а не «…,на пляже»
    assert.ok(prompt.startsWith('candid phone selfie of Илюха, на пляже'));
});

test('triggers: buildInlinePrompt joins non-empty parts with a single space', () => {
    // prefix без хвостового пробела + desc → ровно один пробел (не «ab», не «a  b»)
    assert.equal(buildInlinePrompt({ prefix: 'a', suffix: '' }, 'b'), 'a b');
    // prefix с запятой на стыке → «a, b»
    assert.equal(buildInlinePrompt({ prefix: 'a,', suffix: '' }, 'b'), 'a, b');
    // пустые части выпадают, лишние пробелы схлопываются
    assert.equal(buildInlinePrompt({ prefix: '', suffix: ' c ' }, '  b  '), 'b c');
    assert.equal(buildInlinePrompt({ prefix: '  ', suffix: '' }, 'only'), 'only');
});

test('triggers: sanitizeTriggerList dedups ids (first-wins), keeps img', () => {
    const list = sanitizeTriggerList([
        { id: 'img', name: 'Картинка', aliases: ['img'], aspect: '1:1', prefix: '', suffix: '', refsPolicy: 'auto' },
        { id: 'IMG', name: 'Дубль', aliases: ['img'], aspect: '2:3', prefix: '', suffix: '', refsPolicy: 'off' },
        { id: 'ok', name: 'Ок', aliases: ['ок'], aspect: '3:4', prefix: '', suffix: '', refsPolicy: 'auto' },
    ]);
    assert.equal(list.length, 2);
    assert.equal(list[0].aspect, '1:1');           // первый wins по id
    assert.ok(list.some(t => t.id === 'ok'));
    const first = buildAliasIndex([{ id: 'a', aliases: ['X', 'ёж'] }, { id: 'b', aliases: ['x'] }]);
    assert.equal(first.get('x').id, 'a');          // первый wins по алиасу
    assert.equal(first.get('еж').id, 'a');         // ключи алиасов: lower + ё→е
});

test('triggers: buildInlinePrompt is $-safe for names', () => {
    const selfie = DEFAULT_TRIGGERS.find(t => t.id === 'selfie');
    const prompt = buildInlinePrompt(selfie, 'beach', { charName: 'Alice$&$\'X' });
    assert.ok(prompt.includes("Alice$&$'X"));
    assert.ok(!prompt.includes('{{char}}'));
});
