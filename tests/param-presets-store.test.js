import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const memoryStore = new Map();
const extensionSettings = {};
let saveCalls = 0;

globalThis.SillyTavern = {
  getContext: () => ({
    extensionSettings,
    saveSettingsDebounced: () => { saveCalls += 1; },
  }),
  libs: {
    localforage: {
      async getItem(key) { return memoryStore.get(key) ?? []; },
      async setItem(key, value) { memoryStore.set(key, value); },
      async removeItem(key) { memoryStore.delete(key); },
    },
  },
};

const core = await import('../src/core.js');
const presets = await import('../src/param-presets.js');

beforeEach(() => {
  memoryStore.clear();
  for (const key of Object.keys(extensionSettings)) delete extensionSettings[key];
  saveCalls = 0;
  presets.resetParamPresetStoreForTests();
});

describe('shared image parameter presets', () => {
  it('uses shared settings for CRUD and preserves image parameter normalization', async () => {
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
    assert.deepEqual(extensionSettings.ur_image_studio.imageConnections.presets, []);
    assert.equal(memoryStore.has(core.LF_IMAGE_PARAMS), false);
    assert.equal(saveCalls, 3);
  });
});
