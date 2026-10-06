// @ts-check
// UI tests for the Generate-tab cancel button. The old inline queue status line
// (#urisQueueStatus: «В очереди: N» + «Остановить»/«Пропустить») is gone —
// queue-wide status and controls live in the floating window's QUEUE badge
// panel (see window.js renderQueuePanel + queue-log.js hasLiveQueueLane, pinned
// in queue-log.test.js). What stays on the tab is the per-post cancel button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';
import { makeUserFileServer } from './_helpers.js';

// Файловая дверь: сторы данных должны резолвиться мгновенно и без сети.
// Без неё ready() ходит в реальный сервер (если запущен) или ждёт вечно.
const fileServer = makeUserFileServer({
    fallback(url, options) {
        return globalThis.__realFetch ? globalThis.__realFetch(url, options) : { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    },
});
globalThis.fetch = fileServer.fetch;


const { document } = makeFakeDocument();
globalThis.document = document;
globalThis.window = { location: { origin: 'http://localhost:8000' }, dispatchEvent: () => {} };
globalThis.SillyTavern = {
    getContext: () => ({ extensionSettings: {}, saveSettingsDebounced: () => {}, getRequestHeaders: () => ({}) }),
    libs: { localforage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } },
};
globalThis.toastr = undefined;

const { setCancelState } = await import('../src/ui/tab-generate.js');

test('setCancelState shows the cancel button with the requestId while running', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button id="urisCancelImage" hidden data-request-id=""></button>';
    setCancelState(root, 'req-abc', true);
    const btn = root.querySelector('#urisCancelImage');
    assert.equal(btn.hidden, false, 'button is shown');
    assert.equal(btn.getAttribute('data-request-id'), 'req-abc');
});

test('setCancelState hides the cancel button when not running', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button id="urisCancelImage" data-request-id="req-abc"></button>';
    setCancelState(root, null, false);
    const btn = root.querySelector('#urisCancelImage');
    assert.equal(btn.hidden, true);
});

test('setCancelState is a no-op when the cancel button is absent', () => {
    const root = document.createElement('div');
    assert.doesNotThrow(() => setCancelState(root, 'req-x', true));
});

// Пин слияния: у вкладки «Генерация» больше нет своей статус-строки очереди —
// единственное место очереди в UI это бейдж QUEUE окна.
test('the Generate tab no longer renders a queue status line', async () => {
    const core = await import('../src/core.js');
    const { render } = await import('../src/ui/tab-generate.js');
    const { document: fakeDoc, root } = makeFakeDocument();
    globalThis.document = fakeDoc;
    core.loadSettings();
    // Без тега таба render() отсекается epoch-гвардом и ничего не рендерит.
    root.__urisTabId = 'generate';
    core.state.currentMsgId = 0;
    globalThis.toastr = undefined;
    try {
        await render(root);
        assert.equal(root.querySelector('#urisQueueStatus'), null, 'статус-строка очереди удалена из разметки');
    } finally {
        core.state.currentMsgId = null;
    }
});

// Кнопка «Сгенерировать» оживает по вводу без ре-рендера вкладки: render
// ставит disabled по черновику на момент рендера, набранный текст должен
// включать кнопку сразу.
test('syncGenerateEnabled: пустой промпт — disabled, непустой — enabled', async () => {
    const { syncGenerateEnabled } = await import('../src/ui/tab-generate.js');
    const root = document.createElement('div');
    root.innerHTML = '<textarea id="urisPrompt"></textarea><button id="urisGenerateImage" disabled type="button"></button>';
    syncGenerateEnabled(root);
    assert.equal(root.querySelector('#urisGenerateImage').disabled, true, 'пусто — disabled');
    root.querySelector('#urisPrompt').value = '  cat  ';
    syncGenerateEnabled(root);
    assert.equal(root.querySelector('#urisGenerateImage').disabled, false, 'текст — enabled');
    root.querySelector('#urisPrompt').value = '   ';
    syncGenerateEnabled(root);
    assert.equal(root.querySelector('#urisGenerateImage').disabled, true, 'пробелы — disabled');
});

test('syncGenerateEnabled безопасен без кнопки или промпта', async () => {
    const { syncGenerateEnabled } = await import('../src/ui/tab-generate.js');
    const root = document.createElement('div');
    assert.doesNotThrow(() => syncGenerateEnabled(root));
    assert.doesNotThrow(() => syncGenerateEnabled(null));
});
