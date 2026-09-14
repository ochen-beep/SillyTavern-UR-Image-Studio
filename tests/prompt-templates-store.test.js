import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

const memoryStore = new Map();
const extensionSettings = {};
let saveCalls = 0;
const originalSt = globalThis.SillyTavern;
const originalToastr = globalThis.toastr;

globalThis.SillyTavern = {
  getContext: () => ({
    extensionSettings,
    saveSettingsDebounced: () => { saveCalls += 1; },
    saveMetadata: () => {},
    getRequestHeaders: () => ({}),
  }),
  libs: {
    localforage: {
      async getItem(key) { return memoryStore.get(key) ?? []; },
      async setItem(key, value) { memoryStore.set(key, value); },
      async removeItem(key) { memoryStore.delete(key); },
    },
  },
};
globalThis.toastr = undefined;

const core = await import('../src/core.js');
const templates = await import('../src/prompt-templates.js');

beforeEach(() => {
  memoryStore.clear();
  for (const key of Object.keys(extensionSettings)) delete extensionSettings[key];
  saveCalls = 0;
  templates.resetTemplateStoreForTests();
});
afterEach(() => templates.resetTemplateStoreForTests());

function availableStore(seed = []) {
  const records = [...seed];
  const calls = [];
  return {
    calls,
    async available() { return true; },
    async list() { calls.push(['list']); return structuredClone(records); },
    async create(payload) { calls.push(['create', payload]); records.push({ ...payload }); return { ...payload }; },
    async update(id, payload) {
      calls.push(['update', id, payload]);
      const index = records.findIndex(item => item.id === id);
      records[index] = { ...payload, id };
      return { ...records[index] };
    },
    async delete(id) { calls.push(['delete', id]); records.splice(records.findIndex(item => item.id === id), 1); },
  };
}

describe('shared prompt templates', () => {
  it('lists supported templates from shared settings and caches the first projection', async () => {
    extensionSettings.ur_image_studio = {
      imageConnections: {
        templates: [
          { id: 'instruction', name: 'Director', type: 'instruction', instruction: 'Direct.' },
          { id: 'legacy', type: 'fields', fields: [] },
        ],
      },
    };

    const first = await templates.listTemplates();
    const second = await templates.listTemplates();

    assert.deepEqual(first, [{ id: 'instruction', name: 'Director', type: 'instruction', instruction: 'Direct.' }]);
    assert.deepEqual(second, first);
  });

  it('writes create, update, and delete to shared settings without legacy localforage', async () => {
    const created = await templates.createInstructionTemplate({ name: 'Director', instruction: 'First' });
    const updated = await templates.saveTemplate({ ...created, name: 'Revised', instruction: 'Second' });
    await templates.deleteTemplate(created.id);

    assert.equal(created.name, 'Director');
    assert.equal(updated.name, 'Revised');
    assert.equal(memoryStore.has(core.LF_TEMPLATES), false, 'legacy key untouched');
    assert.deepEqual(extensionSettings.ur_image_studio.imageConnections.templates, []);
    assert.equal(saveCalls, 3);
  });

  it('invalidateTemplateCache drops the cache so external settings changes become visible', async () => {
    extensionSettings.ur_image_studio = {
      imageConnections: { templates: [{ id: 't1', name: 'First', type: 'instruction', instruction: 'A' }] },
    };
    const first = await templates.listTemplates();
    assert.equal(first.length, 1);
    assert.equal(first[0].id, 't1');

    // External mutation bypassing the module's CRUD (e.g. backup import).
    extensionSettings.ur_image_studio.imageConnections.templates = [
      { id: 't2', name: 'Second', type: 'instruction', instruction: 'B' },
    ];
    // Without invalidation the cache still returns the old record.
    const stale = await templates.listTemplates();
    assert.equal(stale[0].id, 't1');

    templates.invalidateTemplateCache();
    const fresh = await templates.listTemplates();
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].id, 't2');
  });
});

it('template CRUD пишет события в журнал диагностики', async () => {
  const journal = await import('../src/diagnostic-events.js');
  journal.resetDiagnosticEventsForTests();
  const created = await templates.createInstructionTemplate({ name: 'Ж', instruction: 'B' });
  await templates.deleteTemplate(created.id);
  const crud = journal.listDiagnosticEvents().filter(e => e.event === 'template-crud');
  assert.deepEqual(crud.map(e => e.operation), ['create', 'delete']);
});
