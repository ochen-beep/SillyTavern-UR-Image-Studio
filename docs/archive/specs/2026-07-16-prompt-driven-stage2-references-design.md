# Prompt-driven Stage 2 references — дизайн

**Дата:** 2026-07-16  
**Статус:** Approved (brainstorming complete)  
**Автор:** URIS Dev + ZCode  
**Уточняет:** `2026-07-15-scene-first-generation-design.md`

## 1. Проблема

Текущий scene resolver вычисляет `stage2Refs` по исходному тексту сообщения до запуска Stage 1. Поэтому персонаж может остаться в `#urisRefsPreview`, даже если готовый prompt Stage 1 его не содержит и Stage 2 не должна изображать его.

Нижний слой уже хранит message-scoped `includedIds` и `excludedIds`, но Generate UI предоставляет corrections только для неоднозначных совпадений. Обычный автоматически найденный reference нельзя удалить, а нераспознанный reference нельзя добавить как correction текущего сообщения.

В результате видимый prompt и видимый набор изображений Stage 2 могут описывать разные сцены, а пользователь не может исправить расхождение.

## 2. Решение

Stage 1 и Stage 2 получают разные детерминированные разрешения сущностей:

1. **Stage 1 scene context** разрешается по исходному тексту сообщения до text-LLM request. Он определяет текстовые descriptions, которые помогают Stage 1 построить prompt.
2. **Stage 2 reference context** разрешается по текущему сохранённому `draft.prompt`. Он определяет автоматические image references, которые будут отправлены image provider.

Готовый и редактируемый prompt становится источником истины для автоматических Stage 2 refs. Исходное сообщение не добавляет image reference само по себе.

Это целенаправленно заменяет принцип `one resolver, one snapshot` из исходного scene-first дизайна более точным принципом:

> Один детерминированный matching contract, два явно разделённых входа и два snapshot lifecycle.

Обе фазы используют одинаковые правила строгого matching для canonical name, aliases, Unicode-регистра, границ слов и неоднозначностей. Они не используют LLM, keywords или descriptions для распознавания.

## 3. Модель данных

`draft.stage1.contextSnapshot` остаётся неизменяемой записью контекста, реально переданного Stage 1. Она не переписывается при редактировании готового prompt.

Текущее разрешение Stage 2 вычисляется из:

```text
current draft.prompt
+ reference candidates
+ draft.references.includedIds
+ draft.references.excludedIds
```

и нормализуется в представление со следующими логическими полями:

```js
{
  promptHash,
  referencesRevision,
  entities: [],
  stage2Refs: [],
  ambiguities: []
}
```

Это представление может храниться в draft или вычисляться при чтении. Выбор является деталью реализации, но оно не должно считаться частью исторического Stage 1 snapshot.

Перед provider call создаётся существующий immutable Stage 2 snapshot. В него копируются точный prompt и эффективные refs, вычисленные из одной актуальной версии draft. Последующее редактирование prompt или corrections не меняет уже запущенный запрос, gallery entry или queued current-prompt snapshot.

## 4. Эффективный набор Stage 2 refs

Автоматический набор содержит только сущности, чьи canonical name или явный alias присутствуют в текущем prompt.

Ручные corrections применяются поверх автоматического набора:

```text
(autoDetectedFromPrompt − excludedIds) ∪ includedIds
```

Правила приоритета:

- ручной `×` сохраняет entity ID в `excludedIds`, поэтому сущность не возвращается при последующих изменениях prompt;
- ручной `+` сохраняет entity ID в `includedIds`, поэтому сущность остаётся даже без имени в prompt;
- добавление исключённой сущности удаляет её из `excludedIds` и добавляет в `includedIds`;
- удаление вручную добавленной сущности удаляет её из `includedIds` и добавляет в `excludedIds`;
- corrections принадлежат текущему `chatId + msgId`, переживают rerender и reload и не меняют global reference pool;
- изменение prompt не сбрасывает corrections;
- порядок остаётся стабильным: manual includes, затем `char`, `user`, затем автоматически найденные NPC в порядке первого упоминания в prompt.

Пустой prompt даёт только вручную включённые refs. До появления prompt автоматический Stage 2 набор пуст.

## 5. Generate UI

`#urisRefsPreview` показывает эффективные Stage 2 image refs для текущего сохранённого prompt, а не `draft.stage1.contextSnapshot.stage2Refs`.

Каждый effective reference имеет действие `×`. Действие создаёт message-scoped exclusion и немедленно обновляет preview.

Кнопка `+` открывает picker глобального reference pool. В picker доступны сущности с изображением, которые ещё не входят в effective set. Выбор создаёт message-scoped inclusion и немедленно обновляет preview. Picker не изменяет chat-scoped legacy extras и не добавляет сущность в исходный текст или prompt.

При каждом изменении prompt:

1. текст сохраняется в соответствующий message-scoped draft;
2. строгий resolver синхронно пересчитывает автоматические refs по текущему тексту;
3. сохранённые corrections накладываются поверх результата;
4. preview обновляется в том же UI update cycle.

Resolver локальный и дешёвый, поэтому отдельная кнопка обновления не нужна. Реализация может объединять частые DOM renders, но видимое состояние не должно отставать от сохранённого prompt перед Stage 2.

Неоднозначное имя в prompt не включает ни одного кандидата автоматически. UI показывает ambiguity рядом с preview; выбор кандидата создаёт обычный manual include.

Legacy controls `extraRefIds` и `descRefs` не должны выглядеть как управление эффективным Stage 2 набором. В prompt-first Generate flow `+`/`×` работают только через `draft.references`.

## 6. Pipeline и конкурентность

### 6.1. Ручной Stage 1

Stage 1 получает scene context, вычисленный по исходному сообщению. После сохранения результата prompt UI и следующий Stage 2 resolution вычисляются по новому prompt.

### 6.2. Ручной Stage 2

Перед запуском pipeline атомарно читает текущий draft, разрешает refs по точному отправляемому prompt и создаёт immutable Stage 2 snapshot. Preview и provider input должны использовать один и тот же effective-resolution contract.

### 6.3. Автоматический Stage 2

После успешной Stage 1 pipeline сначала сохраняет prompt в исходный message-scoped draft, затем разрешает Stage 2 refs по этому prompt и только после этого запускает image provider. Он не переиспользует `stage1.contextSnapshot.stage2Refs`.

### 6.4. Навигация и поздние ответы

Resolution всегда привязан к draft исходного `chatId + msgId`. Переход на другое сообщение не переносит prompt, corrections или refs. Поздний Stage 1 response следует существующей защите run/revision token и не должен перетирать более новую ручную редакцию либо запускать Stage 2 с refs от другого текста.

## 7. Ошибки и совместимость

- Ошибка загрузки отдельного image reference отображается как warning и обрабатывается существующей provider policy; она не меняет corrections.
- Удалённый из global pool ID игнорируется при разрешении и может быть очищен стандартной sanitization draft state.
- Provider mode/capability filter (`never`, лимит refs, отсутствие поддержки refs) применяется после prompt-driven resolution. Preview provider truncation должен соответствовать фактическому request.
- Сохранённые drafts без новых вычисляемых полей не требуют миграции: Stage 2 resolution восстанавливается из `prompt` и существующих corrections.
- Старое `stage1.contextSnapshot.stage2Refs` можно временно сохранять для диагностики/совместимости, но оно не является источником текущего preview или нового Stage 2 request.

## 8. Тестирование

### 8.1. Resolver

- NPC присутствует в исходном сообщении, но отсутствует в prompt: Stage 1 context содержит NPC, Stage 2 refs не содержит его;
- NPC отсутствует в сообщении, но присутствует в prompt: Stage 2 resolver добавляет его;
- canonical name, alias, Unicode case и word boundaries работают одинаково для обеих фаз;
- keyword и description не создают Stage 2 match;
- пустой prompt не создаёт automatic refs;
- ambiguity не включает кандидатов автоматически.

### 8.2. Corrections

- `×` удаляет обычный автоматически найденный ref;
- исключённый ref не возвращается после удаления и повторного ввода имени в prompt;
- `+` добавляет нераспознанный ref;
- вручную добавленный ref остаётся после изменений prompt;
- повторное добавление снимает exclusion;
- corrections одного сообщения не влияют на другое и переживают reload.

### 8.3. UI

- preview обновляется после ввода и удаления имени в prompt;
- каждый effective chip можно удалить;
- picker добавляет pool ref через `includedIds`, а не legacy extras;
- preview после `+`/`×` совпадает с effective resolver output;
- ambiguity selection обновляет preview;
- переключение сообщений показывает refs соответствующего draft.

### 8.4. Pipeline

- manual Stage 2 отправляет refs текущего prompt;
- auto Stage 2 после Stage 1 отправляет refs результата Stage 1, а не исходного сообщения;
- ручная редакция перед Stage 2 меняет refs;
- immutable snapshot не меняется после последующей редакции;
- provider mode и cap применяются к prompt-driven набору;
- navigation race и поздний Stage 1 response не смешивают drafts.

## 9. Критерии приёмки

- NPC, упомянутый только в исходном посте, не попадает в Stage 2, если его нет в текущем prompt.
- NPC, распознанный в текущем prompt, автоматически появляется в `#urisRefsPreview`.
- Изменение prompt немедленно обновляет автоматический набор refs.
- Любой effective ref можно удалить через `×`.
- Любой подходящий pool ref можно добавить через `+`, даже если он не распознан в prompt.
- Ручные additions и exclusions сохраняются при последующих пересчётах текущего сообщения.
- Preview, immutable Stage 2 snapshot и фактический provider request основаны на одном prompt-driven effective set.
- Stage 1 продолжает получать descriptions, разрешённые по исходному сообщению.
- Решение не добавляет LLM-запросов и не требует миграции сохранённых drafts.
