# Scene-first Generation, Stage 1 и шаблоны — дизайн

**Дата:** 2026-07-15  
**Статус:** Approved (brainstorming complete)  
**Автор:** URIS Dev + ZCode  
**Заменяет:** основной UX Generate и пользовательскую модель Stage 1 из `2026-07-11-stage1-prompt-rework-design.md`  
**Не заменяет:** provider adapters и утверждённую модель глобального reference pool

## 1. Контекст и проблема

Сейчас вкладка Generate одновременно показывает навигацию по сообщениям, выбор шаблона, ручной выбор карточек персонажей, режимы двух стадий, flow-фильтр, reference controls, итоговый prompt, параметры изображения, structured draft, kind, style override, raw JSON, очередь и историю. Внутренняя схема Stage 1 стала частью основного пользовательского интерфейса, хотя image-провайдерам в конечном счёте нужны только готовый prompt, параметры изображения и поддерживаемые изображения-референсы.

Текущая модель создаёт несколько проблем:

1. Пользователь должен понимать `kind`, registry fields, structured JSON, flatten и режимы Stage 1/Stage 2 до того, как сможет выполнить обычную генерацию.
2. `Stage 1: off/manual/auto` и `Stage 2: off/manual/auto-after` выглядят как доступность стадий, хотя фактически в основном управляют автоматическими событиями.
3. Prompt хранится фактически на уровне чата и может визуально или логически разойтись с выбранным сообщением.
4. Карточки bundle-персонажей отправляются в Stage 1 независимо от присутствия в сцене, а текстовые и графические reference flows разрешаются раздельно.
5. Smart matching разбивает многословное имя на токены и может считать совпадением одно распространённое слово.
6. Universal Stage 1 adapter может скрыто вызвать дополнительный LLM-запрос для нормализации нестандартного JSON, создавая неочевидные расходы и задержку.
7. Новая установка должна позволять работать без сохранённых пользовательских шаблонов, а создание шаблона должно начинаться с пустого содержимого.

Целевая ментальная модель:

```text
Сцена → построенный и редактируемый prompt → изображение
          Stage 1                       Stage 2
```

Видимый prompt — центральный объект вкладки и основной контроль пользователя над тем, что отправляется image-провайдеру.

## 2. Цели и принципы

### 2.1. Цели

- Дать обычному пользователю простой flow, похожий на ChatGPT или Gemini: выбрать сцену, проверить prompt, настроить параметры и создать изображение.
- Всегда показывать результат Stage 1 и разрешать его редактирование.
- Сохранить отдельные Stage 1 и Stage 2 для ручной проверки и power-user сценариев.
- Локально и детерминированно определять присутствующих персонажей без дополнительных LLM-запросов.
- Использовать один снимок scene context для UI, Stage 1 и Stage 2.
- Показывать в `#urisRefsPanel` только эффективные референсы выбранной сцены и разрешать corrections для конкретного сообщения.
- Начинать с нуля пользовательских шаблонов, но сохранять существующие пользовательские schema-v3 templates.
- Поддержать два явных типа шаблонов: полная инструкция Stage 1 и конструктор произвольных полей.
- Сделать создание шаблона из естественного описания экспериментальной opt-in функцией.
- Не выполнять скрытых дополнительных LLM-запросов.
- Сохранить текущий общий provider contract и адаптацию к Gemini, OpenAI-like, Pollinations и Agnes.

### 2.2. Не цели

- Семантическое распознавание местоимений и косвенных упоминаний без LLM.
- Морфологический анализ имён, не перечисленных в aliases.
- Реализация lorebook integration в рамках этой итерации; проектируется только точка расширения.
- Полная унификация provider-specific capabilities.
- Автоматическое удаление пользовательских шаблонов.
- Визуальный язык программирования с произвольным mapping любых output fields в provider API.

### 2.3. Основные принципы

1. **Progressive disclosure:** обычный flow не требует знания внутренних схем; power-user controls раскрываются отдельно.
2. **Prompt first:** видимый textarea prompt остаётся источником следующего ручного Stage 2.
3. **One resolver, one snapshot:** UI и обе стадии не выполняют независимый matching.
4. **No hidden spend:** один запуск Stage 1 означает один text-LLM request.
5. **Message-scoped state:** prompt, параметры и reference corrections принадлежат `chatId + msgId`.
6. **Provider boundary:** provider adapters получают только итоговый instruction и изображения.
7. **Iterative UX:** подписи и расположение блоков можно корректировать после живого теста без изменения доменных контрактов.

## 3. Пользовательский интерфейс Generate

### 3.1. Базовая компоновка

```text
┌─ Генерация ────────────────────────────────────────────────┐
│ ‹              Сообщение 48 из 126                  ›      │
│                                                           │
│ Шаблон                                                     │
│ [ Без шаблона — базовое построение                   ▼ ]   │
│                                                           │
│ ┌─ Референсы сцены ──────────────────────────────────────┐ │
│ │ [img] {{char}} ×   [img] Роза ×   [img] Дерек ×   [+] │ │
│ │ ⚠ «Алекс» неоднозначен                         [Выбрать]│ │
│ └───────────────────────────────────────────────────────┘ │
│                                                           │
│ ┌─ Prompt изображения ───────────────────────────────────┐ │
│ │ A blond prince in ornate Renaissance attire rides... │ │
│ └───────────────────────────────────────────────────────┘ │
│                                                           │
│ [Перестроить prompt]                                      │
│                                                           │
│ Стороны [9:16 ▼]  Размер [2K ▼]  Качество [Auto ▼]        │
│                                                           │
│ [Добавить в очередь]               [Создать изображение]   │
│                                                           │
│ ▸ Дополнительно                                           │
└───────────────────────────────────────────────────────────┘
```

Prompt отображается всегда. До первого построения область содержит пустое состояние и кнопку `Построить prompt`; после построения становится редактируемым textarea.

### 3.2. Ручной Stage 2

- `Построить prompt` выполняет только Stage 1.
- Непустой prompt можно проверить и изменить.
- `Создать изображение` при непустом prompt создаёт immutable Stage 2 snapshot и запускает только Stage 2.
- Если prompt пуст, `Создать изображение` сначала строит prompt и останавливается, не запуская Stage 2.
- Ручные изменения prompt сохраняются перед Stage 2.
- Непустой prompt никогда не перестраивается молча.
- Если `promptOrigin === "edited"`, команда `Перестроить prompt` требует подтверждения замены ручной редакции.

### 3.3. Автоматический Stage 2

При режиме полного auto-flow:

```text
Stage 1 завершилась
  ├─ prompt немедленно сохранён и отображён
  └─ Stage 2 сразу запускается со snapshot результата Stage 1
```

Prompt остаётся доступен для просмотра, редактирования и последующей регенерации. Изменения после создания Stage 2 snapshot не влияют на уже запущенный запрос.

### 3.4. Понятные automation modes

Два старых selector-а заменяются одной настройкой:

```text
Запуск после нового подходящего сообщения:

( ) Ничего не делать
( ) Автоматически построить prompt
( ) Построить prompt и создать изображение
```

Соответствие внутренним стадиям:

| Режим | Stage 1 | Stage 2 |
|---|---|---|
| Ничего не делать | вручную | вручную |
| Автоматически построить prompt | автоматически | вручную |
| Построить и создать изображение | автоматически | автоматически |

Ручные команды доступны во всех режимах. Generation flow (`AI`, `user`, `all`, `manual`) остаётся отдельным фильтром событий, если он нужен текущему auto-flow.

### 3.5. Power-user секция

Итоговый prompt не скрывается в advanced mode. В `Дополнительно` находятся только диагностика и специализированные controls:

- технический результат Stage 1;
- контекст, переданный Stage 1;
- snapshot последней Stage 2;
- origin prompt;
- resolved entity IDs;
- structured draft и field editor, только если выбран fields template;
- сырой ответ Stage 1 только для диагностики ошибки.

`kind`, raw JSON и style override не занимают основной экран. Legacy structured templates могут временно показывать совместимые controls в power-user секции.

### 3.6. Очередь

Очередь предлагает две явные операции:

1. `Построить prompt и создать изображение` — full pipeline по сцене.
2. `Добавить текущий prompt в очередь` — Stage 2 с текущей редакцией без повторного Stage 1.

Очередь не должна молча решать, использовать существующий prompt или перестраивать его.

## 4. Scene Context Resolver

### 4.1. Назначение

Перед Stage 1 и Stage 2 локальный resolver строит единое представление контекста выбранного сообщения:

```text
Текст сцены
  + имена/aliases {{char}}
  + имена/aliases {{user}}
  + имена/aliases reference pool
  + corrections для msgId
  + lorebook entries в будущем
                 │
                 ▼
          SceneContextSnapshot
            ├─→ Generate UI
            ├─→ Stage 1 text context
            └─→ Stage 2 image refs
```

Resolver не вызывает нейросеть и не расходует токены.

### 4.2. Данные сущности

Минимальные данные для matching:

```js
{
  id: "aria-rose",
  role: "npc", // char | user | npc
  name: "Aria Rose",
  aliases: ["Aria", "Rose", "Ария", "Роза"],
  description: "...",
  imagePath: "..."
}
```

Reference pool получает отдельное поле `aliases`. `keywords` сохраняются для организации и поиска по библиотеке, но не используются как доказательство присутствия в сцене.

Aliases для `{{char}}` и `{{user}}` также задаются явно. Их canonical name берётся из текущего SillyTavern character/persona context.

### 4.3. Строгий matching

Совпадением считается:

1. полное `name` как цельная фраза;
2. любой явно записанный alias как цельная фраза;
3. Unicode-aware, case-insensitive match;
4. match только на границах буквенно-цифрового слова;
5. одна сущность возвращается один раз, даже если найдено несколько её имён.

Не считается совпадением:

- автоматически выделенная часть полного имени;
- keyword;
- слово из description;
- подстрока внутри другого слова;
- местоимение;
- косвенное описание;
- неуказанная словоформа.

`{{char}}` и `{{user}}` включаются только при таком же точном распознавании либо ручном добавлении. Они не считаются присутствующими только из-за своей роли в чате.

### 4.4. Порядок и позиции

Resolver сохраняет позицию первого совпадения каждого NPC в сцене. Эффективный стабильный порядок для provider refs:

1. ручные включения пользователя;
2. `{{char}}`;
3. `{{user}}`;
4. автоматически найденные NPC в порядке первого упоминания.

Порядок виден в панели, так как provider cap может отбросить хвост.

### 4.5. Неоднозначности

Если одна и та же match-фраза принадлежит нескольким сущностям, resolver не включает ни одну автоматически:

```text
⚠ «Алекс» соответствует нескольким персонажам
[Выбрать: Alexander Reed / Alexandra Stone]
```

Выбранная сущность сохраняется как manual include для конкретного сообщения. До выбора неоднозначные сущности не участвуют ни в Stage 1, ни в Stage 2.

### 4.6. Corrections для сообщения

Для `chatId + msgId` сохраняются:

```js
{
  includedIds: [],
  excludedIds: []
}
```

Эффективный набор:

```text
(autoDetected − excludedIds) ∪ includedIds
```

Правила:

- `×` добавляет entity ID в exclusions текущего сообщения;
- `+` открывает pool picker и добавляет entity ID в inclusions;
- повторное ручное добавление автоматически найденной, ранее исключённой сущности удаляет exclusion;
- corrections переживают переключение вкладки и перезагрузку;
- corrections не меняют глобальный pool и не действуют на другие сообщения.

### 4.7. `#urisRefsPanel`

Панель показывает только эффективные сущности выбранной сцены и unresolved ambiguities. Она больше не показывает:

- все потенциальные extras;
- отдельные списки Stage 1 descriptions и Stage 2 images;
- `never / smart / always`;
- пустые char/user slots;
- нераспознанные сущности.

Одна сущность может иметь разные capabilities:

| Сущность | Stage 1 text | Stage 2 image |
|---|---:|---:|
| `{{char}}` | character card при наличии | avatar при наличии |
| `{{user}}` | persona card при наличии | avatar при наличии |
| NPC | pool description при наличии | pool image при наличии |

Панель обозначает это компактно (`T`, `I`, `T+I`) и показывает provider warnings до запуска.

### 4.8. Snapshot и revision

При запуске Stage 1 создаётся immutable snapshot:

```js
{
  chatId,
  msgId,
  messageHash,
  contextRevision,
  entities: [],
  stage1Descriptions: [],
  stage2Refs: [],
  ambiguities: [],
  lorebookEntries: []
}
```

- Stage 1 и auto Stage 2 используют один snapshot.
- Переключение выбранного сообщения не меняет принадлежность результата.
- Corrections после старта увеличивают revision и применяются к следующему запуску.
- UI помечает готовый prompt как потенциально устаревший: `Контекст изменён — перестройте prompt`.
- Lorebook в будущем добавляет только текстовый Stage 1 context и не становится image reference автоматически.

## 5. Stage 1

### 5.1. Ответственность

Stage 1 преобразует сцену, локально собранный контекст и инструкцию шаблона в готовый image prompt.

Она не:

- распознаёт персонажей;
- выбирает изображения;
- вызывает дополнительную модель;
- генерирует изображение;
- требует от обычного пользователя видеть промежуточные поля.

### 5.2. Работа без пользовательского шаблона

Новая установка содержит ноль пользовательских templates. Selector показывает:

```text
Без шаблона — базовое построение
```

Это не объект в пользовательской библиотеке, а встроенная минимальная инструкция приложения. Её смысл:

- преобразовать художественную сцену в точный запрос для одного изображения;
- сохранить фактический состав, действия, взаимодействия, окружение, композицию, свет и настроение;
- использовать переданные карточки и descriptions как источник истины;
- не добавлять отсутствующих персонажей и событий;
- вернуть только готовый image prompt.

Приложение отдельно и безопасно добавляет секции `СЦЕНА`, `ПЕРСОНАЖИ СЦЕНЫ` и в будущем `LOREBOOK`.

### 5.3. Один LLM-запрос

Один запуск Stage 1 выполняет ровно один text-LLM request. Нестандартный ответ не вызывает скрытую LLM-нормализацию.

Для instruction template parser поддерживает локально:

- plain text;
- markdown fence stripping;
- `{ "prompt": "..." }`;
- известную instruction envelope текущего приложения, если это нужно для legacy.

Для fields template невалидный JSON приводит к явной ошибке и действиям:

- повторить Stage 1;
- открыть сырой ответ;
- использовать сырой ответ как prompt.

Любой повторный LLM-запрос — только явная команда пользователя.

### 5.4. Единый Stage 1 result

Оба новых типа шаблона нормализуются в:

```js
{
  prompt: "готовый текст для image provider",
  templateId: null,
  templateType: "base" | "instruction" | "fields" | "legacy-v3",
  structuredDraft: null,
  sourceMsgId: 48,
  contextRevision: 3,
  raw: null
}
```

`prompt` обязателен. `structuredDraft` и `raw` существуют только для power-user диагностики и fields templates.

## 6. Шаблоны

### 6.1. Создание с нуля

Основная команда:

```text
[Создать шаблон]
       ├─ Полная инструкция Stage 1
       └─ Конструктор полей
```

Оба типа начинаются с пустого пользовательского содержимого. Built-in preset не создаётся автоматически.

### 6.2. Полная инструкция Stage 1

Пользователь задаёт содержательную системную инструкцию, описывающую, как превратить сцену в prompt. Приложение добавляет только минимальную транспортную оболочку:

- отделение инструкции от недоверенного текста сцены;
- scene context blocks;
- требование вернуть один итоговый prompt;
- локальный parse/normalization ответа.

Пользователю не нужно вручную размещать `{{scene}}` или описывать JSON protocol.

### 6.3. Конструктор произвольных полей

Шаблон содержит упорядоченный список полей:

```js
{
  key: "camera",
  label: "Камера",
  instruction: "Укажи shot type, angle, framing и depth of field",
  required: true,
  prefix: "Camera: ",
  suffix: ""
}
```

Пользователь может:

- добавлять и удалять любые поля;
- задавать key, label и инструкцию;
- менять порядок;
- помечать required;
- оставить список пустым;
- в advanced controls задать prefix/suffix;
- задать общую head/tail оболочку prompt.

`kind` и фиксированный registry field set не обязательны. LLM возвращает структурный draft по созданной схеме, после чего deterministic assembler объединяет поля в установленном пользователем порядке. Итогом всегда становится обычный текстовый prompt.

### 6.4. Параметры по умолчанию

Оба типа templates могут содержать:

```js
{
  aspectRatioDefault: "9:16",
  imageSizeDefault: "2K",
  qualityDefault: "auto"
}
```

При выборе шаблона defaults копируются в message-scoped GenerationDraft. Далее пользователь может изменить их без изменения шаблона.

- Повторный Stage 1 не сбрасывает параметры.
- Изменение template defaults не переписывает уже созданные drafts.
- `Без шаблона` использует глобальные application defaults.

### 6.5. Существующие schema-v3 templates

Пользовательские templates сохраняются и не удаляются. Они читаются как `legacy-v3` через compatibility adapter.

Предпочтительная стратегия:

1. продолжать исполнять существующий формат;
2. показывать его как legacy structured template;
3. при возможности предлагать `Создать редактируемую копию` в новом fields format;
4. не переписывать исходник автоматически;
5. не создавать встроенные templates в пустой библиотеке.

Если безопасная конвертация невозможна, legacy template остаётся рабочим и доступным для копирования, но не обязан поддерживать полный новый editor.

### 6.6. Экспериментальное создание из описания

Глобальный тумблер по умолчанию выключен:

```text
Настройки → Экспериментальные функции
[ ] Создание шаблонов из описания
```

После включения появляется отдельная команда `Создать из описания · Experimental`.

- Интерфейс заранее предупреждает о дополнительном text-LLM request и расходе токенов.
- LLM создаёт только черновик обычного fields template.
- Черновик не сохраняется и не активируется автоматически.
- Пользователь проверяет и редактирует его перед сохранением.
- Экспериментальный flow не создаёт третий runtime template type.

## 7. GenerationDraft и хранение

### 7.1. Message-scoped draft

Источник истины привязан к `chatId + msgId`:

```js
{
  chatId: "chat-123",
  msgId: 48,
  messageHash: "...",

  templateId: null,
  prompt: "",
  promptOrigin: "empty", // empty | stage1 | edited

  aspectRatio: "9:16",
  imageSize: "2K",
  quality: "auto",

  references: {
    includedIds: [],
    excludedIds: [],
    revision: 0
  },

  stage1: {
    status: "idle", // idle | running | ready | error
    structuredDraft: null,
    contextSnapshot: null,
    builtAt: null,
    error: null
  },

  stage2: {
    status: "idle", // idle | running | ready | error
    lastSubmittedSnapshot: null,
    error: null
  }
}
```

DOM не является source of truth. Полный rerender вкладки не теряет draft.

### 7.2. Конкурентность Stage 1

Запуск фиксирует `chatId`, `msgId`, `messageHash` и context snapshot. Ответ записывается только в исходный draft.

Если пользователь перешёл на другое сообщение, текущий textarea не изменяется; при возврате результат доступен в правильном draft.

Если пользователь успел вручную изменить prompt того же draft после начала Stage 1, завершившийся запрос не должен молча затереть новую редакцию. Реализация использует run/revision token и либо сохраняет результат как pending candidate, либо показывает конфликт с явным выбором замены.

### 7.3. Stage 2 snapshot

Перед provider call создаётся неизменяемый снимок:

```js
{
  sourceMsgId: 48,
  messageHash: "...",
  prompt: "реально отправленный текст",
  aspectRatio: "9:16",
  imageSize: "2K",
  quality: "high",
  refs: [],
  templateId: null,
  contextRevision: 3,
  submittedAt: "..."
}
```

Именно snapshot сохраняется с gallery/pending entry и используется для:

- отображения реально отправленного prompt;
- повторной генерации без Stage 1;
- восстановления списка реально отправленных refs;
- диагностики provider request.

### 7.4. Queue item

```js
{
  chatId,
  msgId,
  messageHash,
  requestedAction: "full-pipeline" | "current-prompt-stage2",
  templateId,
  enqueuedAt
}
```

Для `full-pipeline` контекст разрешается при начале задачи с сохранёнными message corrections. Для `current-prompt-stage2` очередь хранит immutable Stage 2 snapshot при постановке, чтобы последующая редакция textarea не меняла задачу.

## 8. Provider boundary

Общий Stage 2 contract остаётся простым:

```js
{
  prompt,
  aspectRatio,
  imageSize,
  quality,
  references
}
```

Текущие adapters переводят его в provider-specific запросы:

- Gemini: text + inlineData refs + `imageConfig.aspectRatio/imageSize`;
- OpenAI-like: `prompt`, mapped `size`, `quality`; refs только в поддерживаемых strategies;
- Pollinations: prompt path + width/height; один ref для поддерживаемой модели;
- Agnes: `prompt`, mapped size; refs не поддерживаются.

Provider layer не получает template fields или Stage 1 schema.

UI заранее показывает capability warnings и точно отмечает, какие refs попадут под provider cap. Текстовые descriptions всё равно могут использоваться Stage 1, даже если provider не принимает image refs.

## 9. Ошибки и восстановление

### 9.1. Resolver

Неоднозначность не блокирует Stage 1 целиком; неоднозначная сущность пропускается и показывается с действием `Выбрать`.

### 9.2. Stage 1

При timeout, network или parse error:

- draft и corrections сохраняются;
- показываются `Повторить` и `Написать prompt вручную`;
- raw response доступен в диагностике, если был получен;
- Stage 2 разрешён с вручную введённым prompt;
- скрытый retry через LLM-normalization запрещён.

### 9.3. Stage 2

При ошибке provider:

- prompt и Stage 2 snapshot сохраняются;
- `Повторить с тем же snapshot` не вызывает Stage 1;
- можно изменить prompt или соединение и создать новый snapshot;
- pending image recovery продолжает защищать уже полученный provider result.

### 9.4. Изменившаяся сцена

Если `messageHash` изменился после построения prompt, draft помечается stale. Автоматическая инъекция результата в другой текст или сообщение запрещена. Пользователь может перестроить prompt по новой сцене либо оставить старую редакцию вручную.

## 10. Модульные границы

Целевые логические компоненты:

| Компонент | Ответственность |
|---|---|
| `scene-context-resolver` | Локальный matching, ambiguities, ordering, effective entities |
| `generation-drafts` | CRUD message-scoped drafts, revisions, persistence |
| `stage1-context-builder` | Безопасная сборка scene/characters/NPC/lorebook text blocks |
| `stage1-template-runtime` | Base/instruction/fields/legacy-v3 dispatch и единый result |
| `fields-template-assembler` | Schema для LLM и deterministic flatten произвольных fields |
| `stage2-snapshot` | Immutable provider input и gallery metadata |
| Generate UI | Отображение draft, refs, actions и progress; не source of truth |
| Template UI | Два editor flow и legacy copy flow |
| Provider adapters | Только перевод общего Stage 2 contract в API |

Точные имена файлов определяются implementation plan после проверки существующих patterns. Не требуется немедленно удалять registry modules: legacy-v3 adapter может продолжать их использовать до отдельной безопасной миграции.

## 11. Поэтапный переход

1. **Domain foundation:** message-scoped drafts, strict resolver, aliases, corrections и unit tests.
2. **Snapshot-safe pipeline:** Stage 1/Stage 2 принимают явный context/snapshot и не зависят от изменяемого `state.currentMsgId`.
3. **Generate UI:** новый prompt-first layout и единый automation selector.
4. **Template runtime:** base mode, instruction templates, fields templates и defaults.
5. **Template UI:** пустая библиотека, два create flows, legacy copy/read flow.
6. **Experimental flow:** глобальный feature toggle и draft creation through explicit LLM request.
7. **Cleanup:** удалить мёртвые controls и runtime branches только после подтверждения legacy compatibility.

Каждый этап должен оставлять приложение работоспособным и иметь отдельную verification boundary.

## 12. Тестирование

### 12.1. Scene resolver

- полное Unicode name;
- явные aliases;
- case-insensitive match;
- границы слов;
- отсутствие автоматического tokenization полного имени;
- keywords и descriptions не участвуют;
- `{{char}}`/`{{user}}` только по name/alias;
- duplicate alias ambiguity;
- include/exclude corrections на конкретный `msgId`;
- стабильный порядок первого упоминания;
- provider cap preview.

### 12.2. Stage 1

- base instruction без user template;
- instruction template;
- fields template с произвольным порядком;
- legacy-v3 execution;
- ровно один LLM call на запуск;
- отсутствие hidden normalization request;
- plain text/fenced/`{prompt}` local parsing;
- invalid fields JSON error flow;
- исходный `msgId` и context revision сохраняются при навигации;
- run token защищает ручную редакцию от позднего ответа.

### 12.3. Draft persistence

- разные prompts для разных сообщений;
- сохранение parameters и corrections;
- переключение вкладок;
- перезагрузка;
- применение template defaults только при выборе;
- повторный Stage 1 не сбрасывает параметры;
- stale state при изменении message hash.

### 12.4. Stage 2 и очередь

- manual Stage 2 использует текущий textarea prompt;
- пустой prompt строится без автоматического Stage 2 в manual mode;
- auto mode показывает prompt и сразу использует Stage 1 snapshot;
- редакция после старта не меняет in-flight request;
- retry использует тот же snapshot без Stage 1;
- `current-prompt-stage2` queue item immutable;
- provider получает корректные params и ограниченный ordered ref list.

### 12.5. Legacy и empty state

- существующие schema-v3 templates не удаляются;
- legacy template исполняется;
- новый fields template создаётся пустым;
- новая библиотека не получает built-in templates;
- `Без шаблона` работает без storage template;
- experimental button скрыта по умолчанию.

### 12.6. Живая UX-проверка

После первой реализации вручную проверяются:

1. новый пользователь: без templates → сцена → prompt → редакция → image;
2. full auto: новое сообщение → prompt виден → Stage 2 сразу стартовала;
3. alias collision → ручной выбор → перестроение → корректные text/image refs;
4. fields power user → field edit → prompt reassembly → Stage 2 получает видимый текст;
5. navigation race → Stage 1 для сообщения A не изменяет draft сообщения B;
6. provider without refs → warning, Stage 1 descriptions всё равно работают.

## 13. Критерии приёмки

Дизайн считается реализованным, когда:

- Generate tab позволяет выполнить основной flow без знания structured schema.
- Итоговый Stage 1 prompt всегда виден и редактируем.
- Auto Stage 2 показывает prompt и запускается со snapshot этого результата.
- Prompt, параметры и reference corrections хранятся по `chatId + msgId`.
- `#urisRefsPanel` показывает только effective scene entities и ambiguities.
- Matching использует только полное name и явные aliases без LLM и без keyword matching.
- Corrections сохраняются для сообщения и одинаково влияют на Stage 1/Stage 2.
- Один запуск Stage 1 не выполняет скрытых дополнительных LLM-запросов.
- Без пользовательского template доступен встроенный base flow, но storage library остаётся пустой.
- Можно создать пустой instruction template или пустой fields template.
- Template defaults подставляются в редактируемые controls Generate.
- Existing user schema-v3 templates не удалены и остаются исполнимыми либо доступными через документированный compatibility flow.
- Experimental template generation выключена по умолчанию и явно предупреждает о дополнительном запросе.
- Provider adapters продолжают получать простой общий Stage 2 contract.
