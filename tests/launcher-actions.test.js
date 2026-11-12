// @ts-check
// Launcher hold-gesture + actions: pure logic under tests/launcher-actions.test.js.
// The DOM glue (bar button / FAB pointer pipeline) is thin wiring around these.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

import { evaluateGesture, resolveLastAiPostId, buildEmbedItem, runLauncherAction, extractAnchorQuote, pickAnchorParagraph } from '../src/ui/launcher-actions.js';
import { stableHash, normalizeAnchorText } from '../src/inline/runner.js';

// ── evaluateGesture: one decision for click vs hold-menu vs drag ──

test('evaluateGesture: quick release without movement is a click', () => {
    assert.equal(evaluateGesture({ heldMs: 100, maxMovePx: 0 }), 'click');
    assert.equal(evaluateGesture({ heldMs: 549, maxMovePx: 3 }), 'click');
});

test('evaluateGesture: hold past the threshold without movement opens the menu', () => {
    assert.equal(evaluateGesture({ heldMs: 550, maxMovePx: 0 }), 'menu');
    assert.equal(evaluateGesture({ heldMs: 1200, maxMovePx: 5 }), 'menu');
});

test('evaluateGesture: movement beyond the drag threshold wins over hold', () => {
    assert.equal(evaluateGesture({ heldMs: 1200, maxMovePx: 7 }), 'drag');
    assert.equal(evaluateGesture({ heldMs: 100, maxMovePx: 30 }), 'drag');
});

// ── resolveLastAiPostId: target for "draw" actions ──

const msg = (mes, extra = {}) => ({ mes, is_user: false, ...extra });

test('resolveLastAiPostId: returns the last eligible AI message id', () => {
    const chat = [msg('old'), { mes: 'user', is_user: true }, msg('mid'), msg('last text')];
    assert.equal(resolveLastAiPostId(chat), 3);
});

test('resolveLastAiPostId: skips user, system, hidden and empty posts', () => {
    const chat = [
        msg('real ai'),
        { mes: 'user line', is_user: true },
        msg('sys', { is_system: true }),
        msg('hidden', { is_hidden: true }),
        msg('   '),
    ];
    assert.equal(resolveLastAiPostId(chat), 0);
});

test('resolveLastAiPostId: null without candidates', () => {
    assert.equal(resolveLastAiPostId([]), null);
    assert.equal(resolveLastAiPostId([{ mes: 'x', is_user: true }]), null);
    assert.equal(resolveLastAiPostId(null), null);
});

// ── buildEmbedItem: pipeline card → inline store item (manual shell) ──

test('buildEmbedItem: manual-ready item shape keyed by desc', () => {
    const desc = 'story text';
    const item = buildEmbedItem({
        card: { id: 'card-1', imagePath: 'user/images/C/uris_1.png' },
        desc,
    });
    assert.equal(item.idx, -1);
    assert.equal(item.type, 'img');
    assert.equal(item.status, 'ready');
    assert.equal(item.imagePath, 'user/images/C/uris_1.png');
    assert.equal(item.cardId, 'card-1');
    assert.equal(item.desc, desc);
    assert.equal(item.descHash, item.descHash);
    assert.match(item.descHash, /^[0-9a-f]+$/);
});

test('buildEmbedItem: same desc → same descHash (shell key stability)', () => {
    const a = buildEmbedItem({ card: { id: 'a', imagePath: '/a.png' }, desc: 'same' });
    const b = buildEmbedItem({ card: { id: 'b', imagePath: '/b.png' }, desc: 'same' });
    assert.equal(a.descHash, b.descHash);
    assert.notEqual(
        buildEmbedItem({ card: { id: 'a', imagePath: '/a.png' }, desc: 'other' }).descHash,
        a.descHash,
    );
});

// ── extractAnchorQuote: Cyrillic quote from the Stage 1 prompt ──

test('extractAnchorQuote: prefers the Subtitle line quote', () => {
    const prompt = 'Capture the moment...\nSubtitle: Clean minimalist typography reading: "Поставь меня на пол" (omit if none)';
    assert.equal(extractAnchorQuote(prompt), 'Поставь меня на пол');
});

test('extractAnchorQuote: falls back to any quoted Cyrillic phrase', () => {
    const prompt = 'She whispers "уходи, Дэм" and steps back into the rain.';
    assert.equal(extractAnchorQuote(prompt), 'уходи, Дэм');
});

test('extractAnchorQuote: ignores English-only quotes and long quotes', () => {
    assert.equal(extractAnchorQuote('"Damien Blackwood" stands tall, "heritage silver" glints.'), null);
    const long = 'word '.repeat(13).trim();
    assert.equal(extractAnchorQuote(`Subtitle: reading: "${long}"`), null);
    assert.equal(extractAnchorQuote('no quotes at all'), null);
});

// ── pickAnchorParagraph: same-language fuzzy paragraph match ──

const POST = [
    'Первый абзац про утро и кофе на кухне.',
    '**22 октября.** Замок входной двери поддался с тихим щелчком. Дамиен толкнул тяжёлое полотно плечом.',
    'Финальный абзац про дождь за окном.',
].join('\n\n');

test('pickAnchorParagraph: matches the middle paragraph ignoring markdown', () => {
    const anchor = pickAnchorParagraph(POST, 'Замок входной двери поддался с тихим щелчком, Дамиен толкнул полотно плечом');
    assert.ok(anchor, 'anchor found');
    assert.equal(anchor.index, 1);
    assert.equal(anchor.anchorHash, stableHash(normalizeAnchorText(POST.split('\n\n')[1])));
});

test('pickAnchorParagraph: ties resolve to the first qualifying paragraph', () => {
    const text = 'Он толкнул дверь плечом.\n\nОн толкнул дверь плечом снова.';
    const anchor = pickAnchorParagraph(text, 'толкнул дверь плечом');
    assert.equal(anchor.index, 0);
});

test('pickAnchorParagraph: below threshold → null (caller appends at end)', () => {
    assert.equal(pickAnchorParagraph(POST, 'совершенно другая тема про космос и звёзды'), null);
    assert.equal(pickAnchorParagraph(POST, null), null);
    assert.equal(pickAnchorParagraph('', 'замок двери'), null);
});

// ── runLauncherAction: dispatch with injected deps ──

test('runLauncherAction: inline-last rerolls the last eligible post', async () => {
    const calls = [];
    await runLauncherAction('inline-last', {
        getChat: () => [msg('first'), msg('target story')],
        rerollInline: job => calls.push(job),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].msgId, 1);
    assert.equal(calls[0].idx, -1);
    assert.equal(calls[0].type, 'img');
    assert.equal(calls[0].desc, 'target story');
});

test('runLauncherAction: story-last runs the full pipeline and embeds the card', async () => {
    const calls = [];
    const card = { id: 'card-9', imagePath: 'user/images/C/x.png' };
    await runLauncherAction('story-last', {
        getChat: () => [msg('story body')],
        getChatId: () => 'chat-1',
        runFullPipeline: input => { calls.push(['pipeline', input]); return card; },
        embedCard: (c, msgId, desc, messageText) => calls.push(['embed', c, msgId, desc, messageText]),
        toast: () => {},
    });
    assert.deepEqual(calls[0], ['pipeline', { chatId: 'chat-1', msgId: 0, messageText: 'story body' }]);
    assert.deepEqual(calls[1], ['embed', card, 0, 'story body', 'story body']);
});

test('runLauncherAction: gallery opens the gallery tab', async () => {
    const calls = [];
    await runLauncherAction('gallery', { openGalleryTab: () => calls.push('gallery') });
    assert.deepEqual(calls, ['gallery']);
});

test('runLauncherAction: unknown action and empty chat fail loudly, not silently', async () => {
    await assert.rejects(() => runLauncherAction('nope', {}));
    await assert.rejects(() => runLauncherAction('inline-last', { getChat: () => [], rerollInline: () => {} }));
    await assert.rejects(() => runLauncherAction('story-last', { getChat: () => [], runFullPipeline: () => ({}) }));
});

// ── attachHold: contextmenu glue (fake-dom) ──

const { attachHold } = await import('../src/ui/launcher-actions.js');

function holdTarget(doc) {
    // Detached node is fine: attachHold only binds listeners.
    return doc.createElement('div');
}

// fake-dom dispatches plain objects; preventDefault is read by the handlers.
const pointerEvent = (type, pointerType) => ({
    type, bubbles: true, cancelable: true, pointerType, button: 0,
    isPrimary: true, clientX: 10, clientY: 10, pointerId: 1,
    preventDefault: () => {}, stopPropagation: () => {},
});
const contextMenuEvent = () => ({
    type: 'contextmenu', bubbles: true, cancelable: true, button: 2,
    preventDefault: () => {}, stopPropagation: () => {},
});

test('attachHold: desktop right-click (contextmenu without touch) opens the menu once', async () => {
    const fake = makeFakeDocument();
    const el = holdTarget(fake.document);
    const calls = { menu: 0, click: 0 };
    attachHold(el, {
        onMenu: () => { calls.menu += 1; },
        onClick: () => { calls.click += 1; },
        holdMs: 50,
    });
    el.dispatchEvent(contextMenuEvent());
    await new Promise(res => setTimeout(res, 80));
    el.dispatchEvent(pointerEvent('pointerup', 'mouse'));
    assert.equal(calls.menu, 1, 'ПКМ открывает меню');
    assert.equal(calls.click, 0, 'после меню тоггл не срабатывает');
});

test('attachHold: touch long-press — contextmenu silenced, hold timer opens the menu once', async () => {
    const fake = makeFakeDocument();
    const el = holdTarget(fake.document);
    const calls = { menu: 0, click: 0 };
    attachHold(el, {
        onMenu: () => { calls.menu += 1; },
        onClick: () => { calls.click += 1; },
        holdMs: 120,
    });
    el.dispatchEvent(pointerEvent('pointerdown', 'touch'));
    await new Promise(res => setTimeout(res, 60));
    // Android synthesizes contextmenu ~500ms, before our hold threshold.
    el.dispatchEvent(contextMenuEvent());
    await new Promise(res => setTimeout(res, 120));
    el.dispatchEvent(pointerEvent('pointerup', 'touch'));
    assert.equal(calls.menu, 1, 'меню открыто ровно один раз (таймером, не contextmenu)');
    assert.equal(calls.click, 0, 'после зажатия тоггла нет');
});

test('attachHold: quick left click after a contextmenu still toggles', async () => {
    const fake = makeFakeDocument();
    const el = holdTarget(fake.document);
    const calls = { menu: 0, click: 0 };
    attachHold(el, {
        onMenu: () => { calls.menu += 1; },
        onClick: () => { calls.click += 1; },
        holdMs: 50,
    });
    el.dispatchEvent(contextMenuEvent());
    await new Promise(res => setTimeout(res, 500)); // menuShown window expired
    el.dispatchEvent(pointerEvent('pointerdown', 'mouse'));
    await new Promise(res => setTimeout(res, 10));
    el.dispatchEvent(pointerEvent('pointerup', 'mouse'));
    assert.equal(calls.click, 1, 'быстрый клик после ПКМ работает');
});
