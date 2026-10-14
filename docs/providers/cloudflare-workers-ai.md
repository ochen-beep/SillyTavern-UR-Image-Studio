---
source: https://developers.cloudflare.com/workers-ai/get-started/rest-api/ + https://developers.cloudflare.com/workers-ai/platform/pricing/ + https://developers.cloudflare.com/workers-ai/platform/limits/ + страницы моделей /workers-ai/models/flux-1-schnell, /workers-ai/models/stable-diffusion-xl-base-1.0, /workers-ai/models/stable-diffusion-xl-lightning (все доступны в markdown по суффиксу index.md / llms.txt)
fetched: 2026-10-13
note: цены SDXL-base-1.0 и SDXL-lightning на странице pricing не указаны — страницы моделей показывают «Unit Pricing: $0.00 per step» (модели в статусе Beta); тарифицируются ли они нейронами при превышении бесплатной квоты, на странице pricing не раскрыто
---

# Cloudflare Workers AI — REST API text-to-image

Serverless-инференс моделей Cloudflare. Для генерации изображений используется единый REST-эндпоинт `/ai/run/{model}`; формат ответа зависит от модели: flux-1-schnell возвращает JSON с base64, SDXL-модели — бинарный поток (см. ниже).

## Эндпоинт и авторизация

- Выполнение модели: `POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{model}` (пример: `.../ai/run/@cf/black-forest-labs/flux-1-schnell`).
- Auth: заголовок `Authorization: Bearer {API_TOKEN}`. Токен создаётся в дашборде (Workers AI → «Use REST API» → «Create a Workers AI API Token»); при ручном создании нужны права «Workers AI - Read» и «Workers AI - Edit». Account ID копируется с той же страницы.
- Общий JSON-конверт ответов Cloudflare API: `{ "result": ..., "success": bool, "errors": [], "messages": [] }`.

## Модели text-to-image

### @cf/black-forest-labs/flux-1-schnell (FLUX.1 [schnell])

- `POST https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/black-forest-labs/flux-1-schnell`
- Параметры:
  - `prompt` (string, **required**, minLength 1, maxLength 2048) — описание изображения;
  - `steps` (integer, default 4, max 8) — число шагов диффузии;
  - `seed` (integer, optional) — воспроизводимость.
- **Формат ответа: JSON**, изображение в `result.image` как Base64-строка («The generated image in Base64 format»). В примерах Cloudflare её либо встраивают как data-URI, либо декодируют через `atob()` и отдают как байты с `Content-Type: image/jpeg`.
- Лицензия: условия Black Forest Labs (bfl.ai/legal/terms-of-service).

### @cf/stabilityai/stable-diffusion-xl-base-1.0 (Beta)

- Параметры:
  - `prompt` (string, **required**, minLength 1);
  - `negative_prompt` (string, optional);
  - `height`, `width` (integer, min 256, max 2048);
  - `num_steps` (integer, default 20, max 20);
  - `guidance` (number, default 7.5) — adherence к промпту;
  - `strength` (number, default 1, диапазон 0–1) — для img2img;
  - `seed` (integer, optional);
  - `image[]` / `image_b64` (array of uint8 / base64-строка) — входное изображение для img2img;
  - `mask[]` (array of uint8) — маска для inpainting.
- **Формат ответа: бинарный** — по документации биндинг/REST возвращают `ReadableStream` с байтами изображения (не JSON с base64), т.е. ответ можно сразу сохранять как PNG-файл.

### @cf/bytedance/stable-diffusion-xl-lightning (Beta)

- Тот же набор параметров и тот же бинарный формат ответа (`ReadableStream`), что и у SDXL-base-1.0; модель от ByteDance, быстрая (few-step).

## Примеры

```bash
# flux-1-schnell: ответ — JSON с base64
curl https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai/run/@cf/black-forest-labs/flux-1-schnell \
  -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -d '{ "prompt": "cyberpunk cat", "steps": 4 }'
# => {"result":{"image":"<base64>"},"success":true,"errors":[],"messages":[]}

# SDXL: ответ — бинарные байты изображения
curl https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai/run/@cf/stabilityai/stable-diffusion-xl-base-1.0 \
  -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -d '{"prompt":"a cat in space","num_steps":20,"guidance":7.5,"width":1024,"height":1024}' \
  --output image.png
```

## Лимиты (rate limits, запросов в минуту)

- Задача **Text-to-Image: 720 req/min** (исключение `@cf/runwayml/stable-diffusion-v1-5-img2img` — 1500).
- Beta-модели «may have lower rate limits»; лимиты распространяются и на локальный режим wrangler; повышенные лимиты — через заявку в Cloudflare.
- Справочник ошибок: https://developers.cloudflare.com/workers-ai/platform/errors/

## Цены (биллинг в Neurons)

- **Бесплатная квота: 10 000 Neurons в день** (проверено на странице pricing, дата fetched) — доступно и на Workers Free, и на Workers Paid.
- Сверх квоты (Workers Paid): **$0.011 за 1 000 Neurons**.
- `@cf/black-forest-labs/flux-1-schnell`: **4.80 Neurons за тайл 512x512** ($0.0000528) + **9.60 Neurons за шаг** ($0.0001056). Итого типичная генерация 1024x1024 (4 тайла, 4 шага): ~38.4 Neurons — меньше 0.5% дневной бесплатной квоты.
- `stable-diffusion-xl-base-1.0` и `stable-diffusion-xl-lightning`: на странице pricing не перечислены; страницы моделей показывают «Unit Pricing: $0.00 per step» (Beta). Актуальную тарификацию перед использованием стоит перепроверить.
- Также есть flux-2-dev, flux-2-klein-4b/9b (тарификация за тайлы/мегапиксели, см. pricing-страницу).

## Проверено вживую (2026-10-13, curl с тестового стенда)

- ✅ `flux-1-schnell`: HTTP 200 за ~5с, JSON `result.image` = base64 JPEG 1024×1024 (~416 КБ).
- ✅ `stable-diffusion-xl-lightning`: HTTP 200 за ~5с, **бинарный** ответ. ⚠ **`Content-Type: image/png` врёт** — фактические байты JPEG (`ffd8 JFIF`). MIME определять только по магическим байтам.
- ✅ `flux-2-klein-4b`: работает, но **требует multipart/form-data** (`-F prompt=...`; на JSON отвечает 400 «required properties at '/' are 'multipart'»); ответ — JSON `result.image` base64, ~13с. Multipart в браузере URIS идёт только direct (ST-прокси JSON-only) — см. CORS ниже.
- ❌ `stable-diffusion-xl-base-1.0`: сломан на стороне CF — две попытки, HTTP 408 через ~121с, `AiError: Request timeout` (code 3046). Не включать в каталог / помечать.
- ⚠ **CORS закрыт**: OPTIONS-проба с `Origin`/`Access-Control-Request-*` → 405 без `Access-Control-Allow-Origin`. Из браузера прямые запросы не пройдут — URIS auto-heal уведёт в ST-прокси (JSON-запросы прокси-совместимы; бинарный ОТВЕТ через прокси проходит). Multipart-модели (flux-2-klein) из браузера, скорее всего, недоступны — оставить как direct-only с честной пометкой.
- ✅ Каталог: `GET .../ai/models/search?task=Text-to-Image` → 10 моделей, включая новые `flux-2-dev`, `flux-2-klein-4b/9b`, `leonardo/phoenix-1.0`, `leonardo/lucid-origin` (в доках на момент fetched описаний не было — параметры уточнять).

## Бесплатное тестирование

- **Статус: бесплатно**, карта и платный план Workers не требуются — на бесплатном тарифе даётся **10 000 Neurons/день** (обнуляется ежедневно), чего хватает на десятки-сотни генераций flux-1-schnell в день.
- Сверх квоты нужна подписка **Workers Paid ($5/мес)** по $0.011/1000 Neurons.
- Для REST API нужен только аккаунт Cloudflare и API-токен; номера карты при регистрации не запрашиваются.
