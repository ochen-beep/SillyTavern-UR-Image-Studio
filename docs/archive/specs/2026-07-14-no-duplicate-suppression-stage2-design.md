# Отмена подавления повторной генерации Stage2 — гарантированное сохранение каждого клика

- **Дата**: 2026-07-14
- **Статус**: design approved
- **Зависимости**: нет (изолированное изменение pipeline + state)
- **Исходный план**: `docs/plans/2026-07-14-no-duplicate-suppression-stage2.md`

## Цель

Каждое нажатие кнопок генерации в галерее/на вкладке «Генерация» должно сохранять отдельную картинку в галерее — даже при абсолютно одинаковых вводных (промпт, референсы, пост). Расширение не должно искусственно ограничивать «мифические дубли».

## Архитектура

### Состояние

- Удалить `state.stage2RunningMsgId`.
- Добавить `state.stage2Chains: Map<msgId, Promise>` — per-msgId FIFO-цепочка ручных Stage2.

### Сериализация в `runStage2`

- Ручные вызовы (`opts.isAuto !== true`) встают в очередь для конкретного `msgId` и выполняются строго один за другим.
- Каждый вызов сохраняет отдельную картинку (`100 кликов = 100 картинок`).
- Upstream-запросы не дублируются в один момент благодаря последовательной цепочке.
- Авто-flow (`opts.isAuto: true`) обходит цепочку и идёт параллельно ручным кликам — оба результата сохраняются.

### Файлы изменений

| Файл | Изменение |
|------|-----------|
| `src/core.js` | Удалить `stage2RunningMsgId`; добавить `stage2Chains` с комментарием-обоснованием |
| `src/pipeline.js` | `runStage2`: убрать guard-блок; добавить сериализацию per-msgId через Promise-chain; опция `opts.isAuto`; безопасная очистка Map-entry |
| `index.js` | В `onStage1Ready` передать `{ isAuto: true }` в `runStage2` |
| `src/ui/tab-gallery.js` | Обёртка кнопки `[data-act="regen"]` в `disabled`-маску на время одной генерации |

## Data flow

1. Ручной клик → `runStage2(msgId, instruction, onStatus, signal, opts)`.
2. Если `!opts.isAuto && msgId != null`:
   - Получаем текущий хвост цепочки `state.stage2Chains.get(msgId)`.
   - Создаём `myNext = new Promise(r => releaseNext = r)`.
   - Записываем в Map: `state.stage2Chains.set(msgId, myNext)`.
   - В `try` ждём `prevPromise` (`await prevPromise.catch(() => {})`).
3. Создаём `AbortController` только после ожидания очереди, чтобы `state.abortController` указывал на активную генерацию, а не queued-вызов.
4. Выполняем тело Stage2 (resolve presets, collect refs, generate, save pending, process pending).
5. В `finally`:
   - Сбрасываем `state.abortController`.
   - Освобождаем `releaseNext()`.
   - Если наш промис всё ещё последний в Map — удаляем entry.

## Error handling

- Abort одного вызова не отменяет следующие в очереди (`prevPromise.catch(() => {})`).
- Map-entry чистится только если наш промис остался последним, что предотвращает утечку при переключении постов.

## Тестовое покрытие

Добавляем `tests/pipeline-stage2-serialization.test.js` в стиле существующих тестов проекта.

| Блок | Проверка |
|------|----------|
| FIFO per msgId | Три быстрых вызова `runStage2` без `isAuto` → `generateImage` вызывается ровно 3 раза, последовательно |
| Auto bypass | Вызов с `{isAuto:true}` не ждёт текущей manual-цепочки и выполняется параллельно |
| Cleanup | После завершения всех вызовов `state.stage2Chains` не содержит обработанный `msgId` |
| Abort isolation | Abort первого вызова не прерывает второй в очереди |
| No old guard | `state.stage2RunningMsgId` отсутствует, сообщение `пропуск дубля` не логируется |

## Acceptance criteria

1. Три последовательных клика «Сгенерировать» → ≥3 новых записей в галерее.
2. Три быстрых клика «Перегенерировать» на одной карте → 3 отдельных картинки.
3. `stage1Mode='auto'` + `stage2Mode='auto-after'` + одновременный ручной клик → сохраняются обе картинки.
4. В логах больше не появляется `Stage2: уже выполняется для поста N - пропуск дубля`.
5. `grep -rn "stage2RunningMsgId" src/ index.js` → ни одного совпадения.
6. Batch-режим «В очередь» (`enqueue`) работает как прежде.
