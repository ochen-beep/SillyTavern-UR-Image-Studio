import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ServerImageError } from '../server-plugin/src/errors.js';
import {
  ALLOWED_IMAGE_TYPES,
  MAX_DOWNLOAD_RETRIES,
  MAX_IMAGE_BYTES,
  artifactExists,
  deleteArtifact,
  materializeArtifact,
  readArtifact,
} from '../server-plugin/src/storage/artifact-store.js';
import { enforceRetention, MAX_JOURNAL_ROWS, TERMINAL_TTL_MS } from '../server-plugin/src/journal/retention.js';
import { claimRequest, finishDeleteByConnection, getRequest, listRequests, stageDeleteByConnection, transitionRequest } from '../server-plugin/src/journal/journal.js';
import { getUserPaths } from '../server-plugin/src/storage/paths.js';
import { writeJson } from '../server-plugin/src/storage/atomic-json.js';
import { cleanupTempDir, useTempDir } from './server-plugin/temp-store.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a4649460001ffd9', 'hex');
const WEBP = Buffer.from('52494646040000005745425056503820', 'hex');

let dirs;
beforeEach(() => { dirs = []; });
afterEach(() => { for (const dir of dirs) cleanupTempDir(dir); });
function makePaths() {
  const root = useTempDir();
  dirs.push(root);
  return getUserPaths({ user: { directories: { root } } });
}
function response(bytes, { status = 200, mimeType = 'image/png' } = {}) {
  return {
    status,
    headers: new Headers(mimeType ? { 'content-type': mimeType } : {}),
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  };
}
async function seed(paths, requestId, state, updatedAt, artifact = null) {
  const terminal = new Set(['ready', 'failed', 'failed-ambiguous']);
  return {
    requestId,
    fingerprint: requestId.padEnd(64, 'a').slice(0, 64),
    connectionId: 'connection-1',
    route: {},
    state,
    providerRequestId: null,
    providerResult: null,
    artifact,
    error: null,
    createdAt: updatedAt,
    updatedAt,
    terminal: terminal.has(state),
  };
}

await describe('connection cleanup stores', async () => {
  await it('deletes every request row and its artifacts idempotently', async () => {
    const paths = makePaths();
    const keep = await materializeArtifact({ paths, requestId: 'keep', result: { kind: 'bytes', value: PNG, mimeType: 'image/png' } });
    const remove = await materializeArtifact({ paths, requestId: 'remove', result: { kind: 'bytes', value: JPEG, mimeType: 'image/jpeg' } });
    await writeJson(paths.requests, [
      await seed(paths, 'keep', 'ready', new Date().toISOString(), keep),
      { ...(await seed(paths, 'remove', 'ready', new Date().toISOString(), remove)), connectionId: 'connection123456' },
      { ...(await seed(paths, 'active-remove', 'dispatching', new Date().toISOString())), connectionId: 'connection123456' },
    ]);
    await stageDeleteByConnection(paths, 'connection123456');
    await deleteArtifact(paths, remove);
    await finishDeleteByConnection(paths, 'connection123456');
    assert.deepEqual((await listRequests(paths)).map(row => row.requestId), ['keep']);
    assert.equal(await artifactExists(paths, remove), false);
    await stageDeleteByConnection(paths, 'connection123456');
    await finishDeleteByConnection(paths, 'connection123456');
    assert.deepEqual((await listRequests(paths)).map(row => row.requestId), ['keep']);
  });
});
await describe('artifact materialization', async () => {
  await it('exports pinned safe MVP limits and image mappings', () => {
    assert.equal(MAX_IMAGE_BYTES, 25 * 1024 * 1024);
    assert.equal(MAX_DOWNLOAD_RETRIES, 2);
    assert.equal(ALLOWED_IMAGE_TYPES['image/png'], '.png');
    assert.equal(ALLOWED_IMAGE_TYPES['image/jpeg'], '.jpg');
    assert.equal(ALLOWED_IMAGE_TYPES['image/webp'], '.webp');
    assert.equal(TERMINAL_TTL_MS, 7 * 24 * 60 * 60 * 1000);
    assert.equal(MAX_JOURNAL_ROWS, 200);
  });

  await it('materializes bytes, strict base64, and URL results with controlled extensions', async () => {
    const cases = [
      ['bytes', { kind: 'bytes', value: PNG, mimeType: 'image/png' }, '.png', PNG],
      ['base64', { kind: 'base64', value: JPEG.toString('base64'), mimeType: 'image/jpeg' }, '.jpg', JPEG],
      ['url', { kind: 'url', value: 'https://cdn.example/signed?secret=complete', mimeType: null }, '.webp', WEBP],
    ];
    for (const [requestId, result, extension, expected] of cases) {
      const paths = makePaths();
      const persisted = [];
      const safeRequest = async options => {
        assert.equal(persisted.length, 1, 'URL must be durable before the first download');
        assert.equal(options.url, result.value);
        assert.equal(options.method, 'GET');
        assert.equal(options.maxResponseBytes, MAX_IMAGE_BYTES);
        return response(WEBP, { mimeType: 'image/webp' });
      };
      const metadata = await materializeArtifact({
        paths, requestId, result, safeRequest,
        persistProviderResult: async durable => persisted.push(structuredClone(durable)),
      });
      assert.equal(metadata.relativePath, `artifacts/${requestId}${extension}`);
      assert.equal(metadata.mimeType, extension === '.jpg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : 'image/png');
      assert.equal(metadata.byteLength, expected.byteLength);
      assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
      assert.match(metadata.createdAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(await readArtifact(paths, metadata), expected);
      assert.equal(await artifactExists(paths, metadata), true);
      assert.equal(statSync(join(paths.root, metadata.relativePath)).mode & 0o777, process.platform === 'win32' ? 0o666 : 0o600);
      if (result.kind === 'url') assert.deepEqual(persisted, [result]);
      else assert.deepEqual(persisted, []);
    }
  });

  await it('resumes a persisted URL after restart without generation and safely repeats durable persistence', async () => {
    const paths = makePaths();
    const providerResult = { kind: 'url', value: 'https://cdn.example/image?signature=still-present', mimeType: null };
    await claimRequest(paths, { requestId: 'resume', fingerprint: 'a'.repeat(64), connectionId: 'c', route: {} });
    await transitionRequest(paths, 'resume', 'dispatching', { providerResult });
    let generationCalls = 0;
    let persistenceCalls = 0;
    const restartedRow = await getRequest(paths, 'resume');
    const artifact = await materializeArtifact({
      paths,
      requestId: restartedRow.requestId,
      result: restartedRow.providerResult,
      safeRequest: async ({ url }) => {
        assert.equal(url, providerResult.value);
        return response(PNG);
      },
      persistProviderResult: async durable => {
        persistenceCalls++;
        assert.deepEqual(durable, providerResult);
      },
    });
    await transitionRequest(paths, 'resume', 'result-received', { artifact });
    await transitionRequest(paths, 'resume', 'ready', { artifact });
    assert.equal(generationCalls, 0);
    assert.equal(persistenceCalls, 1);
    assert.equal((await getRequest(paths, 'resume')).state, 'ready');
  });

  await it('requires durable URL persistence and fails persistence before any fetch', async () => {
    const result = { kind: 'url', value: 'https://cdn.example/image', mimeType: null };
    let fetchCalls = 0;
    const safeRequest = async () => { fetchCalls++; return response(PNG); };

    await assert.rejects(() => materializeArtifact({
      paths: makePaths(), requestId: 'missing-persist', result, safeRequest,
    }), error => error.code === 'ARTIFACT_PERSISTENCE_REQUIRED');
    assert.equal(fetchCalls, 0);

    await assert.rejects(() => materializeArtifact({
      paths: makePaths(), requestId: 'failed-persist', result, safeRequest,
      persistProviderResult: async () => { throw new Error('journal write failed'); },
    }), /journal write failed/);
    assert.equal(fetchCalls, 0);
  });

  await it('disposes non-successful URL responses before failing the download', async () => {
    let disposeCalls = 0;
    const failedResponse = {
      status: 400,
      dispose() { disposeCalls++; },
    };

    await assert.rejects(() => materializeArtifact({
      paths: makePaths(),
      requestId: 'failed-response-dispose',
      result: { kind: 'url', value: 'https://cdn.example/image', mimeType: null },
      safeRequest: async () => failedResponse,
      persistProviderResult: async () => {},
    }), error => error.code === 'ARTIFACT_DOWNLOAD_FAILED');
    assert.equal(disposeCalls, 1);
  });

  await it('retries only retryable URL downloads with deterministic exponential backoff', async () => {
    const paths = makePaths();
    const signal = new AbortController().signal;
    const delays = [];
    let attempts = 0;
    const safeRequest = async options => {
      attempts++;
      assert.equal(options.timeoutMs, 12_345);
      assert.equal(options.maxRedirects, 2);
      assert.equal(options.signal, signal);
      if (attempts < 3) throw new ServerImageError({ code: 'OUTBOUND_REQUEST_FAILED', message: 'retry', retryable: true });
      return response(PNG);
    };
    await materializeArtifact({
      paths, requestId: 'retry', result: { kind: 'url', value: 'https://cdn.example/image', mimeType: null },
      safeRequest, persistProviderResult: async () => {}, timeoutMs: 12_345, maxRedirects: 2, signal,
      sleep: async (delay, receivedSignal) => { delays.push(delay); assert.equal(receivedSignal, signal); },
    });
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [100, 200]);

    attempts = 0;
    await assert.rejects(() => materializeArtifact({
      paths: makePaths(), requestId: 'no-retry', result: { kind: 'url', value: 'https://cdn.example/image', mimeType: null },
      safeRequest: async () => { attempts++; throw new ServerImageError({ code: 'DESTINATION_BLOCKED', message: 'blocked', retryable: false }); },
      persistProviderResult: async () => {},
      sleep: async () => { throw new Error('must not sleep'); },
    }), error => error.code === 'DESTINATION_BLOCKED');
    assert.equal(attempts, 1);
  });

  await it('stops retry backoff when the caller aborts', async () => {
    const controller = new AbortController();
    let attempts = 0;
    let sleepCalls = 0;
    await assert.rejects(() => materializeArtifact({
      paths: makePaths(), requestId: 'abort-retry', result: { kind: 'url', value: 'https://cdn.example/image', mimeType: null },
      persistProviderResult: async () => {},
      signal: controller.signal,
      safeRequest: async () => {
        attempts++;
        controller.abort(new Error('caller aborted'));
        throw new ServerImageError({ code: 'OUTBOUND_REQUEST_FAILED', message: 'retry', retryable: true });
      },
      sleep: async () => { sleepCalls++; },
    }), /caller aborted/);
    assert.equal(attempts, 1);
    assert.equal(sleepCalls, 0);
  });

  await it('rejects oversized, spoofed, unsupported, malformed base64, empty, and traversal inputs', async () => {
    const paths = makePaths();
    const invalid = [
      ['oversize', { kind: 'bytes', value: Buffer.alloc(MAX_IMAGE_BYTES + 1), mimeType: 'image/png' }, 'ARTIFACT_TOO_LARGE'],
      ['spoof', { kind: 'bytes', value: PNG, mimeType: 'image/jpeg' }, 'ARTIFACT_MIME_MISMATCH'],
      ['unsupported', { kind: 'bytes', value: Buffer.from('GIF89a'), mimeType: 'image/gif' }, 'ARTIFACT_TYPE_UNSUPPORTED'],
      ['truncated-jpeg', { kind: 'bytes', value: Buffer.from('ffd8ff00', 'hex'), mimeType: 'image/jpeg' }, 'ARTIFACT_TYPE_UNSUPPORTED'],
      ['invalid-webp-chunk', { kind: 'bytes', value: Buffer.from('52494646040000005745425042414421', 'hex'), mimeType: 'image/webp' }, 'ARTIFACT_TYPE_UNSUPPORTED'],
      ['base64', { kind: 'base64', value: `${PNG.toString('base64')}!`, mimeType: 'image/png' }, 'ARTIFACT_RESULT_INVALID'],
      ['empty', { kind: 'bytes', value: Buffer.alloc(0), mimeType: 'image/png' }, 'ARTIFACT_RESULT_INVALID'],
      ['../escape', { kind: 'bytes', value: PNG, mimeType: 'image/png' }, 'INVALID_REQUEST_ID'],
    ];
    for (const [requestId, result, code] of invalid) {
      await assert.rejects(
        () => materializeArtifact({ paths, requestId, result }),
        error => error instanceof ServerImageError && error.code === code,
        `${requestId} should fail as ${code}`,
      );
    }
  });

  await it('uses detected MIME only when declaration is absent and deletes safely and idempotently', async () => {
    const paths = makePaths();
    const metadata = await materializeArtifact({ paths, requestId: 'detected', result: { kind: 'bytes', value: WEBP, mimeType: null } });
    assert.equal(metadata.mimeType, 'image/webp');
    assert.equal(metadata.relativePath, 'artifacts/detected.webp');
    await deleteArtifact(paths, metadata);
    await deleteArtifact(paths, metadata);
    assert.equal(await artifactExists(paths, metadata), false);
    await assert.rejects(() => readArtifact(paths, metadata), error => error.code === 'ENOENT');
    await assert.rejects(() => readArtifact(paths, { relativePath: '../other-user.png' }), error => error.code === 'INVALID_ARTIFACT_PATH');
  });

  await it('does not run ready integration callback when the atomic artifact write fails', async () => {
    const paths = makePaths();
    let readyCalls = 0;
    await assert.rejects(() => materializeArtifact({
      paths, requestId: 'write-fail', result: { kind: 'bytes', value: PNG, mimeType: 'image/png' },
      atomicWrite: async () => { throw new Error('disk full'); },
      onArtifactReady: async () => { readyCalls++; },
    }), /disk full/);
    assert.equal(readyCalls, 0);
    assert.equal(existsSync(join(paths.artifacts, 'write-fail.png')), false);
  });
});

await describe('journal retention', async () => {
  await it('expires only terminal rows older than seven days and deletes matching artifacts', async () => {
    const paths = makePaths();
    const now = new Date('2026-07-27T12:00:00.000Z');
    const old = new Date(now.getTime() - TERMINAL_TTL_MS - 1).toISOString();
    const recent = new Date(now.getTime() - TERMINAL_TTL_MS + 1).toISOString();
    const oldArtifact = await materializeArtifact({ paths, requestId: 'old-ready', result: { kind: 'bytes', value: PNG, mimeType: 'image/png' } });
    const rows = [
      await seed(paths, 'old-ready', 'ready', old, oldArtifact),
      await seed(paths, 'old-failed', 'failed', old),
      await seed(paths, 'old-ambiguous', 'failed-ambiguous', old),
      await seed(paths, 'old-active', 'dispatching', old),
      await seed(paths, 'recent-ready', 'ready', recent),
    ];
    await writeJson(paths.requests, rows);
    const result = await enforceRetention(paths, { now });
    assert.deepEqual(result.deletedRequestIds.sort(), ['old-ambiguous', 'old-failed', 'old-ready']);
    assert.deepEqual((await listRequests(paths)).map(row => row.requestId).sort(), ['old-active', 'recent-ready']);
    assert.equal(await artifactExists(paths, oldArtifact), false);
  });

  await it('caps total rows at 200 by oldest terminal updatedAt while retaining every nonterminal row', async () => {
    const paths = makePaths();
    const now = new Date('2026-07-27T12:00:00.000Z');
    const rows = [];
    for (let index = 0; index < 205; index++) {
      rows.push(await seed(paths, `terminal-${String(index).padStart(3, '0')}`, 'failed', new Date(now.getTime() - (205 - index) * 1000).toISOString()));
    }
    for (let index = 0; index < 10; index++) {
      rows.push(await seed(paths, `active-${String(index).padStart(3, '0')}`, 'dispatching', new Date(now.getTime() - index * 1000).toISOString()));
    }
    await writeJson(paths.requests, rows);
    await enforceRetention(paths, { now });
    const retained = await listRequests(paths);
    assert.equal(retained.length, 200);
    assert.equal(retained.filter(row => row.state === 'failed').length, 190);
    assert.equal(retained.filter(row => row.state === 'dispatching').length, 10);
    assert.equal(retained.some(row => row.requestId === 'terminal-014'), false);
    assert.equal(retained.some(row => row.requestId === 'terminal-015'), true);

    const overflow = makePaths();
    const activeRows = [];
    for (let index = 0; index < 210; index++) activeRows.push(await seed(overflow, `active-${index}`, 'dispatching', now.toISOString()));
    activeRows.push(await seed(overflow, 'terminal', 'failed', now.toISOString()));
    await writeJson(overflow.requests, activeRows);
    await enforceRetention(overflow, { now });
    const overflowRetained = await listRequests(overflow);
    assert.equal(overflowRetained.length, 210);
    assert.equal(overflowRetained.every(row => row.state === 'dispatching'), true);
  });

  await it('marks deletion durably before artifact removal and resumes after a crash', async () => {
    const paths = makePaths();
    const now = new Date('2026-07-27T12:00:00.000Z');
    const old = new Date(now.getTime() - TERMINAL_TTL_MS - 1).toISOString();
    const artifact = await materializeArtifact({ paths, requestId: 'crash-delete', result: { kind: 'bytes', value: PNG, mimeType: 'image/png' } });
    await writeJson(paths.requests, [await seed(paths, 'crash-delete', 'ready', old, artifact)]);

    let deleteCalls = 0;
    await assert.rejects(() => enforceRetention(paths, {
      now,
      deleteArtifact: async () => { deleteCalls++; throw new Error('crash during delete'); },
    }), /crash during delete/);
    assert.equal(deleteCalls, 1);
    const staged = await getRequest(paths, 'crash-delete');
    assert.equal(staged.state, 'deleting');
    assert.deepEqual(staged.artifact, artifact);
    assert.equal(await artifactExists(paths, artifact), true);

    const resumed = await enforceRetention(paths, { now });
    assert.deepEqual(resumed.deletedRequestIds, ['crash-delete']);
    assert.equal(await getRequest(paths, 'crash-delete'), null);
    assert.equal(await artifactExists(paths, artifact), false);
  });

  await it('keeps a safe staged row when final journal removal fails after artifact deletion', async () => {
    const paths = makePaths();
    const now = new Date('2026-07-27T12:00:00.000Z');
    const old = new Date(now.getTime() - TERMINAL_TTL_MS - 1).toISOString();
    const artifact = await materializeArtifact({ paths, requestId: 'remove-write-fail', result: { kind: 'bytes', value: PNG, mimeType: 'image/png' } });
    await writeJson(paths.requests, [await seed(paths, 'remove-write-fail', 'ready', old, artifact)]);
    let writes = 0;

    await assert.rejects(() => enforceRetention(paths, {
      now,
      writeJson: async (file, rows) => {
        writes++;
        if (writes === 2) throw new Error('final journal write failed');
        await writeJson(file, rows);
      },
    }), /final journal write failed/);
    assert.equal(await artifactExists(paths, artifact), false);
    const staged = await getRequest(paths, 'remove-write-fail');
    assert.equal(staged.state, 'deleting');
    assert.notEqual(staged.state, 'ready');

    const resumed = await enforceRetention(paths, { now });
    assert.deepEqual(resumed.deletedRequestIds, ['remove-write-fail']);
    assert.equal(await getRequest(paths, 'remove-write-fail'), null);
  });

  await it('does not delete an artifact if the pending-deletion journal write fails', async () => {
    const paths = makePaths();
    const now = new Date('2026-07-27T12:00:00.000Z');
    const old = new Date(now.getTime() - TERMINAL_TTL_MS - 1).toISOString();
    const artifact = await materializeArtifact({ paths, requestId: 'stage-write-fail', result: { kind: 'bytes', value: JPEG, mimeType: 'image/jpeg' } });
    await writeJson(paths.requests, [await seed(paths, 'stage-write-fail', 'ready', old, artifact)]);
    let deleteCalls = 0;

    await assert.rejects(() => enforceRetention(paths, {
      now,
      writeJson: async () => { throw new Error('pending journal write failed'); },
      deleteArtifact: async () => { deleteCalls++; },
    }), /pending journal write failed/);
    assert.equal(deleteCalls, 0);
    assert.equal((await getRequest(paths, 'stage-write-fail')).state, 'ready');
    assert.equal(await artifactExists(paths, artifact), true);
  });

  await it('is user-isolated and idempotent when artifacts or rows are already absent', async () => {
    const first = makePaths();
    const second = makePaths();
    const now = new Date('2026-07-27T12:00:00.000Z');
    const old = new Date(now.getTime() - TERMINAL_TTL_MS - 1).toISOString();
    const artifact = await materializeArtifact({ paths: second, requestId: 'same-id', result: { kind: 'bytes', value: JPEG, mimeType: 'image/jpeg' } });
    await writeJson(first.requests, [await seed(first, 'same-id', 'failed', old, { ...artifact, relativePath: 'artifacts/missing.jpg' })]);
    await writeJson(second.requests, [await seed(second, 'same-id', 'ready', now.toISOString(), artifact)]);
    const once = await enforceRetention(first, { now });
    const twice = await enforceRetention(first, { now });
    assert.deepEqual(once.deletedRequestIds, ['same-id']);
    assert.deepEqual(twice.deletedRequestIds, []);
    assert.equal(await artifactExists(second, artifact), true);
    assert.equal((await listRequests(second)).length, 1);
    assert.deepEqual(readFileSync(join(second.root, artifact.relativePath)), JPEG);
  });
});
