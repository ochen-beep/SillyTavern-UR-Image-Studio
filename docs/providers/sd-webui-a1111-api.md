---
source: https://github.com/AUTOMATIC1111/stable-diffusion-webui/wiki/API (+ исходники modules/api/models.py и modules/processing.py, wiki Command-Line-Arguments-and-Settings)
fetched: 2026-10-13
note: wiki-страница API официально помечена как устаревшая (2023) — актуальная схема всегда живая на /docs инстанса. Схема payload ниже собрана из официального кода (models.py генерирует Pydantic-модели из сигнатур processing.py, значения по умолчанию оттуда же). README Forge/reForge/SD.Next не заявляют совместимость с /sdapi/v1 явно — см. раздел «Совместимость».
---

# Stable Diffusion WebUI (A1111) — локальный HTTP API

Локальный REST API интерфейса AUTOMATIC1111 (и форков: Forge, reForge, SD.Next). Работает на FastAPI/uvicorn; контракты `/sdapi/v1/*` у форков те же (с оговорками). Браузерный OpenAPI-спек всегда доступен на живом инстансе: `http://127.0.0.1:7860/docs` — это канонический и всегда актуальный источник схемы.

## Запуск и флаги

| Флаг | По умолчанию | Описание |
|---|---|---|
| `--api` | выкл. | Запустить WebUI вместе с API. |
| `--nowebui` | выкл. | Запустить только API без UI. |
| `--api-auth` | нет | Basic-аутентификация API в формате `username:password`; несколько пар через запятую (`u1:p1,u2:p2`). |
| `--api-log` | выкл. | Логировать все API-запросы. |
| `--api-server-stop` | выкл. | Разрешить остановку/перезапуск сервера через API. |
| `--cors-allow-origins` | нет | Список разрешённых CORS-origins через запятую (без пробелов). |
| `--cors-allow-origins-regex` | нет | Разрешённые origins одним регулярным выражением. |
| `--port` | 7860 | Порт сервера. |
| `--listen` | выкл. | Слушать 0.0.0.0 (доступ с других машин). |

## Аутентификация и CORS

- Без `--api-auth` API открыт без аутентификации (рассчитан на localhost).
- С `--api-auth` запросы требуют HTTP Basic (`Authorization: Basic base64(user:pass)`).
- Для запросов к API из браузера (например, из расширения) нужен `--cors-allow-origins` с origin страницы, иначе preflight/ответы будут блокированы.

## Основные эндпоинты

- `POST /sdapi/v1/txt2img` — text-to-image.
- `POST /sdapi/v1/img2img` — image-to-image (и inpainting через `mask`/`inpaint_*`).
- `GET /sdapi/v1/progress` — прогресс текущей генерации (`progress`, `eta_relative`, `state`, `current_image` и др.).
- `GET /sdapi/v1/options` и `POST /sdapi/v1/options` — чтение/постоянное изменение настроек (в отличие от `override_settings`, который действует на один запрос).
- `GET /sdapi/v1/samplers` — список сэмплеров (имена для `sampler_name`).
- `GET /sdapi/v1/sd-models` — список чекпоинтов (`title`/`model_name`/`filename`/`hash`).
- `POST /sdapi/v1/refresh-checkpoints` — рескан папки моделей.
- `GET /sdapi/v1/prompt-styles`, `GET /sdapi/v1/scripts`, `POST /sdapi/v1/interrupt` и др. — см. `/docs`.

## Формат запроса txt2img

JSON; можно передавать любое подмножество полей — отсутствующие берут дефолты. Полный список ключей (из Pydantic-модели `StableDiffusionTxt2ImgProcessingAPI`, генерируемой из `StableDiffusionProcessingTxt2Img`; типы Optional, всё nullable):

Базовые (общие с img2img):

| Ключ | Тип | Дефолт |
|---|---|---|
| `prompt` | str | `""` |
| `negative_prompt` | str | `""` |
| `styles` | list[str] | `[]` |
| `seed` | int | `-1` (случайный) |
| `subseed` | int | `-1` |
| `subseed_strength` | float | `0` |
| `seed_resize_from_h` / `seed_resize_from_w` | int | `-1` |
| `sampler_name` | str | из UI (устаревший алиас `sampler_index`) |
| `scheduler` | str | `null` (Automatic) |
| `batch_size` | int | `1` |
| `n_iter` | int | `1` |
| `steps` | int | `50` |
| `cfg_scale` | float | `7.0` |
| `width` / `height` | int | `512` |
| `restore_faces` | bool | `null` (из настроек) |
| `tiling` | bool | `null` |
| `eta` | float | `null` |
| `denoising_strength` | float | `null` (для txt2img игнорируется без hires) |
| `s_min_uncond`, `s_churn`, `s_tmax`, `s_tmin`, `s_noise` | float | `null` |
| `override_settings` | dict | `{}` |
| `override_settings_restore_afterwards` | bool | `true` |
| `refiner_checkpoint` | str | `null` |
| `refiner_switch_at` | float | `null` |
| `token_merging_ratio`, `token_merging_ratio_hr` | float | `0` |
| `disable_extra_networks` | bool | `false` |
| `firstpass_image` | str (base64) | `null` |

Hires fix (только txt2img):

| Ключ | Тип | Дефолт |
|---|---|---|
| `enable_hr` | bool | `false` |
| `firstphase_width` / `firstphase_height` | int | `0` |
| `hr_scale` | float | `2.0` |
| `hr_upscaler` | str | `null` (из настроек) |
| `hr_second_pass_steps` | int | `0` |
| `hr_resize_x` / `hr_resize_y` | int | `0` |
| `hr_checkpoint_name` | str | `null` |
| `hr_sampler_name` | str | `null` |
| `hr_scheduler` | str | `null` |
| `hr_prompt` / `hr_negative_prompt` | str | `""` |

Служебные (оба эндпоинта):

| Ключ | Тип | Дефолт | Смысл |
|---|---|---|---|
| `sampler_index` | str | `"Euler"` | Устаревшее имя поля сэмплера; поддерживается для совместимости. |
| `script_name` | str | `null` | Имя скрипта (вкладка Scripts в UI). |
| `script_args` | list | `[]` | Позиционные аргументы скрипта (зависят от версии). |
| `send_images` | bool | `true` | Возвращать изображения в ответе. |
| `save_images` | bool | `false` | Сохранять в outputs. |
| `alwayson_scripts` | dict | `{}` | Аргументы always-on расширений (см. ниже). |
| `force_task_id` | str | `null` | Явный id задачи. |
| `infotext` | str | `null` | Восстановить параметры из infotext-строки. |

`override_settings` перекрывает настройки на один запрос, например `{"sd_model_checkpoint": "Anything-V3.0-pruned", "CLIP_stop_at_last_layers": 2}`; для `sd_model_checkpoint` допустимо UI-имя, имя файла (с/без расширения) или хеш.

`alwayson_scripts` — механизм вызова расширений: `{"alwayson_scripts": {"<ИмяСкрипта>": {"args": [...]}}}`. Например, ADetailer вызывается так с позиционным списком `args` (состав и порядок аргументов зависят от версии расширения — сверяться с его доками; это не часть контракта самого WebUI).

## Формат запроса img2img — отличия

| Ключ | Тип | Дефолт |
|---|---|---|
| `init_images` | list[str] (base64) | обязательны |
| `resize_mode` | int | `0` (0=Just resize, 1=Crop and resize, 2=Resize and fill, 3=Just resize (latent)) |
| `denoising_strength` | float | `0.75` |
| `image_cfg_scale` | float | `null` |
| `mask` | str (base64) | `null` — маска inpaint (белое = перерисовать) |
| `mask_blur_x` / `mask_blur_y` | int | `4` (устаревший `mask_blur` — сеттер, не отдельное поле) |
| `mask_round` | bool | `true` |
| `inpainting_fill` | int | `0` |
| `inpaint_full_res` | bool | `true` |
| `inpaint_full_res_padding` | int | `0` |
| `inpainting_mask_invert` | int | `0` |
| `initial_noise_multiplier` | float | `null` |
| `latent_mask` | str (base64) | `null` |
| `include_init_images` | bool | `false` (не возвращается в ответе) |

## Формат ответа

```json
{
  "images": ["<base64 PNG, по одному на картинку>"],
  "parameters": { "...эхо части запроса..." },
  "info": "{ \"строка-JSON\": с полной infotext-информацией генерации }"
}
```

`images` пуст, если `send_images: false`. Декодирование: `base64.b64decode(images[0])` → PNG.

## Замечания

- Вики-гайд по API (2023) официально помечен как неактуальный; полное и актуальное описание схемы каждого эндпоинта — интерактивно на `http://127.0.0.1:7860/docs` (Swagger UI живого инстанса).
- Скрипты (`script_name`/`script_args`) и `alwayson_scripts` принимают позиционные аргументы, состав которых меняется между версиями WebUI и расширений.

## Совместимость форков

- **Forge (lllyasviel/stable-diffusion-webui-forge)** — базируется на SD-WebUI 1.10.1; в статус-таблице README: «API endpoints (txt2img, img2img, etc) — Normal, but pending improved Flux support», т.е. контракт `/sdapi/v1` сохранён, но поддержка Flux через API неполная.
- **reForge (Panchovix/stable-diffusion-webui-reForge)** — форк Forge/A1111; README не заявляет совместимость API явно (внутренние переработки, часть CMD-флагов удалена). Контракт `/sdapi/v1` ожидается прежним — unverified.
- **SD.Next (vladmandic/automatic)** — развитие кодовой базы A1111; README не делает явных заявлений о `/sdapi/v1` (проект также продвигает собственный API). Частичная совместимость — unverified.
- **Draw Things (macOS/iOS)** — официальные README/community-репозитории описывают только gRPC-сервер (gRPCServerCLI, порт 7859) и CLI (`draw-things-cli`); эмуляция `/sdapi/v1` в официальной документации не упомянута — слухи об A1111-совместимости считать unverified.
