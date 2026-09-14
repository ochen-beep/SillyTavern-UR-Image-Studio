import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_TRIGGERS, REFS_POLICIES, normalizeTrigger, buildAliasIndex, resolveProfile,
    buildInlinePrompt, sanitizeTriggerList, findAliasMatch,
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

test('triggers: findAliasMatch — самое раннее вхождение в тексте (границы слов)', () => {
    const idx = buildAliasIndex(DEFAULT_TRIGGERS);
    const hit = findAliasMatch(idx, 'сделай селфи на пляже');
    assert.equal(hit.alias, 'селфи');
    assert.equal(hit.profile.id, 'selfie');
    assert.equal(hit.index, 'сделай '.length);
    assert.equal(hit.length, 'селфи'.length);
    assert.equal(findAliasMatch(idx, 'selfieee — не слово'), null);             // подстрока ≠ алиас
    assert.equal(findAliasMatch(idx, 'Сделай СЕЛФИ')?.profile.id, 'selfie');    // регистр не важен
    assert.equal(findAliasMatch(idx, ''), null);
    assert.equal(findAliasMatch(idx, null), null);
});

test('triggers: findAliasMatch экранирует метасимволы в алиасе', () => {
    const idx = buildAliasIndex([{ id: 'x', aliases: ['img(1)'] }]);
    assert.equal(findAliasMatch(idx, 'го img(1)!')?.alias, 'img(1)');
    assert.equal(findAliasMatch(idx, 'го img1'), null);                          // метасимволы — литерал, не шаблон
});

test('triggers: границы алиаса учитывают цифры (img2 ≠ img)', () => {
    const idx = buildAliasIndex(sanitizeTriggerList(null));
    assert.equal(findAliasMatch(idx, 'нарисуй img2 быстро'), null);
    const hit = findAliasMatch(idx, 'нарисуй img 2 быстро');
    assert.equal(hit?.alias, 'img');
});

test('triggers: findAliasMatch берёт раннее вхождение, а не первый алиас реестра', () => {
    const idx = buildAliasIndex([
        { id: 'img', name: 'И', aliases: ['img'], aspect: '1:1' },
        { id: 'scene', name: 'С', aliases: ['scene'], aspect: '16:9' },
    ]);
    const hit = findAliasMatch(idx, 'сначала scene, потом img');
    assert.equal(hit.alias, 'scene');
    assert.equal(hit.index, 'сначала '.length);
});

test('triggers: «фотограф сказал фото» матчит слово «фото», а не кусок «фотограф»', () => {
    const idx = buildAliasIndex(sanitizeTriggerList(null));
    const hit = findAliasMatch(idx, 'фотограф сказал фото');
    assert.equal(hit.alias, 'фото');
    assert.equal(hit.index, 'фотограф сказал '.length);
});

test('triggers: buildInlinePrompt разворачивает макросы и в desc ({{char}} photo не уезжает буквально)', () => {
    const img = DEFAULT_TRIGGERS.find(t => t.id === 'img');
    const prompt = buildInlinePrompt(img, '{{char}} photo', { charName: 'Mira' });
    assert.ok(prompt.includes('Mira photo'));
    assert.ok(!prompt.includes('{{char}}'));
});
