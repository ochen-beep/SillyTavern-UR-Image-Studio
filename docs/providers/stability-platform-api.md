---
source: https://platform.stability.ai/docs/api-reference (SPA, не отдал контент) + официальные KB-статьи kb.stability.ai (api-key-rate-limit-information, where-can-i-find-my-api-key, understanding-aspect-ratios-in-our-apis, integrating-stability-ai-with-zapier, resolving-malformed-formdata-request-errors-in-c, how-b-credits-work-billing-faqs, why-are-my-credits-being-spent-at-inconsistent-amounts) + сниппеты официальных страниц platform.stability.ai/pricing и /docs/getting-started
fetched: 2026-10-13
note: полный API-reference на platform.stability.ai — client-side SPA без SSR; llms.txt/openapi.json недоступны, Cloudflare блокирует прямой забор JS-бандла (проверены WebFetch, webReader, браузер, Wayback — архив тоже хранит только SPA-шелл). Контракт ниже собран из официальных сервер-рендеренных KB-статей Stability AI и поисковых сниппетов официальных страниц; полный список параметров sd3/ultra/core сверять с живым /docs на platform.stability.ai.
---

# Stability AI Platform API — v2beta Stable Image

Облачный REST API platform.stability.ai. Базовый URL: `https://api.stability.ai`.

## Аутентификация

- API-ключ создаётся в дашборде https://platform.stability.ai (раздел API Keys; до 10 активных ключей на аккаунт).
- Заголовок: `Authorization: Bearer <KEY>`.
- Ключ нельзя публиковать в клиентском коде — вызовы только с бэкенда.

## Эндпоинты генерации (v2beta)

- `POST https://api.stability.ai/v2beta/stable-image/generate/sd3` — Stable Diffusion 3 / 3.5
- `POST https://api.stability.ai/v2beta/stable-image/generate/ultra` — Stable Image Ultra (макс. детализация)
- `POST https://api.stability.ai/v2beta/stable-image/generate/core` — Stable Image Core (быстрая)
- `POST https://api.stability.ai/v2beta/stable-image/upscale/creative` — апскейл (async)
- `POST https://api.stability.ai/v2beta/stable-image/edit/search-and-recolor` — перекраска по маске (prompt принимает только словесные цвета, не HEX/RGB)
- Инпейнтинг — тот же семейство эндпоинтов stable-image (image + mask + prompt)

## Формат запроса

`multipart/form-data` (JSON не принимается). Заголовки:

- `Authorization: Bearer <KEY>`
- `Accept`:
  - `image/*` — сервер вернёт бинарное изображение (png/jpeg/webp) прямо в теле ответа;
  - `application/json` — сервер вернёт JSON (base64-изображение + метаданные; удобнее для интеграций).

Поля формы (подтверждено официальными KB/примерами):

| Поле | Значения |
|---|---|
| `prompt` | текст промпта |
| `negative_prompt` | только для sd3 |
| `aspect_ratio` | `1:1`, `16:9`, `21:9`, `2:3`, `3:2`, `4:5`, `5:4`, `9:16`, `9:21` — поддерживается на Ultra, Core и SD3 |
| `output_format` | `png`, `jpeg`, `webp` |
| `seed` | 0..4294967294; 0 = случайный |
| `model` (только sd3) | `sd3.5-large`, `sd3.5-medium`, `sd3.5-large-turbo` |
| `cfg_scale` (только sd3) | how strictly to follow prompt |
| `style_preset` (только sd3) | именованный пресет стиля |

Таблица aspect_ratio (официальная, едина для Ultra/Core/SD3):

| aspect_ratio | Пиксели (W×H) |
|---|---|
| 16:9 | 1344×768 |
| 1:1 | 1024×1024 |
| 21:9 | 1536×640 |
| 2:3 | 832×1216 |
| 3:2 | 1216×832 |
| 4:5 | 896×1088 |
| 5:4 | 1088×896 |
| 9:16 | 768×1344 |
| 9:21 | 640×1536 |

Полные дефолты и полный список полей каждого эндпоинта — в API-reference (`platform.stability.ai/docs/api-reference#tag/Generate`), который на момент скачивания недоступен автоматически (см. note).

## Формат ответа

- При `Accept: image/*` — бинарное изображение.
- При `Accept: application/json` — JSON с base64-картинкой и метаданными (seed, finish_reason).

## Ошибки

- `400` + `{"success": false, "message": "Malformed FormData request. ..."}` — неправильно собран multipart (известная проблема: C# HttpClient требует кавычки в Content-Disposition `name`).
- `402` — закончились кредиты.
- `429` — rate limit (см. ниже).
- Точный список кодов — в API-reference (не удалось скачать автоматически).

## Лимиты

- Официальный rate limit: **150 запросов за 10 секунд** на ключ; при превышении — `429`, за которым следует блокировка на **60 секунд**.
- До 10 API-ключей на аккаунт; ротация/распределение нагрузки через несколько ключей разрешены.

## Биллинг

- **1 кредит = $0.01**. Тарифные планы: Creator — 2000 кредитов/мес; Pro — 6000 кредитов/мес (недавно увеличено с 5000); неиспользованные кредиты сгорают в конце периода; докупка топ-апов через дашборд.
- Стоимость генерации зависит от эндпоинта и параметров (размер, шаги) — полная таблица по моделям на platform.stability.ai/pricing (SPA, автоматически не скачалась).

## Бесплатное тестирование

- **Новый аккаунт получает 25 бесплатных кредитов** (подтверждено официальной KB-статьей «Where can I find my API key» и страницей pricing: «Get started with 25 free credits»).
- При регистрации через Google social login 25 кредитов начисляются сразу (страница getting-started).
- 25 кредитов хватает на несколько тестовых генераций Core/SD3.5, но не на Ultra-серию; для постоянной работы нужен платный план или топ-ап.
