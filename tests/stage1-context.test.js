// @ts-check
// stage1-context.js: persona / {{char}} card / lorebook / history blocks
// for Stage 1. Toggles are off by default — parts is empty; each enabled
// block lands as its own string; history stops at the anchor post and skips
// is_system/is_hidden.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let core;
let mod;

beforeEach(async () => {
    globalThis.SillyTavern = { getContext: () => ({ extensionSettings: {}, saveSettingsDebounced: () => {} }) };
    core = await import('../src/core.js');
    core.state.settings = {
        stage1IncludePersona: false,
        stage1IncludeCharacter: false,
        stage1IncludeLore: false,
        stage1HistoryDepth: 0,
    };
    mod = await import('../src/stage1-context.js');
});

const CTX = {
    name1: 'Аня',
    name2: 'Загрей',
    characterId: 0,
    characters: [{ name: 'Zagreus', description: 'Принц Подземного мира.', personality: 'Дерзкий и тёплый.' }],
    powerUserSettings: { persona_description: 'Я — Аня, тихая зритeльница.' },
    chatMetadata: { world_info: 'Hades Book' },
    loadWorldInfo: async (book) => ({
        entries: {
            1: { uid: 1, comment: 'Щедрость', content: 'Контракты Подземного мира не берут обратно.', disable: false },
            2: { uid: 2, comment: 'Мёртвый', content: 'Никогда не должен попасть в ответ.', disable: true },
            3: { uid: 3, content: 'Без комментария, но рабочий.', disable: false },
        },
    }),
    chat: [
        { is_user: true, name: 'Аня', mes: 'привет' },
        { is_system: true, mes: 'system noise' },
        { is_user: false, name: 'Загрей', mes: 'Здравствуй, чемпион.' },
        { is_user: true, name: 'Аня', mes: 'что на обед?', is_hidden: true },
        { is_user: false, name: 'Загрей', mes: 'Ужин в Элизиуме.' },
    ],
};

test('по умолчанию все блоки выключены — parts пуст', async () => {
    const parts = await mod.buildStage1ContextParts(CTX, { msgId: null });
    assert.deepEqual(parts, []);
});

test('персона и карточка {{char}} включаются тумблерами и несут содержимое', async () => {
    core.state.settings.stage1IncludePersona = true;
    core.state.settings.stage1IncludeCharacter = true;
    const parts = await mod.buildStage1ContextParts(CTX, {});
    assert.equal(parts.length, 2);
    assert.match(parts[0], /\[Persona \(\{\{user\}\}\)/);
    assert.match(parts[0], /тихая зритeльница/);
    assert.match(parts[1], /\[Character \(\{\{char\}\}\): Zagreus/);
    assert.match(parts[1], /Принц Подземного мира/);
    assert.match(parts[1], /Дерзкий и тёплый/);
});

test('лорбук: только включённые записи, сортировка по uid, обрезка disable', async () => {
    core.state.settings.stage1IncludeLore = true;
    const parts = await mod.buildStage1ContextParts(CTX, {});
    assert.equal(parts.length, 1);
    assert.match(parts[0], /\[Lorebook:/);
    assert.match(parts[0], /Контракты Подземного мира/);
    assert.match(parts[0], /Без комментария/);
    assert.doesNotMatch(parts[0], /Никогда не должен/);
});

test('история: depth сообщений до якоря, без system/hidden, формат «Имя: текст»', async () => {
    core.state.settings.stage1HistoryDepth = 10;
    const parts = await mod.buildStage1ContextParts(CTX, { msgId: 4 });
    assert.equal(parts.length, 1);
    // якорь #4 — сам не попадает; system/hidden отброшены; порядок сверху вниз
    assert.equal(parts[0], '[Chat history (earlier messages; context only, do NOT react to these as current):\nАня: привет\nЗагрей: Здравствуй, чемпион.]');
});

test('без якоря (msgId=null) история берёт хвост чата', async () => {
    core.state.settings.stage1HistoryDepth = 2;
    const parts = await mod.buildStage1ContextParts(CTX, { msgId: null });
    assert.match(parts[0], /Загрей: Ужин в Элизиуме/);
    assert.doesNotMatch(parts[0], /привет/);
});

test('нет loadWorldInfo / нет чата — блоки просто пустые, без падений', async () => {
    core.state.settings.stage1IncludePersona = true;
    core.state.settings.stage1IncludeLore = true;
    core.state.settings.stage1HistoryDepth = 5;
    const parts = await mod.buildStage1ContextParts({}, {});
    assert.deepEqual(parts, []);
});

test('buildProfileMessages: массив user-блоков → отдельные {role:user} сообщения', async () => {
    const { buildProfileMessages } = await import('../src/text-connection.js');
    const messages = buildProfileMessages('system', ['scene', '[Persona: x]', '[Lorebook:\n- a: b]']);
    assert.deepEqual(messages, [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'scene' },
        { role: 'user', content: '[Persona: x]' },
        { role: 'user', content: '[Lorebook:\n- a: b]' },
    ]);
    // строка (без контекста) — прежняя форма
    assert.deepEqual(buildProfileMessages('s', 'only user'), [
        { role: 'system', content: 's' },
        { role: 'user', content: 'only user' },
    ]);
});
