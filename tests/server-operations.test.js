import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readJson, writeJson } from '../server-plugin/src/storage/atomic-json.js';
import { useTempDir, cleanupTempDir } from './server-plugin/temp-store.js';
import {
  beginOperation,
  advanceOperation,
  finishOperation,
  listOperations,
  reconcileOperations,
} from '../server-plugin/src/storage/operations-store.js';

function makePaths(root) {
  const base = join(root, 'plugins', 'ur-image-studio');
  return {
    root: base,
    connections: join(base, 'connections.json'),
    operations: join(base, 'operations.json'),
    journalKey: root,
  };
}

// --------------------------------------------------------------------------
// Step 1: Marker lifecycle
// --------------------------------------------------------------------------

describe('operation marker lifecycle', () => {
  let dir;
  let paths;

  before(() => {
    dir = useTempDir();
    paths = makePaths(dir);
  });

  after(() => {
    cleanupTempDir(dir);
  });

  it('beginOperation creates a marker in operations.json with correct schema', async () => {
    const marker = {
      id: 'op-001',
      type: 'create',
      connectionId: 'conn-1',
      phase: 'creating-secret',
      oldSecretId: null,
      newSecretId: 'secret-A',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await beginOperation(paths, marker);

    const onDisk = await readJson(paths.operations, []);
    assert.equal(onDisk.length, 1);
    const saved = onDisk[0];
    assert.equal(saved.id, 'op-001');
    assert.equal(saved.type, 'create');
    assert.equal(saved.connectionId, 'conn-1');
    assert.equal(saved.phase, 'creating-secret');
    assert.equal(saved.oldSecretId, null);
    assert.equal(saved.newSecretId, 'secret-A');
    assert.equal(typeof saved.createdAt, 'string');
    assert.equal(typeof saved.updatedAt, 'string');
  });

  it('advanceOperation updates existing marker fields', async () => {
    // Start from whatever is on disk already, then advance op-001
    const patch = { phase: 'committed', newSecretId: 'secret-A-updated' };
    await advanceOperation(paths, 'op-001', patch);

    const onDisk = await readJson(paths.operations, []);
    const op = onDisk.find(o => o.id === 'op-001');
    assert.ok(op);
    assert.equal(op.phase, 'committed');
    assert.equal(op.newSecretId, 'secret-A-updated');
    // Unchanged fields
    assert.equal(op.type, 'create');
    assert.equal(op.connectionId, 'conn-1');
  });

  it('finishOperation removes the marker', async () => {
    await finishOperation(paths, 'op-001');

    const onDisk = await readJson(paths.operations, []);
    assert.equal(onDisk.length, 0);
  });

  it('listOperations returns all markers', async () => {
    const m1 = {
      id: 'op-list-1', type: 'create', connectionId: 'c1',
      phase: 'p1', oldSecretId: null, newSecretId: 's1',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const m2 = {
      id: 'op-list-2', type: 'delete', connectionId: 'c2',
      phase: 'p2', oldSecretId: null, newSecretId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };

    await beginOperation(paths, m1);
    await beginOperation(paths, m2);

    const ops = await listOperations(paths);
    assert.equal(ops.length, 2);
    const ids = ops.map(o => o.id);
    assert.ok(ids.includes('op-list-1'));
    assert.ok(ids.includes('op-list-2'));
  });

  it('operations are user-scoped (different paths = different operations)', async () => {
    const dir2 = useTempDir();
    try {
      const paths2 = makePaths(dir2);
      const m = {
        id: 'op-scoped', type: 'create', connectionId: 'cx',
        phase: 'p', oldSecretId: null, newSecretId: 'sx',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      await beginOperation(paths2, m);

      const ops1 = await listOperations(paths);
      const ops2 = await listOperations(paths2);

      // paths has op-list-1 and op-list-2, NOT op-scoped
      assert.ok(ops1.find(o => o.id === 'op-list-1'));
      assert.ok(!ops1.find(o => o.id === 'op-scoped'));

      // paths2 only has op-scoped
      assert.equal(ops2.length, 1);
      assert.equal(ops2[0].id, 'op-scoped');
    } finally {
      cleanupTempDir(dir2);
    }
  });
});

// --------------------------------------------------------------------------
// Step 2: Reconciliation with fake stores
// --------------------------------------------------------------------------

describe('reconcileOperations', () => {
  let dir;
  let paths;

  before(() => {
    dir = useTempDir();
    paths = makePaths(dir);
  });

  after(() => {
    cleanupTempDir(dir);
  });

  /**
   * Helper: seed operations.json with given markers, then reconcile.
   */
  async function seedAndReconcile(markers, connectionStore, secretStore) {
    await writeJson(paths.operations, markers);
    const context = { paths, connectionStore, secretStore };
    return reconcileOperations(context);
  }

  it('does not clean live connection data for a delete marker written before tombstoning', async () => {
    const calls = [];
    const marker = {
      id: 'recon-live-delete', type: 'delete', connectionId: 'conn-live', phase: 'deleting',
      oldSecretId: 'live-secret', newSecretId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await writeJson(paths.operations, [marker]);

    await reconcileOperations({
      paths,
      connectionStore: { getConnections: () => [{ id: 'conn-live', secretId: 'live-secret' }] },
      secretStore: { async deleteSecret(id) { calls.push(['secret', id]); } },
      requestStore: { async deleteByConnection(id) { calls.push(['requests', id]); } },
      artifactStore: { async deleteByConnection(id) { calls.push(['artifacts', id]); } },
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(await readJson(paths.operations, []), []);
  });

  it('uses current metadata rather than marker phase to reconcile rotations', async () => {
    const cases = [
      { phase: 'creating-secret', current: 'new-secret', deleted: 'old-secret' },
      { phase: 'committed', current: 'old-secret', deleted: 'new-secret' },
    ];
    for (const [index, fixture] of cases.entries()) {
      const deletedIds = [];
      const marker = {
        id: `recon-authoritative-${index}`, type: 'rotate-key', connectionId: 'conn-authoritative',
        phase: fixture.phase, oldSecretId: 'old-secret', newSecretId: 'new-secret',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      await seedAndReconcile(
        [marker],
        { getConnections: () => [{ id: 'conn-authoritative', secretId: fixture.current }] },
        { async deleteSecret(id) { deletedIds.push(id); } },
      );
      assert.deepEqual(deletedIds, [fixture.deleted]);
    }
  });

  it('recovers an operation-labeled secret when the host write returned no ID', async () => {
    const deletedIds = [];
    const marker = {
      id: 'recon-write-window', type: 'create', connectionId: 'conn-write-window',
      phase: 'creating-secret', oldSecretId: null, newSecretId: null,
      secretLabel: 'ur-image-studio:operation:recon-write-window',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };

    await seedAndReconcile(
      [marker],
      { getConnections: () => [] },
      {
        async findSecretsByLabel(label) {
          assert.equal(label, marker.secretLabel);
          return [{ id: 'host-written-before-crash', present: true }];
        },
        async deleteSecret(id) { deletedIds.push(id); },
      },
    );

    assert.deepEqual(deletedIds, ['host-written-before-crash']);
    assert.deepEqual(await readJson(paths.operations, []), []);
  });

  it('uncommitted create (phase before committed) with newSecretId not in any connection deletes the new secret', async () => {
    const deletedIds = [];
    const secretStore = {
      deleteSecret(id) { deletedIds.push(id); },
      secretExists() { return true; },
    };
    const connectionStore = {
      getConnections() { return []; },
    };

    const markers = [{
      id: 'recon-1', type: 'create', connectionId: 'conn-x',
      phase: 'creating-secret', oldSecretId: null, newSecretId: 'orphan-secret-1',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }];

    await seedAndReconcile(markers, connectionStore, secretStore);
    assert.deepEqual(deletedIds, ['orphan-secret-1']);

    // The operation should be cleaned up (removed)
    const remaining = await readJson(paths.operations, []);
    assert.equal(remaining.length, 0);
  });

  it('rotate-key before metadata commit preserves old secret, removes new orphan secret', async () => {
    const deletedIds = [];
    const secretStore = {
      deleteSecret(id) { deletedIds.push(id); },
      secretExists() { return true; },
    };
    const connectionStore = {
      // No connection references the new secret yet (uncommitted rotation)
      getConnections() { return [{ id: 'conn-r', secretId: 'old-secret' }]; },
    };

    const markers = [{
      id: 'recon-2', type: 'rotate-key', connectionId: 'conn-r',
      phase: 'creating-secret', oldSecretId: 'old-secret', newSecretId: 'new-orphan-secret',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }];

    await seedAndReconcile(markers, connectionStore, secretStore);

    // Should delete the new orphan, NOT the old secret
    assert.deepEqual(deletedIds, ['new-orphan-secret']);
    assert.ok(!deletedIds.includes('old-secret'));

    const remaining = await readJson(paths.operations, []);
    assert.equal(remaining.length, 0);
  });

  it('rotate-key after metadata commit preserves new referenced secret, removes old secret', async () => {
    const deletedIds = [];
    const secretStore = {
      deleteSecret(id) { deletedIds.push(id); },
      secretExists() { return true; },
    };
    const connectionStore = {
      // Connection now references the NEW secret (committed rotation)
      getConnections() { return [{ id: 'conn-r2', secretId: 'new-active-secret' }]; },
    };

    const markers = [{
      id: 'recon-3', type: 'rotate-key', connectionId: 'conn-r2',
      phase: 'committed', oldSecretId: 'old-stale-secret', newSecretId: 'new-active-secret',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }];

    await seedAndReconcile(markers, connectionStore, secretStore);

    // Should delete the OLD secret, NOT the new referenced one
    assert.deepEqual(deletedIds, ['old-stale-secret']);
    assert.ok(!deletedIds.includes('new-active-secret'));

    const remaining = await readJson(paths.operations, []);
    assert.equal(remaining.length, 0);
  });

  it('tombstoned delete retries cleanup idempotently and does not fail if already cleaned', async () => {
    const deletedIds = [];
    const secretStore = {
      deleteSecret(id) { deletedIds.push(id); },
      secretExists() { return false; }, // already cleaned
    };
    const connectionStore = {
      // Connection is tombstoned (deleted)
      getConnections() { return [{ id: 'conn-del', secretId: 'del-secret', tombstone: true }]; },
    };

    const markers = [{
      id: 'recon-4', type: 'delete', connectionId: 'conn-del',
      phase: 'tombstoned', oldSecretId: 'del-secret', newSecretId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }];

    // Should not throw even though secret is already gone
    await seedAndReconcile(markers, connectionStore, secretStore);

    // Still attempts cleanup
    assert.deepEqual(deletedIds, ['del-secret']);

    const remaining = await readJson(paths.operations, []);
    assert.equal(remaining.length, 0);
  });

  it('delete completes secret, request journal, and artifact cleanup before removing its marker', async () => {
    const calls = [];
    const secretStore = { async deleteSecret(id) { calls.push(['secret', id]); } };
    const connectionStore = {
      getConnections() { return [{ id: 'conn-clean', secretId: 'secret-clean', tombstone: true }]; },
    };
    const requestStore = { async deleteByConnection(id) { calls.push(['requests', id]); } };
    const artifactStore = { async deleteByConnection(id) { calls.push(['artifacts', id]); } };
    const markers = [{
      id: 'recon-clean', type: 'delete', connectionId: 'conn-clean', phase: 'tombstoned',
      oldSecretId: 'secret-clean', newSecretId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }];

    await writeJson(paths.operations, markers);
    await reconcileOperations({ paths, connectionStore, secretStore, requestStore, artifactStore });

    assert.deepEqual(calls, [
      ['secret', 'secret-clean'],
      ['requests', 'conn-clean'],
      ['artifacts', 'conn-clean'],
    ]);
    assert.deepEqual(await readJson(paths.operations, []), []);
  });

  it('retains a delete marker when cleanup fails and retries all cleanup idempotently', async () => {
    let failArtifacts = true;
    const calls = [];
    const context = {
      paths,
      connectionStore: {
        getConnections() { return [{ id: 'conn-retry', secretId: 'secret-retry', tombstone: true }]; },
      },
      secretStore: { async deleteSecret() { calls.push('secret'); } },
      requestStore: { async deleteByConnection() { calls.push('requests'); } },
      artifactStore: {
        async deleteByConnection() {
          calls.push('artifacts');
          if (failArtifacts) throw new Error('cleanup unavailable');
        },
      },
    };
    const marker = {
      id: 'recon-retry', type: 'delete', connectionId: 'conn-retry', phase: 'tombstoned',
      oldSecretId: 'secret-retry', newSecretId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await writeJson(paths.operations, [marker]);

    await assert.rejects(reconcileOperations(context), /cleanup unavailable/);
    assert.deepEqual((await readJson(paths.operations, [])).map(op => op.id), ['recon-retry']);

    failArtifacts = false;
    await reconcileOperations(context);
    assert.deepEqual(calls, ['secret', 'requests', 'artifacts', 'secret', 'requests', 'artifacts']);
    assert.deepEqual(await readJson(paths.operations, []), []);
  });

  it('never deletes a secret ID that appears in any committed (non-tombstoned) connection secretId', async () => {
    const deletedIds = [];
    const secretStore = {
      deleteSecret(id) { deletedIds.push(id); },
      secretExists() { return true; },
    };
    const connectionStore = {
      getConnections() {
        return [
          { id: 'conn-active-1', secretId: 'protected-secret-A' },
          { id: 'conn-active-2', secretId: 'protected-secret-B' },
          // Tombstoned connection - its secret is NOT protected
          { id: 'conn-tomb', secretId: 'unprotected-secret', tombstone: true },
        ];
      },
    };

    const markers = [
      // An uncommitted create that would normally delete its orphan secret,
      // but the secret happens to be referenced by a live connection
      {
        id: 'recon-5a', type: 'create', connectionId: 'conn-new',
        phase: 'creating-secret', oldSecretId: null, newSecretId: 'protected-secret-A',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
      // A rotation where the old secret is still used by another connection
      {
        id: 'recon-5b', type: 'rotate-key', connectionId: 'conn-r3',
        phase: 'committed', oldSecretId: 'protected-secret-B', newSecretId: 'some-new-secret',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ];

    await seedAndReconcile(markers, connectionStore, secretStore);

    // protected-secret-A must NOT be deleted (it is in a live connection)
    assert.ok(!deletedIds.includes('protected-secret-A'),
      'should not delete protected-secret-A used by conn-active-1');

    // protected-secret-B must NOT be deleted (it is in a live connection)
    assert.ok(!deletedIds.includes('protected-secret-B'),
      'should not delete protected-secret-B used by conn-active-2');

    // unprotected-secret CAN be deleted (only referenced by tombstoned connection)
    // But we didn't create an operation for it, so it won't appear here.
  });
});
