import { randomUUID } from 'node:crypto';

/**
 * In-memory SecretManager implementation for testing.
 * Mirrors the SillyTavern SecretManager constructor(directories) shape.
 */
export class FakeSecretManager {
  static calls = [];
  static stores = new Map();

  static reset() {
    this.calls = [];
    this.stores.clear();
  }

  /** @param {{ root?: string }} directories */
  constructor(directories) {
    const scope = directories?.root ?? '';
    if (!FakeSecretManager.stores.has(scope)) FakeSecretManager.stores.set(scope, new Map());
    this._store = FakeSecretManager.stores.get(scope);
    this._directories = directories;
  }

  async writeSecret(key, value, label) {
    const id = randomUUID();
    this._store.set(`${key}:${id}`, { id, value, label, active: true });
    FakeSecretManager.calls.push({ method: 'write', key, id, label });
    return id;
  }

  async readSecret(key, id) {
    FakeSecretManager.calls.push({ method: 'read', key, id });
    return this._store.get(`${key}:${id}`)?.value ?? null;
  }

  async deleteSecret(key, id) {
    FakeSecretManager.calls.push({ method: 'delete', key, id });
    this._store.delete(`${key}:${id}`);
  }

  async findSecretsByLabel(key, label) {
    const result = [];
    for (const entry of this._store.values()) {
      const call = FakeSecretManager.calls.find(item => item.id === entry.id && item.key === key);
      if (call && entry.label === label) result.push({ ...entry });
    }
    return result;
  }

  getAllSecrets() {
    const result = {};
    for (const entry of this._store.values()) {
      const call = FakeSecretManager.calls.find(item => item.id === entry.id);
      if (!call) continue;
      if (!result[call.key]) result[call.key] = [];
      result[call.key].push({ ...entry });
    }
    return result;
  }
}
