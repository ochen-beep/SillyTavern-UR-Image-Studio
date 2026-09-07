// @ts-check
// Tests for the expanded text editor (src/ui/text-editor.js) and the expand
// buttons wired into the Generation prompt and template instruction fields.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

// Module-scope bootstrap (imports read globals at call time, per-test mocks
// are reinstalled in beforeEach).
globalThis.document = makeFakeDocument().document;
globalThis.window = { location: { origin: 'http://localhost:8000' }, dispatchEvent: () => {} };
globalThis.toastr = { success: () => {}, error: () => {}, info: () => {}, warning: () => {} };
globalThis.SillyTavern = { getContext: () => ({}) };

const { state } = await import('../src/core.js');
const { editTextModal } = await import('../src/ui/text-editor.js');
const tabGenerate = await import('../src/ui/tab-generate.js');
const { renderTemplateCard } = await import('../src/ui/tab-templates.js');

let popupCalls;

function installCtx(popupResult) {
    popupCalls = [];
    globalThis.SillyTavern = {
        getContext: () => ({
            POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3 },
            POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
            callGenericPopup: async (content, type, inputValue, options) => {
                popupCalls.push({ content, type, inputValue, options });
                return typeof popupResult === 'function' ? popupResult(content) : popupResult;
            },
        }),
    };
}

beforeEach(() => {
    state.settings = {};
    state.activeTemplateId = null;
    installCtx(1);
});

test('editTextModal builds a maximized_textarea popup and returns the value on OK', async () => {
    const result = await editTextModal({ value: 'a cat, cinematic', title: 'Промпт картинки' });
    assert.equal(result, 'a cat, cinematic');
    assert.equal(popupCalls.length, 1);

    const { content, type, options } = popupCalls[0];
    assert.equal(type, 1); // POPUP_TYPE.TEXT
    assert.equal(options.wide, true);
    assert.equal(options.large, true);
    assert.equal(options.rows, 18);

    const ta = content.querySelector('.maximized_textarea');
    assert.ok(ta, 'editor textarea present');
    assert.match(ta.className, /text_pole/);
    assert.equal(ta.value, 'a cat, cinematic');
    assert.ok(ta.rows >= 10, 'multiline editor');
    assert.match(content.textContent, /Промпт картинки/);
});

test('editTextModal returns null on cancel and keeps callers free to ignore', async () => {
    installCtx(0); // POPUP_RESULT.NEGATIVE
    assert.equal(await editTextModal({ value: 'keep me' }), null);

    installCtx(false);
    assert.equal(await editTextModal({ value: 'keep me' }), null);

    installCtx(undefined);
    assert.equal(await editTextModal({ value: 'keep me' }), null);
});

test('editTextModal returns null without ST popup support', async () => {
    globalThis.SillyTavern = { getContext: () => ({}) };
    assert.equal(await editTextModal({ value: 'x' }), null);
    globalThis.SillyTavern = { getContext: () => ({ callGenericPopup: async () => 1 }) };
    assert.equal(await editTextModal({ value: 'x' }), null);
});

test('editTextModal omits the title element when none given', async () => {
    await editTextModal({ value: 'v' });
    const content = popupCalls[0].content;
    assert.doesNotMatch(content.innerHTML, /uris-text-editor-title/);
});

test('generate prompt markup carries the expand button next to the field', () => {
    const vm = tabGenerate.buildGenerateViewModel({
        draft: { prompt: 'a cat', aspectRatio: '1:1', imageSize: '1K', quality: 'auto', messageHash: 'h' },
        snapshot: null,
        automationMode: 'manual',
        templates: [],
        messageText: 'x',
    });
    const html = tabGenerate.renderGenerateMarkup(vm);
    assert.match(html, /id="urisPromptExpand"/);
    assert.match(html, /uris-expand-btn/);
    assert.match(html, /fa-maximize/);
});

test('template instruction card carries the expand button', () => {
    const html = renderTemplateCard({ id: 't1', name: 'Director', type: 'instruction', instruction: 'sys' });
    assert.match(html, /data-act="expand-instruction"/);
    assert.match(html, /uris-expand-btn/);
});
