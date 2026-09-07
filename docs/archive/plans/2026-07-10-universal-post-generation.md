# Universal Post Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow image generation for any chat message (AI or user) via a configurable generation flow, by extracting post navigation into a dedicated module.

**Architecture:** A new `src/post-navigator.js` module owns current post selection and filtering. `src/events.js` and `src/ui/tab-generate.js` become consumers. `src/core.js` gains a `generationFlow` setting with four modes: `ai-only`, `user-only`, `all`, `manual`.

**Tech Stack:** ES modules, SillyTavern extension API (`eventSource`, `getContext`), Node.js built-in test runner (`node:test`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/post-navigator.js` (new) | Filter enum, current post state, navigation, last-post resolution, validation. |
| `tests/post-navigator.test.js` (new) | Unit tests for filters, navigation, fallback. |
| `src/core.js` (modify) | Add `generationFlow` default to settings. |
| `src/events.js` (modify) | Remove `lastAiIndex`/`navigatePosts`; wire `GENERATION_ENDED` and `MESSAGE_SENT` through `post-navigator`. |
| `src/ui/tab-generate.js` (modify) | Import navigation from `post-navigator.js`; add flow selector; update post info. |
| `tests/events.test.js` (modify) | Add tests for event subscriptions per flow. |
| `docs/changelog.md` (modify) | Document the new feature. |

---

### Task 1: Create `src/post-navigator.js`

**Files:**
- Create: `src/post-navigator.js`

Implement the post navigator module with no DOM dependencies.

- [ ] **Step 1: Write the module skeleton**

Create `src/post-navigator.js`:

```js
// @ts-check
/**
 * Пост-навигатор: единый источник истины для выбора текущего сообщения
 * и фильтрации допустимых сообщений для генерации.
 */
import { state, getCtx, log } from './core.js';

export const POST_FILTER = {
    AI_ONLY: 'ai-only',
    USER_ONLY: 'user-only',
    ALL: 'all',
    MANUAL: 'manual',
};

const VALID_FILTERS = new Set(Object.values(POST_FILTER));

/** @returns {import('./core.js').ChatMessage[]} */
function getChat() {
    return getCtx().chat || [];
}

function matchesFilter(msg, filter) {
    if (!msg) return false;
    if (filter === POST_FILTER.ALL || filter === POST_FILTER.MANUAL) return true;
    if (filter === POST_FILTER.AI_ONLY) return !msg.is_user;
    if (filter === POST_FILTER.USER_ONLY) return !!msg.is_user;
    return false;
}

export function setFilter(filter) {
    if (!VALID_FILTERS.has(filter)) {
        warn('post-navigator: invalid filter', filter, '— falling back to ai-only');
        filter = POST_FILTER.AI_ONLY;
    }
    state.generationFlow = filter;
    if (!isValidTarget(state.currentMsgId)) {
        state.currentMsgId = getLastPostIndex();
        log('post-navigator: filter changed, currentMsgId migrated to', state.currentMsgId);
    }
}

export function getFilter() {
    return state.generationFlow || POST_FILTER.AI_ONLY;
}

export function getFilteredIndexes() {
    const chat = getChat();
    const filter = getFilter();
    const out = [];
    for (let i = 0; i < chat.length; i++) {
        if (matchesFilter(chat[i], filter)) out.push(i);
    }
    return out;
}

export function isValidTarget(msgId) {
    const chat = getChat();
    if (msgId == null || msgId === -1 || !chat[msgId]) return false;
    return matchesFilter(chat[msgId], getFilter());
}

export function setCurrentMsgId(msgId) {
    if (isValidTarget(msgId)) {
        state.currentMsgId = msgId;
        return msgId;
    }
    const fallback = getLastPostIndex();
    state.currentMsgId = fallback;
    return fallback;
}

export function getCurrentMsgId() {
    return state.currentMsgId ?? getLastPostIndex();
}

export function navigatePosts(direction) {
    const indexes = getFilteredIndexes();
    if (!indexes.length) {
        state.currentMsgId = null;
        return null;
    }
    const current = state.currentMsgId ?? indexes[indexes.length - 1];
    let pos = indexes.indexOf(current);
    if (pos === -1) pos = indexes.length - 1;
    pos = Math.max(0, Math.min(indexes.length - 1, pos + direction));
    state.currentMsgId = indexes[pos];
    return state.currentMsgId;
}

export function getLastPostIndex() {
    const chat = getChat();
    const filter = getFilter();
    for (let i = chat.length - 1; i >= 0; i--) {
        if (matchesFilter(chat[i], filter)) return i;
    }
    return null;
}

export function getPostInfo() {
    const ctx = getCtx();
    const msgId = getCurrentMsgId();
    const msg = ctx.chat?.[msgId];
    if (!msg) return 'Нет поста';
    const preview = String(msg.mes || '').replace(/<[^>]*>/g, '').slice(0, 50);
    const label = msg.is_user ? 'user' : 'AI';
    return `Пост #${msgId} (${label}): ${preview}…`;
}

function warn(...args) {
    const ctx = getCtx();
    if (ctx?.warn) ctx.warn(...args);
    else console.warn(...args);
}
```

- [ ] **Step 2: Verify it parses**

Run: `node --check src/post-navigator.js`
Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add src/post-navigator.js
git commit -m "feat(post-navigator): add post selection and filtering module"
```

---

### Task 2: Write unit tests for `src/post-navigator.js`

**Files:**
- Create: `tests/post-navigator.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/post-navigator.test.js`:

```js
// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal ST mock before importing module under test.
globalThis.SillyTavern = {
    getContext: () => globalThis.__testCtx || { chat: [], warn: () => {} },
};
globalThis.toastr = undefined;

const { POST_FILTER, setFilter, getFilter, getFilteredIndexes, isValidTarget, navigatePosts, getLastPostIndex, getPostInfo, setCurrentMsgId } = await import('../src/post-navigator.js');

function setChat(chat) {
    globalThis.__testCtx = { chat };
}

function setState(state) {
    const mod = await import('../src/core.js');
    Object.assign(mod.state, state);
}

test('getFilteredIndexes respects ai-only filter', () => {
    setChat([
        { mes: 'hi', is_user: true },
        { mes: 'hello', is_user: false },
        { mes: 'bye', is_user: true },
        { mes: 'goodbye', is_user: false },
    ]);
    setFilter(POST_FILTER.AI_ONLY);
    assert.deepEqual(getFilteredIndexes(), [1, 3]);
});

test('getFilteredIndexes respects user-only filter', () => {
    setChat([
        { mes: 'hi', is_user: true },
        { mes: 'hello', is_user: false },
        { mes: 'bye', is_user: true },
    ]);
    setFilter(POST_FILTER.USER_ONLY);
    assert.deepEqual(getFilteredIndexes(), [0, 2]);
});

test('getFilteredIndexes returns all for all/manual', () => {
    setChat([
        { mes: 'a', is_user: true },
        { mes: 'b', is_user: false },
    ]);
    setFilter(POST_FILTER.ALL);
    assert.deepEqual(getFilteredIndexes(), [0, 1]);
    setFilter(POST_FILTER.MANUAL);
    assert.deepEqual(getFilteredIndexes(), [0, 1]);
});

test('navigatePosts moves within filtered indexes', () => {
    setChat([
        { mes: 'u1', is_user: true },
        { mes: 'a1', is_user: false },
        { mes: 'u2', is_user: true },
        { mes: 'a2', is_user: false },
    ]);
    setFilter(POST_FILTER.AI_ONLY);
    const mod = await import('../src/core.js');
    mod.state.currentMsgId = 3;
    assert.equal(navigatePosts(-1), 1);
    assert.equal(navigatePosts(1), 3);
});

test('navigatePosts falls back to last valid when current is invalid', () => {
    setChat([
        { mes: 'u1', is_user: true },
        { mes: 'a1', is_user: false },
    ]);
    setFilter(POST_FILTER.AI_ONLY);
    const mod = await import('../src/core.js');
    mod.state.currentMsgId = 0;
    assert.equal(navigatePosts(0), 1);
});

test('getLastPostIndex returns last matching message', () => {
    setChat([
        { mes: 'u1', is_user: true },
        { mes: 'a1', is_user: false },
        { mes: 'u2', is_user: true },
    ]);
    setFilter(POST_FILTER.AI_ONLY);
    assert.equal(getLastPostIndex(), 1);
    setFilter(POST_FILTER.USER_ONLY);
    assert.equal(getLastPostIndex(), 2);
});

test('setFilter migrates currentMsgId when it no longer matches', () => {
    setChat([
        { mes: 'u1', is_user: true },
        { mes: 'a1', is_user: false },
    ]);
    const mod = await import('../src/core.js');
    mod.state.currentMsgId = 0;
    setFilter(POST_FILTER.AI_ONLY);
    assert.equal(mod.state.currentMsgId, 1);
});

test('getPostInfo labels user and AI posts', () => {
    setChat([
        { mes: 'hello world', is_user: true },
    ]);
    const mod = await import('../src/core.js');
    mod.state.currentMsgId = 0;
    setFilter(POST_FILTER.ALL);
    assert.match(getPostInfo(), /Пост #0 \(user\): hello world…/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/post-navigator.test.js`
Expected: FAIL because module exports may not be fully wired or state helpers missing.

- [ ] **Step 3: Fix tests/module if needed**

If tests fail due to `core.js` not exporting mutable `state`, adjust test setup to inject state via a test helper. The implementation must not change for test convenience only.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/post-navigator.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/post-navigator.test.js
git commit -m "test(post-navigator): cover filters, navigation, and fallback"
```

---

### Task 3: Add `generationFlow` setting default in `src/core.js`

**Files:**
- Modify: `src/core.js`

- [ ] **Step 1: Locate settings default object**

Read `src/core.js` and find the default settings object (search for `const DEFAULT_SETTINGS` or similar).

- [ ] **Step 2: Add the new field**

Add:

```js
generationFlow: 'ai-only', // 'ai-only' | 'user-only' | 'all' | 'manual'
```

- [ ] **Step 3: Commit**

```bash
git add src/core.js
git commit -m "feat(core): add generationFlow setting default"
```

---

### Task 4: Refactor `src/events.js` to use `post-navigator.js`

**Files:**
- Modify: `src/events.js`

- [ ] **Step 1: Replace imports and remove old helpers**

Change the top import block to:

```js
import { state, getCtx, log, error } from './core.js';
import { applyBindingForCurrentChat } from './chat-binding.js';
import { POST_FILTER, setFilter, getLastPostIndex, setCurrentMsgId } from './post-navigator.js';
```

Remove the old functions `lastAiIndex` and `navigatePosts` from `src/events.js` entirely.

- [ ] **Step 2: Update `bindEvents` to set filter from settings**

Inside `bindEvents`, before wiring event listeners:

```js
setFilter(state.settings?.generationFlow || POST_FILTER.AI_ONLY);
```

- [ ] **Step 3: Replace `_onGenerationEnded` with flow-aware handlers**

Replace the existing `_onGenerationEnded` block with:

```js
const triggerIfMatches = (msgId, expectedType) => {
    if (msgId == null || msgId === -1) return;
    const filter = state.generationFlow || POST_FILTER.AI_ONLY;
    const msg = ctx.chat?.[msgId];
    if (!msg) return;
    const isUser = !!msg.is_user;
    if (filter === POST_FILTER.MANUAL) return;
    if (filter === POST_FILTER.AI_ONLY && isUser) return;
    if (filter === POST_FILTER.USER_ONLY && !isUser) return;
    state.currentMsgId = msgId;
    _onAutoStage1?.(msgId);
};

_onGenerationEnded = () => {
    if (!state.settings.enabled) return;
    const filter = state.generationFlow || POST_FILTER.AI_ONLY;
    if (filter === POST_FILTER.USER_ONLY || filter === POST_FILTER.MANUAL) return;
    const i = getLastPostIndex();
    if (i != null) triggerIfMatches(i, 'ai');
};
ctx.eventSource.makeLast(et.GENERATION_ENDED, _onGenerationEnded);

_onMessageSent = (msgId) => {
    if (!state.settings.enabled) return;
    const filter = state.generationFlow || POST_FILTER.AI_ONLY;
    if (filter === POST_FILTER.AI_ONLY || filter === POST_FILTER.MANUAL) return;
    const i = (typeof msgId === 'number' && msgId >= 0) ? msgId : getLastPostIndex();
    if (i != null) triggerIfMatches(i, 'user');
};
ctx.eventSource.on(et.MESSAGE_SENT, _onMessageSent);
```

Add `_onMessageSent` to the module-level variable declarations near `_onGenerationEnded`.

- [ ] **Step 4: Update `_onChatChanged`**

Replace:

```js
const i = lastAiIndex(ctx);
if (i != null) state.currentMsgId = i;
```

with:

```js
const i = getLastPostIndex();
if (i != null) setCurrentMsgId(i);
```

- [ ] **Step 5: Update `unbindEvents`**

Add cleanup for `_onMessageSent`:

```js
try { if (_onMessageSent) ctx.eventSource.removeListener(et.MESSAGE_SENT, _onMessageSent); } catch {}
```

and set `_onMessageSent = null` at the end.

- [ ] **Step 6: Verify parse**

Run: `node --check src/events.js`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/events.js
git commit -m "feat(events): wire auto-generation through post-navigator"
```

---

### Task 5: Update `src/ui/tab-generate.js`

**Files:**
- Modify: `src/ui/tab-generate.js`

- [ ] **Step 1: Update imports**

Change:

```js
import { navigatePosts, notifyStage1Ready } from '../events.js';
```

to:

```js
import { notifyStage1Ready } from '../events.js';
import { POST_FILTER, navigatePosts, getPostInfo, setFilter } from '../post-navigator.js';
```

- [ ] **Step 2: Add flow selector to HTML template**

After the Stage2 mode row, add:

```html
<div class="uris-row"><label>Флоу генерации</label>
    <select class="text_pole" id="urisGenerationFlow">
        <option value="${POST_FILTER.AI_ONLY}" ${state.settings.generationFlow === POST_FILTER.AI_ONLY ? 'selected' : ''}>Только AI</option>
        <option value="${POST_FILTER.USER_ONLY}" ${state.settings.generationFlow === POST_FILTER.USER_ONLY ? 'selected' : ''}>Только пользователь</option>
        <option value="${POST_FILTER.ALL}" ${state.settings.generationFlow === POST_FILTER.ALL ? 'selected' : ''}>Все сообщения</option>
        <option value="${POST_FILTER.MANUAL}" ${state.settings.generationFlow === POST_FILTER.MANUAL ? 'selected' : ''}>Ручной выбор</option>
    </select></div>
```

- [ ] **Step 3: Bind flow selector**

In `bindGenerate`, after the Stage2 mode listener, add:

```js
root.querySelector('#urisGenerationFlow').addEventListener('change', async e => {
    const flow = e.target.value;
    state.settings.generationFlow = flow;
    setFilter(flow);
    await persistBundleFields({ generationFlow: flow });
    updatePostInfo(root);
    getCtx().saveSettingsDebounced();
});
```

- [ ] **Step 4: Replace `updatePostInfo` implementation**

Replace the body of `updatePostInfo` with:

```js
function updatePostInfo(root) {
    const info = root.querySelector('#urisPostInfo');
    if (!info) return;
    info.textContent = getPostInfo();
}
```

- [ ] **Step 5: Verify parse**

Run: `node --check src/ui/tab-generate.js`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/ui/tab-generate.js
git commit -m "feat(ui/generate): add generation flow selector and use post-navigator"
```

---

### Task 6: Add event binding tests

**Files:**
- Modify: `tests/events.test.js` (or create if missing)

- [ ] **Step 1: Check existing events tests**

Run: `ls tests/events.test.js` — if it exists, read it; otherwise create it.

- [ ] **Step 2: Add flow-aware subscription tests**

Minimal test if creating new file:

```js
// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

const listeners = {};

globalThis.SillyTavern = {
    getContext: () => ({
        chat: [
            { mes: 'u1', is_user: true },
            { mes: 'a1', is_user: false },
        ],
        eventSource: {
            on: (evt, fn) => { listeners[evt] = fn; },
            makeLast: (evt, fn) => { listeners[evt] = fn; },
            removeListener: (evt) => { delete listeners[evt]; },
        },
        event_types: {
            GENERATION_ENDED: 'GENERATION_ENDED',
            MESSAGE_SENT: 'MESSAGE_SENT',
            CHAT_CHANGED: 'CHAT_CHANGED',
        },
        saveSettingsDebounced: () => {},
    }),
};
globalThis.toastr = undefined;

const { state } = await import('../src/core.js');
state.settings = { enabled: true, generationFlow: 'ai-only' };

const { bindEvents, unbindEvents } = await import('../src/events.js');

test('bindEvents subscribes to GENERATION_ENDED for ai-only flow', () => {
    bindEvents({ onAutoStage1: () => {} });
    assert.ok(listeners.GENERATION_ENDED);
    unbindEvents();
});
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/events.test.js`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add tests/events.test.js
git commit -m "test(events): verify event subscription per generation flow"
```

---

### Task 7: Run full test suite

- [ ] **Step 1: Run all tests**

Run: `node --test tests/*.test.js`
Expected: all tests pass.

- [ ] **Step 2: Fix any regressions**

If existing tests fail because `navigatePosts` was removed from `events.js`, update those tests to import from `post-navigator.js`.

- [ ] **Step 3: Commit**

```bash
git add tests/
git commit -m "test: update tests for post-navigator migration"
```

---

### Task 8: Update changelog

**Files:**
- Modify: `docs/changelog.md`

- [ ] **Step 1: Add entry**

Append under an `## Unreleased` section:

```markdown
## Unreleased

### Added
- Генерация теперь доступна для любого сообщения в ленте (AI или пользователя).
- Переключатель флоу генерации: "Только AI", "Только пользователь", "Все сообщения", "Ручной выбор".
- Новый модуль `src/post-navigator.js` отвечает за выбор и фильтрацию сообщений.
```

- [ ] **Step 2: Commit**

```bash
git add docs/changelog.md
git commit -m "docs(changelog): document universal post generation"
```

---

## Self-Review Checklist

- [ ] **Spec coverage:** every requirement from `2026-07-10-universal-post-generation-design.md` has a task.
- [ ] **No placeholders:** no TBD/TODO or vague steps.
- [ ] **Type consistency:** `generationFlow` values match `POST_FILTER` enum across all files.
- [ ] **Backward compatibility:** default `ai-only` preserves old behavior.
