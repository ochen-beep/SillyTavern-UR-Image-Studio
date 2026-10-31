// @ts-check
// A manual submit is blind to the queue but must not be blind to a
// generation already in flight outside it (auto full-pipeline, bridge):
// the per-post live registry backs the same confirmation the queue
// duplicate gets.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStGlobals } from './_helpers.js';

function makeInMemoryLFA() {
    const store = new Map();
    return {
        getItem: async (k) => (store.has(k) ? store.get(k) : null),
        setItem: async (k, v) => { store.set(k, v); },
        removeItem: async (k) => { store.delete(k); },
    };
}

let lfMock;
let coreState;
let extensionSettings;

installStGlobals();
globalThis.toastr = undefined;

const { state } = await import('../src/core.js');
const { guardDuplicateSubmission } = await import('../src/ui/submit-guard.js');
const { createQueueItem } = await import('../src/pipeline-queue.js');
const { normalizePoolReference } = await import('../src/refs-library.js');

beforeEach(async () => {
    lfMock = makeInMemoryLFA();
    globalThis.SillyTavern.libs = { localforage: lfMock };
    extensionSettings = { ur_image_studio: { imageConnections: { schemaVersion: 1, connections: [], catalogs: {}, galleryIndex: [], templates: [], presets: [], refs: [], folders: [], selectedRouteId: null } } };
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings,
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
        chatMetadata: {},
        chat: [{ mes: 'text' }],
        chatId: 'chat-1',
    });
    const core = await import('../src/core.js');
    coreState = core.state;
    core.loadSettings();
    coreState.currentChatId = 'chat-1';
    state.activeStage2ByPost.clear();
    state.queue.length = 0;
});

test('an active out-of-queue generation on the post triggers the confirmation', async () => {
    const item = await createQueueItem({
        chatId: 'chat-1', msgId: 3, messageText: 'text',
        requestedAction: 'current-prompt-stage2', templateId: null,
        submission: { prompt: 'P', aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
            references: { includedIds: [], excludedIds: [], revision: 0 } },
    });
    state.activeStage2ByPost.set('chat-1:3', 1);

    const confirms = [];
    const declined = await guardDuplicateSubmission(item, { chatId: 'chat-1', msgId: 3 }, {
        confirmActiveGeneration: async (text) => { confirms.push(text); return false; },
    });
    assert.equal(declined, false, 'declined confirm — no submit');
    assert.match(confirms[0], /генерируется/, 'the confirm names the in-flight generation');

    const accepted = await guardDuplicateSubmission(item, { chatId: 'chat-1', msgId: 3 }, {
        confirmActiveGeneration: async () => true,
    });
    assert.equal(accepted, true, 'explicit bypass stays with the user');
});

test('a quiet post submits without any confirmation', async () => {
    const item = await createQueueItem({
        chatId: 'chat-1', msgId: 4, messageText: 'text',
        requestedAction: 'current-prompt-stage2', templateId: null,
        submission: { prompt: 'P', aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
            references: { includedIds: [], excludedIds: [], revision: 0 } },
    });
    const result = await guardDuplicateSubmission(item, { chatId: 'chat-1', msgId: 4 }, {
        confirmActiveGeneration: async () => { throw new Error('must not be asked'); },
    });
    assert.equal(result, true);
});

test('imported refs never carry an external image URL', async () => {
    const kept = normalizePoolReference({ id: 'r1', name: 'A', imagePath: 'user/images/URIS_Refs/a.png' });
    assert.equal(kept.imagePath, 'user/images/URIS_Refs/a.png', 'canonical path survives');
    const relative = normalizePoolReference({ id: 'r3', name: 'C', imagePath: 'a/b/img.png' });
    assert.equal(relative.imagePath, 'a/b/img.png', 'legacy relative paths are kept (harmless 404 at worst)');
    const external = normalizePoolReference({ id: 'r2', name: 'B', imagePath: 'https://evil.example/pixel.png' });
    assert.equal(external.imagePath, '', 'an external URL never reaches tiles or fetches');
});
