# UR Image Studio — Интеграция reference images (референсов)

> Дата: 2026-07-10
> Контекст: расширение UR Image Studio v2 (`D:\VC CODE\UR Image Studio`)
> Цель: реализовать корректную, масштабируемую отправку референсных изображений в image-generation провайдеры.
> Статус: спецификация для реализации

---

## 1. Контекст и постановка задачи

В UR Image Studio v2 референсы уже являются самостоятельным блоком workflow (spec §4.2), но на практике:

- Только **Gemini** действительно отправляет референсы (`inlineData` parts).
- **OpenAI**-провайдер игнорирует референсы, потому что стандартный `/v1/images/generations` не принимает изображения.
- **Pollinations** и **Agnes** — text-to-image only.
- Нет NPC-референсов, нет сжатия, нет детального логирования.

Задача — сделать отправку референсов **корректной, проверяемой и масштабируемой**:

1. Поддержать OpenAI `gpt-image-*` через официальный `/v1/images/edits` с `FormData`.
2. Поддержать OpenAI-совместимые multimodal chat endpoints как fallback.
3. Сохранить и улучшить Gemini `inlineData`.
4. Добавить NPC-референсы с keyword-мэтчингом.
5. Добавить сжатие и загрузку референсов на сервер ST.
6. Добавить подробное логирование для ручного тестирования.
7. Сделать архитектуру расширяемой для новых провайдеров.

---

## 2. Что исследовано

### 2.1 Форк `UR Image StudioФОРК`

- ✅ Уже реализован `POST /v1/images/edits` с `FormData` и полем `image[]` для `gpt-image-*`.
- ✅ Реализованы NPC-референсы с keyword-мэтчингом.
- ✅ Есть `dataUrlToFile`, `dataUrlToBase64`, `dataUrlMimeType`, `imageToDataUrl`.
- ⚠️ Нет Pollinations/Agnes, другая структура промпт-пайплайна.

### 2.2 `notsosillynotsoimages` / `SLAYimages`

- ✅ NPC-референсы с word-boundary мэтчингом (SLAY).
- ✅ Сжатие 768px JPEG 0.8.
- ✅ Загрузка референсов на сервер ST.
- ❌ `notsosillynotsoimages` отправляет `body.image` в `/v1/images/generations` — нестандартно, не работает с реальным OpenAI.
- ❌ SLAY использует multimodal `chat.completions` с `image_url` — хорошо для gpt-4o-like, но не заменяет `images/edits`.
- ❌ Оба расширения монолитные (3k–6k строк в `index.js`).

### 2.3 Документация провайдеров

| Провайдер | Референсы | Способ | Лимиты |
|-----------|-----------|--------|--------|
| **OpenAI `gpt-image-*`** | ✅ | `POST /v1/images/edits`, `multipart/form-data`, поле `image[]` (или `image` для одного), `input_fidelity: 'high'`, `quality: 'low'\|'medium'\|'high'` | до 16 изображений, до 50 MB каждое, PNG/WebP/JPG |
| **OpenAI DALL-E** | ❌ | только `/v1/images/generations` | — |
| **OpenAI multimodal chat** | ✅ | `POST /v1/chat/completions`, `image_url` parts в messages | зависит от модели |
| **Gemini** | ✅ | `generateContent` с `inlineData` parts + `responseModalities: ['TEXT','IMAGE']` | до 4 (legacy) / до 14 (Gemini 3) |
| **Pollinations `kontext`** | ⚠️ | GET `/prompt/{prompt}?image={URL}` — требует публично доступный URL | 1 |
| **Agnes** | ❓ | OpenAI-совместимый, image-to-image не задокументирован | — |
| **ComfyUI / A1111** | ✅ | IPAdapter, InstantID, ControlNet через workflow JSON | зависит от workflow |

---

## 3. Принципы дизайна

1. **Провайдер сам решает, как отправлять референсы.** Диспетчер только готовит общий формат `[{ image: dataUrl, role, name }]`.
2. **Единая подготовка референсов:** сжатие, лимитирование, логирование — в одном месте.
3. **Capability registry.** Каждый провайдер декларирует: поддерживает ли референсы, максимальное количество, стратегию.
4. **Smart-режим.** Помимо `always`/`never` — `smart`, который отправляет референсы только для персонажей, упомянутых в промпте/чате.
5. **Логирование всего.** Размеры до/после сжатия, mime, endpoint, количество parts — всё видно в консоли.
6. **Upload → URL.** Для провайдеров, которым нужен URL (Pollinations), референс загружается на сервер ST и передаётся ссылкой.
7. **Минимальные breaking changes.** Существующие профили референсов без NPC и без `smart` продолжают работать.

---

## 4. Модель данных

### 4.1 Расширенный профиль референсов

```js
{
  id: string,
  name: string,
  mode: 'never' | 'always' | 'smart',   // новое: 'smart'
  charAvatar: boolean,
  userAvatarFile: string,
  npcReferences: [                       // новое
    {
      id: string,
      name: string,                      // имя NPC
      keywords: string[],                // альтернативные имена/алиасы
      imagePath: string,                 // путь на сервере ST
      enabled: boolean
    }
  ]
}
```

Хранение: `uris_references_profiles` в localforage (как и раньше).

### 4.2 Внутренний формат референса

```js
{
  image: string,    // data URL
  role: 'char' | 'user' | 'npc',
  name: string      // имя персонажа (для инструкций и smart-мэтчинга)
}
```

### 4.3 Capability registry

```js
// src/providers/base.js
export const REF_CAPABILITIES = {
  'openai-like': {
    strategies: ['formDataEdits', 'multimodalChat'],
    supportsStrategy: (strategy, model) => {
      if (strategy === 'formDataEdits') return /gpt-image/i.test(model);
      if (strategy === 'multimodalChat') return /gpt-4o|o1|o3/i.test(model); // опционально
      return false;
    },
    maxRefs: { formDataEdits: 16, multimodalChat: 8 },
  },
  gemini: {
    strategies: ['inlineData'],
    supportsStrategy: () => true,
    maxRefs: { inlineData: 4 },
  },
  pollinations: {
    strategies: ['urlParam'],
    supportsStrategy: (strategy, model) => strategy === 'urlParam' && model === 'kontext',
    maxRefs: { urlParam: 1 },
  },
  agnes: {
    strategies: ['none'],
    supportsStrategy: () => false,
    maxRefs: { none: 0 },
  },
  comfyui: {
    strategies: ['workflow'],
    supportsStrategy: () => false, // пока заглушка
    maxRefs: { workflow: 0 },
  },
  a1111: {
    strategies: ['workflow'],
    supportsStrategy: () => false, // пока заглушка
    maxRefs: { workflow: 0 },
  },
};
```

---

## 5. Утилиты референсов (`src/references.js`)

### 5.1 Сжатие изображения

```js
export async function compressDataUrl(dataUrl, {
    maxWidth = 768,
    maxHeight = 768,
    quality = 0.85,
    preferWebP = true,
} = {})
```

- Загружает data URL в `Image`.
- Масштабирует с сохранением пропорций до `maxWidth`/`maxHeight`.
- Пробует `image/webp`; если не поддерживается — `image/jpeg`.
- Сохраняет PNG только если исходник PNG с прозрачностью и запрошено.
- Возвращает `{ dataUrl, width, height, format, originalBytes, compressedBytes }`.

### 5.2 Конвертация data URL

```js
export function dataUrlToBase64(dataUrl)
export function dataUrlMimeType(dataUrl)
export async function dataUrlToFile(dataUrl, filename)
export async function dataUrlToBlob(dataUrl)
```

### 5.3 Загрузка референса на сервер ST

```js
export async function uploadReferenceImage(dataUrl, filename, subfolder = 'URIS_Refs')
```

- POST `/api/images/upload` с `{ image, format, ch_name: 'URIS_Refs', filename }`.
- Возвращает серверный путь, например `/user/images/URIS_Refs/npc_abc.png`.

### 5.4 Загрузка аватаров

Существующие функции остаются:
- `getCharacterAvatarDataUrl()`
- `getUserAvatarDataUrl(file)`
- `fetchUserAvatars()`

### 5.5 Логирование метаданных

```js
export function logRefsMeta(refs, label = 'refs')
```

Выводит `console.table` с:
- `role`, `name`, `originalBytes`, `compressedBytes`, `format`, `dimensions`.

---

## 6. Профили референсов (`src/references-profiles.js`)

### 6.1 CRUD NPC

```js
export async function addNpcReference(profileId, { name, keywords, imagePath })
export async function updateNpcReference(profileId, npcId, patch)
export async function removeNpcReference(profileId, npcId)
```

### 6.2 Сбор референсов

```js
export async function collectReferencesFromProfile(profile, context = {})
```

Где `context = { chatText, instructionText, charName, userName }`.

Логика:

1. Если `mode === 'never'` → `[]`.
2. Если `mode === 'smart'`:
   - `charAvatar` собирается только если `charName` упомянут в `chatText + instructionText`.
   - `userAvatarFile` собирается только если `userName` упомянут.
   - NPC собираются только если `name` или `keywords` найдены в тексте.
3. Если `mode === 'always'`:
   - Собираются все включённые char/user/NPC.
4. Применяется `MAX_REFS_TOTAL = 4` по умолчанию (может быть переопределено провайдером).
5. Приоритет: `char` → `user` → NPC (в порядке слотов).

### 6.3 Keyword matching

```js
export function isNameInText(name, text)
```

- Токенизация по пробелам/запятым/`|`, фильтр `length >= 2`.
- Word-boundary через Unicode `(?<!\p{L}\p{N})...(?![\p{L}\p{N}])`.
- Case-insensitive.
- Регулярное выражение экранируется.

### 6.4 Активный профиль

```js
export async function collectReferencesFromActiveProfile(context = {})
```

---

## 7. Диспетчер (`src/image-api.js`)

### 7.1 Подготовка референсов

```js
async function prepareReferences(refs, provider, model) {
    const cap = REF_CAPABILITIES[provider];
    const strategy = resolveStrategy(cap, model); // formDataEdits | inlineData | urlParam | none
    if (!strategy) return { refs: [], strategy: 'none', warnings: ['refs unsupported'] };

    const compressed = await Promise.all(
        refs.map(r => compressDataUrl(r.image))
            .then(c => ({ ...r, image: c.dataUrl, meta: c }))
    );

    const max = cap.maxRefs[strategy] ?? 4;
    const capped = compressed.slice(0, max);
    return { refs: capped, strategy };
}
```

### 7.2 Передача в провайдер

```js
const { refs: preparedRefs, strategy, warnings } = await prepareReferences(safeRefs, profile.provider, profile.model);

switch (apiType) {
    case 'openai':
        return await openai.generateImage(profile, instruction, preparedRefs, strategy, onStatus, signal);
    case 'gemini':
        return await gemini.generateImage(profile, instruction, preparedRefs, onStatus, signal);
    case 'pollinations':
        return await pollinations.generateImage(profile, instruction, preparedRefs, onStatus, signal);
    // ...
}
```

---

## 8. Провайдеры

### 8.1 OpenAI-like (`src/providers/openai.js`)

#### Стратегия A: `formDataEdits` (для `gpt-image-*`)

```js
const form = new FormData();
form.append('model', p.model);
form.append('prompt', buildReferenceInstruction(refs) + '\n\n' + prompt);
form.append('n', '1');
form.append('size', size);
form.append('quality', mapQualityForGptImage(p.quality));
form.append('input_fidelity', 'high');

for (const [i, ref] of refs.entries()) {
    form.append('image[]', await dataUrlToFile(ref.image, `reference${i}.png`));
}

const resp = await fetchWithTimeout(`${normalizeEndpoint(p.endpoint)}/v1/images/edits`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${p.apiKey}` },
    body: form,
    signal,
}, 120000);
```

- `Content-Type` **не** устанавливается вручную — fetch ставит boundary.
- Качество маппится: `hd`/`high` → `high`, `medium` → `medium`, остальное → `low`.
- Размер маппится из `aspectRatio` через `ASPECT_SIZE_MAP`.

#### Стратегия B: `multimodalChat` (опционально, через `providerOptions.useMultimodalChat`)

```js
const content = [
    { type: 'text', text: buildReferenceInstruction(refs) + '\n\n' + prompt },
    ...refs.map(ref => ({ type: 'image_url', image_url: { url: ref.image } }))
];
const body = {
    model: p.model,
    messages: [{ role: 'user', content }],
    modalities: ['image', 'text'],
    stream: false,
};
```

- Используется только если `providerOptions.useMultimodalChat === true`.
- Подходит для `gpt-4o`, `o1`, `o3` и совместимых прокси.

#### Стратегия C: `images/generations` (без референсов)

- Текущее поведение — без изменений.
- Если refs непустые и ни одна стратегия не поддерживается — логируем warning.

### 8.2 Gemini (`src/providers/gemini.js`)

```js
const sentRefs = refs.slice(0, 4);
const parts = [];
for (const ref of sentRefs) {
    parts.push({
        inlineData: {
            mimeType: dataUrlMimeType(ref.image),
            data: dataUrlToBase64(ref.image),
        }
    });
}
const fullPrompt = sentRefs.length
    ? `${buildReferenceInstruction(sentRefs)}\n\n${prompt}`
    : prompt;
parts.push({ text: fullPrompt });

const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: ar, imageSize: is },
    },
};
```

- Используем `dataUrlMimeType(ref.image)` вместо захардкоженного `image/png`.
- Ограничиваем 4 референсами.

### 8.3 Pollinations (`src/providers/pollinations.js`)

#### Стратегия `urlParam` (только `kontext`)

```js
if (p.model === 'kontext' && refs.length) {
    const ref = refs[0];
    const uploadedPath = await uploadReferenceImage(ref.image, 'pollinations_ref');
    const publicUrl = resolvePublicUrl(uploadedPath);
    params.set('image', publicUrl);
    log('pollinations: используем URL референса', publicUrl);
}
```

- Если ST недоступен извне — пытаемся data URL как fallback.
- Если URL слишком длинный — ошибка с понятным сообщением.

#### Остальные модели

- Text-to-image, референсы игнорируются с warning.

### 8.4 Agnes (`src/providers/agnes.js`)

- Без изменений.
- Референсы игнорируются с warning и логированием.

### 8.5 ComfyUI / A1111

- Остаются заглушками (`UnsupportedError`).
- В будущем: workflow JSON с reference-нодами — out of scope.

---

## 9. Инструкции для референсов

```js
function buildReferenceInstruction(refs) {
    if (!refs.length) return '';
    const instructions = refs.map((ref, i) => {
        const label = ref.role === 'char' ? 'Character' :
                      ref.role === 'user' ? 'User' :
                      `NPC "${ref.name}"`;
        return `Image ${i + 1} shows ${label}. Use it ONLY for this ${label.toLowerCase()}'s appearance.`;
    });
    return `[Reference guide: ${instructions.join(' ')} IMPORTANT: unrelated characters must have their own unique appearance. Do not apply the look of one reference to another character.]`;
}
```

- Текст на английском (v2 spec §8.10).
- Нумерация картинок соответствует порядку parts.

---

## 10. Pipeline (`src/pipeline.js`)

### 10.1 `runStage2`

```js
const msg = ctx.chat?.[msgId];
const chatText = String(msg?.mes || '').replace(/<[^>]*>/g, ' ');
const instructionText = [instruction.prompt, instruction.style].filter(Boolean).join(' ');

const refs = await collectReferencesFromActiveProfile({
    chatText,
    instructionText,
    charName: ctx.characters?.[ctx.characterId]?.name,
    userName: ctx.name1,
});

const dataUrl = await generateImage(imageConnId, null, instruction, refs, onStatus);
```

### 10.2 `runStage1`

- Без изменений.

---

## 11. UI (`src/ui/tab-references.js`)

### 11.1 Режим

Добавить опцию `smart`:

```html
<select class="text_pole uris-mode">
    <option value="never">Никогда</option>
    <option value="smart">Умный (по упоминанию в промпте)</option>
    <option value="always">Всегда</option>
</select>
```

### 11.2 NPC-референсы

Для каждого профиля — секция NPC:

```html
<div class="uris-npc-list">
    <!-- NPC cards -->
</div>
<button class="menu_button uris-add-npc">+ Добавить NPC</button>
```

Карточка NPC:
- Поле имени.
- Поле ключевых слов (через запятую).
- Превью загруженного изображения.
- Кнопка загрузки/замены изображения.
- Чекбокс enabled.
- Кнопка удаления.

### 11.3 Загрузка NPC-изображения

```js
const dataUrl = await readFileAsDataUrl(file);
const compressed = await compressDataUrl(dataUrl);
const path = await uploadReferenceImage(compressed.dataUrl, `npc_${npcId}`);
// сохраняем path в профиль
```

### 11.4 Hint

Обновить логику hint:
- Если активный image-провайдер OpenAI и модель не `gpt-image-*` и не multimodal — показывать предупреждение.
- Если Pollinations и модель не `kontext` — показывать предупреждение.

---

## 12. Логирование

### 12.1 Что логировать

| Место | Данные |
|-------|--------|
| `collectReferencesFromProfile` | `mode`, `charName`, `userName`, matched NPC names, total refs |
| `compressDataUrl` | original bytes → compressed bytes, dimensions, format |
| `uploadReferenceImage` | filename, returned path |
| `prepareReferences` | provider, model, strategy, maxRefs, capped count |
| `openai.generateImage` | endpoint, strategy, model, refs count, FormData fields |
| `gemini.generateImage` | endpoint, model, parts count, mime types |
| `pollinations.generateImage` | model, has image URL, URL type (public/local/data) |

### 12.2 Формат

```js
log('references.collect', {
    mode: profile.mode,
    charName,
    userName,
    matchedNpcs: matched.map(n => n.name),
    totalRefs: refs.length,
});

console.table(refs.map(r => ({
    role: r.role,
    name: r.name,
    originalBytes: r.meta.originalBytes,
    compressedBytes: r.meta.compressedBytes,
    format: r.meta.format,
    dimensions: `${r.meta.width}x${r.meta.height}`,
})));
```

---

## 13. Тестирование

### 13.1 Unit-тесты

- `tests/references.test.js`:
  - `compressDataUrl` уменьшает размер.
  - `dataUrlMimeType` корректно определяет MIME.
  - `isNameInText` с word-boundary.
  - `collectReferencesFromProfile` для `always`/`never`/`smart`.

- `tests/providers/openai.test.js`:
  - `gpt-image-1` использует `/v1/images/edits` с `FormData`.
  - `dall-e-3` использует `/v1/images/generations` и игнорирует refs.
  - `mapQualityForGptImage`.

- `tests/providers/gemini.test.js`:
  - `inlineData` parts с правильным mime.
  - лимит 4 референсов.

### 13.2 Ручные тесты

| Сценарий | Ожидаемый результат |
|----------|---------------------|
| Gemini + 2 рефа | Картинка с референсами, в консоли видно parts |
| OpenAI gpt-image-1 + 1 реф | `POST /v1/images/edits`, FormData, `input_fidelity: high` |
| OpenAI DALL-E + реф | Реф игнорируется, warning |
| Pollinations kContext + реф | URL в query, warning если локальный |
| Smart mode, NPC не упомянут | NPC не отправляется |
| Smart mode, NPC упомянут | NPC отправляется |
| 3MB PNG реф | Сжимается до <500KB |

---

## 14. Миграция и обратная совместимость

### 14.1 Существующие профили референсов

- Поле `mode` раньше было `'never' | 'always'`. При чтении старых данных:
  - `undefined` → `'never'`.
  - `'never'` / `'always'` — как есть.
  - Добавляем `npcReferences: []` если отсутствует.

### 14.2 Существующие провайдеры

- OpenAI-провайдер продолжает работать для text-to-image.
- Gemini-провайдер продолжает работать с референсами.
- Pollinations/Agnes без изменений для text-to-image.

### 14.3 Галерея

- `refsSig` в gallery entry расширяется: `'char,user,npc:Axel'`.

---

## 15. Архитектура изменений

### 15.1 Изменённые файлы

| Файл | Что меняется |
|------|--------------|
| `src/references.js` | Добавить compression, upload, mime, file, blob, logging |
| `src/references-profiles.js` | NPC CRUD, smart mode, keyword matching, collect with context |
| `src/providers/base.js` | `REF_CAPABILITIES`, `buildReferenceInstruction` |
| `src/providers/openai.js` | FormData edits + multimodal chat fallback |
| `src/providers/gemini.js` | Mime type from data URL |
| `src/providers/pollinations.js` | kContext URL param |
| `src/providers/agnes.js` | Логирование, warning |
| `src/image-api.js` | `prepareReferences`, dispatch with strategy |
| `src/pipeline.js` | Передача chatText/instructionText в collect |
| `src/ui/tab-references.js` | Smart mode, NPC UI |
| `src/core.js` | Возможно: константы `MAX_REFS_*` |

### 15.2 Новые тесты

| Файл | Что тестирует |
|------|---------------|
| `tests/references.test.js` | Compression, mime, keyword matching |
| `tests/references-profiles.test.js` | Collect with modes, NPC matching |
| `tests/providers/openai-refs.test.js` | FormData edits, multimodal chat |

---

## 16. Риски и ограничения

| Риск | Митигация |
|------|-----------|
| Pollinations требует публичный URL | Upload + warning + data URL fallback |
| OpenAI `gpt-image-*` дорогой | Логирование + warning перед отправкой |
| Сжатие портит детали лица | 768px достаточно, качество 0.85 |
| Smart mode может пропустить NPC | Настраиваемые keywords + debug логи |
| Multimodal chat fallback нестандартен | Опция в `providerOptions`, default false |

---

## 17. Критерии готовности

- [ ] `src/references.js` содержит `compressDataUrl`, `uploadReferenceImage`, `dataUrlToFile`, `dataUrlMimeType`.
- [ ] `src/references-profiles.js` поддерживает NPC и `smart` режим.
- [ ] OpenAI `gpt-image-*` отправляет референсы через `/v1/images/edits` с `FormData`.
- [ ] Gemini отправляет референсы как `inlineData` с правильным MIME.
- [ ] Pollinations `kontext` отправляет референс как URL.
- [ ] Все провайдеры логируют технические данные в консоль.
- [ ] UI вкладки «Референсы» позволяет управлять NPC.
- [ ] Unit-тесты проходят.
- [ ] Ручные тесты на Gemini и OpenAI gpt-image-1 успешны.
