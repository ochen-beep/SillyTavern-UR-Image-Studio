# UR Image Studio: поддержка Pollinations.ai и Agnes AI

## Status

Design — pending implementation plan.

## Goal

Добавить в UR Image Studio два полноценных image-провайдера:

- **Pollinations.ai** — нативный GET-эндпоинт, бесплатный tier с watermark, опциональный ключ.
- **Agnes AI** — OpenAI-совместимый endpoint, который не принимает top-level `response_format`.

Провайдеры должны быть изолированы друг от друга, не плодить костылей в общем `openai.js` и поддерживать механизм `providerOptions` для будущих расширений.

## Context

Текущая архитектура URIS v2:

- `src/image-api.js` — диспетчер, выбирает провайдер по `apiType` коннекта.
- `src/providers/openai.js` — OpenAI-like image/text.
- `src/providers/gemini.js`, `comfyui.js`, `a1111.js` — остальные провайдеры.
- `src/core.js` — `VALID_API_TYPES = ['auto', 'openai', 'gemini']`.
- `src/ui/tab-api.js` — UI image-коннектов.
- `src/connections.js` — CRUD коннектов, отдельное хранение API-ключа.

Из лога пользователя видна конкретная ошибка Agnes:

```
UnsupportedParamsError: Setting `response_format` is not supported by openai, agnes-t2i-general-model.
To drop it from the call, set `litellm.drop_params = True`
```

Agnes требует либо `return_base64: true`, либо `extra_body.response_format`, и падает на top-level `response_format`.

Pollinations.ai имеет собственный простой GET-эндпоинт `https://image.pollinations.ai/prompt/{prompt}` с параметрами `width`, `height`, `model`, `seed`, `nologo`, `enhance` и т.д., а также OpenAI-совместимый POST `/v1/images/generations`.

## Decision: отдельные провайдеры + универсальные providerOptions

Выбран вариант B: каждый сервис — отдельный модуль-провайдер. В `ImageProfile` и объекте коннекта добавляется поле `providerOptions: object`, в котором хранятся настройки, специфичные для провайдера. Это позволяет в будущем добавлять новые параметры (img2img, seed, safety и т.д.) без изменения общей схемы коннекта.

## Architecture

```
┌─────────────────┐
│  src/image-api  │──switch(apiType)──┬──► providers/openai.js
│   (dispatcher)  │                   ├──► providers/gemini.js
└─────────────────┘                   ├──► providers/agnes.js       (NEW)
                                      └──► providers/pollinations.js (NEW)
```

### Новые файлы

- `src/providers/pollinations.js`
- `src/providers/agnes.js`
- `tests/providers.test.js`

### Изменённые файлы

- `src/core.js` — `VALID_API_TYPES`, `resolveApiType`.
- `src/providers/base.js` — `ImageProfile` typedef + `providerOptions`.
- `src/image-api.js` — импорт и dispatch новых провайдеров.
- `src/connections.js` — поле `providerOptions` в create/save connection.
- `src/ui/tab-api.js` — dropdown apiType + рендер provider-specific полей.

## Provider: Pollinations.ai

### Endpoint

`GET https://image.pollinations.ai/prompt/{urlEncodedPrompt}`

Промпт кодируется через `encodeURIComponent`. Стиль и prompt объединяются через `composePrompt(style, prompt)`.

### Query parameters

| Param      | Source                                                   | Default         |
|------------|----------------------------------------------------------|-----------------|
| `width`    | parse size string (`1024x1024` → 1024)                 | 1024            |
| `height`   | parse size string                                        | 1024            |
| `model`    | `providerOptions.model` → `p.model`                      | `flux`          |
| `nologo`   | `providerOptions.noLogo`                                 | `true`          |
| `enhance`  | `providerOptions.enhance`                                | `false`         |
| `seed`     | `providerOptions.seed` (future)                          | —               |
| `private`  | `providerOptions.private` (future)                       | —               |

### Size mapping

Переиспользуется маппинг аспектов/размеров из `openai.js` (`ASPECT_SIZE_MAP`). Размер вида `WxH` парсится в `width` и `height`.

### Authentication

Если `apiKey` задан — передаётся заголовком `Authorization: Bearer {apiKey}`. Для бесплатного GET вызова ключ не обязателен.

### Response handling

Ответ — binary blob. Конвертируется в dataUrl через `FileReader.readAsDataURL` (аналогично `urlToDataUrl` в `openai.js`).

### References

В первой итерации не поддерживаются. Если `refs.length > 0` — лог warning, как в `openai.js`.

## Provider: Agnes AI

### Endpoint

`POST {normalizeEndpoint(endpoint)}/v1/images/generations`

### Request body

```json
{
  "model": "agnes-image-2.1-flash",
  "prompt": "composed prompt + style",
  "size": "1024x1024",
  "return_base64": true
}
```

### Key constraints

- **Не отправлять** top-level `response_format`.
- `return_base64: true` вместо `response_format: 'b64_json'`.
- `size` — из `ASPECT_SIZE_MAP[instruction.aspectRatio]` → `p.size` → `'1024x1024'`.

### Authentication

`Authorization: Bearer {apiKey}`.

### Response handling

Ожидаем `data[0].b64_json`. Если пришёл `url` — подгружаем через `urlToDataUrl`.

### References

В первой итерации не поддерживаются (warning).

### Timeout

Оставляем стандартный `fetchWithTimeout` 120s. В будущем можно увеличить через `state.settings.generationTimeout`.

## Data model changes

### ImageProfile typedef (`src/providers/base.js`)

```js
/**
 * @typedef {Object} ImageProfile
 * @property {string} provider
 * @property {string} endpoint
 * @property {string} [apiKey]
 * @property {string} model
 * @property {string} [size]
 * @property {string} [quality]
 * @property {string} [aspectRatio]
 * @property {string} [imageSize]
 * @property {Object} [providerOptions] — provider-specific settings
 */
```

### Connection object (`src/connections.js`)

```js
{
  id,
  kind: 'image',
  name,
  apiType,              // 'pollinations' | 'agnes' | ...
  endpoint,
  model,
  providerOptions: {},  // NEW
  availableModels: [],
  lastFetch: 0,
  secretId: ''
}
```

`providerOptions` сохраняется в `localforage` вместе с метаданными коннекта, но никогда не содержит API-ключ.

### Передача в диспетчер (`src/image-api.js`)

При сборке `profile` добавляем:

```js
const profile = {
    provider: apiType === 'gemini' ? 'gemini' : 'openai-like',
    endpoint: conn.endpoint,
    apiKey,
    model: conn.model,
    size: imageParam?.size,
    quality: imageParam?.quality,
    aspectRatio: imageParam?.aspectRatio,
    imageSize: imageParam?.imageSize,
    styleTemplate: imageParam?.styleTemplate,
    providerOptions: conn.providerOptions || {},  // NEW
};
```

## UI changes (`src/ui/tab-api.js`)

### Dropdown apiType

Добавить пункты:

```html
<option value="pollinations">Pollinations.ai</option>
<option value="agnes">Agnes AI</option>
```

### Provider-specific fields

При `apiType === 'pollinations'` показывать:

- Модель (input + datalist): `flux`, `turbo`, `gptimage`, `kontext`, `seedream`, `nanobanana`, `nanobanana-pro`.
- Чекбокс «Без watermark (nologo)`.
- Чекбокс «Улучшать промпт (enhance)`.

При `apiType === 'agnes'` дополнительных полей нет.

### Collect

`collectConnCard` должен возвращать `providerOptions` в зависимости от текущего `apiType`.

## Auto-detection (`src/core.js`)

```js
export function resolveApiType(endpoint, model) {
    const ep = String(endpoint || '').toLowerCase();
    if (/pollinations\.ai/.test(ep)) return 'pollinations';
    if (/agnes-ai\.com/.test(ep)) return 'agnes';
    if (/generativelanguage\.googleapis\.com/.test(ep)) return 'gemini';
    if (/\/v1beta\b/.test(ep)) return 'gemini';
    const m = String(model || '').toLowerCase();
    if (/^(gemini|imagen)/.test(m)) return 'gemini';
    return 'openai';
}
```

## Error handling

- Нет endpoint → стандартная проверка в `image-api.js`.
- Нет API-ключа у Agnes → стандартная проверка в `image-api.js`.
- Pollinations работает без ключа (free tier): в `image-api.js` проверка `if (!apiKey)` пропускается для `apiType === 'pollinations'`.
- HTTP 400 от Agnes/Pollinations → пробрасываем текст ошибки пользователю.
- Сетевые ошибки → оборачиваем в "Image API недоступен".

## Testing

Новый файл `tests/providers.test.js`:

1. Мок `global.fetch` и `FileReader`.
2. `pollinations.generateImage` строит правильный URL с `width`, `height`, `model`, `nologo`.
3. `pollinations.generateImage` возвращает dataUrl из binary blob.
4. `agnes.generateImage` шлёт JSON body без `response_format` и с `return_base64: true`.
5. `agnes.generateImage` парсит `b64_json` в dataUrl.
6. `resolveApiType` корректно определяет `pollinations` и `agnes` по URL.

## Out of scope (следующая итерация)

- Image-to-image для Pollinations (`kontext` через `image=`) и Agnes (`image[]`).
- `seed`, `private`, `safe` для Pollinations (заложены в `providerOptions`, но UI не рисуется).
- Автоподгрузка списка моделей Pollinations/Agnes через `fetchModels`.
- Поддержка OpenAI-совместимого POST Pollinations (`/v1/images/generations`) — нативный GET проще и не требует base64.

## References

- Pollinations.ai docs: https://github.com/pollinations/pollinations/blob/main/APIDOCS.md
- Agnes AI docs: https://wiki.agnes-ai.com/en/docs/agnes-image-21-flash
