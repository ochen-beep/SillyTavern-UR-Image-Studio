import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { migrateCollection, resetMigrationDepsForTests, setMigrationDepsForTests } from '../src/store-migration.js';
import { LF_IMAGE_PARAMS, LF_REFS_FOLDERS, LF_REFS_POOL } from '../src/core.js';
import { normalizeImageParam } from '../src/param-presets.js';
import { normalizePoolReference } from '../src/refs-library.js';

function createFakeLocalforage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const calls = [];
  return {
    calls,
    async getItem(key) { calls.push(['getItem', key]); return values.get(key) ?? null; },
    async removeItem(key) { calls.push(['removeItem', key]); values.delete(key); },
    value(key) { return values.get(key) ?? null; },
  };
}

function createFakeStore({ readback = null } = {}) {
  const collections = new Map();
  const calls = [];
  return {
    calls,
    async listCollection(name) {
      calls.push(['list', name]);
      if (readback !== null && name !== 'migration-checkpoint') return readback;
      return collections.get(name) ?? (name === 'migration-checkpoint' ? {} : []);
    },
    async replaceWhole(name, value) {
      calls.push(['replaceWhole', name, value]);
      collections.set(name, structuredClone(value));
      return value;
    },
    value(name) { return collections.get(name); },
  };
}

afterEach(() => resetMigrationDepsForTests());

describe('server-store migration', () => {
  it('writes normalized templates, verifies read-back, checkpoints on the server, then clears localforage', async () => {
    const localforage = createFakeLocalforage({
      legacy_templates: [
        { id: 't1', name: ' One ', apiKey: 'must-strip' },
        { id: 't2', name: 'Two' },
      ],
    });
    const store = createFakeStore();
    setMigrationDepsForTests({ localforage, store });

    const result = await migrateCollection('templates', {
      lfKey: 'legacy_templates',
      normalize: item => ({ id: item.id, name: item.name.trim() }),
    });

    assert.deepEqual(result, { migrated: true, count: 2 });
    assert.deepEqual(store.value('templates'), [{ id: 't1', name: 'One' }, { id: 't2', name: 'Two' }]);
    assert.equal(localforage.value('legacy_templates'), null, 'cleared only after read-back');
    const checkpoint = store.value('migration-checkpoint');
    assert.equal(checkpoint.templates.count, 2);
    assert.ok(checkpoint.templates.verifiedAt);
    assert.deepEqual(localforage.calls.map(c => c[0]), ['getItem', 'removeItem']);
  });

  it('migrates image parameter presets with stable IDs and normalized provider fields', async () => {
    const localforage = createFakeLocalforage({
      [LF_IMAGE_PARAMS]: [{
        id: 'cinematic', name: 'Cinematic', size: '1536x1024', quality: 'hd',
        aspectRatio: 'invalid', imageSize: 'invalid', styleTemplate: 'film still',
      }],
    });
    const store = createFakeStore();
    setMigrationDepsForTests({ localforage, store });

    const result = await migrateCollection('param-presets', {
      lfKey: LF_IMAGE_PARAMS,
      normalize: normalizeImageParam,
    });

    assert.deepEqual(result, { migrated: true, count: 1 });
    assert.deepEqual(store.value('param-presets')[0], {
      id: 'cinematic', name: 'Cinematic', size: '1536x1024', quality: 'hd',
      aspectRatio: '1:1', imageSize: '1K', styleTemplate: 'film still',
    });
    assert.equal(localforage.value(LF_IMAGE_PARAMS), null);
  });

  it('migrates reference metadata without changing its SillyTavern imagePath', async () => {
    const imagePath = 'user/images/URIS_Refs/Aria%20Rose.webp';
    const localforage = createFakeLocalforage({
      [LF_REFS_POOL]: [{
        id: 'ref-aria', name: ' Aria ', aliases: ['Aria', ' aria '], description: 'blue hair',
        imagePath, folders: ['folder-cast'], createdAt: 123,
      }],
    });
    const store = createFakeStore();
    setMigrationDepsForTests({ localforage, store });

    const result = await migrateCollection('refs', { lfKey: LF_REFS_POOL, normalize: normalizePoolReference });

    assert.deepEqual(result, { migrated: true, count: 1 });
    assert.equal(store.value('refs')[0].imagePath, imagePath);
    assert.equal(store.value('refs')[0].id, 'ref-aria');
    assert.deepEqual(store.value('refs')[0].folders, ['folder-cast']);
    assert.equal(localforage.value(LF_REFS_POOL), null);
  });

  it('migrates ref folders independently while preserving stable IDs, order, and color', async () => {
    const folders = [{ id: 'folder-cast', name: 'Cast', color: '#4a90d9', order: 2 }];
    const localforage = createFakeLocalforage({ [LF_REFS_FOLDERS]: folders });
    const store = createFakeStore();
    setMigrationDepsForTests({ localforage, store });

    const result = await migrateCollection('ref-folders', { lfKey: LF_REFS_FOLDERS, normalize: folder => folder });

    assert.deepEqual(result, { migrated: true, count: 1 });
    assert.deepEqual(store.value('ref-folders'), folders);
    assert.equal(localforage.value(LF_REFS_FOLDERS), null);
  });

  it('keeps legacy refs when server read-back changes their imagePath', async () => {
    const imagePath = 'user/images/URIS_Refs/aria.webp';
    const localforage = createFakeLocalforage({
      [LF_REFS_POOL]: [{ id: 'ref-aria', name: 'Aria', imagePath }],
    });
    const store = createFakeStore({ readback: [{ id: 'ref-aria', name: 'Aria', imagePath: 'user/images/other.webp' }] });
    setMigrationDepsForTests({ localforage, store });

    await assert.rejects(
      migrateCollection('refs', { lfKey: LF_REFS_POOL, normalize: normalizePoolReference }),
      /read-back verification failed/,
    );
    assert.equal(localforage.value(LF_REFS_POOL)[0].imagePath, imagePath);
  });

  it('does not delete localforage when server read-back differs', async () => {
    const localforage = createFakeLocalforage({ legacy_templates: [{ id: 't1', name: 'One' }] });
    const store = createFakeStore({ readback: [{ id: 't1', name: 'Different' }] });
    setMigrationDepsForTests({ localforage, store });

    await assert.rejects(
      migrateCollection('templates', { lfKey: 'legacy_templates', normalize: x => x }),
      /read-back verification failed/,
    );

    assert.deepEqual(localforage.value('legacy_templates'), [{ id: 't1', name: 'One' }]);
    assert.equal(localforage.calls.some(c => c[0] === 'removeItem'), false);
    assert.equal(store.value('migration-checkpoint'), undefined);
  });

  it('is a no-op when the localforage key is empty', async () => {
    const localforage = createFakeLocalforage();
    const store = createFakeStore();
    setMigrationDepsForTests({ localforage, store });

    const result = await migrateCollection('templates', { lfKey: 'legacy_templates', normalize: x => x });

    assert.deepEqual(result, { migrated: false, reason: 'empty' });
    assert.deepEqual(store.calls, [['list', 'migration-checkpoint']]);
  });

  it('uses the synced server checkpoint to skip a stale browser-local copy on another install', async () => {
    const localforage = createFakeLocalforage({ legacy_templates: [{ id: 'stale', name: 'Old browser copy' }] });
    const store = createFakeStore();
    await store.replaceWhole('migration-checkpoint', {
      templates: {
        verifiedAt: '2026-07-29T12:00:00.000Z',
        count: 3,
        sourceFingerprint: JSON.stringify([{ id: 'other', name: 'Authoritative source' }]),
      },
    });
    store.calls.length = 0;
    setMigrationDepsForTests({ localforage, store });

    const result = await migrateCollection('templates', { lfKey: 'legacy_templates', normalize: x => x });

    assert.deepEqual(result, { migrated: false, reason: 'checkpoint' });
    assert.deepEqual(store.calls, [['list', 'migration-checkpoint']]);
    assert.deepEqual(localforage.value('legacy_templates'), [{ id: 'stale', name: 'Old browser copy' }], 'never erase stale local copy on skip');
  });

  it('recovers idempotently after a crash between verified write and legacy cleanup', async () => {
    const localforage = createFakeLocalforage({ legacy_templates: [{ id: 't1', name: 'One' }] });
    const store = createFakeStore();
    let failRemove = true;
    const originalRemove = localforage.removeItem;
    localforage.removeItem = async key => {
      if (failRemove) { failRemove = false; throw new Error('simulated crash before cleanup'); }
      return originalRemove.call(localforage, key);
    };
    setMigrationDepsForTests({ localforage, store });

    await assert.rejects(migrateCollection('templates', { lfKey: 'legacy_templates', normalize: x => x }), /simulated crash/);
    assert.deepEqual(store.value('templates'), [{ id: 't1', name: 'One' }]);
    assert.ok(store.value('migration-checkpoint').templates, 'checkpoint is durable before cleanup');

    // In the same browser this should finish the cleanup rather than write a
    // duplicate. Checkpoint skip alone would retain legacy data forever, so a
    // matching source is cleanup-eligible.
    const result = await migrateCollection('templates', { lfKey: 'legacy_templates', normalize: x => x });
    assert.deepEqual(result, { migrated: false, reason: 'checkpoint-cleanup' });
    assert.equal(localforage.value('legacy_templates'), null);
    assert.deepEqual(store.value('templates'), [{ id: 't1', name: 'One' }]);
  });
});
