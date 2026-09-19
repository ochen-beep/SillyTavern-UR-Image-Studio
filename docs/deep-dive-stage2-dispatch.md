# Deep dive: Stage 2 — dispatch, chain, queue (pipeline-stage2 + pipeline-queue)

Дата: 2026-09-09 · Версия расширения: 0.8.6 · Основание: code review + сверка с ST release-веткой.
Назначение: инженерный документ для безопасного внесения фиксов P1-2 (неабортируемая цепочка) и смежных правок.

## 1. Точки входа (все вызовы)

| Вызов | Место | signal | opts | В chain? |
|---|---|---|---|---|
| `runStage2ForDraft` — ручной «Сгенерировать» | `src/ui/tab-generate.js:809` | нет | `{}` (после prepareRunInput) | **да** |
| `runStage2` (positional) — regen из галереи/лайтбокса | `src/ui/gallery-actions.js:187` → `pipeline-stage2.js:397` | нет | `{refs?, onStart, instruction}` | **да** (msgId от карточки) |
| `runStage2ForDraft` — очередь, stage2-only | `src/pipeline-queue.js:113` | `state.queueAbort.signal` | `{}` | **да** |
| `runStage2ForDraft` — очередь, после Stage 1 | `src/pipeline-queue.js:117` | `state.queueAbort.signal` | `{}` | **да** |
| `runStage2ForDraft` — авто full-pipeline | `src/pipeline-stage1.js:224` | как у runFullPipelineForDraft (из `index.js:149` — **нет сигнала**) | `{isAuto:true}` | **нет** (bypass) |

Ветка `instruction` (edit) приходит только через `runStage2` от `gallery-actions.regenerate`.
Прочие потребители состояния: `state.stage2Chains` — только `pipeline-stage2.js:87,90,372-373`;
`state.activeGenerations` — `core.js:148`, запись `pipeline-stage2.js:119`, чтение `abortGeneration` (`core.js:187`) / `abortAllGenerations` (`core.js:203`); кнопка Cancel (`tab-generate.js:840-848`) и «Пропустить» (`tab-generate.js:1391-1393`).

## 2. Поток данных (ручной путь, от клика до карточки)

prepareRunInput (`tab-generate.js:760-778`: снапшот chatConfig + flush textarea в draft) →
`runStage2ForDraft` (`pipeline-stage2.js:74`):
1. snapshot chatConfig (79) → постановка в per-msgId chain (86-92) → ожидание очереди (104-106) → проверка signal (107) → создание/регистрация контроллера (113-119) → события `uris:stage2-start` (128).
2. `loadDraftForStage2` (51-59): hash-контроль сообщения, иначе throw «Source message changed».
3. Оверлей generationDefaults (135-143) → ревизии промпта/референсов (160-161) → `buildCandidates` + `resolvePromptReferenceContext` (165-171) → `resolveActivePresets`/`resolveConnection` (173-180) → materialize refs (182-195).
4. Повторное чтение draft (207-219): если ревизии уехали — throw «Generation inputs changed» (защита от правок во время materialize).
5. `createStage2Snapshot` (231-238) → persist `stage2.status='running'` (241-244) → `generateImageRequest` (`image-api.js:105`: pending-recovery → провайдер → materialize → карточка галереи) → draft `ready` (292-298) → `playStageSound` (302).
6. `finally` (364-376): удаление из `activeGenerations`, `stage2-end`, `releaseNext()` + очистка chain-head.

## 3. Контракт с SillyTavern

- `GENERATION_STOPPED` эмитится `stopGeneration()` безусловно (script.js:5548) → `onStopAll` (`index.js:168-171`): `abortAllGenerations()` + `stopQueue()`. Оба работают только по **уже зарегистрированным** контроллерам.
- localforage-черновики ключуются `(chatId, msgId)` — изоляция чатов есть везде, кроме `stage2Chains`.
- Auto-путь не получает внешний signal (`index.js:149`), значит отменяется только через собственный контроллер в `activeGenerations`.

## 4. Крайние случаи (что сейчас произойдёт)

| Сценарий | Сейчас | Оценка |
|---|---|---|
| Stop ST / onDisable, пока в chain ждёт 2-й элемент | 1-й абортится → `releaseNext` → 2-й **стартует**: контроллер ещё не создан, никем не абортируется → платный запрос «из-под» Stop/disable | **P1-2** |
| Ручная генерация в чате A (msgId 5) + переход в чат B и генерация msgId 5 | B ждёт окончания A (`stage2Chains` ключ = голый msgId, `pipeline-stage2.js:87`) — задержка до минут, без индикации | **P1-2 (ключ)** |
| Очередь + ручной клик на один пост | FIFO через chain — обе выполняются, оплата x2 по дизайну | ок (задокументировано `core.js:149-158`) |
| Auto + manual на один пост | Параллельно (auto bypass chain) — два запроса | ок по дизайну |
| Сообщение отредактировано во время materialize | Повторное чтение draft (207-219) ловит смену ревизии → throw, оплаты нет | ок |
| Сообщение отредактировано во время **провайдер-вызова**, генерация завершилась | `updateGenerationDraft` в catch/ready пишет со **старым** messageText: `getGenerationDraft` видит рассинхрон hash (черновик уже переписан правкой) → **пересоздаёт draft и перетирает отредактированный промпт**, поверх пишет status | **новая находка** (см. §6) |
| Refs materialize упал после 200 OK | outcome `materialize`, наблюдение не обвиняет модель; pending-запись остаётся для review | ок |
| `withDraftLock` при параллельных Stage 1/2 на один draft | Сериализация записи; token/revision guard отсекает устаревший apply | ок |

## 5. Хрупкие места

1. `pipeline-stage2.js:86-92 → 103`: постановка в chain **до** `try`; сегодня между ними нет throw, но любой будущий код в этом зазоре навсегда заблокирует цепочку поста (releaseNext не наступит).
2. Связка внешнего signal → ownController (`addEventListener('abort', …, {once:true})`, 114-117) не снимается — сигнал умирает вместе с контроллером, приемлемо.
3. `messageText` захватывается один раз на входе и дальше является «паролем» ко всем `updateGenerationDraft` — см. крайний случай из §4.
4. `state.queueAbort` в `finally` processQueue зануляется **после** reject remaining — порядок безопасен только потому, что блок синхронный.

## 6. Новая находка (из шага 4 протокола)

**Перетирание промпта при правке сообщения во время генерации.** Пользователь правит сообщение → ререндер → autosave пишет draft с новым hash → генерация завершается (успех или ошибка) → `updateGenerationDraft(chatId, msgId, СТАРЫЙ text, …)` в `pipeline-stage2.js:292/355` → внутри `getGenerationDraft` hash не совпал → черновик пересоздан пустым → промпт юзера потерян. Фикс (после P1-1/P1-2, отдельной задачей): в `updateGenerationDraft` при рассинхроне hash **не пересоздавать** draft молча, а пробрасывать «message changed» (updater-пути pipeline должны трактовать это как no-op, а не wipe).

## 7. План фикса P1-2 (минимальный)

```js
// pipeline-stage2.js — перенести ДО await prevPromise:
ownController = new AbortController();
if (signal) { if (signal.aborted) ownController.abort();
  else signal.addEventListener('abort', () => ownController.abort(), { once: true }); }
activeRequestId = crypto.randomUUID();
state.activeGenerations.set(activeRequestId, ownController);
const chainKey = `${chatId}:${msgId}`;               // cross-chat изоляция
// ...в try после await prevPromise:
useSignal = ownController.signal;
if (useSignal.aborted) throw new DOMException('Aborted', 'AbortError');
// ...в catch: не писать draft-статус, если run ещё не стартовал (флаг started)
```
Внешнее поведение «до»: очередность, оплата, события — не меняются. Меняется только отзывчивость abort до старта.

## 8. 5 вопросов, не извлекаемых из кода

1. Удерживает ли известные шлюзы соединение после abort — завершается ли генерация на сервере и списывается ли оплата (определяет, стоит ли делать «мягкую» отмену)?
2. Реальная частота cross-chat коллизий msgId — встречает ли юзер задержку из §4 на практике?
3. Нужен ли auto-пути внешний signal (сейчас `index.js:149` его не передаёт) — например, для будущего «Stop только авто»?
4. Ожидаемое поведение «Остановить» для элемента очереди: отменить текущий ИЛИ вычистить и хвост?
5. Есть ли у ST мобильной версии гонки visibilitychange, влияющие на pending-recovery записи?

## Самопроверка (Блок 0 п.6)

- «Что должно быть правдой, чтобы P1-2 была верна?» — что контроллер действительно создаётся после `await prevPromise`: подтверждено строками 104-119; что Stop идёт через `activeGenerations`: подтверждено `core.js:203-207`.
- «Какой сценарий сломает фикс?» — если `releaseNext` перестанет вызываться при throw до старта: закрыто `finally` (365-376) — перенос регистрации не меняет finally-путь.
- **Не уверен**: точное поведение провайдеров при abort после отправки (вопрос §8.1) — проверяется только рантаймом/биллингом; в статике не доказуемо.

## 9. Addendum 2026-09-19 — ручная генерация через очередь (fire-and-forget)

- «Сгенерировать» больше не зовёт `runStage2ForDraft` напрямую из обработчика: `submitCurrentGeneration` (`tab-generate.js`) ставит `current-prompt-stage2` item в `pipeline-queue` с `item.submission` — submit-time снапшотом промпта/параметров/коррекций.
- `runStage2ForDraft` получил `opts.submission`: снапшот авторитетен над драфтом, не пишется в драфт и не проходит post-materialize revision re-check (актуален только для reading-прогонов: auto и legacy). `opts.instruction` (галерея) семантически близок, но по-прежнему пишет промпт в драфт. Невалидный submission (пустой/нестроковый prompt, комбинация с instruction) кидает fail-closed до всякого ввода-вывода.
- Таблица §1, строка «ручной Сгенерировать»: место вызова — `tab-generate.js` (`submitCurrentGeneration` → `enqueueGeneration`), в chain — опосредованно (очередь серийна; chain остаётся рабочей сериализацией для галерейной регенерации).
- Крайний случай §4 «Сообщение отредактировано во время materialize → throw» сохраняется только для reading-прогонов; для submission-прогонов гонка исключена построением (пин: mid-run-тест в `tests/pipeline-stage2-submission.test.js`).
- Крайний случай §6 (перетирание промпта при правке исходного сообщения во время генерации) не ухудшился и не устранён — отдельная задача.
- События `uris:stage{1,2}-start/end` теперь несут `chatId`; Stop-кнопка таба ключует in-flight по `chatId:msgId` (Set) — интерливинг «Stage 2 летит → Stage 1 стартует/заканчивается» больше не прячет кнопку, студия и чат-пост №0 изолированы. Пока летят обе стадии, кнопка тегирована последним стартовавшим реквестом (LIFO): клик «Остановить» отменяет перестройку промпта, а не картинку; к Stage 2 кнопка возвращается по `stage1-end`.
- Известное ограничение: очередь сессионная (`state.queue` в памяти) — перезагрузка страницы молча теряет ожидающие item'ы (без тоста и диагностического следа); промпты не теряются — они записаны в драфты в момент клика, задачи можно переотправить. Персистенция/восстановление очереди — отдельная задача.
