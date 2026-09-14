import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

import { scanConflictCopies } from '../server-plugin/src/storage/conflict-scan.js';
import { useTempDir, cleanupTempDir } from './server-plugin/temp-store.js';

const tempDirs = [];
function makePaths() {
  const root = useTempDir();
  tempDirs.push(root);
  // The scanner reads `paths.root` (the plugin dir).
  return { root: join(root, 'plugins', 'ur-image-studio') };
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

function touch(paths, relPath, mtime) {
  const full = join(paths.root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, 'x');
  if (mtime) {
    const t = typeof mtime === 'number' ? mtime : Date.parse(mtime);
    const d = new Date(t);
    utimesSync(full, d, d);
  }
}

describe('conflict-copy scan', () => {
  it('detects real Syncthing conflict naming (marker before final extension)', async () => {
    const paths = makePaths();
    touch(paths, 'refs.json');
    touch(paths, 'refs.sync-conflict-20260729-120000-ABCDEF.json', '2026-07-29T12:00:00Z');
    touch(paths, 'templates.sync-conflict-20260729-120000-ABCDEF.json');

    const copies = await scanConflictCopies(paths);

    assert.equal(copies.length, 2);
    assert.ok(copies.every(c => typeof c.file === 'string' && !c.file.includes(paths.root)));
    assert.ok(copies.every(c => typeof c.mtime === 'number'));
    const names = copies.map(c => c.file).sort();
    assert.deepEqual(names, [
      'refs.sync-conflict-20260729-120000-ABCDEF.json',
      'templates.sync-conflict-20260729-120000-ABCDEF.json',
    ]);
  });

  it('detects Dropbox/OneDrive "(conflicted copy)" naming', async () => {
    const paths = makePaths();
    touch(paths, 'refs.json');
    touch(paths, 'refs (conflicted copy 2026-07-29).json');
    touch(paths, 'templates (conflicted copy).json');

    const copies = await scanConflictCopies(paths);

    assert.equal(copies.length, 2);
    assert.deepEqual(copies.map(c => c.file).sort(), [
      'refs (conflicted copy 2026-07-29).json',
      'templates (conflicted copy).json',
    ]);
  });

  it('ignores temp, hidden, and non-collection files', async () => {
    const paths = makePaths();
    touch(paths, 'refs.json');
    touch(paths, 'refs.json.tmp');
    touch(paths, '.refs.json.swp');
    touch(paths, 'notes.txt');
    touch(paths, 'random.sync-conflict-20260729.json'); // not a registered collection

    const copies = await scanConflictCopies(paths);

    assert.equal(copies.length, 0, 'no registered collection matches');
  });

  it('does NOT match a file whose name merely ends with a registered collection', async () => {
    const paths = makePaths();
    // Anchoring must reject `x-templates.sync-conflict-...json` because the
    // registered collection is `templates`, not `x-templates`.
    touch(paths, 'x-templates.sync-conflict-20260729-120000-ABC.json');

    const copies = await scanConflictCopies(paths);

    assert.equal(copies.length, 0);
  });

  it('returns safe descriptors (basename + mtime only, never absolute paths)', async () => {
    const paths = makePaths();
    touch(paths, 'refs.sync-conflict-20260729-120000-ABC.json', '2026-07-29T12:00:00Z');

    const [copy] = await scanConflictCopies(paths);

    assert.equal(copy.file, 'refs.sync-conflict-20260729-120000-ABC.json');
    assert.equal(typeof copy.mtime, 'number');
    assert.ok(!JSON.stringify(copy).includes(paths.root), 'no absolute path leaks');
    assert.ok(!JSON.stringify(copy).includes(join(paths.root, '..')), 'no parent path leaks');
  });

  it('returns an empty array when the plugin directory does not exist yet', async () => {
    const paths = makePaths();
    // root was never created (no touch calls) -> ENOENT is tolerated.
    const copies = await scanConflictCopies(paths);
    assert.deepEqual(copies, []);
  });
});
