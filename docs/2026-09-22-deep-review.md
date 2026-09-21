# Deep review URIS — 2026-09-22

Комплексное исследование v0.9.0 против SillyTavern 1.19.0 (six-track: ST API conformance, storage, pipeline/providers, UI, inline/bridge/diagnostics, server-line). Все утверждения с file:line. Резюме для владельца — в конце файла.

---

## 0. Общий вердикт

Кодовая база — **не хаотичный вайбкод**: слои видят борьбу с реальными инцидентами, комментарии честно документируют «почему так», инварианты протестированы. Но подозрение на переусложнённость подтверждается **локально, а не системно**: ядро (транспорт, file-store, autolane, grammar, inline render, провайдерные адаптеры) — правильного размера; переусложнение сидит **вокруг ядра** — в мёртвой серверной линии, дублях одной логики в 2-3 экземплярах, легаси-режимах и ручной проводке магазинов.

Числа (src ≈ 26 800 строк без vendor, тесты ≈ 34 400):
- Мёртвый код в src: **~1 100 строк** (остров 832 + discoverCatalog ~250).
- Мёртвые тесты: **~9 000 строк (26% сюита)** — тестируют несуществующий `server-plugin/`.
- Реалистичное упрощение без потери функций: **−2 600…3 300 строк src (10-12%)** сверх острова, плюс −9 000 тестов.
- Опционально фичи на вынос: bridge.buildPrompt (~135), studio-scope (~250 с каскадом), ручной inline-путь (~150), vendor Croppr (1 182).

---

## 1. Критичные находки (чинить вне зависимости от рефакторинга)

### 1.1. Документация врёт о приватности сетевого дампа
- README:98 — «network dump records the last 200 extension requests (metadata, not bodies)»; USER_GUIDE:59/64 — «200 запросов», «промптов там нет».
- Код: `MAX_NET_ENTRIES = 500` (netdump.js:53); тела пишутся — `KEEP_LONG_STRING_KEYS = ['text','content','prompt','message',…]` до 8 КБ на поле (netdump.js:164-170), request body капится head+tail на 32 КБ **специально чтобы сохранить промпт** (netdump.js:61-63, 272-276), JSON-ответ целиком до 64 КБ (:55).
- Правда только в подсказке панели (tab-settings.js:176) и про event-log (diagnostic-events.js:57-59 — реально metadata-only), и ключи API вычищаются (netdump.js:159, 361-364).
- **Действие:** поправить README/USER_GUIDE, либо сделать запись тел opt-in (тогда код начнёт соответствовать докам). Сейчас дамп, приложенный к багрепорту, может унести NSFW-промпты.

### 1.2. Двойной биллинг в autoFetch (proxy.js)
- `autoFetch` (proxy.js:209-262): direct → на CORS/сетевой TypeError повтор через прокси. Но **«сервер обработал и ответил 200 без CORS-заголовков» браузер маскирует тем же TypeError** → второй платный POST. Сценарий не теоретический: `tunnel-bypass.js:12-15` сам описывает ngrok ERR_NGROK_6024 как «phantom blocked by CORS».
- Реверс-фолбэк proxy→direct (proxy.js:223-233) добавляет ещё одну ветку ради сомнительной симметрии.
- **Действие:** для генерирующих POST при «CORS-маскированном 200» не ретраить автоматически (отдавать диагностику «исход неизвестен» — семантика уже есть в image-transport: `IMAGE_DELIVERY_AMBIGUOUS`); реверс-фолбэк убрать.

### 1.3. Серверный плагин (4 489 строк) вне git, с историей оплат
- `D:\SillyTavern QA\data\default-user\plugins\ur-image-studio` — единственная копия исходников; внутри `requests.json` (29 реальных запросов), `artifacts/` (19 картинок, 2026-07-28…31) — генерация через сервер реально ходила и оплачивалась.
- Ни deploy-, ни dev-дерево, ни git-история его не содержат; `tests/server-*.test.js` (22 файла, 7 727 строк) импортируют несуществующий `server-plugin/` и не могут выполняться (поэтому exclusion в package.json).
- Задеплоенный роутер не имеет ни одного `/v1/store` роута → половина острова (`server-store-api`, `store-state`, `store-migration`) целится в версию плагина, которой нет даже на стенде.
- **Действие (минимум):** скопировать плагин в `<repo>/server-plugin/` (без artifacts/*.json/journal.key), закоммитить. Иначе 29-записная история — единственный «бэкап».

### 1.4. Мелкие, но реальные баги
- **data-port:** `summarizeBackup` (data-port.js:800-816) считает refs/folders/templates из **legacy** localforage-ключей → диалог импорта показывает «Референсы: 0» для бэкапа, несущего N референсов в `shared` (data-port.js:426-437).
- **refreshActive съедает ввод:** `uris:post-follow`/`chat-generation-defaults-changed` → полный re-render «Генерации» (index.js:218-227); если пользователь печатает (<400 мс debounce-автосейва), textarea пересобирается со старым draft — правка и фокус теряются. Фикс: не рендерить при фокусе в `#urisPrompt` или синхронно сливать значение в draft перед рендером.
- **Черновики растут вечно:** ключи `uris_generation_draft:<chatId>:<msgId>` (generation-drafts.js:98-106) не удаляются никогда — каждый пост каждого чата оставляет запись со снапшотами навсегда. Нужен LRU/чистка при закрытии чата.
- **Тихий глотатель ошибок рендера:** `tabs.js:69` — `catch(() => {})`; упавший async-render оставляет пустую вкладку без записи в error-pool.
- **chat-binding:** миграция хранит легаси-запись под `legacy` (chat-binding.js:156-181), которую следующая нормализация снова выкидывает (88-114) — полумёртвая ветка.
- **evidence влияет на диспетч:** `dispatch-plan.js:213` берёт `evidence.dialect` для следующей генерации; misclassification отказа (regex по английским текстам чужих шлюзов, capability-observer.js:178-194, 285-301) способен закрепить неудачный диалект. Оговорка «diagnostic-only» (capability-observer.js:5-19) уже неточна.

---

## 2. Мёртвый код (удаляется без потерь)

| Что | Строк | Доказательство |
|---|---|---|
| Остров целиком: server-image-api 123, server-store-api 194, server-connection-state 46, store-state 71, store-migration 78, image-recovery 249, reference-check 71 | 832 | Ни один не достижим из index.js; `server-connection-state.js` не импортирует никто вообще; smoke.test.js:27-43 **пинит** недостижимость регэкспами |
| 22 тест-файла, импортирующие несуществующий `server-plugin/` | 7 727 | ERR_MODULE_NOT_FOUND; exclusion в package.json |
| `discoverCatalog` + route-помощники в catalog.js (711-783 и др.) | ~250 | Прод-путь ушёл на connect-probe + dispatch-plan |
| Дубли recovery-стора в image-recovery.js:77-100 (вторая копия `savePendingBrowserRequest`/`updatePendingBrowserRequest` поверх того же LF-ключа `uris_pending_images`) | ~30 | Живой аналог — browser-image-recovery.js (importers: image-api.js:13, diagnostic-dump.js:6, window.js:8) |
| `flushAllFileStoresOnUnload`/`flushAllFileStores` (file-store.js:938-946) — написаны, но index.js вручную перечисляет магазины трижды (121-126, 263-278, 482-486) | — | Либо использовать, либо удалить |
| fake-dom ветка в render.js:357-370 + тестовые seam'ы (33-44) в проде | ~30 | Перенести в tests/fake-dom.js |
| CSS-мусор: ~3-5% селекторов (напр. `.uris-ref-editor`, style.css:737-740 — класс не встречается в JS) | ~100 | Прогнать unused-селектор-чек |

Уточнение классификации: `reference-check.js` — не «серверная линия» (README misclassify), а **клиентская** недоделанная фича (платная 1×1 контрольная генерация; импортирует image-api/dispatch-plan, reference-check.js:9-12). Либо подключить кнопку в карточку подключения (~50 строк UI), либо удалить.

---

## 3. Переусложнения по подсистемам

### 3.1. Storage (file-store и вокруг)
7 активных механизмов хранения + фабрика напрашивается:
- **Бойлерплейт магазинов:** на каждый из 5 — по 15+ однострочных экспортов ensure/flush/replace/export; семь почти идентичных хелперов «достать вложенность настроек» (gallery-index.js:56-67, refs-library.js:33-44, param-presets.js:21-32, template-file-store.js:35-49, prompt-templates.js:17-31, connection-store.js:14-29). Фабрика `defineStore({file, key, empty, legacy})` → **−300…400 строк**.
- **Write amplification:** `deleteFolder`/`mergeFolders` (refs-library.js:441-485) делают `store.update` **в цикле по референсам**; для mergeWithServer-магазина каждая запись = ре-чтение файла + полная перезапись → папка из 50 референсов = до 100 сетевых обращений. Галерея: до 3 полных перезаписей индекса на одну картинку (addCard → updateCard(thumb) → updateGalleryEntry(dims); file-store.js:648-651, 791).
- **Read-путь с записью:** открытие вкладки «Галерея» = `reconcile:true` (gallery-index.js:279-283) → POST /api/images/list по каждой папке + возможная перезапись файла. Рендер вкладки = скан ФС сервера. Фикс: reconcile по кнопке.
- **Стартап:** `refreshPoolCache()` (index.js:114) стоит **до** `Promise.all(ensure*)` (121-126) и внутри ждёт refsStore.ready → сериализует старт; плюс каждый магазин сам POST /api/files/verify (file-store.js:522) — 4-5 одинаковых проб. Фикс: memoized probe-promise + перенос refreshPoolCache в общий Promise.all.
- **Целостность:** версионирования нет — last-writer-wins для gallery/presets/templates/studio; задокументированный инцидент потери (file-store.js:44-55). Three-way merge написан и работает, но включён только у refs. Решение: mergeWithServer всем (конфиг-строка) либо честный single-writer и снос merge.
- **data-port (952):** двойное представление (legacy localforage + shared), ~200 строк миграторов v6→v8, rollback-снапшот вселенной. Формат v9 = только shared → **−300…400 строк** и чинит баг п.1.4.
- **Legacy-режим file-store** (~200 строк: legacyRead/Write/Strip, enterLegacyMode, re-probe с троттлингом) — вопрос «какой минимальный ST поддерживаем»; если 1.19+ — сносится.

### 3.2. Pipeline / провайдеры
Поток одной генерации — ~11 модулей (tab-generate → pipeline-queue → pipeline-stage2 → image-api → registry → adapter → image-transport → core.fetchWithTimeout → proxy → image-base.readJsonResponse → materialize). Чистые форвардеры: pipeline.js (18, осознанно), providers/base.js (15, пустой typedef — удалить), connections.js (фасад над connection-store).
- **Восемь механизмов сериализации** для однопользовательского расширения: queue+processQueue, stage2Chains, autoFlights, autolane, withDraftLock, evidence-chain, recovery writeChain, apiKeyState.chain. autolane (21 строка) — образец; остальные — кандидаты на одну утилиту `serialize(key, fn)`. **−100 строк и минус класс «а что если гонка»**.
- **Stage 2 — три пути входа** (instruction-легаси / submission-снапшот / live-draft) + повторное чтение draft с revision-проверкой + immutableSubmission + lastSubmittedSnapshot + requestId-гвард (pipeline-stage2.js:169-209, 270-282, 297, 359, 423). Для одного пользователя с per-post сериализацией — ~200 строк лишней защиты. Один snapshot-at-start (как submission) → **−180 строк**.
- **Тройная валидация reference-policy:** реестр (image-provider-registry.js:31-32) + каждый адаптер руками (image-openai.js:256-262, image-openrouter.js:23-25). Один слой.
- **Дубли:** декомпрессия gzip/zstd/deflate дважды почти дословно (image-base.js:37-128 vs catalog.js:630-708) — ~150 строк; таблицы ASPECT_SIZES (image-openai.js:19-27 = image-pollinations.js:5-9); quality-списки в трёх файлах со «связующим контракт-тестом» (image-openai.js:35, provider-descriptors.js:18, dispatch-plan.js:159-165); нормализация полей референсов в трёх местах (model-catalog.js:73-75, catalog.js:216-219, catalog.js:93-100).
- **Четыре каталога + классификаторы:** catalog.js 783 + model-catalog.js 154 + connect-probe.js 320 + provider-descriptors.js 50 + image-model-capabilities.js 83 + classifyModelCapability в dispatch-plan.js:312-435. Сжать до одного probe-модуля: **~1 300 → ~300 строк**.
- **Regex по model id — 8 таблиц в 5 файлах** (dispatch-plan.js:34,60,312-313; image-model-capabilities.js:28; image-openai.js:53,108; catalog.js:8). Каждая куплена инцидентом, но «что мы знаем о модели» надо собрать в один модуль-константы.
- **Текстовые провайдеры:** openai.js:42-50 = gemini.js:53-59; детект таймаута **строкой** `/Timeout \(/`; ретрай по regex `/429|502|503|504|network|…/i` (core.js:626-629) — любое «429» в любом месте сообщения триггерит. У изображений ретрая нет — правильно.
- **Оставить как есть:** семантику «один платный POST» в image-transport (noResubmit, MULTIPART_CORS_REQUIRED vs IMAGE_DELIVERY_AMBIGUOUS), readJsonResponse (батл-тестирован на zstd/brotli), идею dispatch-plan (диалект = производный факт, не настройка), stale-проверки messageHash в очереди, timeout до конца чтения тела (core.js:751-759), aspect-ratio.js, scene-context.js.

### 3.3. UI
- **Модель рендера здоровая:** innerHTML на мутацию + точечные под-хосты для ввода (debounce 400 мс + keywords/preview/ambiguities точечно, tab-generate.js:756-809), каретка/скролл/фокус защищены осознанно (tab-references.js:125-127, tab-api.js:188-239). Ключевой vdom/morphdom **не нужен**.
- **5 самодельных epoch-гвардов** (tabs.js:37, tab-generate.js:590, tab-references.js:113, tab-templates.js:57, tab-gallery.js:29) + снапшоты скролла в трёх местах → один `renderScope(root, {tabId, paint})`: **−80…120 строк**, минус целый класс гонок.
- **tab-generate.js (1 654) = 4-5 модулей в одном:** view-model/markup ~650, биндинги ~480, панель референсов ~430 (1140-1354, 1422-1474), policy ~185, abort/queue ~120. Разрезать механически → ~1 000.
- **Desktop/mobile-дубль в tab-references.js:** `_renderMobileFolders/_renderMobileGrid/_renderMobileCard` (459-661, ~200 строк) повторяют сайдбар/грид/оверлей. Один CSS-grid-лейаут → **−150…200 строк**.
- **Три реализации drag:** floating-launcher (Pointer Events, эталон), window.js (ручные mouse+touch, touchmove passive — на таче страница скроллится под драгом; resize без touch), chip-drag (tab-generate.js:1305-1354). Один pointer-хелпер → **−80 строк** и чинит мобильный драг окна.
- **XSS-аудит:** 82 innerHTML-присваивания проверены; escapeHtml (core.js:545) используется 178 раз, все пользовательские/LLM-данные экранированы (tab-generate.js:228-256, 1218-1248; tab-references.js:151-218; inline/render.js вообще на createElement/textContent). Реальных уязвимостей **нет**; риск — процессный (дисциплина без теста мест вызова). Дешёвая страховка — grep-скрипт «`${` внутри innerHTML без escapeHtml на строке».
- **CSS здоров:** 40 дизайн-токенов в :root, 666 селекторов без массовых повторов, 24 `!important` (13 оправданы в мобильном блоке против inline-стилей drag), mobile консолидирован. Из 2 615 строк ~440 — вендорный CSS PhotoSwipe, ~180 — комментарии. «Половину удалить» не выйдет; максимум 100-200 строк утилит.
- **Вендоры:** PhotoSwipe — ядро UX, тонкая обвязка lightbox.js (200 строк) — **оставить**. fzstd (16 строк) — легитимный полифилл zstd. Croppr (1 182 строки, 42 КБ) обслуживает один диалог кропа — кандидат на замену собственным прямоугольником (~150-200 строк поверх общего drag-хелпера), но только если кроп не в центре сценариев.
- Мелочи: дубль диагностики index.js:437-461 ≡ tab-settings.js:307-338 (~60 строк) → общий модуль; ключ текст-LLM по input-debounce без flush при уходе со вкладки (tab-api.js:96-102).

### 3.4. Inline / bridge / диагностика
- **grammar.js (57)** — честный regex с code-fence-исключением, ReDoS-безопасный по построению. Не трогать.
- **render.js (594)** — план-реконсиляция + textContent, образцово; лишнее: дубль orphan-логики (computeShellPlan:159-176 vs reconcileManualShells:456-463), fake-dom ветка в проде, тестовые seam'ы. Ручной путь (idx=-1, 📷-кнопка) — ~150 строк самого дорогого кода из расчёта строка/ценность: кандидат на вынос (фича «нарисовать по посту» уже есть через навигатор).
- **runner/store — тройная защита одной инварианты** («готовый оплаченный результат не откатывается»: store.js:78, runner.js:249, render.js:508-509) — сигнал, что статусы размазаны по слоям.
- **bridge.js (721), фасад ~130:** построчный дубль резолв-цепочки референсов с inline-раннером (runner.js:197-220 vs bridge.js:265-306; уже разъехались: инлайн передаёт signal, мост — нет) → общий `resolveReferences()` (**−120 строк**). `buildPrompt` + листальщики (~135) — вырезать, потребителей кроме скрытой лабы нет. Тогда мост ~450 строк; если потребителей нет вовсе — весь мост (−721) и таб.
- **События:** тройная подписка на GENERATION_ENDED/MESSAGE_SENT (events.js:104,116,135-137 + scanner.js:99-102) — порядок makeLast-обработчиков между модулями не специфицирован → один модуль-роутер (**−30 строк**, минус скрытая связность). Retry setTimeout(300) при пустом chatId (events.js:70-79) — рекурсивный тёмный фикс. CoT-теги хардкодом (post-navigator.js:32) — хрупкий список.
- **autolane (21)** — уже plain async mutex. Эталон, не трогать.
- **scene-context.js** — не «пакует чат», а матчер сущностей по алиасам (52-57, 353-357); sane. Дубль: buildSceneContextSnapshot (261-306) ≈ resolvePromptReferenceContext (318-344) на 80% → один билдер stage2Refs (**−40**).
- **Шаблоны:** только `{{char}}`/`{{user}}` через substituteParams — пропорционально.
- **Кандидат на удаление фичи:** studio-scope (103 + ~150 каскада в chat-binding/file-store) — виртуальный чат `__uris_studio__` ради генерации на welcome-экране. Классический over-engineering для pet-проекта.
- **Не трогать:** tunnel-bypass (59, легитимные заголовки loca.lt/ngrok), notify, st-upload-format, history, error-pool; диагностическое трио разделено по реальным разрезам (metadata vs тела vs сессия) — не сливать.

### 3.5. Server line — вердикт
«Полумиграция, осознанно запаркованная» — README честен. Остров 832 строки = 3,1% src; тесты острова ≈ 8 990 = 26% сюита. Offstage — внешний потребитель **клиентского** моста, к острову отношения не имеет. Задеплоенный плагин (4 489 строк) — параллельная серверная реимплементация генерации (~2 000+ строк концептуального дубля: три адаптера, probe, secrets — уже разъезжаются с клиентскими, ср. input_fidelity-гварды). Варианты: (а) линия закрыта → удалить остров + легаси-ветки isServerOwnedConnection (connections.js:16-24, connection-store.js:37) + решить судьбу плагина; (б) линия жива → вернуть плагин в git, снять exclusion, тесты впервые заработают. Рекомендация: вернуть плагин в git + почистить дубли, остров оставить спать под smoke-карантином.

---

## 4. Соответствие SillyTavern 1.19.0 (docs + исходники ST)

**Правильно:** manifest и хуки (activate — на каждую загрузку, enable — ручное, safeInit с cleanup-сбросом `_initialized` покрывает disable→enable без reload — extensions.js:314-322, index.js:501); extensionSettings + saveSettingsDebounced; большой gallery-индекс вынесен из settings (соответствует официальному «don't store large data in extensionSettings»); секреты в localforage (обоснованно: серверные secrets без allowKeysExposure необратимы — secrets.js:540-558); родные /api/images/upload|list по контракту (images.js:39-113, st-upload-format.js:65 ≈ utils.js:1661); события валидны для 1.19.0; Stage 1 через официальный ctx.ConnectionManagerRequestService (st-context.js:294); CSRF-заголовки везде; клиентские миниатюры не дубль (родной /thumbnail не обслуживает user/images — thumbnails.js:249-256).

**Хрупкое:** /api/files, /proxy/, /api/images — недокументированные внутренние роуты (смягчено пробами с деградацией); /proxy/ выключен по умолчанию (enableCorsProxy, server-main.js:258-262) и JSON-only (corsProxy.js:40 — multipart невозможен, что транспорт честно соблюдает); таймаут хуков 5 с (extensions.js:453-465) — медленный старт залогирует timeout (безвредно, шумно).

**Упущенные официальные API:**
- `/api/image-metadata` (image-metadata.js:622-660): серверные hash/aspectRatio/animated/dominantColor с mtime-кэшем — частично заменило бы браузерные createImageBitmap-пробы и поля gallery-индекса.
- `ctx.saveMetadataDebounced` (st-context.js:136) — chat-binding.js:44 зовёт недебаунснутый saveMetadata на каждое применение конфига.
- `saveBase64AsFile` (utils.js:1651) — базовый путь для uploadPayload (native-image-storage.js:78-100).
- `MESSAGE_*_RENDERED` события (ST events.js:48-49) — сократили бы нагрузку на MutationObserver в inline render.
- `renderExtensionTemplateAsync` (st-context.js:191) — опционально для UI-шаблонов.

---

## 5. Производительность (сводка)

1. **Стартап:** сериализованный refs-цепочка + 4-5 verify-POST (см. 3.1) — самые дешёвые минуты экономии.
2. **Сеть на мутациях:** refs deleteFolder/mergeFolders до 2N запросов; галерея 3 перезаписи на картинку; reconcile при каждом рендере галереи. Всё лечится батчингом + reconcile:false.
3. **Inline render:** полный проход `.mes` + regex на каждую мутацию чата (debounce 250 мс) — приемлемо; MESSAGE_*_RENDERED снизили бы частоту.
4. **store.js reconcileMessageSlots** — O(сообщений) на слот на удаление; на тысячных чатах квадратично, терпимо.
5. **IndexedDB:** бесконечный рост черновиков (п.1.4).
6. UI-рендер производительность не жрёт (данные локальные, списки сотни) — проблема там поддерживаемость, не скорость.

---

## 6. Топ-действия (сводный план)

**Немедленно (S):**
1. Починить README/USER_GUIDE о netdump (или opt-in тел).
2. Закрыть двойной биллинг в autoFetch; убрать реверс-фолбэк.
3. Удалить 22 мёртвых тест-файла (−7 727 строк) и исправить summarуBackup.
4. Коммит плагина в git (или осознанное решение похоронить серверную линию).
5. Лимит/чистка черновиков; catch → recordUrisError в tabs.js.

**Рефакторинг без потери функций (M, суммарно −3 500…4 000 src + −9 000 тестов):**
6. Удалить остров + discoverCatalog + дубли recovery (−1 100).
7. Фабрика `defineStore` + реальные flushAll* (−300…400) + батч-мутации refs/gallery + reconcile по кнопке + memoized probe + перенос refreshPoolCache.
8. data-port v9 (−300…400), Stage 2 один путь (−180), merge probe/каталогов (~1 300 → 300), serialize-утилита (−100), модуль констант аспектов/качества (−80).
9. UI: renderScope-хелпер, split tab-generate, kill desktop/mobile дубля, один drag-хелпер (−450…550 суммарно).

**Решения по фичам (обдумать):**
10. bridge.buildPrompt (−135), studio-scope (−250), ручной inline-путь (−150), Croppr (−1 182), legacy-режим file-store (−200), merge-подсистема vs single-writer.

**Что НЕ трогать:** image-transport («один платный POST»), readJsonResponse, dispatch-plan (идея), autolane, grammar, inline render (ядро), scene-context, file-store core, PhotoSwipe, fzstd, CSS-токены, escapeHtml-дисциплину, использование ST API.
