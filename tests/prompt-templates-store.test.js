import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

const extensionSettings = {};
const originalSt = globalThis.SillyTavern;
const originalToastr = globalThis.toastr;

globalThis.SillyTavern = {
  getContext: () => ({
    extensionSettings,
    saveSettingsDebounced: () => {},
    saveMetadata: () => {},
    getRequestHeaders: () => ({}),
  }),
  libs: {
    localforage: {
      async getItem() { return []; },
      async setItem() {},
      async removeItem() {},
    },
  },
};
globalThis.toastr = undefined;

const templates = await import('../src/prompt-templates.js');

beforeEach(() => {
  for (const key of Object.keys(extensionSettings)) delete extensionSettings[key];
  templates.resetTemplateStoreForTests();
});
afterEach(() => templates.resetTemplateStoreForTests());

function availableStore(seed = []) {
  const records = [...seed];
  const calls = [];
  return {
    calls,
    records,
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
  it('lists supported templates from the store and caches the first projection', async () => {
    const store = availableStore([
      { id: 'instruction', name: 'Director', type: 'instruction', instruction: 'Direct.' },
      { id: 'legacy', type: 'fields', fields: [] },
    ]);
    templates.setTemplateStoreForTests(store);

    const first = await templates.listTemplates();
    const second = await templates.listTemplates();

    assert.deepEqual(first, [{ id: 'instruction', name: 'Director', type: 'instruction', instruction: 'Direct.' }]);
    assert.deepEqual(second, first);
    assert.equal(store.calls.filter(([op]) => op === 'list').length, 1, 'кэш: второй список идёт из памяти');
  });

  it('writes create, update, and delete through the store', async () => {
    const store = availableStore();
    templates.setTemplateStoreForTests(store);

    const created = await templates.createInstructionTemplate({ name: 'Director', instruction: 'First' });
    const updated = await templates.saveTemplate({ ...created, name: 'Revised', instruction: 'Second' });
    await templates.deleteTemplate(created.id);

    assert.equal(created.name, 'Director');
    assert.equal(updated.name, 'Revised');
    assert.deepEqual(
      store.calls.map(([op]) => op).filter(op => op !== 'list'),
      ['create', 'update', 'delete'],
    );
  });

  it('invalidateTemplateCache drops the cache so external store changes become visible', async () => {
    const store = availableStore([{ id: 't1', name: 'First', type: 'instruction', instruction: 'A' }]);
    templates.setTemplateStoreForTests(store);

    const first = await templates.listTemplates();
    assert.equal(first.length, 1);
    assert.equal(first[0].id, 't1');

    // External mutation bypassing the module's CRUD (e.g. backup import).
    store.records.length = 0;
    store.records.push({ id: 't2', name: 'Second', type: 'instruction', instruction: 'B' });

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
  const store = availableStore();
  templates.setTemplateStoreForTests(store);
  const created = await templates.createInstructionTemplate({ name: 'Ж', instruction: 'B' });
  await templates.deleteTemplate(created.id);
  const crud = journal.listDiagnosticEvents().filter(e => e.event === 'template-crud');
  assert.deepEqual(crud.map(e => e.operation), ['create', 'delete']);
});
