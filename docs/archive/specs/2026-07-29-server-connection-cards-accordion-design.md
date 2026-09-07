# Карточки серверных коннектов: гармошка и удаление миграции

Дата: 2026-07-29

## Задача

Две связанные вещи во вкладке «API», блок «Image-коннекты»:

1. Серверные карточки коннектов сейчас плоские — все поля идут подряд, свернуть
   нельзя. Редактировать три коннекта неудобно. Привести их к карточному
   паттерну, который уже используется в проекте для legacy-коннектов и шаблонов:
   шапка с шевроном и именем, сворачиваемое тело.
2. Секция `.uris-migration-pending-section` («Legacy connections ready for server
   migration») висит в UI и не даёт ничего перенести. Убрать миграцию целиком.

## Исходное состояние

**Серверная карточка** — `src/ui/server-connection-form.js:66` (`renderServerConnectionForm`).
Рендерит `.uris-server-connection` без шапки: строки Name / Endpoint / API key,
кнопка Probe, строка Route, предупреждения, Save, Delete. Каждая кнопка — отдельным
блоком.

**Карточный паттерн** — уже есть и работает. CSS в `style.css:178-195`
(`.uris-preset-card`, `.uris-preset-card-header`, `.uris-acc-chevron`,
`.uris-preset-card-body`, `.uris-collapsed`), эталон разметки — `imageConnFields`
в `src/ui/tab-api.js:535`, эталон биндинга — `bindConnRows` в `src/ui/tab-api.js:672-680`.

**Миграция** — `src/server-connection-migration.js` (310 строк) плюс
`tests/server-connection-migration.test.js` (1050 строк), автозапуск в
`index.js:100-104`, UI-секция в `src/ui/tab-api.js`, шесть helper-функций в
`src/connections.js:377-445`.

## Найденный дефект (обоснование удаления)

Миграция не работала никогда. `migrateConnection` собирает `createInput`
(`src/server-connection-migration.js:238-246`) без `apiKey` и без `probeId`, а
`POST /v1/connections` требует оба: `requireKey` бросает `API_KEY_REQUIRED`
(`server-plugin/src/router.js:139`), дальше `receipts.peek` проверял бы квитанцию
(`router.js:140-142`). Результат — HTTP 400 на каждый клик «Probe & Migrate».

Оба значения были на руках: `apiKey` читается на шаге 3, `probeId` приходит в
`probeResult` на шаге 4. Они просто не попадали в тело запроса.

Тесты дефект пропустили: они подменяют `createServerConnection` фейком, который
принимает любой вход, и проверяют только `id`, `endpoint`, `apiFamilyOverride`
(`tests/server-connection-migration.test.js:626`). Контракт с сервером нигде не
зафиксирован.

Решение — не починить, а удалить: расширением пользуются два человека, миграцией
ни одна запись перенесена не была, а поддержка стоит ~1400 строк.

## Часть 1: карточка-гармошка

`renderServerConnectionForm` переходит на карточный паттерн:

```
+--------------------------------------------------+
| v  [ My OpenAI            ]  gpt-image-1         |   <- header, клик сворачивает
+--------------------------------------------------+
| Endpoint  [ https://api.openai.com/v1        ]   |   <- body
| API key   [ ••••••••                         ]   |
| Route     [ gpt-image-1                    v ]   |
| [ Probe ]  [ Save ]  [ Delete ]                  |
+--------------------------------------------------+
```

Корневой элемент получает классы `uris-preset-card uris-server-connection` плюс
`uris-collapsed` в свёрнутом состоянии. `uris-server-connection` сохраняется:
по нему идёт выборка в `src/ui/tab-api.js:493` и висят серверные стили
(`style.css:221-226`).

Шапка `.uris-preset-card-header` содержит:

- `<i class="fa-solid fa-chevron-down uris-acc-chevron">` — поворот на 90° в
  свёрнутом виде уже описан в `style.css:194`;
- поле имени — остаётся `.uris-server-name`, чтобы `collectServerConnectionForm`
  (`server-connection-form.js:108`) читал его тем же селектором;
- подпись роута `.uris-server-route-label` — label выбранного роута, либо
  `manualModelId`, либо «роут не выбран» для черновика.

Тело `.uris-preset-card-body` содержит всё остальное в текущем порядке: Endpoint,
API key, Probe, Route, `.uris-server-fetched`, предупреждения, advanced-блок,
кнопки Save и Delete. Кнопки собираются в один ряд `.uris-server-actions` —
класс уже определён (`style.css:265`).

Строка `Name` из тела удаляется: имя теперь только в шапке.

Новый CSS — одно правило на `.uris-server-route-label`: приглушённый мелкий текст,
`flex: 0 0 auto`, обрезка по `text-overflow: ellipsis`. Остальное наследуется.

Предупреждения probe (`.uris-server-warning`, `errorMessage`) остаются внутри тела:
они появляются в ответ на действие пользователя, а карточка в этот момент
развёрнута.

Блок `.uris-server-unavailable` выносится из тела в корень карточки, перед шапкой.
Он рисуется по состоянию сервера при любом рендере, а не по действию пользователя,
и в свёрнутой карточке был бы не виден.

## Часть 2: состояние сворачивания

Состояние хранится в `state.settings.accordionState` через
`getAccordionOpen`/`setAccordionOpen` (`src/ui/accordion-state.js`) по ключу
`api:server-conn:<id>`. Дефолт — свёрнуто (`defaultOpen = false`): у сохранённого
коннекта смотреть нечего, пока его не редактируют.

`bindHeaderToggle` не используется: он переключает класс `hidden` на теле, а
карточный CSS работает через `uris-collapsed` на корне. Вместо него — локальный
биндер в `bindServerConnectionForm`, повторяющий `bindConnRows`
(`src/ui/tab-api.js:672-680`): клик по шапке, игнор клика по `input`, переключение
`uris-collapsed` и `hidden` на теле, запись через `setAccordionOpen`.

Черновик (`draftId` без `id`) всегда развёрнут и в storage не пишется: id
временный, накопил бы мусор в `accordionState`.

При удалении коннекта — `forgetAccordion('api:server-conn:' + id)`, чтобы не
оставлять orphan-ключи.

Перерисовка секции после probe/save состояние не сбрасывает: оно читается из
storage при каждом рендере.

## Часть 3: удаление миграции

Удаляется полностью.

**Файлы целиком:**

- `src/server-connection-migration.js`
- `tests/server-connection-migration.test.js`

**`index.js`:** импорты миграции (`:42-43`), функция `migrateLocalConnections`
(`:268-309`), её вызов (`:104`). Импорт `listConnections`, `getConnection`,
`getConnectionKey` из `connections.js` сохраняется, если он нужен другим местам —
проверить по факту.

**`src/ui/tab-api.js`:** `renderMigrationPendingCard`, `migrationPendingProbes`,
`bindMigrationPendingCard`, `buildMigrationDeps`, сканирование кандидатов в
`renderImageConnSection` (`:463-474`), блок рендера секции (`:485-489`), импорты
из `server-connection-migration.js` (`:27-29`). Импорты `listConnections`,
`getConnectionKey`, `probeTransientConnection`, `createServerConnection`,
`listServerConnections`, `removeLocalConnectionKey` и других migration-helper'ов
чистятся по факту неиспользования — часть из них нужна legacy-карточкам.

**`src/connections.js`:** `removeLocalConnectionKey`, `removeLegacyMigratedSecret`,
`removeMigratedLocalRecord`, `saveMigrationState`, `loadMigrationState`,
`deleteMigrationState` и константа `LF_MIGRATION_STATE_PREFIX` (`:365-445`).

**`style.css`:** блок `.uris-migration-*` (`:279-311`).

**Тесты:** migration-блоки в `tests/tab-api-server-connections.test.js`
(`:191-255`, `:363-500`) и семь smoke-тестов в `tests/smoke.test.js` (`:477-537`).

### Порядок работ

Сначала удаление кода, потом пользователь заново создаёт коннекты через «Добавить
server image-коннект». Endpoint'ы вводятся по памяти — согласовано.

### Старые записи в localforage

После удаления записи с `apiType` openai/gemini/auto становятся полностью
недоступными из UI. Они и сейчас не попадают в список коннектов —
`isLegacyImageConnection` (`src/connections.js:210`) пропускает только `agnes` и
`pollinations` — а migration-секция была последним местом, где они отображались.

Автоочистки нет: одноразовый код в репозиторий не добавляется. Пользователь
чистит вручную через DevTools → Application → IndexedDB (инстанс localforage
SillyTavern):

- `uris_connections` — массив коннектов, удалить элементы с `apiType` `openai`,
  `gemini` или `auto`;
- `uris_conn_key_<id>` — API-ключ каждой удалённой записи;
- `uris_migration_state_<id>` — остатки состояния миграции, если есть.

Записи `agnes` и `pollinations` в `uris_connections` трогать нельзя: они живые.

## Проверка

`node --test tests/*.test.js` целиком — это поймёт всё, что цеплялось за удалённые
экспорты. Отдельно смотрим `tests/tab-api-server-connections.test.js` и
`tests/smoke.test.js`: в них были прямые ссылки на migration-символы.

Новые тесты на гармошку: рендер шапки с шевроном, именем и подписью роута; тело
скрыто при `accordionState[api:server-conn:<id>] === false`; черновик развёрнут
независимо от storage; клик по шапке пишет состояние, клик по полю имени — нет.

Проверка вживую в SillyTavern: карточка сворачивается и разворачивается, состояние
держится после перезахода на вкладку, probe и save работают как раньше.

## Что не делается

- Миграция не починена — удалена. Возврат к теме потребует нового спека.
- Кнопки «Забыть локально» на legacy-карточках нет: секция удаляется целиком.
- Массовой очистки localforage нет.
- Legacy-карточки (`agnes`, `pollinations`) не меняются: у них карточный паттерн
  уже есть.
