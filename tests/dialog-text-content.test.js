// @ts-check
// The dialog wrappers pass a text node, not a string: ST renders string popup
// content via innerHTML, so a stored name like '<img src=x onerror=...>' from
// an imported backup must render as text and never become live markup.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

const HOSTILE = '<img src=x onerror="window.__urisPwned=1">';

beforeEach(() => {
    const { document } = makeFakeDocument();
    globalThis.document = document;
});

test('dialog wrappers hand ST an element whose textContent is the raw text', async () => {
    const { dialogTextContent, showConfirmModal, showInputModal } = await import('../src/core.js');

    const content = dialogTextContent(`Удалить папку «${HOSTILE}»?`);
    assert.equal(typeof content, 'object', 'content is an HTMLElement, not a string');
    assert.ok(content.textContent.includes(HOSTILE), 'the hostile name survives verbatim as text');

    const seen = [];
    globalThis.SillyTavern = {
        getContext: () => ({
            POPUP_TYPE: { CONFIRM: 'confirm', INPUT: 'input' },
            callGenericPopup: async (content, type) => { seen.push({ content, type }); return type === 'confirm' ? 1 : 'Nueva'; },
        }),
    };
    await showConfirmModal(`Удалить папку «${HOSTILE}»?`);
    await showInputModal(`Имя подпапки (в «${HOSTILE}»):`, 'Новая папка');

    assert.equal(seen.length, 2, 'both dialogs went through the ST seam');
    for (const call of seen) {
        assert.equal(typeof call.content, 'object', 'every dialog body is an element');
        assert.ok(call.content.textContent.includes(HOSTILE), 'the hostile name is preserved as text');
    }
    assert.notEqual(seen[0].type, 'string-content', 'confirm did not receive a raw string');
});

test('dialogTextContent falls back to a plain string outside the browser', async () => {
    const savedDocument = globalThis.document;
    try {
        delete globalThis.document;
        const fresh = await import(`../src/core.js?nocache=${Date.now()}`);
        const out = fresh.dialogTextContent('plain');
        assert.equal(out, 'plain', 'node consumers (tests without DOM) keep receiving a string');
    } finally {
        globalThis.document = savedDocument;
    }
});
