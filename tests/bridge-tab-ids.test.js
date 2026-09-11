import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Static guard: every id queried in a UI module must exist in its own markup.
// Regression: the bridge lab wrote id="urisBridgeLabStatus" in markup while the
// code queried "#urisLabStatus" — the status line silently never updated.
const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'tab-bridge.js');
const source = readFileSync(FILE, 'utf8');

test('bridge tab: every queried #id exists in the rendered markup', () => {
    const markupIds = new Set([...source.matchAll(/id="([A-Za-z][\w-]*)"/g)].map(m => m[1]));
    // Collect every '#urisLab…' literal and require the exact id="…" for each.
    const queried = new Set([...source.matchAll(/'#([A-Za-z][\w-]*)'/g)].map(m => m[1]));
    const missing = [...queried].filter(id => !markupIds.has(id));
    assert.deepEqual(missing, [], `selectors point to ids absent from markup: ${missing.join(', ')}`);
    // And the known regression pair specifically:
    assert.ok(markupIds.has('urisLabStatus'), 'urisLabStatus must exist in markup');
    assert.ok(queried.has('urisLabStatus'), 'urisLabStatus must be queried by refresh code');
});
