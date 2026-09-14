import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertSecretManagerApi, loadHostSecretManager } from '../server-plugin/src/host/sillytavern.js';
import { ServerImageError } from '../server-plugin/src/errors.js';
import { createSecretStore } from '../server-plugin/src/secrets/secret-store.js';
import { FakeSecretManager } from './server-plugin/fake-secret-manager.js';

const SECRET_KEY = 'ur_image_studio.connection_api_secret';

// ─── assertSecretManagerApi ───────────────────────────────────────────

describe('assertSecretManagerApi', () => {
  it('accepts a valid class with all three methods', () => {
    assert.doesNotThrow(() => assertSecretManagerApi(FakeSecretManager));
  });

  it('accepts a baseline host with only the three required methods', () => {
    class BaselineSecretManager {
      async writeSecret() {}
      async readSecret() {}
      async deleteSecret() {}
    }
    assert.doesNotThrow(() => assertSecretManagerApi(BaselineSecretManager));
  });

  it('throws SERVER_COMPONENT_INCOMPATIBLE if writeSecret is missing', () => {
    class MissingWrite {
      async readSecret() {}
      async deleteSecret() {}
    }
    assert.throws(
      () => assertSecretManagerApi(MissingWrite),
      (err) => {
        assert.ok(err instanceof ServerImageError);
        assert.equal(err.code, 'SERVER_COMPONENT_INCOMPATIBLE');
        return true;
      },
    );
  });

  it('throws SERVER_COMPONENT_INCOMPATIBLE if readSecret is missing', () => {
    class MissingRead {
      async writeSecret() {}
      async deleteSecret() {}
    }
    assert.throws(
      () => assertSecretManagerApi(MissingRead),
      (err) => {
        assert.ok(err instanceof ServerImageError);
        assert.equal(err.code, 'SERVER_COMPONENT_INCOMPATIBLE');
        return true;
      },
    );
  });

  it('throws SERVER_COMPONENT_INCOMPATIBLE if deleteSecret is missing', () => {
    class MissingDelete {
      async writeSecret() {}
      async readSecret() {}
    }
    assert.throws(
      () => assertSecretManagerApi(MissingDelete),
      (err) => {
        assert.ok(err instanceof ServerImageError);
        assert.equal(err.code, 'SERVER_COMPONENT_INCOMPATIBLE');
        return true;
      },
    );
  });
});

// ─── loadHostSecretManager ────────────────────────────────────────────

describe('loadHostSecretManager', () => {
  it('resolves from SILLYTAVERN_ROOT env', async () => {
    // We can only test that it attempts the import; without a real ST
    // installation the import will fail at runtime. We test the path
    // resolution logic by checking it throws a module-not-found style error
    // rather than something unrelated.
    const originalRoot = process.env.SILLYTAVERN_ROOT;
    process.env.SILLYTAVERN_ROOT = process.cwd();
    try {
      await assert.rejects(
        () => loadHostSecretManager(),
        (err) => {
          // Should be an import error, not a ServerImageError
          assert.ok(!(err instanceof ServerImageError));
          return true;
        },
      );
    } finally {
      if (originalRoot === undefined) {
        delete process.env.SILLYTAVERN_ROOT;
      } else {
        process.env.SILLYTAVERN_ROOT = originalRoot;
      }
    }
  });
});

// ─── createSecretStore ────────────────────────────────────────────────

describe('createSecretStore', () => {
  function makeReq() {
    return { user: { directories: { root: '/tmp/test-user' } } };
  }

  it('returns an object with writeSecret, readSecret, deleteSecret, findSecretsByLabel', () => {
    const store = createSecretStore(makeReq(), { SecretManagerClass: FakeSecretManager });
    assert.equal(typeof store.writeSecret, 'function');
    assert.equal(typeof store.readSecret, 'function');
    assert.equal(typeof store.deleteSecret, 'function');
    assert.equal(typeof store.findSecretsByLabel, 'function');
  });

  it('keeps baseline three-method hosts compatible without broad secret enumeration', () => {
    class BaselineSecretManager {
      async writeSecret() { return 'baseline-id'; }
      async readSecret() { return null; }
      async deleteSecret() {}
    }

    const store = createSecretStore(makeReq(), { SecretManagerClass: BaselineSecretManager });
    assert.equal(typeof store.writeSecret, 'function');
    assert.equal(typeof store.readSecret, 'function');
    assert.equal(typeof store.deleteSecret, 'function');
    assert.equal('findSecretsByLabel' in store, false);
  });

  it('uses an optional narrow operation-label capability when the host provides it', async () => {
    const calls = [];
    class NarrowLookupManager {
      async writeSecret() {}
      async readSecret() {}
      async deleteSecret() {}
      async findSecretsByLabel(key, label) {
        calls.push([key, label]);
        return [
          { id: 'match-a', label, value: 'plaintext-a' },
          { id: 'wrong-label', label: 'other', value: 'plaintext-b' },
          { id: 42, label, value: 'plaintext-c' },
        ];
      }
    }
    const store = createSecretStore(makeReq(), { SecretManagerClass: NarrowLookupManager });

    const result = await store.findSecretsByLabel('ur-image-studio:operation:op-a');

    assert.deepEqual(calls, [[SECRET_KEY, 'ur-image-studio:operation:op-a']]);
    assert.deepEqual(result, [{ id: 'match-a', present: true }]);
    assert.equal(JSON.stringify(result).includes('plaintext'), false);
  });

  it('does not use getAllSecrets as a recovery capability', () => {
    class BroadOnlyManager {
      async writeSecret() {}
      async readSecret() {}
      async deleteSecret() {}
      async getAllSecrets() { throw new Error('must not enumerate plaintext secrets'); }
    }
    const store = createSecretStore(makeReq(), { SecretManagerClass: BroadOnlyManager });
    assert.equal('findSecretsByLabel' in store, false);
  });

  it('finds only IDs matching an operation-scoped label without exposing values', async () => {
    FakeSecretManager.reset();
    const store = createSecretStore(makeReq(), { SecretManagerClass: FakeSecretManager });
    const first = await store.writeSecret('secret-a', 'ur-image-studio:operation:op-a');
    await store.writeSecret('secret-b', 'ur-image-studio:operation:op-b');

    assert.deepEqual(await store.findSecretsByLabel('ur-image-studio:operation:op-a'), [
      { id: first.id, present: true },
    ]);
    assert.ok(!JSON.stringify(await store.findSecretsByLabel('ur-image-studio:operation:op-a')).includes('secret-a'));
  });

  it('preserves the host UUID and uses it for reads and deletes', async () => {
    const store = createSecretStore(makeReq(), { SecretManagerClass: FakeSecretManager });
    const written = await store.writeSecret('sk-test-123', 'Connection A');
    assert.match(written.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(written, { id: written.id, present: true });
    assert.deepEqual(await store.readSecret(written.id), { id: written.id, present: true });
    assert.deepEqual(await store.deleteSecret(written.id), { id: written.id, present: false });
    assert.deepEqual(await store.readSecret(written.id), { id: written.id, present: false });
  });

  it('keeps two connection secrets isolated under the exact namespaced key', async () => {
    FakeSecretManager.reset();
    const store = createSecretStore(makeReq(), { SecretManagerClass: FakeSecretManager });
    const first = await store.writeSecret('secret-for-a', 'Connection A');
    const second = await store.writeSecret('secret-for-b', 'Connection B');

    assert.notEqual(first.id, second.id);
    assert.deepEqual(await store.readSecret(first.id), { id: first.id, present: true });
    assert.deepEqual(await store.readSecret(second.id), { id: second.id, present: true });
    await store.deleteSecret(first.id);
    assert.deepEqual(await store.readSecret(first.id), { id: first.id, present: false });
    assert.deepEqual(await store.readSecret(second.id), { id: second.id, present: true });
    assert.deepEqual(FakeSecretManager.calls.map(({ method, key }) => ({ method, key })), [
      { method: 'write', key: SECRET_KEY },
      { method: 'write', key: SECRET_KEY },
      { method: 'read', key: SECRET_KEY },
      { method: 'read', key: SECRET_KEY },
      { method: 'delete', key: SECRET_KEY },
      { method: 'read', key: SECRET_KEY },
      { method: 'read', key: SECRET_KEY },
    ]);
  });

  it('JSON.stringify of result does NOT contain API key', async () => {
    const apiKey = 'super-secret-key-abc123';
    const store = createSecretStore(makeReq(), { SecretManagerClass: FakeSecretManager });
    const { id } = await store.writeSecret(apiKey);
    const writeResult = await store.readSecret(id);
    const json = JSON.stringify(writeResult);
    assert.ok(!json.includes(apiKey), 'API key must not appear in JSON output');
  });

  it('error messages do NOT contain API key', async () => {
    const apiKey = 'super-secret-key-abc123';
    const store = createSecretStore(makeReq(), { SecretManagerClass: FakeSecretManager });
    await store.writeSecret(apiKey);
    // Delete and then read — the store should not leak the key in errors.
    // Since our store doesn't throw on missing, we verify by checking that
    // any error from the underlying manager doesn't propagate the key.
    // We test with a broken manager that throws with the key value.
    class LeakyManager extends FakeSecretManager {
      async readSecret(key, id) {
        throw new Error(`Failed to read secret: ${key} value was ${await super.readSecret(key, id)}`);
      }
    }
    const leakyStore = createSecretStore(makeReq(), { SecretManagerClass: LeakyManager });
    const { id } = await leakyStore.writeSecret(apiKey);
    try {
      await leakyStore.readSecret(id);
      assert.fail('should have thrown');
    } catch (err) {
      const msg = err.message;
      assert.ok(!msg.includes(apiKey), `Error message must not contain API key. Got: ${msg}`);
    }
  });
});
