import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { statSync, readFileSync } from 'node:fs';
import { getUserPaths } from '../server-plugin/src/storage/paths.js';
import { getOrCreateJournalKey } from '../server-plugin/src/storage/journal-key-store.js';
import { fingerprintRequest } from '../server-plugin/src/journal/journal.js';
import { claimRequest, getRequest, listRequests, transitionRequest, runSingleFlight } from '../server-plugin/src/journal/journal.js';
import { reconcileJournal } from '../server-plugin/src/journal/reconciliation.js';
import { useTempDir, cleanupTempDir } from './server-plugin/temp-store.js';

function paths(root) { return getUserPaths({ user: { directories: { root } } }); }
function request(overrides = {}) {
  return { connectionId: 'conn-1', selectedRoute: { id: 'route-1', apiFamily: 'openai-images', modelId: 'image-1', source: 'catalog' }, prompt: 'a lighthouse', aspectRatio: '1:1', imageSize: '1024x1024', quality: 'high', references: [{ id: 'ref-1', name: 'style.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAE=' }], ...overrides };
}

let dirs;
beforeEach(() => { dirs = []; });
afterEach(() => { for (const dir of dirs) cleanupTempDir(dir); });
function makePaths() { const dir = useTempDir(); dirs.push(dir); return paths(dir); }

await describe('durable request journal', async () => {
  await it('creates one durable 32-byte key concurrently with private permissions', async () => {
    const p = makePaths();
    const keys = await Promise.all(Array.from({ length: 20 }, () => getOrCreateJournalKey(p)));
    assert.equal(new Set(keys.map(k => k.toString('hex'))).size, 1);
    assert.equal(keys[0].length, 32);
    assert.equal(statSync(p.journalKeyFile).mode & 0o777, process.platform === 'win32' ? 0o666 : 0o600);
    assert.deepEqual(keys[0], await getOrCreateJournalKey(p));
  });

  await it('fingerprint survives restart and differs across users', async () => {
    const p1 = makePaths(); const p2 = makePaths();
    const fp = await fingerprintRequest(await getOrCreateJournalKey(p1), request());
    assert.equal(fp, await fingerprintRequest(await getOrCreateJournalKey(p1), request()));
    assert.notEqual(fp, await fingerprintRequest(await getOrCreateJournalKey(p2), request()));
  });

  await it('fingerprint is sensitive to explicit fields and reference bytes', async () => {
    const p = makePaths(); const key = await getOrCreateJournalKey(p);
    const base = await fingerprintRequest(key, request());
    for (const change of [{ prompt: 'different' }, { aspectRatio: '16:9' }, { selectedRoute: { ...request().selectedRoute, modelId: 'other' } }, { references: [{ ...request().references[0], dataUrl: 'data:image/png;base64,AAI=' }] }]) {
      assert.notEqual(base, await fingerprintRequest(key, request(change)));
    }
  });

  await it('journal JSON contains no prompt, data URL, reference bytes, or provider image payload', async () => {
    const p = makePaths(); const key = await getOrCreateJournalKey(p);
    await claimRequest(p, { requestId: 'req-1', fingerprint: await fingerprintRequest(key, request()), connectionId: 'conn-1', route: request().selectedRoute });
    await transitionRequest(p, 'req-1', 'dispatching');
    const largeBase64 = Buffer.alloc(2 * 1024 * 1024, 7).toString('base64');
    await assert.rejects(
      () => transitionRequest(p, 'req-1', 'result-received', { providerResult: { kind: 'base64', value: largeBase64, mimeType: 'image/png' } }),
      /provider result|payload/i,
    );
    const text = readFileSync(p.requests, 'utf8');
    assert.equal(text.includes('lighthouse'), false); assert.equal(text.includes('AAE='), false); assert.equal(text.includes('data:image'), false);
    assert.equal(text.includes(largeBase64.slice(0, 1024)), false); assert.ok(Buffer.byteLength(text) < 16 * 1024);
  });

  await it('claims same fingerprint and rejects request ID conflicts', async () => {
    const p = makePaths(); const first = { requestId: 'req-1', fingerprint: 'a'.repeat(64), connectionId: 'c', route: { id: 'r', apiFamily: 'x', modelId: 'm', source: 's' } };
    const one = await claimRequest(p, first); const two = await claimRequest(p, first);
    assert.equal(two.requestId, one.requestId);
    await assert.rejects(() => claimRequest(p, { ...first, fingerprint: 'b'.repeat(64) }), err => err.code === 'REQUEST_ID_CONFLICT');
  });

  await it('enforces transitions and requires artifact metadata for ready', async () => {
    const p = makePaths(); await claimRequest(p, { requestId: 'r', fingerprint: 'a'.repeat(64), connectionId: 'c', route: { id: 'x', apiFamily: 'a', modelId: 'm', source: 's' } });
    for (const state of ['not-dispatched', 'dispatching', 'upstream-accepted', 'result-received']) await transitionRequest(p, 'r', state);
    await assert.rejects(() => transitionRequest(p, 'r', 'ready'), /artifact/i);
    await transitionRequest(p, 'r', 'ready', { artifact: { id: 'a', mime: 'image/png', size: 3 } });
    await assert.rejects(() => transitionRequest(p, 'r', 'dispatching'), /transition/i);
  });

  await it('shares per-request single flight', async () => {
    const p = makePaths(); let calls = 0;
    const results = await Promise.all([1, 2].map(() => runSingleFlight(p, 'same', async () => { calls++; return 42; })));
    assert.equal(calls, 1); assert.deepEqual(results, [42, 42]);
  });

  await it('reconciles orphan states without dispatching and materializes only result-received durable results', async () => {
    const p = makePaths();
    await claimRequest(p, { requestId: 'claimed', fingerprint: 'a'.repeat(64), connectionId: 'c', route: {} });
    await claimRequest(p, { requestId: 'dispatching', fingerprint: 'b'.repeat(64), connectionId: 'c', route: {} });
    await transitionRequest(p, 'dispatching', 'dispatching');
    await claimRequest(p, { requestId: 'accepted', fingerprint: 'c'.repeat(64), connectionId: 'c', route: {} });
    await transitionRequest(p, 'accepted', 'dispatching');
    await transitionRequest(p, 'accepted', 'upstream-accepted');
    await reconcileJournal(p);
    assert.equal((await getRequest(p, 'claimed')).state, 'not-dispatched');
    assert.equal((await getRequest(p, 'dispatching')).state, 'failed-ambiguous');
    assert.equal((await getRequest(p, 'accepted')).state, 'failed-ambiguous');

    await claimRequest(p, { requestId: 'durable', fingerprint: 'd'.repeat(64), connectionId: 'c', route: {} });
    await transitionRequest(p, 'durable', 'dispatching');
    await transitionRequest(p, 'durable', 'result-received', { providerResult: { kind: 'url', value: 'https://cdn.example/image', mimeType: 'image/png' } });
    let materialized = 0;
    await reconcileJournal(p, async result => { materialized++; assert.equal(result.kind, 'url'); return { id: 'art', mime: 'image/png', size: 3 }; });
    assert.equal(materialized, 1);
    assert.equal((await getRequest(p, 'durable')).state, 'ready');
  });

  await it('lists persisted requests', async () => {
    const p = makePaths(); await claimRequest(p, { requestId: 'r', fingerprint: 'a'.repeat(64), connectionId: 'c', route: {} });
    assert.equal((await listRequests(p)).length, 1);
  });
});
