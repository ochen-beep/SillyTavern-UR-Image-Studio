import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const extensionSettings = {};

globalThis.SillyTavern = {
  getContext: () => ({
    extensionSettings,
    saveSettingsDebounced: () => {},
  }),
  libs: {
    localforage: {
      async getItem() { return []; },
      async setItem() {},
      async removeItem() {},
    },
  },
};

const presets = await import('../src/param-presets.js');

beforeEach(async () => {
  // Flush BEFORE clearing: a fire-and-forget write loop parked mid-upload
  // from the previous test must land in the PREVIOUS map (proven flake class).
  await presets.flushParamPresetWrites().catch(() => {});
  for (const key of Object.keys(extensionSettings)) delete extensionSettings[key];
  presets.resetParamPresetStoreForTests();
});

function recordingStore() {
  const records = [];
  const calls = [];
  return {
    records,
    calls,
    async available() { return true; },
    async list() { calls.push('list'); return structuredClone(records); },
    async create(payload) { calls.push('create'); records.push({ ...payload }); return { ...payload }; },
    async update(id, payload) {
      calls.push('update');
      const index = records.findIndex(item => item.id === id);
      records[index] = { ...payload, id };
      return { ...records[index] };
    },
    async delete(id) { calls.push('delete'); records.splice(records.findIndex(item => item.id === id), 1); },
  };
}

describe('shared image parameter presets', () => {
  it('runs CRUD through the store and preserves image parameter normalization', async () => {
    const store = recordingStore();
    presets.setParamPresetStoreForTests(store);

    const created = await presets.createImageParam({
      id: 'cinematic',
      name: 'Cinematic',
      aspectRatio: 'not-valid',
      imageSize: 'not-valid',
    });
    const saved = await presets.saveImageParam({ ...created, name: 'Cinematic wide', aspectRatio: '16:9' });
    await presets.deleteImageParam(created.id);

    assert.equal(created.aspectRatio, '1:1');
    assert.equal(created.imageSize, '1K');
    assert.equal(saved.name, 'Cinematic wide');
    assert.deepEqual(
      store.calls.filter(op => op !== 'list'),
      ['create', 'update', 'delete'],
    );
  });
});
