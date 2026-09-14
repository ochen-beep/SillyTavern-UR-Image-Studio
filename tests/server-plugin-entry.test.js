import { afterEach, describe, it } from 'node:test';
import { existsSync } from 'node:fs';
import { getUserPaths } from '../server-plugin/src/storage/paths.js';
import { materializeArtifact } from '../server-plugin/src/storage/artifact-store.js';
import { listRequests } from '../server-plugin/src/journal/journal.js';
import { createConnection } from '../server-plugin/src/storage/connections-store.js';
import { writeJson } from '../server-plugin/src/storage/atomic-json.js';
import { FakeSecretManager } from './server-plugin/fake-secret-manager.js';
import { cleanupTempDir, useTempDir } from './server-plugin/temp-store.js';

import assert from 'node:assert/strict';
import * as plugin from '../server-plugin/index.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) cleanupTempDir(root); FakeSecretManager.reset(); });

describe('server-plugin entry', () => {
  it('exports info with required shape', () => {
    assert.deepEqual(plugin.info, {
      id: 'ur-image-studio',
      name: 'UR Image Studio',
      description: 'Server execution for UR Image Studio image APIs',
    });
  });

  it('exports init as a function', () => {
    assert.equal(typeof plugin.init, 'function');
  });

  it('exports exit as a function', () => {
    assert.equal(typeof plugin.exit, 'function');
  });

	it('uid from standalone id.js generates unique strings of expected format', async () => {
	    const { uid } = await import('../server-plugin/src/id.js');
	    const a = uid();
	    const b = uid();
	    assert.equal(typeof a, 'string');
	    assert.equal(typeof b, 'string');
	    assert.notEqual(a, b);
	    assert.match(a, /^[0-9a-z]+$/);
	    assert.equal(a.length, b.length);
	});

	it('server-plugin modules can be imported standalone without accessing client src/', async () => {
	    // This test fails if server-plugin/src/services/connections.js (or any
	    // module it transitively imports) reaches outside server-plugin/ into
	    // src/core.js or other client code — ensuring Termux compatibility.
	    const mod = await import('../server-plugin/src/services/connections.js');
	    assert.ok(mod);
	    assert.equal(typeof mod.createConnectionService, 'function');
	});

	it('production service deletion removes journal rows and artifacts', async () => {
    const root = useTempDir(); roots.push(root);
    const req = { user: { directories: { root } } };
    const paths = getUserPaths(req);
    const artifact = await materializeArtifact({
      paths, requestId: 'delete-production',
      result: { kind: 'bytes', value: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), mimeType: 'image/png' },
    });
    await writeJson(paths.requests, [{
      requestId: 'delete-production', fingerprint: 'a'.repeat(64), connectionId: 'connection123456',
      route: {}, state: 'ready', artifact, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }]);
    await createConnection(paths, {
      id: 'connection123456', name: 'Delete', endpoint: 'https://api.example.com/v1',
      modelRouteId: 'route123456', selectedRoute: { id: 'route123456', modelId: 'm', label: 'm', apiFamily: 'openai-images', source: 'manual', confidence: 'manual', capabilities: { generate: 'supported', references: 'unknown', maxReferences: null, aspectRatios: null, imageSizes: null, qualityValues: null } },
      apiFamilyOverride: 'openai-images', secretId: null, timeoutMs: 300000,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const services = await plugin.createDefaultServices({ SecretManagerClass: FakeSecretManager });
    await services.deleteConnection(req, 'connection123456');
    assert.deepEqual(await listRequests(paths), []);
    assert.equal(existsSync(`${paths.root}/${artifact.relativePath}`), false);
  });

});
