# ComfyUI в UR Image Studio: синтез исследования и самопроверка

> От 2026-09-30. Рабочий документ к фиче «ComfyUI как провайдер Stage 2». Полные материалы: [отчёт по GitHub-проектам](2026-09-30-github-comfyui-integrations.md) и [справка по API ComfyUI](2026-09-30-comfyui-api-reference.md). Самопроверка на неоговорённые нюансы — в конце.

## Состояние на момент исследования

В URIS 6 контрактов провайдеров (`openai-images`, `gemini-native`, `chat-completions`, `openrouter-images`, `pollinations-images`, `naistera`). Цепочка: подключение (schema v2) → `dispatch-plan.js` → `image-provider-registry.js` → адаптер `src/providers/*` (чистая функция `input → {dataUrl|url}`) → `image-transport.js` (CORS-лестница) → `image-api.js` (материализация в галерею).

База для ComfyUI сильная: асинхронный поллинг уже реализован в адаптере Naistera (`POST → job_id → поллинг GET с дедлайном timeoutMs и AbortSignal`), транспорт универсален, ST-прокси стримит бинарные GET-ответы (значит, и `/history/{id}`, и `/view` проходят через `/proxy/`). Чего нет: ключевого исключения (apiKey обязателен везде с двумя хардкод-исключениями), WS-слоя (не нужен для v1), `comfyui` в `API_SHAPES`/`DIALECT_ORDER`/пробнике, таблицы аспект → WxH, клиентской генерации seed.

## Подходы

**A — контракт `comfyui` со встроенным workflow (этап 1, рекомендация).** Встроенный дефолтный txt2img-workflow (API-формат, константа: CheckpointLoaderSimple → CLIPTextEncode ×2 → KSampler → EmptyLatentImage → VAEDecode → SaveImage), `POST /prompt` → поллинг `/history/{prompt_id}` → `GET /view` → обычный `{kind:'dataUrl'}`. «Модель» = имя чекпойнта (пробник: `/system_stats` + `/models/checkpoints`). Seed клиентский, abort → `POST /interrupt`, референсы в v1 — unsupported. Ложится на существующие паттерны на 100%, покрывается юнит-тестами как Naistera.

**B — пользовательские workflow-шаблоны (этап 2, поверх A).** API-формат JSON на подключении + кавычкованные плейсхолдеры (`%prompt%`, `%negative_prompt%`, `%seed%`, `%width%/%height%`, `%steps%`, `%cfg%`, `%sampler%`) + пользовательские find/replace (паттерн ядра ST). Валидация до отправки: остатки плейсхолдеров, наличие `SaveImage`, наличие `class_type` через точечные `/object_info/{class}`. Референсы — `POST /upload/image` (multipart, direct-only) + инъекция в `LoadImage`.

**C — WebSocket-first клиент (не рекомендуется как база).** В URIS нет ни одного WS-использования, ST-прокси WS не умеет, известная проблема потери событий при длинной истории (StableCanvas#22). Ядро ST живёт на поллинге. Опциональное украшение этапа 2 в будущем.

Серверный плагин-прокси (путь ядра ST) сознательно отклонён: проект уже хоронил серверный вариант — прямой путь с прокси-фолбэком его закрывает.

## Точки интеграции этапа A

| Файл | Правка |
|---|---|
| `src/image-connection-schema.js` | `CONTRACTS.COMFYUI = 'comfyui'`; `API_SHAPE_VALUES`/`AUTH_STRATEGIES` — `comfyui`/`none` |
| `src/provider-descriptors.js` | дескриптор: `auth.required: false`, `async: true`, polling, таблица аспектов |
| `src/providers/image-comfyui.js` | новый адаптер: workflow-константа + inject + poll + view + interrupt |
| `src/providers/image-base.js` | `requireInvocation`: ключ не нужен для comfyui (лучше — по `descriptor.auth.required`) |
| `src/image-api.js` | то же для проверки ключа перед диспетчем |
| `src/image-provider-registry.js` | запись в `adapters` |
| `src/dispatch-plan.js` | `API_SHAPES.COMFYUI`, `DIALECT_ORDER`, `inferApiShape` узнаёт `:8188` |
| `src/connect-probe.js` | ветка comfyui: `/system_stats` + `/models/checkpoints` (+ сохранение query-строки URL) |
| `src/ui/server-connection-form.js` | подпись контракта, «Ключ не требуется», подсказка про `--enable-cors-header "*"` |
| `tests/image-comfyui.test.js` | инъекция параметров, парсинг history/node_errors, дедлайн поллинга, сборка `/view` |

---

## Самопроверка (2026-09-30): 10 нюансов, не оговорённых в основном отчёте

Проверено по коду; гипотезы, не проверяемые кодом, помечены.

### 1. Топология «браузер ↔ ST-сервер ↔ ComfyUI» нигде не проговорена

ST-прокси выходит в сеть с машины ST-сервера: если ComfyUI крутится на машине браузера, а ST — на другой машине или в Docker, фолбэк через `/proxy/` стучится в `localhost:8188` **сервера ST** и получает ECONNREFUSED. Обратная топология (ComfyUI на машине ST, браузер remote) наоборот ломает прямой путь. Значит «прямая дорога мертва» ≠ «прокси её спасёт»: в текстах ошибок и в «Проверить» надо различать эти случаи, а подсказка с флагом зависит от топологии. Бонус-грабля: проброс `--enable-cors-header "*"` в Docker — боль с кавычками (ComfyUI-Docker#190).

### 2. Private Network Access — отдельный от CORS барьер *(гипотеза, проверить на целевых браузерах)*

Chrome (PNA): запрос со «менее приватного» origin (публичный сайт или LAN-IP) на `127.0.0.1` требует `Access-Control-Allow-Private-Network: true` в ответе на preflight — ComfyUI его не шлёт. Страница ST, открытая на `http://192.168.x.x:8000`, может не достучаться до локального ComfyUI даже с `--enable-cors-header "*"`. Mitigation: открывать ST на localhost; Firefox PNA не имплементирует. В основном отчёте был упомянут только mixed content — это другой механизм.

### 3. `prompt_id` и незащищённый контекст

Свежие серверы ComfyUI валидируют `prompt_id` как канонический lowercase-UUID (400 `invalid_prompt_id`). `crypto.randomUUID()` существует только в secure context (https или localhost), а весь текущий код URIS либо зовёт его **без фолбэка** (`src/pipeline-stage1.js:75`, `src/pipeline-stage2.js:135`), либо падает на base36-формат (`src/image-transport.js:87`, `src/bridge.js:375`), который ComfyUI отвергнет. Нужен собственный UUIDv4-генератор на Math.random в адаптере.

### 4. Белый список заголовков ComfyUI

CORS-мидлварь ComfyUI отвечает `Allow-Headers: Content-Type, Authorization` — любой кастомный заголовок сломает preflight и даст фантомный «blocked by CORS». Конкретный сценарий: tunnel-bypass-заголовки (`bypass-tunnel-reminder`, `ngrok-skip-browser-warning`, `src/tunnel-bypass.js:34-37`) включатся, если ComfyUI выставлен наружу через ngrok/localtunnel (реальный способ показать удалённый ComfyUI), и убьют прямую дорогу. Адаптер обязан слать только пару `Content-Type`/`Authorization`. Удачное совпадение: префлайт-оракул URIS (`probePreflightDelivery`) проверяет именно `authorization, content-type`.

### 5. Семантика «оплаты» и отмены не перенесена

Вся машина ambiguous-доставки (`IMAGE_DELIVERY_AMBIGUOUS`, «возможно, запрос уже обработан и будет оплачен», no-resubmit) написана про платные API. Для бесплатного локального ComfyUI тексты врут про «оплату», а риск повторного POST — не двойное списание, а **двойная постановка в очередь** (и занятый VRAM). Отмена = abort + `POST /interrupt`: прицельный `{prompt_id}` на свежих серверах, но на старых тело игнорируется → **глобальный** interrupt, можно сорвать чужую задачу (предупредить в тексте). Плюс гигиена: `POST /history {"delete":[prompt_id]}` после забора картинки — история ComfyUI копится в памяти сервера.

### 6. Дедлайн включает чужую очередь

Очередь ComfyUI общая для всех клиентов: задача URIS может ждать чужой job (из ComfyUI-морды или другого клиента), и всё это время тикает `connection.timeoutMs` (паттерн Naistera: дедлайн с момента POST). Нужен различимый статус «в очереди vs выполняется» (`GET /prompt` → `queue_remaining`, `GET /queue`) и решение: продлевать дедлайн, пока задача ждёт, или честный таймаут с понятным текстом. Отдельно: `/history/{id}` отдаёт `{}` и для «ещё ждёт», и для «исчез из истории» — статус надо сверять с `/queue`, иначе ложный таймаут.

### 7. Negative prompt в модели данных URIS отсутствует

`src/gallery-index.js:42` уже имеет поле `negativePrompt` у карточки галереи, но пайплайн его никогда не заполняет: Stage 1 негатив не пишет, в request его нет. Дефолтному workflow негатив нужен: либо фиксированный дефолт-строка, либо поле на подключении (которое на этапе 2 превратится в `%negative_prompt%`).

### 8. Маппинг существующих per-chat параметров

Request несёт `quality: 'auto'|'low'|'medium'|'high'` и `imageSize: '1K'/'2K'` (`src/image-api.js:56-57`) — в мире ComfyUI их нет. Решение: скрывать/гасить контролы для comfy-контракта или переводить (1K → база 1024, 2K → 1536+) с существующим паттерном Pollinations (`omittedFields` + warnings), иначе UI молча показывает бессмысленные селекты. Стороны → прямой маппинг в WxH, кратные 64 (SDXL-бакеты), а не слоты `ASPECT_SIZES`.

### 9. Три роли поля «Ключ»

В отчёте — только «ключ не нужен». На деле: (а) пустой — локальный ComfyUI без auth; (б) Basic-auth credentials, если ComfyUI за reverse-proxy — заголовок `Authorization` разрешён CORS-мидлварью, но базовый URL надо хранить вместе с query (`?token=`) и не стрипать её, как делают сборщики URL в `src/catalog.js` (урок SillyTavern#4146); (в) `api_key_comfy_org` для платных API-нод в кастомных шаблонах этапа 2 (передавать в `extra_data`; сервер сам вырезает секрет из `/queue` и `/api/jobs`). «Проверить» не должен требовать ключ ни в одной роли.

### 10. Schema-хвосты и хранилище шаблонов

Механика: `REMOTE_METADATA_FIELDS` в `src/image-connection-schema.js:100-105` — белый список метаданных по контракту; без записи для `comfyui` любой `remoteMetadata` уронит нормализацию с TypeError. Капы `MAX_DETECTED_MODEL_IDS`/`MAX_DETECTED_MODEL_METADATA = 500` (там же, строки 247-249) молча обрежут библиотеку чекпойнтов больше 500 файлов. Архитектура: **подключения живут в settings.json** (`src/connection-store.js` → `ctx.extensionSettings`), а ST переписывает settings.json целиком при каждом изменении — поэтому workflow-шаблоны этапа 2 хранить в серверном файл-сторе (machinery `template-file-store.js`), а не в записи подключения.

---

## Ревизия (2026-09-30, вечер): режим пет-проекта

Решение владельца: без оверинжиниринга, только «генерить картинки через ComfyUI». Подходы A и B сливаются в одну маленькую фичу, этапность и «правильные» механизмы режутся.

**Что подтвердил код и что это даёт:**

- Выбор контракта в форме пишет `overrides.dialect` (`server-connection-form.js:257-258`), а `resolveDispatchPlan` уважает этот пин раньше всего остального (`dispatch-plan.js:208-217`). Значит **dispatch-plan править не нужно вообще** — новый контракт в `CONTRACTS` + строка в списке `DIALECT_OPTIONS` формы, и явный выбор «comfyui» доезжает до реестра как есть.
- В форме уже есть «— ввести ID вручную —» (`server-connection-form.js:166`) — модель (имя чекпойнта) вводится руками, **ветка пробника для comfy не нужна**.
- `extraBody` записи подключения проходит нормализацию как есть (`image-connection-schema.js:393-397`) — workflow-JSON храним в `connection.extraBody.workflow`, никакого файл-стора. ~3 КБ в settings.json — осознанный компромисс пет-проекта (нюанс №10 принят, не решается).
- Опрос маршрута наследует `route.transport.initialDelivery` — поллинг `/history` идёт той же дорогой, что и POST; `/view` через `downloadResult`/`autoFetch` сам учит ход direct→proxy. Транспорт не трогаем. Не хочется CORS-флаг — пользователь ставит «Через прокси ST» на карточке, и всё работает через `/proxy/` (он умеет JSON POST/GET и стримит бинарные GET).

**Минимальный план (~270 строк):**

1. `image-connection-schema.js` — `COMFYUI: 'comfyui'` (1 строка).
2. `server-connection-form.js` — строка в `DIALECT_OPTIONS`, textarea «Workflow (API-формат)» → `extraBody.workflow` (видна для comfy), плейсхолдер ключа «не требуется», хинт про `--enable-cors-header "*"` / «Через прокси ST».
3. `src/providers/image-comfyui.js` — адаптер (~150-170 строк): дефолтный txt2img-workflow константой (API-формат) как начальное значение; подстановка плейсхолдеров `%model%` (← route.modelId), `%prompt%` (кавычкованный, JSON.stringify), `%seed%` (свой UUIDv4-based random), `%width%`/`%height%` (маппинг аспект→WxH кратными 64, только если плейсхолдеры есть); POST /prompt → поллинг /history по образцу Naistera (дедлайн timeoutMs) → /view через downloadResult; abort → fire-and-forget `POST /interrupt`; референсы → REFERENCES_UNSUPPORTED; ошибки: 400 → error.message/node_errors, history-ошибка → node_type + exception_message, CORS-сбой → хинт с флагом.
4. `image-base.js` + `image-api.js` — пустой ключ допустим для comfyui (по 2-3 строки, по образцу pollinations/naistera).
5. `image-provider-registry.js` — import + запись (2 строки).
6. `provider-descriptors.js` — опционально 8 строк ради `defaultEndpoint: 'http://127.0.0.1:8188'`.
7. `tests/image-comfyui.test.js` — чистые функции: инъекция плейсхолдеров, парсинг history-ошибки, сборка /view.

**Из 10 нюансов самопроверки снимаются:** №1 (топология — решает выбор доставки на карточке), №2 (PNA — только если ST не на localhost; хинт), №6 (очередь — дедлайн как есть), №7 (негатив живёт в workflow), №8 (quality/imageSize comfy игнорирует), №9 (ключ просто необязателен), №10 (workflow в extraBody — компромисс принят). Остаются три копеечных: №3 (UUIDv4-хелпер в адаптере; латентный баг `pipeline-stage1.js:75`/`pipeline-stage2.js:135` — отдельная задача вне фичи), №4 (адаптер шлёт только Content-Type), №5 (interrupt + не пугающие тексты — принимаем существующие).

**Честные ограничения v1:** из коробки — txt2img на SD-чекпойнтах; Flux/кастомные графы — вставкой своего workflow (это и есть механизм); референсов нет; «Проверить» для comfy не работает (модель вручную); селекты «Качество»/«Размер» игнорируются; если в workflow нет `%seed%` — картинка будет повторяться.
