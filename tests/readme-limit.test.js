// @ts-check
// The README is a product page, not dev notes: the line cap keeps it lean.
// Long-form content belongs in USER_GUIDE.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('README stays within the 80-line product cap', () => {
    const lines = readFileSync(new URL('../README.md', import.meta.url), 'utf8').split('\n');
    assert.ok(lines.length <= 80, `README is ${lines.length} lines — cap is 80`);
});
