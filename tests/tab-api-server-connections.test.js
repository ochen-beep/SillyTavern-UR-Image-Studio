// @ts-check
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

const { document, root } = makeFakeDocument();
globalThis.document = document;
globalThis.window = { location: { origin: 'http://localhost:8000' }, dispatchEvent: () => {} };
globalThis.SillyTavern = {
    getContext: () => ({ extensionSettings: {}, saveSettingsDebounced: () => {}, getRequestHeaders: () => ({}) }),
    libs: { localforage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } },
};

const {
    bindServerConnectionForm,
    collectServerConnectionForm,
    renderServerConnectionForm,
    validateServerConnectionDraft,
} = await import('../src/ui/server-connection-form.js');
const { state, defaultSettings } = await import('../src/core.js');

function mount(draft, options = {}) {
    root.innerHTML = renderServerConnectionForm(draft, options);
    return root.querySelector('.uris-server-connection');
}
function baseDraft(overrides = {}) {
    return {
        id: 'browser-1', name: 'Images', endpoint: 'https://images.test/v1', timeoutMs: 120000,
        apiKey: '',
        model: { id: 'gpt-image-1', source: 'list' },
        detected: {
            apiShape: 'openai', auth: 'bearer', delivery: 'direct',
            modelIds: ['text-model', 'gpt-image-1'], checkedAt: new Date().toISOString(),
        },
        overrides: {}, evidence: {}, extraBody: {},
        ...overrides,
    };
}
function flush(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

beforeEach(() => {
    root.innerHTML = '';
    state.settings = { ...defaultSettings, accordionState: {} };
});

// ── Rendering: visible surface is endpoint + key + probe + model ──

test('form renders the saved API key masked in the password field', () => {
    const form = mount(baseDraft({ apiKey: 'sk-secret' }));
    const keyField = form.querySelector('.uris-server-api-key');
    assert.equal(keyField.getAttribute('type'), 'password');
    assert.equal(keyField.value, 'sk-secret');
});

test('the contract dropdown is gone; advanced overrides are collapsed inside <details>', () => {
    const form = mount(baseDraft());
    assert.equal(form.querySelector('.uris-server-contract'), null);
    assert.equal(form.querySelector('.uris-server-route-filter'), null);
    assert.equal(form.querySelector('.uris-server-route'), null);
    const advanced = form.querySelector('.uris-server-advanced');
    assert.ok(advanced, 'advanced section rendered');
    assert.equal(advanced.getAttribute('open'), null);
    assert.ok(form.querySelector('.uris-server-dialect'), 'dialect override lives in advanced');
    assert.ok(form.querySelector('.uris-server-probe'));
    assert.ok(form.querySelector('.uris-server-clone'));
    assert.ok(form.querySelector('.uris-server-delete'));
});

test('facts line summarizes the last probe outcome with image-model counts', () => {
    const form = mount(baseDraft());
    const facts = form.querySelector('.uris-server-facts').innerHTML;
    assert.match(facts, /Подключено/);
    assert.match(facts, /1 image-модель из 2/);
    assert.match(facts, /Bearer/);
    assert.match(facts, /без прокси/);
});

test('unprobed connection shows a call to action instead of facts', () => {
    const form = mount(baseDraft({ detected: null }));
    assert.match(form.querySelector('.uris-server-facts').innerHTML, /Не проверено/);
});

test('model dropdown shows image models only and has no extra toggle', () => {
    const form = mount(baseDraft());
    const options = form.querySelector('.uris-server-model').querySelectorAll('option').map(o => o.attributes.value);
    assert.deepEqual(options, ['gpt-image-1', '__manual__'], 'text models are hidden by default');
    assert.equal(form.querySelector('.uris-server-model').value, 'gpt-image-1');
    assert.notEqual(form.querySelector('.uris-server-manual-row').getAttribute('hidden'), null);
    assert.equal(form.querySelector('.uris-server-model-toggle'), null);
});

test('model dropdown keeps an unclassified catalog hidden without an extra toggle', () => {
    const draft = baseDraft({ detected: { ...baseDraft().detected, modelIds: ['text-a', 'text-b'] } });
    const form = mount(draft);
    const options = form.querySelector('.uris-server-model').querySelectorAll('option').map(o => o.attributes.value);
    // Неклассифицированный каталог скрыт (text-a/text-b не показываются), но
    // текущая list-модель остаётся видимой отдельным option — выбор не «теряет
    // вид» на пустом/непонятном каталоге (фикс инцидента 2026-09-28).
    assert.deepEqual(options, ['gpt-image-1', '__manual__']);
    assert.equal(form.querySelector('.uris-server-model').value, 'gpt-image-1');
    assert.equal(form.querySelector('.uris-server-model-toggle'), null);
});

test('manual model id shows the manual row with the current id and a dynamic placeholder', () => {
    const form = mount(baseDraft({ model: { id: 'seedream-4-0', source: 'manual' } }));
    assert.equal(form.querySelector('.uris-server-model').value, '__manual__');
    assert.equal(form.querySelector('.uris-server-manual-row').getAttribute('hidden'), null);
    assert.equal(form.querySelector('.uris-server-manual-model').value, 'seedream-4-0');
    assert.equal(form.querySelector('.uris-server-manual-model').getAttribute('placeholder'), 'gpt-image-1', 'placeholder from the first image model');
});

test('dialect dropdown defaults to Auto and reflects a saved override', () => {
    assert.equal(mount(baseDraft()).querySelector('.uris-server-dialect').value, '');
    assert.equal(mount(baseDraft({ overrides: { dialect: 'gemini-native' } })).querySelector('.uris-server-dialect').value, 'gemini-native');
});

test('edit protocol defaults to Auto and reflects a saved json choice', () => {
    assert.equal(mount(baseDraft()).querySelector('.uris-server-edit-protocol').value, '');
    assert.equal(mount(baseDraft({ overrides: { editProtocol: 'json' } })).querySelector('.uris-server-edit-protocol').value, 'json');
});

// ── Collect + validate ──

test('timeout renders in seconds and collects validated milliseconds', () => {
    const form = mount(baseDraft());
    const timeout = form.querySelector('.uris-server-timeout');
    assert.equal(timeout.getAttribute('type'), 'number');
    assert.equal(timeout.value, '120');
    assert.match(form.innerHTML, /Таймаут \(сек\)/);
    timeout.value = '45';
    const collected = collectServerConnectionForm(form, baseDraft());
    assert.equal(collected.timeoutMs, 45000);
});

test('timeout validation rejects empty, fractional, and out-of-range seconds', () => {
    for (const value of ['', '15.5', '14', '601']) {
        const form = mount(baseDraft());
        form.querySelector('.uris-server-timeout').value = value;
        const draft = collectServerConnectionForm(form, baseDraft());
        assert.throws(() => validateServerConnectionDraft(draft, { purpose: 'probe' }), /timeoutMs/);
    }
});

test('collect turns override selections into a clean overrides object', () => {
    // Switching a saved override to a different value rewrites it; Auto (the
    // empty option) as the rendered default is covered by the auto-save tests.
    const form = mount(baseDraft({ overrides: { dialect: 'chat-completions', maxRefs: 3 } }));
    form.querySelector('.uris-server-dialect').value = 'gemini-native';
    form.querySelector('.uris-server-delivery').value = 'proxy';
    form.querySelector('.uris-server-refs-mode').value = 'never';
    form.querySelector('.uris-server-refs-max').value = '';
    const collected = collectServerConnectionForm(form, baseDraft({ overrides: { dialect: 'chat-completions', maxRefs: 3 } }));
    assert.deepEqual(collected.overrides, { dialect: 'gemini-native', delivery: 'proxy', refs: 'never' });
});

test('invalid extra body JSON is reported and does not crash collection', () => {
    const form = mount(baseDraft({ extraBody: { n: 1 } }));
    form.querySelector('.uris-server-extra-body').value = '{oops';
    const collected = collectServerConnectionForm(form, baseDraft({ extraBody: { n: 1 } }));
    assert.deepEqual(collected.extraBody, {});
    assert.ok(collected.overrides.__extraBodyError);
});

test('save requires a model (list or manual) — no model, no generation', () => {
    const draft = baseDraft({ model: null });
    assert.throws(() => validateServerConnectionDraft(draft), /model/i);
});

// ── Auto-save: metadata + key ──

test('typing a name auto-saves connection metadata on debounce without apiKey leak', async () => {
    const draft = baseDraft({ name: 'Old' });
    const form = mount(draft);
    const saves = [];
    bindServerConnectionForm(form, draft, {
        saveConnection: async input => { saves.push(input); return input; },
        setConnectionApiKey: async () => {},
        rerender: () => {},
        saveDebounceMs: 20,
    });
    form.querySelector('.uris-server-name').value = 'New';
    form.querySelector('.uris-server-name').dispatchEvent({ type: 'input' });
    await flush(30);
    assert.equal(saves.length, 1);
    assert.equal(saves[0].name, 'New');
    assert.equal(saves[0].id, 'browser-1');
    assert.equal('apiKey' in saves[0], false);
    assert.equal(saves[0].model.id, 'gpt-image-1');
});

test('a manual model id and the edit protocol override survive auto-save', async () => {
    const draft = baseDraft({ model: { id: 'seedream-4-0', source: 'manual' } });
    const form = mount(draft);
    const saves = [];
    bindServerConnectionForm(form, draft, {
        saveConnection: async input => { saves.push(input); return input; },
        setConnectionApiKey: async () => {},
        rerender: () => {},
        saveDebounceMs: 20,
    });
    form.querySelector('.uris-server-manual-model').value = 'seedream-4-1';
    form.querySelector('.uris-server-edit-protocol').value = 'json';
    form.querySelector('.uris-server-manual-model').dispatchEvent({ type: 'input' });
    await flush(30);
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0].model, { id: 'seedream-4-1', source: 'manual' });
    assert.equal(saves[0].overrides.editProtocol, 'json');
});

test('typing an API key auto-saves it to browser-local storage on debounce', async () => {
    const draft = baseDraft({ apiKey: '' });
    const form = mount(draft);
    const keyWrites = [];
    bindServerConnectionForm(form, draft, {
        saveConnection: async () => draft,
        setConnectionApiKey: async (id, key) => { keyWrites.push([id, key]); },
        rerender: () => {},
        saveDebounceMs: 20,
    });
    form.querySelector('.uris-server-api-key').value = 'new-secret';
    form.querySelector('.uris-server-api-key').dispatchEvent({ type: 'input' });
    await flush(30);
    assert.deepEqual(keyWrites, [['browser-1', 'new-secret']]);
});

test('clearing the API key field removes the browser-local key on debounce', async () => {
    const draft = baseDraft({ apiKey: 'old-secret' });
    const form = mount(draft);
    const keyWrites = [];
    bindServerConnectionForm(form, draft, {
        saveConnection: async () => draft,
        setConnectionApiKey: async (id, key) => { keyWrites.push([id, key]); },
        rerender: () => {},
        saveDebounceMs: 20,
    });
    form.querySelector('.uris-server-api-key').value = '';
    form.querySelector('.uris-server-api-key').dispatchEvent({ type: 'input' });
    await flush(30);
    assert.deepEqual(keyWrites, [['browser-1', '']]);
});

test('auto-save key write failure reports the error without crashing', async () => {
    const draft = baseDraft({ apiKey: '' });
    const form = mount(draft);
    const notices = [];
    bindServerConnectionForm(form, draft, {
        saveConnection: async () => draft,
        setConnectionApiKey: async () => { throw new Error('localforage full'); },
        notifyError: error => notices.push(error.message),
        rerender: () => {},
        saveDebounceMs: 20,
    });
    form.querySelector('.uris-server-api-key').value = 'x';
    form.querySelector('.uris-server-api-key').dispatchEvent({ type: 'input' });
    await flush(30);
    assert.deepEqual(notices, ['localforage full']);
});

// ── Probe («Проверить») ──

test('probe uses the draft key and timeout, saves detected facts, prefers rerenderCard', async () => {
    const draft = baseDraft({ apiKey: 'loaded-key', timeoutMs: 30000 });
    const form = mount(draft);
    const probes = [];
    const saves = [];
    let fullRerenders = 0, cardRerenders = 0;
    bindServerConnectionForm(form, draft, {
        probeConnection: async input => {
            probes.push(input);
            return {
                apiShape: 'openai', auth: 'bearer', delivery: 'direct',
                modelIds: ['gpt-image-1', 'new-image'], checkedAt: '2026-08-22T00:00:00.000Z',
            };
        },
        saveConnection: async input => { saves.push(input); return input; },
        setConnectionApiKey: async () => {},
        rerender: () => { fullRerenders++; },
        rerenderCard: () => { cardRerenders++; },
    });
    await form.querySelector('.uris-server-probe').click();
    assert.equal(probes[0].apiKey, 'loaded-key');
    assert.equal(probes[0].timeoutMs, 30000);
    assert.equal(probes[0].corsMode, 'auto');
    assert.equal(saves.length, 1);
    assert.equal(saves[0].detected.modelIds.length, 2);
    assert.deepEqual(saves[0].routes, [], 'discovered route lists are no longer persisted');
    assert.equal(cardRerenders, 1);
    assert.equal(fullRerenders, 0);
    // The previously selected model survives the probe.
    assert.equal(draft.model.id, 'gpt-image-1');
});

test('probe honors the proxy delivery override as corsMode', async () => {
    const draft = baseDraft({ apiKey: 'k', overrides: { delivery: 'proxy' } });
    const form = mount(draft);
    const probes = [];
    bindServerConnectionForm(form, draft, {
        probeConnection: async input => { probes.push(input); return { apiShape: 'openai', auth: 'bearer', delivery: 'proxy', modelIds: ['m'], checkedAt: new Date().toISOString() }; },
        saveConnection: async input => input,
        setConnectionApiKey: async () => {},
        rerender: () => {},
    });
    await form.querySelector('.uris-server-probe').click();
    assert.equal(probes[0].corsMode, 'proxy');
});

test('probe failure prefers rerenderCard over rerender and preserves errorMessage', async () => {
    const draft = baseDraft({ apiKey: 'loaded-key' });
    const form = mount(draft);
    const notices = [];
    let fullRerenders = 0, cardRerenders = 0;
    bindServerConnectionForm(form, draft, {
        probeConnection: async () => { throw new Error('Invalid token'); },
        saveConnection: async () => draft,
        setConnectionApiKey: async () => {},
        notifyError: error => notices.push(error.message),
        rerender: () => { fullRerenders++; },
        rerenderCard: () => { cardRerenders++; },
    });
    await form.querySelector('.uris-server-probe').click();
    assert.equal(draft.errorMessage, 'Invalid token');
    assert.deepEqual(notices, ['Invalid token']);
    assert.equal(cardRerenders, 1, 'probe failure should call rerenderCard');
    assert.equal(fullRerenders, 0, 'probe failure should NOT trigger the full host rerender');
});

// ── Model select ──

test('picking a list model saves it; picking manual reveals the input without saving', async () => {
    const draft = baseDraft({ model: { id: 'gpt-image-1', source: 'list' } });
    const form = mount(draft);
    const saves = [];
    bindServerConnectionForm(form, draft, {
        saveConnection: async input => { saves.push(input); return input; },
        setConnectionApiKey: async () => {},
        rerenderCard: () => {},
        rerender: () => {},
        saveDebounceMs: 20,
    });
    const select = form.querySelector('.uris-server-model');
    select.value = 'text-model';
    select.dispatchEvent({ type: 'change' });
    await flush(30);
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0].model, { id: 'text-model', source: 'list' });

    select.value = '__manual__';
    select.dispatchEvent({ type: 'change' });
    await flush(30);
    assert.equal(saves.length, 1, 'switching to manual must not save an empty model');
    assert.equal(form.querySelector('.uris-server-manual-row').getAttribute('hidden'), null);
});

// ── Forget + clone ──

test('forget clears detected facts and evidence, then saves', async () => {
    const draft = baseDraft({ evidence: { 'gpt-image-1': { dialect: 'openai-images', refs: 'confirmed', n: 2 } } });
    const form = mount(draft);
    const saves = [];
    bindServerConnectionForm(form, draft, {
        saveConnection: async input => { saves.push(input); return input; },
        setConnectionApiKey: async () => {},
        rerenderCard: () => {},
        rerender: () => {},
    });
    await form.querySelector('.uris-server-forget').click();
    assert.equal(saves.length, 1);
    assert.equal(saves[0].detected, null);
    assert.deepEqual(saves[0].evidence, {});
});

test('clone delegates to the provided cloneConnection and rerenders the host', async () => {
    const draft = baseDraft();
    const form = mount(draft);
    const clones = [];
    let fullRerenders = 0;
    bindServerConnectionForm(form, draft, {
        cloneConnection: async data => { clones.push(data); return { ...data, id: 'browser-2' }; },
        notifySuccess: () => {},
        rerender: () => { fullRerenders++; },
    });
    await form.querySelector('.uris-server-clone').click();
    assert.equal(clones.length, 1);
    assert.equal(clones[0].endpoint, 'https://images.test/v1');
    assert.equal(clones[0].model.id, 'gpt-image-1');
    assert.equal(fullRerenders, 1);
});

// ── Delete ──

test('delete removes the connection after confirmation and rerenders the host', async () => {
    const draft = baseDraft();
    const form = mount(draft);
    const deletes = [];
    let fullRerenders = 0, cardRerenders = 0;
    bindServerConnectionForm(form, draft, {
        confirmDelete: async () => true,
        deleteConnection: async id => { deletes.push(id); },
        rerender: () => { fullRerenders++; },
        rerenderCard: () => { cardRerenders++; },
    });
    await form.querySelector('.uris-server-delete').click();
    assert.deepEqual(deletes, ['browser-1']);
    assert.equal(fullRerenders, 1, 'successful delete needs the full host rebuild');
    assert.equal(cardRerenders, 0);
});

test('delete is cancelled when the user declines confirmation', async () => {
    const draft = baseDraft();
    const form = mount(draft);
    const deletes = [];
    bindServerConnectionForm(form, draft, {
        confirmDelete: async () => false,
        deleteConnection: async id => { deletes.push(id); },
        rerender: () => {},
    });
    await form.querySelector('.uris-server-delete').click();
    assert.deepEqual(deletes, []);
});

// ── Header status dot & active connection ──

test('header status dot is green when configured and probed', () => {
    const form = mount(baseDraft());
    assert.equal(form.querySelector('.uris-server-status').classList.contains('uris-status-green'), true);
});

test('header status dot is amber when configured but not yet probed', () => {
    const form = mount(baseDraft({ detected: null }));
    assert.equal(form.querySelector('.uris-server-status').classList.contains('uris-status-amber'), true);
});

test('header status dot is red when incomplete (missing endpoint or model)', () => {
    assert.equal(mount(baseDraft({ endpoint: '' })).querySelector('.uris-server-status').classList.contains('uris-status-red'), true);
    assert.equal(mount(baseDraft({ model: null })).querySelector('.uris-server-status').classList.contains('uris-status-red'), true);
});

test('header status dot is red when a transient probe error overrides an otherwise-valid config', () => {
    const form = mount(baseDraft({ errorMessage: 'probe failed' }));
    assert.equal(form.querySelector('.uris-server-status').classList.contains('uris-status-red'), true);
});

test('an existing connection with no api key in the draft is not flagged red (key lives in separate storage)', () => {
    const form = mount(baseDraft({ apiKey: '' }));
    assert.equal(form.querySelector('.uris-server-status').classList.contains('uris-status-red'), false);
});

test('clicking the status dot activates the connection without toggling collapse', async () => {
    const draft = baseDraft();
    const form = mount(draft);
    const activated = [];
    bindServerConnectionForm(form, draft, {
        rerender: () => {},
        setActive: async id => { activated.push(id); },
    });
    const dot = form.querySelector('.uris-server-status');
    const collapsedBefore = form.classList.contains('uris-collapsed');
    await dot.click();
    assert.deepEqual(activated, ['browser-1']);
    assert.equal(form.classList.contains('uris-collapsed'), collapsedBefore);
});

test('rendering with isActive adds the active class; without it the class is absent', () => {
    root.innerHTML = renderServerConnectionForm(baseDraft(), { isActive: true });
    assert.equal(root.querySelector('.uris-server-connection').classList.contains('uris-server-active'), true);
    root.innerHTML = renderServerConnectionForm(baseDraft());
    assert.equal(root.querySelector('.uris-server-connection').classList.contains('uris-server-active'), false);
});

// ── Full section integration (tab-api.js) ──

test('image connection cards remain browser CRUD controls when no server plugin is present', async () => {
    const extensionSettings = {};
    globalThis.SillyTavern.getContext = () => ({ extensionSettings, saveSettingsDebounced: () => {}, getRequestHeaders: () => ({}) });
    const host = document.createElement('div');
    const tabApi = await import(`../src/ui/tab-api.js?browser-crud=${Date.now()}`);
    await tabApi.renderImageConnSection(host);
    const add = host.querySelector('#urisAddImageConn');
    assert.ok(add);
    assert.equal(add.disabled, false);
    await add.click();
    assert.equal(host.querySelectorAll('.uris-server-connection').length, 1);
    assert.equal(host.querySelector('.uris-server-unavailable'), null);
});

test('a newly added connection starts empty with no dialect pinned', async () => {
    const extensionSettings = {};
    globalThis.SillyTavern.getContext = () => ({ extensionSettings, saveSettingsDebounced: () => {}, getRequestHeaders: () => ({}) });
    const host = document.createElement('div');
    const tabApi = await import(`../src/ui/tab-api.js?empty-create=${Date.now()}`);
    await tabApi.renderImageConnSection(host);
    await host.querySelector('#urisAddImageConn').click();
    assert.equal(host.querySelector('.uris-server-dialect').value, '');
    assert.equal(host.querySelector('.uris-server-model').value, '__manual__');
    assert.equal(host.querySelector('.uris-server-facts').innerHTML, 'Не проверено — нажмите «Проверить»');
});

test('rendered cards load the browser-local API key masked into the password field', async () => {
    const extensionSettings = {};
    globalThis.SillyTavern.getContext = () => ({ extensionSettings, saveSettingsDebounced: () => {}, getRequestHeaders: () => ({}) });
    globalThis.SillyTavern.libs = { localforage: { getItem: async () => 'stored-secret', setItem: async () => {}, removeItem: async () => {} } };
    const host = document.createElement('div');
    const tabApi = await import(`../src/ui/tab-api.js?masked-key=${Date.now()}`);
    await tabApi.renderImageConnSection(host);
    await host.querySelector('#urisAddImageConn').click();
    const keyField = host.querySelector('.uris-server-api-key');
    assert.equal(keyField.getAttribute('type'), 'password');
    assert.equal(keyField.value, 'stored-secret');
});

// ── comfy: сводка workflow + кнопки встроенных графов (У2/У4) ──

test('comfy: сводка workflow живая, кнопки вставляют встроенные графы', () => {
    const draft = baseDraft({ overrides: { dialect: 'comfyui' } });
    const form = mount(draft);
    bindServerConnectionForm(form, draft, {
        saveConnection: async input => input,
        setConnectionApiKey: async () => {},
        rerender: () => {},
        saveDebounceMs: 20,
    });
    const area = form.querySelector('.uris-server-comfy-workflow');
    const summary = form.querySelector('.uris-server-comfy-summary');
    assert.ok(area && summary, 'comfy-карточка показывает textarea и сводку');
    assert.match(summary.textContent, /Пусто/);

    area.value = '{"9":{"class_type":"SaveImage","inputs":{"images":[]}}}';
    area.dispatchEvent({ type: 'input' });
    assert.match(summary.textContent, /Промпт ✗/);
    assert.match(summary.textContent, /Выход ✓/);

    const defaultButtons = form.querySelectorAll('.uris-server-comfy-default');
    assert.equal(defaultButtons.length, 2);
    defaultButtons[0].dispatchEvent({ type: 'click' });
    assert.match(area.value, /CheckpointLoaderSimple/);
    assert.match(area.value, /%prompt%/);
    assert.match(summary.textContent, /Промпт ✓/);

    defaultButtons[1].dispatchEvent({ type: 'click' });
    assert.match(area.value, /LoadImage/);
    assert.match(summary.textContent, /LoadImage: 1/);
});

test('comfy: чекпойнт-лоадер без %model% подсвечивается в сводке', () => {
    const draft = baseDraft({ overrides: { dialect: 'comfyui' } });
    const form = mount(draft);
    bindServerConnectionForm(form, draft, {
        saveConnection: async input => input,
        setConnectionApiKey: async () => {},
        rerender: () => {},
        saveDebounceMs: 20,
    });
    const area = form.querySelector('.uris-server-comfy-workflow');
    const summary = form.querySelector('.uris-server-comfy-summary');
    area.value = '{"4":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"x.safetensors"}},"9":{"class_type":"SaveImage","inputs":{"images":[]}}}';
    area.dispatchEvent({ type: 'input' });
    assert.match(summary.textContent, /чекпойнт-лоадер без %model%/);
});

test('comfy: «Проверить» передаёт диалект подключения в пробник', async () => {
    const draft = baseDraft({ overrides: { dialect: 'comfyui' }, model: { id: 'm.safetensors', source: 'manual' } });
    const form = mount(draft);
    const probes = [];
    bindServerConnectionForm(form, draft, {
        saveConnection: async input => input,
        setConnectionApiKey: async () => {},
        rerender: () => {},
        probeConnection: async input => { probes.push(input); return { apiShape: 'comfyui', auth: 'none', delivery: 'direct', modelIds: ['m.safetensors'], modelMetadata: [] }; },
        saveDebounceMs: 20,
    });
    form.querySelector('.uris-server-probe').dispatchEvent({ type: 'click' });
    await flush(30);
    assert.equal(probes.length, 1);
    assert.equal(probes[0].dialect, 'comfyui');
});
