---
status: phase-1-done
created: 2026-10-13
implemented: |
  Фаза 1 (cloudflare-workers-ai) реализована 2026-10-13: дескриптор +
  src/providers/image-cloudflare.js + регистрация по чеклисту §4.2 +
  пробник (models/search) + 17 тестов (tests/cloudflare.test.js,
  endpoint-utils.test.js), полный прогон 1709/1709. Живой тест адаптера
  против настоящего API (node, транспорт=fetch): flux-1-schnell (JSON) и
  sdxl-lightning (бинарь, MIME sniffed) — обе генерации валидны.
sources: docs/providers/sd-webui-a1111-api.md, docs/providers/stability-platform-api.md, docs/providers/bfl-flux-api.md, docs/providers/cloudflare-workers-ai.md, docs/providers/huggingface-inference.md, docs/providers/fal-ai-api.md, docs/providers/replicate-api.md, docs/providers/seedream-byteplus.md + полный разбор кода URIS (ядро + UI/тесты)
---

# План: новые image-провайдеры для URIS (с нуля, по официальной документации)

Цель: добавить в URIS провайдеров из рекомендаций сравнения со st-chatu8, реализуя всё с нуля по официальным докам (код st-chatu8 не используется — он под AFPL, не open source). Документация уже скачана в `docs/providers/`.

## 0. Исходные данные

### 0.1 Что URIS уже умеет (переиспользуемые примитивы)

- **Контракт = дескриптор + адаптер + ~12 точек регистрации** (полный чеклист ниже в §4.2).
- **Поллинг джоб**: общий `pollUntil` (`src/async-utils.js:60-70`) + дескрипторные `jobPath`/`polling.intervalMs` (прецедент: naistera `src/providers/image-naistera.js:121-166`, ComfyUI `pollHistory`).
- **Бинарные ответы**: транспорт возвращает сырой `Response` со штампом доставки (`src/image-transport.js:142-286`); результат `{kind:'bytes', value, mimeType}` принимает `materializeImageResult` (`src/native-image-storage.js:182-185`); MIME-сниффер по магическим байтам есть (`src/core.js:979-997`).
- **multipart/form-data запросы**: `requestMultipart` (`src/image-transport.js:361-375`), но **только direct** — ST-прокси JSON-only (`src/proxy.js:51-65` бросает `MULTIPART_PROXY_UNSUPPORTED`).
- **Auto-heal доставки** (OPTIONS-проба, запоминание сломанного direct, прокси-фолбэк) — контракт-агностичен, новый JSON-контракт получает автоматически (`src/image-api.js:67-105`, `src/image-transport.js:222-274`).
- **Секреты**: localforage + `stripSecrets` — новый провайдер защищён автоматически.
- **Манифестные параметры**: геометрия/quality резолвятся из capabilities каталога (`src/wire-params.js:130-198`) — провайдер, публикующий манифест моделей, не требует правок UI параметров.
- **extraBody**: произвольный JSON с карточки подключения уже мерджится в тело (chat-completions) и читается naistera — дешёвый канал для экзотических параметров.

### 0.2 Чего не хватает (пробелы, закрываемые в Фазе 0)

1. **Basic auth** — нигде нет; нужен для A1111 `--api-auth`.
2. **samplerParams (steps/cfg/sampler/scheduler) и negative prompt в generation-request** — сейчас request содержит только `prompt/aspectRatio/imageSize/quality/references` (`src/pipeline-stage2.js:295-305`); negative prompt вообще никому не отправляется (поле есть только в карточке галереи).
3. **Seed в галерею** — контракт результата адаптера не имеет metadata-поля (`src/image-base.js:273-293`); A1111/BFL/fal отдают seed в ответе, было бы полезно сохранять.
4. Стриминг/SSE — **не нужен**: все целевые API либо однократные, либо поллинг.

### 0.3 Проверка «что можно тестировать вживую и бесплатно»

Локальный прогон на машине разработки (2026-10-13): A1111 :7860, ComfyUI :8188, SD.Next :7861 — не запущены; `nvidia-smi` отсутствует. Значит локальный SD-бэкенд «сразу» не проверить — только если у пользователя есть webui на другой машине/позже.

| Провайдер | Бесплатный живой тест | Источник |
|---|---|---|
| **Cloudflare Workers AI** | **ДА — 10 000 neurons/день**; flux-1-schnell ≈ 4.8 neurons/тайл 512px + 9.6/шаг → десятки генераций в день. Нужен только аккаунт CF + API token, без карты | docs/providers/cloudflare-workers-ai.md |
| **Stability Platform** | **ДА — 25 стартовых кредитов** (1 кредит = $0.01) при регистрации → несколько тестовых генераций sd3.5-medium/core | docs/providers/stability-platform-api.md |
| A1111/Forge/SD.Next | Бесплатно сам по себе, но нужен работающий webui (GPU) — на текущей машине недоступен | docs/providers/sd-webui-a1111-api.md |
| BFL FLUX | НЕТ free tier (только покупка кредитов) | docs/providers/bfl-flux-api.md |
| fal.ai | Unverified — стартовые кредиты на официальных страницах не подтверждены | docs/providers/fal-ai-api.md |
| Replicate | Unverified — скорее нет; flux-schnell $3/1000 изображений | docs/providers/replicate-api.md |
| HuggingFace Inference | **НЕТ** — в pricing-таблице free-аккаунту включённых кредитов нет (коррекция первичной оценки) | docs/providers/huggingface-inference.md |
| Seedream (BytePlus) | Платно (от $0.018/изображение), постоплата | docs/providers/seedream-byteplus.md |

**Вывод по тестированию**: первичный живой полигон — Cloudflare Workers AI (бесплатно, сразу, без карты), второй — Stability (25 кредитов). A1111 — как только появится стенд. Остальные — появление кредитов пользователя.

## 1. Порядок провайдеров и обоснование

1. **Cloudflare Workers AI** (`cloudflare-workers-ai`) — единственный подтверждённо бесплатный облачный; заодно закрывает сразу две новизны: JSON+base64 ответ (flux-1-schnell) и бинарный поток (SDXL base/lightning, плюс у них есть negative_prompt и img2img через `image_b64`).
2. **A1111/Forge/reForge/SD.Next** (`sd-webui`) — максимум ценности для аниме/локал-аудитории; один адаптер на 4 семейства (вики официально помечена устаревшей — истина в живом `/docs` инстанса; совместимость SD.Next/Draw Things помечена unverified в доке).
3. **Поллинг-семейство: BFL FLUX** (`bfl-flux`) → **fal.ai** (`fal-queue`) → **Replicate** (`replicate`) — один и тот же паттерн submit→poll→fetch; BFL первым (самый чистый контракт: `polling_url`, статусы, `x-key`).
4. **Stability Platform** (`stability-v2beta`) — multipart-only (direct CORS — проверить вживую!), 25 бесплатных кредитов хватит на верификацию.
5. **Seedream** — тонкий адаптер поверх OpenAI-совместимого `/api/v3/images/generations`; кандидат не на новый контракт, а на диалект/пресет существующего `openai-images` (решить в начале фазы).
6. **HuggingFace** — отложено: бесплатного теста нет, OpenAI-совместимый `/v1/images/generations` у роутера не поддержан (прямая цитата доков), ценность при наличии fal/Replicate низкая.

## 2. Фаза 0 — общие примитивы (блокер для A1111 и частично CF/Stability)

### 2.1 samplerParams + negative prompt в request

Дешёвый путь (`extraBody` на карточке) уже существует, но для SD-семейства steps/cfg/sampler — первоклассные параметры, их должен видеть UI генерации. Полный путь:

1. `src/pipeline-stage2.js:295-305` — расширить request полями `negativePrompt?`, `sampler? {steps, cfgScale, samplerName, scheduler}`, `seed?` (seed: `null` = авто).
2. `src/generation-drafts.js` — добавить поля в `createStage2Snapshot` (epoch-guard черновиков).
3. `src/image-api.js:210-219` — проброс в invocation.
4. `src/image-connection-schema.js` — валидация/нормализация новых полей (диапазоны: steps 1–150, cfg 1–30, seed −1/0…2^32−1).
5. `src/core.js:277-283` (`DEFAULT_CHAT_CONFIG_ENVELOPE` / `generationDefaults`) + `loadSettings.globalGenerationDefaults` (:483-489) — персистентность.
6. UI: `src/ui/tab-generate.js:218-231` — третья строка `.uris-gen-params` (Negative textarea сворачиваемая, steps/cfg/sampler числа/дропдаун), `readGenerationParams` :530-535, `prepareSubmissionInput` :873-909; per-провайдерная видимость — по capabilities (`samplerParams: supported/unsupported`), чтобы у Gemini/OpenAI UI не плодил мёртвые поля.
7. Существующие адаптеры игнорируют новые поля (опциональные); ComfyUI-адаптер начнёт подставлять negative в встроенные графы (`src/providers/image-comfyui.js:53,65` — там сейчас жёстко пустая нода) и `%seed%` в плейсхолдер.
8. Тесты: расширить `tests/image-provider-adapters.test.js`, снапшот-тесты drafts, UI-тест `tests/tab-api-server-connections.test.js` не трогаем (это форма подключения, не генерации).

Альтернатива-укорочение: если хочется быстрее — Фазы 1 (CF) можно делать БЕЗ samplerParams (у flux-schnell только steps 1–8), а Фазу 0.1 отложить до A1111. Решение: сначала CF без samplerParams, samplerParams делать вместе с A1111.

### 2.2 Basic auth хелпер (для A1111)

1. Хелпер `basicAuthHeader(user, pass)` рядом с `src/providers/image-base.js`; поле ключа карточки для `sd-webui` принимает формат `user:password` (плейсхолдер-подсказка в `server-connection-form.js:215`); пустое = без auth (большинство локальных инстансов без `--api-auth`).
2. `src/image-connection-schema.js:246` — добавить `'basic'` в `AUTH_STRATEGIES` для detected-факта пробы.
3. Учесть: custom-заголовок вызывает preflight → на инстансе без `--cors-allow-origins` сработает oracle и уйдёт в прокси — это ожидаемое поведение, задокументировать в гайде.

### 2.3 Seed в галерею (опционально, низкий приоритет)

`imageResultFromValue` + потребители: добавить опциональное `result.meta {seed, ...}`; `gallery-index.js:47-48` — поле карточки; `ui/gallery-actions.js` — отображение. Делать после Фазы 2 (A1111 отдаёт seed в `info`).

## 3. Фаза 1 — Cloudflare Workers AI (`cloudflare-workers-ai`)

Контракт по скачанной доке: `POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{model}`, Bearer token; flux-1-schnell → JSON `{result:{image: base64}}`; SDXL base/lightning → бинарный поток image/png (prompt, negative_prompt, num_steps ≤20, guidance, img2img через `image_b64`). Лимит 720 req/min. Free: 10k neurons/день.

Шаги:

1. Дескриптор `PROVIDER_DESCRIPTORS['cloudflare-workers-ai']` (`src/provider-descriptors.js`): `defaultEndpoint: 'https://api.cloudflare.com'`, `endpoint.normalize` (обязателен account_id в пути — валидация формата `/client/v4/accounts/{id}`), `generationPath` с интерполяцией модели, `auth {required: true, scheme: 'bearer', missingError}`.
2. Адаптер `src/providers/image-cloudflare.js`: сборка `{prompt, negative_prompt?, num_steps?, guidance?, image_b64?}`; чтение ответа — снифф `Content-Type`: `application/json` → `result.image` (base64 → `imageResultFromValue`), иначе `arrayBuffer()` → `{kind:'bytes', mimeType}` (НЕ через `readJsonResponse` — он бросит `UPSTREAM_RESPONSE_INVALID` на бинаре, `src/image-base.js:219-227`).
3. Референсы (img2img): `image_b64` из первого референса (SDXL: одна картинка); `assertEncodedReferenceCount`; лимит `maxReferences: 1` в dispatch-plan; кодировка в `REFERENCE_ENCODINGS`.
4. Каталог моделей: у CF есть `GET /client/v4/accounts/{id}/ai/models/search?task=Text-to-Image` — ветка пробника в `src/connect-probe.js`, `catalogSource: 'cf-workers-ai-models'`, `modelMetadata` с `imageGeneration: true` и бинарный/JSON флагом (новое per-model поле — расширить белый список `normalizeConnectionDetected`, `src/image-connection-schema.js:318-356`).
5. Регистрация по чеклисту §4.2 (все 12 точек).
6. Тесты `tests/cloudflare.test.js` по образцу `tests/naistera.test.js`: happy-path JSON-base64; happy-path бинарный; 401/403 типизированы без ретрая; нет токена → отказ до транспорта; img2img-лимит; classifyUrl для `/ai/run/` и `/ai/models/search`; endpoint-normalize кейс в `tests/endpoint-utils.test.js`.
7. **Живой тест (бесплатно)**: завести CF-аккаунт → API token (Workers AI) → account ID → карточка в URIS → «Проверить» (каталог) → генерация flux-1-schnell → генерация SDXL (бинарный путь) → проверка auto-heal (если у CF API нет CORS-заголовков — ожидаем уход в ST-прокси; зафиксировать факт в доке).

## 4. Фаза 2 — A1111/Forge/SD.Next (`sd-webui`)

Зависит от Фазы 0 (samplerParams, negative, Basic auth). Контракт: `POST /sdapi/v1/txt2img` (JSON → `{images:[base64], info}` с seed/sampler в `info`-JSON), `/sdapi/v1/img2img` (`init_images`), `GET /sdapi/v1/samplers`, `/sdapi/v1/sd-models`, `/sdapi/v1/progress`, `/sdapi/v1/options`; `--api`, `--api-auth` (Basic), `--cors-allow-origins`.

Шаги:

1. Дескриптор: `defaultEndpoint: 'http://127.0.0.1:7860'`, `auth {required: false}` (Basic опционален, см. 0.2), `generationPath: '/sdapi/v1/txt2img'`, `modelsPath: '/sdapi/v1/sd-models'`.
2. Адаптер `src/providers/image-sdwebui.js`: маппинг aspect/size → width/height (кратно 8, дефолт из статичной таблицы); samplerParams → `steps/cfg_scale/sampler_name/scheduler`; `negative_prompt`; `seed` (−1 = авто); img2img: `init_images` из референсов + `denoising_strength` (новое sampler-поле или extraBody); `override_settings` — только через extraBody (не давать UI).
3. Парсинг ответа: `images[0]` → `imageResultFromValue`; `info` (JSON-строка) → если сделана Фаза 0.3, вытащить seed в `meta`.
4. Пробник: `GET /sdapi/v1/sd-models` → `modelIds` из `title` (маппинг до `normalizeModelCatalog` — у A1111 своя форма, нужен rawModelId-кейс, `src/model-catalog.js:46-49`); опционально `GET /sdapi/v1/samplers` → `supportedParameters` для UI-дропдауна sampler'ов (манифестный подход, как у wire-params). `catalogSource: 'a1111-sd-models'`.
5. Регистрация (§4.2) + `DELIVERY_PROBE_CONTRACTS` (`src/image-api.js:109`) — `GET /sdapi/v1/sd-models` это дешёвый same-host зонд до платного POST.
6. Тесты `tests/sdwebui.test.js`: точное тело txt2img (deepEqual), Basic-заголовок из `user:pass`, img2img с референсом, ответ-разбор `{images, info}`, 401 при `--api-auth`, endpoint-normalize, пробник (две формы каталога).
7. Гайд `docs/guide/sd-webui-setup.md` по образцу `docs/guide/comfyui-setup.md`: флаги `--api --cors-allow-origins=*`, вариант без CORS через ST-прокси (JSON-only — подходит, т.к. запросы JSON), `--api-auth` и формат ключа.
8. **Живой тест**: поднять webui (или попросить пользователя со стендом) → «Проверить» → txt2img → img2img с референсом → перегенерация с зафиксированным seed.

### 4.1 Фаза 3 — поллинг-семейство: BFL → fal → Replicate

Общий паттерн уже покрыт `pollUntil`; различия — имена полей и статусы:

| | submit | poll | auth | результат | TTL URL |
|---|---|---|---|---|---|
| BFL | `POST /v1/flux-pro-1.1[-ultra]`, `/v1/flux-dev`, `/v1/flux-kontext-pro` → `{id, polling_url}` | `GET /v1/get_result?id=` статусы Pending/…/Ready | `x-key` | `result.sample` URL | **10 минут** |
| fal | `POST https://queue.fal.run/{model}` → `{request_id, status_url, response_url}` | `GET response_url` (IN_QUEUE/IN_PROGRESS/COMPLETED) | `Authorization: Key` | `{images:[{url}], seed}` | не указан |
| Replicate | `POST /v1/models/{owner}/{name}/predictions` (или `Prefer: wait` до 60с) | `GET /v1/predictions/{id}` | Bearer | `output` URLs | **1 час** |

Критично: URL результата короткоживущие — адаптер возвращает `{kind:'url'}`, и `materializeImageResult` скачивает немедленно (механика есть). В netdump скачивание с `*.bfl.ai`/`replicate.delivery` классифицировать как `image`-доставку.

Общие шаги на каждый контракт: дескриптор (`jobPath` + `polling {intervalMs, maxMs}` — BFL рекомендует ~0.5с, но `maxMs` поднять: дешёвый flux-schnell секунды, kontext до минуты; общий дедлайн всё равно `connection.timeoutMs`, дефолт 120с может не хватить под очередь — задокументировать рекомендацию 300с), адаптер с terminal-states и extract, ветка пробника (каталоги: у BFL нет models-GET — статичный список моделей в дескрипторе с `generationUnverified` по образцу pollinations; fal/Replicate имеют model-GET), регистрация, тесты (поллинг, таймаут без второго POST, 402 «нет кредитов» типизировать).

Порядок: BFL первым (контракт чище всего), затем fal, затем Replicate. Живой тест — платный, минимум один прогон на провайдера при появлении кредитов.

### 4.2 Чеклист регистрации контракта (применять в каждой фазе)

1. `src/image-connection-schema.js` — `CONTRACTS`, при необходимости `REMOTE_METADATA_FIELDS`, `API_SHAPE_VALUES`/`AUTH_STRATEGIES`.
2. `src/provider-descriptors.js` — дескриптор (endpoint/auth/paths/polling/parameters).
3. `src/providers/image-<x>.js` — адаптер (requireInvocation → referencesFor/assertEncodedReferenceCount → diagnosticRequestOptions → transport → readJsonResponse/arrayBuffer → imageResultFromValue).
4. `src/image-provider-registry.js` — карта адаптеров.
5. `src/dispatch-plan.js` — `API_SHAPES`/`inferApiShape`/`DIALECT_ORDER` (иначе контракт только ручным пином), `REFERENCE_ENCODINGS`, опционально `FAMILY_PATTERNS`/`maxReferencesFor`/`VALID_PARAMS`.
6. `src/capability-observer.js` — `REFERENCE_MODE_BY_CONTRACT`/`OPERATION_BY_CONTRACT`, коды ошибок в `INVALID_REQUEST_CODES`/`NETWORK_ERROR_CODES`.
7. `src/connect-probe.js` — ветка пробы + `src/catalog.js` URL-билдер.
8. `src/image-api.js` — `DELIVERY_PROBE_CONTRACTS` (если есть дешёвый GET), тернарник encoding в `referenceSummaries`.
9. `src/netdump.js` — `classifyUrl` (каталог → skip, POST/поллинг → `image`).
10. `src/ui/server-connection-form.js` — `DIALECT_OPTIONS`, placeholder/валидация ключа, `headerStatus` подсказки, условный блок полей если нужен.
11. Тесты: `tests/<x>.test.js` + инварианты (`image-provider-adapters.test.js` quality-таблица, `endpoint-utils.test.js`, `image-provider-registry-stamp.test.js`).
12. `docs/providers/<x>-api.md` — уже скачано; дописать факты живой верификации (CORS, реальные коды ошибок) после теста.

## 5. Фаза 4 — Stability (`stability-v2beta`)

Особенность: **multipart-only → только direct CORS** (ST-прокси не переносит FormData). До реализации — живой CORS-чек: `fetch('https://api.stability.ai/v2beta/...', {method:'OPTIONS', ...})` из браузера ST или просто первая генерация; если CORS закрыт — контракт несостоятелен в браузерной модели URIS без серверного плагина, и фаза отменяется/откладывается (в доке зафиксировать). Если открыт: адаптер на `requestMultipart`, `Accept: application/json` (base64 — чтобы не тащить бинарь) или `image/*` + `{kind:'bytes'}`; параметры prompt/negative_prompt/aspect_ratio (9 фиксированных значений — идеально ложатся на `VALID_ASPECT_RATIOS`)/output_format/seed/cfg_scale (sd3)/style_preset. 25 бесплатных кредитов → 3–8 тестовых генераций в зависимости от модели (sd3.5-medium/core дешевле). 402 = кончились кредиты — типизировать.

## 6. Фаза 5 — Seedream (BytePlus) и решение по HF

- **Seedream**: OpenAI-совместимый `POST {base}/api/v3/images/generations` с `model: seedream-*`, `size` ('1K'/'2K' или WxH), `watermark`, `response_format: 'url'`; ответ `{data:[{url}]}`, URL живёт 24ч. Решение в начале фазы: это диалект существующего `openai-images` (через `catalogSource`-переключатель, прецедент `nanogpt-image-models` в `dispatch-plan.js:210-213`) или отдельный тонкий контракт. Скорее диалект — меньше точек регистрации.
- **HF**: отложено (нет free-кредитов, нет OpenAI-совместимого images-эндпоинта; Task API с бинарным ответом технически ложится на примитивы Фазы 1 — вернуться при запросе пользователей).
- **NovelAI**: осознанно НЕ делаем — официальной документации image API не существует (проверено на docs.novelai.net 2026-10-13), контракт только по community-реверсу + ToS-риски; не соответствует рамке «изучив документацию».

## 7. Верификация каждой фазы

1. `npm test` (node --test, Node ≥22) — полный прогон, включая инвариант-тесты реестра/качества/endpoint-utils.
2. Живой чеклист (по образцу `docs/research/2026-09-30-comfyui-verification-checklist.md`): «Проверить» (каталог, auth-ошибки типизированы) → генерация happy-path → генерация с неверным ключом (401 → понятная ошибка, без ретрая) → референс (если поддержан) → принудительный обрыв (таймаут, без второго платного POST) → auto-heal сценарий (блокировка CORS → уход в прокси для JSON-контрактов) → карточка в галерее с корректными метаданными → экспорт настроек (ключ не утёк) → netdump (запросы классифицированы, токены не в дампе).
3. Дописать факты живой проверки в соответствующий `docs/providers/*.md` (раздел «Проверено вживую»).

## 8. Оценка трудоёмкости

| Фаза | Содержание | Оценка | Живой тест |
|---|---|---|---|
| 1 | CF Workers AI | 1–1.5 дня (адаптер + пробник + тесты; бинарный путь впервые) | сразу, бесплатно |
| 0+2 | samplerParams/negative/seed + A1111 | 2–3 дня (UI генерации — самая дорогая часть) | нужен стенд webui |
| 3 | BFL, fal, Replicate | ~1 день на первого (BFL), ~0.5 на каждого следующего | платно, минимально |
| 4 | Stability | 0.5–1 день (если CORS открыт) | 25 бесплатных кредитов |
| 5 | Seedream-диалект | ~0.5 дня | платно, дёшево |

Суммарно: 5–7 рабочих дней на весь список, из них живое бесплатное тестирование доступно с первого дня (CF) и в Фазе 4 (Stability).

## Аддендум: живая верификация 2026-10-13 (curl, тестовый стенд)

Обнаружено, что рабочий ключ Cloudflare Workers AI (с Account ID) уже есть у пользователя и был проверен 2026-09-22 — регистрация не понадобилась, Фаза 1 тестируется немедленно. Прогон по фактам:

- ✅ `flux-1-schnell` — HTTP 200 за ~5с, JSON base64 JPEG (как в доках).
- ✅ `stable-diffusion-xl-lightning` — бинарный ответ за ~5с; **Content-Type врёт** (заявлен image/png, байты JPEG). Требование к адаптеру: MIME только по магическим байтам (в URIS уже есть `detectImageMime`, `src/core.js:979-997` — использовать его, не заголовок).
- ✅ `flux-2-klein-4b` — новая модель в каталоге, **требует multipart-запрос** (на JSON — 400 «required properties are 'multipart'»), ответ JSON base64. В браузере недоступна (multipart → direct-only, а CORS закрыт) — в Фазе 1 не включать либо помечать direct-only.
- ❌ `stable-diffusion-xl-base-1.0` — сломан на стороне CF (408/code 3046, две попытки по ~121с). Исключить из каталога пробника или помечать `generationUnverified` + известный сбой.
- ⚠ **CORS у api.cloudflare.com закрыт** (OPTIONS → 405 без ACAO). Значит весь CF-трафик из браузера пойдёт через ST-прокси — auto-heal сделает это автоматически, но это стоит зафиксировать как ожидаемое поведение (и учесть: прокси-нога у пользователя обязана быть включена, `enableCorsProxy`).
- ❌ HuggingFace: ранее бесплатный путь `hf-inference` теперь отвечает **402 «no remaining credits»** — free-статус окончательно закрыт (дока обновлена).
- ✅ Каталог `GET .../ai/models/search?task=Text-to-Image` живой: 10 t2i-моделей, включая flux-2-dev/klein-4b/klein-9b и leonardo/* — пробник Фазы 1 строить на нём.
- Новый бесплатный кандидат из заметок пользователя: **Together AI — FLUX.1-schnell-Free, OpenAI-совместимый** (`POST https://api.together.xyz/v1/images/generations`). Есть шанс, что работает на существующем контракте `openai-images` без нового адаптера — проверить первым делом после получения ключа (это бесплатный тест №2 после CF).

Обновлённый приоритет живых тестов: 1) CF (ключ есть) → 2) Together (после регистрации, бесплатно) → 3) Stability (25 кредитов, после регистрации) → 4) A1111 (нужен стенд) → платные по мере появления балансов.
