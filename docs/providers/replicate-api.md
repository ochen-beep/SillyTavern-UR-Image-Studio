---
source: https://replicate.com/docs/topics/predictions/create-a-prediction + https://replicate.com/docs/reference/http + https://replicate.com/pricing + https://replicate.com/black-forest-labs/flux-schnell
fetched: 2026-10-13
note: справочник HTTP задокументирован; точные значения входных параметров конкретных моделей (в т.ч. flux-schnell) в HTML-доках не рендерятся (JS) — официальное направление: брать схему через GET /v1/models/{owner}/{name} → latest_version.openapi_schema. Про бесплатные стартовые кредиты страница pricing ничего не говорит — статус unverified
---

# Replicate — Predictions API

Replicate исполняет модели в виде «predictions» (запрос-предсказание с уникальным id). Официальные модели (в т.ч. `black-forest-labs/flux-schnell`) вызываются без указания версии.

## Эндпоинты

- **Официальная модель:** `POST https://api.replicate.com/v1/models/{owner}/{name}/predictions` — body `{"input": {...}}` (версия не нужна, всегда последняя).
- **Любая/community-модель по версии:** `POST https://api.replicate.com/v1/predictions` — body `{"version": "<version_id>", "input": {...}}`.
- **Поллинг:** `GET https://api.replicate.com/v1/predictions/{prediction_id}` (совпадает с `urls.get`).
- **Отмена:** `POST .../predictions/{id}/cancel` (из `urls.cancel`).

## Авторизация

- `Authorization: Bearer $REPLICATE_API_TOKEN`.

## Синхронный режим (Prefer: wait)

- Заголовок `Prefer: wait` — сервер держит соединение (по умолчанию до 60 с; `Prefer: wait=5` — 5 с). Если генерация уложилась — ответ сразу с заполненным `output` и терминальным `status`.
- Если не уложилась — вернётся неполный объект (`status: "starting"|"processing"`), URL для дальнейшего опроса — в заголовке `Location` и в `urls.get`.
- Для генерации картинок `Prefer: wait` обычно хватает: FLUX-подобные модели отрабатывают за секунды.

## Асинхронный режим и поллинг

- Без заголовка ответ приходит сразу:

```json
{
  "id": "gm3qorzdhgbfurvjtvhg6dckhu",
  "status": "starting",
  "output": null,
  "urls": {
    "get": "https://api.replicate.com/v1/predictions/gm3qorzdhgbfurvjtvhg6dckhu",
    "cancel": "https://api.replicate.com/v1/predictions/gm3qorzdhgbfurvjtvhg6dckhu/cancel",
    "web": "https://replicate.com/p/gm3qorzdhgbfurvjtvhg6dckhu"
  }
}
```

- Опрос `urls.get` раз в 1–2 с до терминального статуса: `succeeded` | `failed` | `canceled` (промежуточные: `starting`, `processing`).
- **Вебхуки:** в body `"webhook": "https://...", "webhook_events_filter": ["completed"]`. **Дедлайн:** заголовок `Cancel-After` (от 5 с до 24 ч; форматы `30`, `30s`, `5m`, `1m30s`) — автоотмена долгих предсказаний.

## Объект prediction

Поля: `id`, `model`, `version`, `input`, `logs`, `output`, `error`, `status`, `created_at`, `started_at`, `completed_at`, `source`, `data_removed`, `metrics` (`predict_time`, `total_time`), `urls` (`web`, `get`, `cancel`).

- **output** для image-моделей — массив **URL-ов файлов** (отдаются с `replicate.delivery`); файлы скачиваются обычным GET, токен не нужен.
- Важно: входы, выходы и логи API-предсказаний **автоматически удаляются через час** (`data_removed`) — результат надо скачивать сразу.

## Передача файлов (референсы)

- На странице reference отдельный `/v1/files` не задокументирован; рекомендация доков: файлы передаются как **HTTP-URL** (для файлов >256 КБ или используемых повторно) либо **data-URL** (≤256 КБ, однократно) в полях `input`.

## Модель black-forest-labs/flux-schnell

- Официальная модель: 12B rectified-flow transformer, генерация за 1–4 шага, лицензия Apache-2.0.
- Биллинг: **$3.00 за 1000 выходных изображений** ($0.003/изображение, биллинг по результату, не по секундам).
- Входная схема — через API: `GET https://api.replicate.com/v1/models/black-forest-labs/flux-schnell` → `latest_version.openapi_schema.components.schemas.Input` (jq: `.latest_version.openapi_schema.components.schemas.Input`). Точные дефолты параметров в HTML-доках не публикуются (unverified), типовой набор полей: `prompt`, `aspect_ratio`, `num_outputs`, `num_inference_steps`, `guidance`, `seed`, `output_format`.

## Цены (железо, для частных моделей)

- Pay-as-you-go за секунды исполнения: CPU $0.000025/с; T4 $0.000225/с; L40S $0.000975/с; A100-80GB $0.0014/с; H100 $0.001525/с. Часть моделей (в т.ч. flux-schnell, flux-1.1-pro $0.04/выход) биллится за выходное изображение.

## Бесплатное тестирование

- **Статус: unverified (скорее платно).** Страница https://replicate.com/pricing (проверено 2026-10-13) **не упоминает ни бесплатных стартовых кредитов, ни free-tier** — только «You only pay for what you use». Ранее Replicate выдавал пробные кредиты новым аккаунтам, но в текущем прайс-листе это не задокументировано.
- Самая дешёвая точка входа для теста — flux-schnell: $0.003 за изображение (≈333 картинки за $1); нужна ли карта при регистрации — на странице не указано (unverified).
