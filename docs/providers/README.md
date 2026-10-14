# Документация провайдеров (скачано из сети 2026-10-01)

Официальная документация по API провайдеров, с которыми работает UR Image Studio.
Один файл = один провайдер (или грань провайдера). В шапке каждого файла — точный
`source:` и дата скачивания.

## Провайдеры расширения → файлы

| Контракт расширения | Файлы здесь |
|---|---|
| `openai-images` | `openai-images-api.md` |
| `gemini-native` | `gemini-image-generation.md`, `gemini-imagen.md` |
| `chat-completions` | `openai-chat-completions-api.md` |
| `openrouter-images` | `openrouter-image-generation-guide.md`, `openrouter-images-api.md`, `openrouter-images-models-api.md`, `openrouter-images-endpoints-api.md` |
| `pollinations-images` | `pollinations-api.md`, `pollinations-openapi.json` |
| `naistera` | `naistera-api.md` |
| `comfyui` | `comfyui-local-api.md`, `comfyui-readme.md` |
| `cloudflare-workers-ai` | `cloudflare-workers-ai.md` |

## Кандидаты из плана 2026-10-13 (доки скачаны, реализация — по плану
[../research/2026-10-13-new-image-providers-plan.md](../research/2026-10-13-new-image-providers-plan.md))

| Провайдер | Файлы здесь |
|---|---|
| A1111/Forge/SD.Next (SD WebUI API) | `sd-webui-a1111-api.md` |
| Stability Platform v2beta | `stability-platform-api.md` |
| BFL FLUX | `bfl-flux-api.md` |
| fal.ai | `fal-ai-api.md` |
| Replicate | `replicate-api.md` |
| BytePlus Seedream | `seedream-byteplus.md` |
| HuggingFace Inference | `huggingface-inference.md` (free закрыт, проверено вживую 2026-10-13 — 402) |

## Описания файлов

- **openai-images-api.md** — Images API (`/v1/images/generations`, `/images/edits`,
  `/images/variations`) вербатим из официальной OpenAPI-спеки OpenAI
  (`openai/openai-openapi`) — это первоисточник справки
  platform.openai.com/docs/api-reference/images. Покрывает `gpt-image-*` и `dall-e-*`
  (запросные схемы, размеры, стриминг-события).
- **openai-chat-completions-api.md** — `/v1/chat/completions` из того же спека
  (все параметры запроса, формы ответа, content-part типы). Адаптер
  `chat-completions` достаёт картинки из ответов чата (см. `src/providers/image-chat-completions.js`).
- **gemini-image-generation.md** — полная страница «Nano Banana image generation»
  (ai.google.dev): модели, text-to-image, редактирование, multi-turn, aspect ratio,
  разрешения до 4K, лимиты; внутри есть раздел про стратегии промптов.
- **gemini-imagen.md** — страница Imagen: модель отключена, рекомендация миграции на
  Nano Banana (файл короткий, т.к. сам источник такой).
- **openrouter-*.md** — гайд по мульти-модальной генерации картинок + API-референс
  `POST /api/v1/images/generations`, список image-моделей и эндпоинтов.
  ⚠️ `openrouter-images-api.md` обрезан (~28k символов, лимит сервиса чтения):
  не хватает хвоста схем стриминг-событий; запросная часть POST /images сохранена.
  openrouter.ai закрыт Cloudflare (curl, PowerShell, WebFetch и in-app браузер — 403),
  архивной копии нет; для полной копии открыть `.md`-URL в обычном браузере.
- **pollinations-api.md** — APIDOCS.md из репозитория Pollinations: image-эндпоинт
  `image.pollinations.ai/prompt/{prompt}` со всеми параметрами, текст/audio API,
  аутентификация и rate limits.
- **pollinations-openapi.json** — OpenAPI-спецификация `gen.pollinations.ai`
  (OpenAI-совместимый `POST /v1/images/generations` и каталог `/image/models`) —
  именно этот эндпоинт использует адаптер расширения.
- **naistera-api.md** — контракт сервиса из README расширения sillyimages автора
  сервиса (единственная публичная документация): `POST /api/generate`, поллинг
  `GET /api/generate/jobs/{job_id}`, каталог `GET /api/models`. Полную реализацию
  см. `src/providers/image-naistera.js` и `src/provider-descriptors.js`.
- **comfyui-local-api.md** — официальные примеры `script_examples/` из репозитория
  ComfyUI: `POST /prompt` → `GET /history/{id}` → `GET /view`, websocket-вариант.
- **comfyui-readme.md** — README ComfyUI (установка, запуск сервера, аргументы).
- **cloudflare-workers-ai.md** — Cloudflare Workers AI REST: `POST /client/v4/accounts/{id}/ai/run/{model}`,
  каталог `/ai/models/search`, биллинг в Neurons (10 000/день бесплатно).
  Включает раздел «Проверено вживую (2026-10-13)»: у SDXL-моделей Content-Type
  врёт (заявлен png, байты JPEG — MIME по магическим байтам), flux-2-klein
  требует multipart (из браузера недоступен), sdxl-base-1.0 сломан (408),
  CORS закрыт (трафик идёт через ST-прокси).

## Ограничения окружения при скачивании

- `ai.google.dev`, `platform.openai.com`, `learn.microsoft.com` из этой сети напрямую
  недоступны — Gemini-доки и гайд OpenAI получены через сервис web-reader.
- `platform.openai.com/docs/api-reference/*` через web-reader не рендерится (SPA) —
  поэтому OpenAI-референсы взяты из OpenAPI-спеки (эквивалентный первоисточник).
- `openrouter.ai` — Cloudflare 403 на все каналы, кроме web-reader; у одного файла
  отмечен усечённый хвост (см. выше).
- `platform.stability.ai` — SPA; использованы архивная копия SPA-бандла и архивный
  OpenAPI-спек api.stability.ai (файлы лежат в `../prompting/`).
