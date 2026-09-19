# URIS Bridge — вендорный обзор для разработчиков расширений

UR Image Studio как **поставщик генерации** для вашего расширения: телефон,
визуальная новелла, аватары, инлайн-иллюстрации — один вызов, без своего
API-слоя. Ключи, провайдеры, CORS, recovery, галерея, диагностика остаются
внутри URIS.

- Канал: `globalThis.URIS`, контракт **apiVersion 1** (URIS ≥ 0.8.6, мост
  включён тумблером «Разрешить генерацию другим расширениям»).
- Всё локально в странице: расширения ST и так делят один контекст — мост не
  открывает ничего наружу, кроме публичной поверхности.
- Каждый вызов помечен вашим `caller` — requestId, диагностика и карточка
  галереи показывают, кто потратил запрос.
- Референс-интеграция: **Offstage** (телефон) — клиент `lib/uris-bridge.js`
  (перечитывает глобал на каждом вызове, нормализует коды), фото-бабблы с
  серийной очередью и запретом повторной оплаты после перезагрузки,
  слеш-команда `/offstage-draw`, условный `<photo>`-протокол в ответах LLM.

Состав: минимальный стек ST → инвентарь тавернового инструментария →
подключение → справочник API → паттерны встраивания → аборты и отмена →
жизненный цикл → грабли реальных расширений → чек-лист → FAQ.
Drop-in клиент: [`devkit/uris-client.js`](devkit/uris-client.js).

---

## 1. Минимальный стек: что нужно от SillyTavern

### 1.1. Скелет расширения (без этого ST не загрузит код)

```
my-extension/
  manifest.json   ← паспорт
  index.js        ← ES-модуль, точка входа
```

```json
{
    "display_name": "My Extension",
    "loading_order": 110,
    "js": "index.js",
    "author": "you",
    "version": "0.1.0"
}
```

Папка — в `data/<user>/extensions/<имя>` или установка git-URL через
Extensions-панель. ST импортирует `js` как ES-модуль и вызывает хуки из
`manifest.hooks` (`activate`, `disable`, …).

### 1.2. Обязательные обращения к ST API — ноль

Мост — обычный глобал страницы. Потребитель может не трогать
`SillyTavern.getContext()` вообще: ключи, chat-metadata, генерация, галерея —
внутри URIS. Интеграционный код целиком — `globalThis.URIS` + `await
URIS.ready`.

### 1.3. Рекомендуемые таверновые точки (качество жизни)

| Что | Зачем | Как |
|---|---|---|
| `loading_order` | URIS = 100. Больше — грузитесь после (синхронная видимость глобала в `init`). С клиентским `ready()` порядок не важен | manifest |
| `ctx.eventSource` / `eventTypes` | Жизненный цикл: `CHAT_CHANGED` (сброс per-chat состояния), `GENERATION_STOPPED` (таверна рвёт и мостовые вызовы), `APP_READY` | `SillyTavern.getContext()` |
| `ctx.extensionSettings.<ваш-модуль>` + `ctx.saveSettingsDebounced` | Свои настройки. Не храните здесь ключи (§10) и не пишите в чужие неймспейсы | getContext |
| `ctx.chatId` / `chatMetadata` | Скоуп «на этот чат» | getContext |
| События моста | `uris:bridge`, `uris:bridge-destroyed`, `URIS.on(...)` — готовность, сбои, выключение (опционально, §8–9) | мост |
| `AbortController` | Отмена генераций (веб-стандарт) | браузер |
| Хранилище результатов | `imagePath` — постоянный файл; держите у себя: `extensionSettings` (мелочи), `SillyTavern.libs.localforage` (объёмы) | ST |
| `toastr`, `SillyTavern.libs` (lodash, DOMPurify…) | Общие глобалы таверны — опционально | ST |

Свой UI — обычный DOM: расширения живут в одной странице.

### 1.4. Жёсткая зависимость (опционально)

`"dependencies": ["third-party/UR Image Studio"]` — ST не загрузит вас без
URIS (имя папки установки значимо). Для мягкой деградации не используйте:
клиент из §2 переживает любой порядок загрузки и выключение.

⚠️ Поля `requires`/`optional` в манифесте — legacy мёртвого Extras API;
современный ST их игнорирует. Уберите, если есть.

### 1.5. Чего НЕ нужно

- Серверного кода (плагины Express, правки сервера ST).
- Ключей, endpoint'ов, провайдерских SDK — всё в соединениях URIS.
- CORS-настроек — доставка (direct/через `/proxy/`) — внутреннее дело URIS.
- Импортов из внутренностей ST (`../../../script.js`) — ненадёжно;
  `getContext()` — санкционированная поверхность, и для моста она не нужна.
- `generate_interceptor`, function tools, regex-скриптов — мост их не требует.

---

## 2. Подключение

**A (рекомендуется): drop-in клиент.** [`devkit/uris-client.js`](devkit/uris-client.js)
— один файл без зависимостей:

```js
import { createUrisClient } from './uris-client.js';
const uris = createUrisClient({ caller: 'my-extension' });
```

Клиент решает гонку загрузки (ваш `init` раньше URIS — `ready()` дождётся
глобала), не кэширует ссылку на глобал (переживает выключение/включение
URIS), оборачивает недоступность в `URIS_UNAVAILABLE`.

**B: напрямую.** `globalThis.URIS` + `await URIS.ready`. Для прототипов и
консоли.

**C: жёсткая зависимость.** См. §1.4 — только если без URIS смысла нет.

## 3. Быстрый старт

```js
const uris = createUrisClient({ caller: 'my-phone' });

async function onDrawClicked(sceneText) {
    if (!uris.isAvailable()) { showHint('Установите UR Image Studio'); return; }
    const ctl = new AbortController();
    showPendingBubble(ctl);                       // бабл «Отправка фото…» + отмена
    try {
        const { result } = await uris.generateFromScene(
            { text: sceneText, aspectRatio: '9:16' },
            { signal: ctl.signal, onStatus: s => updateBubble(s) },
        );
        showPhotoBubble(result.imagePath);        // см. §7 про показ
    } catch (err) {
        switch (err.code) {
            case 'URIS_UNAVAILABLE':
            case 'EXT_DISABLED':    showHint('URIS выключен'); break;
            case 'NO_CONNECTION':  showHint('В URIS не выбрано соединение'); break;
            case 'ABORTED':        hideBubble(); break;         // отмена — не ошибка
            default:               showErrorBubble(err.message);
        }
    }
}
```

`generateFromScene` = `buildPrompt` (шаблон + макросы + резолвер сцены) →
`generate` с авто-подбором референсов. Шаблон не нужен — зовите
`generate({ prompt })` напрямую.

## 4. Поверхность API v1

| Метод | Вход | Результат | Заметки |
|---|---|---|---|
| `ready()` | `{timeoutMs?}` | поверхность моста | ждёт глобал и init |
| `generate(req, opts)` | `{prompt, aspectRatio?, imageSize?, quality?, references?, connectionId?, modelId?, useSceneRefs?, expandMacros?}` / `{signal?, onStatus?, queue?}` | `{requestId, cardId, imagePath, width, height, warnings}` | **платный** POST; recovery/галерея/Stop — в URIS |
| `buildPrompt(req, opts)` | `{text, templateId?, useScene?=true, expandMacros?=true}` | `{requestId, prompt, templateId, templateType, matchedReferences, ambiguities}` | **платный** текстовый LLM-запрос (Stage 1) |
| `generateFromScene(req, opts)` | `{text, templateId?, aspectRatio?, …}` | `{built, result}` | сахар: buildPrompt → generate |
| `getStatus()` | — | `{enabled, ready, accepting, connection, active}` | |
| `listConnections()` | — | `[{id, label, modelId, ready}]` | endpoint/ключи не отдаются |
| `listRefs()` | — | `[{id, name, folders, bindingMode}]` | пул без payload'ов |
| `listTemplates()` | — | `[{id, name, type}]` | без тел промптов |
| `abort(requestId)` | id | `bool` | работает и для очереди |
| `on(type, cb)` / `off` | тип или `'*'` | unsubscribe | события из §8 |

Константы: `aspectRatio` ∈ `1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9,
21:9`; `imageSize` ∈ `1K, 2K, 4K`; `quality` ∈ `auto, high, medium, low`.

### Коды ошибок (`err.code`)

| Код | Что делать |
|---|---|
| `URIS_UNAVAILABLE` (клиент) | URIS не установлен/не появился — подсказка |
| `NOT_READY` / `EXT_DISABLED` | мост выключен или URIS инициализируется — повторить позже |
| `NO_CONNECTION` | нет соединения: попросить выбрать (или передать `connectionId`) |
| `NO_ROUTE` | модель несовместима с соединением — сбросить `modelId` |
| `ROUTE_SELECTION_REQUIRED`, `MISSING_API_KEY`, `*_TOKEN_REQUIRED` | настроить соединение в URIS; сообщение уже готово для показа |
| `TEMPLATE_INVALID`, `NOT_FOUND` | шаблон пуст/не найден — конфигурация, не сеть |
| `REF_NOT_FOUND`, `REF_UNAVAILABLE` | `refId` нет в пуле или картинка не читается |
| `INVALID_PARAMS`, `INVALID_CALLER` | ваша ошибка — чинить на своей стороне |
| `ABORTED` | нормальный путь отмены, не показывать как ошибку |

Ошибки — `Error` с полем `code`. **Никогда не парсите текст сообщения** —
тексты могут меняться, коды — контракт.

## 5. Пайплайн URIS для внешних вызовов

**Шаблоны и сцена.** `buildPrompt` — Stage 1 над **произвольным текстом**,
без черновиков сообщений: `{{char}}`/`{{user}}` и макросы ST разворачиваются,
`useScene: true` сопоставляет текст с референсами, привязанными к чату.

**Референсы** — три способа в `generate`:
1. `references: [{ refId }]` — мост сам возьмёт картинку из пула URIS;
2. `references: [{ dataUrl, name? }]` — свои байты (аватар карточки и т.п.);
3. `useSceneRefs: true` — резолвер Stage 2 сам подберёт референсы по промпту
   (кто упомянут — тех и шлём; description-рефы впишутся в текст).

Способы комбинируются; капы и политику провайдера проверяет URIS.

```js
const res = await uris.generate({
    prompt: 'selfie photo, smiling, golden hour',
    aspectRatio: '9:16',
    references: [{ refId: appearanceRefId }], // лицо из пула
    useSceneRefs: true,                        // + совпадения по промпту
}, { signal });
```

## 6. Паттерны встраивания

**6.1. Кнопка по требованию.** Простейший случай (§3): действие юзера →
генерация → показ. Вся логика в одном обработчике.

**6.2. Маркеры в ответах LLM** (телефон/новелла: персонаж «сам» шлёт фото).
Хост учит LLM тегу (инструкция в промпте — условно, когда юзер попросил фото),
парсит ответ, ставит на место тега заготовку, зовёт мост, встраивает результат:

```js
const marker = /<photo>([\s\S]+?)<\/photo>/i.exec(replyText);
if (marker) {
    const desc = marker[1].trim();
    if (desc.length < 3) { /* деградация: скрыть тег, мост не звать */ }
    const shell = mountPendingBubble();          // вместо тега в DOM
    uris.generate({ prompt: desc }, { caller, signal })
        .then(res => shell.showImage(res.imagePath))
        .catch(e => shell.showError(e.code === 'ABORTED' ? null : e.message));
}
```

Контрактные точки: тег остаётся в сохранённом тексте (идемпотентность и
самоподдержание формата — модель видит свои прошлые теги); юзеру тег не
показывается; при недоступном URIS тег прячется, текст ответа не теряется.

**Где платный клик.** Выше — автопилотный вариант: мост зовётся сразу после
тега. Референс-интеграция (Offstage) выбрала консервативную развилку: тег
превращается в заготовку «фото ожидает запроса», и платный вызов запускает
клик юзера по карточке — модель *предлагает* фото, оплачивает человек.
Оба варианта легальны; автопилот — это §6.3 (явное согласие юзера).
Проверять такой протокол по живой модели ненадёжно (тег можно не дождаться)
— см. инъекцию canned-ответа в runbook, сценарий G.

**6.3. Фоновая/автопилотная генерация.** Без явного клика — только с явного
согласия юзера и лимитом на вашей стороне (мост серийный, но не бесплатный).

**6.4. Реактивный UI.** `uris.on('generation:ended', …)` или
`window: 'uris:bridge'` — обновлять ленты/счётчики; фильтруйте по
`detail.caller === 'my-extension'`.

## 7. Результат, показ, персистентность

- **`imagePath` — путь, а не байты**: `user/images/<папка>/uris_ext_<caller>_….png`,
  постоянный файл ST. Показ: `<img src="/${imagePath}">`. Переживает
  перезагрузку — храните путь в своих сообщениях, не dataURL.
- **Vision/обратная петля** (показать картинку модели): `fetch('/'+imagePath)`
  → blob → dataURL → multimodal-запрос.
- **requestId** — тег отслеживания (`ext_<caller>_<uuid>`), не стабильный id;
  для своего стора используйте свои id, requestId/`cardId` — как ссылку на
  карточку галереи URIS.
- **Очередь**: мост выполняет внешние вызовы строго по одному; не стройте
  параллельных очередей на своей стороне. `queue: false` — осознанный обход.

## 8. Аборты и отмена

**Механика.** Один `AbortController` на генерацию; сигнал передаётся в вызов:

```js
const ctl = new AbortController();
const p = uris.generate(request, { caller, signal: ctl.signal });
cancelButton.onclick = () => ctl.abort();
```

Работают оба момента:
- **отмена в очереди** (запрос ещё не стартовал) — реджект `ABORTED`, платный
  POST не отправляется вовсе;
- **отмена в полёте** — `fetch` рвётся по сигналу. Если POST уже ушёл,
  провайдер мог насчитать токены: URIS оставит pending-recovery запись для
  ручного разбора (честность вместо молчаливой потери).

**Правила гигиены:**

1. Отмена — не ошибка: `err.code === 'ABORTED'` убирайте тихо.
2. Не бросайте промис без контроллера: «унесённый» `generate()` невозможно
   отменить — юзер платит за брошенное.
3. **Stop таверны накрывает и мостовые вызовы** (`GENERATION_STOPPED` →
   `abortAllGenerations` внутри URIS) — слушайте `generation:error`/`ABORTED`,
   чтобы убрать заготовку.
4. Закрытие вкладки/`pagehide`: запрос с `signal` обрывается браузером;
   состояние фиксируется в diagnostics/recovery URIS — пропавших денег
   молча не бывает.
5. Отмена ещё не стартовавшего (очередного) запроса — `abort(requestId)`
   работает и до старта.

**UI-паттерн**: заготовка живёт всё время pending — и в очереди, и в полёте;
кнопка отмены доступна всегда; `onStatus` — спиннеру. Референс — кнопка
«Остановить» самого URIS: она реагирует на те же события.

## 9. Жизненный цикл и надёжность

- `URIS.ready` — промис; `ready()` клиента перекэшируется после отказа
  (URIS может быть включён снова — rejection не вечен). Промис **реджектится,
  а не висит**: если init() упал или URIS выключили до готовности, ждущие
  потребители получают ошибку (`NOT_READY` при выключении до готовности) —
  вечно pending не бывает.
- Выключение URIS: pending-запросы получают `ABORTED`, глобал удаляется,
  диспатчится `uris:bridge-destroyed`. Повторное включение — новый глобал.
  **Не кэшируйте ссылку** — обращайтесь к `globalThis.URIS` в момент вызова
  (клиент так и делает).
- Ваше расширение обязано деградировать тихо: нет URIS → скрыть кнопки
  генерации, не падать при загрузке, не блокировать свой `init` на чужом
  `ready()` дольше таймаута.

## 10. Этикет и границы

- `caller` — стабильный id расширения (`'offstage'`, `'my-vn'`): по нему
  юзер атрибутирует расходы. Не случайная строка.
- **Платные вызовы — только по действию юзера или явному согласию** (лимиты —
  на вашей стороне). Автопилот без согласия = чужие деньги.
- Не пишите в `extensionSettings.ur_image_studio`, не читайте чужие ключи.
  Прецедент, почему гигиена ключей в сторонних расширениях критична —
  [PSA SillyTavern #5592](https://github.com/SillyTavern/SillyTavern/discussions/5592).
- Ключи соединений не покидают URIS: `listConnections()` отдаёт только
  `{id, label, modelId, ready}`. Не просите и не ожидайте большего.

## 11. Грабли реальных расширений

1. **Кэш ссылки на глобал** — после re-enable URIS ссылка мертва; вызовы
   падают загадочно. Правило: `globalThis.URIS` в момент вызова.
2. **Свой API-слой с ключами** — как GlassPhone (перебор чужих папок,
   мини-клиенты, списки моделей, скопированные из чужого расширения): ломается
   при любом чужом рефакторинге и рассыпает ключи по чужим настройкам.
   Мост существует именно вместо этого.
3. **Блокировка своего `init` на чужом `ready()`** без таймаута — вы не
   загрузитесь, если URIS сломан. Всегда timeout + деградация.
4. **Параллельные очереди поверх моста** — двойная сериализация и голодание.
   Мост уже серийный.
5. **Парсинг текстов ошибок** вместо `err.code` — тексты меняются.
6. **Регенерация при перезагрузке** — маркер/задача в вашем хранилище должна
   ключиться так, чтобы перезагрузка страницы не стоила денег
   (`imagePath` персистентен — восстанавливайте показ, а не генерацию).
7. **dataURL вместо imagePath** — раздувает хранилище и умирает при экспорте;
   путь стабильнее и меньше.
8. **Отсутствие `caller`** — `INVALID_CALLER` у юзера в рантайме; задайте его
   один раз константой расширения.

## 12. Чек-лист интеграции

- [ ] `caller` — константа, валидная по `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`
- [ ] Детект: `isAvailable()` / `ready({timeoutMs})` — без блокировки init
- [ ] Все вызовы с `signal` (AbortController), кнопка отмены в pending-UI
- [ ] `err.code`-свитч; `ABORTED` — тихо; тексты ошибок не парсятся
- [ ] `imagePath` сохраняется в ваших данных; `<img src="/"+path>` для показа
- [ ] Нет кэша ссылки на `globalThis.URIS`
- [ ] Деградация без URIS: кнопки скрыты, init не падает
- [ ] Платные вызовы — за действием юзера/с согласием; лимиты на вашей стороне
- [ ] `extensionSettings.ur_image_studio` не читается и не пишется
- [ ] Проверено: выключение URIS посреди полёта → `ABORTED`, включение → работает

## 13. Когда мост НЕ нужен (родные средства ST)

- `SillyTavern.getContext()`: `eventSource`/`eventTypes` (включая свои
  строковые события), `chatMetadata`+`saveMetadata`, `extensionSettings`,
  `writeExtensionField`, `getThumbnailUrl`, `substituteParams`/`macros`,
  `SlashCommandParser`, `renderExtensionTemplateAsync`, `Popup`, токенизаторы,
  `variables`, `swipe`, `registerFunctionTool`.
- Текстовая генерация как сервис: `generateQuietPrompt`, `generateRaw`,
  `ChatCompletionService`/`TextCompletionService`/
  `ConnectionManagerRequestService` (так работает Offstage).
- Слэш-команды своего расширения (`SlashCommandParser`), вызываемые из
  Quick Replies и скриптов (`/run`).
- `generate_interceptor` в манифесте — глобальная функция на каждой генерации
  (порядок = `loading_order`).

Мост закрывает то, чего в ST нет: **сервис платной image-генерации и
промпт-пайплайна** (мультипровайдер, референсы, очередь, отмена, recovery,
галерея, атрибуция) — по образцу `quickReplyApi`, но с версионированием
(`apiVersion`) и структурными ошибками.

Официальные точки старта для скелета расширения:
[Writing UI Extensions](https://docs.sillytavern.app/for-contributors/writing-extensions/),
[Extension-ReactTemplate](https://github.com/SillyTavern/Extension-ReactTemplate).

## 14. FAQ

**Моё расширение грузится раньше URIS — `window.URIS` нет?**
Клиентский `ready()` решает; вручную — `loading_order` > 100, poll глобала
или однократный слушатель `uris:bridge`. Никогда не проверяйте глобал
на верхнем уровне модуля.

**Можно без подписок на события?**
Да — весь мост request/response: `ready`-промис + `await generate` +
`onStatus`-колбэк конкретного запроса. События — опциональный мониторинг.
Единственный нюанс — не кэшировать ссылку на глобал (§9).

**Можно ли получить endpoint/ключ соединения?** Нет. Только sanitized-списки.

**Галерея забивается чужими картинками?** Атрибуция живёт в
`provenance.requestId` (префикс `ext_<caller>_…`) и в самом имени файла
(`uris_ext_<caller>_….png`) — фильтр по нему в планах URIS (M3).

**Стабильность контракта?** `apiVersion: 1`; изменения только аддитивно,
breaking — с ростом версии и сохранением старой поверхности.
