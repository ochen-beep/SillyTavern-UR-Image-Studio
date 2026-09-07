# References Redesign — единая панель + описания для Stage1

**Дата:** 2026-07-14
**Статус:** Approved (brainstorming complete)
**Автор:** URIS Dev

## Контекст и проблема

Система хранения и отправки референсов реализована в v3-redesign (`refs-library.js` + `tab-references.js` + `tab-generate.js`), но интерфейс запутан:

1. **Путаница двух панелей.** На вкладке «Генерация» рядом стоят два визуально похожих блока: `uris-flow-config` (настройки пайплайна генерации: шаблон, персонажи, Stage1/Stage2, flow) и `#urisRefsStatus` (панель референсов). Пользователь не понимает, где что.
2. **Дублирование управления {{char}}/{{user}}.** Постоянные настройки слотов живут во вкладке «Референсы» (`#urisRefsChat`, селекты auto/pinned). Временный Override — во вкладке «Генерация» (`#urisRefsOverrideEnabled` + чекбоксы). Два места = путаница.
3. **Баг Override UX.** В `buildOverrideControls` чекбокс {{char}}/{{user}} рендерится только если `!(o.includeChar === false)` — после снятия галки чекбокс исчезает, вернуть нельзя без «Сброс».
4. **Бестолковая иконка.** Превью auto-слотов (`slotPreview`) показывает иконку `fa-robot` вместо реального аватара {{char}}/{{user}}.
5. **Пикер без фильтров.** `showPoolPicker` (`body > div.uris-picker-overlay > div`) не имеет фильтров по папкам, хотя пул их поддерживает.
6. **Нет текстовых описаний референсов для Stage1.** Pool-item хранит только картинку. Описание NPC/локации нельзя отправить в построение промпта.

## Цели

- Единая панель управления референсами на вкладке «Генерация» (вместо read-back + Override).
- Удаление дублирующего блока настроек `#urisRefsChat` (его содержимое переезжает в единую панель).
- Превью auto-слотов с реальными аватарами {{char}}/{{user}}.
- Фильтры по папкам в пикере.
- Текстовые описания референсов, попадающие в Stage1 (построение промпта), в двух режимах: smart-детект по имени и ручное закрепление.
- Ничего не сломать: обратная совместимость данных, существующие тесты проходят.

---

## Дизайн

### Секция 1 — Модель данных

#### 1a. Pool item — поле `description`

`refs-library.js::createRef` (строки 30-47) и `updateRef` (49-61) расширяются:

```
{id, name, keywords, imagePath, folderId, createdAt, description}
```

`description: string` (опционально, по умолчанию `''`). Свободный текст внешности/деталей для Stage1. Референс без `description` работает как раньше (только картинка → Stage2). `updateRef` патчит `description` при `patch.description != null`.

Старые pool items читаются с `description: ''` через нормализацию в `getRefSync`/`getRef` — явная миграция не нужна (тот же паттерн, что у `_normalizeSlot`).

#### 1b. Chat binding — поле `descRefs`

`refs-library.js::defaultChatRefs` (113-120) и `getChatRefs` (129-139) расширяются:

```
{
  mode: 'smart',
  charSlot: {type:'auto'},
  userSlot: {type:'auto'},
  extraRefIds: [],      // картинки в Stage2 (без изменений)
  descRefs: [],         // НОВОЕ: описания в Stage1
}
```

`descRefs: Array<{refId: string, mode: 'auto' | 'pinned'}>`:
- `pinned` → описание **всегда** идёт в Stage1.
- `auto` → описание идёт в Stage1 только при smart-матче имени/keywords в тексте сцены (`isNameInText`).

`getChatRefs()` нормализует `descRefs`: фильтрует невалидные, проставляет дефолт `mode:'auto'`. Старые chat bindings читаются с `descRefs: []`.

`extraRefIds` (картинки Stage2) и `descRefs` (текст Stage1) **независимы**: один pool-item может быть в обоих, в одном или ни в одном. Существующий общий `mode` (`always`/`smart`/`never`) — фильтр **только для картинок** Stage2 и не затрагивает текст Stage1 (у которого свой per-ref режим auto/pinned).

### Секция 2 — Потоки данных

#### Stage2 (картинки) — без изменений

Путь `collectRefsForCurrentChat` → `_resolveRefs` → `imageToDataUrl`/аватары → `prepareReferences` → `gemini.inlineData` не меняется. Сигнатуры `_resolveRefs(context, override)`, `collectRefsForCurrentChat(context, override)`, `runStage2(..., opts.override)` **сохраняются** — `override` остаётся harmless-параметром (после удаления UI всегда `null`), чтобы не ломать pipeline API.

#### Stage1 (текст промпта) — новая точка инъекции

Параллельно существующему `renderCharactersBlock()` (`prompt-builder.js:25-31`) добавляется `renderRefDescriptionsBlock()`:

```
buildSystemPrompt(...) возвращает:
[head, schema, style, rules, hints, fewShot,
 chars,         // существующий (из bundle.characterIds)
 refDescs,      // НОВЫЙ блок
 JSON_ONLY_TAIL]
```

Формат нового блока (по образцу `renderCharactersBlock`):
```
=== Референсы сцены (используй ТОЛЬКО эту внешность) ===
- "Aria" (NPC): девушка с синими волосами, шрам на щеке...
- "Таверна Заря" (локация): тёмное дерево, камин...
```

#### Сборка списка для Stage1

В `runStage1` (`pipeline.js:86`), рядом с `resolveActivePresets()`, добавляется:

```
const sceneText = msg?.mes || '';
const refDescs = await collectDescRefsForCurrentChat(sceneText);
buildSystemPrompt(templateContent, activeChars, { ..., refDescriptions: refDescs });
```

Новая функция `collectDescRefsForCurrentChat(sceneText)` в `refs-library.js`:
1. `chatRefs = getChatRefs()`.
2. Для каждого `descRefs`-элемента:
   - `mode==='pinned'` → взять `ref.description` (если непустое).
   - `mode==='auto'` → `isNameInText([ref.name, ...ref.keywords].join(' '), sceneText)` ? взять : пропустить.
3. Skip пустых `description` и несуществующих ref.
4. Вернуть `[{name, description}]`.

Переиспользуем **экспортированный** `isNameInText` (`refs-library.js:162`). Новая логика матчинга не пишется.

#### Переход через границы модулей

| Из | В | Что |
|----|----|-----|
| `refs-library.js` | `pipeline.js` | `collectDescRefsForCurrentChat(sceneText)` → `[{name, description}]` |
| `pipeline.js` | `prompt-builder.js` | `opts.refDescriptions` в `buildSystemPrompt` |

`buildSystemPrompt` меняется минимально: чтение `opts.refDescriptions` + один элемент в конкатенации. Вызывающие стороны без `opts.refDescriptions` → блок пустой → поведение идентично текущему.

### Секция 3 — Структура интерфейса

#### 3a. Вкладка «Генерация» — единая панель референсов

Старое `#urisRefsStatus` (read-back + Override) → единая панель управления:

```
┌─ Референсы ──────────────────────────────────────────────┐
│ Режим: [Умный ▾]                                  [⚙]     │
├──────────────────────────────────────────────────────────┤
│ {{char}} [Auto ▾] [🟦превью]  {{user}} [Auto ▾] [🟦превью] │  ← адаптивная строка слотов
├──────────────────────────────────────────────────────────┤
│ Картинки (Stage2): [+ Aria] [Bar]  …                     │  ← extras-чипы (extraRefIds)
│ Описания (Stage1): [Aria📌] [Bar🔄]  …                    │  ← descRefs-чипы (📌pinned/🔄auto)
├──────────────────────────────────────────────────────────┤
│ → Уйдёт в генерацию: [🟦][🟩][🟨]  (3/4)                 │  ← live-превью результата
└──────────────────────────────────────────────────────────┘
```

`[⚙]` переключает на вкладку «Референсы» (редактор пула), как бывший `#urisRefsEdit`.

#### 3b. Компактная адаптивная строка слотов

Слоты {{char}}/{{user}} + превью + «Из пула» переносятся из `#urisRefsChat` (`tab-references.js:37-50`) в панель генерации, в одну строку.

**Исправление превью auto-слотов:** `slotPreview` для `type:'auto'` вместо иконки `fa-robot` показывает реальный аватар:
- auto-{{char}} → `getCharacterAvatarDataUrl()` (аватар текущего персонажа ST).
- auto-{{user}} → `getUserAvatarDataUrlForCurrent()` (аватар активной персоны).

Асинхронная подгрузка: рендерим плейсхолдер (`fa-robot` временно), затем async-функция подменяет `img.src`. Паттерн fire-and-forget уже есть в `renderRefsStatus`. Pinned-слоты показывают `ref.imagePath` без изменений.

#### 3c. Вкладка «Референсы» — только редактор пула/библиотеки

Блок `#urisRefsChat` (настройки чата) **удаляется** — содержимое переехало в панель генерации (3a). Вкладка = только пул/библиотека:

```
┌─ Вкладка «Референсы» ────────────────────────────────────┐
│ [Все] [Без папки] [Папка1] [+]  [+ Референс]              │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐                               │
│ │img │ │img │ │img │ │img │  ← пул (клик = редактор)      │
│ └────┘ └────┘ └────┘ └────┘                               │
└──────────────────────────────────────────────────────────┘
```

#### 3d. Пикер — фильтры по папкам

`showPoolPicker` (`tab-references.js:334-376`) дополняется строкой folder-chips (дублирующей пул):

```
┌─ Выберите референс для {{char}} ─────────────────────────┐
│ [Все] [Без папки] [Папка1] [Папка2]            [Отмена]  │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐                               │
│ │img │ │img │ │img │ │img │                               │
│ └────┘ └────┘ └────┘ └────┘      [Готово]                 │
└──────────────────────────────────────────────────────────┘
```

Логика `folderChipsHtml` выделяется в общую функцию, вызываемую из пула и из пикера. При смене фильтра перерисовывается только `.uris-picker-grid`, overlay не закрывается, `selected` Set сохраняется.

#### 3e. Чипы «Персонажи» — переименование

Строка `flow-config > div:nth-child(2)` (`tab-generate.js:58`): label «Персонажи» → «Чьи карточки отправим в Stage 1». Функция (`loadCharacters`, чипы → `bundle.characterIds`) не меняется.

### Секция 4 — Крайние случаи, совместимость, тесты

#### 4a. Обратная совместимость данных

| Сценарий | Поведение |
|----------|-----------|
| Старый pool item без `description` | `getRef`/`getRefSync` возвращают `description: ''` (fallback). Редактор показывает пустое поле. |
| Старый chat binding без `descRefs` | `getChatRefs()` возвращает `descRefs: []`. Stage1-блок пустой = поведение как сегодня. |
| Удалённый pool-item, на который ссылается `descRefs[].refId` | Пропуск при сборке (как `getRefSync` → null в `_resolveRefs`). |
| Существующие тесты `refs-library.test.js` | Не ломаются: `defaultChatRefs()` добавляет поле, старые assert'ы на `.mode`/`.charSlot`/`.extraRefIds` проходят. |

Миграция явная не нужна — нормализация в `getChatRefs`/`getRefSync` добавляет дефолты.

#### 4b. Риски

**Риск 1: дублирование описания в Stage1.** Если референс `Aria` есть и в `bundle.characterIds` (как custom-персонаж), и в `descRefs` — описание попадёт в промпт дважды. Решение: `renderRefDescriptionsBlock` дедуплицирует по `name` против уже включённых `activeCharacters`. O(n) фильтр.

**Риск 2: auto-аватар async в синхронном рендере.** `slotPreview` сейчас синхронный. Подгрузка авто-аватара асинхронна. Решение: плейсхолдер → async-подмена `img.src`. Паттерн fire-and-forget из `renderRefsStatus`.

**Риск 3: пустое описание → «битый» блок.** Если у всех `descRefs` пустой `description` или auto-режим ничего не сматчил — `renderRefDescriptionsBlock` возвращает `''`, блок не попадает в конкатенацию (существующий `.filter(s => s && s.trim())`).

**Риск 4: пикер с фильтрами — перезаливка.** При клике на folder-chip внутри пикера перерисовываем только грид, не закрывая overlay. Локальный `_pickerFolderFilter`, перерисовка `.uris-picker-grid`, сохранение `selected` Set.

#### 4c. Что удаляется

- `#urisRefsOverrideEnabled` чекбокс и handler (`tab-generate.js:88, 740-753`).
- `#urisRefsReset` кнопка (`tab-generate.js:92, 759-764`).
- `buildOverrideControls()` / `bindOverrideControls()` (`tab-generate.js:676-732`).
- `#urisOverrideControls` host (`tab-generate.js:616-628`).
- `initOverride()` (`tab-generate.js:545-547`).
- `state.refsOverride` поле (`core.js:83`) и его reset в `events.js:79`.
- Весь блок `#urisRefsChat` (`tab-references.js:30-156`, включая `renderChatSection`, `slotSelect`, `extrasHtml`, `bindExtrasList`).

**Что НЕ удаляется** (переезжает): логика `slotSelect`, превью слотов, extras-чипы — в панель генерации в адаптивной форме.

**Что НЕ трогается** (harmless): `opts.override` параметр в `_resolveRefs`/`collectRefsForCurrentChat`/`runStage2` — сохраняется как всегда-`null`, чтобы не ломать pipeline API. JSDoc typedef `RefsOverride` остаётся.

#### 4d. Тесты

| Файл | Что тестирует |
|------|---------------|
| `tests/refs-library.test.js` | `descRefs` нормализация в `getChatRefs`; `collectDescRefsForCurrentChat`: pinned всегда, auto по матчу, skip пустого description, skip удалённого refId |
| `tests/prompt-builder.test.js` | `renderRefDescriptionsBlock`: пустой список → '', есть описания → блок; дедупликация против `activeCharacters`; `buildSystemPrompt` без `opts.refDescriptions` → без блока |
| `tests/references.test.js` | обновить: убрать override-кейсы (если есть), добавить descRefs-flow |

`collectDescRefsForCurrentChat` — новая экспортированная функция, использующая `isNameInText` напрямую по массиву `[name, ...keywords]`. Это решает отсутствие «scan pool» функции (замечание: такой функции не существовало).

### Секция 5 — Поэтапность реализации

Каждый шаг — компилируется и тестируется отдельно. Порядок выбран так, чтобы система оставалась рабочей между шагами.

**Шаг 1 — Модель данных** (`refs-library.js`, `tests/refs-library.test.js`)
- Расширить `createRef`/`updateRef`: поле `description`.
- Расширить `defaultChatRefs`/`getChatRefs`: поле `descRefs` с нормализацией.
- Новая функция `collectDescRefsForCurrentChat(sceneText)`.
- Тесты: нормализация, сборка, match, edge-cases.

**Шаг 2 — Stage1 инъекция** (`prompt-builder.js`, `pipeline.js`, `tests/prompt-builder.test.js`)
- `renderRefDescriptionsBlock(refDescs, activeCharacters)` с дедупликацией.
- `buildSystemPrompt`: `opts.refDescriptions`, блок в конкатенации.
- `runStage1`: вызов `collectDescRefsForCurrentChat`, передача в opts.
- Тесты: пустой → '', есть → блок, дедупликация.

**Шаг 3 — Редактор pool-item: description** (`tab-references.js`)
- `openRefEditor`: `<textarea>` для description, persist через `updateRef`.

**Шаг 4 — Единая панель референсов** (`tab-generate.js`)
- Переписать `#urisRefsStatus` (81-96) → единая панель: режим, слоты char/user с async-превью аватаров, extras-чипы, descRefs-чипы (📌/🔄), live-превью.
- Удалить Override UI (545-547, 615-628, 676-732, 739-764), `state.refsOverride` (`core.js:83`), reset в `events.js:79`.
- Переименовать чипы «Персонажи» → «Чьи карточки отправим в Stage 1» (58).
- Удалить неиспользуемые CSS-классы override.

**Шаг 5 — Чистка вкладки «Референсы» + пикер с фильтрами** (`tab-references.js`)
- Удалить `#urisRefsChat` блок (30-156): `renderChatSection`, `slotSelect`, `extrasHtml`, `bindExtrasList`.
- `showPoolPicker` (334-376): folder-chips фильтров, перерисовка grid без закрытия overlay.
- Общая функция folder-chips с пулом.

#### Проверка между шагами

- После шагов 1-2: ручной тест — описание референса попадает в Stage1 промпт.
- После шага 4: ручной тест — управление из одной панели, аватары подгружаются.
- После шага 5: `npm test` полный прогон.

---

## Затрагиваемые файлы

| Файл | Изменения |
|------|-----------|
| `src/refs-library.js` | `createRef`/`updateRef` +description; `defaultChatRefs`/`getChatRefs` +descRefs; новая `collectDescRefsForCurrentChat` |
| `src/prompt-builder.js` | новая `renderRefDescriptionsBlock`; `buildSystemPrompt` +opts.refDescriptions |
| `src/pipeline.js` | `runStage1`: вызов collect, передача в opts |
| `src/ui/tab-generate.js` | переписать `#urisRefsStatus` → единая панель; удалить Override UI; переименовать чипы |
| `src/ui/tab-references.js` | `openRefEditor` +description; удалить `#urisRefsChat`; пикер +folder-chips; общая функция chips |
| `src/core.js` | удалить `state.refsOverride` (83) |
| `src/events.js` | удалить `state.refsOverride = null` reset (79) |
| `style.css` | удалить override-классы; добавить стили единой панели |
| `tests/refs-library.test.js` | +descRefs/collectDescRefs тесты |
| `tests/prompt-builder.test.js` | +refDescriptions блок тесты |
| `tests/references.test.js` | обновить override-кейсы |

## Что НЕ входит (YAGNI)

- Глобальные/кросс-чатовые пресеты описаний (только per-chat binding).
- Редактор описаний прямо в панели генерации (только в редакторе pool-item на вкладке «Референсы»).
- Миграция старых профилей (уже сделана в `migrateWipeLegacyProfiles`).
- Изменение Stage2 pipeline (картинки) — только Stage1 (текст) получает новый поток.
