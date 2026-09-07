# UR Image Studio — Дизайн v2 (Workflow Redesign)

> Дата: 2026-07-01
> Предыдущая версия: `docs/superpowers/specs/2026-06-27-ur-image-studio-design.md` (MVP, трёхвкладочный layout)
> Назначение: переработка окна под мысленную модель пользователя — «workflow как в ComfyUI»: блоки (источник → правила → генерация) видны рядом; пресеты — это атомарные именованные бандлы, а не сваленные в одну кладовку настройки; галерея якорится к сообщению.
> Контекст фиксации: продуктовое ревью 2026-07-01 выявило, что инженерная основа аккуратная, но карта вкладок не совпала с моделью пользователя — «режим confirm» мёртвый, редактор промпта обойдён в автоподоражных сценариях, связи «пост ↔ картинка» нет, референсов как сущности не существует.

---

## 1. Принципы v2

1. **Вкладки = блоки workflow, а не категории настроек.** Раньше вкладка «Пресеты» была кладовкой четырёх разных сущностей. Теперь каждая сущность живёт своей вкладкой и называется ролью в flow: API, Референсы, Генерация, Галерея, Профили.
2. **Два независимых переключателя вместо одного «режима».** Режим `confirm` v1 был мёртвым, потому что единственный переключатель `auto/confirm/manual` смешал управление Stage1 и Stage2. v2 разделяет: Stage1 (построение промпта) и Stage2 (картинка) настраиваются независимо — это даёт 4 осмысленных гибрида вместо одного «промежуточного».
3. **Редактор промпта = нижняя панель результата Stage1.** Главная площадь вкладки «Генерация» — конфигурация flow (источник, шаблон, персонажи, режимы). Поля style/prompt/aspect/size появляются как «промежуточный вывод ноды» (`ак ComfyUI`) только когда есть построенный Stage1 промпт. Раньше редактор занимал весь таб, а конфигурация была свалена в «Пресеты».
4. **Референсы — самостоятельный блок workflow.** До v2 галки `sendCharAvatar/userAvatarFile/referenceMode` жили внутри карточки image-пресета, что смешивало «подключение к image-API» с «что подавать как референс». Теперь отдельная коллекция профилей референсов и своя вкладка.
5. **Бандлы — именованные атомарные пресеты всего flow.** Раньше «привязка к чату» через `chatMetadata.uris_binding` хранила 4 отдельных id'шника, и пользователь не видел, что что-то применяется. Теперь один именованный профиль задает все блоки целиком и применяется одним кликом.
6. **Галерея якорится к сообщению.** Картинка вешаетсяя на DOM-ноду (`message.mes` через observer, без мутации текста), а не живёт отдельной сеткой. Клик по якорю → lightbox. Навигатор постов автоматически получает бейджи связи.
7. **Провайдеры — расширяемый слой, не hardcoded apiType.** Вводятся `src/providers/*` под OpenAI-like, Gemini, ComfyUI, A1111. Это даёт подключение локальных эндпоинтов (LM Studio уже работает через OpenAI-like как есть; ComfyUI требует своего провайдера).

## 2. Поддержка локальных эндпоинтов

| Провайдер | Совместимость с v1 | Что нужно в v2 |
|---|---|---|
| **LM Studio** (локальный text-LLM) | Already работает — OpenAI-совместимый `/v1/chat/completions`. Просто вставить `http://127.0.0.1:1234/v1` в endpoint text-коннекта. | Ничего на уровне кода; в UI — явная подсказка «localhost OK». |
| **OpenAI / OpenAI-like** (включая локальные self-hosted шлюзы) | Работало, остаётся. | Без изменений; обобщается до `provider: 'openai-like'`. |
| **Gemini** | Работало, остаётся. | Без изменений; `provider: 'gemini'`. |
| **ComfyUI** (локальный граф-пайплайн) | НЕ поддерживается — чужой протокол. | Новый провайдер: `POST /prompt` с workflow JSON вместо «prompt строкой». Возвращается `prompt_id` → поллинг `/history/{prompt_id}` → забор изображений по filename из `/view`. |
| **A1111 WebUI / Forge / reForge** (опционально, на будущее) | НЕ поддерживается. | Планируемый провайдер: `POST /sdapi/v1/txt2img` payload. Не входит в MVP v2, но слой провайдеров должен позволять добавить. |

Влияние на архитектуру: `apiType: 'openai' | 'gemini'` заменяется на `provider` + отделяется контракт «`generateText` / `generateImage` с разной формой payload'а». Image-API больше не предполагает «отправить prompt строкой» — ComfyUI отправляет workflow с подставленным текстом в конкретную ноду.

## 3. Карта вкладок v2

```
┌─ UR Image Studio ──────────────────────────────────────────┐
│  [API] [Референсы] [Генерация] [Галерея] [Профили]          │
│                                                              │
│  Активный профиль: [Манга-сессия ▾]   (мост ко всем блокам) │
└──────────────────────────────────────────────────────────────┘
```

Подробнее по каждой вкладке — в разделе 4.

## 4. Вкладки (по ролям блоков workflow)

### 4.1 API

Два независимых списка профилей:
- **Text-connections** — `{id, name, provider: 'openai-like'|'gemini', endpoint, apiKey, model, temperature?}`. Коннекты к text-LLM.
- **Image-connections** — `{id, name, provider: 'openai-like'|'gemini'|'comfyui'|'a1111', endpoint, apiKey?, model, ...providerSpecific}`. Профили image-API.

Вверху вкладки — **toggle-bar активной пары**: текущий text-connection × текущий image-connection, переключаются в один клик. Активная пара живёт в `state` и немедленно течёт в «Генерацию» — отдельно нигде сохранять не надо.

При выборе провайдера карточка профиля перерисовывает поля под него:
- `openai-like`: endpoint, apiKey, model, `size`, `quality`.
- `gemini`: endpoint, apiKey, model, `aspectRatio`, `imageSize`.
- `comfyui`: endpoint, **workflow JSON** (textarea), **id ноды для подстановки текста** (`text_node_id`), **id ноды для подстановки seed** (опц.), **id выходной ноды изображений** (для опроса history).
- `a1111` (опц., не MVP): endpoint, model, sampler, steps, cfg, dimensions.

CRUD: создать/переименовать/скопировать/удалить. Quick-toggle активной пары.

### 4.2 Референсы

Новая секция. Коллекция **профилей референсов** в localforage (`uris_references_profiles`):

```js
{
  id, name,
  charAvatar: bool,          // использовать аватар {{char}}
  userAvatarFile: string,    // файл аватара пользователя (или '')
  customImages: string[],    // ид custom-upload файлов (для будущего)
  mode: 'never'|'always',    // упрощённо; tag_controls нет (тегов из чата не приходит)
}
```

Вверху — toggle-bar активного профиля (один). CRUD аналогично API.

Реализация того, **как** референс передаётся в image-API, лежит в провайдере:
- openai-like (images/generations): нестандартно, поля `image` historically не существует — провайдер либо игнорирует, либо error. В v2 **объявляем** референсы для OpenAI images как «не поддерживается провайдером» (galga в UI становится disabled с подсказкой при выборе openai-like image-connection). Это убирает v1-противоречие (там галка работала, но по факту поле летело вслепую).
- gemini: `inlineData` parts в contents.
- comfyui: upload аватара на `/upload/image`, затем имя файла подставляется в `LoadImage` ноду workflow JSON по сеpcифицированному id ноды (настройка image-connection, см. 4.1).

Сбор референсов (`src/references.js`) переезжает в логику провайдера, не в `image-api.js`.

### 4.3 Генерация

Главная площадь v2. Делится на три зоны сверху вниз:

**Зона 1 — Источник сцены.** Навигатор постов:
- `← Пост #4 (🖼️ 2 генерации) →` — бейджи «есть кадр к этому посту» подтягиваются из галереи по `sourceMsgId`.
- Превью текста поста (обрезанный `message.mes`).
- На постах AI-ответов (по умолчанию ставится последний AI-пост).

**Зона 2 — Конфигурация flow.** Блоки правила построения промпта:
- Шаблон промпта (выбор из коллекции, виден превью первых строк).
- Персонажи — chips, чекбоксами какие активны (char/user слоты + кастомные через «+»).
- **Stage1 режим** (независимо): `◐ auto на новом AI-посте | ○ ручной кнопкой | ○ off`.
- **Stage2 режим** (независимо): `◐ auto после Stage1 | ○ ручной кнопкой | ○ off`.

Семантика гибридов (см. принцип 2):

| Stage1 | Stage2 | Поведение |
|---|---|---|
| auto | auto-after | Полный автомат: новый ответ модели → построить промпт → картинка → якорь к посту. |
| auto | manual | `confirm` v1, теперь живой: новый ответ → построить промпт и открыть нижнюю панель результата; картинка по кнопке «Отправить в image-API». |
| manual | auto-after | Промпт по кнопке «Построить», после готового промпта — картинка автоматически. |
| manual | manual | Полный ручной (дефолт). |
| auto | off | Только строить промпт; ничего не генерить (пригодится для просмотра LLM-интерпретации). |
| off | * | Stage2 не имеет смысла без Stage1 (UI дизейблит Stage2 при Stage1=off, либо явно требует «Построить вручную»). |

**Зона 3 — Нижняя панель результата Stage1** (`lower panel`, как в ComfyUI intermediate output):
Появляется только когда есть построенный промпт (Stage1 выполнен, в auto или manual). Содержит:
- поля `style` (textarea 2 строки), `prompt` (textarea 6 строк), `aspect_ratio` (select), `image_size` (select);
- кнопку «Сырой JSON» (toggle textarea для advanced правки — как в v1);
- главную кнопку «Отправить в image-API» (Stage2 manual);
- опционально: «Положить в очередь» (если включена очередь — см. 4.3.1);
- кнопка «Восстановить из Stage1» (вернуть исходный промпт LLM, если пользователь правил).

Раньше эта панель занимала весь таб, и конфигурация flow отсутствовала. Теперь конфигурация сверху — первична, результат снизу — вторичен.

**Зона 4 (опционально, внизу) — Очередь пакетной генерации.** Решение v2: очередь **обходит редактор только в явном режиме** и **отменяемая**:
- кнопка «В очередь» для текущего выбранного поста добавляет task.
- очередь ставит Stage1 и Stage2 подряд (`runStage1 → runStage2`), **но всегда передаёт abortController.signal в fetchWithTimeout обеих стадий**.
- виджет очереди показывает список задач + кнопку «Остановить» (ней separate abort), которая отменяет текущую и оставшиеся.
- если Stage2 в конфигурации = manual, очередь ставит только Stage1 + авто-открытие панели результата (без Stage2). Это устраняет v1-противоречие «очередь обходит редактор»: при manual-Stage2 очередь просто останавливается на готовом промпте.

### 4.4 Галерея

Режим по умолчанию: **Якорь к сообщению**, опционально **копия в ST-галерею**.

#### Хранение

```js
{
  id, ts,
  src,                  // dataUrl до save в ST; путь после save
  prompt, style, aspectRatio, imageSize,
  refsSig,              // 'char,user' / 'char' / 'user' / ''
  sourceMsgId,          // числовой индекс поста в чате (для бейджа)
  saved: bool,          // сохранено в ST-сервер
  stGalleryPath: string|null,  // путь в ST-галерее при копии
}
```

Хранилище прежнее — `uris_gallery_<chatId>` в localforage. Но способ отображения меняется: вместо отдельной сетки вкладки «Галерея» как самостоятельного контента — карточки показываются **в самой вкладке как archive-листинг**, а в чате появляются **якоря**.

#### Якорь к сообщению

Якорь — это DOM-нода, навешанная на `message.mes`-элемент поста (обёртка чата ST), **без мутации текста `message.mes`**. Реализуется `MutationObserver` на чат-контейнер (по образцу `DS Comments/feed-gestures.js` из соседнего репо):

1. При готовности галереи расширение сканирует `ctx.chat` по `sourceMsgId` и для каждого поста, у которого `items.find(i => i.sourceMsgId === msgId)` есть запись, вешает на соответствующий DOM-контейнер поста (`[mesid="<i>"]` — ST ставит такие атрибуты) иконку-якорь: `🖼️ (N)` с `data-uris-anchor="{msgId}"`.
2. Клик по якорю → открывает lightbox (полноэкранный, swipe по коллекции якорей этого поста; swipe вниз — закрытие — как в v1 lightbox).
3. Observer следит за появлением новых постов в DOM → вешает янтот бейдж, если в localforage для этого `sourceMsgId` уже есть записи (после перезагрузки страницы — автоматически).

«Мутация `message.mes` не выполняется»: продолжаем принцип автономности из v1 spec. Якорь — это DOM-only overlay, не запись в сам пост.

#### Копия в ST-галерею (опция)

Чекбокс в настройках/профиле: «Дополнительно сохранять в ST-галерею». При включении во время Stage2, после получения dataUrl от image-API, дополнительно:
- `POST /api/images/upload` с `image/base64Data, format, ch_name, filename` (как в v1 `saveImageToFile`).
- Полученный путь сохраняется в `entry.stGalleryPath` и `entry.saved = true`.
- Картинка появляется во встроенной ST-галерее как обычный сгенерировано.
- **Fallback**: если upload не удался, `entry` остаётся с dataUrl, запись не теряется. Ошибка показывается toastr, Snackbar, queer не блокирует поток.

Это сохраняет BOTH: локальный якорь-превью + архив в ST-галерее для перманентности.

#### Контент вкладки «Галерея»

Вкладка теперь — **archive-листинг + инструменты**, а не «сетка картинок» как единственный способ:
- Список всех записей текущего чата (сета со скроллом), отсортированных по `ts` обратно.
- Каждая запись: превью, дата, превью промпта, кнопки (Открыть lightbox / Сохранить в ST / Копировать промпт / Перегенерировать / Перейти к посту-источнику / Удалить).
- «Перейти к посту-источнику» — скроллит чат к `message.mes` с этим `sourceMsgId` и подсвечивает якорь (связь пост↔картинка явно видна, в отличие от v1).
- «Перегенерировать» в v2 — **с возможностью «Перегенерировать с новым промптом»** (повторить Stage1) и «Перегенерировать с тем же промптом» (только Stage2, как в v1). Это закрывает v1-недостаток: нельзя было построить заново промпт того же поста.
- Тулбар: «Очистить все», «Сохранить всё в ST», счётчик.

### 4.5 Профили

Бывшая «Привязка к чату», но переименованная и расширена до **именованных бандлов**.

#### Сущность бандла

```js
{
  id, name,
  textProfileId,          // id text-connection профиля
  imageProfileId,         // id image-connection профиля
  referencesProfileId,    // id профиля референсов
  templatesIds: [],       // массив id шаблонов (порядок = priority; первый активный по умолчанию)
  characterIds: [],      // активные персонажи
  stage1Mode,             // 'auto'|'manual'|'off'
  stage2Mode,             // 'auto-after'|'manual'|'off'
  queueSettings: { ... }, // опц.: batch-настройки очереди
  galleryMode: 'anchor'|'localforage'|'st-only',  // режим галереи (по умолчанию 'anchor')
  copyToStGallery: bool,
}
```

Хранение: `uris_bundles` в localforage (массив). `chatMetadata.uris_binding` остаётсякак storage текущего выбранного бандла — его значение теперь `{ bundleId, overrides: { ... } }`. `overrides` — точечные переопределения (например, переключил активный image-connection на время, не сохраняя в бандл).

#### UI вкладки «Профили»

- Сверху: текущий применённый к этому чату профиль (select + кнопка «Применить»).
- CRUD бандлов: список, создать/редактировать/копировать/удалить.
- Редактор бандла: выбор каждого под-профиля (text, image, references, templates, characters) через селекты, выбор Stage1/Stage2 режимов через toggle-bar (как в «Генерация», синхронизировано), режим галереи + чекбокс копии в ST.
- Кнопка «Сохранить как новый профиль» — берёт текущее состояние всех блоков из активного бандла и переопределений, создаёт новый бандл.
- Кнопка «Применить текущее состояние к этому чату» — пишет `chatMetadata.uris_binding = { bundleId: this.id, overrides: {} }` без создания нового бандла.

Это реализует **пункт 5 требований пользователя**: «все настройки в один большой пресет и закрепить за конкретным чатом».

## 5. Data flow v2

### Авто-auto-режим (Stage1=auto, Stage2=auto-after)

1. `events.js` на `GENERATION_ENDED` (если `stage1Mode === 'auto'`) находит последний AI-пост, кладёт `state.currentMsgId = i`.
2. `pipeline.runStage1` вызывается с `state.currentMsgId`:`buildSystemPrompt` + `buildUserPrompt` + активный text-connection из `state.activeTextProfileId`.
3. Промпт parsed (`parser.js`), `state.lastInstruction` сохраняется.
4. Нижняя панель результата Stage1 заполняется (если вкладка «Генерация» активна — видно сразу; если нет, якорь-уведомление «Промпт готов» при разворачивании окна).
5. Если `stage2Mode === 'auto-after'` → автоматически `pipeline.runStage2` с активным image-connection и референсами из активного references-профиля.
6. Полученный dataUrl сохраняется в `storage.addToGallery` с `sourceMsgId = i`. Обсервер вешает якорь на этот пост DOM. Если `copyToStGallery` — параллельно `POST /api/images/upload`.

### Manual-Stage2 (Stage1=auto, Stage2=manual)

То же до шага 4 включительно. Затем пользователь правит промпт в нижней панели и жмёт «Отправить в image-API» — это `runStage2` с правленой инструкцией.

### Manual-Stage1 (Stage1=manual)

`GENERATION_ENDED` игнорируется. Пользователь сам выбирает пост навигатором, жмёт «Построить промпт» — это `runStage1` для `state.currentMsgId`.

### Очередь пакетной генерации

- Stage2=manual в conf → очередь ставит только Stage1, Stage2 ждёт кнопку.
- Stage2=auto-after в conf → очередь креfull pipeline одна задача, но abortable в любой момент.
- `state.abortController` прокидывается в `fetchWithTimeout` обеих стадий через параметр `signal` (провайдеры обязаны его уважать).

## 6. Модель данных v2

### Новые сущности

| Ключ localforage | Содержимое |
|---|---|
| `uris_references_profiles` | Массив профилей референсов (новая сущность) |
| `uris_bundles` | Массив именованных бандлов (новая сущность поверх бывшей привязки) |

### Изменённые

| Сущность | v1 | v2 |
|---|---|---|
| Text-пресет | `apiType: 'openai'\|'gemini'` | `provider: 'openai-like'\|'gemini'` (openai остаётся в向后 compat алиаса) |
| Image-пресет | `apiType`, `size`, `quality`, `aspectRatio`, `imageSize`, `sendCharAvatar` и др. | `provider`, провайдер-specific поля; галки референсов **уезжают в references-профиль** |
| `chatMetadata.uris_binding` | `{ textPresetId, imagePresetId, characterIds, templateId }` (4 id'шника) | `{ bundleId, overrides: { ... } }` (один id бандла + точечные переопределения) |

### Без изменений

- `uris_text_presets`, `uris_image_presets` (форма дополняется `provider`, но список пре-существует)
- `uris_characters`, `uris_templates` — без изменений
- `uris_gallery_<chatId>`, `uris_prompt_history_<chatId>` — без изменений (gallery entry добавляет `stGalleryPath`)

## 7. Архитектура модулей v2

### Без концептуальных изменений

- `src/core.js` — state, defaults (расширяется `stage1Mode`/`stage2Mode` вместо `generationMode`), utils (log, escapeHtml, debounce, fetchWithTimeout с уважаемым signal, modal-обёртки)
- `src/presets.js` — CRUD; добавляются `listReferencesProfiles/createReferencesProfile/...`, `listBundles/createBundle/...`
- `src/parser.js` — без изменений
- `src/prompt-builder.js` — без изменений (персонажи и шаблоны те же)
- `src/storage.js` — без изменений (entry добавляет опц. `stGalleryPath`)
- `src/history.js` — без изменений (но optionally расширить запись: `[{ prompt, ts, style, sourceMsgId }]` вместо строк, для информативной истории; см. 8.5)
- `src/ui/window.js` — плавающее окно/мобайл без изменений
- `src/ui/tabs.js` — каркас без изменений (просто 5 вкладок вместо 3)
- `src/ui/lightbox.js` — без изменений (используется для клика по якорю)

### Новые модули

```
src/
├─ providers/
│  ├─ base.js        ← интерфейс: generateText(p, system, user, signal), generateImage(p, instr, refs, signal)
│  ├─ openai.js      ← OpenAI-like /chat/completions, /images/generations
│  ├─ gemini.js      ← generateContent, imageConfig
│  ├─ comfyui.js    ← /prompt queue + /history poll + /view (MVP v2)
│  └─ a1111.js       ← stub на будущее (опц.)
├─ references-profiles.js  ← CRUD профилей референсов
├─ bundles.js              ← CRUD бандлов + applyBundleToChat
├─ ui/
│  ├─ tab-api.js           ← бывший tab-presets (text/image секции); референсы уходят в свою
│  ├─ tab-references.js    ← новая вкладка
│  ├─ tab-generate.js      ← переписан: конфиг flow сверху + нижняя панель Stage1
│  ├─ tab-gallery.js       ← архивный листинг + кнопка «перейти к посту»
│  ├─ tab-profiles.js      ← новая: бандлы
│  └─ post-anchor.js       ← MutationObserver + render якорей
```

### Переписываемые

- `src/text-api.js`, `src/image-api.js` — заменяются тонкими функциями-диспетчерами, которые resolve провайдера из `provider` поля пресета и делегируют в `src/providers/*`. Поведение OpenAI/Gemini выносится из них в провайдеры.
- `src/references.js` —split: сбор аватаров (`getCharacterAvatarDataUrl/getUserAvatarDataUrl`) остаётся общим, **кодирование под конкретный API и инструкция для него** переносится в провайдер. Убирается дублирование переключателей `sendCharAvatar` vs `referenceMode`.
- `src/pipeline.js` — `runStage1`, `runStage2` теперь принимают `signal: AbortSignal` и передают далее; `runFullPipeline` (для очереди) тот же. Hathom resolve профилей через `state.activeReferencesProfileId`, не через старую привязку.
- `src/events.js` — `handler` делит на `handleStage1Event` и `handleStage2Event`; trigger на `GENERATION_ENDED` срабатывает только если `stage1Mode === 'auto'`. Stage2 trigger — на «Stage1 готов» (callback), если `stage2Mode === 'auto-after'`.
- `src/chat-binding.js` — обёрнуется `bundles.js`: `getBinding()` возвращает `{ bundleId, overrides }`, `applyBindingForCurrentChat` расшифровывает бандл → разложение в state.

### index.js

`init()` порядок:
1. `loadSettings`, миграция v1-settings (если есть `generationMode`, перевести в `stage1Mode/stage2Mode`).
2. `ensureDefaultTemplate`, `ensureBuiltinCharacterSlots`.
3. `migrateV1Presets` — translate `apiType` to `provider`, оторвать галки референсов от image-пресетов в новые references-профили.
4. `register 5 вкладок`.
5. `mountPanel`, `renderTabs`, `setActiveTab('generate')`.
6. `applyBindingForCurrentChat` (теперь — применяет бандл).
7. `bindEvents`.
8. `initPostAnchorObserver` (новый observer; остановка на cleanup).

## 8. Дополнения и закрытие v1-недочётов (из продуктового ревью)

1. **`confirm` уходит как сущность.** Вместо него две независимые настройки (см. принцип 2). Живой режим `confirm = Stage1=auto, Stage2=manual`.
2. **Очередь с редактором и отменой.** Stage2=manual → очередь останавливается на готовом промпте. AbortController уважается на обеих стадиях (см. 4.3.1). Кнопка «Остановить» очередную валидна.
3. **Связь пост↔картинка.** Якорь на DOM + бейджи в навигаторе + кнопка «Перейти к посту» в галерее (см. 4.4 + 4.3 зона 1).
4. **Дублирование референсов убрано.** `referenceMode` vs `sendCharAvatar` — одно переключение «режим референсов» на references-профиле + галки выбора источников (char avatar / user avatar / custom).
5. **История промптов информативна.** Рекомендуется хранить объекты вместо строк: `{ prompt, ts, style, sourceMsgId }`. Дропдаун показывает `15:32 · стиль «seinen» · #4 Alice зашла…`. Не блокер v2, но в spec фиксировано.
6. **Безопасное сохранение в ST.** Upload errors не затирают `src` dataUrl. Файл заменяется путём только после успешного upload (см. 4.4 Копия в ST-галерею).
7. **Режимы `mode: 'never'` упрощается.** В references-профиле остаётся `mode: 'never'|'always'` только как глобальная галка «выключить референсы Favorites Независимо от провайдера». Реальное управление — галки `charAvatar/userAvatarFile/custom`.
8. **Реальная поддержка локальных эндпоинтов (LM Studio, ComfyUI)** — провайдеры (см. 2, 4.1).
9. **Безопасность вёрстки пресетов.** Значения endpoint'ов входят через DOM-API (createElement + свойство value), а не через конкат в `innerHTML` с `escapeHtml`, чтобы кавычки в URL не ломали вёрстку. Рекомендация для всего UI-рендера пресетов в v2.
10. **Hyбypass промежуточных инструкций на русском для image-API.** Инструкция для image-API про референсы (`buildReferenceInstruction`) была на русском, хотя prompt — на английском. v2 — текст к image-API только на английском, русском только русский SFX и speech bubbles внутри prompt (по шаблону).
11. **Подгрузка списка моделей (`src/models.js`).** В v1 поле «Модель» было ручным `<input>` (`tab-presets.js:87,109`); пользователь должен знать имя наизусть, опечатка → `404 model not found` без подсказки. Особенно болезненно для:
    - **LM Studio** — список живой, зависит от загруженных `.gguf`; `GET /v1/models` экспозит его, но расширение не дёргает.
    - **OpenAI cloud** — `/v1/models` возвращает весь catalog, включая чат-only модели, которые упадут в `/images/generations` с `400 model does not support images`. Нужен whitelist по известным image-API моделям (`dall-e-3`, `dall-e-2`, `gpt-image-1` и по имени `/^(dall-e|gpt-image)/i`).
    - **Gemini** — `/v1beta/models` возвращает embed-only и image-only-through-`predict` (Imagen) наравне с `generateContent`-моделями. Нужен фильтр по `supportedGenerationMethods.includes('generateContent')` для text-kind, и по known-image-линейкам (`gemini-2.*image`, `imagen`) для image-kind.

    В v2 модуль `src/models.js` вводит `listModels(profile, kind) → [{id, label, ok, reason}]` и `validateModel(profile, kind, modelId)`. UI в `tab-api.js` (Task 17): поле модели — `<select>` + кнопка «🔄 Обновить список» (по образцу `uris-refresh-avatars`). Модели с `ok=false` рендерятся как `<option disabled>` с пометкой `(⚠️ <reason>)` — selectable нельзя, но видны для диагностики. **Safe fallback:** если `listModels()` бросил (401/403/5xx, network, LM Studio off) →.toastr.warning + поле переключается в `<input>` для ручного ввода; сохранение пресета не блокируется. Refresh кешируется на 5 мин в `state.modelsCache[profileId|kind]`; кеш инвалидируется при изменении endpoint/apiKey. Для **comfyui** поле model скрыто — модель — это поле `ckpt_name`/`unet_name` в workflow JSON ноды, и его пользователь задаёт в ComfyUI UI, не в расширении. Для **a1111** (stub) — coming soon.

    Это закрывает искусственное «модели не пробрасываются в список»: в v2 пробрасываются **все** доступные в API, фильтруются только несовместимые методы (видны, но disabled), а при невозможности получить list UI откатывается на ручной ввод.

## 9. Сценарии пользователя (как из любого момента чата получить кадр)

### A. «Я только что получила длинный ответ персонажа, хочу кадр»

- Setting: бандл «Манга-сессия», Stage1=auto, Stage2=manual.
- После `GENERATION_ENDED`: Stage1 запускается автоматически → в нижней панели вкладки «Генерация» появляется промпт…
- Я открываю окно, вижу заполненные поля, правлю при необходимости, жму «Отправить в image-API».
- Картинка приходит, якорь 🖼️ (1) появляется на этом посте.

### B. «Хочу перечитать старую сцену и сделать кадр к ней»

- Переключаюсь в «Генерацию», навигатором постов листаю назад, вижу `Пост #12 (🖼️ 1 генерация)` — у этого уже есть кадр; пролистываю дальше до `Пост #6`.
- Жму «Построить промпт» (Stage1=manual в этом бандле) → в нижней панели — готовый промпт.
- Жму «Отправить в image-API». Якорь вешается на Пост #6.

### C. «Поехали по всем недавним постам, поставь кадр к каждому»

- Stage2 = auto-after, беру навигатором Пост #20, Пост #22, Пост #24 → жму «В очередь» на каждом.
- Внизу списка очереди видно 3 задачи; кнопка «Остановить» — могу отменить, если передумаю.
- К каждому посту последовательно появляется якорь.

### D. «Хочу локально, без OpenAI вообще (LM Studio + ComfyUI)»

- Во вкладке API создаю text-connection «LM Studio local»: provider=openai-like, endpoint=`http://127.0.0.1:1234/v1`, apiKey=`lm-studio`, model из models list.
- Создаю image-connection «ComfyUI local»: provider=comfyui, endpoint=`http://127.0.0.1:8188`, workflow JSON залетает в textarea, `text_node_id` = id ноды CLIPTextEncode для prompt; output node id = id SaveImage ноды.
- Создаю бандл «Локальная сессия» с этими профилями. Применяю к чату. Дальше любой из сценариев A–C работает без выхода в облако.

## 10. Что НЕ входит в v2 MVP (YAGNI)

- **A1111 / SD WebUI провайдер** — только stub, не реализуется в первой волне. Слой провайдеров готов принять.
- **Tag_controls (тег-управляемые референсы из чата)** — нет тегов в чате.
- **Генерация вариаций (3 альтернативы через text-LLM)** — отложено.
- **Multimodal text-LLM** (передача аватаров как референсов в Stage1 text-LLM) — пока текст-описание персонажей только.
- **User-friendly редактор workflow JSON для ComfyUI** — в MVP v2 загружается raw JSON; визуальный граф-builder вынесен за рамки. Параметр подстановки `text_node_id` — простое текстовое поле ввода.
- **Вставка картинки в `message.mes`** — нет, остаётся принцип автономности. Только DOM-якорь.
- **Тест-фреймворк** — без изменений относительно v1: верификация через `node --check` и ручная загрузка в SillyTavern.

## 11. Риски и валидация

### Риски

- **ComfyUI protokol implementation** — критичный путь. `POST /prompt` возвращает `prompt_id`, `/history/{id}` возвращает статус + изображения; флоу с polling'ом может быть неустойчив против скорой генерации. Подлежит проверке на локальном ComfyUI до объявления «готово».
- **MutationObserver на чат-контейнер** — ST может рендерить/перерендерить посты при scroll/virtualization. Якорь нужно навешивать per-пост детекторов, а не single-shot один раз.
- **Миграция v1→v2 настроек** — брокардинг `apiType → provider` и отрыв `sendCharAvatar` от image-пресета. Нужен `migrateV1Presets` в `init()`, обратимый и молчаливый (с `log`).
- **Перерисовка вкладок** — переход с 3 на 5 вкладок: проверить mobile fullscreen, что 5 кнопок не привышают ширину.

### Валидация

- `node --check` для всех модулей после каждой итерации.
- Демонстрация каждого из 4 гибридов Stage1/Stage2 на одном чате с одним template и одной парой профилей (OpenAI/Gemini).
- ComfyUI локально: простой workflow (CLIPTextEncode → KSampler → SaveImage) + текст подстановка (`text_node_id`) + аватар через LoadImage.
- Якорь: сгенерировать картинку к посту #10 → переключить чат → вернуться → бейдж должен сохраниться.

## 12. Ссылки

- v1 spec: `docs/superpowers/specs/2026-06-27-ur-image-studio-design.md`
- Продуктовое ревью 2026-07-01 (в чате, дублировано здесь ключевые пункты).- Шаблон prompt (default) — прежний, из `src/default-template.js`, сохраняется.

---

План v2 ожидается отдельным документом (`docs/superpowers/plans/2026-07-01-ur-image-studio-v2-plan.md`) после согласования этого spec'а.

---

## Приложение A. Референсы из похожих расширений (поиск 2026-07-01)

Найдено через GitHub search. Помогли сверить решения v2 с живой практикой ST-комьюнити.

### A.1 `wickedcode01/st-image-auto-generation` (111★) — главный референс

Главный архитектурный приём: **прикрепляет изображения через встроенную ST-систему media**, а не через `innerHTML` в DOM. Из кода `index.js`:

- **События ST:** `event_types.CHAT_COMPLETION_PROMPT_READY` — inject инструкций в LLM-prompt перед генерацией (по `depth` и `role`); `event_types.MESSAGE_RECEIVED` → `handleIncomingMessage`; `eventSource.emit(event_types.MESSAGE_UPDATED, ...)` — триггер перерисовки чата после замены тега картинкой.
- **DOM anchor по `mesid`:** `$(\`.mes[mesid="${context.chat.length - 1}"]\`)` — ST выставляет `mesid` на ноду поста, селектор自己是 надёжный.
- **Нативная media-система вместо сырого `<img>` в DOM:** `message.extra.image_swipes` (массив «свайпов» картинок у поста), `message.extra.image` (текущая), `appendMediaToMessage(message, messageElement)` — рендерит встроенный ST-виджет. После: `context.saveChat()` для persist.
- **Три режима инъекции** (`INSERT_TYPE`): 
  - `INLINE` → добавляет в свайпы, родной media-display pipeline (картинка показывается как SWIPE ST).
  - `REPLACE` → мутирует `message.mes` (заменяет тег на `<img>`), после — `updateMessageBlock` для перерисовки. Поддержка ST-виджетов теряется.
  - `NEW_MESSAGE` → slash-команда сама создаёт отдельный пост под картинку. Лучшая совместимость, но ломает связь пост↔картинка.
- **Race-safe для нескольких тегов в одном ответе:** `for...of` + `await` последовательно — никакого параллельного fire-and-forget. Никакого token/lock-механизма нет.
- **Вызов генерации:** `SlashCommandParser.commands['sd'].callback(...)` — делегирует в нативный ST `/sd` slash-command (по сути ST'sA1111/ComfyUI-native pipeline). Это для нас **не подходит**: мы хотим свой prompt в свою localforage-галерею, а не ST-message.extra. Но pattern hook-into-native-API — полезен.

**Что мы берём для v2:**
1. Селектор `.mes[mesid="N"]` для якорей — реальный ST-интерефейс, не выдуманный нами.
2. Три режима инъекции — повторяет наш выбор: `anchor` (= REPLACE без мутации mes, только DOM-оверлей) и `st-only` (= INLINE через `message.extra` / `/api/images/upload`). Режим `NEW_MESSAGE` мы сознательно **не** делаем — он ломает связь sourceMsgId↔пost (явно отмечено в наших сценариях A–C).
3. Race-safe: **предзапомнить `sourceMsgId` до Stage1, перепроверить на этапе вставки после Stage2** (если пост удалили/отсвайпали/отредактировали — skip). У wickedcode просто sequential loop; v2 поддержит и отмену через AbortController.

### A.2 `ets1odoo-beep/st-image-auto-generation` (fork, "race-safe inline image handling")

Дополнительные идеи по сравнению с оригиналом:
- **Capture original message target до старта генерации.** Если пока картинка рендерится, исходный пост был swiped/edited/deleted, замена **скипается** — без ошибок. Именно это у нас в v2 risks был «связь пост↔картинка оторвана», теперь есть concrete паттерн как чинить.
- **Queue Concurrency setting** — limit=1 для ComfyUI / low-VRAM. Чтобы не положить backend.
- **Generation Delay** — ждать N мс после завершения AI-сообщения перед инъекцией. Снижает соперничество со ST-рендером и собственным GENERATION pipeline.

**Что мы берём для v2:**
- `queueSettings.concurrency` в бандле (по умолчанию 1, что соответствует нашему `queueRunning` single-flight, но расширяется на будущее).
- `queueSettings.generationDelayMs` — пауза между Stage2-done и anchor-инъекцией (мини).
- Pre-flight check:`if (!ctx.chat?.[storedSourceMsgId] || ctx.chat[storedSourceMsgId].mes !== storedMesHash) skip` — не вешать якорь на изменившийся/исчезнувший пост.

### A.3 Паттерны из других найденных расширений

- **`shanmaocc/Text-Image-Generator`** — заявлен как «AI prompt generation + ComfyUI integration». Подтверждает, что двухстадийный flow (text LLM строит промпт → ComfyUI рендерит) — не уникальная наша идея и реалhy feasible.
- **`krisshen2021/live-msg-inline-Img-generator`** — inline-инъекция через `<span data-prompt=... data-img-gen=...>` внутри `message.mes` (замена спан на контейнер с картинкой). Это другой подход — он **мутирует** `mes`, что ломает наш принцип автономности. Не берём как референс; подтверждает, что DOM-only anchor — более чистый путь.
- **`djdembeck/...Autopilot`** — «parallel image generation». Подтверждает, что очередь/конкурентность — ожидаемая фича; мы делаем проще (sequential + abort), этого достаточно для MVP.

### A.4 ComfyUI API (по подтверждённым описаниям; конкретные JSON-примеры не загрузились из-за таймаутов github/npm)

Протоколы ComfyUI для нашего провайдера `comfyui.js`:

| Endpoint | Method | Назначение | v2 use |
|---|---|---|---|
| `/prompt` | POST | Queue workflow JSON (graph node dict). Returns `{ prompt_id, number, node_errors }`. | Stage2: отправить workflow с подставленным текстом в `text_node_id`. |
| `/history/{prompt_id}` | GET | Статус + outputs. По завершении содержит: `{ prompt_id: { outputs: { "<node_id>": { images: [{ filename, subfolder, type: "output" }] } } } }`. | Poll до `outputs`-entry. Когда есть — забрать filename у `output_node_id`. |
| `/view` | GET | Скачать сгенерированное изображение по `?filename=...&subfolder=...&type=output`. | Прочитать bytes в `data:image/png;base64,...` через `FileReader`. |
| `/upload/image` | POST (multipart) | Upload reference image (e.g. avatar). Response: `{ name, subfolder, type: "input" }`. | Stage2-comfy: загрузить аватар, подставить `{name}` в `LoadImage` ноду workflow. |
| `/object_info` | GET | Схемы всех нод (для graph-builder UI). | **Не MVP** — в v2 просто raw workflow JSON в textarea; может использоваться в будующем visual builder. |
| `/queue` | GET | Текущая очередь. | Опц. для статуса очереди upstream. |
| `/interrupt` | POST | Прервать текущую генерацию. | Mapped на пользовательскую «Остановить» через `AbortController` нашего слоя (interrupt upstream + abort fetch). |
| WebSocket `/ws` | ws | Live progress (exec_info, execution_cached, progress). | **Не MVP** — polling `/history` достаточно. |

Особенности ComfyUI vs v1-OpenAI: prompt — **не строка**, а **graph dict**, где у каждой ноды свой id и inputs. Workflow JSON пользователь заранее собирает в ComfyUI UI (save → "API format"), вставляет в textarea профиля image-connection; расширение находит текст-ноду по `text_node_id` и делает `workflow[text_node_id].inputs.text = composedPrompt`. Сeed подставляется同理 при наличии `seed_node_id`. Для референсов: аватар upload → `workflow[loadImage_node_id].inputs.image = uploadedName`.

### A.5 A1111 WebUI / Forge / reForge (опц., не MVP v2)

Single endpoint `POST /sdapi/v1/txt2img` (или `/img2img` с init_images для референсов):
- payload: `{ prompt, negative_prompt, seed, steps, cfg_scale, width, height, sampler_name, batch_size, ... }`
- response: `{ images: [base64, ...], info: { seed, ... } }`
- controlNet reference через `alwayson_scripts` extension-nesting.

Провайдер `a1111.js` готов принять — страйзáet только отправить объект payload (без ComfyUI-graph-nuance). Внесено в `src/providers/` план как stub; реализация ~50 строкей.

### A.6 Итог по приложениям

| Реализация v2 | Откуда заимствовано |
|---|---|
| `.mes[mesid="N"]` селектор для `post-anchor.js` | wickedcode01/st-image-auto-generation (нативный ST DOM) |
| Режим `st-only` галереи через `message.extra.image_swipes` + `appendMediaToMessage` | wickedcode01 — нативная media-система ST |
| Якорь без мутации `message.mes` (DOM overlay только) | отказ от `krisshen2021` (span-replace); дополнительно предзапомнить mesHash до Stage1 | 
| Pre-flight check `sourceMsgId` перед инъекцией | ets1odoo-beep/st-image-auto-generation |
| `queueSettings.concurrency` (def. 1) + `generationDelayMs` | ets1odoo-beep (для ComfyUI/low-VRAM) |
| ComfyUI провайдер (`/prompt` → poll `/history` → `/view` + `/upload/image` + `/interrupt`) | ComfyUI upstream API (по подтверждённым описаниям); spec готов, JSON-валидация на impl-фазе |
| A1111 провайдер (`/sdapi/v1/txt2img`) | Стандарт A1111 payload; stub на будующее, не MVP |
| Отказ от делегирования в ST-native `/sd` slash-команду | осознанный выбор: нам нужна своя localforage-галерея, не ST-message.extra; slash-делегирование конфликтовало бы с принципом автономности |

### A.7 Что не удалось достоверно подгрузить и что отметить как имплементационную верификацию

Из-за ограничений webhook fetch на крупные github-файлы и CAPTCHA ddg:
- Точные JSON-поля ComfyUI `/prompt` request body — нужно сверить на локальном ComfyUI на impl-фазе (см. **11. Риски**).
- Точная форма ответа `/history/{prompt_id}` с outputs.images — аналогично.
- Версии ComfyUI могут отличаться в имени полей (e.g. `data` vs `images`, как в gemini `inlineData` vs `inline_data`). Наш провайдер должен быть robusy на оба варианта (как уже сделано в `image-api.js:gemini` парсинге `inline_data|inlineData`).

Что **не** нашло подтверждения вне теорий, но остаётся в spec'е по нашему решению:
- Идея «именованных бандлов» как meta-пресет whole-flow — ни в одном найденном расширении этой сущности нет; там либо single-config, либо разрозненные settings. v2 — это улучшение, не референс; воспринимать как новый продуктовый шаг.

### A.8 `aceeenvw/notsosillynotsoimages` (fork SillyTavern — inline image generation)

> Ревью 2026-07-02. **Не входит в MVP v2** — отложен на следующую итерацию; этот блок — реестр идей и багов для отдельного брейншторма, а не обязательное требование.

**Концептуальное отличие.** Upstream строит логику на том, что LLM сама пишет тег `<img data-iig-instruction='{...}' src="[IMG:GEN]">` прямо в ответе; расширение перехватывает тег, показывает inline-спиннер, собирает референсы, генерит картинку и подменяет спиннер — картинка живёт **прямо в сообщении**. UR Image Studio — двухстадийный flow (отдельный text-LLM шаг → image-API), картинкой управляет отдельная студия; `message.mes` намеренно не мутируется. Это разные продукты, не форк-в-лоб. Архитектура и продуктовый замысел UR сильнее (модульность + ручной редактор + пресеты + галерея + история + чат-биндинги), но у upstream выше shipped-зрелость по inline-рендеру и референсам — стоит заимствовать приёмы, не концепцию.

**Идеи к заимствованию (приоритеты для следующей итерации):**

| # | Идея | Зачем | Приоритет |
|---|------|-------|-----------|
| 1 | inline-рендер: спиннер → картинка прямо в сообщении (`wrapImageWithActions`) | главное, чего нет у UR; user ожидает картинку в чате, а не «сбоку» | высокий |
| 2 | NPC-слоты + частичный матчинг имени по prompt'у (`matchNpcReferences`: слова >2 символов, case-insensitive partial) | `references.js` умеет только char+user; NPC-матч — дешёвая фича для consistency | высокий |
| 3 | компрессия референсов до 768px (`compressBase64Image` через canvas) | UR шлёт полный аватар dataURL; сжатие критично для payload'а/скорости/лимитов | высокий |
| 4 | приоритизация референсов: char → user → NPC → отбросить всё >4 | логичный fallback-каскад; у UR нет ни лимита 4, ни приоритезации | средний |
| 5 | парсер tag'а через `braceCount`, а не regex | regex `/data-iig-instruction\s*=\s*['"]([\s\S]*?)['"]/i` обрывается на внутренней кавычке (см. баг 4 ниже); safe-scan надёжнее | высокий |
| 6 | error SVG-плейсхолдер + ленивый резолв пути (`getErrorImagePath`: `script[src*="index.js"]`, fallback через HEAD) | у UR нет neither ошибки-картинки, ни fallback; дешёвая полировка UX | средний |
| 7 | inline-контролы: hover (desktop) / tap+4s autohide (mobile) / double-tap lightbox | lightbox у UR только для галереи; inline-обёртка — вместе с п.1 | средний |
| 8 | кнопка «regenerate all images» в message menu (`.extraMesButtons`) | дешёвая и понятная точка входа; у UR только `navigatePosts` | средний |
| 9 | Naistera backend + retry на `grok_refs_temporarily_unavailable` | расширяет supported-матрицу на бесплатный бэкенд | низкий |
| 10 | iOS transport/timeout adjustments | у UR есть `generationTimeout`, но без iOS-специфики | низкий |
| 11 | legacy `[IMG:GEN:...]` формат | бесплатная совместимость со старыми промпт-шаблонами | низкий |

**Баги текущей базы UR (критично, фиксить в v2 до брейншторма):**

1. `image-api.js` `callOpenAI` — image-to-image сломан: `body.image` отправляется на `/v1/images/generations`, который **не принимает** `image` (для i2i нужен `/v1/images/edits` с multipart). Референсы на OpenAI молча игнорируются.
2. `image-api.js` size-mapping хардкодит только `1:1/16:9/9:16`; остальные 8 значений из `VALID_ASPECT_RATIOS` тихо падают в `1024x1024`.
3. `pipeline.js`/`fetchWithTimeout` — `AbortController` не доходит до fetch: `fetchWithTimeout` создаёт свой собственный, не принимает внешний сигнал; отмена генерации **не** отменяет летящий запрос.
4. `parser.js` regex `([\s\S]*?)['"]` non-greedy обрывается на первой внутренней кавычке → ломает JSON с `style: "..."`.
5. `events.js` `makeLast(GENERATION_ENDED, ...)` стреляет и после regenerate; в auto-режиме возможен loop регенерации (Stage 1 триггерит GENERATION_ENDED → снова авто-ген). Нужен guard «не реагировать на собственный Stage-1 ответ».
6. `storage.js`/`defaultSettings` — `galleryLimit: 0` = без лимита; localforage растёт бесконечно, авто-режим в долгом чате съедает место.
7. Нет дедупликации галереи — `addToGallery` всегда `unshift`, авто-реген кладёт копии.
8. `decodeEntities` ловит только 5 сущностей, не общий numeric `&#NN;`; `parseInstructionJson` это использует.

**Итог одной фразой.** Архитектура и задумка UR на голову выше, но shipped-состояние слабее по inline-рендеру и референсам; upstream — справочник приёмов, не конкурент. Пункты 1, 5 из таблицы и баги 1–4 из списка закрывают разрыв. Выносится на отдельный брейншторм следующей итерации — не блокирует v2 MVP.