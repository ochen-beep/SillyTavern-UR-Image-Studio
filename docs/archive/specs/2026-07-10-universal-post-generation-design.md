# Дизайн: генерация для любого сообщения в ленте

**Дата:** 2026-07-10  
**Статус:** approved  
**Связанный план:** будет создан отдельно  

## 1. Контекст и проблема

В UR Image Studio v2 генерация изображений жёстко привязана к AI-сообщениям:

- `src/events.js::lastAiIndex()` ищет только `!is_user`.
- `src/events.js::navigatePosts()` строит массив только из индексов AI-постов.
- Авто-Stage1 при `GENERATION_ENDED` запускается только для последнего AI-поста.

Из-за этого `state.currentMsgId` никогда не указывает на пользовательское (`{{user}}`) сообщение, и сгенерировать картинку для него невозможно без обходных путей.

## 2. Цель

Позволить пользователю выбирать **любое** сообщение в чате в качестве источника сцены для генерации, с понятным переключателем флоу и без нарушения обратной совместимости.

## 3. Архитектура

### 3.1. Новый модуль — `src/post-navigator.js`

Единственный источник истины для выбора текущего поста и фильтрации допустимых сообщений.

```js
export const POST_FILTER = {
    AI_ONLY: 'ai-only',      // !is_user
    USER_ONLY: 'user-only',  // is_user
    ALL: 'all',              // любые сообщения
    MANUAL: 'manual',        // любые сообщения, авто-генерация отключена
};

export function setFilter(filter);
export function getFilter();
export function navigatePosts(direction);     // ранее в events.js
export function getCurrentMsgId();
export function setCurrentMsgId(msgId);       // валидация + fallback
export function getLastPostIndex();           // последний подходящий пост
export function getFilteredIndexes();         // массив индексов по фильтру
export function isValidTarget(msgId);         // проверка msgId против фильтра
export function getPostInfo();                // строка для UI
```

### 3.2. Изменения в существующих файлах

| Файл | Что меняется |
|---|---|
| `src/events.js` | Удалены `lastAiIndex`, `navigatePosts`. Авто-триггеры читают фильтр из `post-navigator`. Подписки: `GENERATION_ENDED` (AI), `MESSAGE_SENT` (user). |
| `src/ui/tab-generate.js` | `navigatePosts` импортируется из `post-navigator.js`. Добавлен селектор `generationFlow`. Обновление `urisPostInfo` через `getPostInfo()`. |
| `src/core.js` | В `settings` добавлено поле `generationFlow` (`'ai-only'` по умолчанию для обратной совместимости). |

### 3.3. Переключатель флоу в UI

Вкладка «Генерация» получает селектор:

| Значение | Навигация ←/→ | Авто-триггер |
|---|---|---|
| `ai-only` | только AI | `GENERATION_ENDED` |
| `user-only` | только пользователь | `MESSAGE_SENT` |
| `all` | все сообщения | `GENERATION_ENDED` + `MESSAGE_SENT` |
| `manual` | все сообщения | нет |

## 4. Data flow

### Инициализация

1. `index.js` → `bindEvents()`.
2. `events.js` читает `state.settings.generationFlow` и вызывает `postNavigator.setFilter()`.
3. При `CHAT_CHANGED`: `currentMsgId = postNavigator.getLastPostIndex()`.

### Ручная навигация

1. Клик ←/→ в `tab-generate.js`.
2. `postNavigator.navigatePosts(direction)` строит отфильтрованный массив и смещает `state.currentMsgId`.
3. `updatePostInfo()` перерисовывает UI.

### Авто-триггер

```
GENERATION_ENDED ─┐
MESSAGE_SENT ─────┼→ events.js ──► postNavigator.getLastPostIndex()
                  │                       │
                  │                       ▼
                  │       фильтр включает тип сообщения?
                  │                       │
                  └───────────────────────┘
                          │
                          ▼
                  _onAutoStage1(msgId)
```

### Смена флоу в runtime

1. Пользователь меняет селектор.
2. `tab-generate.js` сохраняет `generationFlow` и вызывает `postNavigator.setFilter()`.
3. Если текущий пост не подходит под новый фильтр — `currentMsgId` мигрирует на `getLastPostIndex()`.

## 5. Edge cases

- **Пустой чат:** `getLastPostIndex()` → `null`; Build/Generate дизейблятся.
- **Смена флоу:** автоматический fallback на валидный пост.
- **Удаление/редактирование сообщения:** race-safe проверка по хэшу в pipeline остаётся.
- **Двойной авто-триггер:** `stage2RunningMsgId` guard в `runStage2` и один `AbortController` в `runFullPipeline`.
- **Streaming preview:** фильтруем `msgId === -1` и отсутствующие `ctx.chat[msgId]`.

## 6. Тестирование

- `tests/post-navigator.test.js` — unit-тесты фильтров, навигации, fallback.
- `tests/events.test.js` — проверка подписок под разные флоу.
- Ручной прогон — стрелки ходят по всем сообщениям, авто-генерация реагирует согласно селектору.

## 7. Обратная совместимость

- Значение по умолчанию `generationFlow = 'ai-only'` повторяет текущее поведение.
- Старые бандлы без `generationFlow` трактуются как `'ai-only'`.
