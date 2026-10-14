---
source: https://fal.ai/docs/model-endpoints/queue + https://fal.ai/pricing
fetched: 2026-10-13
note: docs.fal.ai — JS-heavy Next.js; web-рендер теряет часть код-блоков, поэтому queue-раздел выверен по рендеру + структуре ответов страницы. Стартовые бесплатные кредиты на странице pricing НЕ упомянуты — статус unverified. Прайс-лист на /pricing показывает только топ-10 моделей на категорию; цену конкретной модели (в т.ч. fal-ai/flux/schnell) надо смотреть на её странице fal.ai/model/...
---

# fal.ai — Queue API генерации изображений

fal.ai — платформа генеративного медиа-инференса (1000+ моделей). Долгие запросы (генерация картинок — почти всегда) идут через очередь: submit → поллинг статуса → GET результата, либо вебхук.

## Эндпоинты очереди

Хост очереди — `queue.fal.run` (отдельный субдомен, пути повторяют id модели).

- **Submit:** `POST https://queue.fal.run/{model_id}` (пример: `POST https://queue.fal.run/fal-ai/flux/schnell`), body — JSON с параметрами модели (`{"prompt": "..."}`).
- **Status:** `GET https://queue.fal.run/{model_id}/requests/{request_id}/status` (опционально `?logs=1`).
- **Stream статуса:** `GET .../requests/{request_id}/status/stream?logs=1` — SSE (`text/event-stream`).
- **Result:** `GET https://queue.fal.run/{model_id}/requests/{request_id}` (или `response_url` из ответа submit).
- **Cancel:** `PUT https://queue.fal.run/{model_id}/requests/{request_id}/cancel` — только пока запрос в очереди. Ответы: `202 {"status":"CANCELLATION_REQUESTED"}`, `400 {"status":"ALREADY_COMPLETED"}`, `404 {"status":"NOT_FOUND"}`.

## Авторизация

- Заголовок: `Authorization: Key $FAL_KEY` (ключ создаётся в дашборе fal.ai).
- Доп. заголовки: `X-Fal-No-Retry: 1` (отключить авто-ретраи), `X-Fal-Request-Start-Timeout`, `X-Fal-Runner-Hint`, `X-Fal-Queue-Priority`.

## Формат ответа submit

```json
{
  "request_id": "764cabcf-b745-4b3e-ae38-1200304cf45b",
  "response_url": "https://queue.fal.run/fal-ai/flux/schnell/requests/{request_id}/response",
  "status_url": "https://queue.fal.run/fal-ai/flux/schnell/requests/{request_id}/status",
  "cancel_url": "https://queue.fal.run/fal-ai/flux/schnell/requests/{request_id}/cancel",
  "queue_position": 0
}
```

## Статусы

- `IN_QUEUE` — поля `queue_position`, `response_url`;
- `IN_PROGRESS` — `logs` (если включены), `response_url`;
- `COMPLETED` — `logs`, `metrics.inference_time`; ошибки — поля `error`, `error_type`.
- Логи выключены по умолчанию; включаются `?logs=1` при запросе статуса (`RequestLog`: message, level `STDERR|STDOUT|ERROR|INFO|WARN|DEBUG`, source, timestamp).

## Результат

После `COMPLETED` — GET на `response_url`/result-эндпоинт возвращает JSON модели. Для image-моделей (включая `fal-ai/flux/schnell`) структура содержит массив `images` с URL-ами и поле `seed`; в вебхук-примере доков: `"payload": { "images": [...] }`. Изображение скачивается обычным GET по `url` (отдаётся с CDN fal.media) — auth для скачивания не нужен.

## Вебхуки (альтернатива поллингу)

- К submit добавляется `?fal_webhook=https://your-server.com/webhook` (в SDK — `webhook_url`).
- По завершении fal шлёт POST: `{ "request_id", "gateway_request_id", "status": "OK" | "ERROR", "payload": { "images": [...] } }`. Статусы вебхука (`OK`/`ERROR`) — не то же самое, что статусы очереди.
- Доставки могут повторяться — идемпотентность по `request_id`; ответ `HTTP 200` подтверждает получение.

## Модель fal-ai/flux/schnell

- «Быстрая/дешёвая» FLUX.1-schnell на fal: submit на `https://queue.fal.run/fal-ai/flux/schnell`, вход — минимум `prompt` (плюс настройки размера/числа изображений на странице модели).
- Оплата помодельная, per-use; примеры цен image-моделей с /pricing (за единицу): `fal-ai/z-image/turbo` $0.005/мегапиксель, `fal-ai/nano-banana` $0.0398/изображение. Точную цену flux/schnell смотрите на странице модели (на общий прайс-лист не попала).

## Бесплатное тестирование

- **Статус: unverified.** Страница https://fal.ai/pricing (проверено 2026-10-13) описывает только pay-per-use и почасовые GPU ($1.99–$12.99/ч) — **про стартовые бесплатные кредиты новых пользователей на ней ничего не сказано**; исторически fal выдавал пробные кредиты, но официальным прайс-листом это не подтверждено.
- Оплата помодельная, без подписки; для вывода в прод нужна привязанная карта/пополнение (условия пополнения на странице не раскрыты — unverified).
- Рекомендация: проверить наличие welcome-кредитов в дашборе после регистрации (Settings → Billing) перед интеграцией.
