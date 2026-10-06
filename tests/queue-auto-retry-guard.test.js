// @ts-check
// Регрессия 2026-10-06 (пункт 3.2, вторая половина): авто-повтор IMAGE_DELIVERY_AMBIGUOUS
// ставил retry в очередь без проверки дубликата. Если пользователь успел вручную
// поставить ту же генерацию, пока неудачная исполнялась, авто-повтор стал бы второй
// платной попыткой. Guard: canAutoRetry смотрит только state.queue (runningQueueItem
// в момент проверки — сам упавший item с тем же отпечатком, false positive).
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

function mkItem(prompt, extra = {}) {
    return {
        chatId: 'c1',
        msgId: 0,
        chatConfig: { imageProfileId: 'conn', imageRoute: { modelId: 'model-a' } },
        submission: { prompt, aspectRatio: '1:1', imageSize: '1K', quality: 'standard' },
        ...extra,
    };
}

let coreState;
let pq;

beforeEach(async () => {
    installStGlobals();
    globalThis.SillyTavern.libs.localforage = makeInMemoryLFA();
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings: { ur_image_studio: {} },
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
        chatMetadata: {},
        chat: [],
        chatId: 'c1',
    });
    const core = await import('../src/core.js');
    coreState = core.state;
    coreState.queue = [];
    pq = await import('../src/pipeline-queue.js');
});

test('canAutoRetry: пустая очередь — повтор разрешён', () => {
    assert.equal(pq.canAutoRetry(mkItem('A cat.')), true);
});

test('canAutoRetry: та же генерация уже в очереди — повтор запрещён', () => {
    coreState.queue = [{ queueId: 'q1', item: mkItem('A cat.') }];
    assert.equal(pq.canAutoRetry(mkItem('A cat.')), false);
});

test('canAutoRetry: чужой промпт в очереди — повтор разрешён', () => {
    coreState.queue = [{ queueId: 'q1', item: mkItem('A dog.') }];
    assert.equal(pq.canAutoRetry(mkItem('A cat.')), true);
});

test('canAutoRetry: другая модель/стороны — повтор разрешён', () => {
    const other = mkItem('A cat.', {
        chatConfig: { imageProfileId: 'conn', imageRoute: { modelId: 'model-b' } },
    });
    coreState.queue = [{ queueId: 'q1', item: other }];
    assert.equal(pq.canAutoRetry(mkItem('A cat.')), true);
});

test('canAutoRetry: маркер retriedAmbiguous не влияет на отпечаток', () => {
    const marked = mkItem('A cat.', { retriedAmbiguous: true });
    coreState.queue = [{ queueId: 'q1', item: marked }];
    assert.equal(pq.canAutoRetry(mkItem('A cat.')), false);
});
