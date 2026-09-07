// @ts-check
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

let fakeDoc;
let saves;

beforeEach(() => {
    fakeDoc = makeFakeDocument();
    globalThis.document = fakeDoc.document;
    globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
    saves = 0;
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: {},
            saveSettingsDebounced: () => { saves++; },
        }),
    };
});

test('active URIS tab defaults, restores valid IDs, and persists user selections', async () => {
    const { state, defaultSettings } = await import('../src/core.js');
    const { registerTab, resolveInitialTab, setActiveTab, getActiveTab } = await import('../src/ui/tabs.js');

    assert.equal(defaultSettings.activeTab, 'generate');
    state.settings = { ...defaultSettings, activeTab: 'gallery' };
    const tabs = fakeDoc.document.createElement('div');
    tabs.id = 'urisTabs';
    const body = fakeDoc.document.createElement('div');
    body.id = 'urisBody';
    fakeDoc.root.appendChild(tabs);
    fakeDoc.root.appendChild(body);

    registerTab({ id: 'generate', label: 'Generate', render: () => {} });
    registerTab({ id: 'gallery', label: 'Gallery', render: () => {} });

    assert.equal(resolveInitialTab('generate'), 'gallery');
    assert.equal(resolveInitialTab('generate'), 'gallery');
    state.settings.activeTab = 'unknown';
    assert.equal(resolveInitialTab('generate'), 'generate');

    state.settings.activeTab = 'gallery';
    assert.equal(setActiveTab(resolveInitialTab('generate'), { persist: false }), true);
    assert.equal(getActiveTab(), 'gallery');
    assert.equal(saves, 0);

    // Reopening prefers the live registered tab over a stale stored setting.
    state.settings.activeTab = 'generate';
    assert.equal(resolveInitialTab('generate'), 'gallery');

    state.settings.activeTab = 'gallery';
    assert.equal(setActiveTab('gallery'), true);
    assert.equal(getActiveTab(), 'gallery');
    assert.equal(state.settings.activeTab, 'gallery');
    assert.equal(saves, 0);
    assert.equal(setActiveTab('generate'), true);
    assert.equal(getActiveTab(), 'generate');
    assert.equal(state.settings.activeTab, 'generate');
    assert.equal(saves, 1);
    assert.equal(setActiveTab('missing'), false);
    assert.equal(saves, 1);
});

test('hidden startup can activate Generate without rendering a tab body', async () => {
    const { state, defaultSettings } = await import('../src/core.js');
    const { setActiveTab, getActiveTab } = await import('../src/ui/tabs.js');

    state.settings = { ...defaultSettings, collapsed: true, activeTab: 'gallery' };
    const tabs = fakeDoc.document.createElement('div');
    tabs.id = 'urisTabs';
    const body = fakeDoc.document.createElement('div');
    body.id = 'urisBody';
    fakeDoc.root.appendChild(tabs);
    fakeDoc.root.appendChild(body);

    assert.equal(setActiveTab('generate', { persist: false, render: false }), true);
    assert.equal(getActiveTab(), 'generate');
    assert.equal(body.children.length, 0);
});
