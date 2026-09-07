# Отмена подавления повторной Stage2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить re-entrancy guard `stage2RunningMsgId` на per-msgId FIFO-цепочку, чтобы каждый ручной клик генерации сохранял отдельную картинку, а авто-flow оставался параллельным.

**Architecture:** Ручные вызовы `runStage2` сериализуются через `Map<msgId, Promise>` в `state.stage2Chains`; авто-flow обходит цепочку через `opts.isAuto`. Кнопка регенерации в галерее блокируется на время одного вызова.

**Tech Stack:** SillyTavern extension, vanilla ES modules, JSDoc, `node:test` for tests.

**Spec:** `docs/superpowers/specs/2026-07-14-no-duplicate-suppression-stage2-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/core.js` | State: remove `stage2RunningMsgId`, add `stage2Chains: Map<msgId, Promise>` |
| `src/pipeline.js` | `runStage2`: FIFO serialization, `opts.isAuto` bypass, safe Map cleanup |
| `index.js` | Auto-flow passes `{ isAuto: true }` to `runStage2` |
| `src/ui/tab-gallery.js` | Regen button busy mask (`disabled` around `runStage2`) |
| `tests/pipeline-stage2-serialization.test.js` | Unit tests for FIFO, auto bypass, cleanup, abort isolation |

---

## Task 1: Update `src/core.js` state

**Files:**
- Modify: `src/core.js:54-59`

- [ ] **Step 1: Replace `stage2RunningMsgId` with `stage2Chains`**

Find the block:

```js
    abortController: null,     // текущая стадия генерации (отмена)
    // Re-entrancy guard для Stage2: msgId, для которого Stage2 уже выполняется,
    // или null. Защищает от параллельных дублей (авто-Stage1 + ручная регенерация
    // того же поста, дублирующие события) — каждый из путей раньше independently
    // звал runStage2, отправляя второй запрос к платному апстриму.
    stage2RunningMsgId: null,
```

Replace with:

```js
    abortController: null,     // текущая стадия генерации (отмена)
    // Per-msgId FIFO-цепочка мануальных Stage2 (Promise-chain). Каждый ручной
    // клик (tab-generate #urisGenImg, gallery [data-act="regen"]) становится
    // в очередь для конкретного поста и выполняется строго один за другим,
    // сохраняя отдельную картинку на каждый клик (=> 100 кликов = 100 картинок,
    // даже при абсолютно одинаковых вводных). Upstream-запросы не дублируются
    // в один момент (последовательная цепочка). Авто-flow (auto-after Stage2)
    // обходит цепочку через opts.isAuto и идёт параллельно — оба результата
    // сохраняются. Map.update/remove управляется в pipeline.runStage2.
    stage2Chains: new Map(),
```

- [ ] **Step 2: Verify no remaining `stage2RunningMsgId` references**

Run:
```bash
grep -n "stage2RunningMsgId" src/core.js
```
Expected: no output.

---

## Task 2: Update `src/pipeline.js` `runStage2`

**Files:**
- Modify: `src/pipeline.js:160-281`

- [ ] **Step 1: Update JSDoc for `runStage2` signature**

Replace the existing JSDoc block (lines 160-171):

```js
/**
 * @param {number|string} msgId
 * @param {object} instruction
 * @param {(status: string) => void} [onStatus]
 * @param {AbortSignal} [signal]
 * @param {object} [opts]
 * @param {import('./references-profiles.js').RefsOverride} [opts.override] - per-gen override активного профиля.
 * @param {Array<{image:string,role:string,name?:string}>} [opts.refs] - готовый массив референсов (обходит collect; для регена «те же референсы»).
 * @param {(refs: Array<{image:string,role:string,name?:string}>) => void} [opts.onRefsSent] - callback после сбора референсов (для UI-превью).
 * @returns {Promise<object|null>}
 * @throws {Error}
 * @throws {DOMException}
 */
```

with:

```js
/**
 * @param {number|string} msgId
 * @param {object} instruction
 * @param {(status: string) => void} [onStatus]
 * @param {AbortSignal} [signal]
 * @param {object} [opts]
 * @param {import('./references-profiles.js').RefsOverride} [opts.override] - per-gen override активного профиля.
 * @param {Array<{image:string,role:string,name?:string}>} [opts.refs] - готовый массив референсов (обходит collect; для регена «те же референсы»).
 * @param {(refs: Array<{image:string,role:string,name?:string}>) => void} [opts.onRefsSent] - callback после сбора референсов (для UI-превью).
 * @param {boolean} [opts.isAuto] - true для авто-flow (auto-after Stage2):
 *        обходит per-msgId FIFO-цепочку и идёт параллельно мануальным кликам
 *        (оба результата сохраняются). По умолчанию (manual) — сериализуется.
 * @returns {Promise<object|null>}
 * @throws {Error}
 * @throws {DOMException}
 */
```

- [ ] **Step 2: Replace guard block with FIFO serialization**

Find the function start (after JSDoc):

```js
export async function runStage2(msgId, instruction, onStatus, signal, opts = {}) {
    // Re-entrancy guard: не запускаем второй Stage2 для того же поста, пока
    // первый ещё выполняется. Раньше авто-Stage1 + ручной запуск/регенерация
    // для того же msgId независимо звали runStage2 -> два апстрим-запроса
    // (двойная трата квоты, дубли в галерее). Блокировка точечная по msgId -
    // разные посты можно генерировать параллельно (будущее/очередь).
    if (state.stage2RunningMsgId === msgId && msgId != null) {
        log('Stage2: уже выполняется для поста', msgId, '- пропуск дубля');
        return null;
    }
    const ctx = getCtx();
    const ownController = !signal ? new AbortController() : null;
    if (ownController) state.abortController = ownController;
    const useSignal = signal || ownController.signal;
    state.stage2RunningMsgId = msgId;

    try {
```

Replace with:

```js
export async function runStage2(msgId, instruction, onStatus, signal, opts = {}) {
    // Per-msgId FIFO-сериализация мануальных Stage2. 100 кликов по тому же
    // посту → 100 серийных upstream-запросов → 100 отдельных картинок в галерее.
    // Upstream-запросы не дублируются в один момент (строго последовательная
    // цепочка). Авто-flow (opts.isAuto) идёт мимо цепочки, параллельно — оба
    // результата сохраняются (см. решение с пользователем 2026-07-14).
    let releaseNext = null;
    let prevPromise = Promise.resolve();
    let myNext = null;
    let isChained = false;
    if (!opts.isAuto && msgId != null) {
        const chain = state.stage2Chains.get(msgId) || Promise.resolve();
        prevPromise = chain;
        myNext = new Promise(r => { releaseNext = r; });
        state.stage2Chains.set(msgId, myNext);
        isChained = true;
    }

    const ctx = getCtx();
    let ownController = null;
    let useSignal = signal;

    try {
        // Ждём своей очереди для мануальных кликов. Авто-flow пропускает это.
        if (isChained) {
            await prevPromise.catch(() => {});
        }

        // AbortController создаём только когда вызов реально начинает работу,
        // чтобы state.abortController указывал на активную генерацию, а не на
        // queued-вызов, ожидающий в цепочке.
        ownController = !signal ? new AbortController() : null;
        if (ownController) state.abortController = ownController;
        useSignal = signal || ownController.signal;
```

- [ ] **Step 3: Update `finally` block for cleanup**

Find:

```js
    } finally {
        if (ownController) state.abortController = null;
        state.stage2RunningMsgId = null;
    }
}
```

Replace with:

```js
    } finally {
        if (ownController) state.abortController = null;
        // Освобождаем next-промис для следующего в очереди на этом msgId.
        if (releaseNext) {
            releaseNext();
            // Если наша цепочка всё ещё последняя в Map (т.е. нас никто не
            // сменил), чистим entry чтобы Map не рос бесконечно на разных постах.
            if (myNext && state.stage2Chains.get(msgId) === myNext) {
                state.stage2Chains.delete(msgId);
            }
        }
    }
}
```

- [ ] **Step 4: Verify no old guard strings remain**

Run:
```bash
grep -n "stage2RunningMsgId\|пропуск дубля" src/pipeline.js
```
Expected: no output.

---

## Task 3: Update `index.js` auto-flow

**Files:**
- Modify: `index.js:130-138`

- [ ] **Step 1: Pass `{ isAuto: true }` in `onStage1Ready`**

Find:

```js
        onStage1Ready: async (instr) => {
            if (state.settings.stage2Mode === 'auto-after') {
                try {
                    await runStage2(state.currentMsgId, instr, s => setStatus(s));
                    setStatus('');
                    toastr?.success('Картинка сгенерирована');
                    if (isPanelVisible() && getActiveTab() === 'gallery') refreshActive();
                } catch (e) { setStatus(''); error('Auto Stage2:', e.message); toastr?.error('Stage2: ' + e.message); }
            }
        },
```

Replace with:

```js
        onStage1Ready: async (instr) => {
            if (state.settings.stage2Mode === 'auto-after') {
                try {
                    // opts.isAuto: обходим per-msgId FIFO-цепочку ручных кликов,
                    // авто-flow идёт параллельно регенерации; оба результата
                    // сохраняются отдельными картинками в галерее.
                    await runStage2(state.currentMsgId, instr, s => setStatus(s),
                        undefined, { isAuto: true });
                    setStatus('');
                    toastr?.success('Картинка сгенерирована');
                    if (isPanelVisible() && getActiveTab() === 'gallery') refreshActive();
                } catch (e) { setStatus(''); error('Auto Stage2:', e.message); toastr?.error('Stage2: ' + e.message); }
            }
        },
```

---

## Task 4: Update `src/ui/tab-gallery.js` regen handler

**Files:**
- Modify: `src/ui/tab-gallery.js:104-143`

- [ ] **Step 1: Add busy mask around `runStage2` call**

Find the regen click handler (lines 104-143):

```js
        cardEl.querySelector('[data-act="regen"]')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            const it = items.find(x => x.id === id);
            // Phase 1: если у записи есть снапшот референсов (it.refs), спросим
            // пользователя - регенерировать с теми же референсами или с текущим
            // активным профилем. Старые записи без it.refs регенерируются как и
            // раньше - через активный профиль.
            const snapshot = Array.isArray(it.refs) ? it.refs : null;
            let useSameRefs = false;
            if (snapshot && snapshot.length) {
                const names = snapshot.map(r => r.role === 'char' ? '{{char}}' : (r.role === 'user' ? '{{user}}' : (r.name || 'npc'))).join(', ');
                useSameRefs = await showConfirmModal(
                    `Регенерировать с теми же референсами (${snapshot.length}: ${names})?\n\n` +
                    `«OK» - те же референсы (снапшот на момент первичной генерации).\n` +
                    `«Отмена» - использовать текущий активный профиль (мог измениться).`
                );
            }
            try {
                setStatus('Перегенерация...');
                const instr = { style: it.style, prompt: it.prompt, aspectRatio: it.aspectRatio, imageSize: it.imageSize };
                let opts = {};
                if (useSameRefs && snapshot) {
                    // «Те же референсы»: пересобрать dataUrl-ы из снапшота.
                    // Для npc - fetch по imagePath (если есть в активном профиле по npcId),
                    // для char - getCharacterAvatarDataUrl (текущего ST-чара - caveat: аватар
                    // мог измениться, см. план §Риски), для user - getUserAvatarDataUrl.
                    const refs = await rebuildRefsFromSnapshot(snapshot);
                    opts = { refs };
                    // toast-предупреждение: refs profile sig мог разойтись.
                    const curSig = refs.map(r => r.role).sort().join(',');
                    if (it.refsSig && it.refsSig !== curSig) {
                        toastr?.info('Состав референсов отличается от первичной генерации (профиль/аватар изменился)');
                    }
                }
                await runStage2(it.sourceMsgId, instr, s => setStatus(s), undefined, opts);
                toastr?.success('Перегенерировано');
                render(root);
            } catch (err) { toastr?.error('Перегенерация: ' + err.message); }
            finally { setStatus(''); }
        });
```

Replace with:

```js
        cardEl.querySelector('[data-act="regen"]')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            const regenBtn = cardEl.querySelector('[data-act="regen"]');
            if (regenBtn?.disabled) return;
            const it = items.find(x => x.id === id);
            // Phase 1: если у записи есть снапшот референсов (it.refs), спросим
            // пользователя - регенерировать с теми же референсами или с текущим
            // активным профилем. Старые записи без it.refs регенерируются как и
            // раньше - через активный профиль.
            const snapshot = Array.isArray(it.refs) ? it.refs : null;
            let useSameRefs = false;
            if (snapshot && snapshot.length) {
                const names = snapshot.map(r => r.role === 'char' ? '{{char}}' : (r.role === 'user' ? '{{user}}' : (r.name || 'npc'))).join(', ');
                useSameRefs = await showConfirmModal(
                    `Регенерировать с теми же референсами (${snapshot.length}: ${names})?\n\n` +
                    `«OK» - те же референсы (снапшот на момент первичной генерации).\n` +
                    `«Отмена» - использовать текущий активный профиль (мог измениться).`
                );
            }
            try {
                if (regenBtn) regenBtn.disabled = true;
                setStatus('Перегенерация...');
                const instr = { style: it.style, prompt: it.prompt, aspectRatio: it.aspectRatio, imageSize: it.imageSize };
                let opts = {};
                if (useSameRefs && snapshot) {
                    // «Те же референсы»: пересобрать dataUrl-ы из снапшота.
                    // Для npc - fetch по imagePath (если есть в активном профиле по npcId),
                    // для char - getCharacterAvatarDataUrl (текущего ST-чара - caveat: аватар
                    // мог измениться, см. план §Риски), для user - getUserAvatarDataUrl.
                    const refs = await rebuildRefsFromSnapshot(snapshot);
                    opts = { refs };
                    // toast-предупреждение: refs profile sig мог разойтись.
                    const curSig = refs.map(r => r.role).sort().join(',');
                    if (it.refsSig && it.refsSig !== curSig) {
                        toastr?.info('Состав референсов отличается от первичной генерации (профиль/аватар изменился)');
                    }
                }
                // opts здесь НЕ содержит isAuto — сериализуется per-msgId через
                // state.stage2Chains. 100 быстрых кликов регенерации на той же карте
                // → 100 серийных upstream-запросов → 100 отдельных картинок.
                await runStage2(it.sourceMsgId, instr, s => setStatus(s), undefined, opts);
                toastr?.success('Перегенерировано');
                render(root);
            } catch (err) { toastr?.error('Перегенерация: ' + err.message); }
            finally {
                setStatus('');
                if (regenBtn) regenBtn.disabled = false;
            }
        });
```

---

## Task 5: Add tests

**Files:**
- Create: `tests/pipeline-stage2-serialization.test.js`

- [ ] **Step 1: Create test file**

```js
// @ts-check
// Тесты сериализации Stage2: per-msgId FIFO, auto-bypass, cleanup, abort isolation.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function makeInMemoryLFA() {
    const store = new Map();
    return {
        getItem: async (k) => (store.has(k) ? store.get(k) : null),
        setItem: async (k, v) => { store.set(k, v); },
        removeItem: async (k) => { store.delete(k); },
        _store: store,
        _clear() { store.clear(); },
    };
}

let lfMock;

function installGlobals() {
    lfMock = makeInMemoryLFA();
    globalThis.SillyTavern = {
        libs: { localforage: lfMock },
        getContext: () => ({
            extensionSettings: {},
            saveSettingsDebounced: () => {},
            getRequestHeaders: () => ({}),
            chat: [],
            chatId: 'test-chat',
        }),
    };
    globalThis.window = { location: { origin: 'http://localhost:8000' } };
    globalThis.toastr = undefined;
    globalThis.URL = { createObjectURL: () => '', revokeObjectURL: () => {} };
    globalThis.document = { addEventListener: () => {} };
}

let coreState;

async function setupConnection() {
    const connId = 'test-conn';
    await lfMock.setItem('uris_connections', [{
        id: connId,
        name: 'Test Pollinations',
        apiType: 'pollinations',
        endpoint: 'https://image.pollinations.ai',
        model: 'flux',
    }]);
    await lfMock.setItem('uris_conn_key_' + connId, '');
    coreState.activeImageProfileId = connId;
}

function makeFetch(delayMs = 10) {
    return async (url, options) => {
        await new Promise(r => setTimeout(r, delayMs));
        const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        return {
            ok: true,
            status: 200,
            headers: new Map(),
            text: async () => '',
            arrayBuffer: async () => bytes.buffer,
        };
    };
}

beforeEach(async () => {
    installGlobals();
    const core = await import('../src/core.js');
    coreState = core.state;
    core.loadSettings();
    await setupConnection();
});

test('manual calls for same msgId are serialized', async () => {
    const { runStage2 } = await import('../src/pipeline.js');
    globalThis.fetch = makeFetch(20);
    const starts = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        starts.push(Date.now());
        return origFetch(url, options);
    };

    const instr = { prompt: 'a cat', style: 'anime', aspectRatio: '1:1', imageSize: '1K' };
    const p1 = runStage2(1, instr);
    const p2 = runStage2(1, instr);
    const p3 = runStage2(1, instr);

    await Promise.all([p1, p2, p3]);

    assert.equal(starts.length, 3, 'должно быть 3 upstream-вызова');
    assert.ok(starts[1] - starts[0] >= 15, 'второй вызов должен начаться после первого');
    assert.ok(starts[2] - starts[1] >= 15, 'третий вызов должен начаться после второго');
});

test('isAuto bypasses the manual chain', async () => {
    const { runStage2 } = await import('../src/pipeline.js');
    globalThis.fetch = makeFetch(30);
    const starts = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        starts.push(Date.now());
        return origFetch(url, options);
    };

    const instr = { prompt: 'a cat', style: 'anime', aspectRatio: '1:1', imageSize: '1K' };
    const manual = runStage2(2, instr);
    const auto = runStage2(2, instr, undefined, undefined, { isAuto: true });

    await Promise.all([manual, auto]);

    assert.equal(starts.length, 2, 'должно быть 2 upstream-вызова');
    assert.ok(starts[1] - starts[0] < 25, 'auto-вызов не должен ждать окончания manual');
});

test('stage2Chains entry is cleaned up after all calls resolve', async () => {
    const { runStage2 } = await import('../src/pipeline.js');
    globalThis.fetch = makeFetch(5);

    const instr = { prompt: 'a cat', style: 'anime', aspectRatio: '1:1', imageSize: '1K' };
    await Promise.all([
        runStage2(3, instr),
        runStage2(3, instr),
        runStage2(3, instr),
    ]);

    assert.ok(!coreState.stage2Chains.has(3), 'цепочка для msgId должна быть удалена');
});

test('abort of first manual call does not cancel second in queue', async () => {
    const { runStage2 } = await import('../src/pipeline.js');
    const starts = [];
    globalThis.fetch = async (url, options) => {
        starts.push(Date.now());
        if (starts.length === 1) {
            // Abort the first call after it starts.
            options.signal?.dispatchEvent(new Event('abort'));
            await new Promise((_, reject) => {
                options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            });
        }
        const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        return { ok: true, status: 200, headers: new Map(), text: async () => '', arrayBuffer: async () => bytes.buffer };
    };

    const instr = { prompt: 'a cat', style: 'anime', aspectRatio: '1:1', imageSize: '1K' };
    const ac = new AbortController();
    const p1 = runStage2(4, instr, undefined, ac.signal);
    const p2 = runStage2(4, instr);

    // Abort the first call shortly after.
    setTimeout(() => ac.abort(), 5);

    await p2;
    assert.equal(starts.length, 2, 'второй вызов должен выполниться несмотря на abort первого');
});

test('old guard string is gone', async () => {
    const fs = await import('node:fs');
    const content = fs.readFileSync(new URL('../src/pipeline.js', import.meta.url), 'utf8');
    assert.ok(!content.includes('stage2RunningMsgId'), 'не должно остаться stage2RunningMsgId');
    assert.ok(!content.includes('пропуск дубля'), 'не должно остаться пропуск дубля');
});
```

- [ ] **Step 2: Run the new tests and expect them to fail before implementation**

Run:
```bash
node --test tests/pipeline-stage2-serialization.test.js
```

Expected: tests fail because `stage2Chains` doesn't exist yet and guard still skips duplicates.

---

## Task 6: Run full test suite and verify

- [ ] **Step 1: Run all tests**

```bash
node --test tests/*.test.js
```

Expected: all tests pass.

- [ ] **Step 2: Run verification grep commands**

```bash
grep -rn "stage2RunningMsgId\|пропуск дубля" src/ index.js
```
Expected: no output.

```bash
grep -rn "stage2Chains" src/core.js src/pipeline.js
```
Expected: matches in both files.

```bash
grep -rn "isAuto: true" index.js
```
Expected: one match.

---

## Plan Self-Review

- **Spec coverage**: every acceptance criterion in the spec maps to a task or test.
- **Placeholder scan**: no TBD/TODO/fill-in; all code blocks are complete.
- **Type consistency**: `opts.isAuto` is documented in JSDoc and used consistently in `runStage2`, `index.js`, and tests.
