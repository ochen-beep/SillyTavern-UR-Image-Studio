# UR Image Studio — Universal Stage 1 Adapter & Simplified UI

> Дата: 2026-07-09
> Контекст: дополнение к `docs/superpowers/specs/2026-07-01-ur-image-studio-v2-design.md`
> Назначение: сделать Stage 1 универсальным для любых text-LLM и упростить UI вкладки «Генерация», убрав жёсткие захардкоженные категории.

---

## 1. Проблема

Сейчас Stage 1 работает в двух режимах:

1. **Structured** — жёстко требует от модели поля `camera`, `characters`, `panels` и т.д. по `outputKind` (`manga-page`, `single-illustration`, `cinematic-still`).
2. **Raw** — ожидает от модели JSON вида `{style, prompt, aspectRatio, imageSize}`, но не объясняет это явно в system prompt.

Результат: если пользователь пишет свой system prompt и модель возвращает любую другую JSON-структуру (`subject/setting/action/technical_specifications` и т.п.), парсер не распознаёт ответ, и поля «Стиль»/«Промпт» остаются пустыми. Сырой JSON тоже не сохраняется, потому что legacy/raw ветка возвращает `draft: null`.

---

## 2. Цель

Stage 1 должен быть **универсальным**:

- Пользователь пишет в шаблоне, что он хочет от модели.
- Отправляется сцена.
- Модель возвращает **любой** осмысленный JSON (или inline-тег).
- Расширение извлекает из этого `{style, prompt, aspectRatio, imageSize, quality}` и показывает в UI.

При этом основной UI облегчается: убираются захардкоженные «Тип кадра» и «Стиль», которые сейчас ограничивают пользователя. Они переезжают в шаблон / advanced-режим.

---

## 3. Принципы

1. **Шаблон первичен.** Что именно просить у модели — решает system prompt в шаблоне. Расширение не навязывает схему.
2. **Адаптер терпимый.** Любой JSON или inline-тег превращается в простой внутренний объект `{style, prompt, aspectRatio, imageSize, quality, draft, raw}`.
3. **UI минималистичен.** По умолчанию видны только поля, нужные для 90% сценариев.
4. **Advanced — глобальный тоггл.** Продвинутые поля (style override, quality, сырой JSON) показываются только при включённом тоггле.
5. **Обратная совместимость.** Старые structured-шаблоны продолжают работать через существующий `prompt-flatter.js`.

---

## 4. Новый внутренний формат инструкции

```ts
{
  style: string;          // визуальный стиль, может быть пустым
  prompt: string;         // финальная строка для image API
  aspectRatio: string;    // например "9:16"
  imageSize: string;      // "1K" | "2K" | "4K"
  quality?: string;       // "low" | "medium" | "high" (для GPT Image 2)
  draft?: object;         // structured draft (если был structured-шаблон)
  kind?: string;          // "manga-page" | "single-illustration" | "cinematic-still" | null
  raw: any;               // сырое содержимое ответа модели (JSON или строка)
}
```

`raw` всегда сохраняется и показывается в advanced-режиме.

---

## 5. Универсальный адаптер Stage 1

### 5.1 Этапы адаптации

Адаптер `src/stage1-adapter.js` получает текст ответа LLM и пытается распознать его в порядке приоритета:

1. **Inline image tag** — `<img data-iig-instruction='{...}' src="[IMG:GEN]">` или `[IMG:GEN:{...}]`.
2. **Strict schema match** — JSON соответствует текущему structured-шаблону (`camera`/`characters`/`panels` и т.д.).
3. **Legacy direct match** — JSON содержит поля `style` + `prompt`.
4. **Smart extraction** — JSON с произвольной структурой (`subject`, `setting`, `action`, `technical_specifications`, `description`, `scene`, `composition` и т.д.).
5. **Plain text fallback** — если нет JSON, весь текст считается `prompt`, `style` остаётся пустым.

### 5.2 Smart extraction

Если JSON не подошёл под известные схемы, запускается **adapter prompt** к той же text-LLM (лёгкий, быстрый вызов):

```
System: Ты — нормализатор промптов для генерации изображений.
User: Вот JSON, который вернула другая модель. Извлеки из него:
- style: визуальный стиль / art direction (если есть)
- prompt: полное описание изображения для image API
- aspectRatio (опц.)
- imageSize (опц.)
- quality (опц.)

Верни ТОЛЬКО JSON вида {"style":"...","prompt":"..."}.

JSON: { ... }
```

Adapter prompt используется только если эвристики не смогли извлечь `prompt` напрямую. Это позволяет не платить за лишний вызов в простых случаях.

### 5.3 Эвристики для smart extraction

До adapter prompt применяются простые правила:

- Если есть `prompt` — используем его.
- Если есть `description` / `scene_description` / `action.scene_description` — используем как `prompt`.
- Если есть `style` / `art_style` / `aesthetic` / `art_direction` — используем как `style`.
- Если есть `subject` + `setting` + `action` — склеиваем в `prompt`.
- `aspectRatio` / `aspect_ratio` / `aspect ratio` — маппим на валидные значения.
- `imageSize` / `image_size` / `resolution` — маппим на `1K`/`2K`/`4K`.

### 5.4 Поддержка inline-тегов

Если в ответе модели найден тег `<img data-iig-instruction='{...}' src="[IMG:GEN]">`, он парсится как в `alhenassillyimages` / `notsosillynotsoimages`. Поля `style`, `prompt`, `aspect_ratio`, `image_size`, `quality` извлекаются напрямую.

---

## 6. Изменения UI вкладки «Генерация"

### 6.1 Простой режим (по умолчанию)

```
┌─────────────────────────────────────┐
│ Шаблон промпта  [▼]                 │
│ Персонажи       [чипсы]             │
│ Stage 1         [Авто ▼]            │
│ Stage 2         [Авто-after ▼]      │
│                                     │
│ Промпт          [textarea]          │
│                                     │
│ Стороны  [9:16 ▼]   Размер [2K ▼]   │
│                                     │
│ [Построить] [Сгенерировать] [В очередь] │
└─────────────────────────────────────┘
```

**Убрано из простого режима:**
- Тип кадра (Манга-страница / Одиночная иллюстрация / Кинематографический кадр)
- Поле «Стиль»
- Сырой JSON

**Оставлено:**
- Шаблон — задаёт system prompt.
- Персонажи — передают внешность.
- Stage 1 / Stage 2 — управление flow.
- Промпт — результат Stage 1, редактируемый.
- Стороны / Размер — технические параметры image API.

### 6.2 Advanced режим

Включается глобальным тогглом (сохраняется в `extensionSettings.uris_advancedMode`).

```
┌─────────────────────────────────────┐
│ ▼ Advanced                          │
│                                     │
│ Style override  [textarea]          │
│ Quality         [auto ▼]            │
│                                     │
│ [✓] Показывать сырой JSON           │
│                                     │
│ { "style":"...", "prompt":"..." }   │
│                                     │
│ [Пересобрать промпт из JSON]        │
└─────────────────────────────────────┘
```

**Поля advanced:**
- **Style override** — подменяет или дополняет стиль, возвращённый моделью.
- **Quality** — `low` / `medium` / `high` / `auto`. Используется для GPT Image 2 и подобных API.
- **Сырой JSON** — показывает `instruction.raw`, можно редактировать и пересобрать промпт.
- **Пересобрать промпт из JSON** — запускает `normalizeInstruction` на отредактированном JSON.

### 6.3 Что происходит с «Типом кадра" и «Стилем"

- **Тип кадра** уходит из UI. Его функция (дефолтные стороны/размер) переходит в шаблон (`aspectRatioDefault`, `imageSizeDefault`). Если в будущем понадобится — можно вернуть как пользовательский пресет в шаблонах.
- **Стиль** уходит в шаблон и в advanced override. Пользователь либо просит модель вернуть `style` в своём шаблоне, либо задаёт его вручную в advanced.

---

## 7. Поведение Style override

Если задан style override:

1. Если модель вернула `style` — они **конкатенируются**: `override + ", " + modelStyle`.
2. Если модель не вернула `style` — используется только override.
3. При отправке в image API финальная строка собирается как:
   - Для OpenAI-like / Naistera: `[Style: {style}] {prompt}`.
   - Для Gemini: `style` и `prompt` передаются в текстовой части `parts`, стиль в начале.

Если `style` пустой — отправляется только `prompt`.

---

## 8. Техническая реализация

### 8.1 Новые/изменённые модули

| Модуль | Что меняется |
|---|---|
| `src/parser.js` | Добавить smart extraction, inline-tag parsing, сохранение `raw`. |
| `src/stage1-adapter.js` | **Новый** модуль: эвристики + adapter prompt + нормализация в `{style, prompt, ...}`. |
| `src/prompt-builder.js` | Raw-режим: явно требовать `{style, prompt}` в JSON-only tail; разрешать отсутствие схемы. |
| `src/pipeline.js` | Использовать новый адаптер; сохранять `raw` в `state.lastInstruction`. |
| `src/core.js` | Добавить `defaultSettings.advancedMode: false`. |
| `index.js` (UI) | Убрать «Тип кадра» и «Стиль» из простого режима; добавить глобальный тоггл Advanced; показывать сырой JSON. |
| `style.css` | Стили для advanced-секции и тоггла. |

### 8.2 Псевдокод адаптера

```js
export async function adaptStage1Response(rawText, template, rules, signal) {
  const text = String(rawText || '').trim();

  // 1. inline tag
  const inline = parseInlineImageTag(text);
  if (inline) return normalizeInlineTag(inline, text);

  // 2. JSON extraction
  const json = parseInstructionJson(text);
  if (json) {
    // 2a. structured draft
    if (isStructuredDraft(json)) {
      return normalizeStructuredDraft(json, rules);
    }
    // 2b. legacy {style, prompt}
    if (json.style !== undefined || json.prompt !== undefined) {
      return normalizeLegacy(json, text);
    }
    // 2c. smart extraction
    const extracted = extractSimpleFields(json);
    if (extracted.prompt) return normalizeLegacy(extracted, text);
    // 2d. adapter prompt fallback
    const adapted = await runAdapterPrompt(text, signal);
    return normalizeLegacy(adapted, text);
  }

  // 3. plain text fallback
  return {
    style: '',
    prompt: text,
    aspectRatio: null,
    imageSize: null,
    quality: null,
    draft: null,
    kind: null,
    raw: text,
  };
}
```

### 8.3 Adapter prompt

```js
const ADAPTER_SYSTEM = `Ты — нормализатор промптов для генерации изображений. Тебе даётся JSON или текст, который вернула другая языковая модель. Извлеки из него поля для image API.

Верни ТОЛЬКО JSON вида:
{
  "style": "...",
  "prompt": "...",
  "aspectRatio": "9:16",
  "imageSize": "2K",
  "quality": "medium"
}

Правила:
- style — только визуальный стиль / art direction. Если в исходных данных нет стиля, оставь пустую строку.
- prompt — полное описание изображения: субъект, действие, окружение, свет, настроение. Объединяй фрагменты логично.
- aspectRatio — одно из: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9. Если не указано — null.
- imageSize — одно из: 1K, 2K, 4K. Если не указано — null.
- quality — low, medium, high. Если не указано — null.
- Никакого markdown, никаких \`\`\`json блоков.`;
```

### 8.4 Поведение quality

- Если quality не задан ни моделью, ни пользователем — используется `auto` (провайдер решает).
- Пользовательский выбор в advanced побеждает.
- Для провайдеров, не поддерживающих quality (Gemini, Naistera), параметр игнорируется.

---

## 9. Обратная совместимость

### 9.1 Старые structured-шаблоны

Шаблоны с `mode: 'structured'` продолжают работать:
- system prompt строится как раньше.
- Парсер распознаёт structured draft через `isStructuredDraft()`.
- `prompt-flatter.js` собирает финальную строку.
- Поля `aspectRatio` / `imageSize` берутся из draft.

### 9.2 Старые raw-шаблоны

Шаблоны с `mode: 'raw'` получают улучшенный system prompt:
- К пользовательскому тексту добавляется явная инструкция: «Верни ТОЛЬКО JSON вида {"style":"...","prompt":"..."}».
- Если модель всё равно вернула другую структуру — срабатывает smart extraction / adapter prompt.

### 9.3 Старые настройки

- `advancedMode` добавляется в `defaultSettings` со значением `false`.
- Старые бандлы и шаблоны не ломаются.

---

## 10. Тестирование

### 10.1 Unit-тесты

- `tests/stage1-adapter.test.js` — новый файл:
  - inline tag parsing;
  - structured draft passthrough;
  - legacy `{style, prompt}` passthrough;
  - smart extraction для `subject/setting/action/technical_specifications`;
  - plain text fallback;
  - style override concatenation.

### 10.2 Ручные сценарии

1. Пользователь пишет шаблон «Создай динамичное изображение... Верни JSON с subject/setting/action» → адаптер извлекает style/prompt.
2. Пользователь использует старый structured manga-шаблон → поведение не меняется.
3. Пользователь использует alhenassillyimages-style inline tag → парсится напрямую.
4. Пользователь включает Advanced, меняет сырой JSON, жмёт «Пересобрать» → промпт обновляется.

---

## 11. Миграция данных

- `state.lastInstruction` теперь обязан содержать `raw`.
- При загрузке старых записей из истории, где `raw` отсутствует, можно установить `raw = { style, prompt, aspectRatio, imageSize }`.
- В localforage ничего мигрировать не нужно, кроме добавления `advancedMode` в extension settings.

---

## 12. Out of scope (не в этом PR)

- Полный рефакторинг `image-api.js` под provider layer v2.
- Поддержка ComfyUI / A1111.
- UI для редактирования field mapping.
- Автоматический выбор image API под aspect ratio (например, GPT Image 2 vs Gemini).
