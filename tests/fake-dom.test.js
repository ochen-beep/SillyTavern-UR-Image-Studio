// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

test('prepend inserts nodes before existing children and maintains DOM relationships', () => {
    const { document, root } = makeFakeDocument();
    const existing = document.createElement('span');
    const first = document.createElement('strong');
    const second = document.createElement('em');
    root.appendChild(existing);

    root.prepend(first, second);

    assert.deepEqual(root.children, [first, second, existing]);
    assert.deepEqual(root.childNodes, [first, second, existing]);
    for (const node of [first, second]) {
        assert.equal(node.parentNode, root);
        assert.equal(node.ownerDocument, document);
    }
});
