// @ts-check
/**
 * Conditional SillyTavern compatibility suite.
 *
 * All tests requiring a real ST installation are grouped under a parent
 * describe that skips when SILLYTAVERN_ROOT is not set.  The "no production
 * absolute ST path" check runs unconditionally because it only needs the source
 * tree.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { info, init, exit } from '../server-plugin/index.js';
import { assertSecretManagerApi } from '../server-plugin/src/host/sillytavern.js';
import { registerRoutes } from '../server-plugin/src/router.js';
import { createFakeRouter } from './server-plugin/fake-router.js';

// ─── Helpers ───────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('..', import.meta.url));
const pluginDir = resolve(__dirname, 'server-plugin');
const pluginNodeModules = resolve(pluginDir, 'node_modules');

const ST_ROOT = process.env.SILLYTAVERN_ROOT;
const hasST = typeof ST_ROOT === 'string' && ST_ROOT.trim().length > 0;

// ─── 1-7: Conditional ST compatibility suite ──────────────────────

describe('SillyTavern compatibility', { skip: !hasST ? 'SILLYTAVERN_ROOT not set — skipping ST integration tests' : false }, () => {
  it('Node.js >= 20', () => {
    const [major] = process.versions.node.split('.').map(Number);
    assert.ok(major >= 20, `Node.js version ${process.versions.node} is below minimum 20`);
  });

  // ── npm dependencies ─────────────────────────────────────────

  it('node-fetch is installable', () => {
    const pkgPath = resolve(pluginNodeModules, 'node-fetch', 'package.json');
    accessSync(pkgPath);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    assert.equal(pkg.name, 'node-fetch');
  });

  it('write-file-atomic is installable', () => {
    const pkgPath = resolve(pluginNodeModules, 'write-file-atomic', 'package.json');
    accessSync(pkgPath);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    assert.equal(pkg.name, 'write-file-atomic');
  });

  // ── SecretManager API contract ───────────────────────────────

  it('SecretManager API contract: writeSecret, readSecret, deleteSecret exist', () => {
    class MinimalSecretManager {
      async writeSecret() {}
      async readSecret() {}
      async deleteSecret() {}
    }
    assert.doesNotThrow(() => assertSecretManagerApi(MinimalSecretManager));

    class MissingDelete {
      async writeSecret() {}
      async readSecret() {}
    }
    assert.throws(
      () => assertSecretManagerApi(MissingDelete),
      (err) => err.code === 'SERVER_COMPONENT_INCOMPATIBLE',
    );
  });

  // ── Plugin exports ───────────────────────────────────────────

  it('plugin exports info, init, and exit', () => {
    assert.equal(typeof info, 'object');
    assert.equal(typeof init, 'function');
    assert.equal(typeof exit, 'function');
  });

  it('info includes id, name, description with correct values', () => {
    assert.equal(info.id, 'ur-image-studio');
    assert.equal(info.name, 'UR Image Studio');
    assert.equal(typeof info.description, 'string');
    assert.ok(info.description.length > 0);
  });

  // ── Router registration ──────────────────────────────────────

  it('router registers expected routes', () => {
    const { router, routes } = createFakeRouter();
    registerRoutes(router, {
      ensureReconciled: async () => {},
      listConnections: async () => [],
    });

    const expected = [
      { method: 'GET', path: '/v1/status' },
      { method: 'GET', path: '/v1/connections' },
      { method: 'GET', path: '/v1/connections/export' },
      { method: 'POST', path: '/v1/connections/import' },
      { method: 'POST', path: '/v1/connections/import/:importOperationId/rollback' },
      { method: 'POST', path: '/v1/connections/probe' },
      { method: 'POST', path: '/v1/connections/:connectionId/probe' },
      { method: 'POST', path: '/v1/connections' },
      { method: 'PUT', path: '/v1/connections/:connectionId' },
      { method: 'DELETE', path: '/v1/connections/:connectionId' },
      { method: 'POST', path: '/v1/generate' },
      { method: 'GET', path: '/v1/requests/:requestId' },
    ];

    assert.equal(routes.length, expected.length);
    for (const [index, exp] of expected.entries()) {
      assert.equal(routes[index].method, exp.method, `route[${index}] method mismatch`);
      assert.equal(routes[index].path, exp.path, `route[${index}] path mismatch`);
    }
  });

  // ── Init reconciliation ──────────────────────────────────────

  it('init reconciles without throwing (with injected services)', async () => {
    const { router } = createFakeRouter();
    let reconcileCalled = false;

    await init(router, {
      async verifyHostCompatibility() {},
      async ensureReconciled() {
        reconcileCalled = true;
      },
      async listConnections() { return []; },
    });

    assert.equal(reconcileCalled, false, 'init should not call ensureReconciled directly');
  });

  // ── Exit function ────────────────────────────────────────────

  it('exit is a function', () => {
    assert.equal(typeof exit, 'function');
    assert.doesNotThrow(() => exit());
  });
});

// ─── 8. No production absolute ST path ─────────────────────────────

describe('no hardcoded absolute SillyTavern path in production source', () => {
  const srcDir = resolve(__dirname, 'server-plugin', 'src');
  const pluginIndex = resolve(__dirname, 'server-plugin', 'index.js');

  // All production source files to check
  const filesToCheck = [
    pluginIndex,
    resolve(srcDir, 'host', 'sillytavern.js'),
    resolve(srcDir, 'router.js'),
    resolve(srcDir, 'errors.js'),
    resolve(srcDir, 'validation.js'),
    resolve(srcDir, 'services', 'connections.js'),
    resolve(srcDir, 'services', 'generation.js'),
    resolve(srcDir, 'services', 'probe.js'),
    resolve(srcDir, 'services', 'receipt-cache.js'),
    resolve(srcDir, 'services', 'request-status.js'),
    resolve(srcDir, 'storage', 'paths.js'),
    resolve(srcDir, 'storage', 'connections-store.js'),
    resolve(srcDir, 'storage', 'operations-store.js'),
    resolve(srcDir, 'storage', 'artifact-store.js'),
    resolve(srcDir, 'storage', 'atomic-json.js'),
    resolve(srcDir, 'storage', 'journal-key-store.js'),
    resolve(srcDir, 'storage', 'mutex.js'),
    resolve(srcDir, 'storage', 'request-store.js'),
    resolve(srcDir, 'storage', 'catalog-store.js'),
    resolve(srcDir, 'journal', 'journal.js'),
    resolve(srcDir, 'journal', 'reconciliation.js'),
    resolve(srcDir, 'journal', 'retention.js'),
    resolve(srcDir, 'journal', 'states.js'),
    resolve(srcDir, 'network', 'endpoint.js'),
    resolve(srcDir, 'network', 'destination-policy.js'),
    resolve(srcDir, 'network', 'safe-fetch.js'),
    resolve(srcDir, 'secrets', 'secret-store.js'),
    resolve(srcDir, 'adapters', 'index.js'),
    resolve(srcDir, 'adapters', 'common.js'),
    resolve(srcDir, 'adapters', 'coordinator.js'),
    resolve(srcDir, 'adapters', 'openai-images.js'),
    resolve(srcDir, 'adapters', 'openrouter-images.js'),
    resolve(srcDir, 'adapters', 'gemini-native.js'),
  ];

  // Patterns matching hardcoded absolute paths referencing SillyTavern
  const absolutePathPatterns = [
    /['"`]\/home\/\w+\/SillyTavern/i,
    /['"`]\/Users\/\w+\/SillyTavern/i,
    /['"`]\/tmp\/SillyTavern/i,
    /['"`][A-Za-z]:\\SillyTavern/i,
    /['"`][A-Za-z]:\\Users\\\w+\\SillyTavern/i,
    /['"`]\/SillyTavern\//i,
  ];

  for (const fp of filesToCheck) {
    const relativePath = fp.replace(resolve(__dirname, 'server-plugin'), 'server-plugin');
    try {
      const content = readFileSync(fp, 'utf8');
      const lines = content.split('\n');

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];

        // Check against known absolute path patterns
        for (const pattern of absolutePathPatterns) {
          const match = line.match(pattern);
          if (match) {
            // Allow occurrences that reference the SILLYTAVERN_ROOT env var
            if (line.includes('SILLYTAVERN_ROOT')) continue;
            if (line.includes('path.join') || line.includes('resolve(')) continue;
            assert.fail(
              `${relativePath}:${lineIdx + 1} contains hardcoded absolute path:\n` +
              `  ${line.trim()}`,
            );
          }
        }

        // Generic check: any string literal containing both a filesystem
        // separator and "SillyTavern" (case-insensitive) — unless it's
        // referencing the env var or a join/resolve pattern.
        const pathInLiteral = line.match(/['"`]((?:\/|[A-Za-z]:\\)\S*[Ss]illy[Tt]avern\S*)['"`]/);
        if (pathInLiteral && pathInLiteral[1].includes(sep)) {
          if (!line.includes('SILLYTAVERN_ROOT') && !line.includes('path.join') && !line.includes('resolve(') && !line.includes('pathToFileURL')) {
            assert.fail(
              `${relativePath}:${lineIdx + 1} contains hardcoded absolute path:\n` +
              `  ${line.trim()}`,
            );
          }
        }
      }
    } catch (err) {
      if (err.code === 'ENOENT') continue; // Skip if file doesn't exist
      throw err;
    }
  }
});
