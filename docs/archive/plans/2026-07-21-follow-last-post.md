# Follow-Last-Post Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить переключатель «Следить за последним постом» в пост-навигатор вкладки «Генерация»: при включении навигатор автоматически перемещается на последний подходящий пост после генерации/свайпа/отправки сообщения; при выключении пост выбирается только вручную.

**Architecture:** Новая глобальная настройка `followLastPost` (default ON) в `extension_settings`. Обработчик в `events.js` слушает `GENERATION_ENDED`/`MESSAGE_SENT`/`MESSAGE_SWIPED` и при включённом флаге делает snap `currentMsgId → getLastPostIndex()` + диспатчит `window`-событие `uris:post-follow`, на которое подписана вкладка «Генерация» (index.js) для live re-render. Иконка-тогл `fa-magnet` рендерится в `.uris-postnav` сразу после `#urisPostInfo`.

**Tech Stack:** Vanilla JS (SillyTavern extension), node:test для unit-тестов, существующие `state`/`getCtx`/`saveSettings`/`setCurrentMsgId`/`getLastPostIndex`/`refreshActive`.

**Спека:** `docs/superpowers/specs/2026-07-21-follow-last-post-design.md`

---

## File Structure

- `src/core.js` — добавить `followLastPost: true` в `defaultSettings` (одна строка).
- `src/events.js` — новая функция-обработчик `onPostFollowEvent`, регистрация/снятие в `bindEvents`/`unbindEvents`, новый экспорт `notifyPostFollow` (обёртка над `window.dispatchEvent('uris:post-follow')`).
- `src/ui/tab-generate.js` — рендер тогла в обоих вариантах разметки (renderGenerateMarkup + renderEmptyStateMarkup), обработчик клика, подписка внутри `bindGenerate`/`bindEmptyState`.
- `index.js` — подписка на `uris:post-follow` рядом с `uris:stage1-ready` (init + cleanup).
- `style.css` — стиль `.uris-follow-toggle.is-active` рядом с `.uris-postnav-btn`.
- `tests/events.test.js` — unit-тесты: follow on/off × три события, unbind снимает слушатели.
- `tests/tab-generate.test.js` — UI-тест: рендер тогла в обоих состояниях, клик инвертирует.

---

## Task 1: Добавить настройку `followLastPost` в defaultSettings

**Files:**
- Modify: `src/core.js:149` (внутри `defaultSettings`)

- [ ] **Step 1: Прочитать `defaultSettings` и убедиться, что ключа ещё нет**

Run: `grep -n "followLastPost" src/core.js`
Expected: пусто.

- [ ] **Step 2: Добавить ключ в `defaultSettings`**

В `src/core.js`, внутри `export const defaultSettings = Object.freeze({ ... })`, после строки `generationFlow: 'ai-only',` добавить:

```js
    followLastPost: true,    // v3: навигатор вкладки «Генерация» следует за последним постом (GENERATION_ENDED/MESSAGE_SENT/MESSAGE_SWIPED)
```

- [ ] **Step 3: Проверить, что существующие тесты схемы/настроек не сломались**

Run: `node --test tests/settings-migration.test.js tests/schema.test.js`
Expected: те же pass/fail, что и на чистом HEAD (новый ключ не должен ломать миграции — миграции копируют известные поля).

- [ ] **Step 4: Commit**

```bash
git add src/core.js
git commit -m "feat(core): add followLastPost setting (default on)"
```

---

## Task 2: events.js — обработчик follow + подписка/снятие (TDD)

**Files:**
- Modify: `src/events.js` (module-level vars, `bindEvents`, `unbindEvents`)
- Test: `tests/events.test.js`

- [ ] **Step 1: Расширить testCtx в `tests/events.test.js` двумя новыми event_types**

В объекте `event_types` (строки 15–19) добавить:

```js
const event_types = {
    GENERATION_ENDED: 'GENERATION_ENDED',
    MESSAGE_SENT: 'MESSAGE_SENT',
    MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    CHAT_CHANGED: 'CHAT_CHANGED',
};
```

- [ ] **Step 2: Написать падающий тест: follow=ON → GENERATION_ENDED двигает currentMsgId + диспатчит uris:post-follow**

Добавить в конец `tests/events.test.js` (перед закрывающим — после теста `'CHAT_CHANGED recovers from loadChatConfig error…'`):

```js
test('follow=ON: GENERATION_ENDED snaps currentMsgId to last post and dispatches uris:post-follow', () => {
    state.settings.followLastPost = true;
    state.settings.automationMode = 'manual'; // automation off — чисто UI-snap
    state.currentMsgId = 1;                    // пользователь ушел на старый пост
    const dispatched = [];
    const originalDispatch = window.dispatchEvent;
    window.dispatchEvent = (ev) => { dispatched.push(ev.type); return true; };
    let captured = null;
    bindEvents({ onAutomation: (p) => { captured = p; } });
    makeLastListeners.GENERATION_ENDED();
    assert.equal(captured, null, 'automation must not fire in manual mode');
    assert.equal(state.currentMsgId, 3, 'currentMsgId must snap to last post');
    assert.ok(dispatched.includes('uris:post-follow'), 'uris:post-follow must be dispatched');
    window.dispatchEvent = originalDispatch;
    unbindEvents();
});
```

- [ ] **Step 3: Написать падающий тест: follow=ON → MESSAGE_SWIPED диспатчит событие (даже если msgId не сменился)**

Добавить рядом:

```js
test('follow=ON: MESSAGE_SWIPED dispatches uris:post-follow even when currentMsgId unchanged', () => {
    state.settings.followLastPost = true;
    state.currentMsgId = 3; // уже на последнем — msgId не изменится
    const dispatched = [];
    const originalDispatch = window.dispatchEvent;
    window.dispatchEvent = (ev) => { dispatched.push(ev.type); return true; };
    bindEvents({ onAutomation: () => {} });
    listeners.MESSAGE_SWIPED();
    assert.equal(state.currentMsgId, 3);
    assert.ok(dispatched.includes('uris:post-follow'), 'swipe must trigger re-render even if msgId unchanged');
    window.dispatchEvent = originalDispatch;
    unbindEvents();
});
```

- [ ] **Step 4: Написать падающий тест: follow=OFF — события не двигают currentMsgId и не диспатчат**

```js
test('follow=OFF: GENERATION_ENDED does not touch currentMsgId or dispatch uris:post-follow', () => {
    state.settings.followLastPost = false;
    state.settings.automationMode = 'manual';
    state.currentMsgId = 1;
    const dispatched = [];
    const originalDispatch = window.dispatchEvent;
    window.dispatchEvent = (ev) => { dispatched.push(ev.type); return true; };
    bindEvents({ onAutomation: () => {} });
    makeLastListeners.GENERATION_ENDED();
    assert.equal(state.currentMsgId, 1, 'currentMsgId must stay where user left it');
    assert.equal(dispatched.includes('uris:post-follow'), false, 'must not dispatch when follow is off');
    window.dispatchEvent = originalDispatch;
    unbindEvents();
});
```

- [ ] **Step 5: Написать падающий тест: ручная навигация не сбрасывает followLastPost**

```js
test('followLastPost flag is not cleared by manual navigation', () => {
    state.settings.followLastPost = true;
    state.currentMsgId = 3;
    bindEvents({ onAutomation: () => {} });
    // Символизирует ручной клик по стрелке ← через post-navigator
    state.currentMsgId = 2;
    assert.equal(state.settings.followLastPost, true, 'manual nav must not clear the flag');
    unbindEvents();
});
```

- [ ] **Step 6: Запустить тесты — убедиться, что новые падают по ожидаемой причине (RED)**

Run: `node --test tests/events.test.js`
Expected: 4 новых теста FAIL (`state.currentMsgId` остаётся 1, `uris:post-follow` не диспатчится и т.д.). Существующие 21 — PASS.

- [ ] **Step 7: Реализовать обработчик в `src/events.js`**

Вверху файла, после `let _onChatChanged = null;` (строка 21), добавить module-level vars:

```js
let _onPostFollow = null;      // ссылка для removeListener (одна функция на 3 события)
```

Импорт `setCurrentMsgId` уже есть (строка 13). Внутри `bindEvents`, после блока `_onMessageSent` и до `_onChatChanged`, вставить:

```js
    // FOLLOW-LAST-POST: при включённой настройке snap currentMsgId на последний
    // подходящий пост и уведомить UI. Работает независимо от automationMode —
    // это UI-поведение навигатора, а не пайплайн.
    _onPostFollow = () => {
        if (!state.settings.enabled) return;
        if (state.settings.followLastPost === false) return;
        const prev = state.currentMsgId;
        const next = setCurrentMsgId(getLastPostIndex());
        // Всегда диспатчим: для MESSAGE_SWIPED контент того же поста сменился,
        // и вкладка должна перечитать драфт/текст. Для прочих — если msgId сменился.
        if (next !== prev || next != null) {
            window.dispatchEvent(new CustomEvent('uris:post-follow'));
        }
    };
    ctx.eventSource.on(et.GENERATION_ENDED, _onPostFollow);
    ctx.eventSource.on(et.MESSAGE_SENT, _onPostFollow);
    ctx.eventSource.on(et.MESSAGE_SWIPED, _onPostFollow);
```

В `unbindEvents` добавить снятие всех трёх (после `try { if (_onChatChanged) ... }`):

```js
        try { if (_onPostFollow) {
            ctx.eventSource.removeListener(et.GENERATION_ENDED, _onPostFollow);
            ctx.eventSource.removeListener(et.MESSAGE_SENT, _onPostFollow);
            ctx.eventSource.removeListener(et.MESSAGE_SWIPED, _onPostFollow);
        } } catch {}
```

И обнулить ссылку: `_onPostFollow = null;` (рядом с `_onChatChanged = null;`).

- [ ] **Step 8: Запустить тесты — все 25 должны пройти (GREEN)**

Run: `node --test tests/events.test.js`
Expected: `pass 25`, `fail 0`.

- [ ] **Step 9: Commit**

```bash
git add src/events.js tests/events.test.js
git commit -m "feat(events): follow-last-post snap on GENERATION_ENDED/MESSAGE_SENT/MESSAGE_SWIPED"
```

---

## Task 3: style.css — стиль активного тогла

**Files:**
- Modify: `style.css` (рядом с `.uris-postnav-btn`, ~строка 176)

- [ ] **Step 1: Прочитать существующий блок `.uris-postnav-btn`**

Run: `sed -n '175,195p' style.css`

- [ ] **Step 2: Добавить стиль `.uris-follow-toggle.is-active`**

После блока `.uris-postnav-btn { ... }` (найти его закрывающую `}` — там же где `:hover` правило), добавить:

```css
/* Follow-last-post toggle: отдельная кнопка-иконка после #urisPostInfo. */
.uris-follow-toggle.is-active {
    color: var(--uris-accent, #6c8aff);
    border-color: var(--uris-accent, #6c8aff);
    background: var(--uris-surface-btn);
}
```

(использует существующие CSS-переменные проекта; `--uris-accent` может не существовать — тогда браузер возьмёт fallback `#6c8aff`).

- [ ] **Step 3: Commit**

```bash
git add style.css
git commit -m "style(ui): active state for follow-last-post toggle"
```

---

## Task 4: tab-generate.js — рендер тогла в навигаторе (оба варианта)

**Files:**
- Modify: `src/ui/tab-generate.js` (renderGenerateMarkup ~строка 231, renderEmptyStateMarkup ~строка 312)

- [ ] **Step 1: Написать падающий UI-тест на рендер тогла**

В `tests/tab-generate.test.js` найти существующий блок setup (`beforeEach`) и последний тест. Добавить в конец файла:

```js
test('render: follow-last-post toggle reflects followLastPost=true with is-active', async () => {
    state.settings.followLastPost = true;
    state.currentMsgId = 0;
    const root = document.createElement('div');
    await render(root);
    const toggle = root.querySelector('#urisFollowLast');
    assert.ok(toggle, 'toggle button must render');
    assert.ok(toggle.classList.contains('is-active'), 'must be active when followLastPost=true');
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
});

test('render: follow-last-post toggle reflects followLastPost=false without is-active', async () => {
    state.settings.followLastPost = false;
    state.currentMsgId = 0;
    const root = document.createElement('div');
    await render(root);
    const toggle = root.querySelector('#urisFollowLast');
    assert.ok(toggle);
    assert.equal(toggle.classList.contains('is-active'), false);
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
});
```

- [ ] **Step 2: Запустить тесты — убедиться в RED**

Run: `node --test tests/tab-generate.test.js`
Expected: 2 новых FAIL (`toggle` is null — кнопка ещё не рендерится).

- [ ] **Step 3: Добавить тогл в основную разметку**

В `src/ui/tab-generate.js` в `renderGenerateMarkup()` (или функция-генератор HTML, содержащая `<div class="uris-postnav">…`), после строки `<button class="uris-postnav-btn" id="urisNext" …>…</button>` первой копии навигатора (~строка 234) добавить:

```js
                <button class="uris-postnav-btn uris-follow-toggle" id="urisFollowLast"
                    title="Следить за последним постом"
                    aria-pressed="${state.settings.followLastPost !== false ? 'true' : 'false'}"
                    type="button">
                    <i class="fa-solid fa-magnet"></i>
                </button>
```

И сразу применить `is-active` класс. Если разметка собирается через template literal, использовать тернарный оператор в class-строке:

```js
                <button class="uris-postnav-btn uris-follow-toggle ${state.settings.followLastPost !== false ? 'is-active' : ''}" id="urisFollowLast"
                    title="Следить за последним постом"
                    aria-pressed="${state.settings.followLastPost !== false ? 'true' : 'false'}"
                    type="button">
                    <i class="fa-solid fa-magnet"></i>
                </button>
```

- [ ] **Step 4: Добавить тогл в empty-state разметку**

В `renderEmptyStateMarkup()`, после `<button class="uris-postnav-btn" id="urisNext" …>` (~строка 315) добавить такой же блок.

- [ ] **Step 5: Запустить тесты — GREEN**

Run: `node --test tests/tab-generate.test.js`
Expected: новые 2 теста PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/tab-generate.js tests/tab-generate.test.js
git commit -m "feat(ui): render follow-last-post toggle in post-navigator"
```

---

## Task 5: tab-generate.js — обработчик клика по тоглу (TDD)

**Files:**
- Modify: `src/ui/tab-generate.js` (`bindGenerate`, `bindEmptyState`)

- [ ] **Step 1: Написать падающий тест на клик**

В `tests/tab-generate.test.js` добавить:

```js
test('click on follow toggle flips the flag and saves', async () => {
    state.settings.followLastPost = true;
    state.currentMsgId = 0;
    let saved = false;
    const ctx = getCtx();
    const origSave = ctx.saveSettingsDebounced;
    ctx.saveSettingsDebounced = () => { saved = true; };
    const root = document.createElement('div');
    await render(root);
    root.querySelector('#urisFollowLast').click();
    assert.equal(state.settings.followLastPost, false, 'flag must flip');
    assert.equal(saved, true, 'must persist via saveSettingsDebounced');
    ctx.saveSettingsDebounced = origSave;
});
```

Если в `tests/tab-generate.test.js` ещё нет импорта `getCtx` — добавить его в существующий импорт из `../src/core.js` (или `import { getCtx } from '../src/core.js';` отдельно, если файла нет в импортах).

- [ ] **Step 2: Запустить — RED**

Run: `node --test tests/tab-generate.test.js`
Expected: FAIL (`state.settings.followLastPost` остаётся true после клика — обработчик не привязан).

- [ ] **Step 3: Реализовать обработчик в `bindGenerate`**

В `src/ui/tab-generate.js`, в `bindGenerate(root)`, сразу после строк с навигатором:

```js
    root.querySelector('#urisPrev').addEventListener('click', () => { navigatePosts(-1); render(root); });
    root.querySelector('#urisNext').addEventListener('click', () => { navigatePosts(1); render(root); });
```

добавить:

```js
    // Follow-last-post toggle: flips the global flag, persists, and on enable
    // snaps the navigator to the last post immediately.
    root.querySelector('#urisFollowLast')?.addEventListener('click', async () => {
        state.settings.followLastPost = state.settings.followLastPost === false;
        getCtx().saveSettingsDebounced?.();
        if (state.settings.followLastPost) {
            setCurrentMsgId(getLastPostIndex());
        }
        render(root);
    });
```

Импорты `setCurrentMsgId` / `getLastPostIndex` ещё отсутствуют в файле — добавить в существующий импорт из `../post-navigator.js`:

```js
import { POST_FILTER, navigatePosts, getPostInfo, setFilter, setCurrentMsgId, getLastPostIndex } from '../post-navigator.js';
```

- [ ] **Step 4: Реализовать тот же обработчик в `bindEmptyState`**

В `bindEmptyState(root)`, после `root.querySelector('#urisNext')?.addEventListener(...)`, добавить идентичный обработчик (без `setCurrentMsgId` snap можно оставить — при empty-state `getLastPostIndex()` вернёт null, snap безопасен, но после клика render(root) всё равно перерисует с актуальным состоянием):

```js
    root.querySelector('#urisFollowLast')?.addEventListener('click', async () => {
        state.settings.followLastPost = state.settings.followLastPost === false;
        getCtx().saveSettingsDebounced?.();
        render(root);
    });
```

- [ ] **Step 5: Запустить — GREEN**

Run: `node --test tests/tab-generate.test.js`
Expected: все PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/tab-generate.js tests/tab-generate.test.js
git commit -m "feat(ui): wire follow-last-post toggle click handler"
```

---

## Task 6: index.js — подписка на `uris:post-follow` для live re-render

**Files:**
- Modify: `index.js` (~строка 69 рядом с `_onStage1Ready`, init ~176, cleanup ~426)

- [ ] **Step 1: Добавить module-level var рядом с `_onStage1Ready`**

После `let _onStage1Ready = null;` (строка 69):

```js
let _onPostFollow = null;
```

- [ ] **Step 2: Добавить подписку в `init()`, после `_onStage1Ready`**

После блока `window.addEventListener('uris:stage1-ready', _onStage1Ready);` (~строка 176) добавить:

```js
    // Live-обновление вкладки «Генерация» при follow-last-post snap. Срабатывает
    // на GENERATION_ENDED/MESSAGE_SENT/MESSAGE_SWIPED когда флаг включён —
    // events.js уже переставил currentMsgId и прислал это событие.
    _onPostFollow = () => {
        if (!isPanelVisible() || getActiveTab() !== 'generate') return;
        refreshActive();
    };
    window.addEventListener('uris:post-follow', _onPostFollow);
```

(импорты `isPanelVisible`, `getActiveTab`, `refreshActive` уже есть — используются в `_onStage1Ready` выше).

- [ ] **Step 3: Добавить снятие в `cleanup()`**

В `cleanup()`, после строки `if (_onStage1Ready) { window.removeEventListener('uris:stage1-ready', _onStage1Ready); _onStage1Ready = null; }`:

```js
    if (_onPostFollow) { window.removeEventListener('uris:post-follow', _onPostFollow); _onPostFollow = null; }
```

- [ ] **Step 4: Запустить сьют events + tab-generate — убедиться, что ничего не сломалось**

Run: `node --test tests/events.test.js tests/tab-generate.test.js`
Expected: всё PASS (изменения в index.js не покрыты unit-тестами — это thin-glue подписка, проверяется вручную).

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(index): subscribe to uris:post-follow for live Generate tab refresh"
```

---

## Task 7: Smoke + полная проверка

**Files:** без изменений.

- [ ] **Step 1: Полный набор тестов**

Run: `node --test "tests/*.test.js" > tests-output.log 2>&1; grep -E "tests [0-9]+$|pass [0-9]+$|fail [0-9]+$" tests-output.log | tail -3`
Expected: те же 29 pre-existing failures (references-profiles и соседи), что и на чистом HEAD. Новых падений быть не должно. Общее число `pass` должно увеличиться на количество новых тестов (events: +4, tab-generate: +3 = +7).

- [ ] **Step 2: Дифф против чистого HEAD — только ожидаемые файлы**

Run: `git diff HEAD --stat`
Expected: изменены `src/core.js`, `src/events.js`, `src/ui/tab-generate.js`, `index.js`, `style.css`, `tests/events.test.js`, `tests/tab-generate.test.js` + добавлен docs/specs + docs/plans.

- [ ] **Step 3: Ручная проверка в ST (опционально, если есть доступ)**

- Открыть чат, включить галку (должна быть включена по дефолту, иконка магнита подсвечена).
- Сделать свайп → навигатор должен перейти на последний пост автоматически, вкладка показывать свежий текст.
- Снять галку → навигатор остаётся на текущем посту после свайпа.
- В авторежиме (full-pipeline) генерация всё равно идёт для последнего поста, независимо от галки.

---

## Self-Review

**1. Spec coverage:**
- Глобальная настройка default ON → Task 1. ✓
- Обработчик на 3 события + диспatch uris:post-follow → Task 2. ✓
- Галочка в навигаторе → Task 4 (рендер) + Task 5 (клик). ✓
- Подсветка активного состояния → Task 3. ✓
- follow=ON: snap на последний → Task 2. ✓
- follow=OFF: только ручной выбор → Task 2 (тесты OFF-ветви). ✓
- Галочка не снимается сама → Task 2 (тест на ручную навигацию) + Task 5 (обработчик только инвертирует). ✓
- Авторежим не зависит → уже реализовано, spec явно говорит «не меняется». ✓
- Live re-render открытой вкладки → Task 6. ✓

**2. Placeholder scan:** проверен — все шаги содержат конкретный код и команды, без TBD.

**3. Type consistency:** имена функций/переменных согласованы — `followLastPost` (camelCase, everywhere), `uris:post-follow` (event name, в events.js и index.js идентично), `urisFollowLast` (DOM id, в обоих вариантах рендера и в обработчиках), `_onPostFollow` (module-level var, в events.js и в index.js — отдельные, как и `_onStage1Ready`). `is-active` класс — везде одинаково.
