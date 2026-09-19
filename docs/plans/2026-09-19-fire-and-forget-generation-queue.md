# Fire-and-forget генерация: submit-time снапшот + серийная очередь + живой редактор

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сценарий «построил промпт → Сгенерировать → тут же перестроил → снова Сгенерировать → …» без ожидания разблокировки экрана и без падения идущей генерации от перестройки промпта.

**Architecture:** Ручной «Сгенерировать» перестаёт звать `runStage2ForDraft` напрямую из обработчика и идёт через серийную очередь `pipeline-queue` с **submit-time снапшотом** (`item.submission`: промпт/параметры/коррекции референсов на момент клика). Stage 2 получает новый режим `opts.submission`: снапшот авторитетен над драфтом, не пишется в драфт и не проходит post-materialize revision re-check — гонка «промпт перестроен во время подготовки» исчезает по построению. UI-блокировка редактора по `isRunning` при рендере снимается; редактор живёт всю генерацию.

**Tech Stack:** SillyTavern-расширение (ES-модули, без сборки), localforage через `SillyTavern.libs`, node:test. Новых API SillyTavern не появляется: план не выходит за контракт, зафиксированный в `docs/deep-dive-stage2-dispatch.md` §3 (`GENERATION_STOPPED` → `abortAllGenerations()` + `stopQueue()`, проверено по исходнику ST `public/script.js:5607/5618`).

---

## 0. Контекст: какие ограничения нужны, какие смягчаем

### Оставляем как есть (нужны)

| Ограничение | Почему нужно |
|---|---|
| `withBusy` на «Построить промпт» | Текстовый LLM-вызов; дубль-клик = мусорный платный запрос. Кнопка занята секунды, флоу «посмотрел промпт → отправил» этого не ломает. |
| Гарды Stage 1: `runToken` + `promptRevision` ([generation-drafts.js:283-321](../src/generation-drafts.js)) | Защищают ручные правки промпта от затирания результатом более старого Stage 1 и от «суперсекции» дублей. |
| Серийность платных POST | Очередь — один платный POST за раз; per-post chain (`stage2Chains`) остаётся страховкой. Та же дисциплина, что у автолейна (`src/autolane.js`: «один платный POST автоматики за раз»). Терпимая цена: ручные генерации разных постов больше не идут параллельно. |
| Контракт отклонения устаревшего состояния до платного запроса | Требование `docs/plans/deferred-queue-and-chat-insertion.md`: item несёт chatId/msgId/хэш сообщения/снапшот роута; stale chat / изменённый исходник → reject ДО POST. Распространяется и на item'ы со снапшотом — НЕ смягчать. |
| Каскады отмены | `stopQueue` / `abortAllGenerations` / per-request cancel — не трогаем. |
| Abort-механика Stage 2 (регистрация контроллера до ожидания chain, P1-2) | Уже исправлено, покрыто тестами — не трогаем. |

### Смягчаем / убираем

| Ограничение | Что меняем |
|---|---|
| Рендер глушит редактор и обе кнопки по `draft.stage1/2.status === 'running'` (липкий лок: после завершения генерации таб никто не перерендеривает) | Полностью снимаем: `isRunning` остаётся только для видимости кнопки «Остановить». Редактор, expand, «Построить промпт», «Сгенерировать» — всегда живые (кроме `!canGenerateImage`). |
| `withBusy` на «Сгенерировать» держит кнопку до конца генерации | `withBusy` остаётся только на быстрых снапшот+enqueue (анти-даблклик); ожидание генерации из обработчика убираем. |
| Гонка ревизий в Stage 2: правка промпта во время материализации референсов роняет прогон «Generation inputs changed» | Для прогонов со снапшотом (`opts.submission`) ревизии не перечитываются вовсе: снапшот и есть интент сабмита. Гард остаётся только для reading-прогонов (auto-flow, legacy) — у них окно миллисекунды и нет сабмита. |
| Элемент очереди читает драфт в момент исполнения (для «промпт → задача N, перестроил → задача N+1» это генерирует последний промпт дважды) | Item несёт снапшот промпта, поставленный в момент клика. |
| Мёртвый код: `enqueueCurrent` (нет ни одного вызова из UI), `executeGenerationAction` (test-only, шифрует старую семантику блокировки) | Удаляем: `submitCurrentGeneration` заменяет первое; второе кодирует поведение, которое отменяем. |

### Затрагиваемые цепочки (проверено)

- **Auto-flow** (`index.js:168-195` → `runFullPipelineForDraft`, `isAuto`) — не трогаем: остаётся на reading-пути с revision-гардом.
- **Галерейная регенерация** (`gallery-actions.js:155-229` → `runStage2` позиционный, `opts.instruction`) — не трогаем. Семантический сосед `opts.submission`: instruction по-прежнему пишет промпт в драфт, submission — нет.
- **Автолейн + мост + inline** — отдельные лейны по дизайну (`src/autolane.js`), не трогаем.
- **Пульс лаунчеров** (`floating-launcher.js:203` слушает `uris:stage2-start/end`) — работает: каждый item очереди эмитит события.
- **`sweepStaleRunningDrafts`** — работает: записи `stage2.status` в драфт сохраняются.
- **Строка статуса очереди** (`updateQueueStatus`) — уже умеет «В очереди: N» + «Остановить» + «Пропустить» и активируется этим планом.
- **`stage2Chains`** — остаётся: через очередь items проходят транзитом (очередь серийна), для галерейной регенерации — рабочая сериализация.

### Не-цели (осознанно вне плана)

- §6 из `docs/deep-dive-stage2-dispatch.md` (перетирание промпта при правке **исходного сообщения** во время генерации) — существующий дефект, план его не ухудшает и не чинит.
- «Stop не должен отвергать items, добавленные после стопа» — уже соблюдается: после `stopQueue` новая постановка стартует свежий `processQueue`.
- Глобальная унификация лейнов (manual+auto+bridge в один) — отдельная архитектурная задача.

## 1. Структура изменений

- `src/pipeline-stage2.js` — режим `opts.submission` (одна функция, 6 правок).
- `src/pipeline-queue.js` — item.submission (валидация, копия, заморозка) + передача в Stage 2.
- `src/ui/tab-generate.js` — `prepareSubmissionInput`, `submitCurrentGeneration` (fire-and-forget), снятие `isRunning`-лока, удаление мёртвого кода.
- `tests/pipeline-stage2-submission.test.js`, `tests/pipeline-queue-submission.test.js` — новые.
- `tests/tab-generate.test.js` — новые/заменённые тесты, удаление тестов мёртвого кода.
- Доки: `docs/CHANGELOG.md`, `docs/deep-dive-stage2-dispatch.md`, `docs/deep-dive-generate-tab-render.md`, `USER_GUIDE.md`, `package.json` (0.9.0).

В рабочем дереве есть незакоммиченные правки из другой работы — каждый шаг коммитит **только файлы своей задачи** (явный `git add <файлы>`).

---

## Task 1: `opts.submission` в `runStage2ForDraft`

**Files:**
- Modify: `src/pipeline-stage2.js`
- Test: `tests/pipeline-stage2-submission.test.js` (новый)

- [ ] **Step 1.1: Написать падающий тест**

Создать `tests/pipeline-stage2-submission.test.js` (харнес скопирован с `tests/pipeline-stage2-serialization.test.js`):

```js
// @ts-check
// Stage 2 submit-time snapshots (opts.submission): ручной fire-and-forget
// отправляет промпт/параметры, зафиксированные в момент сабмита. Более новый
// драфт (перестроенный промпт) не протекает в платный запрос, не затирается
// прогоном и не роняет его через revision re-check.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, installStGlobals } from './_helpers.js';

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

const connId = 'submission-conn';
const route = {
    source: 'openai-models',
    modelId: 'gpt-image-1',
    generationContract: 'openai-images',
    contractVersion: 1,
    capabilities: { generate: 'supported', references: 'supported', edit: 'unknown', maxReferences: 5 },
    transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
};

beforeEach(async () => {
    lfMock = makeInMemoryLFA();
    installStGlobals();
    globalThis.SillyTavern.libs.localforage = lfMock;
    extensionSettings = { ur_image_studio: { imageConnections: { schemaVersion: 1, connections: [], catalogs: {}, galleryIndex: [], templates: [], presets: [], refs: [], folders: [], selectedRouteId: null } } };
    globalThis.SillyTavern.getContext = () => ({
        extensionSettings,
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
        chat: [],
        chatId: 'test-chat',
    });
    globalThis.window.dispatchEvent = () => {};
    globalThis.CustomEvent ||= class CustomEvent extends Event {
        constructor(type, init) {
            super(type, init);
            this.detail = init?.detail;
        }
    };

    const core = await import('../src/core.js');
    coreState = core.state;
    core.loadSettings();
    const { createConnection } = await import('../src/connection-store.js');
    await createConnection({ id: connId, kind: 'image', name: `Test ${connId}`, endpoint: 'https://api.openai.test/v1', selectedRoute: route });
    await lfMock.setItem(`uris_api_key:${connId}`, 'test-key');

    const proxy = await import('../src/proxy.js');
    proxy._resetCache();
    proxy.clearHostStrategy();
    coreState.queue = [];
    coreState.queueRunning = false;
    coreState.queueAbort = null;
    coreState.stage2Chains = new Map();
});

test('submission prompt wins over a newer draft prompt; the draft is never rewritten', async () => {
    const { updateGenerationDraft, getGenerationDraft } = await import('../src/generation-drafts.js');
    // Драфт уже хранит СЛЕДУЮЩУЮ итерацию: пользователь перестроил промпт уже
    // после сабмита. Прогон должен уйти с «SUBMITTED», драфт — не пострадать.
    await updateGenerationDraft('test-chat', 20, 'A cat.', d => ({
        ...d, prompt: 'EDITED-LATER', aspectRatio: '16:9', imageSize: '1K', quality: 'auto',
    }));

    const bodies = [];
    const restore = mockFetch((url, options) => {
        if (String(url).endsWith('/images/generations')) {
            bodies.push(String(options?.body || ''));
            return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'b3JkZXI=' }] }) };
        }
        if (String(url) === '/api/images/upload') {
            return { ok: true, status: 200, json: async () => ({ path: 'user/images/UR%20Image%20Studio/submission.png' }) };
        }
        throw new Error(`unexpected ${url}`);
    });
    try {
        const { runStage2ForDraft } = await import('../src/pipeline-stage2.js');
        const entry = await runStage2ForDraft(
            { chatId: 'test-chat', msgId: 20, messageText: 'A cat.', templateId: null,
              chatConfig: { imageProfileId: connId, templateId: null, imageRoute: route } },
            undefined,
            undefined,
            { submission: { prompt: 'SUBMITTED', aspectRatio: '1:1', imageSize: '2K', quality: 'high',
                            references: { includedIds: [], excludedIds: [], revision: 0 } } },
        );
        assert.ok(entry, 'run completes despite the draft having moved on');
        assert.equal(entry.prompt, 'SUBMITTED');
        assert.equal(entry.aspectRatio, '1:1', 'snapshot params win over the draft (16:9)');
        assert.equal(entry.imageSize, '2K', 'snapshot params win over the draft (1K)');
        assert.equal(entry.quality, 'high');
        assert.equal(bodies.length, 1);
        assert.match(bodies[0], /SUBMITTED/);
        assert.doesNotMatch(bodies[0], /EDITED-LATER/);
        const draft = await getGenerationDraft('test-chat', 20, 'A cat.');
        assert.equal(draft.prompt, 'EDITED-LATER', 'editor state survives the run');
        assert.equal(draft.aspectRatio, '16:9');
        assert.equal(draft.stage2.status, 'ready');
    } finally {
        restore();
    }
});
```

- [ ] **Step 1.2: Прогнать — убедиться, что падает**

Run: `node --test tests/pipeline-stage2-submission.test.js`
Ожидание: FAIL — без правок `opts.submission` игнорируется, прогон уходит с промптом `EDITED-LATER` (assert `entry.prompt === 'SUBMITTED'`).

- [ ] **Step 1.3: Реализовать `opts.submission`**

В `src/pipeline-stage2.js` — шесть правок.

**(a)** JSDoc `runStage2ForDraft`, после строки `@param {Array<{image:string,name?:string}>} [opts.refs] - compatibility override for references.` добавить:

```js
 * @param {object} [opts.submission] - submit-time snapshot for queued manual runs:
 *   { prompt:string, aspectRatio?:string, imageSize?:string, quality?:string,
 *     references?:{includedIds:string[],excludedIds:string[],revision:number} }.
 *   Authoritative over the live draft: never written back into it, and exempt
 *   from the post-materialize revision re-check — the snapshot IS the submitted
 *   intent; whatever the editor holds by execution time belongs to the next run.
```

**(b)** Перед `let draft = await loadDraftForStage2(chatId, msgId, messageText);` (строка ~150) добавить:

```js
        // Normalize once: only a string prompt makes a submission usable.
        const submission = opts.submission && typeof opts.submission.prompt === 'string'
            ? opts.submission
            : null;
```

**(c)** Условие оверлея generationDefaults (строка ~153):

```js
        if (!opts.instruction && !submission && Object.values(generationDefaults).some(Boolean)) {
```

**(d)** После блока `if (opts.instruction) { ... }` и перед `if (!draft.prompt) {` добавить:

```js
        if (submission) {
            // The snapshot overrides draft fields for THIS run only. Nothing is
            // persisted: the draft may already hold the next run's prompt, and
            // the post-materialize re-read below is skipped — by construction
            // there is nothing it could protect (refs resolve from the snapshot
            // corrections too).
            draft = {
                ...draft,
                prompt: submission.prompt,
                aspectRatio: submission.aspectRatio || draft.aspectRatio,
                imageSize: submission.imageSize || draft.imageSize,
                quality: submission.quality || draft.quality,
                templateId: templateId ?? draft.templateId,
            };
        }
```

**(e)** `resolvePromptReferenceContext` (строки ~184-188) — коррекции берутся из снапшота:

```js
        const referenceResolution = await resolvePromptReferenceContext({
            prompt: draft.prompt,
            candidates,
            corrections: submission
                ? {
                    includedIds: submission.references?.includedIds || [],
                    excludedIds: submission.references?.excludedIds || [],
                    revision: submission.references?.revision || 0,
                }
                : (draft.references || { includedIds: [], excludedIds: [], revision: 0 }),
        });
```

**(f)** Гард перечитывания (строка ~224, комментарий блока сохранить, условие расширить):

```js
        // Re-read the draft after awaited candidate/reference work. Manual
        // parameter edits made while references resolve must win before the
        // immutable paid-request snapshot is created. Skipped for submission
        // runs: their inputs are already frozen at submit time.
        if (!opts.instruction && !submission) {
```

- [ ] **Step 1.4: Прогнать — зелёный + регресс соседей**

Run: `node --test tests/pipeline-stage2-submission.test.js` — ожидание: PASS.
Run: `node --test tests/pipeline-stage2-serialization.test.js` — ожидание: PASS (авто/instruction-пути не задеты).

- [ ] **Step 1.5: Коммит**

```bash
git add src/pipeline-stage2.js tests/pipeline-stage2-submission.test.js
git commit -m "feat(pipeline): opts.submission в Stage 2 — submit-time снапшот, без revision re-check для submission-прогонов"
```

---

## Task 2: Элемент очереди несёт submission-снапшот

**Files:**
- Modify: `src/pipeline-queue.js`
- Test: `tests/pipeline-queue-submission.test.js` (новый)

- [ ] **Step 2.1: Написать падающие тесты + контрактный пин**

Создать `tests/pipeline-queue-submission.test.js` (харнес — гибрид `pipeline-stage2-serialization` + `pipeline-scene-first`: общий `chatMetadata`/`chat` через геттеры, привязка конфига чата к коннекту):

```js
// @ts-check
// Очередь + submit-time снапшот: item несёт промпт/параметры на момент клика,
// выполняется FIFO, и по-прежнему отвергает изменённый исходник ДО платного
// запроса (контракт docs/plans/deferred-queue-and-chat-insertion.md).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, installStGlobals } from './_helpers.js';

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
let chatMetadata = {};
let chat = [{ mes: 'A cat.' }];

const connId = 'queue-conn';
const route = {
    source: 'openai-models',
    modelId: 'gpt-image-1',
    generationContract: 'openai-images',
    contractVersion: 1,
    capabilities: { generate: 'supported', references: 'supported', edit: 'unknown', maxReferences: 5 },
    transport: { bodyKind: 'json', proxyEligible: true, directCors: 'preferred' },
};

function makeCtx() {
    return {
        extensionSettings,
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({}),
        get chatMetadata() { return chatMetadata; },
        get chat() { return chat; },
        chatId: 'test-chat',
    };
}

beforeEach(async () => {
    chatMetadata = {};
    chat = [{ mes: 'A cat.' }];
    lfMock = makeInMemoryLFA();
    installStGlobals();
    globalThis.SillyTavern.libs.localforage = lfMock;
    extensionSettings = { ur_image_studio: { imageConnections: { schemaVersion: 1, connections: [], catalogs: {}, galleryIndex: [], templates: [], presets: [], refs: [], folders: [], selectedRouteId: null } } };
    globalThis.SillyTavern.getContext = makeCtx;
    globalThis.window.dispatchEvent = () => {};
    globalThis.CustomEvent ||= class CustomEvent extends Event {
        constructor(type, init) {
            super(type, init);
            this.detail = init?.detail;
        }
    };

    const core = await import('../src/core.js');
    coreState = core.state;
    core.loadSettings();
    coreState.currentChatId = 'test-chat';
    const { createConnection } = await import('../src/connection-store.js');
    await createConnection({ id: connId, kind: 'image', name: `Test ${connId}`, endpoint: 'https://api.openai.test/v1', selectedRoute: route });
    await lfMock.setItem(`uris_api_key:${connId}`, 'test-key');
    const chatBinding = await import('../src/chat-binding.js');
    const binding = await chatBinding.loadChatConfig();
    await chatBinding.saveChatConfig({ ...binding, config: { ...binding.config, imageProfileId: connId } });

    const proxy = await import('../src/proxy.js');
    proxy._resetCache();
    proxy.clearHostStrategy();
    coreState.queue = [];
    coreState.queueRunning = false;
    coreState.queueAbort = null;
    coreState.stage2Chains = new Map();
});

afterEach(() => {
    coreState.queue = [];
    coreState.queueRunning = false;
    coreState.queueAbort = null;
    coreState.stage2Chains = new Map();
    coreState.currentChatId = null;
});

test('createQueueItem validates and deep-freezes the submission snapshot', async () => {
    const { createQueueItem } = await import('../src/pipeline-queue.js');
    const submission = {
        prompt: 'P1', aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
        references: { includedIds: ['ref-a'], excludedIds: [], revision: 1 },
    };
    const item = await createQueueItem({
        chatId: 'test-chat', msgId: 0, messageText: 'A cat.',
        requestedAction: 'current-prompt-stage2', templateId: null, submission,
    });
    submission.prompt = 'MUTATED';
    submission.references.includedIds.push('ref-b');
    assert.equal(item.submission.prompt, 'P1');
    assert.deepEqual(item.submission.references.includedIds, ['ref-a']);
    assert.ok(Object.isFrozen(item.submission));
    assert.ok(Object.isFrozen(item.submission.references));
});

test('createQueueItem rejects malformed submissions', async () => {
    const { createQueueItem } = await import('../src/pipeline-queue.js');
    const base = { chatId: 'test-chat', msgId: 0, messageText: 'A cat.', templateId: null };
    await assert.rejects(
        () => createQueueItem({ ...base, requestedAction: 'current-prompt-stage2', submission: { prompt: '   ' } }),
        /submission\.prompt/,
    );
    await assert.rejects(
        () => createQueueItem({ ...base, requestedAction: 'full-pipeline', submission: { prompt: 'P' } }),
        /current-prompt-stage2/,
    );
});

test('queued submissions run FIFO, each with its submit-time prompt', async () => {
    const bodies = [];
    const restore = mockFetch((url, options) => {
        if (String(url).endsWith('/images/generations')) {
            bodies.push(String(options?.body || ''));
            return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'b3JkZXI=' }] }) };
        }
        if (String(url) === '/api/images/upload') {
            return { ok: true, status: 200, json: async () => ({ path: 'user/images/UR%20Image%20Studio/q.png' }) };
        }
        throw new Error(`unexpected ${url}`);
    });
    try {
        const { createQueueItem, enqueueGeneration } = await import('../src/pipeline-queue.js');
        const mk = (prompt) => createQueueItem({
            chatId: 'test-chat', msgId: 0, messageText: 'A cat.',
            requestedAction: 'current-prompt-stage2', templateId: null,
            submission: { prompt, aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
                references: { includedIds: [], excludedIds: [], revision: 0 } },
        });
        const p1 = enqueueGeneration(await mk('P1'));
        const p2 = enqueueGeneration(await mk('P2'));
        const [e1, e2] = await Promise.all([p1, p2]);
        assert.ok(e1 && e2, 'both items complete with gallery entries');
        assert.equal(bodies.length, 2);
        assert.match(bodies[0], /P1/);
        assert.doesNotMatch(bodies[0], /P2/);
        assert.match(bodies[1], /P2/, 'FIFO order, each with its submit-time prompt');
    } finally {
        restore();
    }
});

// Контрактный пин (зелёный и до, и после правок): устаревший исходник
// отвергается до платного запроса даже у item'а со снапшотом.
test('a submission item still rejects when the source message changed before its turn', async () => {
    let releaseFirst;
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    const bodies = [];
    const restore = mockFetch((url, options) => {
        if (String(url).endsWith('/images/generations')) {
            bodies.push(String(options?.body || ''));
            return (async () => {
                if (bodies.length === 1) await gate; // держим item 1 в полёте
                return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'b3JkZXI=' }] }) };
            })();
        }
        if (String(url) === '/api/images/upload') {
            return { ok: true, status: 200, json: async () => ({ path: 'user/images/UR%20Image%20Studio/q-stale.png' }) };
        }
        throw new Error(`unexpected ${url}`);
    });
    try {
        const { createQueueItem, enqueueGeneration } = await import('../src/pipeline-queue.js');
        const mk = () => createQueueItem({
            chatId: 'test-chat', msgId: 0, messageText: 'A cat.',
            requestedAction: 'current-prompt-stage2', templateId: null,
            submission: { prompt: 'PX', aspectRatio: '1:1', imageSize: '1K', quality: 'auto',
                references: { includedIds: [], excludedIds: [], revision: 0 } },
        });
        const p1 = enqueueGeneration(await mk()); // стартует сразу: чек прошёл синхронно
        const p2 = enqueueGeneration(await mk()); // ждёт за item 1
        chat[0] = { mes: 'A cat. (edited)' };     // исходник изменился, пока item 2 ждёт
        releaseFirst();                           // item 1 доходит до конца
        await p1;
        await assert.rejects(async () => p2, /source message changed/i);
        assert.equal(bodies.length, 1, 'the stale item never reaches the provider');
    } finally {
        restore();
        releaseFirst?.();
    }
});
```

- [ ] **Step 2.2: Прогнать — красный**

Run: `node --test tests/pipeline-queue-submission.test.js`
Ожидание: валидационные/FIFO-тесты FAIL (`item.submission` — undefined; FIFO-прогон падает с «Prompt is empty» — драфт пуст, снапшот очередью не передаётся). Stale-тест PASS (контракт уже соблюдается).

- [ ] **Step 2.3: Реализовать**

В `src/pipeline-queue.js` заменить `createQueueItem` целиком:

```js
export async function createQueueItem({ chatId, msgId, messageText, requestedAction, templateId, submission = null, now = () => new Date().toISOString() }) {
    if (!['full-pipeline', 'current-prompt-stage2'].includes(requestedAction)) {
        throw new Error(`Unknown requestedAction: ${requestedAction}`);
    }
    if (submission != null && requestedAction !== 'current-prompt-stage2') {
        throw new Error('submission is only valid for current-prompt-stage2');
    }
    // Explicit field copy: the snapshot must not alias (or freeze) the caller's
    // object, and its shape is validated here rather than at paid-dispatch time.
    const submissionSnapshot = submission == null ? null : deepFreeze({
        prompt: String(submission.prompt ?? ''),
        aspectRatio: submission.aspectRatio ?? null,
        imageSize: submission.imageSize ?? null,
        quality: submission.quality ?? null,
        references: {
            includedIds: [...(submission.references?.includedIds || [])],
            excludedIds: [...(submission.references?.excludedIds || [])],
            revision: submission.references?.revision || 0,
        },
    });
    if (submissionSnapshot && !submissionSnapshot.prompt.trim()) {
        throw new Error('submission.prompt must be a non-empty string');
    }
    // Resolve schema-v5 binding and route together at enqueue time. The route is
    // deep-cloned so later connection edits cannot change a queued Stage 2 call.
    const chatConfig = deepFreeze(await resolveChatConfigSnapshot());
    // Studio items carry their scene text: there is no chat message to re-read
    // at execution time, and the studio scope survives chat switches.
    // Submission items deliberately do NOT: per the deferred-queue contract they
    // keep re-reading the live chat and are rejected on stale state before any
    // paid request.
    const item = {
        chatId,
        msgId,
        messageHash: hashMessage(messageText),
        requestedAction,
        templateId: templateId || null,
        chatConfig,
        enqueuedAt: now(),
        ...(chatId === STUDIO_CHAT_ID ? { messageText: String(messageText || '') } : {}),
        ...(submissionSnapshot ? { submission: submissionSnapshot } : {}),
    };
    recordDiagnosticEvent({
        event: 'queue-enqueue', stage: 'queue', chatHash: hashDiagnosticId(chatId), msgId,
        details: { requestedAction, submission: submissionSnapshot != null },
    });
    return item;
}
```

Обновить JSDoc `@param` объекта-входа: добавить `{submission?:object|null}` (снапшот `{prompt, aspectRatio?, imageSize?, quality?, references?}`, только для `current-prompt-stage2`).

В `processQueue` — строка диспетчеризации stage2-only (строка ~122):

```js
                if (item.requestedAction === 'current-prompt-stage2') {
                    entry = await runStage2ForDraft(input, (s) => { log('Q:', s); }, state.queueAbort.signal,
                        item.submission ? { submission: item.submission } : {});
                } else {
```

- [ ] **Step 2.4: Прогнать — зелёный + соседи**

Run: `node --test tests/pipeline-queue-submission.test.js` — ожидание: PASS (все 4).
Run: `node --test tests/tab-generate-queue.test.js tests/dispatch-plan.test.js` — ожидание: PASS.

- [ ] **Step 2.5: Коммит**

```bash
git add src/pipeline-queue.js tests/pipeline-queue-submission.test.js
git commit -m "feat(queue): item несёт submission-снапшот (валидация+заморозка), очередь передаёт его в Stage 2"
```

---

## Task 3: UI fire-and-forget — «Сгенерировать» ставит в очередь и не держит экран

**Files:**
- Modify: `src/ui/tab-generate.js`
- Test: `tests/tab-generate.test.js`

**Важно:** этот таск снимать блокировку экрана ещё не умеет (это Task 4) — коммитить Task 3 и уходить в релиз без Task 4 нельзя: старый `isRunning`-рендер после «Построить промпт» в полёте всё ещё залочит таб. Лендить в одной сессии.

- [ ] **Step 3.1: Тесты — заменить/добавить в `tests/tab-generate.test.js`**

В дестракчуре модуля (строка ~28) заменить `enqueueCurrent` на `submitCurrentGeneration`.

Заменить тест `enqueueCurrent surfaces storage errors via toastr` на:

```js
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
```

Добавить два теста рядом:

```js
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
```

- [ ] **Step 3.2: Прогнать — красный**

Run: `node --test tests/tab-generate.test.js`
Ожидание: новые тесты FAIL (`submitCurrentGeneration is not a function` / undefined-экспорт).

- [ ] **Step 3.3: Реализовать**

**(a)** Удалить замыкание `prepareRunInput` в `bindGenerate` (строки ~868-887) целиком.

**(b)** Удалить экспорт `enqueueCurrent` (строки ~1080-1099) целиком — на его место поставить две функции:

```js
/**
 * Build the Stage 1/2 run input AND the submit-time submission snapshot from
 * the visible editor state. The snapshot is what a queued Stage 2 will send:
 * later edits belong to the next submission and must not leak into this one.
 * @param {HTMLElement} root
 * @returns {Promise<object|null>} null when there is no post to submit for
 */
export async function prepareSubmissionInput(root) {
    const chatConfig = await resolveChatConfigSnapshot();
    const scope = activeScope(root);
    if (!scope.studio && scope.msgId == null) {
        toastr?.warning('Нет поста');
        return null;
    }
    const promptEl = root.querySelector('#urisPrompt');
    const currentDraft = await getGenerationDraft(scope.chatId, scope.msgId, scope.messageText);
    const templateId = resolveDraftTemplateId(currentDraft, state.activeTemplateId);
    const params = readGenerationParams(root, currentDraft);
    const prompt = promptEl?.value || '';
    const savedDraft = await updateGenerationDraft(scope.chatId, scope.msgId, scope.messageText, d => ({
        ...d,
        // Flush the visible scene text with the run: a pending debounced
        // autosave must not miss it.
        ...(scope.studio ? { sceneText: scope.messageText } : {}),
        prompt,
        ...params,
    }));
    return {
        chatId: scope.chatId,
        msgId: scope.msgId,
        messageText: scope.messageText,
        templateId,
        chatConfig,
        submission: {
            prompt,
            ...params,
            references: {
                includedIds: [...(savedDraft.references?.includedIds || [])],
                excludedIds: [...(savedDraft.references?.excludedIds || [])],
                revision: savedDraft.references?.revision || 0,
            },
        },
    };
}

/**
 * Fire-and-forget Stage 2 submission: snapshot the visible editor state, put it
 * on the serial queue, and return. The editor is never locked for the duration
 * of a generation — completion is reported via toasts and the queue status line.
 * @param {HTMLElement} root
 * @param {{enqueue?:Function}} [deps] - enqueue injection for tests
 */
export async function submitCurrentGeneration(root, deps = {}) {
    const enqueueFn = deps.enqueue || enqueueGeneration;
    try {
        const input = await prepareSubmissionInput(root);
        if (!input) return;
        if (!input.submission.prompt.trim()) {
            toastr?.warning('Промпт пуст — постройте или напишите промпт');
            return;
        }
        const wasBusy = state.queueRunning || state.queue.length > 0;
        const item = await createQueueItem({
            chatId: input.chatId,
            msgId: input.msgId,
            messageText: input.messageText,
            requestedAction: 'current-prompt-stage2',
            templateId: input.templateId,
            submission: input.submission,
        });
        const queued = enqueueFn(item);
        if (_generateRoot) updateQueueStatus(_generateRoot);
        toastr?.info(wasBusy ? 'Добавлено в очередь' : 'Генерация началась');
        queued.then(entry => {
            if (!entry) return;
            toastr?.success('Картинка сгенерирована');
            // Provider warnings (dropped size/quality etc.) — surface, don't bury.
            if (Array.isArray(entry?.warnings)) {
                for (const warning of entry.warnings) {
                    toastr?.warning(`${warning.feature}: ${warning.details}`);
                }
            }
            if (getActiveTab() === 'gallery') refreshActive();
        }).catch(e => {
            if (e?.name === 'AbortError') {
                // A whole-queue stop rejects every waiting item at once — one
                // quiet path instead of N «отменена» toasts.
                if (e?.message !== 'Queue stopped') toastr?.info('Генерация отменена');
            } else {
                error('Generate action:', e?.message || e);
                recordUrisError({ scope: 'Генерация', message: e?.message || String(e) });
                toastr?.error(e?.message || String(e));
            }
        }).finally(() => {
            if (_generateRoot) updateQueueStatus(_generateRoot);
        });
    } catch (e) {
        error('Generate action:', e?.message || e);
        recordUrisError({ scope: 'Генерация', message: e?.message || String(e) });
        toastr?.error(e?.message || String(e));
    }
}
```

**(c)** В `bindGenerate` обработчик «Построить промпт»: `const input = await prepareRunInput();` → `const input = await prepareSubmissionInput(root);` (тело обработчика не меняется).

**(d)** Обработчик «Сгенерировать» (строки ~911-946, вместе с комментариями про «Deliberately no render») заменить на:

```js
    // Stage 2 is fire-and-forget: snapshot the visible state, enqueue, return.
    // withBusy only guards the (fast) snapshot+enqueue part against a literal
    // double-click; the editor and buttons stay live for the whole generation.
    const generateImageButton = root.querySelector('#urisGenerateImage');
    generateImageButton?.addEventListener('click', withBusy(generateImageButton, () => submitCurrentGeneration(root)));
```

**(e)** Импорт (строка 10) — убрать ставший неиспользуемым `runStage2ForDraft`:

```js
import { runStage1ForDraft, enqueueGeneration, createQueueItem, stopQueue, buildCandidates } from '../pipeline.js';
```

- [ ] **Step 3.4: Прогнать — зелёный**

Run: `node --test tests/tab-generate.test.js` — ожидание: PASS (включая «bindGenerate attaches Stage 1 and Stage 2 click handlers»).

- [ ] **Step 3.5: Коммит**

```bash
git add src/ui/tab-generate.js tests/tab-generate.test.js
git commit -m "feat(ui): «Сгенерировать» — fire-and-forget постановка в очередь с снапшотом видимого редактора"
```

---

## Task 4: Снять блокировку редактора по `isRunning`, удалить мёртвый код

**Files:**
- Modify: `src/ui/tab-generate.js`
- Test: `tests/tab-generate.test.js`

- [ ] **Step 4.1: Падающий тест разметки**

В `tests/tab-generate.test.js`, рядом с остальными тестами `renderGenerateMarkup`:

```js
test('renderGenerateMarkup keeps the editor and actions enabled while a generation is running', () => {
    const messageText = 'message text';
    const draft = {
        prompt: 'a cat', aspectRatio: '9:16', imageSize: '2K', quality: 'high', templateId: null,
        messageHash: hashMessage(messageText),
        stage2: { status: 'running', requestId: 'req-1' },
    };
    const markup = renderGenerateMarkup(baseVm({ draft, messageText }));
    assert.match(markup, /id="urisPrompt"(?![^>]*disabled)/);
    assert.match(markup, /id="urisPromptExpand"(?![^>]*disabled)/);
    assert.match(markup, /id="urisBuildPrompt"(?![^>]*disabled)/);
    assert.match(markup, /id="urisGenerateImage"(?![^>]*disabled)/);
    assert.match(markup, /id="urisCancelImage"(?![^>]*hidden)/, 'Stop button stays visible for the running request');
});
```

Run: `node --test tests/tab-generate.test.js` — ожидание: FAIL (сейчас `urisPrompt`/кнопки получают `disabled` при running).

- [ ] **Step 4.2: Снять лок в `renderGenerateMarkup`**

- Удалить строку `const runningAttr = isRunning ? ' disabled' : '';`
- `const generateDisabledAttr = isRunning || !canGenerateImage ? ' disabled' : '';` → `const generateDisabledAttr = !canGenerateImage ? ' disabled' : '';`
- В studio-блоке textarea `#urisScene` — убрать `${runningAttr}`.
- В textarea `#urisPrompt` — убрать `${runningAttr}`.
- В кнопке `#urisPromptExpand` — убрать `${runningAttr}`.
- В кнопке `#urisBuildPrompt` — убрать `${runningAttr}`.
- `cancelHidden`/`cancelRequestId` (кнопка «Остановить») — не трогать: `isRunning` остаётся их источником.

- [ ] **Step 4.3: Обновить JSDoc-комментарии (семантика поменялась)**

`setCancelState` (~1496):

```js
/**
 * Toggle the in-flight "Остановить" button without a full re-render. The editor
 * and action buttons are never disabled by generation state (fire-and-forget
 * submissions); the only live chrome this drives is the Stop button and the
 * queue status line.
 */
```

`syncCancelState` (~1556):

```js
/**
 * Re-apply the in-flight "Остановить" state after a tab re-render. Rendering
 * rebuilds the button DOM (losing data-request-id / hidden state), so the
 * running map tells whether a generation is in flight for the current post.
 * Action buttons stay enabled regardless — submissions are fire-and-forget.
 */
```

- [ ] **Step 4.4: Удалить мёртвый код `executeGenerationAction` + его тесты**

- Удалить экспорт `executeGenerationAction` из `src/ui/tab-generate.js` (строки ~730-742).
- Удалить из `tests/tab-generate.test.js` тесты `executeGenerationAction dispatches Stage 1 only…` и `executeGenerationAction dispatches Stage 2 only…` (строки ~451-485).
- В `tests/tab-generate.test.js` проверить дестракчуру: `executeGenerationAction` там не деструктурируется (используется как `tabGenerate.executeGenerationAction`) — удалять из импорта нечего.

- [ ] **Step 4.5: Прогнать**

Run: `node --test tests/tab-generate.test.js tests/tab-generate-queue.test.js` — ожидание: PASS.

- [ ] **Step 4.6: Коммит**

```bash
git add src/ui/tab-generate.js tests/tab-generate.test.js
git commit -m "fix(ui): снята блокировка редактора по isRunning; executeGenerationAction удалён (test-only, шифровал старую семантику)"
```

---

## Task 5: Документация и версия

**Files:**
- Modify: `docs/CHANGELOG.md`, `docs/deep-dive-stage2-dispatch.md`, `docs/deep-dive-generate-tab-render.md`, `USER_GUIDE.md`, `package.json`

- [ ] **Step 5.1: Полный прогон**

Run: `npm test` — ожидание: весь не-server набор зелёный. Записать счётчик для changelog.

- [ ] **Step 5.2: CHANGELOG (шапка файла, новый раздел сверху)**

```markdown
## 2026-09-19 — v0.9.0: генерация fire-and-forget — очередь с submit-time снапшотом и живой редактор

Сценарий: построил промпт → «Сгенерировать» → задача ушла → сразу перестроил промпт → снова «Сгенерировать» — и так без ожидания. Раньше таб блокировался до конца генерации (а после перестройки промпта в полёте — оставался залоченным и ПОСЛЕ её завершения: рендер по `isRunning` глушил редактор и обе кнопки, и по `stage2-end` таб никто не перерендеривал), а гонка ревизий роняла идущую генерацию «Generation inputs changed…». Полный набор зелёный (<счётчик из шага 5.1>).

- **Submit-time снапшот** (`src/pipeline-stage2.js`, `opts.submission`): ручная постановка в очередь несёт промпт/параметры/коррекции референсов на момент клика. Снапшот авторитетен: не пишется в драфт, не перечитывается после материализации референсов (revision re-check для submission-прогонов отключён — гонка исчезает по построению), более новый драфт не протекает в платный запрос и не затирается им. Пути авто-flow и галерейной регенерации (`opts.instruction`) не изменились.
- **Ручная генерация идёт через серийную очередь** (`src/ui/tab-generate.js` → `pipeline-queue.js`): клик «Сгенерировать» снапшотит видимое состояние, ставит item в очередь и мгновенно возвращает редактор. `withBusy` защищает только быстрые снапшот+enqueue от двойного клика. Завершение — тосты (успех/warnings/отмена/ошибка) и строка статуса очереди («В очереди: N», «Пропустить», «Остановить»). Очередь серийна — один платный POST за раз, как у автолейна; per-post chain (`stage2Chains`) остаётся страховкой галерейной регенерации. Мёртвый `enqueueCurrent` заменён `submitCurrentGeneration`.
- **Снята блокировка редактора по `isRunning`** (`src/ui/tab-generate.js`): рендер больше не глушит textarea промпта/сцены, expand и обе кнопки при `draft.stage*.status === 'running'`. Кнопка «Остановить» текущего поста остаётся событийной (`uris:stage2-start/end`), пульс лаунчеров работает как раньше. `executeGenerationAction` (test-only, кодировал старую семантику блокировки) удалён вместе с тестами.
- **Контракт очереди сохранён** (`docs/plans/deferred-queue-and-chat-insertion.md`): item несёт chatId/msgId/хэш сообщения/снапшот роута/operation; устаревший чат или изменённый исходник отвергаются ДО платного запроса — в том числе для item'ов со снапшотом.
- **Тесты**: новые `tests/pipeline-stage2-submission.test.js` (снапшот побеждает более новый драфт, драфт не переписывается), `tests/pipeline-queue-submission.test.js` (валидация/заморозка снапшота, FIFO с промптами на момент клика, отвержение изменённого исходника до POST); в `tests/tab-generate.test.js` — рендер не блокирует редактор при running, `submitCurrentGeneration`: снапшот видимого промпта / пустой промпт → предупреждение / ошибки хранилища → тост; тесты `executeGenerationAction`/`enqueueCurrent` удалены.
```

- [ ] **Step 5.3: Аддендум в `docs/deep-dive-stage2-dispatch.md` (в конец файла)**

```markdown
## 9. Addendum 2026-09-19 — ручная генерация через очередь (fire-and-forget)

- «Сгенерировать» больше не зовёт `runStage2ForDraft` напрямую из обработчика: `submitCurrentGeneration` (`tab-generate.js`) ставит `current-prompt-stage2` item в `pipeline-queue` с `item.submission` — submit-time снапшотом промпта/параметров/коррекций.
- `runStage2ForDraft` получил `opts.submission`: снапшот авторитетен над драфтом, не пишется в драфт и не проходит post-materialize revision re-check (актуален только для reading-прогонов: auto и legacy). `opts.instruction` (галерея) семантически близок, но по-прежнему пишет промпт в драфт.
- Таблица §1, строка «ручной Сгенерировать»: место вызова — `tab-generate.js` (`submitCurrentGeneration` → `enqueueGeneration`), в chain — опосредованно (очередь серийна; chain остаётся рабочей сериализацией для галерейной регенерации).
- Крайний случай §4 «Сообщение отредактировано во время materialize → throw» сохраняется только для reading-прогонов; для submission-прогонов гонка исключена построением.
- Крайний случай §6 (перетирание промпта при правке исходного сообщения во время генерации) не ухудшился и не устранён — отдельная задача.
```

- [ ] **Step 5.4: Поправить упоминание мёртвого кода в `docs/deep-dive-generate-tab-render.md:49`**

Строку про `executeGenerationAction` («написаны и покрыты тестами, но не подключены…») заменить на: «`executeGenerationAction` удалён (v0.9.0): шифровал снятую семантику блокировки обеих кнопок на время стадии; прод всегда использовал независимые `withBusy`».

- [ ] **Step 5.5: USER_GUIDE.md — обновить сценарий генерации**

Найти раздел про «Построить промпт»/«Сгенерировать» (`grep -n "Построить промпт\|Сгенерировать" USER_GUIDE.md`), добавить/заменить абзац:

```markdown
### Генерация без ожидания

«Сгенерировать» ставит задачу в серийную очередь и сразу возвращает вам редактор: можно тут же перестроить промпт (или поправить его руками) и отправить следующую задачу — каждая уйдёт с тем промптом, который был виден в момент клика. Пока очередь работает, под кнопками виден статус: «В очереди: N», «Пропустить» (отменить текущую задачу) и «Остановить» (отменить все). Результат каждой задачи приходит уведомлением и появляется в галерее. Если исходный пост изменился до старта задачи — задача отменится с ошибкой: это защита от генерации по устаревшему состоянию.
```

- [ ] **Step 5.6: Версия**

`package.json`: `"version": "0.8.6"` → `"version": "0.9.0"`.

- [ ] **Step 5.7: Финальный прогон и коммит**

Run: `npm test` — ожидание: зелёный.

```bash
git add docs/CHANGELOG.md docs/deep-dive-stage2-dispatch.md docs/deep-dive-generate-tab-render.md USER_GUIDE.md package.json
git commit -m "docs: fire-and-forget генерация — changelog, аддендум deep-dive, user guide (v0.9.0)"
```

---

## Проверка руками (после реализации, по желанию)

1. Чат с постом: «Построить промпт» → «Сгенерировать» → не дожидаясь, снова «Построить промпт» → «Сгенерировать» ×3. Экран остаётся живым все время; строка «В очереди: N» растёт; картинки приходят тостами и падают в галерею по порядку.
2. «Остановить» в строке очереди гасит всё (тихо, без веера тостов); «Пропустить» отменяет только текущую.
3. Кнопка «Остановить» у кнопок генерации видна, пока текущий пост генерируется, и исчезает по завершении.
4. Редактирование исходного поста до старта ожидающей задачи → тост об ошибке этой задачи, остальные живут.
