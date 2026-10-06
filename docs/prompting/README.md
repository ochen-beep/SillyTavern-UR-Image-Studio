# Документация по промптингу визуальных моделей (скачано из сети 2026-10-01)

Официальные руководства по написанию промптов для image-моделей, доступных через
провайдеров расширения (gpt-image / DALL·E, Gemini Nano Banana, FLUX, Stable Diffusion,
SD3, Qwen-Image). В шапке каждого файла — точный `source:` и дата скачивания.

## Файлы

- **openai-image-prompting.md** — гайд «Image generation» с platform.openai.com:
  Image API vs Responses API, сравнение `gpt-image-1.5` / `gpt-image-1` /
  `gpt-image-1-mini` / DALL·E, редактирование с референсами и масками, input fidelity,
  размер/качество/формат, лимиты и цены. Отдельного раздела «как писать промпты» в
  актуальном гайде нет — он дополнен cookbook-статьёй ниже.
- **openai-cookbook-dalle3-prompting.md** — статья OpenAI Cookbook «What's new with
  DALL·E 3»: как работает prompt rewriting и как формулировать промпты для DALL·E 3
  (вербатим из `openai/openai-cookbook`, файл `.mdx`).
- **gemini-image-prompting.md** — официальный гайд Google «How to prompt Gemini 2.5
  Flash Image (nano banana) for the best results»: «describe the scene, don't just
  list keywords», шаблоны для фотореализма, стикеров, текста в изображении,
  продакт-фото, редактирования/inpainting/style transfer, best practices и ограничения.
- **flux-image-prompting-guide.md** — собрано из 8 официальных страниц
  docs.bfl.ml (Black Forest Labs): основы промптинга, построение промпта, стиль и
  текст в изображениях, технические параметры (пропорции, отказ от negative prompt),
  шпаргалка (камера/свет/стили), редактирование с референсами (FLUX.2), JSON-промпты.
  Применимо к FLUX-моделям через OpenRouter, Pollinations и ComfyUI.
- **qwen-image-2.1-prompting.md** — Qwen-Image-2.1 (Qwen/Alibaba, релиз 2026-09-20):
  единая модель t2i + edit. Форматы промптов из официального README и модельной
  карточки (нативный RGBA-шаблон, референсы `<image1>`…`<image10>`), настройки
  сэмплера и поведение negative prompt (cfg 1 — не работает) из официального гайда
  ComfyUI, плюс вербатим оба официальных системных промпта рерайтеров (T2I и Edit)
  — фактическая методичка команды Qwen «как выглядит хороший промпт» (естественный
  язык, никаких quality-бустеров, ~400–500 слов для t2i).
- **stable-diffusion-prompting.md** — официальная документация Stability AI:
  multi-prompting, веса промптов `(...:1.5)` и negative prompting (диапазон [-10,10],
  лимит 77 токенов), CFG Scale по семействам (v1: 7–14, v2: 4–8, SDXL: 4–12), шаги,
  сэмплеры, seed; SDXL-заметки («короче промпт → описательнее картинка») и примеры.
- **stable-image-api-parameters.md** — параметры Stable Image API из официального
  OpenAPI-спека (`api.stability.ai/v2alpha/openapi`): prompt с синтаксисом весов,
  negative_prompt, aspect_ratio, cfg_scale (дефолты Large/Medium=4, Turbo/Flash=1),
  seed, 17 style_preset, output_format, image/strength — для `generate/ultra`,
  `generate/core`, `generate/sd3`. Релевантно для SD-моделей в ComfyUI и Pollinations.

## Куда смотреть по остальным моделям

- Nano Banana (Gemini): раздел «Prompting guide and strategies» внутри
  `../providers/gemini-image-generation.md`.
- Seedream и прочие модели через OpenRouter: ориентируйтесь на FLUX-разделы
  (естественный язык, без weight-синтаксиса) — большинство современных моделей
  (FLUX, Seedream, Nano Banana) предпочитают описательные промпты, а не keyword-теги.
- Keyword-синтаксис с весами остаётся актуальным в основном для SD1.5/SDXL в ComfyUI.
