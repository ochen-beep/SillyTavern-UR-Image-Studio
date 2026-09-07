// @ts-check
// Unit tests for src/ui/tab-templates.js pure helpers.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = {
    createElement: () => ({
        getContext: () => ({ drawImage: () => {} }),
        toDataURL: (type, _q) => `data:${type || 'image/png'};base64,compressed`,
        set textContent(_v) { this._text = _v; },
        get innerHTML() { return String(this._text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
    }),
};
globalThis.window = { location: { origin: 'http://localhost:8000' }, dispatchEvent: () => {} };
globalThis.SillyTavern = {
    getContext: () => ({ extensionSettings: {}, saveSettingsDebounced: () => {}, getRequestHeaders: () => ({}) }),
};

const { state } = await import('../src/core.js');
const { renderTemplateCreateActions, renderTemplateCard } = await import('../src/ui/tab-templates.js');

beforeEach(() => {
    state.settings = { experimentalTemplateFromDescription: false };
    state.activeTemplateId = null;
});

test('renderTemplateCreateActions emits only an instruction button', () => {
    const html = renderTemplateCreateActions(false);
    assert.match(html, /data-create-type="instruction"/);
    assert.doesNotMatch(html, /data-create-type="fields"/);
    assert.doesNotMatch(html, /data-create-type="description"/);
});

test('renderTemplateCreateActions emits description button when experimental enabled', () => {
    const html = renderTemplateCreateActions(true);
    assert.match(html, /data-create-type="instruction"/);
    assert.match(html, /data-create-type="description"/);
    assert.doesNotMatch(html, /data-create-type="fields"/);
});

test('renderTemplateCard renders instruction editor', () => {
    const template = { id: 't1', name: 'Director', type: 'instruction', instruction: 'system prompt' };
    const html = renderTemplateCard(template);
    assert.match(html, /class="[^"]*uris-template-instruction[^"]*"/);
    assert.match(html, /class="[^"]*uris-instruction[^"]*"/);
    assert.match(html, /system prompt/);
    // type badge is gone (only one type) -> replaced by an active-marker dot
    assert.doesNotMatch(html, /uris-template-badge/);
    assert.match(html, /uris-template-status/);
    // macros hint moved under the textarea, into the card body
    assert.match(html, /Макросы ST/);
    assert.doesNotMatch(html, /Fields|Legacy v3|copy-legacy/);
});

test('active template card shows the active dot and accent class, not the legacy glow', () => {
    state.activeTemplateId = 't1';
    const html = renderTemplateCard({ id: 't1', name: 'Director', type: 'instruction', instruction: '' });
    assert.match(html, /uris-status-active/);
    assert.match(html, /class="[^"]*uris-template-active[^"]*"/);
    assert.doesNotMatch(html, /uris-card-active/);
});

test('inactive template card has a hollow dot and no active class', () => {
    state.activeTemplateId = 'other';
    const html = renderTemplateCard({ id: 't1', name: 'Director', type: 'instruction', instruction: '' });
    assert.doesNotMatch(html, /uris-status-active/);
    assert.doesNotMatch(html, /uris-template-active/);
});
