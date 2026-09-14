# 2026-09-14 — Единый лайтбокс и встраивание результатов Stage 2 в текст чата

Статус: дизайн (предложено к реализации). Связан с `docs/plans/2026-09-14-uris-hardening-de-overengineering.md`.

## Цель

Результат двухстадийной генерации (Stage 2) появляется **встроенным в исходное сообщение** — так же, как инлайн-результаты: та же оболочка, тот же лайтбокс, те же действия. Один код оболочек и просмотра на оба режима, без копий.

## Факты по текущему коду (чему дизайн обязан следовать)

- **Лайтбокс уже универсален** (`src/ui/lightbox.js`): `showLightbox(items, index, {chatId, root})` — PhotoSwipe с dataSource, листание, проба размеров через кэш `image-dimensions.js`, тулбар действий (копировать промпт / обрезать в карточку / сохранить как референс / перегенерировать / удалить) и режим референсов (`actions:'ref'`). Инлайн использует только одиночную обёртку `showSingleImage({src, prompt})` — **без cardId**, поэтому галерейные кнопки на встроенных картинках частично нерабочие (regen/delete ищут карточку по id, которого нет).
- **Инлайн**: store-слоты `chatMetadata.uris_inline` → `planScan` (только постановка) → `computeShellPlan` (статусы: ready/pending/error/changed/button) → оболочки с ключами `idx|type|descHash`. Готовая картинка: `<img>` + click → `showSingleImage`, dblclick → reroll. Orphan/grace-логика осиротевших pending уже реализована (2026-09-14).
- **Двухстадийка**: `runStage2ForDraft` → `generateImageRequest` → materialize → галерейная карточка (`addCard`: `imagePath`, `cardId`, `width/height` из `output`) → результат виден **только во вкладке «Галерея»**; в тексте исходного сообщения ничего не появляется. У черновика остаётся `stage2.lastSubmittedSnapshot` — база для перегенерации.
- **Размеры**: `generateImageRequest` уже пишет `width/height` в карточку — их можно сразу класть в store-item, и PhotoSwipe получит настоящие размеры без пробы.

## Дизайн

### A. Лайтбокс: просмотр в контексте сообщения (малый шаг, большой эффект)

Клик по готовой картинке инлайна открывает **галерею всего сообщения**, а не одиночный кадр:

1. Собрать items: все ready-item'ы слота сообщения (инлайн + Stage 2 embeds из B) в порядке idx.
2. Обогатить каждый item по `cardId` (lookup в gallery-index): `id`, `prompt` карточки, `modelId`, `width/height` — тогда тулбар лайтбокса работает полноценно (regen/delete/crop/save-ref действуют на настоящую карточку, как из сетки галереи).
3. Открыть `showLightbox(items, clickedIndex, {chatId})` — листание стрелками/свайпом внутри сообщения.

`showSingleImage` остаётся как обёртка для одиночных случаев (превью референсов, чипы «Генерации»). Изменение затрагивает один обработчик клика в `render.js`.

### B. Stage 2 embeds в тексте (новый источник оболочек)

**Запись** (в `pipeline-stage2.js`, рядом с существующими событиями):
- перед `generateImageRequest` — pending-item c `requestId` активной задачи: `{ idx:-1, type:'stage2', descHash:stableHash(requestId), desc:<краткое описание/промпт-хвост>, status:'pending', requestId, createdAt }`;
- после materialize — тот же ключ → `status:'ready', imagePath, cardId, width, height`;
- при ошибке/отмене — `error` c кодом (запись только если item не ready — гарды store уже стоят).

Ключ в пространстве `itemKey` (`idx|type|descHash`) не конфликтует ни с маркерами (типы триггеров никогда не равны `stage2`), ни с ручными (`img`). `planScan` не меняется: он итерирует маркеры, а не items, — stage2-элементы никогда не совпадут с маркером и не породят платную постановку.

**Рендер** (`src/inline/render.js`): `computeShellPlan`/`shellFor` получают третий источник оболочек — items с `type:'stage2'` рендерятся всегда (без маркера в тексте), append в конец сообщения, ключ `s2|<descHash>`. Статусы переиспользуют готовую логику: pending со спиннером и ✕, **осиротевший pending → «прервана» (орфан-логика уже написана и покрыта тестами)**, ready → img, error → retry. dblclick/кнопка перегенерации → `regenerate(card)` из gallery-actions по cardId — тот же путь, что и в галерее.

**Управление**:
- новый флаг `settings.embedStage2InChat` (дефолт `false`, opt-in) — тумблеры в «Настройках» и «Медиа»; pipeline пишет embed только при включённом флаге и `sourceMsgId >= 0`;
- лимит на сообщение: хранить последние N (напр. 6) embeds — старые вытесняются при новых генерациях того же поста;
- удаление карточки в галерее (`storage.deleteGalleryCard`) → найти embed с этим `cardId` → `status:'error', error:'удалено из галереи'` → retry-кнопка ведёт в галерею/Генерацию (v1: без авторезапуска).

**Идемпотентность и восстановление**: store персистентен в chatMetadata — перезагрузка страницы восстанавливает embeds; running-задача, пережившая краш, проходит через ту же orphan-логику. Двойной рендер безопасен (реконсиляция по ключам уже есть).

### C. Что НЕ меняется

- Галерейная сетка и её лайтбокс — уже на `showLightbox`, без изменений.
- Инлайн-маркеры, planScan, рероллы — не затронуты (embeds живут в отдельном пространстве ключей).
- Приватность/бэкапы: embeds едут в `chatMetadata` вместе с чатом (как и инлайн-item'ы) — правило «привязанное к чату → chatMetadata» не нарушается; файлов они не дублируют (ссылка на тот же `imagePath`).

## Этапы реализации

| # | Шаг | Файлы | Усилие |
|---|---|---|---|
| 1 | Клик инлайна → message-scoped `showLightbox` с обогащением по cardId; width/height в store-item | `inline/render.js`, `pipeline-stage2.js`, `image-api.js` (width/height в pending-snapshot) | S |
| 2 | Запись embeds из pipeline (pending/ready/error) + флаг `embedStage2InChat` + тумблеры | `pipeline-stage2.js`, `core.js`, `ui/tab-settings.js`, `ui/tab-media.js` | M |
| 3 | Рендер stage2-оболочек (ready/pending/error/orphan) + retry через `regenerate(card)` | `inline/render.js`, `gallery-actions.js` | M |
| 4 | Удаление карточки → погашение embed; лимит N; тесты; CHANGELOG | `storage.js`, `inline/store.js`, `tests/*` | M |

Критерии приёмки: генерация Stage 2 с включённым флагом появляется в сообщении сразу после готовности; перезагрузка восстанавливает её; удаление карточки гасит embed; выключенный флаг — поведение идентично текущему; все оболочки открывают лайтбокс с листанием по сообщению и рабочими действиями.

## Figma

Сервер `figma-developer-mcp` сконфигурирован в ZCode (ключ `FIGMA_API_KEY` в `~/.zcode/cli/config.json`), но в текущей сессии его инструменты не проброшены, а в `docs/` нет ссылок на файл Figma (ключ файла неизвестен). Варианты: прислать URL файла — макеты вытяну через REST API тем же ключом (`GET /v1/files/:key`) и сверю визуал оболочек/лайтбокса; либо переподключить MCP-сервер — тогда пройдусь нодами.
