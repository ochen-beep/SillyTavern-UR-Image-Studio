// @ts-check
// Unit tests for src/ui/tab-generate.js pure helpers.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeUserFileServer } from './_helpers.js';

// Файловая дверь: сторы данных должны резолвиться мгновенно и без сети.
// Без неё ready() ходит в реальный сервер (если запущен) или ждёт вечно.
const fileServer = makeUserFileServer({
    fallback(url, options) {
        return globalThis.__realFetch ? globalThis.__realFetch(url, options) : { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    },
});
globalThis.fetch = fileServer.fetch;


// DOM stubs required before importing modules that use document at runtime.
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
    libs: { localforage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } },
};

const { state } = await import('../src/core.js');
const { listUrisErrors, clearUrisErrors } = await import('../src/error-pool.js');
const { POST_FILTER } = await import('../src/post-navigator.js');
const { hashMessage } = await import('../src/generation-drafts.js');
const { MAX_REFS } = await import('../src/refs-library.js');
const tabGenerate = await import('../src/ui/tab-generate.js');
const { decidePromptActions, buildGenerateViewModel, renderGenerateMarkup, readGenerationParams, submitCurrentGeneration, composeInsertedPrompt, updateReferenceCorrections, refreshReferencePanel, buildReferencePanelState, resolveConnectionReferencePolicy, getSnapshotReferencePolicy, composeEffectiveParams } = tabGenerate;

beforeEach(() => {
    state.settings = {
        generationFlow: POST_FILTER.AI_ONLY,
        advancedMode: false,
    };
});

function baseVm(overrides = {}) {
    const { draft, snapshot, messageText, automationMode = 'manual', templates = [], activeTemplateId = null } = overrides;
    return buildGenerateViewModel({ draft, snapshot, automationMode, templates, messageText, activeTemplateId });
}

test('decidePromptActions builds prompt and disables Stage 2 when prompt is empty', () => {
    assert.deepEqual(decidePromptActions({ prompt: '   ', promptOrigin: 'stage1' }), {
        stage1Action: 'build-prompt', canGenerateImage: false,
    });
});

test('decidePromptActions rebuilds prompt and enables Stage 2 for generated prompt', () => {
    assert.deepEqual(decidePromptActions({ prompt: 'a cat', promptOrigin: 'stage1' }), {
        stage1Action: 'rebuild-prompt', canGenerateImage: true,
    });
});

test('decidePromptActions rebuilds prompt and enables Stage 2 for manual prompt', () => {
    assert.deepEqual(decidePromptActions({ prompt: 'a cat', promptOrigin: 'manual' }), {
        stage1Action: 'rebuild-prompt', canGenerateImage: true,
    });
});

test('buildGenerateViewModel detects stale draft when message hash changed', () => {
    const draft = { chatId: 'c', msgId: 1, messageHash: 'old-hash', prompt: 'a cat', promptOrigin: 'stage1' };
    const vm = buildGenerateViewModel({
        draft,
        snapshot: null,
        automationMode: 'manual',
        templates: [],
        messageText: 'new message text',
    });
    assert.equal(vm.isStale, true);
    assert.equal(vm.stage1Action, 'rebuild-prompt');
    assert.equal(vm.canGenerateImage, true);
});

test('buildGenerateViewModel keeps generate-image when draft matches message hash', () => {
    const messageText = 'same message';
    const draft = { chatId: 'c', msgId: 1, messageHash: hashMessage(messageText), prompt: 'a cat', promptOrigin: 'stage1' };
    const vm = buildGenerateViewModel({
        draft,
        snapshot: null,
        automationMode: 'manual',
        templates: [],
        messageText,
    });
    assert.equal(vm.isStale, false);
    assert.equal(vm.stage1Action, 'rebuild-prompt');
    assert.equal(vm.canGenerateImage, true);
});

test('buildGenerateViewModel surfaces stage1 and stage2 errors', () => {
    const draft = {
        prompt: 'x',
        messageHash: 'h',
        stage1: { status: 'error', error: 'stage1 failed' },
        stage2: { status: 'error', error: 'stage2 failed' },
    };
    const vm1 = buildGenerateViewModel({ draft, snapshot: null, automationMode: 'manual', templates: [], messageText: 'x' });
    assert.equal(vm1.stage1Error, 'stage1 failed');
    const vm2 = buildGenerateViewModel({
        draft: { ...draft, stage1: { status: 'ok' } },
        snapshot: null,
        automationMode: 'manual',
        templates: [],
        messageText: 'x',
    });
    assert.equal(vm2.stage2Error, 'stage2 failed');
});

test('buildGenerateViewModel passes snapshot ambiguities and refs', () => {
    const snapshot = {
        chatId: 'c', msgId: 1, messageHash: 'h', contextRevision: 1, entities: [],
        stage1Descriptions: [{ id: 'aria', name: 'Aria', description: 'desc' }],
        stage2Refs: [{ id: 'aria', name: 'Aria', imagePath: '' }],
        ambiguities: [{ mention: 'she', candidateIds: ['aria', 'luna'] }],
    };
    const vm = buildGenerateViewModel({
        draft: { prompt: 'x', messageHash: 'h' },
        snapshot,
        automationMode: 'manual',
        templates: [],
        messageText: 'x',
    });
    assert.deepEqual(vm.ambiguities, snapshot.ambiguities);
    assert.deepEqual(vm.refs, snapshot.stage2Refs);
    assert.deepEqual(vm.descriptions, snapshot.stage1Descriptions);
});

test('Generate markup no longer renders browser pending recovery rows', () => {
    const html = renderGenerateMarkup(buildGenerateViewModel({
        draft: { prompt: 'x', aspectRatio: '1:1', imageSize: '1K', quality: 'auto', messageHash: 'h' },
        snapshot: null,
        automationMode: 'manual',
        templates: [],
        messageText: 'x',
    }));
    assert.doesNotMatch(html, /uris-browser-pending/);
});

test('renderGenerateMarkup renders rebuild and enabled Stage 2 for nonempty prompt', () => {
    const messageText = 'message text';
    const draft = { prompt: 'a cat', aspectRatio: '9:16', imageSize: '2K', quality: 'high', templateId: null, messageHash: hashMessage(messageText) };
    const markup = renderGenerateMarkup(buildGenerateViewModel({
        draft,
        snapshot: null,
        automationMode: 'manual',
        templates: [],
        messageText,
    }));
    assert.match(markup, /id="urisPrompt"/);
    assert.match(markup, /id="urisBuildPrompt"[^>]*>\s*<i[^>]*><\/i> Перестроить промпт/);
    assert.match(markup, /id="urisGenerateImage"(?![^>]*disabled)[^>]*>\s*<i[^>]*><\/i> Сгенерировать/);
    assert.doesNotMatch(markup, /id="urisPrimaryGenerate"/);
    assert.match(markup, /a cat/);
});

test('Generate rows per UI revision #14: Стороны+Модель, Шаблон, «Дополнительно» аккордеон с остальными', () => {
    const messageText = 'm';
    const draft = { prompt: 'a cat', aspectRatio: '1:1', imageSize: '1K', quality: 'auto', templateId: null, messageHash: hashMessage(messageText) };
    const markup = renderGenerateMarkup(buildGenerateViewModel({
        draft,
        snapshot: null,
        automationMode: 'manual',
        templates: [],
        messageText,
    }));
    // Строка 1: Стороны + Модель в одном uris-gen-params
    const row1 = markup.match(/<div class="uris-gen-params">[\s\S]*?<\/div>/)?.[0] || '';
    assert.match(row1, /id="urisAspect"/);
    assert.match(row1, /id="urisModel"/);
    assert.doesNotMatch(row1, /id="urisImgSize"/);
    // Строка 2: только Шаблон
    const rows = markup.match(/<div class="uris-gen-params">[\s\S]*?<\/div>/g) || [];
    assert.ok(rows[1], 'вторая строка есть');
    assert.match(rows[1], /id="urisTemplate"/);
    assert.doesNotMatch(rows[1], /id="urisAspect"|id="urisImgSize"|id="urisAutomationMode"/);
    // Остальное — под details «Дополнительно» (аккордеон с персистентным id)
    assert.match(markup, /<details[^>]*id="urisGenParamsAcc"[^>]*>/);
    assert.match(markup, /<summary>Дополнительно<\/summary>/);
    const acc = markup.match(/<details[^>]*id="urisGenParamsAcc"[\s\S]*<\/details>/)?.[0] || '';
    assert.match(acc, /id="urisImgSize"/);
    assert.match(acc, /id="urisQuality"/);
    assert.match(acc, /id="urisGenerationFlow"/, 'Флоу внутри аккордеона');
    assert.match(acc, /id="urisAutomationMode"/, 'Автоматизация внутри аккордеона');
    // «Флоу генерации» переименован в «Флоу»
    assert.match(markup, /Флоу</);
    assert.doesNotMatch(markup, /Флоу генерации/);
});

test('renderGenerateMarkup renders the insert-template action inside the prompt card', () => {
    const messageText = 'message text';
    const draft = { prompt: 'a cat', aspectRatio: '9:16', imageSize: '2K', quality: 'high', templateId: null, messageHash: hashMessage(messageText) };
    const markup = renderGenerateMarkup(baseVm({ draft, messageText }));
    const card = markup.match(/<div class="uris-prompt-card">[\s\S]*?<\/div>\s*<div class="uris-gen-params"/)?.[0];
    assert.ok(card, 'prompt card block found');
    assert.match(card, /id="urisInsertTemplate"/);
    assert.match(card, /Вставить шаблон/);
    // The insert action opens the actions row: build → insert → generate.
    assert.ok(card.indexOf('id="urisBuildPrompt"') < card.indexOf('id="urisInsertTemplate"'), 'Stage 1 sits before insert');
});

test('renderGenerateMarkup splits params into rows (format + template + «Дополнительно» аккордеон)', () => {
    const messageText = 'message text';
    const draft = { prompt: 'a cat', aspectRatio: '9:16', imageSize: '2K', quality: 'high', templateId: null, messageHash: hashMessage(messageText) };
    const markup = renderGenerateMarkup(baseVm({ draft, messageText }));
    // 4 uris-gen-params rows (2 open + 2 inside the Advanced accordion).
    assert.equal((markup.match(/class="uris-gen-params"/g) || []).length, 4);
    for (const id of ['urisAspect', 'urisImgSize', 'urisQuality', 'urisTemplate', 'urisAutomationMode', 'urisGenerationFlow']) {
        assert.match(markup, new RegExp(`id="${id}"`));
    }
    // Split point: row 1 ends after Модель, Шаблон opens row 2, Размер/Quality/Флоу/Автоматизация — внутри details.
    const first = markup.indexOf('class="uris-gen-params"');
    const second = markup.indexOf('class="uris-gen-params"', first + 1);
    const details = markup.indexOf('<details');
    assert.ok(markup.indexOf('id="urisAspect"') < second, 'Стороны в строке 1');
    assert.ok(markup.indexOf('id="urisModel"') < second, 'Модель в строке 1');
    assert.ok(second < markup.indexOf('id="urisTemplate"'), 'Шаблон в строке 2');
    assert.ok(markup.indexOf('id="urisTemplate"') < details, 'details идёт после Шаблона');
    assert.ok(details < markup.indexOf('id="urisImgSize"'), 'Размер внутри аккордеона');
    assert.ok(details < markup.indexOf('id="urisGenerationFlow"'), 'Флоу внутри аккордеона');
});

test('renderGenerateMarkup renders build and disabled Stage 2 for whitespace prompt', () => {
    const messageText = 'message text';
    const draft = { prompt: '   ', aspectRatio: '9:16', imageSize: '2K', quality: 'high', templateId: null, messageHash: hashMessage(messageText) };
    const markup = renderGenerateMarkup(baseVm({ draft, messageText }));
    assert.match(markup, /id="urisBuildPrompt"(?![^>]*disabled)[^>]*>\s*<i[^>]*><\/i> Построить промпт/);
    assert.match(markup, /id="urisGenerateImage"[^>]*disabled[^>]*>\s*<i[^>]*><\/i> Сгенерировать/);
});

test('renderGenerateMarkup keeps the editor and actions enabled while a generation is running', () => {
    const messageText = 'message text';
    for (const runningStage of ['stage1', 'stage2']) {
        const draft = {
            prompt: 'a cat', aspectRatio: '9:16', imageSize: '2K', quality: 'high', templateId: null,
            messageHash: hashMessage(messageText),
            [runningStage]: { status: 'running', requestId: 'req-1' },
        };
        const markup = renderGenerateMarkup(baseVm({ draft, messageText }));
        assert.match(markup, /id="urisPrompt"(?![^>]*disabled)/, `${runningStage}: editor stays enabled`);
        assert.match(markup, /id="urisPromptExpand"(?![^>]*disabled)/, `${runningStage}: expand stays enabled`);
        assert.match(markup, /id="urisBuildPrompt"(?![^>]*disabled)/, `${runningStage}: Stage 1 action stays enabled`);
        assert.match(markup, /id="urisGenerateImage"(?![^>]*disabled)/, `${runningStage}: Stage 2 action stays enabled`);
        if (runningStage === 'stage2') {
            assert.match(markup, /id="urisCancelImage"(?![^>]*hidden)/, 'Stop button stays visible for the running request');
        }
    }
});

test('renderGenerateMarkup renders the studio scene editor enabled and without post navigation', () => {
    const sceneText = 'a quiet room';
    const draft = { prompt: 'studio cat', promptOrigin: 'manual', sceneText, aspectRatio: '1:1', imageSize: '1K', quality: 'auto', messageHash: 'h' };
    const markup = renderGenerateMarkup({ ...baseVm({ draft, messageText: sceneText }), isStudio: true });
    assert.match(markup, /id="urisScene"(?![^>]*disabled)/, 'studio scene textarea stays enabled');
    assert.match(markup, new RegExp(`>${sceneText}</textarea>`), 'scene text renders as the editable source');
    assert.doesNotMatch(markup, /id="urisPrev"/, 'post navigator is absent in the studio');
    assert.match(markup, /id="urisGenerateImage"(?![^>]*disabled)/);
});

test('renderGenerateMarkup does not ask for confirmation before replacing manual prompt', () => {
    const messageText = 'message text';
    const draft = { prompt: 'manual edit', promptOrigin: 'manual', aspectRatio: '9:16', imageSize: '2K', quality: 'high', messageHash: hashMessage(messageText) };
    const markup = renderGenerateMarkup(baseVm({ draft, messageText }));
    assert.match(markup, /Перестроить промпт/);
    assert.doesNotMatch(markup, /confirm|подтверд|заменить ручн/i);
});

test('renderGenerateMarkup shows stale badge when draft is stale', () => {
    const draft = { prompt: 'a cat', aspectRatio: '9:16', imageSize: '2K', quality: 'high', templateId: null, messageHash: 'h' };
    const vm = buildGenerateViewModel({
        draft,
        snapshot: null,
        automationMode: 'manual',
        templates: [],
        messageText: 'different message',
    });
    const markup = renderGenerateMarkup(vm);
    assert.match(markup, /uris-draft-stale/);
    assert.match(markup, /Перестроить промпт/);
    assert.match(markup, /id="urisGenerateImage"(?![^>]*disabled)/);
});

test('renderGenerateMarkup renders template and automation mode selectors', () => {
    const draft = { prompt: 'a cat', aspectRatio: '9:16', imageSize: '2K', quality: 'high', templateSelection: 'override', templateId: 'tpl-1', messageHash: 'h' };
    const templates = [{ id: 'tpl-1', name: 'Fantasy' }, { id: 'tpl-2', name: 'Sci-fi' }];
    const markup = renderGenerateMarkup(buildGenerateViewModel({
        draft,
        snapshot: null,
        automationMode: 'full-pipeline',
        templates,
        messageText: 'a cat',
    }));
    assert.match(markup, /id="urisTemplate"/);
    assert.match(markup, /value="tpl-1"[^>]*\sselected|selected[^>]*value="tpl-1"/);
    assert.match(markup, /id="urisAutomationMode"/);
    assert.match(markup, /value="full-pipeline"[^>]*\sselected|selected[^>]*value="full-pipeline"/);
});

test('renderGenerateMarkup selects active template for a default draft', () => {
    const messageText = 'scene';
    const draft = {
        templateSelection: 'default', templateId: null,
        messageHash: hashMessage(messageText), prompt: '',
        aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
    };
    const markup = renderGenerateMarkup(baseVm({
        draft, messageText,
        templates: [{ id: 'tpl-active', name: 'Active' }, { id: 'tpl-other', name: 'Other' }],
        activeTemplateId: 'tpl-active',
    }));
    assert.match(markup, /value="tpl-active"[^>]*selected/);
    assert.doesNotMatch(markup, /value="tpl-other"[^>]*selected/);
});

test('renderGenerateMarkup renders unknown active template fallback for a default draft', () => {
    const messageText = 'scene';
    const draft = {
        templateSelection: 'default', templateId: null,
        messageHash: hashMessage(messageText), prompt: '',
        aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
    };
    const markup = renderGenerateMarkup(baseVm({
        draft, messageText,
        templates: [{ id: 'tpl-other', name: 'Other' }],
        activeTemplateId: 'tpl-deleted',
    }));
    const selectBlock = markup.match(/<select[^>]*id="urisTemplate"[^>]*>[\s\S]*?<\/select>/)?.[0];
    assert.ok(selectBlock);
    assert.match(selectBlock, /<option value=""[^>]*>— базовый режим —<\/option>/);
    assert.match(selectBlock, /<option value="tpl-deleted" selected>tpl-deleted<\/option>/);
    assert.doesNotMatch(selectBlock, /<option value="tpl-other"[^>]*selected/);
});

test('renderGenerateMarkup keeps explicit base override selected', () => {
    const messageText = 'scene';
    const draft = {
        templateSelection: 'override', templateId: null,
        messageHash: hashMessage(messageText), prompt: '',
        aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
    };
    const markup = renderGenerateMarkup(baseVm({
        draft, messageText,
        templates: [{ id: 'tpl-active', name: 'Active' }],
        activeTemplateId: 'tpl-active',
    }));
    const baseBlock = markup.match(/<select[^>]*id="urisTemplate"[^>]*>[\s\S]*?<\/select>/)?.[0];
    assert.ok(baseBlock);
    assert.match(baseBlock, /<option value="" selected>— базовый режим —<\/option>/);
});

test('buildGenerateViewModel follows active template for default draft and preserves override', () => {
    const messageText = 'scene';
    const defaultDraft = {
        templateSelection: 'default', templateId: null,
        messageHash: hashMessage(messageText), prompt: '',
        aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
    };
    const overrideDraft = {
        templateSelection: 'override', templateId: 'tpl-override',
        messageHash: hashMessage(messageText), prompt: '',
        aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
    };
    const templates = [
        { id: 'tpl-a', name: 'A' },
        { id: 'tpl-b', name: 'B' },
        { id: 'tpl-override', name: 'Override' },
    ];

    const vmDefaultA = buildGenerateViewModel({
        draft: defaultDraft, snapshot: null, automationMode: 'manual', templates, messageText, activeTemplateId: 'tpl-a',
    });
    const vmOverrideA = buildGenerateViewModel({
        draft: overrideDraft, snapshot: null, automationMode: 'manual', templates, messageText, activeTemplateId: 'tpl-a',
    });
    assert.equal(vmDefaultA.effectiveTemplateId, 'tpl-a');
    assert.equal(vmOverrideA.effectiveTemplateId, 'tpl-override');

    const vmDefaultB = buildGenerateViewModel({
        draft: defaultDraft, snapshot: null, automationMode: 'manual', templates, messageText, activeTemplateId: 'tpl-b',
    });
    const vmOverrideB = buildGenerateViewModel({
        draft: overrideDraft, snapshot: null, automationMode: 'manual', templates, messageText, activeTemplateId: 'tpl-b',
    });
    assert.equal(vmDefaultB.effectiveTemplateId, 'tpl-b');
    assert.equal(vmOverrideB.effectiveTemplateId, 'tpl-override');
});

test('renderGenerateMarkup renders aspect/size/quality selectors with selected values', () => {
    const draft = { prompt: 'a cat', aspectRatio: '16:9', imageSize: '4K', quality: 'medium', templateId: null, messageHash: 'h' };
    const markup = renderGenerateMarkup(buildGenerateViewModel({
        draft,
        snapshot: null,
        automationMode: 'manual',
        templates: [],
        messageText: 'a cat',
    }));
    assert.match(markup, /<select[^>]*id="urisAspect"/);
    assert.match(markup, /<option selected>16:9<\/option>/);
    assert.match(markup, /<option selected>4K<\/option>/);
    assert.match(markup, /<option value="medium" selected>medium<\/option>/);
});

test('renderGenerateMarkup renders ambiguities and stage error', () => {
    const draft = { prompt: 'x', aspectRatio: '9:16', imageSize: '2K', quality: 'high', templateId: null, messageHash: 'h', stage1: { status: 'error', error: 'scene ambiguous' } };
    const snapshot = {
        chatId: 'c', msgId: 1, messageHash: 'h', contextRevision: 1, entities: [],
        stage1Descriptions: [], stage2Refs: [],
        ambiguities: [{ mention: 'she', candidateIds: ['aria', 'luna'] }],
    };
    const markup = renderGenerateMarkup(buildGenerateViewModel({
        draft,
        snapshot,
        automationMode: 'manual',
        templates: [],
        messageText: 'x',
    }));
    assert.doesNotMatch(markup, /uris-stage-error/);
    assert.doesNotMatch(markup, /scene ambiguous/);
    assert.match(markup, /data-ambiguity="she"/);
    assert.match(markup, /aria/);
    assert.match(markup, /luna/);
});

test('renderGenerateMarkup renders references panel and queue buttons', () => {
    const draft = { prompt: 'x', aspectRatio: '9:16', imageSize: '2K', quality: 'high', templateId: null, messageHash: 'h' };
    const markup = renderGenerateMarkup(buildGenerateViewModel({
        draft,
        snapshot: null,
        automationMode: 'manual',
        templates: [],
        messageText: 'x',
    }));
    assert.match(markup, /id="urisRefsPanel"/);
});

test('renderGenerateMarkup keeps reference preview and whitelist without a references-tab shortcut', () => {
    const draft = { prompt: 'x', aspectRatio: '9:16', imageSize: '2K', quality: 'high', templateId: null, messageHash: 'h' };
    const markup = renderGenerateMarkup(buildGenerateViewModel({
        draft,
        snapshot: null,
        automationMode: 'manual',
        templates: [],
        messageText: 'x',
    }));
    assert.match(markup, /id="urisRefsPreview"/);
    assert.match(markup, /id="urisRefsWhitelist"/);
    assert.match(markup, /id="urisRefsStage1Keywords"/);
    assert.match(markup, /id="urisRefsStage2Keywords"/);
    assert.doesNotMatch(markup, /id="urisRefsEdit"/);
});

test('Generate tab source has no tab-switching action', async () => {
    const src = await readFile(new URL('../src/ui/tab-generate.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\bsetActiveTab\b/);
});

test('renderGenerateMarkup does not render old dual Stage1/Stage2 mode selectors', () => {
    const draft = { prompt: 'x', aspectRatio: '9:16', imageSize: '2K', quality: 'high', templateId: null, messageHash: 'h' };
    const markup = renderGenerateMarkup(buildGenerateViewModel({
        draft, snapshot: null, automationMode: 'manual', templates: [], messageText: 'x',
    }));
    assert.doesNotMatch(markup, /id="urisStage1Mode"/);
    assert.doesNotMatch(markup, /id="urisStage2Mode"/);
});

test('renderGenerateMarkup renders ambiguity include/exclude controls', () => {
    const draft = { prompt: 'x', aspectRatio: '9:16', imageSize: '2K', quality: 'high', templateId: null, messageHash: 'h' };
    const snapshot = {
        chatId: 'c', msgId: 1, messageHash: 'h', contextRevision: 1,
        entities: [{ id: 'aria-rose', name: 'Aria Rose', aliases: [], description: '', imagePath: '' },
                   { id: 'rose-smith', name: 'Rose Smith', aliases: [], description: '', imagePath: '' }],
        stage1Descriptions: [], stage2Refs: [],
        ambiguities: [{ mention: 'Rose', candidateIds: ['aria-rose', 'rose-smith'] }],
    };
    const markup = renderGenerateMarkup(buildGenerateViewModel({
        draft, snapshot, automationMode: 'manual', templates: [], messageText: 'x',
    }));
    assert.match(markup, /data-ambiguity="Rose"/);
    assert.match(markup, /data-candidate-id="aria-rose"/);
    assert.match(markup, /class="[^"]*uris-ref-include[^"]*"/);
    assert.match(markup, /class="[^"]*uris-ref-exclude[^"]*"/);
    assert.match(markup, /Aria Rose/);
    assert.match(markup, /Rose Smith/);
});

test('readGenerationParams reads current controls with draft fallbacks', () => {
    const controls = new Map([
        ['#urisAspect', { value: '16:9' }],
        ['#urisImgSize', { value: '4K' }],
        ['#urisQuality', { value: 'medium' }],
    ]);
    const root = { querySelector: selector => controls.get(selector) || null };
    const draft = { aspectRatio: '1:1', imageSize: '1K', quality: 'auto' };
    assert.deepEqual(readGenerationParams(root, draft), {
        aspectRatio: '16:9', imageSize: '4K', quality: 'medium',
    });

    assert.deepEqual(readGenerationParams({ querySelector: () => null }, draft), {
        aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
    });
});

test('persistVisibleGenerationDraft saves exact visible prompt and parameters with manual origin when changed', async () => {
    let savedUpdater;
    const stored = { prompt: 'old prompt', promptOrigin: 'stage1', aspectRatio: '1:1', imageSize: '1K', quality: 'auto' };
    await tabGenerate.persistVisibleGenerationDraft({
        draft: stored,
        visiblePrompt: '  exact visible prompt  ',
        params: { aspectRatio: '16:9', imageSize: '4K', quality: 'high' },
        persist: async updater => { savedUpdater = updater; },
    });
    assert.deepEqual(savedUpdater(stored), {
        ...stored,
        prompt: '  exact visible prompt  ',
        promptOrigin: 'manual',
        aspectRatio: '16:9', imageSize: '4K', quality: 'high',
    });
});

test('persistVisibleGenerationDraft preserves prompt origin when visible prompt is unchanged', async () => {
    let savedUpdater;
    const stored = { prompt: 'same', promptOrigin: 'stage1', aspectRatio: '1:1', imageSize: '1K', quality: 'auto' };
    await tabGenerate.persistVisibleGenerationDraft({
        draft: stored,
        visiblePrompt: 'same',
        params: { aspectRatio: '1:1', imageSize: '1K', quality: 'auto' },
        persist: async updater => { savedUpdater = updater; },
    });
    assert.equal(savedUpdater(stored).promptOrigin, 'stage1');
});

test('composeInsertedPrompt appends on a new line at the end without caret info', () => {
    assert.equal(composeInsertedPrompt('a cat', 'wide shot'), 'a cat\nwide shot');
    assert.equal(composeInsertedPrompt('', 'wide shot'), 'wide shot');
    // Already newline-terminated text is not double-spaced.
    assert.equal(composeInsertedPrompt('a cat\n', 'wide shot'), 'a cat\nwide shot');
});

test('composeInsertedPrompt splices at the caret and separates both sides', () => {
    assert.equal(composeInsertedPrompt('a cat sits', 'wide shot', { start: 5, end: 5 }), 'a cat\nwide shot\n sits');
    // A selection is replaced by the insert; the template block still lands on
    // its own lines, the remainder of the prompt is preserved verbatim.
    assert.equal(composeInsertedPrompt('a cat sits', 'wide shot', { start: 0, end: 5 }), 'wide shot\n sits');
    // Out-of-range carets clamp to the string bounds.
    assert.equal(composeInsertedPrompt('a cat', 'wide shot', { start: 99, end: 99 }), 'a cat\nwide shot');
});

test('cancelling prompt autosave prevents a delayed old write', async () => {
    let delayed;
    const writes = [];
    const autosave = tabGenerate.createCancellablePromptAutosave({
        persist: async value => writes.push(value),
        delay: 400,
        setTimer: fn => { delayed = fn; return 7; },
        clearTimer: () => {},
    });
    autosave.schedule('detached old prompt');
    autosave.cancel();
    await delayed();
    assert.deepEqual(writes, []);
});

test('pending prompt autosave lands in the draft of the post being edited', async () => {
    // P1 regression: the debounced callback used to re-read state.currentMsgId at
    // fire time, so typing on post 4 and navigating to post 5 inside the debounce
    // window wrote post 4's textarea text into post 5's draft. Identity must be
    // captured at input time.
    const originalCtx = globalThis.SillyTavern.getContext;
    const originalLf = globalThis.SillyTavern.libs.localforage;
    const store = new Map();
    globalThis.SillyTavern.libs.localforage = {
        getItem: async k => (store.has(k) ? store.get(k) : null),
        setItem: async (k, v) => { store.set(k, v); },
        removeItem: async k => { store.delete(k); },
    };
    const ctx = {
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        chatId: 'chat-1',
        chat: [
            { mes: 'post a text', is_user: false },
            { mes: 'post b text', is_user: false },
        ],
    };
    globalThis.SillyTavern.getContext = () => ctx;
    try {
        const { updateGenerationDraft, getGenerationDraft } = await import('../src/generation-drafts.js');
        state.currentMsgId = 0;
        // Seed post b's draft so a cross-post write would be observable.
        await updateGenerationDraft('chat-1', 1, 'post b text', d => ({ ...d, prompt: 'post b prompt' }));

        const els = new Map();
        const makeEl = () => {
            const el = { value: '', listeners: {} };
            el.addEventListener = (type, fn) => { el.listeners[type] = fn; };
            return el;
        };
        const root = { querySelector: sel => { if (!els.has(sel)) els.set(sel, makeEl()); return els.get(sel); } };
        tabGenerate.bindGenerate(root);

        const promptEl = els.get('#urisPrompt');
        assert.ok(promptEl, 'prompt textarea is bound');

        // Type on post a, then navigate away before the debounce fires.
        promptEl.value = 'typed on post a';
        promptEl.listeners.input();
        state.currentMsgId = 1;
        await new Promise(r => setTimeout(r, 550));

        const draftA = await getGenerationDraft('chat-1', 0, 'post a text');
        const draftB = await getGenerationDraft('chat-1', 1, 'post b text');
        assert.equal(draftA.prompt, 'typed on post a', 'pending save must land in the edited post draft');
        assert.equal(draftB.prompt, 'post b prompt', 'navigated-to draft must not receive the stale text');
    } finally {
        state.currentMsgId = null;
    }
});

test('tab-generate source imports every runtime symbol bindGenerate calls at attach time', async () => {
    // Regression guard: bindGenerate's cancel handler calls abortGeneration() and
    // its paths call getCtx()/state. Dropping a core.js import throws
    // ReferenceError during render and silently disables every Generate-tab
    // button, including Stage 1 and Stage 2. (Originally guarded debounce():
    // since the cancellable prompt autosave is wired in, attach no longer calls it.)
    const src = await readFile(new URL('../src/ui/tab-generate.js', import.meta.url), 'utf8');
    assert.match(src, /import\s*\{[^}]*\babortGeneration\b[^}]*\}\s*from\s*'\.\.\/core\.js'/);
    assert.match(src, /import\s*\{[^}]*\bgetCtx\b[^}]*\}\s*from\s*'\.\.\/core\.js'/);
    assert.match(src, /createCancellablePromptAutosave\(\{[\s\S]*?persist:/, 'bindGenerate must use the cancellable autosave, not a bare debounce');
});

test('bindGenerate attaches Stage 1 and Stage 2 click handlers without throwing', () => {
    const attached = [];
    const makeEl = (sel) => {
        let _disabled = false;
        return {
            get disabled() { return _disabled; },
            set disabled(v) { _disabled = v; },
            value: '',
            addEventListener: (type) => attached.push({ sel, type }),
        };
    };
    const root = { querySelector: sel => makeEl(sel) };

    assert.doesNotThrow(() => tabGenerate.bindGenerate(root));

    const clickSels = attached.filter(l => l.type === 'click').map(l => l.sel);
    assert.ok(clickSels.includes('#urisBuildPrompt'), 'Stage 1 button is bound');
    assert.ok(clickSels.includes('#urisGenerateImage'), 'Stage 2 button is bound');
    assert.ok(clickSels.includes('#urisFollowLast'), 'follow-last-post toggle is bound');
    assert.ok(!clickSels.includes('#urisPrimaryGenerate'), 'legacy primary button is not referenced');
});

test('submitCurrentGeneration surfaces storage errors via toastr', async () => {
    const originalCtx = globalThis.SillyTavern.getContext;
    const originalGetItem = globalThis.SillyTavern.libs.localforage.getItem;
    const errors = [];
    const warnings = [];
    globalThis.toastr = {
        error: (msg) => errors.push(msg),
        warning: (msg) => warnings.push(msg),
        info: () => {},
        success: () => {},
    };
    globalThis.SillyTavern.getContext = () => ({
        chatId: 'c1',
        chat: [{ mes: 'hello' }],
        chatMetadata: {},
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
    });
    globalThis.SillyTavern.libs.localforage.getItem = async () => {
        throw new Error('storage failed');
    };
    state.currentMsgId = 0;
    state.queue = [];
    const fakeRoot = { querySelector: () => null };
    try {
        await tabGenerate.submitCurrentGeneration(fakeRoot);
    } finally {
        globalThis.SillyTavern.getContext = originalCtx;
        globalThis.SillyTavern.libs.localforage.getItem = originalGetItem;
        globalThis.toastr = undefined;
    }
    assert.equal(errors.length, 1, 'expected one error toast');
    assert.match(errors[0], /storage failed/);
    assert.equal(warnings.length, 0);
});

test('submitCurrentGeneration enqueues a queue item with the visible prompt snapshot', async () => {
    const originalCtx = globalThis.SillyTavern.getContext;
    const infos = [];
    globalThis.toastr = { info: m => infos.push(m), success: () => {}, error: () => {}, warning: () => {} };
    globalThis.SillyTavern.getContext = () => ({
        chatId: 'c1',
        chat: [{ mes: 'hello' }],
        chatMetadata: {},
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
    });
    state.currentMsgId = 0;
    state.queue = [];
    const captured = [];
    const promptEl = { value: 'draw a cat' };
    const fakeRoot = { querySelector: sel => (sel === '#urisPrompt' ? promptEl : null) };
    try {
        await tabGenerate.submitCurrentGeneration(fakeRoot, {
            enqueue: item => { captured.push(item); return Promise.resolve(null); },
        });
    } finally {
        globalThis.SillyTavern.getContext = originalCtx;
        globalThis.toastr = undefined;
    }
    assert.equal(captured.length, 1);
    assert.equal(captured[0].requestedAction, 'current-prompt-stage2');
    assert.equal(captured[0].chatId, 'c1');
    assert.equal(captured[0].msgId, 0);
    assert.equal(captured[0].submission.prompt, 'draw a cat');
    assert.match(infos.join(' '), /Генерация началась|Добавлено в очередь/);
});

test('submitCurrentGeneration warns instead of enqueuing an empty prompt', async () => {
    const originalCtx = globalThis.SillyTavern.getContext;
    const warnings = [];
    globalThis.toastr = { info: () => {}, success: () => {}, error: () => {}, warning: m => warnings.push(m) };
    globalThis.SillyTavern.getContext = () => ({
        chatId: 'c1',
        chat: [{ mes: 'hello' }],
        chatMetadata: {},
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
    });
    state.currentMsgId = 0;
    const captured = [];
    const fakeRoot = { querySelector: sel => (sel === '#urisPrompt' ? { value: '   ' } : null) };
    try {
        await tabGenerate.submitCurrentGeneration(fakeRoot, {
            enqueue: item => { captured.push(item); return Promise.resolve(null); },
        });
    } finally {
        globalThis.SillyTavern.getContext = originalCtx;
        globalThis.toastr = undefined;
    }
    assert.equal(captured.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Промпт пуст/);
});

test('submitCurrentGeneration stays silent for items rejected by a whole-queue stop', async () => {
    const originalCtx = globalThis.SillyTavern.getContext;
    const infos = [];
    const errors = [];
    globalThis.toastr = { info: m => infos.push(m), success: () => {}, error: m => errors.push(m), warning: () => {} };
    globalThis.SillyTavern.getContext = () => ({
        chatId: 'c1',
        chat: [{ mes: 'hello' }],
        chatMetadata: {},
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
    });
    state.currentMsgId = 0;
    state.queue = [];
    const promptEl = { value: 'draw a cat' };
    const fakeRoot = { querySelector: sel => (sel === '#urisPrompt' ? promptEl : null) };
    let rejectQueued;
    try {
        await tabGenerate.submitCurrentGeneration(fakeRoot, {
            enqueue: () => new Promise((_, reject) => { rejectQueued = reject; }),
        });
    } finally {
        globalThis.SillyTavern.getContext = originalCtx;
    }
    // toastr stays installed until the deferred continuation has run; restored
    // in finally so a failing assert cannot leak the stub into later tests.
    try {
        const infosBefore = infos.length;
        rejectQueued(new DOMException('Queue stopped', 'AbortError'));
        await new Promise(r => setImmediate(r));
        assert.equal(infos.length, infosBefore, 'no cancel toast for queue-stop rejections');
        assert.equal(errors.length, 0);
    } finally {
        globalThis.toastr = undefined;
    }
});

test('submitCurrentGeneration toasts once for an in-flight item aborted by the user', async () => {
    const originalCtx = globalThis.SillyTavern.getContext;
    const infos = [];
    const errors = [];
    globalThis.toastr = { info: m => infos.push(m), success: () => {}, error: m => errors.push(m), warning: () => {} };
    globalThis.SillyTavern.getContext = () => ({
        chatId: 'c1',
        chat: [{ mes: 'hello' }],
        chatMetadata: {},
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
    });
    state.currentMsgId = 0;
    state.queue = [];
    const promptEl = { value: 'draw a cat' };
    const fakeRoot = { querySelector: sel => (sel === '#urisPrompt' ? promptEl : null) };
    let rejectQueued;
    try {
        await tabGenerate.submitCurrentGeneration(fakeRoot, {
            enqueue: () => new Promise((_, reject) => { rejectQueued = reject; }),
        });
    } finally {
        globalThis.SillyTavern.getContext = originalCtx;
    }
    // toastr stays installed until the deferred continuation has run; restored
    // in finally so a failing assert cannot leak the stub into later tests.
    try {
        rejectQueued(new DOMException('Aborted by user', 'AbortError'));
        await new Promise(r => setImmediate(r));
        assert.equal(infos.filter(m => /Генерация отменена/.test(m)).length, 1, 'exactly one cancel toast');
        assert.equal(errors.length, 0);
    } finally {
        globalThis.toastr = undefined;
    }
});

test('submitCurrentGeneration toasts success and records provider warnings quietly in the pool', async () => {
    const originalCtx = globalThis.SillyTavern.getContext;
    const successes = [];
    const warnings = [];
    const errors = [];
    globalThis.toastr = {
        info: () => {},
        success: m => successes.push(m),
        warning: m => warnings.push(m),
        error: m => errors.push(m),
    };
    globalThis.SillyTavern.getContext = () => ({
        chatId: 'c1',
        chat: [{ mes: 'hello' }],
        chatMetadata: {},
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
    });
    state.currentMsgId = 0;
    state.queue = [];
    const promptEl = { value: 'draw a cat' };
    const fakeRoot = { querySelector: sel => (sel === '#urisPrompt' ? promptEl : null) };
    try {
        await tabGenerate.submitCurrentGeneration(fakeRoot, {
            enqueue: () => Promise.resolve({
                warnings: [{ feature: 'Стороны', details: 'модель вернула другое' }],
                generationContext: { post: 0, connection: 'Test', model: 'sd-xl' },
            }),
        });
    } finally {
        globalThis.SillyTavern.getContext = originalCtx;
    }
    // toastr stays installed until the deferred continuation has run; restored
    // in finally so a failing assert cannot leak the stub into later tests.
    try {
        await new Promise(r => setImmediate(r));
        assert.equal(successes.length, 1, 'success toast fired');
        assert.equal(warnings.length, 0, 'provider warning does not toast');
        assert.equal(errors.length, 0);
        const pool = listUrisErrors();
        const entry = pool.find(item => item.scope === 'Провайдер');
        assert.ok(entry, 'provider warning recorded in the pool');
        assert.equal(entry.quiet, true, 'entry is quiet (no badge)');
        assert.match(entry.message, /Стороны: модель вернула другое/);
        assert.deepEqual(entry.context, { post: 0, connection: 'Test', model: 'sd-xl' });
    } finally {
        globalThis.toastr = undefined;
        clearUrisErrors();
    }
});

// ── Message-scoped reference corrections ──

test('updateReferenceCorrections include removes exclusion and increments revision', () => {
    const current = { includedIds: [], excludedIds: ['aaron'], revision: 2 };
    assert.deepEqual(updateReferenceCorrections(current, 'aaron', true), {
        includedIds: ['aaron'], excludedIds: [], revision: 3,
    });
});

test('updateReferenceCorrections exclude removes inclusion and increments revision', () => {
    const current = { includedIds: ['aaron'], excludedIds: [], revision: 7 };
    assert.deepEqual(updateReferenceCorrections(current, 'aaron', false), {
        includedIds: [], excludedIds: ['aaron'], revision: 8,
    });
});

test('updateReferenceCorrections does not duplicate ids', () => {
    const current = { includedIds: ['aaron'], excludedIds: [], revision: 1 };
    const first = updateReferenceCorrections(current, 'aaron', true);
    assert.deepEqual(first, { includedIds: ['aaron'], excludedIds: [], revision: 2 });
    const second = updateReferenceCorrections(first, 'aaron', true);
    assert.deepEqual(second, { includedIds: ['aaron'], excludedIds: [], revision: 3 });
});

test('updateReferenceCorrections normalizes missing arrays', () => {
    const current = { revision: 0 };
    assert.deepEqual(updateReferenceCorrections(current, 'beth', true), {
        includedIds: ['beth'], excludedIds: [], revision: 1,
    });
});

// ── Prompt-driven preview and effective reference controls ──

test('buildGenerateViewModel keeps Stage 1 descriptions separate from prompt refs', () => {
    const stage1Snapshot = {
        entities: [{ id: 'aaron', name: 'Aaron' }],
        stage1Descriptions: [{ id: 'aaron', name: 'Aaron', description: 'red coat' }],
        stage2Refs: [{ id: 'aaron', name: 'Aaron', imagePath: '/aaron.png' }],
        ambiguities: [],
    };
    const referenceResolution = {
        entities: [{ id: 'beth', name: 'Beth' }],
        stage2Refs: [{ id: 'beth', name: 'Beth', imagePath: '/beth.png' }],
        ambiguities: [],
    };
    const messageText = 'source scene';
    const matchingDraft = {
        prompt: 'Beth stands alone.', promptOrigin: 'stage1',
        messageHash: hashMessage(messageText),
        aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
    };
    const vm = buildGenerateViewModel({
        draft: matchingDraft,
        snapshot: stage1Snapshot,
        referenceResolution,
        automationMode: 'manual', templates: [], messageText,
    });
    assert.deepEqual(vm.descriptions, stage1Snapshot.stage1Descriptions);
    assert.deepEqual(vm.refs, referenceResolution.stage2Refs);
    assert.deepEqual(vm.ambiguities, referenceResolution.ambiguities);
    assert.deepEqual(vm.entities, referenceResolution.entities);
    assert.deepEqual(vm.referenceResolution, referenceResolution);
});

test('refreshReferencePanel refreshes ambiguity controls with the effective preview', async () => {
    const hosts = new Map([
        ['#urisRefsPanel', {}],
        ['#urisRefsModeBadge', { innerHTML: 'old' }],
        ['#urisRefsPreview', { innerHTML: '', querySelector: () => null }],
        ['#urisRefsWhitelist', { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] }],
        ['.uris-scene-context', { innerHTML: 'stale' }],
    ]);
    const root = {
        querySelector: selector => hosts.get(selector) || null,
    };
    const resolution = {
        entities: [{ id: 'aria-1', name: 'Aria One' }, { id: 'aria-2', name: 'Aria Two' }],
        stage2Refs: [],
        ambiguities: [{ mention: 'aria', candidateIds: ['aria-1', 'aria-2'] }],
    };

    await refreshReferencePanel(root, resolution);

    assert.match(hosts.get('.uris-scene-context').innerHTML, /data-ambiguity="aria"/);
    assert.match(hosts.get('.uris-scene-context').innerHTML, /data-candidate-id="aria-1"/);
    // Cap label renamed from "-> Stage 2" to "Отправится в генерацию".
    assert.match(hosts.get('#urisRefsPreview').innerHTML, /Выбрано для генерации/);
});

test('renderGenerateMarkup renders pool-only whitelist and no slot controls', () => {
    const messageText = 'scene';
    const draft = {
        prompt: 'Beth stands alone.', promptOrigin: 'stage1',
        messageHash: hashMessage(messageText),
        aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
    };
    const markup = renderGenerateMarkup(buildGenerateViewModel({
        draft,
        snapshot: null,
        referenceResolution: { entities: [], stage2Refs: [], ambiguities: [] },
        automationMode: 'manual', templates: [], messageText,
    }));
    assert.match(markup, /id="urisRefsPreview"/);
    assert.match(markup, /uris-refs-sources-section/);
    assert.match(markup, /uris-refs-sources-label/);
    assert.match(markup, /id="urisRefsWhitelist"/);
    // The "Stage 1 описания" desc panel was removed — descriptions flow from
    // pool cards via buildSceneContextSnapshot, no separate chat-level list.
    assert.doesNotMatch(markup, /data-source="desc"/);
    assert.doesNotMatch(markup, /id="urisRefsDesc"/);
    assert.doesNotMatch(markup, /data-source="slots"/);
    assert.doesNotMatch(markup, /data-source="npc"/);
    assert.doesNotMatch(markup, /urisRefsSlots|charSlot|userSlot|NPC whitelist/);
});

test('whitelist renders folder groups above a merged actions row with direct chips', async () => {
    const src = await readFile(new URL('../src/ui/tab-generate-refs.js', import.meta.url), 'utf8');
    // Direct cards live inside the actions row: the separate "Отдельные карточки"
    // group (header + "нет" placeholder) cost an extra UI line even when empty.
    assert.doesNotMatch(src, /uris-refs-whitelist-direct/);
    // Folder groups come first; the actions row opens with the direct chips and
    // closes with both add tiles.
    assert.match(src, /\$\{folderGroups\.join\(''\)\}<div class="uris-refs-whitelist-actions">\$\{directMarkup\}/);
    assert.match(src, /uris-add-extra[\s\S]*?uris-add-folder/);
});

test('reference library source has aliases editor but no role or keywords editor', async () => {
    const src = await readFile(new URL('../src/ui/tab-references.js', import.meta.url), 'utf8');
    assert.match(src, /uris-ed-aliases/);
    assert.doesNotMatch(src, /uris-ed-role/);
    assert.doesNotMatch(src, /uris-ed-keywords|Keywords/);
    assert.doesNotMatch(src, /keywords:\s*name/);
});

// ── Shared reference policy panel state ──

test('buildReferencePanelState reports effective max and over-limit delivery', () => {
    const state = buildReferencePanelState(
        [{ id: 'a' }, { id: 'b' }],
        { supported: true, maxRefs: 1, reason: '' },
    );
    assert.deepEqual(state, {
        count: 2,
        max: 1,
        canAdd: false,
        unsupported: false,
        overLimit: true,
        message: 'Выбрано 2 референсов, но маршрут поддерживает только 1. Удалите лишние референсы перед генерацией.',
    });
});

test('buildReferencePanelState hides picker for unsupported policy', () => {
    const state = buildReferencePanelState(
        [{ id: 'a' }],
        { supported: false, maxRefs: 0, reason: 'Работа временно отложена.' },
    );
    assert.equal(state.canAdd, false);
    assert.equal(state.unsupported, true);
    assert.equal(state.message, 'Работа временно отложена.');
});

test('resolveConnectionReferencePolicy uses saved browser route capabilities and transport', () => {
    assert.deepEqual(resolveConnectionReferencePolicy({
        executionOwner: 'legacy-browser',
        selectedRoute: {
            capabilities: { references: 'supported', maxReferences: 2 },
            transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
        },
    }), {
        supported: true,
        status: 'supported',
        protocol: null,
        maxRefs: 2,
        reason: '',
        source: 'browser-route',
    });
    assert.deepEqual(resolveConnectionReferencePolicy({
        executionOwner: 'legacy-browser',
        selectedRoute: {
            capabilities: { references: 'unsupported' },
            transport: { bodyKind: 'json', proxyEligible: false, directCors: 'required' },
        },
    }), {
        supported: false,
        status: 'unsupported',
        protocol: null,
        maxRefs: 0,
        reason: 'Выбранный маршрут не принимает референсы.',
        source: 'browser-route',
    });
});

test('getSnapshotReferencePolicy resolves the Stage 2 connection from its saved chat snapshot', async () => {
    state.activeImageProfileId = 'mutable-global-connection';
    const calls = [];
    const getConnection = async id => {
        calls.push(id);
        return id === 'saved-chat-connection'
            ? { selectedRoute: { capabilities: { references: 'supported', maxReferences: 2 } } }
            : { selectedRoute: { capabilities: { references: 'unsupported' } } };
    };

    const policy = await getSnapshotReferencePolicy({ imageProfileId: 'saved-chat-connection' }, getConnection);

    assert.equal(policy.supported, true);
    assert.equal(policy.maxRefs, 2);
    assert.deepEqual(calls, ['saved-chat-connection']);
});

test('getSnapshotReferencePolicy uses its immutable captured route; connection state only decorates', async () => {
    const policy = await getSnapshotReferencePolicy({
        imageProfileId: 'saved-chat-connection',
        imageRoute: { generationContract: 'chat-completions', modelId: 'gemini-3.1-flash-image', capabilities: { references: 'supported', maxReferences: 2 } },
    }, async () => ({
        // Mutable connection disagrees with the captured route: the route wins.
        model: { id: 'gemini-3.1-flash-image', source: 'list' },
        selectedRoute: { capabilities: { references: 'unsupported' } },
        evidence: { 'gemini-3.1-flash-image': { dialect: 'openai-images', refs: 'rejected', reason: 'edit не поддерживается этим шлюзом' } },
    }));

    assert.equal(policy.supported, true);
    assert.equal(policy.maxRefs, 2);
    assert.equal(policy.encoding, 'image_url-части (chat-completions)');
    assert.equal(policy.rejected.dialect, 'chat-completions');
    assert.equal(policy.rejected.nextDialect, 'gemini-native');
    assert.equal(policy.rejected.reason, 'edit не поддерживается этим шлюзом');
});

// ── follow-last-post toggle rendering ──

test('renderGenerateMarkup includes follow toggle with is-active when followLastPost=true', () => {
    state.settings.followLastPost = true;
    const vm = baseVm({ draft: { prompt: '', promptOrigin: 'stage1' }, messageText: 'x' });
    const html = renderGenerateMarkup(vm);
    assert.match(html, /id="urisFollowLast"/, 'toggle button must render');
    assert.match(html, /uris-follow-toggle[^"]* is-active/, 'must be active when followLastPost=true');
    assert.match(html, /aria-pressed="true"/);
});

test('renderGenerateMarkup renders follow toggle without is-active when followLastPost=false', () => {
    state.settings.followLastPost = false;
    const vm = baseVm({ draft: { prompt: '', promptOrigin: 'stage1' }, messageText: 'x' });
    const html = renderGenerateMarkup(vm);
    assert.match(html, /id="urisFollowLast"/);
    assert.doesNotMatch(html, /uris-follow-toggle[^"]* is-active/);
    assert.match(html, /aria-pressed="false"/);
});

test('renderGenerateMarkup renders follow toggle with default-on when setting absent', () => {
    delete state.settings.followLastPost;
    const vm = baseVm({ draft: { prompt: '', promptOrigin: 'stage1' }, messageText: 'x' });
    const html = renderGenerateMarkup(vm);
    assert.match(html, /uris-follow-toggle[^"]* is-active/, 'absent setting defaults to ON');
    assert.match(html, /aria-pressed="true"/);
});

// ── Phase 4: model dropdown + per-family quality ──

test('qualityOptionsFor follows the model family and marks the current value', async () => {
    const { qualityOptionsFor } = await import('../src/ui/tab-generate.js');
    assert.match(qualityOptionsFor('dall-e-3', 'hd'), /<option value="hd" selected>hd<\/option>/);
    assert.match(qualityOptionsFor('dall-e-3', 'hd'), /value="standard"/);
    assert.doesNotMatch(qualityOptionsFor('dall-e-3', 'hd'), /value="low"/);
    assert.match(qualityOptionsFor('gpt-image-1', 'medium'), /<option value="medium" selected>medium<\/option>/);
    assert.match(qualityOptionsFor('gpt-image-1', 'bogus'), /<option value="auto" selected>/, 'unknown value falls back to auto');
    assert.match(qualityOptionsFor('', 'high'), /<option value="high" selected>/, 'no model keeps the generic scale');
});

test('renderModelSelectMarkup covers no-connection, empty-list, manual and list cases', async () => {
    const { renderModelSelectMarkup } = await import('../src/ui/tab-generate.js');
    assert.match(renderModelSelectMarkup(null), /id="urisModel" disabled/);
    const empty = renderModelSelectMarkup({
        connId: 'c', connName: 'X', ids: [], current: '', manual: false,
        classifications: [{ modelId: 'chat-model', kind: 'non-image' }],
    });
    assert.doesNotMatch(empty, /urisGenerateShowAll/, 'the all-models toggle was removed from Generate');
    assert.doesNotMatch(empty, /value="chat-model"/);

    const list = renderModelSelectMarkup({ connId: 'c', connName: 'Relay', ids: ['a', 'b'], current: 'a', manual: false });
    assert.match(list, /id="urisModel"/);
    assert.match(list, /value="a" selected/);
    assert.match(list, /Relay/);
    assert.doesNotMatch(list, /urisGenerateShowAll/, 'the all-models toggle was removed from Generate');

    const manual = renderModelSelectMarkup({ connId: 'c', connName: 'X', ids: ['a'], current: 'zzz', manual: true });
    assert.match(manual, /value="zzz" selected>zzz \(вручную\)/);
});

test('bindModelSelect writes the model through to the connection and flushes the editor draft', async () => {
    const { bindModelSelect } = await import('../src/ui/tab-generate.js');
    const { makeFakeDocument } = await import('./fake-dom.js');
    const { root } = makeFakeDocument();
    root.innerHTML = `<select id="urisModel"><option value="old">old</option><option value="new">new</option></select>
        <textarea id="urisPrompt">typed prompt</textarea>
        <select id="urisAspect"><option>1:1</option></select><select id="urisImgSize"><option>1K</option></select><select id="urisQuality"><option>auto</option></select>`;
    const saves = [];
    let switched = null;
    bindModelSelect(root, { connId: 'conn-1', connName: 'X', ids: ['old', 'new'], current: 'old', manual: false }, {
        saveConnection: async patch => { saves.push(patch); },
        onSwitched: modelId => { switched = modelId; },
    });
    root.querySelector('#urisModel').value = 'new';
    await root.querySelector('#urisModel').dispatchEvent({ type: 'change' });
    assert.deepEqual(saves, [], 'model selection is chat-scoped and does not rewrite the shared connection');
    assert.equal(switched, 'new');
});

// ── Stop button vs interleaved Stage 1/2 (in-flight registry) ──

const { makeFakeDocument } = await import('./fake-dom.js');
const { render, bindAbortUI, unbindAbortUI, syncCancelState } = tabGenerate;

/**
 * The file-level window stub has no listener registry. These tests install a
 * local one (plus a CustomEvent class, same pattern as
 * tests/pipeline-stage2-serialization.test.js) so bindAbortUI() can be driven
 * through the real window events the pipeline dispatches.
 */
function installWindowEventStub() {
    const listeners = new Map();
    const prev = {
        dispatchEvent: globalThis.window.dispatchEvent,
        addEventListener: globalThis.window.addEventListener,
        removeEventListener: globalThis.window.removeEventListener,
    };
    globalThis.window.addEventListener = (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
    };
    globalThis.window.removeEventListener = (type, fn) => { listeners.get(type)?.delete(fn); };
    globalThis.window.dispatchEvent = ev => {
        for (const fn of [...(listeners.get(ev.type) || [])]) fn(ev);
        return true;
    };
    globalThis.CustomEvent ||= class CustomEvent extends Event {
        constructor(type, init) { super(type, init); this.detail = init?.detail; }
    };
    return () => {
        globalThis.window.dispatchEvent = prev.dispatchEvent;
        if (prev.addEventListener) globalThis.window.addEventListener = prev.addEventListener;
        else delete globalThis.window.addEventListener;
        if (prev.removeEventListener) globalThis.window.removeEventListener = prev.removeEventListener;
        else delete globalThis.window.removeEventListener;
    };
}

/** Point getContext at a chat with post #0 and render the Generate tab into a fake DOM. */
async function setupGenerateTab(chatId) {
    const originalCtx = globalThis.SillyTavern.getContext;
    globalThis.SillyTavern.getContext = () => ({
        chatId,
        chat: [{ mes: 'hello' }],
        chatMetadata: {},
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
    });
    const originalDocument = globalThis.document;
    const { document: fakeDoc, root } = makeFakeDocument();
    globalThis.document = fakeDoc;
    // tabs.js tags the tab body before rendering; without the tag render()'s
    // epoch guard bails before binding the UI.
    root.__urisTabId = 'generate';
    state.currentMsgId = 0;
    state.queue = [];
    state.queueRunning = false;
    globalThis.toastr = undefined;
    await render(root);
    return {
        root,
        restore() {
            globalThis.SillyTavern.getContext = originalCtx;
            globalThis.document = originalDocument;
            state.currentMsgId = null;
            state.runningQueueRequestId = null;
        },
    };
}

function stageEvent(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
}

test('Stop button survives an interleaved Stage 1 and stays tagged with the Stage 2 request', async () => {
    const restoreWindow = installWindowEventStub();
    let tab;
    try {
        tab = await setupGenerateTab('c1');
        bindAbortUI();
        const btn = tab.root.querySelector('#urisCancelImage');
        assert.ok(btn, 'Stop button is rendered');

        // Stage 2 (image generation) is in flight for post #0 of chat c1.
        stageEvent('uris:stage2-start', { requestId: 'req2', msgId: 0, chatId: 'c1', source: 'manual' });
        assert.equal(btn.hidden, false, 'Stop visible while Stage 2 runs');
        assert.equal(btn.getAttribute('data-request-id'), 'req2');

        // «Перестроить промпт» starts Stage 1 for the same post while Stage 2 flies.
        stageEvent('uris:stage1-start', { requestId: 'req1', msgId: 0, chatId: 'c1', source: 'manual' });
        assert.equal(btn.getAttribute('data-request-id'), 'req1');

        // Stage 1 ends — Stage 2 is still in flight: the Stop button must survive
        // and retarget to the Stage 2 request (pre-fix the single-value map
        // dropped the entry and hid the button here).
        stageEvent('uris:stage1-end', { requestId: 'req1', msgId: 0, chatId: 'c1' });
        assert.equal(btn.hidden, false, 'Stop must stay visible while Stage 2 is still in flight');
        assert.equal(btn.getAttribute('data-request-id'), 'req2');

        // Stage 2 ends — only now the Stop button hides.
        stageEvent('uris:stage2-end', { requestId: 'req2', msgId: 0, chatId: 'c1' });
        assert.equal(btn.hidden, true, 'Stop hides after the last in-flight request ends');
    } finally {
        unbindAbortUI();
        restoreWindow();
        tab?.restore();
    }
});

test('Stop button state is scoped per chat: another chat finishing must not touch it', async () => {
    const restoreWindow = installWindowEventStub();
    let tab;
    try {
        tab = await setupGenerateTab('c1');
        bindAbortUI();
        const btn = tab.root.querySelector('#urisCancelImage');

        stageEvent('uris:stage2-start', { requestId: 'req-c1', msgId: 0, chatId: 'c1', source: 'manual' });
        assert.equal(btn.hidden, false);
        assert.equal(btn.getAttribute('data-request-id'), 'req-c1');

        // Post #0 of another chat starts and ends — the c1 Stop button must stay
        // untouched (a bare msgId key made chat c2 overwrite and then hide it).
        stageEvent('uris:stage1-start', { requestId: 'req-c2', msgId: 0, chatId: 'c2', source: 'manual' });
        assert.equal(btn.getAttribute('data-request-id'), 'req-c1', 'c2 start must not retarget the c1 button');
        stageEvent('uris:stage1-end', { requestId: 'req-c2', msgId: 0, chatId: 'c2' });
        assert.equal(btn.hidden, false, 'c2 end must not hide the c1 Stop button');
        assert.equal(btn.getAttribute('data-request-id'), 'req-c1');

        stageEvent('uris:stage2-end', { requestId: 'req-c1', msgId: 0, chatId: 'c1' });
        assert.equal(btn.hidden, true, 'c1 Stop hides when its own request ends');
    } finally {
        unbindAbortUI();
        restoreWindow();
        tab?.restore();
    }
});

test('syncCancelState restores the Stop button with the last remaining requestId after a re-render', async () => {
    const restoreWindow = installWindowEventStub();
    let tab;
    try {
        tab = await setupGenerateTab('c1');
        bindAbortUI();
        stageEvent('uris:stage2-start', { requestId: 'req2', msgId: 0, chatId: 'c1', source: 'manual' });
        stageEvent('uris:stage1-start', { requestId: 'req1', msgId: 0, chatId: 'c1', source: 'manual' });
        stageEvent('uris:stage1-end', { requestId: 'req1', msgId: 0, chatId: 'c1' });

        // A re-render rebuilds the button DOM; syncCancelState must restore the
        // in-flight state from the registry (last remaining request wins).
        const second = await setupGenerateTab('c1');
        const btn = second.root.querySelector('#urisCancelImage');
        syncCancelState(second.root);
        assert.equal(btn.hidden, false, 'Stop restored for the post with an in-flight request');
        assert.equal(btn.getAttribute('data-request-id'), 'req2');

        stageEvent('uris:stage2-end', { requestId: 'req2', msgId: 0, chatId: 'c1' });
        syncCancelState(second.root);
        assert.equal(btn.hidden, true, 'Stop hidden once the registry is empty');
        second.restore();
    } finally {
        unbindAbortUI();
        restoreWindow();
        tab?.restore();
    }
});

// ── Insert-template action (prompt card) ──

test('insert-template button splices the selected template instruction into the prompt', async () => {
    const { setTemplateStoreForTests, resetTemplateStoreForTests } = await import('../src/prompt-templates.js');
    setTemplateStoreForTests({
        list: async () => [{ id: 'tpl-1', name: 'Cinematic', type: 'instruction', instruction: 'wide shot of {{char}}' }],
    });
    let tab;
    try {
        tab = await setupGenerateTab('c1');
        // setupGenerateTab installs its own minimal ctx (no substituteParams);
        // replace it AFTER the call so macro expansion is observable. The tab's
        // restore() still returns the file-level stub.
        const tabCtx = globalThis.SillyTavern.getContext;
        globalThis.SillyTavern.getContext = () => ({
            ...tabCtx(),
            substituteParams: text => text.replaceAll('{{char}}', 'Aria'),
        });
        const prompt = tab.root.querySelector('#urisPrompt');
        prompt.value = 'a cat';
        tab.root.querySelector('#urisTemplate').value = 'tpl-1';
        await tab.root.querySelector('#urisInsertTemplate').dispatchEvent({ type: 'click' });
        // Macros are expanded on insert: raw {{char}} must not reach the image model.
        assert.equal(prompt.value, 'a cat\nwide shot of Aria');
    } finally {
        resetTemplateStoreForTests();
        tab?.restore();
    }
});

test('insert-template button warns and keeps the prompt when no template is selected', async () => {
    const { setTemplateStoreForTests, resetTemplateStoreForTests } = await import('../src/prompt-templates.js');
    setTemplateStoreForTests({ list: async () => [] });
    let tab;
    try {
        tab = await setupGenerateTab('c1');
        // setupGenerateTab clears globalThis.toastr; install the stub after it.
        const warnings = [];
        globalThis.toastr = { warning: m => warnings.push(m), info: () => {}, success: () => {}, error: () => {} };
        const prompt = tab.root.querySelector('#urisPrompt');
        prompt.value = 'a cat';
        tab.root.querySelector('#urisTemplate').value = '';
        await tab.root.querySelector('#urisInsertTemplate').dispatchEvent({ type: 'click' });
        assert.equal(prompt.value, 'a cat', 'prompt stays untouched in base mode');
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /Шаблон не выбран/);
    } finally {
        globalThis.toastr = undefined;
        resetTemplateStoreForTests();
        tab?.restore();
    }
});

// ── composeEffectiveParams: приоритеты параметров (пункт 1.1) ──

test('composeEffectiveParams: chat-дефолты важнее черновика, живой выбор UI — важнее дефолтов', () => {
    const draft = { aspectRatio: '1:1', imageSize: '1K', quality: 'auto' };
    // Нет дефолтов и нет живого выбора — значения черновика.
    assert.deepEqual(composeEffectiveParams(draft, {}, null), { aspectRatio: '1:1', imageSize: '1K', quality: 'auto' });
    // Chat-дефолт (перечитанный с сервера) перекрывает черновик — прежнее правило.
    assert.deepEqual(
        composeEffectiveParams(draft, { aspectRatio: '16:9', imageSize: null, quality: 'high' }, null),
        { aspectRatio: '16:9', imageSize: '1K', quality: 'high' },
    );
    // Живой выбор UI (patchChatConfig в полёте) важнее старого дефолта — фикс 1.1.
    assert.deepEqual(
        composeEffectiveParams(draft, { aspectRatio: '16:9' }, { aspectRatio: '2:3' }),
        { aspectRatio: '2:3', imageSize: '1K', quality: 'auto' },
    );
});

// ── Guard двойного запуска (пункт 3.2) ──

function submitGuardContext() {
    return {
        chatId: 'c1',
        chat: [{ mes: 'hello' }],
        chatMetadata: {},
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
    };
}

test('guard двойного запуска: дубликат с отказом не ставится в очередь', async () => {
    const originalCtx = globalThis.SillyTavern.getContext;
    const infos = [];
    globalThis.toastr = { info: m => infos.push(m), success: () => {}, error: () => {}, warning: () => {} };
    globalThis.SillyTavern.getContext = submitGuardContext;
    state.currentMsgId = 0;
    state.queue = [];
    const captured = [];
    const promptEl = { value: 'draw a cat' };
    const fakeRoot = { querySelector: sel => (sel === '#urisPrompt' ? promptEl : null) };
    try {
        // Первый клик — ставится в очередь обычным enqueue.
        await tabGenerate.submitCurrentGeneration(fakeRoot, {
            enqueue: item => { captured.push(item); state.queue.push({ item, queueId: 'qx1' }); return Promise.resolve(null); },
        });
        assert.equal(captured.length, 1);
        // Второй клик с тем же промптом: пользователь отказывается.
        await tabGenerate.submitCurrentGeneration(fakeRoot, {
            enqueue: item => { captured.push(item); return Promise.resolve(null); },
            confirmDuplicate: async () => false,
        });
        assert.equal(captured.length, 1, 'дубликат не поставлен');
        assert.match(infos.join(' '), /дубликат уже в очереди/);
        // Третий клик: «Запустить всё равно» — ставится.
        await tabGenerate.submitCurrentGeneration(fakeRoot, {
            enqueue: item => { captured.push(item); return Promise.resolve(null); },
            confirmDuplicate: async () => true,
        });
        assert.equal(captured.length, 2, 'явный обход подтверждением работает');
    } finally {
        globalThis.SillyTavern.getContext = originalCtx;
        globalThis.toastr = undefined;
        state.queue = [];
    }
});
