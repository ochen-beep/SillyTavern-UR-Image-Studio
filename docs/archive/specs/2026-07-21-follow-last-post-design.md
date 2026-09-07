# Дизайн: «Следить за последним постом» (follow-last-post)

Дата: 2026-07-21

## Проблема

Пост-навигатор (`uris-postnav`) во вкладке «Генерация» не следует за свежими
сообщениями: после генерации нового поста или свайпа вкладка продолжает
показывать ранее выбранный пост. `state.currentMsgId` сейчас переставляется на
последний пост только внутри `triggerIfMatches` (срабатывание автоматизации) и
на `CHAT_CHANGED`. В ручном режиме автоматизации — никогда.

## Требования

1. Переключатель «Следить за последним постом»:
   - **ON** — навигатор и вкладка «Генерация» всегда показывают последний пост
     (по текущему фильтру потока) после генерации поста, свайпа или отправки
     сообщения.
   - **OFF** — выбор поста только вручную стрелками ←/→; события чата выбор не
     двигают.
2. Галочка не снимается сама (в т.ч. при ручной навигации стрелками) — только
   пользователем. При follow=ON ручной уход стрелками на старый пост возможен,
   но следующее событие вернёт навигатор на последний пост.
3. Авторежим (automationMode ≠ manual) не зависит от галочки: пайплайн всегда
   работает с последним сгенерированным постом (уже реализовано в
   `triggerIfMatches`, не меняется).
4. Настройка глобальная (extension_settings), не per-chat. Дефолт: **ON**.

## Реализация

### Настройка (core.js)

- `defaultSettings.followLastPost = true`. Сохранение через существующий
  `saveSettings` (extension_settings). Миграции не нужны — дефолт покрывает
  старые установки (`state.settings.followLastPost ?? true` при чтении).

### События (events.js)

Новый обработчик (один на три события), подписывается в `bindEvents`, снимается
в `unbindEvents`:

- События: `GENERATION_ENDED`, `MESSAGE_SENT`, `MESSAGE_SWIPED`.
- Условие: `state.settings.enabled` и `followLastPost !== false`.
- Действие: `setCurrentMsgId(getLastPostIndex())`; если `currentMsgId` изменился
  или событие — `MESSAGE_SWIPED` (контент того же поста сменился), диспатчим
  `window` событие `uris:post-follow`.
- Хуки работают независимо от `automationMode` (это UI-поведение, не пайплайн)
  и не запускают автоматизацию. Guard `_chatConfigReady` не применяем — snap
  безопасен и во время загрузки конфига.
- На `MESSAGE_SWIPED` тоже snap к `getLastPostIndex()` (семантика «показывать
  последний», а не «перейти к свайпнутому»).

### UI (tab-generate.js + style.css)

- Иконка-тогл в `.uris-postnav` сразу после `#urisPostInfo` (в обоих вариантах
  рендера: полном и empty-state):
  - `<button id="urisFollowLast" class="uris-postnav-btn uris-follow-toggle">`
    с иконкой `fa-magnet`, `title="Следить за последним постом"`,
    `aria-pressed` по состоянию.
  - Активное состояние — класс `is-active` (подсветка, стиль рядом с
    `.uris-postnav-btn` в style.css).
- Клик: инвертирует настройку, `saveSettings()`; при включении — немедленный
  snap `setCurrentMsgId(getLastPostIndex())` + re-render. При выключении
  выбор не двигается.
- Вкладка слушает `uris:post-follow`: если вкладка «Генерация» активна и панель
  видима — `refreshActive()` (re-render восстановит текст из драфта; автосейв
  промпта уже существует, потери ввода нет). Подписка — один раз в `init()`
  (index.js), рядом с `uris:stage1-ready`; снятие в cleanup.

### post-navigator.js

Без изменений: `setCurrentMsgId` / `getLastPostIndex` уже дают нужные
примитивы.

## Обработка ошибок / краевые случаи

- Пустой чат / нет подходящих постов: `getLastPostIndex()` → null,
  `setCurrentMsgId(null)` — существующее поведение empty-state.
- Событие во время стриминга: `GENERATION_ENDED` приходит после завершения —
  snap безопасен; `MESSAGE_SWIPED` приходит после перерисовки сообщения ST.
- Фильтр потока (ai-only/user-only/all) учитывается через существующий
  `getLastPostIndex()`.

## Тесты (tests/events.test.js, tests/tab-generate.test.js)

- follow=ON: `GENERATION_ENDED`/`MESSAGE_SENT`/`MESSAGE_SWIPED` →
  `currentMsgId` = последний подходящий пост + dispatched `uris:post-follow`.
- follow=OFF: те же события не двигают `currentMsgId`, событие не диспатчится.
- follow=ON + ручная навигация: стрелки работают, флаг не сбрасывается.
- `unbindEvents` снимает новые слушатели.
- UI: рендер тогла (оба состояния), клик включает → snap на последний пост.

## YAGNI

- Не делаем: per-chat хранение, авто-снятие галочки, «перейти к свайпнутому
  сообщению» вместо последнего, отдельные флаги для свайпа и генерации.
