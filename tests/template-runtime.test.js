// @ts-check
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const memoryStore = new Map();
const logs = [];
const originalConsoleLog = console.log;

function makeLocalforage() {
    return {
        async getItem(key) { return memoryStore.has(key) ? memoryStore.get(key) : []; },
        async setItem(key, value) { memoryStore.set(key, value); },
        async removeItem(key) { memoryStore.delete(key); },
    };
}

globalThis.SillyTavern = {
    getContext: () => ({
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        saveMetadata: () => {},
        getRequestHeaders: () => ({}),
    }),
    libs: { localforage: makeLocalforage() },
};
globalThis.toastr = undefined;

beforeEach(() => {
    memoryStore.clear();
    logs.length = 0;
    console.log = (...args) => logs.push(args);
    resetTemplateStoreForTests();
    setTemplateStoreForTests({
        available: async () => true,
        async list() { return memoryStore.get(core.LF_TEMPLATES) ?? []; },
        async create(record) {
            const records = memoryStore.get(core.LF_TEMPLATES) ?? [];
            records.push(record);
            memoryStore.set(core.LF_TEMPLATES, records);
            return record;
        },
        async update(id, record) {
            const records = memoryStore.get(core.LF_TEMPLATES) ?? [];
            const index = records.findIndex(item => item.id === id);
            records[index] = { ...record, id };
            memoryStore.set(core.LF_TEMPLATES, records);
            return records[index];
        },
        async delete(id) {
            const records = memoryStore.get(core.LF_TEMPLATES) ?? [];
            memoryStore.set(core.LF_TEMPLATES, records.filter(item => item.id !== id));
        },
    });
});

const core = await import('../src/core.js');

const {
    listTemplates,
    getTemplate,
    classifyTemplate,
    createInstructionTemplate,
    saveTemplate,
    setTemplateStoreForTests,
    resetTemplateStoreForTests,
} = await import('../src/prompt-templates.js');

const { BASE_SCENE_INSTRUCTION, buildStage1Messages, executeStage1 } = await import('../src/template-runtime.js');
import { normalizeSceneEntity } from '../src/scene-context.js';

function makeSnapshot(messageText, entities = []) {
    return {
        chatId: 'chat-1',
        msgId: 9,
        messageHash: 'hash',
        contextRevision: 2,
        entities,
        stage1Descriptions: entities
            .filter(e => e.description)
            .map(e => ({ id: e.id, name: e.name, description: e.description })),
        stage2Refs: [],
        ambiguities: [],
        matchedReferences: [],
    };
}

test('listTemplates retains only instruction records without rewriting unsupported stored records', async () => {
    const stored = [
        { id: 'instruction', name: 'Director', type: 'instruction', instruction: 'Direct.' },
        { id: 'fields', name: 'Fields', type: 'fields', fields: [] },
        { id: 'v3', name: 'Legacy', content: { schemaVersion: 3 } },
    ];
    memoryStore.set(core.LF_TEMPLATES, stored);

    const templates = await listTemplates();

    assert.deepEqual(templates, [stored[0]]);
    assert.strictEqual(memoryStore.get(core.LF_TEMPLATES), stored);
});

test('classifyTemplate recognizes only base and instruction templates', () => {
    assert.equal(classifyTemplate(null), 'base');
    assert.equal(classifyTemplate({ type: 'instruction', instruction: 'Direct.' }), 'instruction');
    assert.throws(() => classifyTemplate({ type: 'fields', fields: [] }), /Unsupported template format/);
    assert.throws(() => classifyTemplate({ content: { schemaVersion: 3 } }), /Unsupported template format/);
});

test('createInstructionTemplate starts empty', async () => {
    const instruction = await createInstructionTemplate({ name: 'Director' });
    assert.deepEqual(instruction, {
        id: instruction.id,
        name: 'Director',
        type: 'instruction',
        instruction: '',
        createdAt: instruction.createdAt,
        updatedAt: instruction.updatedAt,
    });
    assert.deepEqual(await listTemplates(), [instruction]);
});

test('saveTemplate rejects unsupported records', async () => {
    const instruction = await createInstructionTemplate({ name: 'Director' });
    await assert.rejects(
        () => saveTemplate({ ...instruction, instruction: 123 }),
        /Instruction template content must be a string/
    );
    await assert.rejects(
        () => saveTemplate({ id: instruction.id, type: 'fields', fields: [] }),
        /Unsupported template format/
    );
});

test('getTemplate does not return unsupported stored records', async () => {
    memoryStore.set(core.LF_TEMPLATES, [
        { id: 'legacy', name: 'Legacy', content: { schemaVersion: 3 } },
    ]);
    assert.equal(await getTemplate('legacy'), null);
});

test('buildStage1Messages base mode contains scene instruction and text', () => {
    const snapshot = makeSnapshot('She enters.');
    const result = buildStage1Messages({ template: null, messageText: 'She enters.', snapshot });
    assert.equal(result.templateType, 'base');
    assert.equal(result.system, BASE_SCENE_INSTRUCTION);
    assert.match(result.user, /She enters\./);
});

test('buildStage1Messages instruction mode uses template instruction', () => {
    const snapshot = makeSnapshot('She enters.');
    const template = { id: 't1', type: 'instruction', instruction: 'You are a director.' };
    const result = buildStage1Messages({ template, messageText: 'She enters.', snapshot });
    assert.equal(result.templateType, 'instruction');
    assert.equal(result.system, 'You are a director.');
    assert.match(result.user, /She enters\./);
});

test('buildStage1Messages rejects unsupported template formats', () => {
    const snapshot = makeSnapshot('She enters.');
    assert.throws(
        () => buildStage1Messages({ template: { type: 'fields', fields: [] }, messageText: 'She enters.', snapshot }),
        /Unsupported template format/
    );
});

test('buildStage1Messages instruction mode rejects empty instruction', () => {
    const snapshot = makeSnapshot('She enters.');
    const template = { id: 't1', type: 'instruction', instruction: '' };
    assert.throws(
        () => buildStage1Messages({ template, messageText: 'She enters.', snapshot }),
        /Template instruction is empty/
    );
});

test('executeStage1 calls generateText exactly once and returns plain instruction output', async () => {
    let calls = 0;
    const snapshot = makeSnapshot('She enters.', [
        normalizeSceneEntity({ id: 'aria', name: 'Aria', aliases: [], description: 'blonde', imagePath: '' }),
    ]);
    const result = await executeStage1({
        template: { id: 't1', type: 'instruction', instruction: 'Direct the scene.' },
        messageText: 'She enters.',
        snapshot,
        generateText: async () => {
            calls += 1;
            return 'A blonde woman enters a room.';
        },
    });
    assert.equal(calls, 1);
    assert.equal(result.templateType, 'instruction');
    assert.equal(result.prompt, 'A blonde woman enters a room.');
    assert.equal(result.structuredDraft, null);
    assert.equal(result.sourceMsgId, 9);
    assert.equal(result.contextRevision, 2);
});

test('executeStage1 base mode returns plain prompt', async () => {
    const snapshot = makeSnapshot('She enters.');
    const result = await executeStage1({
        template: null,
        messageText: 'She enters.',
        snapshot,
        generateText: async () => 'A girl enters a room.',
    });
    assert.equal(result.templateType, 'base');
    assert.equal(result.prompt, 'A girl enters a room.');
});

function fakeMacroResolver(text) {
    return String(text)
        .replaceAll('{{char}}', 'Aria')
        .replaceAll('{{user}}', 'John');
}

test('buildStage1Messages instruction mode expands ST macros in system and user', () => {
    const snapshot = makeSnapshot('{{char}} walks in.');
    const template = {
        id: 't1',
        type: 'instruction',
        instruction: 'Describe {{char}} for {{user}}.',
    };
    const result = buildStage1Messages({
        template,
        messageText: '{{char}} walks in.',
        snapshot,
        macroResolver: fakeMacroResolver,
    });
    assert.equal(result.templateType, 'instruction');
    assert.equal(result.system, 'Describe Aria for John.');
    assert.match(result.user, /Aria walks in\./);
    assert.doesNotMatch(result.user, /\{\{char\}\}/);
});

test('buildStage1Messages base mode expands ST macros in user scene text', () => {
    const snapshot = makeSnapshot('{{char}} arrives.');
    const result = buildStage1Messages({
        template: null,
        messageText: '{{char}} arrives.',
        snapshot,
        macroResolver: fakeMacroResolver,
    });
    assert.equal(result.templateType, 'base');
    assert.match(result.user, /Aria arrives\./);
    assert.doesNotMatch(result.user, /\{\{char\}\}/);
});

test.after(() => {
    console.log = originalConsoleLog;
});
