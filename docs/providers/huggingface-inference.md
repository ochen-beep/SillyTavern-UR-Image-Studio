---
source: https://huggingface.co/docs/inference-providers/index + /tasks/text-to-image + /pricing + /hub-api + https://huggingface.co/docs/huggingface_hub/guides/inference
fetched: 2026-10-13
note: страницы HF-доков доступны также в raw markdown по суффиксу .md; curl-примеры для провайдер-специфичных маршрутов text-to-image в доках не публикуются (шаблоны InferenceSnippet рендерятся клиентом) — для прямого HTTP без SDK HF официально рекомендует SDK (huggingface_hub / @huggingface/inference), формат задачи ниже задокументирован в «API specification»
---

# Hugging Face Inference Providers — text-to-image

Единый прокси-роутер HF к сторонним провайдерам инференса (hf-inference, fal-ai, replicate, together, nscale, wavespeed и др.): один токен HF, биллинг на аккаунте HF «по ценам провайдера, без наценки».

## Эндпоинты и авторизация

- База роутера: `https://router.huggingface.co`.
- OpenAI-совместимый эндпоинт: `POST https://router.huggingface.co/v1/chat/completions` — **только для chat**. В доках прямо указано: «This OpenAI-compatible endpoint is currently available for chat completion tasks only. For other tasks like text-to-image, embeddings... use the Hugging Face inference clients». То есть **`/v1/images/generations` на роутере НЕ поддерживается** (на 2026-10-13).
- Задача text-to-image вызывается через нативный task-API; URL формируется из выбранного провайдера (SDK делает это сам; исторический паттерн hf-inference: `POST https://router.huggingface.co/hf-inference/models/{model_id}`).
- Auth: `Authorization: Bearer hf_****` — fine-grained токен с разрешением «Make calls to Inference Providers» (создаётся на https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained).
- Альтернатива: свой ключ провайдера («Custom Provider Key») в настройках https://huggingface.co/settings/inference-providers — тогда биллит провайдер, HF-кредиты не применяются.

## Формат запроса (задача text-to-image)

```
POST https://router.huggingface.co/{provider-route}
Authorization: Bearer $HF_TOKEN
Content-Type: application/json

{
  "inputs": "Astronaut riding a horse",
  "parameters": {
    "guidance_scale": 7.5,
    "negative_prompt": "...",
    "num_inference_steps": 30,
    "width": 1024,
    "height": 1024,
    "seed": 42,
    "scheduler": "..."
  }
}
```

Спецификация параметров (из «API specification»):
- `inputs*` (string) — промпт;
- `parameters.guidance_scale` (number) — adherence к промпту;
- `parameters.negative_prompt` (string);
- `parameters.num_inference_steps` (integer) — шаги денойзинга;
- `parameters.width`, `parameters.height` (integer, px);
- `parameters.scheduler` (string) — переопределение шедулера;
- `parameters.seed` (integer).

## Формат ответа

- **Сырые байты изображения** («The generated image returned as raw bytes in the payload») — ответ сохраняется напрямую как PNG/JPEG; SDK возвращает `PIL.Image` (Python) / `Blob` (JS).

## Выбор провайдера и модели

- В SDK: `provider="auto"` (по умолчанию — быстрейший доступный) или конкретный провайдер (`"hf-inference"`, `"fal-ai"`, `"replicate"`, `"together"`, `"nscale"`, `"wavespeed"` и т.д.).
- В имени модели через суффикс: `model:fastest` (по умолчанию), `model:cheapest`, `model:preferred`, `model:имя_провайдера`.
- Рекомендованные модели t2i из доков: `black-forest-labs/FLUX.1-Krea-dev`, `Qwen/Qwen-Image`, `ByteDance/Hyper-SD`; в примерах также `black-forest-labs/FLUX.1-dev` и `FLUX.1-schnell`. Список «горячих» моделей: `GET https://huggingface.co/api/models?inference_provider=all&pipeline_tag=text-to-image` (или `hf models ls --warm --pipeline-tag text-to-image`).
- Маппинг id: HF-id ≠ id провайдера (например `black-forest-labs/FLUX.1-dev` у fal-ai — `fal-ai/flux/dev`); конкретный провайдер модели — `GET https://huggingface.co/api/models/{model}?expand[]=inferenceProviderMapping`.

## Биллинг

- Оплата за каждый запрос по прайсу провайдера, без наценки HF. Для `hf-inference` биллинг = compute-time × цена GPU-секунды (пример из доков: FLUX.1-dev, 10 c на GPU по $0.00012/с = $0.0012 за запрос).
- Включённые месячные кредиты (применяются автоматически): **PRO — $2.00/мес**, **Team/Enterprise — $2.00 на место/мес**; кредиты общие для всех compute-сервисов HF.
- Организационный биллинг: заголовок `X-HF-Bill-To: <org>`.

## Бесплатное тестирование

- **Статус: платно, включённые кредиты только у подписчиков.** Для **Free-аккаунтов включённых кредитов НЕТ** (таблица pricing: «Free Users — None»); free-пользователь может генерировать только купив credit-пакет или оформив PRO. Номер карты нужен для покупки кредитов/PRO.
- **Подтверждено вживую 2026-10-13**: `POST router.huggingface.co/hf-inference/models/stabilityai/stable-diffusion-3-medium-diffusers` с рабочим free-токеном → **HTTP 402 «You have no remaining credits. Purchase pre-paid credits…»**. Ранее (2026-09-22) этот путь работал бесплатно — теперь закрыт.
- Т.е. «бесплатного теста» через Inference Providers на free-аккаунте нет; условно-дешёвый вход — PRO-подписка со включёнными $2 кредитами (на FLUX.1-schnell у hf-inference это десятки генераций).
- Альтернатива бесплатно: некоторые модели доступны через бесплатные HF-плейграунды/Спейсы, но это вне API Inference Providers.
