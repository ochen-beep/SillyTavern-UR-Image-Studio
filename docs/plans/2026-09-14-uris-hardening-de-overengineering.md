# 2026-09-14 — Hardening и de-overengineering URIS

Статус: этапы P0–P2 выполнены в dev-репо (2026-09-14); P3 refactor оставлен опциональным.
База: ветка `feat/inline-engine`, 1231/1231 тестов зелёные после cleanup.

## Контекст

Ревью подтвердило силу ядра (транспорт с no-resubmit семантикой, file-store, провайдер-контракты,
data-port), но выявило концентрированные проблемы:

- два **шва inline-движка** (store text-gate и мёртвый render-словарь planScan) — ре баги,
  а не перениженеринг, и чинятся в первую очередь;
- **узкий** слой мёртвого кода и дублей (9 экспортов, 4 дублированных реализации);
- горстка контрактных расхождений с провайдерами (dall-e-3, OpenRouter chat-completions);
- россыпь UI-мелочей, нарушающих собственные конвенции кодовой базы (toast/error-pool,
  debounce, epoch-guard).

Важно: первоначальное подозрение на «диагностический перениженеринг» ядра **не подтвердилось**.
`netdump.js` (лимиты, скраббинг, осознанные исключения), `dispatch-plan.js` (слои
«статика → evidence → override»), `capability-observer.js` и `connection-evidence.js` —
проверены и имеют документированное назначение. Не трогать.

## Не-цели (что НЕ перерабатываем и почему)

| Модуль | Почему не трогаем |
|---|---|
| `netdump.js` | осознанные лимиты (MAX_NET_ENTRIES=500, капы тел), скраббинг ключей, компактация base64; выкинуть нечего |
| `dispatch-plan.js` | dialect-resolution — реальная функциональность со слоями приоритета; дублирования нет |
| `capability-observer.js` / `connection-evidence.js` | разные времена жизни (журнал наблюдений vs долговечные факты о референсах); объединение — слияние без выгоды |
| `file-store.js` защиты | unreadable-file/readonly/newer-version — страховка данных, удалять нельзя |
| no-resubmit / `IMAGE_DELIVERY_AMBIGUOUS` | деньги-безопасность; это главное конкурентное преимущество |
| Структурированные dispatch-события в `image-transport.js` | отвечают на вопрос «ушёл ли POST дважды» — связаны с деньгами; шум лечится хелпером, а не удалением (этап 6) |

## Таблица улучшений

Приоритеты: P0 — чинить на этой ветке до слияния; P1 — следующий релиз; P2 — уборка;
P3 — опционально. Усилие: S < 1ч, M 2–4ч, L — день+.

| # | Кат. | Улучшение | Зачем | Файлы | Усилие | Риск | Приоритет |
|---|---|---|---|---|---|---|---|
| 1 | баг | Убрать sourceText-гейт из `store.js`; мерж по `(idx\|type\|descHash)` | Правка слова/свайп скрывает и стирает оплаченные item'ы; авто-скан жжёт деньги повторной генерацией; `render-changed` недостижим | `src/inline/store.js` | M | ср. | **P0** |
| 2 | баг | Удалить `render-*` из `planScan`; перенести orphan/grace-логику в `computeShellPlan` | Осиротевший pending крутит спиннер вечно; мёртвый словарь действий вводит в заблуждение | `src/inline/runner.js`, `src/inline/render.js` | M | низк. | **P0** |
| 3 | баг | `cancelInlineJobs(msgId)` — точечный аборт; глобальный только на CHAT_CHANGED/cleanup | Свайп/правка одного поста абортит чужие оплаченные задачи | `src/inline/scanner.js`, `src/inline/runner.js` | S | низк. | **P0** |
| 4 | баг | Единый boundary-regex для триггеров (`\p{L}\p{N}`), вырезание алиаса тем же регексом, что и детект | «фотограф сказал фото» → платный промпт «граф сказал фото»; «img2» матчит «img» | `src/inline/triggers.js`, `src/inline/scanner.js` | S | низк. | **P0** |
| 5 | баг | Убрать двойной `refreshReferencePanel` из рендера «Генерации» | Гонка затирает Stage2-чипы «нет совпадений»; ×2–×4 policy-резолвы за рендер | `src/ui/tab-generate.js` | S | низк. | **P0** |
| 6 | тест | Интеграционная фикстура inline: мок с реальным `chat[].mes`; тест «правка сохраняет ready-items» | Сейчас тесты мокают `chat` — оба P0-бага невидимы для suite'а | `tests/inline-store.test.js`, `tests/_helpers.js` | S | — | **P0** |
| 7 | контракт | DALL_E-семья: размеры `1024x1024/1792x1024/1024x1792`, quality `standard/hd` (без `auto`); gpt-image — как сейчас | У dall-e-3 не существует `1536x1024`; `auto` даёт 400; `dispatch-plan` уже имеет семью — подключить | `src/providers/image-openai.js`, `src/dispatch-plan.js` | M | низк. | **P1** |
| 8 | контракт | `modalities:['image','text']` для openrouter chat-completions пути (за capabilities-флагом) | По докам OR без `modalities` image-вывод не запрашивается | `src/providers/image-chat-completions.js` | S | низк. | **P1** |
| 9 | баг | `applyStage1Result` под `withDraftLock` | unlocked read-modify-write затирает конкурентную правку | `src/generation-drafts.js` | S | низк. | **P1** |
| 10 | баг | `cancelPending`: не переводить `ready→error` (гард `wasReady`) | Окно в тик обнуляет imagePath/cardId оплаченного результата | `src/inline/render.js`, `src/inline/store.js` | S | низк. | **P1** |
| 11 | баг | Chat-скоуп `automationMode/generationFlow` не должен течь в глобальные settings; `patchChatConfig` для legacy — сигналить, а не молчать | Последний визитённый чат становится глобальным дефолтом на след. сессию | `src/chat-binding.js` | M | ср. | **P1** |
| 12 | чистка | Удалить мёртвый код: `refreshErrorPanel`, `ensureManualButtons`, `dropMessage`, `scannerActive`, `detectEntityMentions`, `normalizeChatConfig`, `emitChanged` + 3 вызова, `renderCap` + hidden-input, `connectionsSynced: 0` из возврата data-port | Мёртвый код маскирует намерение; все позиции подтверждены grep'ом | см. этап 4 | S | низк. | **P2** |
| 13 | чистка | Развести дубли: `escapeHtml` (server-connection-form vs core), `stableHash` vs `hashMessage`, `phraseRegex` vs `normalizePhrase`, локальный `showFolderPicker` (без Escape) → `folder-picker.js` | Четыре копии, которые уже разъехались поведением | `src/core.js`, `src/generation-drafts.js`, `src/scene-context.js`, `src/ui/tab-generate.js` | M | низк. | **P2** |
| 14 | UX | Шаблоны-из-описания: try/catch + toastr + recordUrisError; слайдеры настроек — debounce 400ms; chunk-загрузчик галереи — in-flight guard; `_mobileScreen` не сбрасывать в render; `_renderOverlay` — epoch; «Отмена/Отмена» в showRefPicker; `?.` на `saveSettingsDebounced` | Каждый пункт — нарушение собственной конвенции кодовой базы | `src/ui/*.js` | M | низк. | **P2** |
| 15 | UX | `addStage2Includes`: batch-обновление + один `render` вместо N рендеров на каждый пик референса | 5 пиков = 5 полных перерендеров вкладки | `src/ui/tab-generate.js` | S | низк. | **P2** |
| 16 | рефактор | Хелпер `recordDispatch()` в transport; split `tab-generate.js` (draft/pickers/actions) | Копипаста diagnostic-вызовов; файл 1550 строк | `src/image-transport.js`, `src/ui/tab-generate.js` | L | ср. | **P3** |

## План реализации

Порядок жёсткий: 0 → 1 → 2 → 3 → 4 → 5. После каждого этапа — `node --test` зелёный.
Этапы 1–2 можно мержить в `feat/inline-engine` до её закрытия; этапы 3–5 — следующим релизом.

### Этап 0 — guard-тесты inline (до любых правок)

1. В `tests/_helpers.js` / `tests/inline-store.test.js` добавить фикстуру, где
   `SillyTavern.getContext()` возвращает живой `chat: { [msgId]: { mes } }` и `chatMetadata`.
2. Тест-кейсы:
   - `upsertItem` после правки `mes` **сохраняет** ready-item с тем же `(idx,type,descHash)`;
   - item с изменившимся desc остаётся в слоте (для render-changed) и не стирается;
   - осиротевший pending (requestId вне activeGenerations, createdAt старше grace) даёт
     `render-error` (после этапа 1 — через computeShellPlan).

### Этап 1 — inline-швы (P0, #1–#5)

1. `store.js`:
   - `getSlot` больше не возвращает пустой слот по `sourceText !== mes`;
   - `upsertItem` не заменяет слот целиком при несовпадении текста — обновляет
     `messageHash`, мержит item по ключу; item'ы с чужим descHash остаются
     (не рендерятся без совпадающего маркера — это и есть render-changed);
   - чистка слота остаётся за `reconcileMessageSlots` (MESSAGE_DELETED) и ручным reroll.
2. `runner.js`: из `planScan` удалить ветки `render-ready/pending/error/changed/button`
   (возвращать только `store-pending`/`queue`/`skip-unknown`);
   `computeShellPlan` в `render.js` получает inFlight-набор и grace-окно и сам
   выводит error для осиротевших pending (правила перенести 1:1 из planScan, тесты тоже).
3. `scanner.js`/`runner.js`: `cancelInlineJobs(filterMsgId)` — аборт только задач
   с совпадающим msgId; глобальный вызов остаётся на CHAT_CHANGED/unbind/cleanup.
4. `triggers.js`: единый `buildAliasRegex(alias)` с границами `(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`;
   `scanner.js userSent` вырезает алиас этим же регексом (одно вхождение, совпавшее при детекте);
   `scene-context.js` переходит на тот же helper (закрывает #13 частично).
5. `tab-generate.js render()`: убрать fire-and-forget `updatePostInfo` → отдельный
   `refreshReferencePanel`; оставить один вызов с реальной resolution.

Критерий: тесты этапа 0 зелёные; `node --test` полностью зелёный; ручная проверка
«правка поста → картинки остаются, кнопка перерисовки на изменённом описании».

### Этап 2 — контракты провайдеров (P1, #7–#8)

1. `image-openai.js`: `ASPECT_SIZES` → две таблицы по `detectModelFamily(route.modelId)`
   (`dispatch-plan.js` уже экспортирует семью; при `unknown` — текущая gpt-таблица);
   для DALL_E — `acceptedQualityValues` без `auto`; unmapped размер/качество —
   как сейчас через `paramWarnings` (уже есть) + тесты.
2. `image-chat-completions.js`: при `chatCompletionsImageConfig === 'openrouter'`
   добавлять `modalities: ['image','text']`; флаг берётся из capabilities, поэтому
   generic-шлюзы не затронуты. Тест-фикстура ответа OR с `message.images`.
3. Прогнать `tests/image-provider-adapters.test.js`, `tests/chat-completions-parse.test.js`.

### Этап 3 — конкурентность и состояние (P1, #9–#11)

1. `applyStage1Result` обернуть в `withDraftLock`.
2. `cancelPending`: гард «ready не трогаем» (как `wasReady` в runner).
3. `chat-binding.js`: chat-скоуп поля хранить в отдельных runtime-полях state
   (не в `state.settings`), либо помечать и вырезать при `saveSettings`;
   `patchChatConfig` для legacy-биндинга — возвращать `{ merged: false }` и
   писать diagnostic-event + warning.
4. Тесты на каждый пункт (гонки — через задержки в моках).

### Этап 4 — чистка мёртвого кода и дублей (P2, #12–#13)

1. Удалить: `refreshErrorPanel` (window.js), `ensureManualButtons` (render.js) — либо
   пометить «test-seam» и оставить, `dropMessage` (store.js), `scannerActive` (scanner.js),
   `detectEntityMentions` (scene-context.js), `normalizeChatConfig` (chat-binding.js),
   `emitChanged` + вызовы (diagnostic-events.js), `renderCap` + `#urisRefsCap` (tab-generate.js),
   поле `connectionsSynced` из результата `importUrisData`.
2. Дубли: строковый `escapeHtml` без `document` в core (обе реализации → один хелпер);
   `hashMessage` — единственная FNV-1a (runner импортирует);
   `phraseRegex` → `matchesScenePhrase`; `showFolderPicker` в tab-generate →
   `folder-picker.js` (+ обязательный Escape-обработчик).
3. test-only экспорты (`persistVisibleGenerationDraft`, `executeGenerationAction`) —
   пометить единым комментарием-конвенцией `/** Test seam: не использовать в production. */`.

### Этап 5 — UI-мелочи (P2, #14–#15)

Один коммит на группу: templates-error handling; sliders-debounce; gallery chunk guard;
mobile-screen и overlay-epoch; showRefPicker label; `addStage2Includes` batch.

### Этап 6 — опционально (P3, #16)

Хелпер `recordDispatch` в image-transport (11 вызовов → 1 фабрика);
split tab-generate.js на draft/pickers/actions — только после слияния inline-ветки,
чтобы не плодить конфликты.

## Риски

- Этап 1 меняет семантику хранимых слотов. Старые слоты с `sourceText` совместимы:
  поле игнорируется, миграция не требуется. Ветка не слита — окно деградации минимально.
- Этап 2: `modalities` добавляется строго за capabilities-флагом — generic-шлюзы не затронуты.
- Этап 4: удаление test-only экспортов требует одновременной правки тестов —
  делать одним коммитом, suite зелёный.
