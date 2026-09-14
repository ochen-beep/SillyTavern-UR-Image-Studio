import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { getUserPaths } from '../server-plugin/src/storage/paths.js';
import { readJson, writeJson, updateJson, setAtomicWriterForTests, setRetryConfigForTests, setIsWindowsForTests } from '../server-plugin/src/storage/atomic-json.js';
import { ServerImageError } from '../server-plugin/src/errors.js';
import { useTempDir, cleanupTempDir } from './server-plugin/temp-store.js';
import { makeFakeUser } from './server-plugin/fake-user.js';

describe('getUserPaths', () => {
  it('returns correct paths for a given root', () => {
    const root = '/some/user/root';
    const req = makeFakeUser(root);
    const paths = getUserPaths(req);

    assert.equal(paths.root, join(root, 'plugins', 'ur-image-studio'));
    assert.equal(paths.connections, join(paths.root, 'connections.json'));
    assert.equal(paths.requests, join(paths.root, 'requests.json'));
    assert.equal(paths.operations, join(paths.root, 'operations.json'));
    assert.equal(paths.artifacts, join(paths.root, 'artifacts'));
    assert.equal(paths.journalKey, root);
  });

  it('throws ServerImageError with code SERVER_USER_CONTEXT_MISSING when root is missing', () => {
    assert.throws(
      () => getUserPaths({}),
      (err) => {
        assert.ok(err instanceof ServerImageError, 'should be a ServerImageError');
        assert.equal(err.code, 'SERVER_USER_CONTEXT_MISSING');
        return true;
      },
    );
  });
});

describe('atomic JSON storage', () => {
  let dir;
  let file;

  before(() => {
    dir = useTempDir();
    file = join(dir, 'plugins', 'ur-image-studio', 'connections.json');
  });

  after(() => {
    cleanupTempDir(dir);
  });

  it('readJson returns fallback when the file does not exist', async () => {
    const fallback = { connections: [] };
    const result = await readJson(file, fallback);
    assert.deepEqual(result, fallback);
  });

  it('writeJson then readJson round-trips data', async () => {
    const data = { connections: [{ id: 'a', name: 'first' }] };
    await writeJson(file, data);
    const result = await readJson(file, null);
    assert.deepEqual(result, data);
  });

  it('20 concurrent updateJson calls incrementing counter result in final value 20', async () => {
    const counterFile = join(dir, 'counter.json');
    await writeJson(counterFile, { value: 0 });

    const updates = [];
    for (let i = 0; i < 20; i++) {
      updates.push(updateJson(counterFile, null, (current) => ({ value: current.value + 1 })));
    }
    await Promise.all(updates);

    const final = await readJson(counterFile, null);
    assert.equal(final.value, 20);
  });

  it('updateJson uses fallback when file does not exist', async () => {
    const newFile = join(dir, 'nonexistent.json');
    const fallback = { items: [] };
    const result = await updateJson(newFile, fallback, (current) => {
      assert.deepEqual(current, fallback);
      return { items: ['added'] };
    });
    assert.deepEqual(result, { items: ['added'] });
    const onDisk = await readJson(newFile, null);
    assert.deepEqual(onDisk, { items: ['added'] });
  });

  it('if write throws, old JSON remains readable (atomicity)', async () => {
    const original = { version: 1, label: 'original' };
    const targetFile = join(dir, 'guarded.json');
    await writeJson(targetFile, original);

    // Force the write step to fail: place a regular file where the target's
    // parent directory would need to be created, so mkdir throws EEXIST before
    // any bytes are written to the real file.
    const blocker = join(dir, 'blocked');
    writeFileSync(blocker, 'x');
    const doomedFile = join(blocker, 'child.json');

    await assert.rejects(writeJson(doomedFile, { replaced: true }));

    // The original file is untouched by the failed write.
    const remaining = await readJson(targetFile, null);
    assert.deepEqual(remaining, original);
  });
});

describe('atomic JSON storage — Windows rename retry', () => {
  let dir;

  before(() => {
    dir = useTempDir();
    setIsWindowsForTests(true);
    setRetryConfigForTests({ attempts: 4, delayMs: 0 });
  });

  after(() => {
    setIsWindowsForTests(false);
    setRetryConfigForTests(null);
    setAtomicWriterForTests(null);
    cleanupTempDir(dir);
  });

  // The flaky writers are stateful; reset the seam between tests so a leftover
  // writer from one test cannot leak into the next.
  afterEach(() => {
    setAtomicWriterForTests(null);
  });

  /**
   * Build a fake writer that fails with the given error codes N-1 times and
   * then succeeds on the Nth attempt. Records every call.
   */
  function flakyWriter(codes, onSuccess) {
    const calls = [];
    return {
      calls,
      writer: (file, data, options, cb) => {
        calls.push({ file, data, options });
        if (codes.length > 0) {
          const code = codes.shift();
          process.nextTick(() => cb(Object.assign(new Error(`mock ${code}`), { code })));
        } else {
          process.nextTick(() => { onSuccess(file, data, options); cb(null); });
        }
      },
    };
  }

  it('retries EPERM then succeeds and writes the file', async () => {
    const file = join(dir, 'retry-eperm.json');
    const fx = flakyWriter(['EPERM', 'EBUSY'], (f, d) => writeFileSync(f, d));
    setAtomicWriterForTests(fx.writer);
    await writeJson(file, { ok: true });
    assert.equal(fx.calls.length, 3, 'two retries then success => 3 attempts');
    const onDisk = await readJson(file, null);
    assert.deepEqual(onDisk, { ok: true });
  });

  it('retries EBUSY along the way and still commits', async () => {
    const file = join(dir, 'retry-ebusy.json');
    const fx = flakyWriter(['EBUSY', 'EBUSY', 'EBUSY'], (f, d) => writeFileSync(f, d));
    setAtomicWriterForTests(fx.writer);
    await writeJson(file, { n: 1 });
    assert.equal(fx.calls.length, 4, 'three retries then success => 4 attempts');
  });

  it('does NOT retry a non-retryable error (EACCES) and rejects immediately', async () => {
    const file = join(dir, 'no-retry-eacces.json');
    const fx = flakyWriter(['EACCES'], () => {});
    setAtomicWriterForTests(fx.writer);
    await assert.rejects(writeJson(file, { x: 1 }), /mock EACCES/);
    assert.equal(fx.calls.length, 1, 'non-retryable => single attempt');
  });

  it('gives up after the configured attempt count and surfaces the last error', async () => {
    const file = join(dir, 'exhausted.json');
    const fx = flakyWriter(['EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM'], () => {});
    setAtomicWriterForTests(fx.writer);
    await assert.rejects(writeJson(file, { x: 1 }), /mock EPERM/);
    assert.equal(fx.calls.length, 4, 'attempts cap (4) enforced');
  });

  it('does not retry when isWindows is false, even for EPERM', async () => {
    const file = join(dir, 'non-windows.json');
    setIsWindowsForTests(false);
    const fx = flakyWriter(['EPERM'], () => {});
    setAtomicWriterForTests(fx.writer);
    await assert.rejects(writeJson(file, { x: 1 }), /mock EPERM/);
    assert.equal(fx.calls.length, 1, 'non-Windows => no retry');
    setIsWindowsForTests(true);
  });

  it('updateJson commits through retry and returns the new value', async () => {
    const file = join(dir, 'upd-retry.json');
    await writeJson(file, { counter: 0 });
    const fx = flakyWriter(['EPERM'], (f, d) => writeFileSync(f, d));
    setAtomicWriterForTests(fx.writer);
    const result = await updateJson(file, { counter: -1 }, (c) => ({ counter: c.counter + 1 }));
    assert.equal(result.counter, 1);
    const onDisk = await readJson(file, null);
    assert.equal(onDisk.counter, 1);
  });
});
