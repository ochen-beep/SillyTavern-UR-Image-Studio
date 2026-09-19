# Deep dive: вкладка «Генерация» — рендер, autosave, race-инварианты (tab-generate + tabs)

Дата: 2026-09-09 · Версия: 0.8.6 · Основание: code review + перепроверка; цель — безопасные фиксы P1-1 (autosave), P2-1 (epoch), P2-2 (пустая вкладка).

## 1. Точки входа системы

**Инициация рендера:**
| Путь | Место | Инкремент epoch? |
|---|---|---|
| Переключение вкладки / `refreshActive()` | `tabs.js:27-68` (`setActiveTab`) | **да** (`++_renderEpoch`, стр. 30) |
| Навигация ←/→ | `tab-generate.js:678-679` → `render(root)` | **нет** |
| Включить/исключить референс | `applyReferenceCorrection` → `tab-generate.js:945` | **нет** |
| Смена модели | `bindModelSelect` onSwitched → `tab-generate.js:589` | **нет** |
| Конец «Построить промпт» / AbortError «Сгенерировать» | `tab-generate.js:799, 822` | **нет** |
| Empty-state навигация | `bindEmptyState` → `tab-generate.js:400, 407` | **нет** |
| Follow-last-post / дефолты генерации (извне) | `index.js:177-185` → `refreshActive()` | да |

**Точечные обновления без ререндера:** `setCancelState`/`updateQueueStatus` по `uris:stage1/2-start/end` (`tab-generate.js:1431-1457`); `renderPromptAmbiguities` (241); `renderMatchedKeywords` (1039). Fire-and-forget: `updatePostInfo → refreshReferencePanel` (`1358-1366`), `renderLivePreview`/`renderCap` внутри него.

**Запись черновика:** autosave input (`createCancellablePromptAutosave`, 711 — debounce 400 мс с отменой, идентичность поста снимается в момент input), `prepareSubmissionInput` (1023-1059, flush видимого текста в драфт + снапшот при постановке в очередь; с v0.9.0 заменил удалённый `prepareRunInput`), `bindModelSelect` change (554), `saveGenerationDefault` (897).

## 2. Поток данных рендера

`setActiveTab` ставит `body.__urisRenderEpoch/__urisTabId` (`tabs.js:49-51`) → `render()` (`tab-generate.js:531`):
guard пустого состояния (543-547) → `getGenerationDraft` (551) → `loadChatConfig` (553) → оверлей дефолтов (555-568) → `resolveDraftPromptReferences` (570, включает `buildCandidates → listRefs`) → `listTemplates` (572) → `resolveModelChoices` (584 → `resolveChatConfigSnapshot` → может **throw**) → `innerHTML = renderGenerateMarkup` (586) → `bindGenerate` + `syncCancelState` + `bindModelSelect` + `updatePostInfo` (587-591). Между await'ами — проверка `isCurrent()` (533-534).

## 3. Контракт с SillyTavern

- Данные: `ctx.chatId`, `ctx.chat[msgId].mes`, `chatMetadata` через `loadChatConfig/patchChatConfig`; черновики — localforage `(chatId, msgId)` с hash-контролем.
- События: `CHAT_CHANGED` → `uris:chat-changed` (диспатчится `events.js:166,172`, **слушателей нет** — вкладка обновляется только при следующем действии); `MESSAGE_SWIPED/GENERATION_ENDED/MESSAGE_SENT` → `uris:post-follow` → `refreshActive()` при активной вкладке.
- Скролл тела восстанавливается только в `setActiveTab`-пути (`tabs.js:44-65`); прямые `render(root)` сбрасывают scrollTop.

## 4. Крайние случаи (что сейчас произойдёт)

| Сценарий | Сейчас | Оценка |
|---|---|---|
| Печать в посте #5 → переход на #6 (<400 мс) | debounce срабатывает: `state.currentMsgId` уже #6, замкнутый `promptEl` detached со старым текстом → текст #5 записывается в draft #6 как `manual` | **P1-1** |
| Печать → переключение вкладки (<400 мс) | тот же путь: запись в draft текущего поста от умирающего DOM | **P1-1** (тот же фикс) |
| Follow-last-post сработал во время печати | `refreshActive()` перерисовывает редактор: несохранённые нажатия последних 400 мс теряются (autosave ещё не успел) | смягчается P1-1 (cancel+flush при ререндере) |
| Два быстрых клика ←/→ | два параллельных `render(root)` с **одинаковым** epoch: завершившийся позже устаревший рендер перезаписывает DOM — редактор показывает пост #5 при `currentMsgId`=6 | **P2-1** |
| Каталог пометил модель чата non-image → открыть вкладку | `resolveModelChoices → resolveChatConfigSnapshot → assertImageModelEligible` throw → render reject → `tabs.js:62` глотает → **пустая вкладка** | **P2-2** |
| Тот же throw из `updatePostInfo → refreshReferencePanel` (fire-and-forget) | unhandled rejection + полупустая панель референсов | **P2-2** (обернуть `getActiveReferencePolicy`) |
| Быстрые include/exclude кандидатов | `applyReferenceCorrection` → полный ререндер на каждый клик: при задержке возможен устаревший DOM (та же механика P2-1) | закрывается P2-1 |
| `escapeHtml`-пути имён/промптов | все вставки экранированы (проверено review) | ок |
| Пустой чат / msgId=null | empty state, `prepareSubmissionInput` тостит «Нет поста» | ок |

## 5. Хрупкие места

1. `createCancellablePromptAutosave` (711) давно подключён в прод — autosave промпта (784) и сцены (758), идентичность поста фиксируется в момент input (пин P1-1); `executeGenerationAction` удалён (v0.9.0): шифровал снятую семантику блокировки обеих кнопок на время стадии; прод использует независимые `withBusy` (858, 882), Stage 2 — fire-and-forget через очередь.
2. Инвариант «текст в textarea = draft текущего currentMsgId» держится на дисциплине вызовов, а не на механизме: любое расхождение во времени (debounce, follow-ререндер) его ломает.
3. `updatePostInfo` вызывает `refreshReferencePanel(root)` без `referenceResolution` → `renderLivePreview(null)` очищает превью до прихода полного рендера (мигание).
4. Прямые `render(root)` не восстанавливают скролл (теряется позиция при каждой навигации/коррекции).

## 6. План фиксов (минимальный, по этому документу)

- **P1-1**: подключить `createCancellablePromptAutosave`: в `bindGenerate` — `autosave.schedule()` на input, **захват `chatId/msgId` на момент schedule** (замыкание снимает состояние один раз); в начале `render()` — `autosave.cancel()` + flush (записать буфер в draft СТАРОГО поста до смены currentMsgId). Колбэк ничего не читает из свежего `getCtx()`.
- **P2-1**: первой строкой `render()`: `root.__urisRenderEpoch = (root.__urisRenderEpoch || 0) + 1;` — `isCurrent()` начинает отсекать параллельные прямые рендеры; `tabs.js` не затрагивается (его restore использует свой счётчик).
- **P2-2**: try/catch вокруг `resolveModelChoices()` в `render()` (fallback-сообщение + `recordUrisError`) и вокруг `getActiveReferencePolicy()` в `renderLivePreview`/`renderCap`.

## 7. 5 вопросов, не извлекаемых из кода

1. Ожидаемое поведение autosave при уходе с вкладки с набранным текстом: flush перед скрытием или потеря? (сейчас — потеря при >400 мс тишины нет: debounce успевает; при мгновенном закрытии — flushSettings не касается textarea).
2. Нужен ли слушатель `uris:chat-changed` на вкладке (сейчас он диспатчится в пустоту) — или осознанная «ленивость»?
3. Приоритет при гонке «follow-last-post vs печать юзера»: рвать ввод ререндером или откладывать refresh до blur?
4. Нужна ли отмена in-flight Stage 1 при переходе на другой пост (сейчас продолжает и применит результат по token-правилам)?
5. Кросс-постовая запись P1-1: фиксировалась ли она юзером ранее как «промпт сам поменялся» (обратная связь для приоритета)?

## Самопроверка (Блок 0 п.6)

- «Что должно быть правдой, чтобы P1-1 была верна?» — что debounce-колбэк читает `state.currentMsgId` в момент срабатывания: `tab-generate.js:697-699` — подтверждено; что `promptEl` после innerHTML-замены сохраняет `.value`: свойство DOM-узла, детач не сбрасывает — подтверждено механикой DOM.
- «Какой сценарий сломает фикс?» — если `schedule()` вызывается из обработчика, где msgId уже сменился (клик раньше input): фикс должен снимать `{chatId, msgId}` в момент input-события; при rapid navigation между input и schedule — запись уйдёт старому посту с его же текстом (безвредно).
- **Не уверен**: сохраняет ли detached textarea значение во всех движках после `innerHTML`-замены (спецификация не гарантирует, но все движки держат свойство; проверяется тестом в реальном браузере). Также не проверено рантаймом: воспроизведение обоих P1 требует живой ST-вкладки — статический анализ и тесты node покрывают логику, но не тайминги браузера.
