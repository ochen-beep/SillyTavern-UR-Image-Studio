---
source: https://ai.byteplus.com/ark/region:ap-southeast-1/docs/seedream-5-0-pro (+ .md-версия) + https://ai.byteplus.com/ark/region:ap-southeast-1/docs/ModelArk/1544106 (Pricing) + обзор ModelArk https://docs.byteplus.com/en/docs/ModelArk/
fetched: 2026-10-13
note: docs.byteplus.com (doccenter) — JS-heavy, тело страницы не отдаётся, llms.txt у BytePlus не работает (редирект на маркетинговую страницу). Рабочий канал — консольные доки ai.byteplus.com: у каждой страницы есть markdown-версия по суффиксу .md. Детальный справочник параметров «Image generation API» существует отдельной страницей (/docs/image-generation-api) — в этот файл не выгружался
---

# ByteDance Seedream — через BytePlus ModelArk (OpenAI-совместимый Images API)

Seedream — генеративные image-модели ByteDance. Международный доступ — через BytePlus ModelArk (аналог Volcengine Ark); API совместим с OpenAI Images API (`client.images.generate`), seedream-специфичные параметры передаются в `extra_body`. Важно: у BytePlus id моделей без префикса `doubao-` (это именование китайского Volcengine); здесь — `seedream-4-0-250828` и т.п.

## Эндпоинты и авторизация

- **Генерация изображения:** `POST https://ark.ap-southeast.bytepluses.com/api/v3/images/generations` (регион ap-southeast-1).
- Регион eu-west-1: база `https://ark.eu-west.bytepluses.com/api/v3` (модельный состав урезан; image-модели актуального каталога — проверять на странице Region availability).
- Auth: `Authorization: Bearer $ARK_API_KEY` (API-ключ создаётся в консоли: https://ai.byteplus.com/ark/region:ap-southeast-1/apikey).
- SDK: `arkruntime` (Python/Go/Java) либо обычный OpenAI SDK с `base_url="https://ark.ap-southeast.bytepluses.com/api/v3"`.

## Модели (Model ID)

| Model ID | Примечание |
| --- | --- |
| `dola-seedream-5-0-pro-260628` | Seedream 5.0 pro: t2i, i2i, интерактивное редактирование, разложение на слои; разреш. 1K/1.5K/2K; режимы промпт-оптимизации standard/fast |
| `dola-seedream-5-0-flash-260915` | Seedream 5.0 flash: быстрее и дешевле, standard-режим |
| `seedream-5-0-lite-260128` | Seedream 5.0 lite |
| `seedream-4-5-251128` | Seedream 4.5 |
| `seedream-4-0-250828` | Seedream 4.0 (t2i/i2i/multi-reference, sequential generation) |
| `seededit-3-0-i2i-250628` | редактирование изображения (i2i) |

## Формат запроса (пример t2i/i2i)

```bash
curl https://ark.ap-southeast.bytepluses.com/api/v3/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -d '{
    "model": "seedream-4-0-250828",
    "prompt": "красивый закат над морем, фотореализм",
    "size": "2K",
    "output_format": "png",
    "response_format": "url",
    "watermark": false
  }'
```

Параметры:
- `model` (обяз.) — Model ID из таблицы выше;
- `prompt` (string) — промпт; поддерживает координатные теги для позиционирования (интерактивное редактирование 5.0);
- `image` (string URL или массив URL) — референс(ы) для i2i/multi-reference;
- `size` — метод 1 (рекоменд.): `1K` | `1.5K` | `2K` (default `2K`; `1.5K` по цене равен `1K`), соотношение сторон модель берёт из промпта (напр. 16:9 → 2816x1584 при 2K); метод 2: явные `widthxheight`, суммарные пиксели в диапазоне [1280x720 (921600), 2048x2048x1.1025 (4624220)], aspect в [1/16, 16] (пример валидного: `2048x1024`; `512x512` — невалидно);
- `output_format` — `png` | `jpeg`;
- `background` — `transparent` (прозрачный фон, вместе с `output_format: "png"`);
- `response_format` — `url` (в примерах доков; `b64_json` — опция OpenAI-совместимого контракта);
- `watermark` (bool) — добавлять ли водяной знак AI-генерации на выход;
- `optimize_prompt_options.mode` — `standard` (default) | `fast` (только 5.0 pro);
- `layer_decomposition` (bool, 5.0) — разложить вход на базовое изображение + до 16 слоёв PNG с альфа-каналом;
- `sequential_image_generation` — серийная генерация (для 5.0 lite / 4.5 / 4.0; биллинг по фактическому числу сгенерированных изображений).

## Формат ответа

```json
{
  "model": "dola-seedream-5-0-pro-260628",
  "created": 1784696685,
  "data": [
    { "url": "https://...", "size": "2048x2048", "output_format": "jpeg" }
  ],
  "usage": { "input_images": 1, "generated_images": 1, "output_tokens": 23107, "total_tokens": 23107 }
}
```

- Изображение отдаётся ссылкой `url` — скачивание обычным GET. **URL хранится 24 часа** — файл нужно забрать сразу.
- В режиме `layer_decomposition` каждый элемент `data` дополнительно содержит `z_index` (0 — база, слои с 1), `bounding_box.absolute` / `bounding_box.normalized` (координаты [left, top, right, bottom]), `name`, `description`.

## Лимиты

- Seedream 5.0 pro / flash: **IPM 500 изображений/мин** (images per minute).
- Для остальных моделей лимиты RPM/TPM индивидуальны по аккаунту — смотри «Model activation page» в консоли; повышение — через заявку.

## Цены (USD, регион ap-southeast-1; страница Pricing, обновлена 2026-10-13)

| Model ID | Входное изображение | Выходное изображение |
| --- | --- | --- |
| dola-seedream-5-0-pro-260628 | первое бесплатно, со 2-го $0.003 | ≤2.61 Мпикс (≤1.5K): **$0.045**; >2.61 Мпикс: **$0.09** |
| dola-seedream-5-0-flash-260915 | бесплатно | **$0.018** |
| seedream-5-0-lite-260128 | бесплатно | **$0.035** |
| seedream-4-5-251128 | бесплатно | **$0.04** |
| seedream-4-0-250828 | бесплатно | **$0.03** |
| seededit-3-0-i2i-250628 | бесплатно | **$0.03** |

- Несозданные из-за модерации изображения не биллятся; `1.5K` стоит как `1K`.

## Бесплатное тестирование

- **Статус: платно, без документированного free-tier.** На странице Pricing бесплатная квота не предусмотрена для image-моделей (в отличие от embedding-модели skylark-embedding-vision, у которой есть 500K токенов free quota) — welcome-кредиты для новых аккаунтов на официальном прайс-листе не указаны (unverified).
- Биллинг постоплатный: аккаунт должен иметь положительный баланс, при нуле сервис приостанавливается через 2 часа задолженности. Регистрация и ключ — без карты, но для генерации нужно пополнение.
- Дешевая точка входа: Seedream 5.0 flash — $0.018/изображение (≈55 картинок за $1).
