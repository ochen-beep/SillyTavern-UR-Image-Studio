# UR Image Studio: контракт внешнего моста (`globalThis.URIS`)

Аудитория: разработчики сторонних расширений SillyTavern (мобильные клиенты, визуальные новеллы, комментаторы), которые хотят генерировать картинки через UR Image Studio, не дублируя подключение к провайдеру.

- Источник правды по сигнатурам: `src/bridge.js` (фасад) и `src/ui/bridge-tab-ids.test.js` / `tests/bridge.test.js` (контрактные тесты).
- Лаборатория для ручных вызовов — вкладка «Мост» (включается в Настройках → «Внешний мост»).
- Мост включается тумблером «Разрешить генерацию другим расширениям» (по умолчанию включён).

## Подключение

```js
const uris = globalThis.URIS;
if (!uris || !(await uris.getStatus()).ready) { /* расширение не инициализировано */ }
```

`uris.apiVersion` — целое, растёт при несовместимых изменениях. Не полагайтесь на версию UI (`manifest.json`) — для контракта она не семантична.

## Сводка API

| Метод | Назначение |
|---|---|
| `generate(request, options)` | Картинка по готовому промпту (этап 2 без этапа 1). |
| `buildPrompt(request, options)` | Headless Stage 1: шаблон + текст сцены → промпт (платный текстовый запрос). |
| `generateFromScene(request, options)` | Stage 1 + Stage 2 одним вызовом. |
| `parseInline(text)` | Распознать `[[тип: описание]]`-маркеры в тексте (не генерирует). |
| `abort(requestId)` | Отменить живую генерацию. |
| `listActive()` | Живые задачи (очередь, инлайн, внешние вызовы). |
| `getStatus()` | `ready`, `accepting`, активное соединение чата, `active[]`. |
| `listConnections()` | Картинные коннекты (id, label, modelId, ready). |
| `listTemplates()` | Шаблоны Stage 1 (id, name, type). |
| `listRefs()` | Пул референсов (id, name, folders, bindingMode). |
| `listTriggers()` | Триггер-профили инлайна (id, aliases, aspect, refsPolicy). |
| `getCapabilities(connectionId?)` | Возможности соединения ДО платного вызова: контракт, референсы, размеры/качества. |
| `listGallery({ caller, limit, offset })` | Галерея caller'а: карточки с `provenance.requestId = ext_<caller>_…`. |
| `getCard(id)` | Одна карточка с метаданными. |
| `removeCard(id, { caller })` | Удаление карточки; скоуп по caller'у (см. «Ошибки»). |
| `listPending({ caller })` | Recovery: платные запросы без подтверждённого исхода. |
| `classifyError(error)` | Машиночитаемая классификация ошибки (code/category/retryable). |
| `on(type, handler)` | Подписка на события; возвращает unsubscribe-функцию. |

## `generate(request, options)`

```js
const res = await uris.generate(
  {
    prompt: 'a portrait of Zagreus, painterly',
    aspectRatio: '16:9',            // '1:1'|'2:3'|'3:2'|'3:4'|'4:3'|'4:5'|'5:4'|'9:16'|'16:9'|'21:9'
    imageSize: '1K',                // '1K'|'2K'|'4K' (опционально)
    quality: 'high',                // зависит от семейства модели (getCapabilities)
    connectionId: undefined,        // по умолчанию — коннект текущего чата
    references: [{ refId: '...' }], // явные референсы из пула (listRefs)
    useSceneRefs: false,            // авто-подбор референсов по промпту (резолвер Stage 2)
  },
  {
    caller: 'my-extension',         // ОБЯЗАТЕЛЬНО: попадает в provenance и диагностику
    signal: new AbortController().signal,
    onStatus: (s) => console.log(s),
  },
);
// res: { requestId, imagePath, thumbPath, width, height, ... }
```

- `caller` — единственное «право собственности»: карточки в галерее помечаются `ext_<caller>_<requestId>`, `removeCard` удаляет только свои.
- Задача встаёт в общую серийную очередь расширения; `listActive()` видит её наравне с ручными.
- Результат кладётся в нативную галерею ST; прогресс через `onStatus` и события.

## `buildPrompt(request, options)`

```js
const res = await uris.buildPrompt(
  { text: 'пост в соцсети от {{char}}...', templateId: undefined, useScene: true },
  { caller: 'my-extension', signal },
);
// res: { requestId, prompt, templateId, templateType, matchedReferences: [{id, name, effective}] }
```

- `text` — произвольный текст (не обязан быть сообщением чата); макросы ST разворачиваются по текущему чату.
- `useScene` — резолвер сцены сопоставит текст с референсами текущего чата (алиасы, whitelist).
- `templateId: undefined` — базовый режим (встроенная инструкция Stage 1).
- Платный текстовый запрос: идёт через профиль Stage 1 (Настройки → Источник текст-LLM).
- Опциональный контекст Stage 1 (персона/карточка {{char}}/лорбук/история) применяется согласно тумблерам в Настройках → «Контекст Stage 1».

## События

```js
const off = uris.on('gallery:added', ({ card }) => { /* обновить свою ленту */ });
// ... позже: off();
```

Типы: `generation:queued`, `generation:started`, `generation:ended`, `generation:error`, `prompt:started`, `prompt:ended`, `prompt:error`, `gallery:added`, `gallery:removed`, `ready`, `destroyed`, плюс `*` (все). Ошибки в payload несут `{ code, message, category, retryable }`. Проверяйте `typeof uris.on === 'function'` — старые версии моста событий не имели. Дополнительно на `window` летит `CustomEvent('uris:bridge', { detail: { type, ... } })` с теми же типами (используется UI расширения).

## Ошибки

Все ошибки моста — `Error` с полями:

- `code`: `NOT_FOUND`, `TEMPLATE_INVALID`, `ABORTED`, `CARD_NOT_OWNED`, `CAPABILITY_*`, `DELIVERY_*` и др.;
- `category`: `'user' | 'network' | 'provider' | 'capability'`;
- `retryable`: можно ли повторить тем же запросом.

`classifyError(e)` нормализует в эту форму даже чужие исключения. `CARD_NOT_OWNED` — попытка удалить чужую карточку (caller не совпал); файл на диске при этом не стирается никогда — удаление карточки убирает её из индекса галереи.

## Recovery (`listPending`)

Если расширение закрылось между отправкой платного запроса и подтверждением результата, запись остаётся в `listPending({ caller })`. Мост никогда не пересылает такие запросы автоматически — разбор ручной: сверитесь с провайдером и перегенерируйте при необходимости.

## Диагностика

Каждый вызов пишется в diagnostic events (`stage: 'bridge'`) без промптов и секретов. Сетевой дамп («Настройки → Данные и диагностика») содержит метаданные вызовов, включая caller.
