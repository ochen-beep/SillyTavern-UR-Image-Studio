// @ts-check
/**
 * Idempotent migration from a legacy browser key to a server collection.
 *
 * The checkpoint is a server file (`migration-checkpoint.json` through the
 * collection store), never extensionSettings: a third-party extension's
 * settings slot may not exist until ST's activateExtensions() completes.
 */

import { listCollection, replaceWhole } from './server-store-api.js';

let deps = null;
function getDeps() {
  if (deps) return deps;
  return { localforage: globalThis.SillyTavern?.libs?.localforage, store: { listCollection, replaceWhole } };
}

function stable(value) { return JSON.stringify(value); }
function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (!value || typeof value !== 'object') return value;
  const { updatedAt: _serverOwnedUpdatedAt, ...rest } = value;
  return Object.fromEntries(Object.entries(rest).map(([key, child]) => [key, comparable(child)]));
}
function fingerprint(value) {
  // This is an equality guard for cleanup after a crash, not a security hash:
  // only an exact same normalized legacy projection can be cleared after the
  // server checkpoint already exists. A different browser's stale local copy
  // therefore remains untouched.
  return stable(value);
}
function normalizeValue(value, normalize) {
  if (!Array.isArray(value)) return [];
  return value.map(item => normalize(item));
}

/**
 * Migrate one array-shaped legacy localforage key using write -> force read ->
 * verify -> server checkpoint -> legacy cleanup. The ordering ensures a crash
 * can never lose legacy data before server verification.
 */
export async function migrateCollection(name, { lfKey, normalize = x => x }) {
  const { localforage, store } = getDeps();
  if (!localforage || !store) throw new Error('Migration dependencies unavailable');

  const checkpoint = await store.listCollection('migration-checkpoint') ?? {};
  const legacy = await localforage.getItem(lfKey);
  const source = normalizeValue(legacy, normalize);

  if (checkpoint?.[name]) {
    // A prior run may have crashed after writing its durable checkpoint but
    // before clearing the same browser's legacy value. Cleanup is safe ONLY
    // when the local projection matches the checkpoint's source fingerprint.
    // A second installation's stale IndexedDB must remain untouched.
    if (Array.isArray(legacy) && legacy.length && checkpoint[name].sourceFingerprint === fingerprint(source)) {
      await localforage.removeItem(lfKey);
      return { migrated: false, reason: 'checkpoint-cleanup' };
    }
    return { migrated: false, reason: 'checkpoint' };
  }
  if (!source.length) return { migrated: false, reason: 'empty' };

  await store.replaceWhole(name, source);
  const readback = await store.listCollection(name);
  if (stable(comparable(readback)) !== stable(comparable(source))) {
    throw new Error(`Migration read-back verification failed for ${name}`);
  }

  await store.replaceWhole('migration-checkpoint', {
    ...checkpoint,
    [name]: { verifiedAt: new Date().toISOString(), count: source.length, sourceFingerprint: fingerprint(source) },
  });
  await localforage.removeItem(lfKey);
  return { migrated: true, count: source.length };
}

export function setMigrationDepsForTests(value) { deps = value; }
export function resetMigrationDepsForTests() { deps = null; }
