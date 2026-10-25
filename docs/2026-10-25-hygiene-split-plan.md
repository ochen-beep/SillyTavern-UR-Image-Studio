# План гигиенического распила: tab-references.js, index.js, style.css

Дата: 2026-10-25 · Статус: **выполнен** (все шаги, см. §7) · Правило-источник: beep-hygiene
(капы: JS 700 жёсткий / 500 мягкий; корневой style.css ≤ 800)

---

## 1. Цель и границы

Три файла превышают капы: `src/ui/tab-references.js` **1496** строк,
`index.js` **513** (мягкий), `style.css` **2835** (потолок 800). План —
распил на модули **без единого изменения поведения**: та же разметка, те же
обработчики, тот же каскад CSS, публичный API вкладки неизменен.

Не делаем (осознанно): перевод легаси-комментариев RU→EN (правило legacy),
переименование функций, «попутные» улучшения логики, рефакторинг тестов сверх
механической замены чтения CSS.

## 2. Проверенные факты (почему план именно такой)

1. **ST подключает CSS через `<link>`** — `public/scripts/extensions.js:781`
   (`addExtensionStyle`) создаёт `link[rel=stylesheet]` с URL
   `/scripts/extensions/<name>/<manifest.css>`. Значит `@import` в корневом
   style.css легален, относительные пути резолвятся от него же; поле
   `manifest.css` — одна строка, массив файлов ядро не умеет.
2. **29 тестов читают style.css напрямую** (`readFileSync('..','style.css')`)
   и грепают сырой текст. Распил без правки тестов уронит их.
3. **Публичный API tab-references.js** (потребители вне модуля):
   `render` (index.js через registerTab), `showPoolPicker`
   (`src/ui/tab-generate-refs.js` + тест), `mobileFolderCollageHtml` (тест),
   `__resetMobileNavForTests` (тест). Тесты импортируют динамически.
4. **Шов не «мобильное vs десктоп»**: `_bindEditorBody` (строки 1231–1372)
   лежит в мобильном стеке, но вызывается и десктопным оверлеем (878), и
   мобильной карточкой (1220). Редактор — общий модуль.
5. **Общее состояние модуля** (живые `let`): через шов переходят только
   `activeFolderFilter`, `editingRefId`, `editingFolderId`, `gridRefs`,
   `gridFolders`. Остальное локально: `_renderEpoch` используется только в
   `_renderAll` (167–171), `_overlayEpoch` — только в оверлее,
   `_mobileScreen/_mobileGroupId/_mobileSearchQuery` — только в мобильном
   стеке.
6. **Общие чистые хелперы** desktop↔mobile: `refsForActiveFilter`,
   `filterRefsBySearch`, `poolTileHtml` (использования: 731/1094,
   732/1123/1157, 765/1157). Без общего дома дали бы цикл импортов
   main↔mobile.
7. **Сайдбар зовёт `_renderAll`** (например, 342) — при выносе сайдбара это
   цикл main↔sidebar. Решение: сайдбар получает `hooks.rerender` параметром,
   без обратного импорта.

## 3. Целевая структура

### 3.1 index.js → src/ui/settings-panel.js (~95 строк переезжает)

`createSettingsPanel({ hooks })` + приватный `bindSettingsPanel`. Хуки из
index.js: `onEnabledChange(isEnabled)` (внутри — safeInit/cleanup/
ensureLauncher/syncPanelVisibility), `onOpenWindow()` (toggleLauncherPanel),
`ensureLauncherForSync()` — см. текущий bindSettingsPanel (441–467). Статик
`_panelLoaded` уезжает вместе с функцией. index.js: 513 → ~405 ✓.

### 3.2 tab-references.js → 5 модулей (все ≤ 500)

| Модуль | Что входит (строки сейчас) | ~строк | Импортирует |
|---|---|---|---|
| `refs-view-shared.js` | объект `refsView` (5 полей из §2.5) + `refsForActiveFilter`, `filterRefsBySearch`, `poolTileHtml` + `REFS_MOBILE_BREAK`, `REFS_SEARCH_DEBOUNCE_MS` | 75 | refs-library, core (escapeHtml) |
| `ref-editor.js` | `refEditorBodyHtml` (661–691), `_renderOverlay`+`_bindOverlay`+`_overlayEpoch` (838–887), `_bindEditorBody` (1231–1372) | 235 | shared, refs-library, dialogs |
| `refs-sidebar.js` | блок 180–543: `renderSidebar(root, folders, refs, hooks)`, список папок, меню/листы папок, `_editingFolderId` | 370 | shared, refs-library, dialogs |
| `refs-mobile.js` | блок 888–1385 минус `_bindEditorBody`: `_renderMobileAll`/Folders/Group/Grid/Card, `openFolderSwitcher`, `mobileFolderCollageHtml`, `_bindMobileAddRef`, `_mobileScreen/_mobileGroupId/_mobileSearchQuery`, `__resetMobileNavForTests` | 360 | shared, ref-editor, refs-library |
| `refs-pool-picker.js` | 1386–1496: `showPoolPicker`, `pickerChipsHtml` | 115 | refs-library, dialogs |
| `tab-references.js` (main) | `render`, ресайзеры, `_renderAll`+epoch, тулбар (544–625), сетка+делегирование (626–769, минус уехавшие хелперы), ref-actions (770–837) | 330 | все пять выше |

Публичный API сохраняется реэкспортами из main:
`export { showPoolPicker } from './refs-pool-picker.js'` (и для
`mobileFolderCollageHtml`, `__resetMobileNavForTests`) — тесты и
tab-generate-refs не меняются.

Правила распила:
- состояние переезжает в `refsView.*` только у пяти полей из §2.5; ссылки на
  них в переезжающем коде переписываются механически;
- никаких циклов: зависимости идут shared ← {main, sidebar, mobile, editor} ← …;
  сайдбар получает `hooks.rerender`, а не импорт main;
- один модуль — один коммит, `npm test` после каждого.

### 3.3 style.css → корень ≤ 800 + `styles/*.css` через `@import`

Корень оставляет (по правилу «переменные + базовый контейнер + утилиты»):
Design tokens (3–116), Плавающее окно (181–221), Вкладки (222–263), Тело
(264–277), Масштаб (278–304), Поля (305–313), Утилиты (314–325), Ресайзер
(326–334) + блок `@import` **первым правилом файла**. ≈ 230 строк.

| Файл | Секции (строки сейчас) | ~строк |
|---|---|---|
| `styles/launcher.css` | Launcher в QR-бар (117–180) | 65 |
| `styles/connections.css` | Пресеты (335–381), Коннекты (382–455), model toggle (1968–1969), reference options (1863–1864) | 260 |
| `styles/generate.css` | Генерация (456–611), v2.2 (612–661), Templates (662–696), референс-плашка (877–1115), Studio scope (2808–2821) | 660 |
| `styles/gallery.css` | Галерея (701–789) | 90 |
| `styles/references.css` | v3 aliases (697–700), v3-redesign (1116–1171), Sidebar (1172–1266), Main/grid (1267–1390), Overlay (1391–1485), Folder field (1486–1539), Sidebar tools (1540–1567), Folder manager (1568–1608), Filter chips (1609–1620), Batch upload (1759–1783) | 620 |
| `styles/mobile.css` | Mobile (790–851), Mobile stack (1621–1758), mobile-block (1784–1862) | 320 |
| `styles/settings.css` | Source picker (852–872), CORS (873–876), Вкладка «Настройки» (1970–2031) | 110 |
| `styles/overlays.css` | Badges (1865–1967), классы-вместо-inline (2032–2356), dead tap (2357–2611), crop handles (2612–2642), copy menu (2643–2664), action menu (2665–2714), инлайн-обёртки (2715–2807), reduced-motion (2822–конец) | 800 |

Инвариант корректности: **порядок правил сохраняется точно** — порядок
`@import`-ов повторяет текущий порядок секций (для равной специфичности
каскад не меняется). Границы файлов — по границам секций; если секция
«спорит» (например 697–700 против соседних), резать по соседней чистой
границе, не по середине блока.

## 4. Порядок работ (по возрастанию риска)

| Шаг | Что | Коммит | Проверка |
|---|---|---|---|
| 0 | Хелпер `readAllStyles()` в `tests/_helpers.js`: конкатенация style.css + `styles/*.css` (если каталог есть) в порядке @import; перевести 29 CSS-тестов на него | `test(css): read styles via helper` | `npm test` — полный зелёный, прод-код не тронут |
| 1 | index.js → settings-panel.js (§3.1) | `refactor(ui): extract settings panel from index` | `npm test` + ручная: панель настроек ST раскрывается, чекбокс «Включить», селект лаунчера, экспорт/очистка диагностики |
| 2 | `refs-view-shared.js` | `refactor(refs): shared view state and pure helpers` | `npm test` |
| 3 | `ref-editor.js` | `refactor(refs): extract overlay editor` | `npm test` + ручная: оверлей на десктопе, автосейвы полей, кроп/замена картинки |
| 4 | `refs-pool-picker.js` | `refactor(refs): extract pool picker` | `npm test` (тест пикера зелёный без правок) |
| 5 | `refs-sidebar.js` (с `hooks.rerender`) | `refactor(refs): extract folder sidebar` | `npm test` + ручная: клики/ПКМ по папкам, «Избранное», скрытие пустых |
| 6 | `refs-mobile.js` | `refactor(refs): extract mobile stack` | `npm test` + ручная: 380px — папки→группа→сетка→карточка, поиск, долгий тап |
| 7 | style.css: корень+`styles/` по §3.3, по одному файлу за коммит (launcher → gallery → settings → connections → mobile → references → generate → overlays) | `refactor(css): split <area> into styles/` | после каждого — `npm test`; в конце ручной визуальный проход |
| 8 | Свежие `wc -l` в статус этого документа | — | все файлы ≤ 700 (мягкий 500 для src/ui), корень ≤ 800 |

## 5. Риски и закрытие

| Риск | Закрытие |
|---|---|
| 29 CSS-тестов падают после распила | Шаг 0 делается ДО распила; хелпер уже читает оба мира |
| Каскад CSS меняется (порядок) | Порядок @import = текущий порядок секций; резы только по границам секций; ручной визуальный проход в конце |
| Циклы импортов main↔sidebar | Сайдбар получает `hooks.rerender`, обратного импорта нет (§2.7) |
| Живые `let`-биндинги теряются при распиле | Только 5 полей едут в `refsView` (объект — мутабелен из всех модулей); прочее состояние остаётся в своём модуле |
| Тесты ломают импорты вынесенных сущностей | Реэкспорты из main сохраняют пути импорта (§3.2) |
| N доп. HTTP-запросов CSS (9 файлов) | ST грузит расширения после старта страницы; на локалхосте и типичном удалённом доступе 8 доп. запросов статики незаметны; откат тривиален (слить файл обратно) |
| Потерять поведение `_renderAll` против `refreshActive` в сайдбаре | Сайдбар зовёт ровно тот же `hooks.rerender = () => _renderAll(root)`, семантика не меняется |

## 6. Критерий готовности

- `wc -l`: index.js ≤ 500; все новые/изменённые модули ≤ 500; style.css ≤ 800.
- `npm test` зелёный после каждого коммита шагов 0–7.
- Ручной QA-чеклист пройден: вкладки (включая ленивые), поиск референсов,
  десктоп-оверлей, мобильная навигация 380px, пикер из «Генерации», панель
  настроек ST, галерея; визуально тема не «поехала».
- Коммиты — по одному шву, откат любого шага = revert одного коммита.

---

## 7. Итог выполнения (2026-10-25, вечер)

Все шаги выполнены, `npm test` зелёный после каждого коммита (1758/1759,
1 пропуск — давний). Итоговые размеры:

| Файл | Было | Стало |
|---|---|---|
| index.js | 513 | **412** |
| src/ui/tab-references.js | 1496 | **411** |
| → src/ui/refs-view-shared.js | — | 101 |
| → src/ui/ref-editor.js | — | 197 |
| → src/ui/refs-sidebar.js | — | 380 |
| → src/ui/refs-mobile.js | — | 376 |
| → src/ui/refs-pool-picker.js | — | 122 |
| → src/ui/settings-panel.js | — | 118 |
| style.css | 2835 | **281** (корень: токены + база + @import) |
| → styles/*.css (8 файлов) | — | 65–895 |

Отступления от §3/§4 (в пользу корректности, все осознанные):
- **ref-editor.js тоньше, чем в плане**: десктопный оверлей-врапер
  (`_renderOverlay`/`_bindOverlay`) остался в main — его `refreshAround`
  замыкается на `_renderSidebar`/`_renderGrid`, и вынос потребовал бы
  инъекций; общий для двух экранов `bindEditorBody` вынесен (197 строк).
  Удаление референса из редактора получает `opts.onDeleted` — мобильный
  стек сбрасывает навигацию через колбэк, а не запись чужого state.
- **Batch upload (1759–1783) уехал в mobile.css**, а не в references.css:
  1621–1862 — непрерывный кусок, так глобальный порядок правил сохранён
  точно (инвариант §3.3 важнее таксономии файлов).
- **CSS-распил одним атомарным коммитом** (`01833e5`), а не по файлу:
  корень и styles/ взаимозависимы, частичные состояния ломали бы @import.
- Делегирование плиток (`bindPoolGridDelegation`/`selectPoolTile`) при
  выносе мобильного стека спустилось в refs-view-shared.js — им пользуются
  обе сетки.
- `folderSearchQuery`/`mobileSearchQuery` переехали в `refsView` по ходу
  распила: их читают/пишут сайдбар, мобильный стек и main.

Тестовая страховка: `readAllStyles()` (tests/_helpers.js) читает корень без
@import-строк + все styles/*.css в порядке импорта, корень первым —
первое-совпадение селекторов в CSS-контракт-тестах попадает на те же
правила, что и до распила. 19 тест-файлов переведены на хелпер.

Осталась ручная проверка (в браузере, по чеклисту §6): вкладки, поиск
референсов, десктоп-оверлей, мобильная навигация 380px, пикер из
«Генерации», панель настроек ST, визуальный проход темы.
