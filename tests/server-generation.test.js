import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { claimRequest, fingerprintRequest, getRequest, listRequests, transitionRequest } from '../server-plugin/src/journal/journal.js';
import { getOrCreateJournalKey } from '../server-plugin/src/storage/journal-key-store.js';
import { getUserPaths } from '../server-plugin/src/storage/paths.js';
import { readArtifact } from '../server-plugin/src/storage/artifact-store.js';
import { createGenerationService } from '../server-plugin/src/services/generation.js';
import { createRequestStatusService } from '../server-plugin/src/services/request-status.js';
import { cleanupTempDir, useTempDir } from './server-plugin/temp-store.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const ROUTE = {
  id: 'route-1', apiFamily: 'test-family', modelId: 'image-1', source: 'catalog',
  capabilities: { generate: 'supported', references: 'supported', maxReferences: 2 },
};
let roots;
beforeEach(() => { roots = []; });
afterEach(() => { for (const root of roots) cleanupTempDir(root); });
function makeReq() {
  const root = useTempDir(); roots.push(root);
  return { user: { directories: { root } } };
}
function body(overrides = {}) {
  return {
    requestId: 'request-1', connectionId: 'conn-1', prompt: 'a lighthouse',
    references: [], ...overrides,
  };
}
function connection() {
  return { id: 'conn-1', endpoint: 'https://api.example.test', secretId: 'secret-1', timeoutMs: 1000,
    selectedRoute: ROUTE, modelRouteId: 'route-1', apiFamilyOverride: 'test-family' };
}
async function seedState(req, state, patch = {}) {
  const paths = getUserPaths(req);
  const key = await getOrCreateJournalKey(paths);
  await claimRequest(paths, {
    requestId: 'request-1',
    fingerprint: await fingerprintRequest(key, { ...body(), selectedRoute: ROUTE }),
    connectionId: 'conn-1',
    route: ROUTE,
  });
  const route = {
    claimed: [],
    'not-dispatched': ['not-dispatched'],
    dispatching: ['dispatching'],
    'upstream-accepted': ['dispatching', 'upstream-accepted'],
    'result-received': ['dispatching', 'result-received'],
    failed: ['failed'],
    'failed-ambiguous': ['dispatching', 'failed-ambiguous'],
  }[state] ?? [];
  for (const next of route) await transitionRequest(paths, 'request-1', next, next === state ? patch : {});
  return paths;
}

await describe('journaled generation coordinator', async () => {
  it('single-flights duplicate requests and persists the exact dispatch boundary', async () => {
    const req = makeReq(); const paths = getUserPaths(req); const events = []; let calls = 0;
    const service = createGenerationService({
      getConnection: async () => connection(), readSecret: async () => 'raw-secret',
      adapters: [{ apiFamily: 'test-family', async generate(context) {
        calls++; events.push('adapter'); assert.equal(context.secret, 'raw-secret');
        await context.beforeDispatch(); events.push('body'); return { kind: 'bytes', value: PNG, mimeType: 'image/png' };
      } }],
      onTransition: (state, row) => { events.push(state); if (state === 'result-received') events.push(row); },
    });
    const [one, two] = await Promise.all([service.executeGeneration(req, body()), service.executeGeneration(req, body())]);
    assert.equal(calls, 1); assert.deepEqual(one, two); assert.deepEqual(events.slice(0, 5), ['claimed', 'adapter', 'dispatching', 'body', 'result-received']);
    const resultReceived = events.find(event => typeof event === 'object' && event.state === 'result-received');
    assert.ok(resultReceived.artifact); assert.equal(resultReceived.providerResult, null);
    assert.equal((await getRequest(paths, 'request-1')).state, 'ready');
  });

  it('rejects malformed references before adapter dispatch without slicing', async () => {
    const req = makeReq(); let calls = 0;
    const service = createGenerationService({ getConnection: async () => connection(), readSecret: async () => 'x', adapters: [{ apiFamily: 'test-family', async generate() { calls++; } }] });
    await assert.rejects(() => service.executeGeneration(req, body({ references: [{ dataUrl: 'not-data' }] })), /reference/i);
    assert.equal(calls, 0);
    await assert.rejects(() => service.executeGeneration(req, body({ requestId: 'request-2', references: Array.from({ length: 3 }, () => ({ dataUrl: 'data:image/png;base64,AA==' })) })), /reference/i);
    assert.equal(calls, 0);
  });

  it('dispatches one selected adapter for unknown reference support without fallback', async () => {
    const req = makeReq(); let selected = 0; let fallback = 0;
    const unknownRoute = { ...ROUTE, capabilities: { ...ROUTE.capabilities, references: 'unknown' } };
    const unknownConnection = { ...connection(), selectedRoute: unknownRoute };
    const service = createGenerationService({ getConnection: async () => unknownConnection, readSecret: async () => 'x', adapters: [
      { apiFamily: 'test-family', async generate(context) { await context.beforeDispatch(); selected++; return { kind: 'bytes', value: PNG, mimeType: 'image/png' }; } },
      { apiFamily: 'other-family', async generate(context) { await context.beforeDispatch(); fallback++; return { kind: 'bytes', value: PNG, mimeType: 'image/png' }; } },
    ] });
    await service.executeGeneration(req, body({ references: [{ dataUrl: `data:image/png;base64,${PNG.toString('base64')}` }] }));
    assert.equal(selected, 1); assert.equal(fallback, 0);
  });

  it('accepts only the exact public generation body and never redirects adapter dispatch', async () => {
    const req = makeReq(); let calls = 0;
    const service = createGenerationService({ getConnection: async () => connection(), readSecret: async () => 'x', adapters: [
      { apiFamily: 'test-family', async generate() { calls++; } },
    ] });
    for (const injected of [
      { selectedRoute: { ...ROUTE, apiFamily: 'missing-family' } },
      { upstreamRoute: { apiFamily: 'missing-family' } },
      { endpoint: 'https://attacker.example.test' },
      { adapterOptions: { apiFamily: 'missing-family' } },
    ]) {
      await assert.rejects(
        () => service.executeGeneration(req, body({ requestId: `request-${calls + 2}`, ...injected })),
        error => error.code === 'INVALID_GENERATION_REQUEST',
      );
    }
    assert.equal(calls, 0);
  });

  it('uses the persisted route in the fingerprint so a route change conflicts for the same request ID', async () => {
    const req = makeReq();
    let persisted = connection();
    const service = createGenerationService({
      getConnection: async () => persisted,
      readSecret: async () => 'x',
      adapters: [{ apiFamily: 'test-family', async generate(context) { await context.beforeDispatch(); return { kind: 'bytes', value: PNG, mimeType: 'image/png' }; } }],
    });
    await service.executeGeneration(req, body());
    persisted = { ...persisted, selectedRoute: { ...ROUTE, modelId: 'image-2' } };
    await assert.rejects(() => service.executeGeneration(req, body()), error => error.code === 'REQUEST_ID_CONFLICT');
  });

  it('enforces retention after the single-flight generation finishes', async () => {
    const req = makeReq();
    const calls = [];
    const service = createGenerationService({
      getConnection: async () => connection(), readSecret: async () => 'x',
      adapters: [{ apiFamily: 'test-family', async generate(context) { calls.push('adapter'); await context.beforeDispatch(); return { kind: 'bytes', value: PNG, mimeType: 'image/png' }; } }],
      enforceRetention: async paths => { calls.push(['retention', paths]); },
    });
    await service.executeGeneration(req, body());
    assert.equal(calls[0], 'adapter');
    assert.equal(calls[1][0], 'retention');
    assert.equal(calls[1][1].root, getUserPaths(req).root);
  });

  it('marks dispatch uncertainty and never retries the adapter', async () => {
    const req = makeReq(); let calls = 0;
    const service = createGenerationService({ getConnection: async () => connection(), readSecret: async () => 'x', adapters: [{ apiFamily: 'test-family', async generate(context) { calls++; await context.beforeDispatch(); const error = new Error('timeout'); error.code = 'TIMEOUT'; throw error; } }] });
    await assert.rejects(() => service.executeGeneration(req, body()), /timeout|generation/i);
    assert.equal(calls, 1); assert.equal((await getRequest(getUserPaths(req), 'request-1')).state, 'failed-ambiguous');
  });

  it('returns a safe artifact-backed ready DTO and hides journal secrets', async () => {
    const req = makeReq();
    const service = createGenerationService({ getConnection: async () => connection(), readSecret: async () => 'raw-secret', adapters: [{ apiFamily: 'test-family', async generate(context) { await context.beforeDispatch(); return { kind: 'bytes', value: PNG, mimeType: 'image/png' }; } }] });
    const executed = await service.executeGeneration(req, body());
    const status = createRequestStatusService(); const dto = await status.getRequestStatus(req, 'request-1');
    assert.deepEqual(executed, dto);
    assert.deepEqual(Object.keys(dto).sort(), ['diagnosticsId', 'requestId', 'result', 'state']);
    assert.equal(dto.result.kind, 'dataUrl'); assert.match(dto.result.value, /^data:image\/png;base64,/);
    const journal = JSON.stringify(await listRequests(getUserPaths(req))); assert.equal(journal.includes('raw-secret'), false); assert.equal(journal.includes('lighthouse'), false);
    assert.deepEqual(await readArtifact(getUserPaths(req), (await getRequest(getUserPaths(req), 'request-1')).artifact), PNG);
  });

  it('never stores a large provider base64 payload in requests.json', async () => {
    const req = makeReq();
    const largePng = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024, 7)]);
    const encoded = largePng.toString('base64');
    const service = createGenerationService({ getConnection: async () => connection(), readSecret: async () => 'x', adapters: [{ apiFamily: 'test-family', async generate(context) { await context.beforeDispatch(); return { kind: 'base64', value: encoded, mimeType: 'image/png' }; } }] });
    const dto = await service.executeGeneration(req, body());
    assert.equal(dto.state, 'ready');
    const journalText = readFileSync(getUserPaths(req).requests, 'utf8');
    assert.equal(journalText.includes(encoded.slice(0, 1024)), false);
    assert.ok(Buffer.byteLength(journalText) < 16 * 1024);
  });

  it('returns safe status for settled requests and never pays twice', async () => {
    const req = makeReq(); let calls = 0;
    const service = createGenerationService({ getConnection: async () => connection(), readSecret: async () => 'x', adapters: [{ apiFamily: 'test-family', async generate(context) { calls++; await context.beforeDispatch(); return { kind: 'bytes', value: PNG, mimeType: 'image/png' }; } }] });
    const first = await service.executeGeneration(req, body());
    const second = await service.executeGeneration(req, body());
    assert.deepEqual(second, first); assert.equal(calls, 1);
    assert.deepEqual(Object.keys(second).sort(), ['diagnosticsId', 'requestId', 'result', 'state']);
  });

  it('does not redispatch existing dispatching or upstream-accepted states', async () => {
    for (const state of ['dispatching', 'upstream-accepted']) {
      const req = makeReq(); await seedState(req, state); let calls = 0;
      const service = createGenerationService({ getConnection: async () => connection(), readSecret: async () => 'x', adapters: [{ apiFamily: 'test-family', async generate() { calls++; } }] });
      const dto = await service.executeGeneration(req, body());
      assert.equal(calls, 0); assert.equal(dto.state, 'failed-ambiguous');
      assert.deepEqual(Object.keys(dto).sort(), ['diagnosticsId', 'requestId', 'state']);
    }
  });

  it('resumes durable result-received URL materialization without adapter dispatch', async () => {
    const req = makeReq();
    const url = 'https://cdn.example.test/image?signature=complete';
    await seedState(req, 'result-received', { providerResult: { kind: 'url', value: url, mimeType: 'image/png' } });
    let calls = 0;
    const service = createGenerationService({
      getConnection: async () => connection(), readSecret: async () => 'x',
      adapters: [{ apiFamily: 'test-family', async generate() { calls++; } }],
      safeRequest: async options => {
        assert.equal(options.url, url);
        return { status: 200, headers: new Headers({ 'content-type': 'image/png' }), async arrayBuffer() { return PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength); } };
      },
    });
    const dto = await service.executeGeneration(req, body());
    assert.equal(calls, 0); assert.equal(dto.state, 'ready'); assert.match(dto.result.value, /^data:image\/png;base64,/);
  });

  it('allows safely not-dispatched work to execute once', async () => {
    const req = makeReq(); await seedState(req, 'not-dispatched'); let calls = 0;
    const service = createGenerationService({ getConnection: async () => connection(), readSecret: async () => 'x', adapters: [{ apiFamily: 'test-family', async generate(context) { calls++; await context.beforeDispatch(); return { kind: 'bytes', value: PNG, mimeType: 'image/png' }; } }] });
    const dto = await service.executeGeneration(req, body());
    assert.equal(calls, 1); assert.equal(dto.state, 'ready');
  });

  it('never exposes journal fields or provider results from non-ready states', async () => {
    const req = makeReq();
    await seedState(req, 'failed', { providerResult: { kind: 'url', value: 'https://cdn.example.test/private?token=secret' }, error: { code: 'PRIVATE', diagnosticsId: 'diag-1', detail: 'leak' } });
    const dto = await createGenerationService({ getConnection: async () => connection() }).executeGeneration(req, body());
    assert.deepEqual(dto, { requestId: 'request-1', state: 'failed', diagnosticsId: 'diag-1' });
    assert.equal(JSON.stringify(dto).includes('secret'), false);
    assert.equal(JSON.stringify(dto).includes('fingerprint'), false);
  });
});
