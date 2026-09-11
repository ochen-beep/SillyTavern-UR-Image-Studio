// @ts-check
/**
 * Тесты DOM-слоя инлайна (src/inline/render.js).
 * computeShellPlan — чистая реконсиляция; DOM-функции — smoke через fake-dom
 * (по образцу tests/accordion-state.test.js / tests/fake-dom.js).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';
import { state } from '../src/core.js';
import { upsertItem } from '../src/inline/store.js';
import { stableHash } from '../src/inline/runner.js';

let doc = null;
let root = null;
let metadata = {};
let chatArr = [];

beforeEach(() => {
    const fake = makeFakeDocument();
    doc = fake.document;
    root = fake.root;
    globalThis.document = doc;
    metadata = {};
    chatArr = [{ mes: 'смотри [[img: a]] вот', is_user: false }];
    globalThis.SillyTavern = {
        getContext: () => ({ chat: chatArr, chatMetadata: metadata }),
    };
    state.settings = { inlineEnabled: true, inlineTriggers: [] };
    state.activeGenerations = new Map();
});

const {
    computeShellPlan, reconcileVisible, ensureManualButtons,
    initRender, shutdownRender,
} = await import('../src/inline/render.js');

const HASH_A = stableHash('img|a');

/** Готовый item, согласованный с маркером [[img: a]] (hashFn = stableHash). */
function readyItem(imagePath = 'p.png') {
    return { idx: 0, type: 'img', descHash: HASH_A, status: 'ready', imagePath };
}

/** Базовый вход computeShellPlan (по плану задачи); hashFn фейковый → 'aa'. */
function baseInput(existingKeys = []) {
    return {
        msgId: 5,
        markers: [{ start: 0, end: 10, raw: '[[img: a]]', type: 'img', desc: 'a' }],
        items: [{ idx: 0, type: 'img', descHash: 'aa', status: 'ready', imagePath: 'p.png' }],
        hashFn: (s) => (s === 'img|a' ? 'aa' : s),
        existingKeys,
    };
}

/** .mes с .mes_text (текстовый узел с маркером) и .mes_buttons внутри #chat. */
function buildChatDOM() {
    const chatEl = doc.createElement('div');
    chatEl.id = 'chat';
    const mesEl = doc.createElement('div');
    mesEl.classList.add('mes');
    mesEl.setAttribute('mesid', '0');
    const textEl = doc.createElement('div');
    textEl.classList.add('mes_text');
    textEl.appendChild(doc.createTextNode('смотри [[img: a]] вот'));
    mesEl.appendChild(textEl);
    const buttonsEl = doc.createElement('div');
    buttonsEl.classList.add('mes_buttons');
    mesEl.appendChild(buttonsEl);
    chatEl.appendChild(mesEl);
    root.appendChild(chatEl);
    return { chatEl, mesEl, textEl, buttonsEl };
}

// ── computeShellPlan (чистая реконсиляция) ──

test('computeShellPlan: маркер с готовым item → mount ready с ключом idx|type|hash', () => {
    const plan = computeShellPlan(baseInput());
    assert.equal(plan.length, 1);
    assert.equal(plan[0].key, '0|img|aa');
    assert.equal(plan[0].domAction, 'mount');
    assert.equal(plan[0].status, 'ready');
    assert.equal(plan[0].desc, 'a');
});

test('computeShellPlan: уже существующая оболочка → keep', () => {
    const plan = computeShellPlan(baseInput(['0|img|aa']));
    assert.equal(plan[0].domAction, 'keep');
});

test('computeShellPlan: pending item → status pending', () => {
    const plan = computeShellPlan({
        ...baseInput(),
        items: [{ idx: 0, type: 'img', descHash: 'aa', status: 'pending', requestId: 'r1' }],
    });
    assert.equal(plan[0].status, 'pending');
});

test('computeShellPlan: тот же idx|type с другим descHash → changed', () => {
    const plan = computeShellPlan({
        ...baseInput(),
        items: [{ idx: 0, type: 'img', descHash: 'old', status: 'ready', imagePath: 'p.png' }],
    });
    assert.equal(plan[0].status, 'changed');
    assert.equal(plan[0].item.descHash, 'old');
});

test('computeShellPlan: item нет вовсе → button (ручной старт)', () => {
    const plan = computeShellPlan({ ...baseInput(), items: [] });
    assert.equal(plan[0].status, 'button');
    assert.equal(plan[0].item, null);
});

test('computeShellPlan: ready без файла → error (показывать нечего)', () => {
    const plan = computeShellPlan({
        ...baseInput(),
        items: [{ idx: 0, type: 'img', descHash: 'aa', status: 'ready', imagePath: null }],
    });
    assert.equal(plan[0].status, 'error');
});

test('computeShellPlan: error item → status error, текст ошибки доступен', () => {
    const plan = computeShellPlan({
        ...baseInput(),
        items: [{ idx: 0, type: 'img', descHash: 'aa', status: 'error', error: 'NO_CONNECTION' }],
    });
    assert.equal(plan[0].status, 'error');
    assert.equal(plan[0].item.error, 'NO_CONNECTION');
});

// ── reconcileVisible (smoke через fake-dom) ──

test('reconcileVisible: ready → img с src=/+path, маркер скрыт, оболочка помечена', () => {
    const { textEl } = buildChatDOM();
    upsertItem(0, readyItem());
    reconcileVisible();
    const img = textEl.querySelector('img');
    assert.ok(img, 'img создан');
    assert.equal(img.getAttribute('src'), '/p.png');
    assert.equal(img.getAttribute('loading'), 'lazy');
    const shell = textEl.querySelector('[data-uris-inl]');
    assert.equal(shell.getAttribute('data-uris-inl'), `0|img|${HASH_A}`);
    assert.equal(shell.getAttribute('data-uris-status'), 'ready');
    assert.ok(textEl.querySelector('[data-uris-inl-hidden]'), 'маркер обёрнут в display:none');
});

test('reconcileVisible: идемпотентен — повторный прогон не плодит оболочки', () => {
    const { textEl } = buildChatDOM();
    upsertItem(0, readyItem());
    reconcileVisible();
    reconcileVisible();
    assert.equal(textEl.querySelectorAll('img').length, 1);
    assert.equal(textEl.querySelectorAll('[data-uris-inl]').length, 1);
    assert.equal(textEl.querySelectorAll('[data-uris-inl-hidden]').length, 1);
});

test('reconcileVisible: inlineEnabled=false → ничего не делает', () => {
    const { textEl } = buildChatDOM();
    state.settings.inlineEnabled = false;
    upsertItem(0, readyItem());
    reconcileVisible();
    assert.equal(textEl.querySelectorAll('[data-uris-inl]').length, 0);
});

test('reconcileVisible: pending → спиннер; ready в store → замена на img (аменда 1)', () => {
    const { textEl } = buildChatDOM();
    upsertItem(0, { idx: 0, type: 'img', descHash: HASH_A, status: 'pending', requestId: 'r1' });
    reconcileVisible();
    let shell = textEl.querySelector('[data-uris-inl]');
    assert.equal(shell.getAttribute('data-uris-status'), 'pending');
    assert.ok(textEl.querySelector('.fa-spinner'), 'спиннер показан');
    // В проде это приходит событием uris:inline-end → reconcileVisible; в тесте
    // вызываем reconcileVisible напрямую — тот же путь обновления оболочки.
    upsertItem(0, { idx: 0, type: 'img', descHash: HASH_A, status: 'ready', imagePath: 'p.png', requestId: 'r1' });
    reconcileVisible();
    shell = textEl.querySelector('[data-uris-inl]');
    assert.equal(shell.getAttribute('data-uris-status'), 'ready');
    assert.equal(textEl.querySelector('img').getAttribute('src'), '/p.png');
    assert.equal(textEl.querySelectorAll('[data-uris-inl]').length, 1, 'замена, а не дубль');
});

test('reconcileVisible: ✕ у pending с живым requestId → abort контроллера (аменда 2)', () => {
    const { textEl } = buildChatDOM();
    const controller = new AbortController();
    state.activeGenerations.set('r1', controller);
    upsertItem(0, { idx: 0, type: 'img', descHash: HASH_A, status: 'pending', requestId: 'r1' });
    reconcileVisible();
    const cancel = textEl.querySelector('[data-uris-cancel]');
    assert.ok(cancel, 'кнопка отмены на месте');
    cancel.click();
    assert.equal(controller.signal.aborted, true);
});

test('reconcileVisible: ✕ у pending без живого requestId → error-оболочка с retry', () => {
    const { textEl } = buildChatDOM();
    upsertItem(0, { idx: 0, type: 'img', descHash: HASH_A, status: 'pending', requestId: 'dead' });
    reconcileVisible();
    textEl.querySelector('[data-uris-cancel]').click();
    const shell = textEl.querySelector('[data-uris-inl]');
    assert.equal(shell.getAttribute('data-uris-status'), 'error');
});

test('reconcileVisible: маркер убрали из сообщения → устаревшая оболочка снята', () => {
    const { textEl } = buildChatDOM();
    upsertItem(0, readyItem());
    reconcileVisible();
    assert.equal(textEl.querySelectorAll('[data-uris-inl]').length, 1);
    chatArr[0].mes = 'маркера больше нет';
    reconcileVisible();
    assert.equal(textEl.querySelectorAll('[data-uris-inl]').length, 0, 'оболочка удалена');
});

// ── ensureManualButtons (📷 в .mes_buttons) ──

test('ensureManualButtons: 📷 у AI-сообщения; клик → reroll job + ручная оболочка', () => {
    const { textEl, buttonsEl } = buildChatDOM();
    const jobs = [];
    initRender({ reroll: (job) => { jobs.push(job); return Promise.resolve(); } });
    ensureManualButtons();
    const btn = buttonsEl.querySelector('[data-uris-manual]');
    assert.ok(btn, 'кнопка 📷 добавлена');
    btn.click();
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0], { msgId: 0, idx: -1, type: 'img', desc: 'смотри [[img: a]] вот' });
    const manual = textEl.querySelector('[data-manual="1"]');
    assert.ok(manual, 'ручная оболочка вставлена в .mes_text');
    assert.equal(manual.getAttribute('data-uris-status'), 'pending');
    ensureManualButtons();
    assert.equal(buttonsEl.querySelectorAll('[data-uris-manual]').length, 1, 'идемпотентно');
    shutdownRender();
});

test('ensureManualButtons: сообщение пользователя — без кнопки', () => {
    chatArr[0].is_user = true;
    const { buttonsEl } = buildChatDOM();
    ensureManualButtons();
    assert.equal(buttonsEl.querySelectorAll('[data-uris-manual]').length, 0);
});

test('reconcileVisible: ручная оболочка становится ready после генерации (idx -1)', () => {
    const { textEl, buttonsEl } = buildChatDOM();
    const jobs = [];
    initRender({ reroll: (job) => { jobs.push(job); return Promise.resolve(); } });
    ensureManualButtons();
    buttonsEl.querySelector('[data-uris-manual]').click();
    const manualKey = `-1|img|${stableHash(`img|${jobs[0].desc}`)}`;
    assert.equal(textEl.querySelector(`[data-uris-inl="${manualKey}"]`).getAttribute('data-uris-status'), 'pending');
    upsertItem(0, { idx: -1, type: 'img', descHash: stableHash(`img|${jobs[0].desc}`), status: 'ready', imagePath: 'm.png' });
    reconcileVisible();
    const shell = textEl.querySelector(`[data-uris-inl="${manualKey}"]`);
    assert.ok(shell, 'ручная оболочка на месте');
    assert.equal(shell.getAttribute('data-uris-status'), 'ready');
    assert.equal(shell.querySelector('img').getAttribute('src'), '/m.png');
    shutdownRender();
});
