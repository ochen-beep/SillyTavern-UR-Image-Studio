import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

// ── Environment stubs (set before importing src modules) ──

const extensionSettings = {};
const serverFiles = new Map();   // name → file text (what the server would store)
const uploads = [];              // { name, data, keepalive }
let verifyAvailable = true;      // /api/files/verify reachable?
let failUploads = false;         // every /api/files/upload fails?
let gateUploads = null;          // optional deferred gating upload responses

const originalSt = globalThis.SillyTavern;
const originalFetch = globalThis.fetch;
const originalToastr = globalThis.toastr;

let saveCalls = 0;
const toastErrors = [];

globalThis.SillyTavern = {
    getContext: () => ({
        extensionSettings,
        saveSettingsDebounced: () => { saveCalls += 1; },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
    }),
    libs: {
        localforage: {
            async getItem() { return null; },
            async setItem() {},
            async removeItem() {},
        },
    },
};
globalThis.toastr = { error: msg => toastErrors.push(msg) };

globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/files/verify') {
        if (!verifyAvailable) return { ok: false, status: 404, text: async () => '' };
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    if (url === '/api/files/upload' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        uploads.push({ ...body, keepalive: options.keepalive === true });
        if (gateUploads) await gateUploads;
        if (failUploads) return { ok: false, status: 500, text: async () => 'boom' };
        serverFiles.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    if (url.startsWith('/user/files/')) {
        const name = decodeURIComponent(url.slice('/user/files/'.length));
        if (!serverFiles.has(name)) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
        return { ok: true, status: 200, text: async () => serverFiles.get(name), json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

const store = await import('../src/template-file-store.js');
const templates = await import('../src/prompt-templates.js');

function fileTemplates() {
    const text = serverFiles.get(store.TEMPLATE_FILE_NAME);
    if (!text) return null;
    const doc = JSON.parse(text);
    return doc.templates;
}

async function seedServerFile(recordSet) {
    serverFiles.set(
        store.TEMPLATE_FILE_NAME,
        JSON.stringify({ v: store.TEMPLATE_STORE_VERSION, templates: recordSet }),
    );
}

beforeEach(async () => {
    for (const key of Object.keys(extensionSettings)) delete extensionSettings[key];
    // Flush BEFORE clearing: a fire-and-forget write loop parked mid-upload
    // from the previous test must land in the PREVIOUS map (proven flake class).
    await store.flushTemplateWrites().catch(() => {});
    serverFiles.clear();
    uploads.length = 0;
    toastErrors.length = 0;
    verifyAvailable = true;
    failUploads = false;
    gateUploads = null;
    saveCalls = 0;
    templates.resetTemplateStoreForTests();
    store.resetTemplateFileStoreForTests();
});
afterEach(() => {
    templates.resetTemplateStoreForTests();
    store.resetTemplateFileStoreForTests();
});

describe('template file store', () => {
    it('a settings blob with templates starts from the empty file value', async () => {
        extensionSettings.ur_image_studio = {
            imageConnections: {
                templates: [{ id: 'stale', name: 'Old', type: 'instruction', instruction: 'Old.' }],
            },
        };

        const listed = await templates.listTemplates();
        await store.flushTemplateWrites();

        assert.equal(store.templateStoreMode(), 'file');
        assert.deepEqual(listed, [], 'настройки больше не источник данных');
        assert.equal(fileTemplates(), null, 'пустой стор файл не создаёт');
    });

    it('keeps create, update, and delete durable in the server file', async () => {
        const created = await templates.createInstructionTemplate({ name: 'Director', instruction: 'First' });
        await store.flushTemplateWrites();
        assert.deepEqual(fileTemplates().map(t => t.id), [created.id]);

        await templates.saveTemplate({ ...created, name: 'Revised', instruction: 'Second' });
        await store.flushTemplateWrites();
        assert.equal(fileTemplates()[0].name, 'Revised');

        await templates.deleteTemplate(created.id);
        await store.flushTemplateWrites();
        assert.deepEqual(fileTemplates(), []);

        // File-mode writes never touch the settings blob.
        assert.equal(saveCalls, 0);
    });

    it('updates the right record even when unsupported legacy records shift filtered indices', async () => {
        await seedServerFile([
            { id: 'legacy-a', type: 'fields', fields: [] },
            { id: 't1', name: 'Director', type: 'instruction', instruction: 'Direct.' },
            { id: 'legacy-b', content: { schemaVersion: 3 } },
            { id: 't2', name: 'Other', type: 'instruction', instruction: 'Other.' },
        ]);

        const updated = await templates.saveTemplate({ id: 't2', type: 'instruction', name: 'Renamed', instruction: 'New.' });
        await store.flushTemplateWrites();

        assert.equal(updated.name, 'Renamed');
        const stored = fileTemplates();
        assert.equal(stored.length, 4, 'unsupported records are preserved, not dropped');
        assert.equal(stored[1].name, 'Director', 'record before the target is untouched');
        assert.equal(stored[3].name, 'Renamed');
    });

    it('reports a failed upload via toastr and heals via the pending unload payload', async () => {
        await templates.createInstructionTemplate({ name: 'First' });
        await store.flushTemplateWrites();
        assert.deepEqual(toastErrors, []);

        failUploads = true;
        await templates.createInstructionTemplate({ name: 'Lost?' });
        await store.flushTemplateWrites();
        assert.equal(toastErrors.length, 1, 'write failure surfaces to the user');
        assert.equal(fileTemplates().length, 1, 'failed write did not reach the server');

        failUploads = false;
        // The failed payload stays pending, so the unload flush retries it
        // without any new user mutation.
        store.flushTemplateWritesOnUnload();
        await store.flushTemplateWrites();
        assert.deepEqual(fileTemplates().map(t => t.name), ['First', 'Lost?'], 'unload retry heals the missed write');

        await templates.createInstructionTemplate({ name: 'Second' });
        await store.flushTemplateWrites();
        assert.deepEqual(fileTemplates().map(t => t.name), ['First', 'Lost?', 'Second']);
    });

    it('re-sends the newest pending payload with keepalive on unload flush', async () => {
        let release;
        gateUploads = new Promise(resolve => { release = resolve; });

        const createPromise = templates.createInstructionTemplate({ name: 'Pending' });
        await new Promise(resolve => setTimeout(resolve, 0)); // let the write queue up behind the gate
        store.flushTemplateWritesOnUnload();
        release();
        await createPromise;
        await store.flushTemplateWrites();

        assert.equal(uploads.length, 2, 'one chain write + one keepalive attempt');
        assert.equal(uploads[1].keepalive, true);
        assert.equal(uploads[1].data, uploads[0].data, 'keepalive payload matches the queued write');

        // Nothing pending anymore — the unload flush must be a no-op.
        store.flushTemplateWritesOnUnload();
        assert.equal(uploads.length, 2);
    });

    it('replaces the whole record set atomically on backup import', async () => {
        await templates.createInstructionTemplate({ name: 'Old' });
        await store.flushTemplateWrites();

        const replaced = await templates.replaceTemplateStoreRecords([
            { id: 'imported', name: 'Imported', type: 'instruction', instruction: 'From backup.' },
        ]);

        assert.equal(replaced, true);
        assert.deepEqual(fileTemplates(), [{ id: 'imported', name: 'Imported', type: 'instruction', instruction: 'From backup.' }]);
        const listed = await templates.listTemplates();
        assert.deepEqual(listed.map(t => t.id), ['imported']);
    });

    it('no user-files API → readonly, writes refused, nothing uploaded', async () => {
        verifyAvailable = false;

        const created = await templates.createInstructionTemplate({ name: 'Legacy' });
        await store.flushTemplateWrites();

        assert.equal(created, null, 'в readonly шаблон не создаётся (отказ показан тостом)');
        assert.equal(store.templateStoreMode(), 'readonly');
        assert.equal(uploads.length, 0, 'no user-files traffic');
    });
});
