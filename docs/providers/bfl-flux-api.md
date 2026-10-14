---
source: https://docs.bfl.ai/ (mintlify, зеркалится в .md-страницы docs.bfl.ml: api-reference/models/*, api-reference/utility/get-result, quick_start/pricing, api_integration/integration_guidelines, api_integration/errors)
fetched: 2026-10-13
note: документация скачивалась через llms.txt/.md-версии официального сайта (docs.bfl.ai → docs.bfl.ml). Параметры FLUX.1 [flux-dev] показывают устаревший пример значения по умолчанию в доках; актуальные схемы сверять с https://api.bfl.ai/openapi.json.
---

# Black Forest Labs — FLUX API (api.bfl.ai)

Облачный async-API для моделей FLUX. Создание задачи → поллинг результата (или webhook).

## Базовые URL и аутентификация

- **Глобальный:** `https://api.bfl.ai` (маршрутизация по кластерам с автоматическим failover)
- **EU (GDPR):** `https://api.eu.bfl.ai`; **US:** `https://api.us.bfl.ai`
- Раздача картинок — с региональных хостов `delivery.*.bfl.ai` (хостнеймы могут меняться — не хардкодить).
- Ключ из профиля пользователя передаётся в заголовке **`x-key: <API_KEY>`** и на submit, и на поллинг.

## Создание задачи

`POST https://api.bfl.ai/v1/{model}` , Content-Type: `application/json`. Модели:

- `/v1/flux-pro-1.1` — FLUX1.1 [pro]
- `/v1/flux-pro-1.1-ultra` — Ultra mode (до 4MP; тарификация по мегапикселям)
- `/v1/flux-dev` — FLUX.1 [dev]
- `/v1/flux-kontext-pro`, `/v1/flux-kontext-max` — редактирование по текстовой инструкции
- Также есть fill/depth/canny, FLUX.2 семейство и др. (см. llms.txt доков)

Параметры flux-pro-1.1 (`FluxPro11Inputs`):

| Параметр | Тип | Дефолт | Ограничения |
|---|---|---|---|
| `prompt` | string | `""` | |
| `image_prompt` | string (base64) | `null` | референс для Flux Redux |
| `width` | int | 1024 | 256–1440, кратно 32 |
| `height` | int | 768 | 256–1440, кратно 32 |
| `prompt_upsampling` | bool | false | авторасширение промпта |
| `seed` | int | null | воспроизводимость |
| `safety_tolerance` | int | 2 | 0–6 (0 = строже всего; для FLUX.2/edit макс. 5, для FLUX.3 image/video макс. 4) |
| `output_format` | enum | `jpeg` | `jpeg`/`png`/`webp` |
| `webhook_url` | string(URI) | null | max 2083 символа |
| `webhook_secret` | string | null | для проверки подписи webhook |
| `user` | string | null | opaque id конечного пользователя (1–256) |

Отличия flux-dev: добавляются `steps` (int, дефолт 28, 1–50) и `guidance` (float, дефолт 3, диапазон 1.5–5; выше = точнее следование промпту, ниже реалистичность).

Отличия flux-kontext-pro (редактирование): `prompt` обязателен; `input_image` — base64 или URL; `input_image_2`..`input_image_4` — доп. референсы (experimental multiref); `aspect_ratio` — строка от `21:9` до `9:21`; `output_format` дефолт `png`. Поля `guidance`/`steps`/`raw_mode` в опубликованной схеме `FluxKontextProInputs` отсутствуют.

## Ответ на создание

`200` — `AsyncResponse`:

```json
{ "id": "<task id>", "polling_url": "https://api.bfl.ai/v1/get_result?id=...", "cost": 4, "input_mp": 0.79, "output_mp": 0.79 }
```

`422` — ошибка валидации: `{"detail": [{"loc": [...], "msg": "...", "type": "..."}]}`.

Если передан `webhook_url`, приходит `AsyncWebhookResponse` (с `status`, `webhook_url`).

## Поллинг результата

`GET {polling_url}` (эквивалент `GET https://api.bfl.ai/v1/get_result?id=<task_id>`, тот же `x-key`). Пример в доках опрашивает раз в 0.5 секунды. Ответ (`ResultResponse`, у платных моделей `SettledCostResultResponse` с обязательным `cost`):

| Поле | Смысл |
|---|---|
| `status` | `Pending` / `Reasoning` / `Generating` → продолжать; `Ready` → успех; `Request Moderated` / `Content Moderated` / `Task not found` / `Error` → стоп (ошибки) |
| `progress` | 0..1 |
| `result` | URL готового файла (только при `Ready`) |
| `details` | при модерации: `{"Moderation Reasons": ["Violence", ...]}` |
| `cost` | фактическая стоимость в кредитах |
| `preview` | превью (если включено) |

- URL результата живёт **10 минут** — скачивать сразу.
- У URL раздачи **нет CORS** — раздавать картинку конечным пользователям только через свой бэкенд/CDN.
- Webhook-режим: уведомление о завершении приходит на `webhook_url`; подпись проверяется `webhook_secret`.

## Лимиты и обработка ошибок

- **До 24 одновременных (concurrent) запросов** на большинство эндпоинтов; **6** для `flux-kontext-max`.
- `429` — повторять с экспоненциальным backoff; `402` — закончились кредиты (показать пользователю); `400`/`403`/`422`/`500`/`503` — см. errors.md (кодов `401`/`404` в справке нет).
- Firewalls: разрешить исходящие к `*.bfl.ai` (региональные хосты меняются).

## Биллинг

- **1 кредит = $0.01**; одна цена для API и Playground. Оплата только предоплаченными кредитами («add credits»).
- FLUX.1 (за картинку): Kontext [pro] — 4 кредита ($0.04); Kontext [max] — 8 ($0.08); FLUX1.1 [pro] — 4 ($0.04); [pro] Ultra / Raw — 6 ($0.06); Fill [pro] — 5 ($0.05).
- FLUX.2 — тарификация по мегапикселям (первый MP по базовой ставке, каждый следующий дороже); FLUX.3 image — по разрешению ($0.041 за 768² до $0.607 за 4k); видео — за секунду.

## Бесплатное тестирование

- **Free tier отсутствует**: в официальной документации (quick_start/pricing, integration guidelines) нет ни бесплатных кредитов, ни триала — только инструкция пополнить кредиты перед использованием. Для первого теста нужен минимальный платный депозит.
