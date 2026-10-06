---
source: https://github.com/0xl0cal/sillyimages/blob/master/README-en.md (раздел Naistera) — единственная публичная документация сервиса
fetched: 2026-10-01
note: сервис не публикует standalone-доков; полный контракт, реализованный расширением, см. src/providers/image-naistera.js и src/provider-descriptors.js
---

# Naistera — API генерации изображений

Naistera (https://naistera.org) — сервис генерации изображений; токен выдаёт Telegram-бот. Эндпоинты ниже задокументированы автором сервиса в README расширения sillyimages.

## Контракт API

### Naistera

- Endpoint: `https://naistera.org` (default). Token comes from the Telegram bot.
- `POST /api/generate`, body: `{ prompt, negative_prompt?, model, aspect_ratio, preset?, reference_images? }`.
- Can use polling: send `sync: false`, receive `job_id`, then read
  `GET /api/generate/jobs/{job_id}` with the same Bearer token.
- Available models are loaded from `GET /api/models` using the configured token. Model names, reference support, and negative prompt support come from the API response.
- **Send character descriptions** can omit descriptions, add the regular description block, or append persona and character to the end of the prompt as `\| description` lines. Images are sent only to models that support references.
- For NovelAI models, the selected style is added as a plain prefix without the `[STYLE: ...]` wrapper.
- Can return video (`media_kind: "video"`) — the "Enable video generation" option.

Примечания по контрактам из кода расширения: POST может ответить синхронно (результат сразу) или асинхронно (`job_id`) — во втором случае идёт поллинг `GET /api/generate/jobs/{job_id}` только read-only GET-запросами; каталог моделей — `GET /api/models` с тем же Bearer-токеном.
