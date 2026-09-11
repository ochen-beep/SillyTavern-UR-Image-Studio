import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_TRIGGERS, normalizeTrigger, buildAliasIndex, resolveProfile,
    buildInlinePrompt, sanitizeTriggerList,
} from '../src/inline/triggers.js';

test('triggers: defaults include img/selfie/scene with correct shape', () => {
    const ids = DEFAULT_TRIGGERS.map(t => t.id);
    assert.deepEqual(ids, ['img', 'selfie', 'scene']);
    const selfie = DEFAULT_TRIGGERS.find(t => t.id === 'selfie');
    assert.equal(selfie.aspect, '9:16');
    assert.equal(selfie.refsPolicy, 'auto');
    assert.ok(selfie.prefix.includes('{{char}}'));
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
});

test('triggers: sanitizeTriggerList dedups ids/aliases, keeps at least img', () => {
    const list = sanitizeTriggerList([
        { id: 'img', name: 'Картинка', aliases: ['img'], aspect: '1:1', prefix: '', suffix: '', refsPolicy: 'auto' },
        { id: 'IMG', name: 'Дубль', aliases: ['img'], aspect: '2:3', prefix: '', suffix: '', refsPolicy: 'off' },
        { id: 'ok', name: 'Ок', aliases: ['ок'], aspect: '3:4', prefix: '', suffix: '', refsPolicy: 'auto' },
    ]);
    assert.equal(list.length, 2);
    assert.equal(list[0].aspect, '1:1');           // первый wins по id
    assert.ok(list.some(t => t.id === 'ok'));
});
