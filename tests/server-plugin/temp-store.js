import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function useTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'uris-test-'));
  return dir;
}

export function cleanupTempDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
