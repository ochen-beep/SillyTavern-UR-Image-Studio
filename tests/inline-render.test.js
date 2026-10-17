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
    resetViewerForTests();
    resetCardLookupForTests();
});

const {
    computeShellPlan, reconcileVisible, ensureManualButtons,
    initRender, shutdownRender,
    messageLightboxItems, setViewerForTests, resetViewerForTests,
    setCardLookupForTests, resetCardLookupForTests,
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
function buildChatDOM({ extra = true } = {}) {
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
    let extraEl = null;
    if (extra) {
        // Структура ST: меню дополнительных действий внутри .mes_buttons.
        extraEl = doc.createElement('div');
        extraEl.classList.add('extraMesButtons');
        buttonsEl.appendChild(extraEl);
    }
    mesEl.appendChild(buttonsEl);
    chatEl.appendChild(mesEl);
    root.appendChild(chatEl);
    return { chatEl, mesEl, textEl, buttonsEl, extraEl };
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

test('computeShellPlan: pending item → status pending (свежий, в грейс-окне)', () => {
    const plan = computeShellPlan({
        ...baseInput(),
        items: [{ idx: 0, type: 'img', descHash: 'aa', status: 'pending', requestId: 'r1', createdAt: Date.now() }],
    });
    assert.equal(plan[0].status, 'pending');
    assert.equal(plan[0].orphaned, false);
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

// — Осиротевший pending (перезагрузка/краш): requestId вне inFlight и грейс
// истёк → error с retry, а не вечный спиннер. Логика переехала сюда из
// planScan (render-ветки удалены) — только у DOM-слоя есть живые requestId.

test('computeShellPlan: осиротевший pending (за грейсом, вне inFlight) → error', () => {
    const plan = computeShellPlan({
        ...baseInput(),
        items: [{ idx: 0, type: 'img', descHash: 'aa', status: 'pending', requestId: 'dead', createdAt: 0 }],
        now: () => 1_000_000,
    });
    assert.equal(plan[0].status, 'error');
    assert.equal(plan[0].orphaned, true);
});

test('computeShellPlan: живой requestId в inFlight держит pending даже за грейсом', () => {
    const plan = computeShellPlan({
        ...baseInput(),
        items: [{ idx: 0, type: 'img', descHash: 'aa', status: 'pending', requestId: 'r1', createdAt: 0 }],
        inFlight: new Set(['r1']),
        now: () => 1_000_000,
    });
    assert.equal(plan[0].status, 'pending');
    assert.equal(plan[0].orphaned, false);
});

test('computeShellPlan: свежий pending без requestId (ещё стартует) → pending', () => {
    const plan = computeShellPlan({
        ...baseInput(),
        items: [{ idx: 0, type: 'img', descHash: 'aa', status: 'pending', requestId: null, createdAt: 0 }],
        now: () => 60_000,
    });
    assert.equal(plan[0].status, 'pending');
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
    upsertItem(0, { idx: 0, type: 'img', descHash: HASH_A, status: 'pending', requestId: 'r1', createdAt: Date.now() });
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

test('reconcileVisible: осиротевший pending → error-оболочка с retry, не вечный спиннер', () => {
    const { textEl } = buildChatDOM();
    // createdAt: 0 — за грейсом; requestId 'dead' вне state.activeGenerations.
    upsertItem(0, { idx: 0, type: 'img', descHash: HASH_A, status: 'pending', requestId: 'dead', createdAt: 0 });
    reconcileVisible();
    const shell = textEl.querySelector('[data-uris-inl]');
    assert.equal(shell.getAttribute('data-uris-status'), 'error');
    assert.ok(!textEl.querySelector('.fa-spinner'), 'спиннер снят');
    assert.ok(shell.textContent.includes('прервана'), 'текст «прервана» с retry');
    // Клик по retry ставит новую платную задачу с тем же ключом.
    const jobs = [];
    initRender({ reroll: (job) => { jobs.push(job); return Promise.resolve(); } });
    shell.querySelector('.uris-inl-btn').click();
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0], { msgId: 0, idx: 0, type: 'img', desc: 'a' });
    shutdownRender();
});

test('reconcileVisible: ✕ у живого pending → abort контроллера (аменда 2)', () => {
    const { textEl } = buildChatDOM();
    const controller = new AbortController();
    state.activeGenerations.set('r1', controller);
    upsertItem(0, { idx: 0, type: 'img', descHash: HASH_A, status: 'pending', requestId: 'r1', createdAt: Date.now() });
    reconcileVisible();
    const cancel = textEl.querySelector('[data-uris-cancel]');
    assert.ok(cancel, 'кнопка отмены на месте');
    cancel.click();
    assert.equal(controller.signal.aborted, true);
});

test('reconcileVisible: ✕ у pending без живого requestId → error-оболочка с retry', () => {
    const { textEl } = buildChatDOM();
    upsertItem(0, { idx: 0, type: 'img', descHash: HASH_A, status: 'pending', requestId: 'dead', createdAt: Date.now() });
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

// ── Позиция оболочки: на месте маркера, не в конце поста ──

/** Два абзаца в .mes_text, маркер во втором. */
function buildTwoParagraphs() {
    const chatEl = doc.createElement('div');
    chatEl.id = 'chat';
    const mesEl = doc.createElement('div');
    mesEl.classList.add('mes');
    mesEl.setAttribute('mesid', '0');
    const textEl = doc.createElement('div');
    textEl.classList.add('mes_text');
    textEl.innerHTML = '<p>первый абзац</p><p>второй [[img: a]] конец</p>';
    const buttonsEl = doc.createElement('div');
    buttonsEl.classList.add('mes_buttons');
    mesEl.appendChild(textEl);
    mesEl.appendChild(buttonsEl);
    chatEl.appendChild(mesEl);
    root.appendChild(chatEl);
    return { textEl };
}

test('reconcileVisible: оболочка встаёт после абзаца с маркером', () => {
    const { textEl } = buildTwoParagraphs();
    upsertItem(0, readyItem());
    reconcileVisible();
    const kids = textEl.children;
    assert.equal(kids.length, 3, 'p1, p2, оболочка');
    assert.equal(kids[1].tagName, 'p');
    assert.ok(kids[1].querySelector('[data-uris-inl-hidden]'), 'маркер спрятан внутри своего абзаца');
    assert.equal(kids[2].getAttribute('data-uris-inl'), `0|img|${HASH_A}`, 'оболочка сразу после абзаца с маркером');
});

test('reconcileVisible: два маркера в одном абзаце — оболочки в порядке текста', () => {
    const { textEl } = buildTwoParagraphs();
    chatArr[0].mes = 'раз [[img: a]] два [[selfie: b]]';
    textEl.innerHTML = '<p>раз [[img: a]] два [[selfie: b]] три</p>';
    upsertItem(0, readyItem());
    upsertItem(0, { idx: 1, type: 'selfie', descHash: stableHash('selfie|b'), status: 'ready', imagePath: 'b.png' });
    reconcileVisible();
    const kids = textEl.children;
    assert.equal(kids.length, 3, 'p, оболочка img, оболочка selfie');
    assert.equal(kids[1].getAttribute('data-uris-inl'), `0|img|${HASH_A}`);
    assert.equal(kids[2].getAttribute('data-uris-inl'), `1|selfie|${stableHash('selfie|b')}`);
});

test('reconcileVisible: pending→ready сохраняет позицию после абзаца', () => {
    const { textEl } = buildTwoParagraphs();
    upsertItem(0, { idx: 0, type: 'img', descHash: HASH_A, status: 'pending', requestId: 'r1', createdAt: Date.now() });
    reconcileVisible();
    upsertItem(0, { idx: 0, type: 'img', descHash: HASH_A, status: 'ready', imagePath: 'p.png', requestId: 'r1' });
    reconcileVisible();
    const kids = textEl.children;
    assert.equal(kids.length, 3);
    assert.equal(kids[2].getAttribute('data-uris-status'), 'ready');
    assert.equal(kids[2].getAttribute('data-uris-inl'), `0|img|${HASH_A}`, 'замена статуса не утащила оболочку в конец');
});

test('reconcileVisible: raw маркера в DOM не найден — фолбэк в конец .mes_text', () => {
    const { textEl } = buildTwoParagraphs();
    textEl.innerHTML = '<p>маркера в рендере нет</p>';
    upsertItem(0, readyItem());
    reconcileVisible();
    const kids = textEl.children;
    assert.equal(kids.length, 2, 'p, оболочка в конце');
    assert.equal(kids[1].getAttribute('data-uris-inl'), `0|img|${HASH_A}`);
});

// ── Компакт-режим (inlineChips): чипы вместо картинок, клик раскрывает ──

test('compact: готовая картинка — чип; клик раскрывает, ⌃ сворачивает', () => {
    const { textEl } = buildChatDOM();
    state.settings.inlineChips = true;
    upsertItem(0, readyItem());
    reconcileVisible();
    let shell = textEl.querySelector('[data-uris-inl]');
    assert.equal(shell.getAttribute('data-uris-form'), 'chip');
    assert.ok(!shell.querySelector('img'), 'картинки нет, пока чип');
    const chip = shell.querySelector('.uris-inl-chip');
    assert.ok(chip && chip.tagName === 'button', 'чип-кнопка на месте');
    chip.click();
    shell = textEl.querySelector('[data-uris-inl]');
    assert.equal(shell.getAttribute('data-uris-form'), 'full', 'клик по чипу раскрыл картинку');
    assert.equal(shell.querySelector('img').getAttribute('src'), '/p.png');
    assert.ok(shell.querySelector('.uris-inl-collapse'), '⌃ сворачивание на месте');
    // Реконсиляция не схлопывает раскрытое обратно.
    reconcileVisible();
    assert.equal(textEl.querySelector('[data-uris-inl]').getAttribute('data-uris-form'), 'full');
    textEl.querySelector('.uris-inl-collapse').click();
    shell = textEl.querySelector('[data-uris-inl]');
    assert.equal(shell.getAttribute('data-uris-form'), 'chip', '⌃ свернул обратно в чип');
    reconcileVisible();
    assert.equal(textEl.querySelector('[data-uris-inl]').getAttribute('data-uris-form'), 'chip');
});

test('compact: pending — компактный чип со спиннером и рабочей ✕', () => {
    const { textEl } = buildChatDOM();
    state.settings.inlineChips = true;
    upsertItem(0, { idx: 0, type: 'img', descHash: HASH_A, status: 'pending', requestId: 'r1', createdAt: Date.now() });
    reconcileVisible();
    const shell = textEl.querySelector('[data-uris-inl]');
    assert.equal(shell.getAttribute('data-uris-form'), 'chip');
    assert.ok(shell.querySelector('.fa-spinner'), 'спиннер в чипе');
    assert.ok(shell.querySelector('[data-uris-cancel]'), 'отмена на месте');
    // Готовность → чип с кнопкой раскрытия (форма чипа сохраняется).
    upsertItem(0, { idx: 0, type: 'img', descHash: HASH_A, status: 'ready', imagePath: 'p.png', requestId: 'r1' });
    reconcileVisible();
    const readyShell = textEl.querySelector('[data-uris-inl]');
    assert.equal(readyShell.getAttribute('data-uris-form'), 'chip');
    const chipBtn = readyShell.querySelector('.uris-inl-chip');
    assert.ok(chipBtn && chipBtn.tagName === 'button', 'готовый чип-кнопка на месте');
});

test('compact: переключение настройки перестраивает готовые оболочки следующим проходом', () => {
    const { textEl } = buildChatDOM();
    upsertItem(0, readyItem());
    reconcileVisible();
    assert.equal(textEl.querySelector('[data-uris-inl]').getAttribute('data-uris-form'), 'full');
    state.settings.inlineChips = true;
    reconcileVisible();
    assert.equal(textEl.querySelector('[data-uris-inl]').getAttribute('data-uris-form'), 'chip');
    state.settings.inlineChips = false;
    reconcileVisible();
    assert.equal(textEl.querySelector('[data-uris-inl]').getAttribute('data-uris-form'), 'full');
});

test('compact: без чип-режима — прежнее поведение (img сразу, без ⌃)', () => {
    const { textEl } = buildChatDOM();
    upsertItem(0, readyItem());
    reconcileVisible();
    const shell = textEl.querySelector('[data-uris-inl]');
    assert.equal(shell.getAttribute('data-uris-form'), 'full');
    assert.ok(shell.querySelector('img'));
    assert.ok(!shell.querySelector('.uris-inl-collapse'), 'сворачивания нет без компакт-режима');
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

test('ensureManualButtons: 📷 живёт в .extraMesButtons, а не напрямую в .mes_buttons', () => {
    const { extraEl } = buildChatDOM();
    ensureManualButtons();
    const btn = extraEl.querySelector('[data-uris-manual]');
    assert.ok(btn, 'кнопка внутри меню дополнительных действий');
    assert.equal(btn.parentNode, extraEl, 'ровно в .extraMesButtons');
});

test('ensureManualButtons: без .extraMesButtons — фолбэк в .mes_buttons', () => {
    const { buttonsEl } = buildChatDOM({ extra: false });
    ensureManualButtons();
    const btn = buttonsEl.querySelector('[data-uris-manual]');
    assert.ok(btn, 'кнопка добавлена даже без меню дополнительных действий');
    assert.equal(btn.parentNode, buttonsEl);
});

test('shutdownRender: выключение инлайна снимает 📷-кнопки, включение возвращает', () => {
    buildChatDOM();
    ensureManualButtons();
    assert.ok(document.querySelector('[data-uris-manual]'), 'кнопка стоит до выключения');
    shutdownRender();
    assert.equal(document.querySelectorAll('[data-uris-manual]').length, 0, 'после выключения кнопок нет');
    // Цикл on→off→on: повторное включение возвращает кнопку.
    initRender({ reroll: () => Promise.resolve() });
    ensureManualButtons();
    assert.ok(document.querySelector('[data-uris-manual]'), 'после включения кнопка вернулась');
    shutdownRender();
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

test('render: manual error shell converges (stable identity across passes)', () => {
    // Регрессия: безгардовая replaceWith() в reconcileManualShells пересоздавала
    // error-оболочку (data-manual остаётся → совпадение снова) каждый проход —
    // бесконечный чурн через MutationObserver. Здесь без обсервера: 3 прохода
    // подряд должны оставить ТОТ ЖЕ узел.
    const { textEl, buttonsEl } = buildChatDOM();
    const jobs = [];
    initRender({ reroll: (job) => { jobs.push(job); return Promise.resolve(); } });
    ensureManualButtons();
    buttonsEl.querySelector('[data-uris-manual]').click();
    upsertItem(0, { idx: -1, type: 'img', descHash: stableHash(`img|${jobs[0].desc}`), status: 'error', error: 'NO_CONNECTION' });
    reconcileVisible();
    const manualKey = `-1|img|${stableHash(`img|${jobs[0].desc}`)}`;
    const first = textEl.querySelector(`[data-uris-inl="${manualKey}"]`);
    assert.equal(first.getAttribute('data-uris-status'), 'error');
    // Маркер [[img: a]] получает собственную button-оболочку — считаем её,
    // инвариант: количество оболочек не растёт от прохода к проходу.
    const countAfterFirst = textEl.querySelectorAll('[data-uris-inl]').length;
    for (let i = 0; i < 3; i++) {
        reconcileVisible();
        const shell = textEl.querySelector(`[data-uris-inl="${manualKey}"]`);
        assert.equal(shell, first, `проход ${i + 1}: узел не пересоздаётся`);
    }
    assert.equal(textEl.querySelectorAll('[data-uris-inl]').length, countAfterFirst, 'без churn: число оболочек стабильно');
    shutdownRender();
});

test('render: маркерные оболочки тоже сходятся (identity после замены статуса)', () => {
    const { textEl } = buildChatDOM();
    upsertItem(0, { idx: 0, type: 'img', descHash: HASH_A, status: 'pending', requestId: 'r1', createdAt: Date.now() });
    reconcileVisible();
    upsertItem(0, { idx: 0, type: 'img', descHash: HASH_A, status: 'ready', imagePath: 'p.png', requestId: 'r1' });
    reconcileVisible();
    const first = textEl.querySelector('[data-uris-inl]');
    assert.equal(first.getAttribute('data-uris-status'), 'ready');
    reconcileVisible();
    reconcileVisible();
    assert.equal(textEl.querySelector('[data-uris-inl]'), first, 'тот же узел на следующих проходах');
    assert.equal(textEl.querySelectorAll('[data-uris-inl]').length, 1);
});

test('render: осиротевшая ручная pending-оболочка → error, спиннер не живёт вечно', () => {
    const { textEl, buttonsEl } = buildChatDOM();
    const jobs = [];
    initRender({ reroll: (job) => { jobs.push(job); return Promise.resolve(); } });
    ensureManualButtons();
    buttonsEl.querySelector('[data-uris-manual]').click();
    const descHash = stableHash(`img|${jobs[0].desc}`);
    // Генерация убита перезагрузкой: item pending с мёртвым requestId, грейс истёк.
    upsertItem(0, { idx: -1, type: 'img', descHash, status: 'pending', requestId: 'dead', createdAt: 0 });
    reconcileVisible();
    const shell = textEl.querySelector(`[data-uris-inl="-1|img|${descHash}"]`);
    assert.equal(shell.getAttribute('data-uris-status'), 'error');
    assert.equal(shell.getAttribute('data-manual'), '1', 'ручная оболочка остаётся ручной');
    shutdownRender();
});

// ── Просмотр: клик открывает ВСЕ готовые картинки поста ──
//
// Регрессия: клик отдавал showSingleImage({src, prompt}) без cardId, а
// галерейный тулбар лайтбокса читает id/sourceMsgId — «Перегенерировать»
// падало на msgId=undefined, «Удалить» молча ничего не делало.

test('messageLightboxItems: готовые с файлом, порядок по idx, поля карточки важнее item', () => {
    const items = [
        { idx: 1, type: 'img', descHash: 'b', status: 'ready', imagePath: 'two.png', desc: 'второе', cardId: 'c2' },
        { idx: 0, type: 'img', descHash: 'a', status: 'ready', imagePath: 'one.png', desc: 'первое', cardId: 'c1' },
        { idx: 2, type: 'img', descHash: 'c', status: 'pending', imagePath: null },
        { idx: 3, type: 'img', descHash: 'd', status: 'ready', imagePath: null },
    ];
    const cards = new Map([
        ['c1', { id: 'c1', prompt: 'промпт один', negativePrompt: 'neg', quality: 'hd', sourceMsgId: 7, width: 1024, height: 1792, thumbPath: 't1.webp' }],
    ]);
    const out = messageLightboxItems(items, cards, 0);

    assert.deepEqual(out.map(i => i.imagePath), ['one.png', 'two.png'],
        'только готовые с файлом, отсортированные по idx');
    assert.equal(out[0].src, '/one.png', 'src — корневой путь, как у оболочки');
    assert.equal(out[0].id, 'c1');
    assert.equal(out[0].prompt, 'промпт один', 'промпт карточки важнее описания маркера');
    assert.equal(out[0].negativePrompt, 'neg');
    assert.equal(out[0].quality, 'hd');
    assert.equal(out[0].sourceMsgId, 7, 'sourceMsgId карточки — для regenerate');
    assert.equal(out[0].width, 1024);
    assert.equal(out[0].thumbPath, 't1.webp');
    assert.equal(out[0].__inlineKey, '0|img|a');

    // Карточки нет (удалена из галереи) — слайд остаётся, id null,
    // sourceMsgId падает на само сообщение, промпт — на описание.
    assert.equal(out[1].id, null);
    assert.equal(out[1].prompt, 'второе');
    assert.equal(out[1].sourceMsgId, 0);
});

test('messageLightboxItems: ручные результаты (idx<0) сортируются по createdAt', () => {
    const out = messageLightboxItems([
        { idx: -1, type: 'img', descHash: 'new', status: 'ready', imagePath: 'n.png', createdAt: 200 },
        { idx: -1, type: 'img', descHash: 'old', status: 'ready', imagePath: 'o.png', createdAt: 100 },
    ], null, 4);
    assert.deepEqual(out.map(i => i.imagePath), ['o.png', 'n.png']);
    assert.equal(out[0].sourceMsgId, 4);
});

test('клик по инлайн-картинке открывает все готовые картинки поста с данными карточки', async () => {
    const { textEl } = buildChatDOM();
    upsertItem(0, { ...readyItem('one.png'), cardId: 'c1' });
    // Ручной результат того же сообщения — попадает в тот же просмотр.
    upsertItem(0, { idx: -1, type: 'img', descHash: 'manual', status: 'ready', imagePath: 'two.png', createdAt: 5 });
    reconcileVisible();

    const shell = textEl.querySelector(`[data-uris-inl="0|img|${HASH_A}"]`);
    assert.ok(shell, 'готовая оболочка отрисована');
    const img = shell.querySelector('img');
    assert.ok(img, 'картинка внутри оболочки');

    const calls = [];
    setViewerForTests({ showLightbox: (...args) => { calls.push(args); } });
    setCardLookupForTests(async () => [
        { id: 'c1', prompt: 'кофе на столе', sourceMsgId: 0, width: 512, height: 512, thumbPath: 't.webp' },
    ]);
    img.click();
    await new Promise(resolve => setTimeout(resolve, 0)); // lookup карточек асинхронный

    assert.equal(calls.length, 1, 'showLightbox вызван один раз');
    const [items, index, options] = calls[0];
    assert.deepEqual(items.map(i => i.src), ['/two.png', '/one.png'], 'оба готовых результата поста');
    assert.equal(index, 1, 'открыто именно нажатое изображение');
    assert.equal(items[index].id, 'c1', 'id карточки — без него не работают regen/delete');
    assert.equal(items[index].prompt, 'кофе на столе');
    assert.equal(items[index].width, 512);
    assert.equal(options.chatId, null, 'chatId резолвится из контекста');
});

test('клик: двойной клик не ставит платную задачу (dblclick-реролл убран)', () => {
    const { textEl } = buildChatDOM();
    upsertItem(0, { ...readyItem(), cardId: 'c1' });
    reconcileVisible();
    const jobs = [];
    initRender({ reroll: (job) => { jobs.push(job); return Promise.resolve(); } });
    setViewerForTests({ showLightbox: () => {} });
    setCardLookupForTests(async () => []);
    const shell = textEl.querySelector(`[data-uris-inl="0|img|${HASH_A}"]`);
    const img = shell.querySelector('img');
    // Двойной клик — это click + click + dblclick; ни одна из фаз не должна
    // ставить платную задачу (раньше dblclick шёл в startReroll).
    img.click();
    img.click();
    img.dispatchEvent({ type: 'dblclick' });
    assert.deepEqual(jobs, [], 'двойной клик больше не запускает генерацию');
    shutdownRender();
});
