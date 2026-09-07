// @ts-check
// Verifies escapeHtml is attribute-safe (escapes quotes) so values interpolated
// into `attr="..."` cannot break out. See core.js escapeHtml jsdoc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals } from './_helpers.js';
import { makeFakeDocument } from './fake-dom.js';
import { escapeHtml } from '../src/core.js';

installStGlobals();
globalThis.document = makeFakeDocument().document;

test('escapeHtml escapes < > & for text contexts', () => {
    assert.equal(escapeHtml('<a> & b'), '&lt;a&gt; &amp; b');
});

test('escapeHtml escapes double quotes (attribute-safe)', () => {
    // A reference name containing a quote must not break out of alt="..." / data-*="...".
    assert.equal(escapeHtml('x" onerror="alert(1)'), 'x&quot; onerror=&quot;alert(1)');
    assert.equal(escapeHtml('plain'), 'plain');
});

test('escapeHtml escapes single quotes', () => {
    assert.equal(escapeHtml("it's"), 'it&#39;s');
});

test('escapeHtml handles null/undefined/number without throwing', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(42), '42');
});

test('escapeHtml output contains no raw double or single quote', () => {
    const out = escapeHtml('a"b\'c<d>e&f');
    assert.ok(!out.includes('"'), 'no raw double quote');
    assert.ok(!out.includes("'"), 'no raw single quote');
    assert.ok(!out.includes('<'), 'no raw <');
    assert.ok(!out.includes('>'), 'no raw >');
});
