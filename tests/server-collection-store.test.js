import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { join } from 'node:path';

import {
  listCollection,
  getRecord,
  createRecord,
  replaceRecord,
  deleteRecord,
  replaceWhole,
} from '../server-plugin/src/storage/collection-store.js';
import { ServerImageError } from '../server-plugin/src/errors.js';
import { useTempDir, cleanupTempDir } from './server-plugin/temp-store.js';

const tempDirs = [];
const NOW_ISO = '2026-07-29T12:00:00.000Z';

function makePaths() {
  const root = useTempDir();
  tempDirs.push(root);
  return { root: join(root, 'plugins', 'ur-image-studio') };
}

// Monotonic clock for deterministic `updatedAt` assignment.
function makeClock(start = NOW_ISO) {
  let t = new Date(start).getTime();
  return () => new Date(t++).toISOString();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

describe('collection store registry', () => {
  it('rejects an unknown collection name with COLLECTION_UNKNOWN', async () => {
    const paths = makePaths();
    await assert.rejects(
      listCollection(paths, 'not-a-real-collection'),
      (err) => err instanceof ServerImageError && err.code === 'COLLECTION_UNKNOWN',
    );
  });

  it('rejects retired characters collection with COLLECTION_UNKNOWN', async () => {
    const paths = makePaths();
    await assert.rejects(
      listCollection(paths, 'characters'),
      (err) => err instanceof ServerImageError && err.code === 'COLLECTION_UNKNOWN',
    );
  });

  it('rejects a path-traversal collection name', async () => {
    const paths = makePaths();
    await assert.rejects(
      listCollection(paths, '../escape'),
      (err) => err instanceof ServerImageError && err.code === 'COLLECTION_UNKNOWN',
    );
    await assert.rejects(
      listCollection(paths, 'templates/../refs'),
      (err) => err instanceof ServerImageError && err.code === 'COLLECTION_UNKNOWN',
    );
  });

  it('registers all expected collections', async () => {
    const names = [
      'templates', 'param-presets', 'ref-folders',
      'refs', 'prompt-history', 'generation-drafts', 'preferences',
      'migration-checkpoint',
    ];
    const paths = makePaths();
    for (const name of names) {
      // Each resolves (returns empty fallback) rather than throwing COLLECTION_UNKNOWN.
      const value = await listCollection(paths, name);
      assert.ok(Array.isArray(value) || (value && typeof value === 'object'),
        `collection ${name} should be registered`);
    }
  });
});

describe('collection store - array shape (templates)', () => {
  it('creates a record with server-assigned updatedAt and reads it back', async () => {
    const paths = makePaths();
    const clock = makeClock();
    const created = await createRecord(paths, 'templates',
      { id: 'tpl_a', name: 'A', instruction: 'do x' }, clock);
    assert.equal(created.id, 'tpl_a');
    assert.equal(created.updatedAt, NOW_ISO);

    const all = await listCollection(paths, 'templates');
    assert.equal(all.length, 1);
    assert.equal(all[0].name, 'A');
  });

  it('replaces a record by id and bumps updatedAt', async () => {
    const paths = makePaths();
    const clock = makeClock();
    await createRecord(paths, 'templates', { id: 't1', name: 'old' }, clock);
    // advance the clock past the first timestamp
    clock();
    const updated = await replaceRecord(paths, 'templates', 't1',
      { id: 't1', name: 'new' }, clock);
    assert.equal(updated.name, 'new');
    assert.notEqual(updated.updatedAt, NOW_ISO, 'updatedAt advanced');

    const all = await listCollection(paths, 'templates');
    assert.equal(all.length, 1);
    assert.equal(all[0].name, 'new');
  });

  it('getRecord returns undefined for a missing id', async () => {
    const paths = makePaths();
    const clock = makeClock();
    await createRecord(paths, 'templates', { id: 't1', name: 'x' }, clock);
    assert.equal(await getRecord(paths, 'templates', 'nope'), undefined);
    assert.deepEqual((await getRecord(paths, 'templates', 't1')).name, 'x');
  });

  it('deleteRecord removes the record', async () => {
    const paths = makePaths();
    const clock = makeClock();
    await createRecord(paths, 'templates', { id: 't1', name: 'x' }, clock);
    await deleteRecord(paths, 'templates', 't1');
    assert.equal(await getRecord(paths, 'templates', 't1'), undefined);
    assert.equal((await listCollection(paths, 'templates')).length, 0);
  });

  it('replaceWhole overwrites the entire array (migration)', async () => {
    const paths = makePaths();
    const clock = makeClock();
    await createRecord(paths, 'templates', { id: 'keep', name: 'k' }, clock);
    await replaceWhole(paths, 'templates', [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ], clock);
    const all = await listCollection(paths, 'templates');
    assert.deepEqual(all.map(r => r.id), ['a', 'b']);
    // server-assigned updatedAt on every record
    for (const r of all) assert.ok(r.updatedAt);
  });
});

describe('collection store - parameter presets', () => {
  it('preserves parameter preset fields through collection CRUD', async () => {
    const paths = makePaths();
    const clock = makeClock();
    const preset = await createRecord(paths, 'param-presets', {
      id: 'cinematic', name: 'Cinematic', aspectRatio: '16:9', imageSize: '2K', styleTemplate: 'film still',
    }, clock);

    assert.equal(preset.updatedAt, NOW_ISO);
    assert.deepEqual(await getRecord(paths, 'param-presets', 'cinematic'), preset);
  });
});

describe('collection store - object shape (prompt-history)', () => {
  it('stores records keyed by id in an object', async () => {
    const paths = makePaths();
    const clock = makeClock();
    await createRecord(paths, 'prompt-history',
      { id: 'chat_1', prompt: 'p1' }, clock);
    const all = await listCollection(paths, 'prompt-history');
    assert.equal(all.chat_1.prompt, 'p1');
    assert.equal(all.chat_1.updatedAt, NOW_ISO);
  });

  it('replaceRecord updates a keyed entry', async () => {
    const paths = makePaths();
    const clock = makeClock();
    await createRecord(paths, 'prompt-history', { id: 'c1', prompt: 'old' }, clock);
    clock();
    const updated = await replaceRecord(paths, 'prompt-history', 'c1',
      { id: 'c1', prompt: 'new' }, clock);
    assert.equal(updated.prompt, 'new');
    const all = await listCollection(paths, 'prompt-history');
    assert.equal(all.c1.prompt, 'new');
  });

  it('deleteRecord removes a keyed entry', async () => {
    const paths = makePaths();
    const clock = makeClock();
    await createRecord(paths, 'prompt-history', { id: 'c1', prompt: 'p' }, clock);
    await deleteRecord(paths, 'prompt-history', 'c1');
    assert.equal((await listCollection(paths, 'prompt-history')).c1, undefined);
  });
});

describe('collection store - secret sanitization', () => {
  it('strips apiKey/api_key/token/password/secret from created records', async () => {
    const paths = makePaths();
    const clock = makeClock();
    const created = await createRecord(paths, 'templates', {
      id: 't1', name: 'x',
      apiKey: 'sk-leak', api_key: 'sk-leak2', token: 't', password: 'p', secret: 's',
    }, clock);
    for (const f of ['apiKey', 'api_key', 'token', 'password', 'secret']) {
      assert.equal(created[f], undefined, `${f} stripped`);
    }
    const onDisk = await listCollection(paths, 'templates');
    for (const f of ['apiKey', 'api_key', 'token', 'password', 'secret']) {
      assert.equal(onDisk[0][f], undefined, `${f} not persisted`);
    }
  });

  it('strips nested secret fields recursively', async () => {
    const paths = makePaths();
    const clock = makeClock();
    const created = await createRecord(paths, 'refs', {
      id: 'r1', name: 'ref',
      metadata: { apiKey: 'leak', ok: 'keep' },
    }, clock);
    assert.equal(created.metadata.apiKey, undefined);
    assert.equal(created.metadata.ok, 'keep');
  });

  it('does NOT strip secretId (an id-reference, not a secret value)', async () => {
    const paths = makePaths();
    const clock = makeClock();
    const created = await createRecord(paths, 'templates', {
      id: 't1', name: 'x', secretId: 'conn_abc',
    }, clock);
    assert.equal(created.secretId, 'conn_abc', 'secretId preserved (id-reference)');
  });
});

describe('collection store - concurrency', () => {
  it('20 concurrent createRecord calls all persist under the lock', async () => {
    const paths = makePaths();
    const clock = makeClock();
    const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
    await Promise.all(ids.map(id =>
      createRecord(paths, 'templates', { id, name: id }, clock)));
    const all = await listCollection(paths, 'templates');
    assert.equal(all.length, 20);
    assert.deepEqual(all.map(r => r.id).sort(), ids.slice().sort());
  });
});
