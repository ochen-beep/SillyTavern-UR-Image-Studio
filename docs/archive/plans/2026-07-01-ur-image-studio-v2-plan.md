# UR Image Studio v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переработать расширение под модель «workflow-блоки»: 5 вкладок (API / Референсы / Генерация / Галерея / Профили), два независимых переключателя Stage1/Stage2, именованные бандлы, привязка якорем к сообщению без мутации `message.mes`, много-провайдерное API (OpenAI-like / Gemini / ComfyUI; A1111 — stub).

**Source spec:** `docs/superpowers/specs/2026-07-01-ur-image-studio-v2-design.md` (фиксированная точка правды; пункт отступает только при технической невозможности — фиксируется в log/git).

**Tech Stack:** Vanilla JS (ES modules), SillyTavern extension API, localforage (через `SillyTavern.libs.localforage`), Font Awesome, toastr. Без сборки, без тест-фреймворка. Верификация через `node --check` и ручную загрузку в SillyTavern.

**Conventions:** Работаем на master. Коммитить ТОЛЬКО когда пользователь явно просит. Верифицировать `node --check` перед заявлением «готово». Русские комментарии и UI-строки. `message.mes` не мутируется.

---

## Принципы порядка выполнения

1. **Слой провайдеров (Tasks 2–6) + Task 7.5 (models) — фундамент.** До него UI «вкладок API» и pipeline переписывать бессмысленно. models.js зависит от провайдеров (вызывает их `/v1/models`/`/v1beta/models`), но лежит над ними и отдельным файлом — ставится после T2–T6.
2. **Миграция v1→v2 (Task 22) — раньше UI новых вкладок.** Чтобы новые данные находились в наличии к моменту рендера вкладок.
3. **UI вкладок (Tasks 17–21) — после ядра.** Каждая вкладка ре-рендерит из уже готовых модулей. Order: API → Референсы → Профили → Генерация → Галерея (обратно от уровня новизны).
4. **post-anchor (Task 16) — параллельно с UI галереи.** Связан с galleryMode, но независим модульно.
5. **Ручная валидация (Task 25) — последняя.** Все 4 гибридных сценария Stage1/Stage2 + ComfyUI локально.

---

## File Structure (целевая)

```
UR Image Studio/
├─ manifest.json              (без изменений)
├─ index.js                   (Task 22: регистрация 5 вкладок + init)
├─ style.css                  (Task 23: переписать под 5 вкладок + якоря)
├─ docs/superpowers/specs/...
├─ docs/superpowers/plans/...  ← этот документ
└─ src/
   ├─ core.js                 (Task 1: расширить state/settings/utils)
   ├─ default-template.js     (без изменений)
   ├─ parser.js               (без изменений)
   ├─ prompt-builder.js       (без изменений)
   ├─ presets.js              (Task 8: + references-profiles + bundles CRUD)
   ├─ references-profiles.js  (Task 9: новая сущность)
   ├─ bundles.js              (Task 10: новая сущность + apply)
   ├─ chat-binding.js         (Task 11: обёрнут над bundles, v2 форма binding)
   ├─ references.js           (Task 12: рефакторинг: сбор аватаров общий, кодирование -> в провайдер)
   ├─ models.js               (Task 7.5: fetch/refresh списка моделей от провайдера с фильтрами)
   ├─ text-api.js             (Task 7: тонкий dispatcher в providers)
   ├─ image-api.js            (Task 7: тонкий dispatcher в providers)
   ├─ pipeline.js             (Task 13: signal support, separate runStage1/runStage2, queue + stop)
   ├─ events.js               (Task 14: split handlers Stage1/Stage2 на GENERATION_ENDED / on-stage1-done)
   ├─ storage.js              (Task 15: + stGalleryPath, + ST upload error-safe)
   ├─ history.js              (Task 15: опционально entry-object вместо строк)
   └─ providers/
      ├─ base.js              (Task 2: интерфейс)
      ├─ openai.js            (Task 3: /chat/completions + /images/generations)
      ├─ gemini.js            (Task 4: generateContent + imageConfig)
      ├─ comfyui.js           (Task 5: /prompt + poll /history + /view + /upload/image + /interrupt)
      └─ a1111.js              (Task 6: stub на будущее; не входит в MVP-валидацию)
   └─ ui/
      ├─ window.js            (без изменений)
      ├─ tabs.js              (без изменений, просто 5 вкладок)
      ├─ tab-api.js           (Task 17: бывшие text/image секции tab-presets + provider-select)
      ├─ tab-references.js    (Task 18: новая)
      ├─ tab-profiles.js      (Task 19: бандлы)
      ├─ tab-generate.js      (Task 20: rewrite — config-top + lower-panel-result + queue-stop)
      ├─ tab-gallery.js       (Task 21: Rewrite — archive listing + «перейти к посту» + sync-anchor-toggle)
      ├─ post-anchor.js       (Task 16: MutationObserver + render бейджа 🖼️(N))
      └─ lightbox.js          (без изменений, используется для клика по якорю)
```

--- 
## Task 1: Скелет ядра v2 — core.js (расширить)

**Files:** Modify `src/core.js`

- [ ] **Step 1: Расширить ключи localforage**

Добавить экспорты:
```js
export const LF_REFERENCES_PROFILES = 'uris_references_profiles';
export const LF_BUNDLES = 'uris_bundles';
```

- [ ] **Step 2: Расширить `state`**

```js
export const state = {
    ... // прежние поля сохраняются
    activeTextProfileId: null,
    activeImageProfileId: null,
    activeReferencesProfileId: null,
    activeBundleId: null,          // текущий применённый бандл
    activeBundleOverrides: {},    // точечные переопределения
    lastInstruction: null,        // последняя построенная Stage1 (для нижней панели)
    currentChatId: null,
    currentMsgId: null,
    queue: [],
    queueRunning: false,
    queueAbort: null,              // отдельный AbortController для всей очереди
    abortController: null,         // текущая стадия
};
```

- [ ] **Step 3: Расширить `defaultSettings`**

```js
export const defaultSettings = Object.freeze({
    enabled: true,
    collapsed: true,
    // v2: два независимых переключателя вместо generationMode
    stage1Mode: 'manual',         // 'auto' | 'manual' | 'off'
    stage2Mode: 'manual',         // 'auto-after' | 'manual' | 'off'
    maxRetries: 0,
    retryDelay: 1000,
    generationTimeout: 120000,
    historyRich: true,             // хранить объекты вместо строк в истории
    historyLimit: 20,
    galleryLimit: 0,
    windowGeometry: null,
    // legacy (на время миграции)
    generationMode: 'manual',     // сохраняется для migrateV1; не используется в v2 логике
});
```

- [ ] **Step 4: Усилить `fetchWithTimeout` — принимать внешний `signal`**

```js
export async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // если передан внешний signal, проксируем abort:
    const externalSignal = options.signal;
    if (externalSignal) {
        if (externalSignal.aborted) ctrl.abort();
        else externalSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    try {
        return await fetch(url, { ...options, signal: ctrl.signal });
    } catch (e) {
        if (e.name === 'AbortError') {
            if (externalSignal?.aborted) throw new DOMException('Aborted by user', 'AbortError');
            throw new Error(`Таймаут (${Math.round(timeoutMs/1000)}с)`);
        }
        throw e;
    } finally { clearTimeout(timer); }
}
```

- [ ] **Step 5: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/core.js" && echo OK
```

---

## Task 2: providers/base.js — интерфейс провайдеров

**Files:** Create `src/providers/base.js`

- [ ] **Step 1: Определить контракты**

```js
// @ts-check
/**
 * Базовый интерфейс провайдеров генерации.
 * Каждый провайдер реализует тот из методов, который ему подходит:
 *   - generateText  (для text-LLM)
 *   - generateImage (для image-API)
 * Тем, кто не поддерживает (например a1111), метод кидает UnsupportedError.
 */

export class UnsupportedError extends Error {
    constructor(what) { super(`Провайдер не поддерживает: ${what}`); this.name = 'UnsupportedError'; }
}

/**
 * @typedef {Object} TextProfile
 * @property {string} provider - 'openai-like' | 'gemini'
 * @property {string} endpoint
 * @property {string} apiKey
 * @property {string} model
 * @property {number} [temperature]
 */

/**
 * @param {TextProfile} p
 * @param {string} system
 * @param {string} user
 * @param {(s: string) => void} [onStatus]
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} — текст-ответ
 */
export async function generateText(p, system, user, onStatus, signal) {
    throw new UnsupportedError('generateText');
}

/**
 * @param {Object} p — image profile
 * @param {Object} instruction — { style, prompt, aspectRatio, imageSize, quality }
 * @param {Array<{image: string, role: string}>} refs — dataUrl-референсы
 * @param {(s: string) => void} [onStatus]
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} — dataUrl картинки
 */
export async function generateImage(p, instruction, refs, onStatus, signal) {
    throw new UnsupportedError('generateImage');
}

// Создание референс-инструкции для провайдера.
// Возвращает string для дополнения prompt'а ИЛИ массив payloads для /upload
export function buildReferencePayload(provider, refs, ctx) {
    return null;  // по умолчанию референсы не нужны
}
```

- [ ] **Step 2: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/providers/base.js" && echo OK
```

---

## Task 3: providers/openai.js — OpenAI-like (text + image)

**Files:** Create `src/providers/openai.js`

- [ ] **Step 1: Реализовать generateText + generateImage**

- Tекст: `POST {endpoint}/v1/chat/completions`, payload `{model, messages: [{role:'system',...}, {role:'user',...}], temperature}`. Парсить `choices[0].message.content`.
- Tекстовая обработка: референсы НЕ поддерживаются OpenAI images-API — метод `generateImage` кидает `UnsupportedError('reference-images')` если `refs?.length > 0` (т.к. поле `image` — нестандартное, отказ в v2). UI должно показывать это предупреждение в `tab-references`.
- Иmage: `POST {endpoint}/v1/images/generations`, payload `{model, prompt: composePrompt(prompt, style), n: 1, size, quality, response_format: 'b64_json'}`.
- size mapping: `1:1 → '1024x1024'`, `16:9 → '1792x1024'`, `9:16 → '1024x1792'`, иначе используется `p.size` (если задан), иначе fallback `1024x1024`.
- Возврат: `data:image/png;base64,...` из `data[0].b64_json` либо URL из `data[0].url` если `b64_json` нет.
- Retry: общий `callWithRetry` из `core`/`base` перебирает maxRetries только на 429/503/502/504/timeout по тому же regex, что в v1.
- signal: прокидывается во все `fetchWithTimeout` вызовы.

- [ ] **Step 2: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/providers/openai.js" && echo OK
```

---

## Task 4: providers/gemini.js — Gemini (text + image)

**Files:** Create `src/providers/gemini.js`

- [ ] **Step 1: Реализовать**

- text: `POST {endpoint}/v1beta/models/{model}:generateContent`. Payload `{ system_instruction: { parts:[{text:system}] }, contents:[{role:'user', parts:[{text:user}]}], generationConfig:{ temperature, responseMimeType:'application/json' } }`.
- image: сборка `parts`: для каждого ref из `refs.slice(0,4)` → `{inlineData:{ mimeType:'image/png', data: dataUrlToBase64(ref.image) }}`. Plus финальный `{text: composePrompt(prompt, style) + (refs.length ? '\n\n' + buildReferenceInstruction(refs, ctx) : '')}`.
- `buildReferenceInstruction` — английский, а не русский (закрытие v1–debt из spec §8.10).
- imageConfig: `{ aspectRatio: validAR, imageSize: validIS }` с валидацией через `VALID_ASPECT_RATIOS` / `VALID_IMAGE_SIZES`.
- Парсинг ответа: поддерживает оба кейса — `inlineData` (camelCase) и `inline_data` (snake_case).
- signal: использоватся во всех `fetchWithTimeout`.

- [ ] **Step 2: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/providers/gemini.js" && echo OK
```

---

## Task 5: providers/comfyui.js — ComfyUI workflow API

**Files:** Create `src/providers/comfyui.js`

- [ ] **Step 1: Реализовать `generateImage`**

Контракт image-preset для ComfyUI (поля для добавления в `tab-api.js`):
```js
{
  provider: 'comfyui',
  endpoint,              // e.g. http://127.0.0.1:8188
  workflowJson: string,  // raw JSON, выгруженный из ComfyUI "Save (API Format)"
  textNodeId: string,    // id ноды с inputs.text куда подставлять prompt
  seedNodeId: string|null, // id ноды с inputs.seed для random-сидов (опц.)
  outputNodeId: string,  // id SaveImage ноды, откуда забрать outputs.images[0]
  loadAvatarNodeId: string|null  // id LoadImage ноды для аватара (опц.)
}
```

Flow:
1. JSON.parse `workflowJson` → граф dict.
2. Подстановка: `graph[textNodeId].inputs.text = composePrompt(prompt, style)`; если `seedNodeId` то установка `Math.floor(Math.random()*2**53)`.
3. Если refs.length > 0 && loadAvatarNodeId:
   - POST `/upload/image` (multipart form-data: `image` = blob-from-dataUrl, `overwrite=true`).
   - В response: `{ name, subfolder, type:'input' }`.
   - `graph[loadAvatarNodeId].inputs.image = name`.
4. POST `/prompt` c body `{ prompt: graph, client_id: 'uris-' + Date.now() }`.
5. Парсить ответ: `{ prompt_id, number, node_errors }`. Если `node_errors` non-empty → throw с.Describe.
6. Polling: `GET /history/{prompt_id}` каждые 1500ms до timeout. Стоп на `{ prompt_id: { status: { completed: true }, outputs: { [outputNodeId]: { images: [...] }}}}`. Max iterations = `timeout / 1500`.
7. Из ответа взять `outputs[outputNodeId].images[0]` → `{ filename, subfolder, type: 'output' }`.
8. `GET /view?filename=...&subfolder=...&type=output` → fetch blob → `FileReader.readAsDataURL` → resolve dataUrl.
9. signal: при abort также вызвать `POST /interrupt` (fire-and-forget) — прервать upstream задачу, не ждать ack.
10. Retry на 429/503 как обычно.

Поддержка `/history` для старых ComfyUI: если в entry нет `status.completed` (старые версии), считать завершенным по наличию `outputs[<те output_id>].images.length > 0`.

- [ ] **Step 2: `generateText` — UnsupportedError**

ComfyUI не генерирует текст, так как text-LLM должен быть отдельным провайдером (openai-like 通常 для LM Studio).

- [ ] **Step 3: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/providers/comfyui.js" && echo OK
```

Реальная валидация — на локальном ComfyUI в Task 25. В комменте в голове файла пометить что протокол проверен на ComfyUI r3xxx+ версиям; поля с `inline_data` могут быть именно snake в старых сборках.

---

## Task 6: providers/a1111.js — stub

**Files:** Create `src/providers/a1111.js`

- [ ] **Step 1: Stub**

```js
// @ts-check
/**
 * A1111 / Forge / reForge WebUI — stub на будующее (не MVP v2).
 * Реализация ~50 строкок: POST /sdapi/v1/txt2img
 * payload { prompt, negative_prompt, seed, steps, cfg_scale, width, height, sampler_name, batch_size, alwayson_scripts? for controlnet }
 * response { images: [base64,...], info }
 */
import { UnsupportedError } from './base.js';

export async function generateImage(p, instruction, refs, onStatus, signal) {
    throw new UnsupportedError('a1111 not yet implemented');
}
export async function generateText() { throw new UnsupportedError('a1111 text'); }
```

- [ ] **Step 2: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/providers/a1111.js" && echo OK
```

---

## Task 7: text-api.js + image-api.js — тонкие dispatcher'ы

**Files:** Modify `src/text-api.js`, `src/image-api.js`

- [ ] **Step 1: text-api.js**

Заменить всю реализацию на dispatcher:
```js
import { state } from './core.js';
import * as openai from './providers/openai.js';
import * as gemini from './providers/gemini.js';
import { UnsupportedError } from './providers/base.js';

export async function generatePromptText(textPreset, system, user, onStatus) {
    const signal = state.abortController?.signal;
    const p = { ...textPreset, provider: textPreset.provider || mapLegacyApiType(textPreset.apiType) };
    switch (p.provider) {
        case 'openai-like': return openai.generateText(p, system, user, onStatus, signal);
        case 'gemini':      return gemini.generateText(p, system, user, onStatus, signal);
        default: throw new Error('Неизвестный text-провайдер: ' + p.provider);
    }
}

// для миграции v1 presets:
function mapLegacyApiType(t) { return t === 'gemini' ? 'gemini' : 'openai-like'; }
```

- [ ] **Step 2: image-api.js**

То же для image-API:
```js
import { state } from './core.js';
import * as openai from './providers/openai.js';
import * as gemini from './providers/gemini.js';
import * as comfyui from './providers/comfyui.js';
import * as a1111 from './providers/a1111.js';

export async function generateImage(imagePreset, instruction, refs, onStatus) {
    const signal = state.abortController?.signal;
    const p = { ...imagePreset, provider: imagePreset.provider || mapLegacyApiType(imagePreset.apiType) };
    switch (p.provider) {
        case 'openai-like': return openai.generateImage(p, instruction, refs, onStatus, signal);
        case 'gemini':      return gemini.generateImage(p, instruction, refs, onStatus, signal);
        case 'comfyui':     return comfyui.generateImage(p, instruction, refs, onStatus, signal);
        case 'a1111':       return a1111.generateImage(p, instruction, refs, onStatus, signal);
        default: throw new Error('Неизвестный image-провайдер: ' + p.provider);
    }
}

function mapLegacyApiType(t) { return t === 'gemini' ? 'gemini' : 'openai-like'; }
```

- [ ] **Step 3: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/text-api.js" && \
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/image-api.js" && echo OK
```

---

## Task 7.5: models.js — подгрузка и валидация списка моделей

**Context:** В v1 поле «Модель» в карточке пресета — это ручной `<input>` (`tab-presets.js:87,109`). Пользователь должен знать точное имя модели наизусть (`gpt-4o`, `gemini-2.0-flash-exp`, `qwen2.5-7b-instruct`, `dall-e-3`…). Любая опечатка или неизвестность альтернативы —>Runtime-ошибка `404 model not found`/`400 model does not support images`, без подсказки что у API есть.

Эта задача решает три источника потери моделей:
1. **LM Studio** — список живой, зависит от загруженных `.gguf`; пользователь не помнит.
2. **OpenAI cloud** — `/v1/models` возвращает десятки моделей, но не все подходят к `/images/generations` (только dall-e-3, dall-e-2, gpt-image-1). Без фильтра в списке оказываются chat-only —>Runtime-error.
3. **Gemini** — `/v1beta/models` возвращает все, включая `embedContent`-only и image-only через `predict` (Imagen). Лишь часть поддерживает `responseModalities:['TEXT','IMAGE']`.

**Files:** Create `src/models.js`

- [ ] **Step 1: Публичные константы фильтров**

```js
// @ts-check
/**
 * Подгрузка списка моделей от провайдера + фильтры по доступности.
 * Каждый провайдер (openai-like / gemini) экспозит: listModels(provider, profile, kind) -> [{id, label, ok: bool}]
 *   kind = 'text' | 'image' — определяет, какие модели пригодны (фильтры ниже).
 * ComfyUI не имеет «модели» как таковой — модель — это поле `unet_name`/`ckpt_name`
 *   в workflow JSON; подгрузка не нужна (см. comfyui.js в Task 5).
 */
import { fetchWithTimeout, log, warn, error } from './core.js';

// Known-models whitelists для image-API (подмножество /v1/models, технически для /images/generations).
// Возвращается на случай, если провайдер /v1/models не экспозит image-capable флаги.
const OPENAI_IMAGE_MODELS = ['dall-e-3', 'dall-e-2', 'gpt-image-1'];
const OPENAI_IMAGE_HINTS  = /^(dall-e|gpt-image)/i;

// Gemini: /v1beta/models возвращает supportedGenerationMethods[].
const GEMINI_TEXT_METHOD  = 'generateContent';
const GEMINI_IMAGE_KNOWN  = /^(gemini-2\.\d.*image|imagen)/i;  // —> известные image-capable Gemini-линейки
```

- [ ] **Step 2: `listModels(profile, kind)` — единая точка входа**

```js
/**
 * @param {{provider:string, endpoint:string, apiKey:string}} profile
 * @param {'text'|'image'} kind
 * @returns {Promise<{id, label, ok:boolean, reason?:string}[]>}
 * ok=false помечает модели, которые найдены, но непригодны (для UI—disabled или «серый»).
 */
export async function listModels(profile, kind) {
    const p = { ...profile, provider: profile.provider || mapLegacy(profile) };
    switch (p.provider) {
        case 'openai-like': return listOpenAIModels(p, kind);
        case 'gemini':       return listGeminiModels(p, kind);
        case 'comfyui':      return [{ id: '', label: 'модель — в workflow JSON', ok: true }];
        case 'a1111':        return [{ id: '', label: 'coming soon', ok: true }];
        default: throw new Error('Неизвестный провайдер: ' + p.provider);
    }
}

function mapLegacy(p) { return p.apiType === 'gemini' ? 'gemini' : 'openai-like'; }

// ── OpenAI-like ──
async function listOpenAIModels(p, kind) {
    const url = `${p.endpoint.replace(/\/$/,'')}/v1/models`;
    let j;
    try {
        const r = await fetchWithTimeout(url, {
            method: 'GET', headers: { Authorization: `Bearer ${p.apiKey}` },
        }, 10000);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        j = await r.json();
    } catch (e) {
        warn('OpenAI /v1/models failed:', e.message);
        throw new Error('Не удалось получить список моделей: ' + e.message);
    }
    const arr = (Array.isArray(j.data) ? j.data : []).map(x => x.id).filter(Boolean);
    // Сортировка: dall-e/gpt-image первыми (для image-kind), затем lphabetical.
    return arr.sort((a,b) => {
        const ai = OPENAI_IMAGE_HINTS.test(a), bi = OPENAI_IMAGE_HINTS.test(b);
        if (ai !== bi) return bi - ai;
        return a.localeCompare(b);
    }).map(id => {
        let ok = true, reason;
        if (kind === 'image' && !OPENAI_IMAGE_MODELS.includes(id) && !OPENAI_IMAGE_HINTS.test(id)) {
            ok = false; reason = 'не подходит к /images/generations';
        }
        return { id, label: id, ok, reason };
    });
}

// ── Gemini ──
async function listGeminiModels(p, kind) {
    const url = `${p.endpoint.replace(/\/$/,'')}/v1beta/models`;
    let j;
    try {
        const r = await fetchWithTimeout(url, {
            method: 'GET', headers: { Authorization: `Bearer ${p.apiKey}` },
        }, 10000);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        j = await r.json();
    } catch (e) {
        warn('Gemini /v1beta/models failed:', e.message);
        throw new Error('Не удалось получить список моделей: ' + e.message);
    }
    const arr = Array.isArray(j.models) ? j.models : [];
    return arr.map(m => {
        const id = (m.name || '').replace(/^models\//, '');
        const methods = m.supportedGenerationMethods || [];
        let ok = true, reason;
        if (kind === 'text' && !methods.includes(GEMINI_TEXT_METHOD)) {
            ok = false; reason = `поддерживает только ${methods.join(', ')}`;
        }
        if (kind === 'image' && !GEMINI_IMAGE_KNOWN.test(id)) {
            ok = false; reason = 'нет подтверждённой поддержки image-output';
        }
        return { id, label: `${id}${m.displayName ? ' · ' + m.displayName : ''}`, ok, reason };
    }).sort((a,b) => (a.ok===b.ok ? a.label.localeCompare(b.label) : (a.ok ? -1 : 1)));
}

// ── Helper: валидирует что модель-введенная-вручную есть в списке (используется tab-api перед сохранением пресета) ──
export async function validateModel(profile, kind, modelId) {
    if (!modelId) return { ok: false, reason: 'модель не указана' };
    if (profile.provider === 'comfyui' || profile.provider === 'a1111') return { ok: true };
    try {
        const list = await listModels(profile, kind);
        const m = list.find(x => x.id === modelId);
        if (!m) return { ok: false, reason: 'модель не найдена в списке API' };
        return m;  // {ok, reason?}
    } catch (e) {
        // listing failed — не блокируем сохранение (legacy user/offline list)
        return { ok: true, reason: 'list недоступен, проверь разумность вручную' };
    }
}
```

- [ ] **Step 3: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/models.js" && echo OK
```

Expected: без синтаксических ошибок. Реальный запрос к каждому провайдеру валидируется в Task 25.

**UI-привязка (in Task 17 — tab-api.js):**
- Для text-connection карточки: поле model — **select вместо input** + кнопка «🔄 Обновить список» (как `uris-refresh-avatars` для аватаров).
- Для image-connection карточки: то же; если provider=comfyui — поле скрыто (т.к. модель — в workflowJson), показывается только текстовая подсказка.
- Модели с `ok=false` рендерятся как disabled `<option disabled>` с сигментированной пометкой `(⚠️ не подходит: <reason>)` — selectable невозможно по ошибке, но они видны как «да,list содержит их, но warn».
- Refresh кеширует результат в `state.modelsCache[profileId+kind]` на 5 мин (минимизировать requestы при свитчинге вкладок); кеш инвалидируется при изменении endpoint/apiKey в карточке.

**Принципы безопасного fallback (важно при desync из spec §11 рисков):**
- Если `/v1/models` вернул 401/403/5xx —→ UI показывает **fallback на `<input>`** + toastr warning «List не получен, введите имя модели вручную». Сохранение пресета не блокируется.
- Если user offline или LM Studio не запущен — то же fallback. Пользователь может ввести имя по памяти.
- Если list вернул 0 моделей (edge case: empty catalog OAI account) — `select` остаётся пустым с приветствием «API вернул пустой список; введите имя вручную» + fallback input-toggle.

Это закрывает Твой вопрос «может ли модель не проброситься в список»: в v2 — пробрасываются все доступные в API; фильтруются только несовместимые методы (`ok=false` disabled, но видны); а если list-вызов неуспешен, UI откатывается на ручной ввод.

---

## Task 8: presets.js — расширить CRUD (references-profiles + bundles)

**Files:** Modify `src/presets.js`

- [ ] **Step 1: Добавить CRUD для references-profiles и bundles**

Повторить паттерн listX/createX/saveX/deleteX/getPreset, как в существующих для text/image/char/template.

Добавить:
- `LF_REFERENCES_PROFILES`: `listReferencesProfiles, createReferencesProfile, saveReferencesProfile, deleteReferencesProfile`
- `LF_BUNDLES`: `listBundles, createBundle, saveBundle, deleteBundle`

`createReferencesProfile` дефолт: `{ id, name:'Новый профиль референсов', charAvatar:false, userAvatarFile:'', customImages:[], mode:'never' }`.
`createBundle` дефолт: `{ id, name:'Новый бандл', textProfileId:null, imageProfileId:null, referencesProfileId:null, templatesIds:[], characterIds:[], stage1Mode:'manual', stage2Mode:'manual', queueSettings:{ concurrency:1, generationDelayMs:0 }, galleryMode:'anchor', copyToStGallery:false }`.

- [ ] **Step 2: Расширить `createImagePreset`**

Добавить в дефолт: `provider:'openai-like'` и убрать из дефолта лишнее: `sendCharAvatar, sendUserAvatar, userAvatarFile, referenceMode` переходят в references-profile (но оставить в schema на время миграции как deprecated; ignored в логике v2). Добавить в дефолт ComfortUI-поля (пустые): `workflowJson:'', textNodeId:'', seedNodeId:null, outputNodeId:'', loadAvatarNodeId:null`.

- [ ] **Step 3: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/presets.js" && echo OK
```

---

## Task 9: references-profiles.js — новая коллекция

**Files:** Create `src/references-profiles.js`

- [ ] **Step 1: Реализация**

```js
// @ts-check
/**
 * Профили референсов — самостоятельный блок workflow.
 * Хранятся в LF_REFERENCES_PROFILES. CRUD — в presets.js.
 * Здесь — функции применения и построения refs по профилю + bv сбор аватаров.
 */
import { state, getCtx, log } from './core.js';
import { getPreset, LF_REFERENCES_PROFILES } from './presets.js';
import { getCharacterAvatarDataUrl, getUserAvatarDataUrl } from './references.js';

export async function getActiveReferencesProfile() {
    const id = state.activeReferencesProfileId;
    if (!id) return null;
    return await getPreset(LF_REFERENCES_PROFILES, id);
}

// Собрать refs [{image, role}] по активному профилю.
// Если profile.mode === 'never' — возвращает [].
export async function collectReferencesFromActiveProfile() {
    const p = await getActiveReferencesProfile();
    if (!p || p.mode === 'never') return [];
    const refs = [];
    if (p.charAvatar) {
        const d = await getCharacterAvatarDataUrl();
        if (d) refs.push({ image: d, role: 'char' });
    }
    if (p.userAvatarFile) {
        const d = await getUserAvatarDataUrl(p.userAvatarFile);
        if (d) refs.push({ image: d, role: 'user' });
    }
    // customImages — на будующее (LF_CUSTOM_IMAGES); в MVP v2 заглушка
    log(`Собрано refs: ${refs.length}`);
    return refs;
}
```

- [ ] **Step 2: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/references-profiles.js" && echo OK
```

---

## Task 10: bundles.js — именованные бандлы + apply

**Files:** Create `src/bundles.js`

- [ ] **Step 1: Реализация**

```js
// @ts-check
/**
 * Бандлы — именованный пресет «весь flow целиком».
 * Хранятся в LF_BUNDLES (CRUD в presets.js).
 * chatMetadata.uris_binding = { bundleId, overrides }.
 */
import { state, getCtx, log, warn, META_KEY } from './core.js';
import { getPreset, listBundles, LF_BUNDLES, createBundle, saveBundle, deleteBundle } from './presets.js';

export function getBinding() {
    const ctx = getCtx();
    const meta = ctx.chatMetadata?.[META_KEY];
    return meta && typeof meta === 'object' ? meta : null;
}

export function setBinding(binding) {
    const ctx = getCtx();
    if (!ctx.chatMetadata) ctx.chatMetadata = {};
    ctx.chatMetadata[META_KEY] = binding;
    try { ctx.saveMetadata?.(); } catch { /* non-critical */ }
    log('Привязка обновлена', binding);
}

export async function getActiveBundle() {
    const binding = getBinding();
    const bundleId = binding?.bundleId;
    if (!bundleId) return null;
    return await getPreset(LF_BUNDLES, bundleId);
}

// Применить бандл к state (текущему чату): все активные id'ышники проставляются.
export async function applyBundleToCurrentChat(bundleId) {
    const bundle = await getPreset(LF_BUNDLES, bundleId);
    if (!bundle) { warn('Бандл не найден:', bundleId); return null; }
    const binding = getBinding() || {};
    binding.bundleId = bundleId;
    binding.overrides = binding.overrides || {};
    setBinding(binding);
    applyBundleToState(bundle);
    log('Применён бандл', bundle.id, bundle.name);
    return bundle;
}

export function applyBundleToState(bundle) {
    state.activeBundleId = bundle.id;
    state.activeTextProfileId = bundle.textProfileId;
    state.activeImageProfileId = bundle.imageProfileId;
    state.activeReferencesProfileId = bundle.referencesProfileId;
    if (bundle.stage1Mode) state.settings.stage1Mode = bundle.stage1Mode;
    if (bundle.stage2Mode) state.settings.stage2Mode = bundle.stage2Mode;
}

// Создать бандл из текущего state (snapshot).
export async function snapshotCurrentStateToBundle(name) {
    return await createBundle({
        name,
        textProfileId: state.activeTextProfileId,
        imageProfileId: state.activeImageProfileId,
        referencesProfileId: state.activeReferencesProfileId,
        stage1Mode: state.settings.stage1Mode,
        stage2Mode: state.settings.stage2Mode,
        galleryMode: state.settings.galleryMode || 'anchor',
        copyToStGallery: state.settings.copyToStGallery || false,
    });
    // templatesIds, characterIds — подтягиваются из «Генерация» вкладки через tab-profiles save
}

// Дефолтный бандл: первые профили каждого типа.
export async function defaultBundle() {
    const arr = await listBundles();
    if (arr.length) return arr[0];
    const b = await createBundle({ name: 'Базовый' });
    return b;
}
```

- [ ] **Step 2: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/bundles.js" && echo OK
```

---

## Task 11: chat-binding.js — обёртка над bundles

**Files:** Modify `src/chat-binding.js`

- [ ] **Step 1: Переписать под v2**

```js
// @ts-check
/**
 * Legacy-chat-binding был натянут на bundles в v2:
 * `chatMetadata.uris_binding = { bundleId, overrides }`.
 * Здесь — удобные обёртки для index.js.
 */
import { state, getCtx, log } from './core.js';
import { listTextPresets, listImagePresets, listCharacters, listTemplates, createCharacter } from './presets.js';
import { getBinding, setBinding, applyBundleToCurrentChat, defaultBundle, applyBundleToState } from './bundles.js';

export { getBinding, setBinding, applyBundleToCurrentChat, defaultBundle };

export async function applyBindingForCurrentChat() {
    let binding = getBinding();
    if (!binding || !binding.bundleId) {
        const b = await defaultBundle();
        await applyBundleToCurrentChat(b.id);
        return b;
    }
    const bundle = await applyBundleToCurrentChat(binding.bundleId);
    // применить overrides отдельно:
    if (binding.overrides) {
        if (binding.overrides.textProfileId) state.activeTextProfileId = binding.overrides.textProfileId;
        if (binding.overrides.imageProfileId) state.activeImageProfileId = binding.overrides.imageProfileId;
        if (binding.overrides.referencesProfileId) state.activeReferencesProfileId = binding.overrides.referencesProfileId;
        // stage1/2 overrides зарезервированы — в MVP не переопределяются
    }
    log('Применена привязка через бандл:', binding.bundleId);
    return bundle;
}

// Гарантировать char/user слотов в коллекции персонажей (как в v1).
export async function ensureBuiltinCharacterSlots() {
    const chars = await listCharacters();
    const hasChar = chars.some(c => c.role === 'char');
    const hasUser = chars.some(c => c.role === 'user');
    if (!hasChar) await createCharacter({ role: 'char', name: 'Персонаж чата', sceneName: '', description: '' });
    if (!hasUser) await createCharacter({ role: 'user', name: 'Пользователь', sceneName: '', description: '' });
}
```

- [ ] **Step 2: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/chat-binding.js" && echo OK
```

---

## Task 12: references.js — упростить

**Files:** Modify `src/references.js`

- [ ] **Step 1: Убрать `collectReferences` и `buildReferenceInstruction`**

Сбор через профиль — в `references-profiles.js`. Кодирование под провайдер — в самих провайдерах. В references.js остаются только общие функции:
```js
export async function getCharacterAvatarDataUrl() { ... }
export async function getUserAvatarDataUrl(userAvatarFile) { ... }
export async function fetchUserAvatars() { ... }
export function dataUrlToBase64(d) { ... }
export function imageToDataUrl(url) { ... }   // экспортируем
```

`buildReferenceInstruction` — переезжает в `providers/gemini.js` (en English; там где она нужна). В `references.js` не экспортируется.

- [ ] **Step 2: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/references.js" && echo OK
```

---

## Task 13: pipeline.js — signal + runStage1/runStage2 + queue stop

**Files:** Modify `src/pipeline.js`

- [ ] **Step 1: `resolveActivePresets` — читает из state.active* + overrides**

```js
export async function resolveActivePresets() {
    const textPreset = state.activeTextProfileId ? await getPreset(LF_TEXT_PRESETS, state.activeTextProfileId) : null;
    const imagePreset = state.activeImageProfileId ? await getPreset(LF_IMAGE_PRESETS, state.activeImageProfileId) : null;
    const template = null;  // выбран в «Генерация»
    const templates = await listTemplates();
    // templateFromTab — сохранённый выбор из tab-generate state (state.activeTemplateId default = templates[0])
    const activeChars = [];
    const chars = await listCharacters();
    for (const c of chars) if ((state.activeCharacterIds || []).includes(c.id)) activeChars.push(c);
    return {
        textPreset, imagePreset, activeChars,
        templateContent: (templates.find(t => t.id === state.activeTemplateId)?.content) || templates[0]?.content || null,
    };
}
```

- [ ] **Step 2: `runStage1` и `runStage2` принимают и уважают signal**

```js
export async function runStage1(msgId, onStatus) {
    const ctx = getCtx();
    const msg = ctx.chat?.[msgId];
    if (!msg) throw new Error('Сообщение не найдено');
    state.abortController = new AbortController();
    state.currentMsgId = msgId;
    state.pendingSourceMsgId = msgId;   // предзапомнили — для race-safe инъекции
    state.pendingSourceMesHash = hashMes(msg.mes);
    try {
        const { textPreset, activeChars, templateContent } = await resolveActivePresets();
        const system = buildSystemPrompt(templateContent, activeChars);
        const user = buildUserPrompt(msg.mes);
        const raw = await generatePromptText(textPreset, system, user, onStatus);
        if (state.abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const instr = parseInstructionFromText(raw);
        if (!instr) throw new Error('Не удалось распарсить промпт из ответа LLM');
        state.lastInstruction = instr;
        log('Stage 1 готова:', { style: instr.style?.slice(0,40), prompt: instr.prompt?.slice(0,40) });
        return instr;
    } finally {
        state.abortController = null;
    }
}

export async function runStage2(msgId, instruction, onStatus) {
    state.abortController = new AbortController();
    try {
        const { imagePreset } = await resolveActivePresets();
        const refs = await collectReferencesFromActiveProfile();
        const dataUrl = await generateImage(imagePreset, instruction, refs, onStatus);
        if (state.abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        
        const refsSig = refs.map(r => r.role).sort().join(',');
        const ctx = getCtx();
        const chatId = ctx.chatId;
        const saved = (state.activeBundle?.copyToStGallery) || false;
        let stGalleryPath = null;
        if (saved) {
            try { stGalleryPath = await saveImageToFile(dataUrl); }
            catch (e) { warn('ST upload failed, остаётся dataUrl:', e.message); }  // не теряем dataUrl
        }
        const entry = await addToGallery(chatId, {
            src: stGalleryPath || dataUrl,
            prompt: instruction.prompt, style: instruction.style,
            aspectRatio: instruction.aspectRatio, imageSize: instruction.imageSize,
            refsSig, sourceMsgId: msgId, saved: !!stGalleryPath, stGalleryPath,
        });
        await pushHistory(chatId, instruction.prompt, { style: instruction.style, sourceMsgId: msgId });
        
        // race-safe check: пост изменился — не вешаем якорь
        const curMsg = ctx.chat?.[msgId];
        if (curMsg && hashMes(curMsg.mes) === state.pendingSourceMesHash) {
            // триггерим перерисовку якорей (post-anchor.js слушает gallery)
            window.dispatchEvent(new CustomEvent('uris:gallery-updated', { detail: { chatId, msgId } }));
        } else {
            log('Stage2: post changed/deleted, якорь не вешается');
        }
        
        log('Stage 2 готова, entry', entry.id);
        return entry;
    } finally {
        state.abortController = null;
    }
}

function hashMes(s) { let h=5381; for (let i=0;i<(s||'').length;i++) h=((h<<5)+h)^s.charCodeAt(i); return h>>>0; }
```

- [ ] **Step 3: Очередь с concurrency + stop**

```js
export function enqueue(msgId, opts={}) {
    return new Promise((resolve, reject) => {
        state.queue.push({ msgId, resolve, reject, immediate: opts.immediate });
        processQueue();
    });
}

async function processQueue() {
    if (state.queueRunning) return;
    state.queueRunning = true;
    state.queueAbort = new AbortController();   // общий abort для всей очереди
    try {
        while (state.queue.length && !state.queueAbort.signal.aborted) {
            const item = state.queue.shift();
            state.abortController = new AbortController();
            // связать queue-abort с этим abort
            state.queueAbort.signal.addEventListener('abort', () => state.abortController.abort(), { once:true });
            try {
                const instr = await runStage1(item.msgId);
                if (state.settings.stage2Mode === 'auto-after' && item.immediate !== false) {
                    const entry = await runStage2(item.msgId, instr);
                    item.resolve(entry);
                } else {
                    // manual stage2: resolution происходит здесь — подготовленный промпт в очереди готов
                    // но в entry нет — resolve с инструкцией только
                    item.resolve({ instr });
                    // Следующий шаг в очереди пойдёт; пользователь жмёт «Отправить» в редакторе для текущего
                    break;  // пауза очереди — ждать ручной Stage2
                }
            } catch (e) {
                error('Q item failed:', e.message);
                if (e.name === 'AbortError') { break; }
                item.reject(e);
            }
            state.abortController = null;
            // generationDelayMs между задачами
            const delay = state.activeBundle?.queueSettings?.generationDelayMs || 0;
            if (delay) await new Promise(r => setTimeout(r, delay));
        }
    } finally {
        state.queueRunning = false;
        state.queueAbort = null;
        state.queue = [];    // очистить при выходе — останутся нерешённые промисы; см. ниже
    }
}

export function stopQueue() {
    state.queueAbort?.abort();
    state.abortController?.abort();
    // открыть все ожидающие промисы как abort:
    for (const item of state.queue) item.reject(new DOMException('Aborted by user', 'AbortError'));
    state.queue = [];
}
```

- [ ] **Step 4: `runFullPipeline` остаётся для удобства**

```js
export async function runFullPipeline(msgId) {
    const instr = await runStage1(msgId);
    return await runStage2(msgId, instr);
}
```

- [ ] **Step 5: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/pipeline.js" && echo OK
```

---

## Task 14: events.js — split handlers Stage1/Stage2

**Files:** Modify `src/events.js`

- [ ] **Step 1: Реализация**

```js
// @ts-check
import { state, getCtx, log } from './core.js';

let _bound = false;
let _onAutoStage1 = null;
let _onStage1Ready = null;

export function bindEvents(handlers) {
    const ctx = getCtx();
    if (!ctx.eventSource || _bound) return;
    _bound = true;
    _onAutoStage1 = handlers.onAutoStage1;
    _onStage1Ready = handlers.onStage1Ready;
    const et = ctx.event_types;

    // GENERATION_ENDED: запускать Stage1 только если stage1Mode === 'auto'
    ctx.eventSource.makeLast(et.GENERATION_ENDED, () => {
        if (!state.settings.enabled) return;
        if (state.settings.stage1Mode !== 'auto') return;
        const chat = ctx.chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user) {
                state.currentMsgId = i;
                _onAutoStage1?.(i);
                break;
            }
        }
    });

    // CHAT_CHANGED: сбросить currentMsgId + пересчитать anchors
    ctx.eventSource.on(et.CHAT_CHANGED, async () => {
        state.currentChatId = ctx.chatId;
        const chat = ctx.chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user) { state.currentMsgId = i; break; }
        }
        log('CHAT_CHANGED, last AI msg', state.currentMsgId);
        window.dispatchEvent(new CustomEvent('uris:chat-changed'));
    });

    log('Events bound.');
}

export function unbindEvents() { _bound = false; _onAutoStage1 = null; _onStage1Ready = null; }

export function notifyStage1Ready(instr) {
    // событие для Stage2 trigger'а внутри ext — tab-generate слушает
    window.dispatchEvent(new CustomEvent('uris:stage1-ready', { detail: instr }));
    if (state.settings.stage2Mode === 'auto-after' && _onStage1Ready) _onStage1Ready(instr);
}

export function navigatePosts(direction) {
    const ctx = getCtx();
    const chat = ctx.chat || [];
    const aiIndexes = [];
    for (let i = 0; i < chat.length; i++) if (!chat[i].is_user) aiIndexes.push(i);
    if (!aiIndexes.length) return null;
    const cur = state.currentMsgId ?? aiIndexes[aiIndexes.length - 1];
    let pos = aiIndexes.indexOf(cur);
    if (pos === -1) pos = aiIndexes.length - 1;
    pos = Math.max(0, Math.min(aiIndexes.length - 1, pos + direction));
    state.currentMsgId = aiIndexes[pos];
    return state.currentMsgId;
}
```

`_onStage1Ready` — вызывается из `pipeline.runStage1` при успехе, или напрямую из `tab-generate` после ручного построения. Контракт: индекс SourceMsgId берётся из `state.currentMsgId`.

- [ ] **Step 2: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/events.js" && echo OK
```

---

## Task 15: storage.js + history.js — stGalleryPath + rich history

**Files:** Modify `src/storage.js`, `src/history.js`

- [ ] **Step 1: storage.js — добавить `stGalleryPath` в schema**

В `addToGallery` entry принимает поле `stGalleryPath`. validateExisting — без убийства старых галерей.

- [ ] **Step 2: history.js — поддержка rich entry**

```js
export async function pushHistory(chatId, promptText, meta={}) {
    if (!promptText) return;
    let arr = await getHistory(chatId);
    const rich = state.settings.historyRich;
    // дедуп по префиксу в rich-режиме; в legacy-режиме — как строка
    if (rich) {
        const item = { prompt: promptText, ts: Date.now(), style: meta.style || '', sourceMsgId: meta.sourceMsgId ?? null };
        arr = arr.filter(x => (typeof x === 'string' ? x : x.prompt) !== promptText);
        arr.unshift(item);
    } else {
        arr = arr.filter(x => (typeof x === 'string' ? x : x.prompt) !== promptText);
        arr.unshift(promptText);
    }
    arr = arr.slice(0, state.settings.historyLimit || 20);
    await lf().setItem(key(chatId), arr);
}
```

UI «друпдаун» в `tab-generate.js` adapts:

```js
export async function loadHistoryDropdown() {
    const arr = await getHistory(chatId);
    return arr.map((x, i) => {
        if (typeof x === 'string') return { value: x, label: `${i+1}. ${x.slice(0,60)}…` };
        const time = new Date(x.ts).toLocaleTimeString().slice(0,5);
        const style = x.style ? ` · ${x.style.slice(0,20)}` : '';
        return { value: x.prompt, label: `${i+1}. ${time}${style} · ${x.prompt.slice(0,50)}…` };
    });
}
```

- [ ] **Step 3: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/storage.js" && \
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/history.js" && echo OK
```

---

## Task 16: ui/post-anchor.js — DOM-якорь к сообщению

**Files:** Create `src/ui/post-anchor.js`

- [ ] **Step 1: Реализация**

```js
// @ts-check
/**
 * Якорь сгенерированных картинок на DOM-ноде сообщения.
 * НЕ мутирует message.mes — только DOM overlay.
 * Observer следит за появлением/перерисовкой постов и добавляет бейдж 🖼️(N)
 * для постов, у которых в localforage-gallery есть записи по sourceMsgId.
 */
import { getCtx, log } from '../core.js';
import { getGallery } from '../storage.js';

let _observer = null;
let _cache = new Map();   // chatId → Map<msgId, count>

export function initAnchorObserver() {
    if (_observer) return;
    const ctx = getCtx();
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    refreshCacheAndAnchors();
    _observer = new MutationObserver(debounce(() => refreshAnchors(), 100));
    _observer.observe(chatEl, { childList: true, subtree: false });
    window.addEventListener('uris:gallery-updated', () => refreshCacheAndAnchors());
    window.addEventListener('uris:chat-changed', () => refreshCacheAndAnchors());
    log('Anchor observer init');
}

export function stopAnchorObserver() {
    if (_observer) { _observer.disconnect(); _observer = null; }
    _cache.clear();
    document.querySelectorAll('.uris-post-anchor').forEach(el => el.remove());
}

async function refreshCacheAndAnchors() {
    const ctx = getCtx();
    if (!ctx.chatId) return;
    const items = await getGallery(ctx.chatId);
    const byMsg = new Map();
    for (const it of items) {
        const m = byMsg.get(it.sourceMsgId) || 0;
        byMsg.set(it.sourceMsgId, m + 1);
    }
    _cache.set(ctx.chatId, byMsg);
    refreshAnchors();
}

function refreshAnchors() {
    const ctx = getCtx();
    const byMsg = _cache.get(ctx.chatId);
    if (!byMsg) return;
    document.querySelectorAll('.mes[mesid]').forEach(el => {
        const mesid = parseInt(el.getAttribute('mesid'), 10);
        const count = byMsg.get(mesid) || 0;
        let badge = el.querySelector('.uris-post-anchor');
        if (count > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'uris-post-anchor';
                badge.dataset.urisMsgId = mesid;
                badge.innerHTML = `🖼️ <small>(${count})</small>`;
                badge.title = `${count} кадр(ов) в галерее расширения — клик для просмотра`;
                badge.addEventListener('click', () => openLightboxForMsg(mesid));
                el.appendChild(badge);
            } else {
                badge.innerHTML = `🖼️ <small>(${count})</small>`;
            }
        } else if (badge) {
            badge.remove();
        }
    });
}

function openLightboxForMsg(msgId) {
    // делегация в tab-gallery отвечать за отображение; диспетчер через event:
    window.dispatchEvent(new CustomEvent('uris:open-anchor-lightbox', { detail: { msgId } }));
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
```

- [ ] **Step 2: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/ui/post-anchor.js" && echo OK
```

---

## Task 17: ui/tab-api.js — профили коннектов

**Files:** Create `src/ui/tab-api.js`

- [ ] **Step 1: Реализация**

Два accordion-секции: **Text-connections** и **Image-connections**. Вверху — toggle-bar активной пары:
```
[Text: ▾ LM Studio-local]  [Image: ▾ ComfyUI-local]   (current active pair)
```
Выбор меняет `state.activeTextProfileId` / `state.activeImageProfileId`, синхронизируется с tab-profiles (overrides) и сохраняется через `setBinding({ ...getBinding(), overrides })`.

CRUD的做法 через `bindRows`-паттерн из v1 `tab-presets.js`: каждый профиль — карточка со stick-mode автo-save на change/input. Поля выделяются по выбранному `provider` (select):
- `<select class="uris-provider">`: `openai-like` / `gemini` (text), `openai-like` / `gemini` / `comfyui` / `a1111` (image).
- openai-like (text|image): endpoint, apiKey, **model** (select — см. ниже), size (image-only), quality (image-only).
- gemini (text|image): endpoint, apiKey, **model** (select), aspectRatio (image-only), imageSize (image-only).
- comfyui: endpoint, workflowJson (textarea), textNodeId, seedNodeId, outputNodeId, loadAvatarNodeId. **Поле model скрыто** (модель — внутри workflow JSON).
- a1111: disabled-строка «coming soon».
- При выборе provider → переключение видимых групп через `toggleProviderFields(card, provider)`.

**Поле «Модель» — select с refresh (closure на Task 7.5):**
- Для openai-like/gemini рендерится как `<select class="text_pole uris-model"></select>` + `<button class="menu_button uris-refresh-models" title="Обновить список"><i class="fa-solid fa-sync"></i></button>`.
- Клик refresh → `listModels(profile, kind)` из `src/models.js` → заполнить `<option>`:
  - модели с `ok=true` — selectable.
  - модели с `ok=false` — `<option disabled>` с разметкой `${id} (⚠️ ${reason})` — selectable невозможно, но **видны** как диагностический шум.
  - если текущее значение `p.model` в списке не оказалось (was/manual legacy) — добавить `<option value="${p.model}" selected>(вручную: ${p.model})</option>` сверху, активным.
- Refresh кеширует результат в `state.modelsCache[profileId + '|' + kind]` на 5 минут; инвалидируется при изменении endpoint/apiKey в карточке (input event → `delete state.modelsCache[cacheKey]`).
- **Fallback на input** (см. принципы safe-fallback в Task 7.5): если `listModels()` бросил error (HTTP 401/403/5xx, network, LM Studio off) — `toastr.warning('Не удалось получить список моделей: <err>; введите имя вручную')`, поле автоматически переключается в `<input class="uris-model" type="text" value="${p.model}"/>` для ручного ввода. Кнопка refresh остаётся — повторный клик может снова запросить.
- При сохранении карточки (`change` event) — если попался select-mode и выбрана disabled-option (edge case обхода через DOM), просто сохраняется текущее `p.model` без валидации (валидация `validateModel` — она опц.; используется в «save» toast).
- Для comfyui-профиля вместо поля model — статичная надпись «модель задаётся в workflow JSON (Load Checkpoint / Load VAE / и т.д.)».

Safe-render: значения endpoint/model через DOM-API (`el.value`), не `innerHTML` конкат. (закрытие v1 debt из spec §8.9). Для каждого поля `createElement('input')` + `el.value = p.endpoint`. Для select-model: `createElement('option')` + `option.value = id` + `option.textContent = label`.

- [ ] **Step 2: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/ui/tab-api.js" && echo OK
```

---

## Task 18: ui/tab-references.js — профили референсов

**Files:** Create `src/ui/tab-references.js`

- [ ] **Step 1: Реализация**

Сверху — toggle-bar активного references-профиля (один). CRUD списка ниже: карточки `{ name, mode: 'never'|'always', charAvatar: checkbox, userAvatarFile: select }`.

Toggle «Активный» = кнопка на карточке; ставит `state.activeReferencesProfileId`.

UI-предупреждение: если выбран active image profile с provider=openai-like — показывать подсказку «OpenAI images API не принимает референсы; используйте Gemini или ComfyUI». Это закрывает v1 debt (галки работали вслепую).

`fetchUserAvatars()` (refresh-avatars кнопка) — для обновления `userAvatarFile` select.

Safe-render (как в Task 17).

- [ ] **Step 2: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/ui/tab-references.js" && echo OK
```

---

## Task 19: ui/tab-profiles.js — именованные бандлы

**Files:** Create `src/ui/tab-profiles.js`

- [ ] **Step 1: Реализация**

Вверху — текущий применённый бандл к этому чату (select + кнопки «Применить», «Применить без сохранения»).

CRUD бандлов: список карточек. каждую видно:
```
Имя: [Манга-сессия]
 Text:  ▾ LM Studio-local
 Image: ▾ ComfyUI-local
 Refs:  ▾ A+A аватары
 Stage1: ◐ auto   Stage2: ○ manual
 Очередь: concurrency=1 delay=0
 Галерея: ◉ Якорь к сообщению   ☑ копия в ST
 [Сохранить]  [Копия как...]  [Удалить]
```

Button «Применить к этому чату» → `applyBundleToCurrentChat(id)`. Button «Сохранить как новый» → snapshotCurrentStateToBundle (берёт текущее состояние активных id'ышников из state).

Кнопки «Сохранить» карточки — autosave на change через bindRows-паттерн с safe-render.

- [ ] **Step 2: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/ui/tab-profiles.js" && echo OK
```

---

## Task 20: ui/tab-generate.js — rewrite: config-top + lower-panel-result

**Files:** Modify `src/ui/tab-generate.js`

- [ ] **Step 1: Заполнение root HTML**

Layout (spec §4.3):
```
┌─ Генерация ─────────────────────────────────┐
│ [Источник] ← Пост #4 (🖼️ 2) →  [Построить ▾] │
│                                                │
│ Шаблон: [Манга-дефолт ▾]                       │
│ Персонажи: (● Alice  ○ Bob  +)                  │
│ Stage1: ◐ auto  ○ manual  ○ off                │
│ Stage2: ○ auto-after  ◐ manual  ○ off          │
│                                                │
│ ── Нижняя панель Stage1 (показать при готовом) │
│ Стиль:  [textarea]      Промпт: [textarea]     │
│ Стороны: [select]       Размер: [select]        │
│ [Сырой JSON] [Отправить в image] [В очередь]    │
│                                                │
│ ── История ──  [дропдаун]                       │
│ ── Очередь (N задач) [▶ Остановить] ──         │
└────────────────────────────────────────────────┘
```

- [ ] **Step 2: Привязка событий**

- navigatePosts(-1/+1) → update post info, показ бейджа (read из anchor-cache через window event `uris:gallery-updated`).
- Stage1/Stage2 радио-кнопки → `state.settings.stage1Mode/stage2Mode`. При Stage1=off: Stage2 radio блокируется (UI disabled, hint «зависит от Stage1»).
- Шаблон `<select>` → `state.activeTemplateId`, autosave.
- Chips персонажей → `state.activeCharacterIds` (multiselect toggle).
- «Построить промпт» → `runStage1(state.currentMsgId) -> applyResultToPanel(instr) -> notifyStage1Ready(instr)`.
- Нижняя панель — заполнить из `state.lastInstruction` (если в этом mesid-seance был построенный Stage1 для текущего поста).
- Кнопка «Отправить в image» → `runStage2(state.currentMsgId, collectInstructionFromPanel())`.
- Кнопка «В очередь» → `enqueue(state.currentMsgId)`, отображение `state.queue.length`.
- Кнопка «Остановить» (в блоке очереди) → `stopQueue()`.
- Дропдаун истории — `loadHistoryDropdown()` (rich формате из Task 15).
- Окно listener на `uris:open-anchor-lightbox` — открыть lightbox для msgId.

- [ ] **Step 3: Реакция на auto Stage1 / auto-after Stage2**

если `stage1Mode === 'auto'` — `events.js handleAutoStage1` (через `_handlers` в index.js) вызывает `runStage1` → notifyStage1Ready → если `stage2Mode === 'auto-after'` → `runStage2` → якорь вешается через `post-anchor.js` observer. tab не обязательно виден в этот момент; адаптируется на `chat-generate` вкладке в next render shows last task status.

- [ ] **Step 4: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/ui/tab-generate.js" && echo OK
```

---

## Task 21: ui/tab-gallery.js — rewrite: archive listing

**Files:** Modify `src/ui/tab-gallery.js`

- [ ] **Step 1: Layout**

```
[Количество N] [Очистить все]  [Сохранить всё в ST]  [Режим: Якорь ▾]
Список карточек (вертикальный, не сетка):
  ┌───────────────────┐
  │ [превью 96px]  15:32 │
  │ Стиль: seinen         │
  │ Промпт: «Alice...     │
  │ [📷 Открыть] [💾 ST] [📋 Копировать] [🔄 Реген] [🔄+ новый промпт] [→ Пост] [🗑 Удалить]  │
  └───────────────────────────────────────┘
```

`galleryMode` select: `anchor|localforage|st-only` — сохраняется в bundle (state.settings.galleryMode, sync через bundle или override).
`copyToStGallery` checkbox показывается только если mode!==st-only.

- [ ] **Step 2: Кнопки**

- «Открыть» — `showLightbox(items, idx)`.
- «ST» — `saveImageToFile(it.src)` + `updateGalleryEntry(chatId, id, { saved:true, src: path, stGalleryPath: path })`. Не throw — UI error, entry не теряется.
- «Копировать» — clipboard.copyText(prompt).
- «Реген» — `runStage2(it.sourceMsgId, { style, prompt, aspectRatio, imageSize }, ...)`.
- «Реген+новый промпт» — `runStage1(it.sourceMsgId)` → результат в редакторе (переключить tab на Генерация, заполнить нижнюю панель), не автозапуск Stage2 (mode manual).
- «→ Пост» — scroll to `.mes[mesid="{sourceMsgId}"]` и `el.classList.add('highlighted',)`.
- «Удалить» → `removeFromGallery`.

- [ ] **Step 3: Listener на якорь-событие**

```js
window.addEventListener('uris:open-anchor-lightbox', async (e) => {
    const chatId = getCtx().chatId;
    const items = await getGallery(chatId);
    const filtered = items.filter(x => x.sourceMsgId === e.detail.msgId);
    if (filtered.length) showLightbox(filtered, 0);
});
```

- [ ] **Step 4: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/ui/tab-gallery.js" && echo OK
```

---

## Task 22: index.js — register 5 tabs + init + migration

**Files:** Modify `index.js`

- [ ] **Step 1: Миграция v1 → v2**

```js
async function migrateV1Presets() {
    const texts = await listTextPresets();
    for (const t of texts) {
        if (!t.provider) { t.provider = (t.apiType === 'gemini') ? 'gemini' : 'openai-like'; await saveTextPreset(t); }
    }
    const images = await listImagePresets();
    for (const im of images) {
        if (!im.provider) {
            im.provider = (im.apiType === 'gemini') ? 'gemini' : 'openai-like';
            // оставить legacy-поля sendCharAvatar/etc., но логика v2 их игнорирует
            await saveImagePreset(im);
        }
    }
    // v1 binding → bundles: { textPresetId, imagePresetId, characterIds, templateId } → create bundle
    const binding = getCtx().chatMetadata?.[META_KEY];
    if (binding && binding.textPresetId && !binding.bundleId) {
        const b = await createBundle({
            name: 'Импорт из v1',
            textProfileId: binding.textPresetId,
            imageProfileId: binding.imagePresetId,
            referencesProfileId: null,  // отрефенс-profile заглушим далее если надо
            templatesIds: binding.templateId ? [binding.templateId] : [],
            characterIds: binding.characterIds || [],
            stage1Mode: state.settings.generationMode === 'auto' ? 'auto' : 'manual',
            stage2Mode: state.settings.generationMode === 'auto' ? 'auto-after' : 'manual',
        });
        // создать один references-profile из legacy image-preset'а:
        const ip0 = images.find(im => im.id === binding.imagePresetId);
        if (ip0) {
            const refs = await createReferencesProfile({
                name: 'Импорт из v1',
                charAvatar: !!ip0.sendCharAvatar,
                userAvatarFile: ip0.userAvatarFile || '',
                mode: ip0.referenceMode || 'never',
            });
            b.referencesProfileId = refs.id;
            await saveBundle(b);
        }
        // перезапустить binding в v2 форме:
        ctx.chatMetadata[META_KEY] = { bundleId: b.id, overrides: {} };
        try { ctx.saveMetadata?.(); } catch {}
        log('Migrated v1 binding → bundle', b.id);
    }
    // migrationStage1Stage2: legacy generationMode → stage1Mode/stage2Mode
    if (state.settings.generationMode && !state.settings._migratedSt12) {
        const m = state.settings.generationMode;
        state.settings.stage1Mode = (m === 'auto' || m === 'confirm') ? 'auto' : 'manual';
        state.settings.stage2Mode = (m === 'auto') ? 'auto-after' : (m === 'confirm') ? 'manual' : 'manual';
        state.settings._migratedSt12 = true;
        saveSettings();
    }
}
```

- [ ] **Step 2: init() — обновить под 5 вкладок + anchoring**

```js
async function init() {
    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) { error('SillyTavern недоступен'); return; }
    const ctx = getCtx(); if (!ctx) { warn('context недоступен'); return; }
    await loadSettings();

    if (state.settings.collapsed === undefined) state.settings.collapsed = true;

    await migrateV1Presets();          // ВАЖНО: до ensureDefaultTemplate (создаст затем дефолт template если не было)
    await ensureDefaultTemplate();
    await ensureBuiltinCharacterSlots();

    registerTab({ id: 'api',         label: 'API',         render: renderApi });
    registerTab({ id: 'references',  label: 'Референсы',  render: renderReferences });
    registerTab({ id: 'generate',    label: 'Генерация',   render: renderGenerate });
    registerTab({ id: 'gallery',     label: 'Галерея',     render: renderGallery });
    registerTab({ id: 'profiles',    label: 'Профили',     render: renderProfiles });

    createSettingsPanel();

    mountPanel(); renderTabs(); setActiveTab('generate'); syncPanelVisibility(); initViewportSync();

    state.currentChatId = ctx.chatId;
    if (ctx.chatId) await applyBindingForCurrentChat();

    bindEvents({
        onAutoStage1: async (msgId) => {
            if (!state.settings.enabled) return;
            try {
                const instr = await runStage1(msgId, s => setStatus(s));
                notifyStage1Ready(instr);
                setStatus('');
                if (state.settings.stage2Mode === 'auto-after') {
                    await runStage2(msgId, instr, s => setStatus(s));
                    setStatus('');
                    toastr?.success('Картинка сгенерирована (авто)');
                } else {
                    if (isPanelVisible() && getActiveTab() === 'generate') refreshActive();
                    setStatus('Промпт готов — открой «Генерация»');
                    toastr?.info('Промпт построен (Stage1 auto)');
                }
            } catch (e) { setStatus(''); toastr?.error('Stage1: ' + e.message); }
        },
        onStage1Ready: async (instr) => {
            if (state.settings.stage2Mode === 'auto-after') {
                try { await runStage2(state.currentMsgId, instr, s=>setStatus(s)); 
                    setStatus(''); toastr?.success('Картинка сгенерирована'); }
                catch (e) { setStatus(''); toastr?.error('Stage2: ' + e.message); }
            }
        },
    });

    initAnchorObserver();   // ← ключевой v2 инит
    ensureLauncher();
    attachLauncherObserver();

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') { flushSettings(); try { getCtx().saveMetadata?.(); } catch {} }
    });

    log('Initialized v2.');
}
```

`cleanup()`:
```js
function cleanup() {
    if (state.abortController) { state.abortController.abort(); state.abortController = null; }
    if (state.queueAbort) state.queueAbort.abort();
    stopAnchorObserver();
    unbindEvents();
    if (_launcherObserver) { _launcherObserver.disconnect(); _launcherObserver = null; }
    document.getElementById('urisWindow')?.remove();
    document.getElementById('uris_launcher')?.remove();
    log('Cleanup v2.');
}
```

Imports обновить из новой файловой структуры: `tab-api`, `tab-references`, `tab-profiles`, `runStage1/2` from `pipeline`, `notifyStage1Ready` from `events`, `initAnchorObserver/stopAnchorObserver` from `./src/ui/post-anchor.js`, `createBundle/createReferencesProfile/saveBundle/saveTextPreset/saveImagePreset/listTextPresets/listImagePresets/listBundles` from `presets.js`.

- [ ] **Step 3: Верифицировать**

```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/index.js" && echo OK
```

---

## Task 23: style.css — стили для новых вкладок и якорей

**Files:** Modify `style.css`

- [ ] **Step 1: Добавить классы**

`.uris-tab` (5 кнопок tab-bar, флекс-ряд, mobile— "прокрутка", кнопка 44px таргета).
`.uris-active-pair-toggle` — toggle-bar активных профилей вверху API/Рефы/Профили (для пяти вкладок).
`.uris-post-anchor` — стиль бейджа 🖼️(N): absolute, top-right поста, password-area круглый 24px, курсор pointer, title.
`.uris-stage-toggle` — радио группа в «Генерация» (Stage1/Stage2) компактная в три кнопки.
`.uris-lower-panel` — фон панели результата Stage1, отделён от конфигурации top border.
`.uris-archive-card` — карточка галереи с горизонтальным layout (превью 96px слева).
`.uris-queue-stop` — кнопка красная (var(--warningRed)).

Mobile (<768px): 5 вкладок tabbar скроллится горизонтально; stage-toggle в вертикальную колонку; archive-card превращается в column.

- [ ] **Step 2: Верифицировать**

Без `node --check` (CSS); визуально проверить после загрузки. Ожидаемый фикс: успешно открыть окно, переключить 5 вкладок, не сломать существующие стили (`.uris-window`/`.uris-mobile`).

---

## Task 24: Финальная статическая верификация всего проекта

- [ ] **Step 1: Прогнать `node --input-type=module --check` по всем src-модулям**

```bash
for f in src/core.js src/default-template.js src/parser.js src/prompt-builder.js \
         src/presets.js src/references-profiles.js src/bundles.js src/chat-binding.js \
         src/references.js src/text-api.js src/image-api.js src/pipeline.js src/events.js \
         src/storage.js src/history.js \
         src/providers/base.js src/providers/openai.js src/providers/gemini.js \
         src/providers/comfyui.js src/providers/a1111.js \
         src/ui/window.js src/ui/tabs.js src/ui/post-anchor.js \
         src/ui/tab-api.js src/ui/tab-references.js src/ui/tab-generate.js \
         src/ui/tab-gallery.js src/ui/tab-profiles.js src/ui/lightbox.js index.js; do
  node --input-type=module --check < "$f" || echo "FAIL: $f"
done && echo "ALL CHECKED"
```

Expected: только `ALL CHECKED` без `FAIL:`.

- [ ] **Step 2: Поиск неиспользуемых v1-импортов и dead-кода**

```bash
grep -rn "apiType" src/ | grep -v "mapLegacy" || true   # должно быть только в dispatcher legacy-mapping
grep -rn "referenceMode" src/ | grep -v "migrat" || true # TODO: проверить logical usage
grep -rn "sendCharAvatar" src/ || true                 # должно быть только в migrate
```

Все найденные вхождения — в `migrateV1Presets` (depricated legacy), либо parse-level fallback (как `mapLegacyApiType`). Если нашли []; иначе — secondary cleanup.

---

## Task 25: Ручная валидация в SillyTavern (дым)

- [ ] **Step 1: Загрузить расширение в ST**

Установить в `data/default/extensions/UR Image Studio`, перезагрузить ST. Открыть окно через 🎨 launcher в `qr--bar`.

Ожидания: ≥;вылетов нет в console. В окне 5 вкладок.

- [ ] **Step 2: Сценарий A — auto Stage1, manual Stage2**

1. В «Профили» создать бандл «Test A» с stage1Mode=auto, stage2Mode=manual, copyToStGallery=false.
2. В «API» задать text-connection (OpenAI cloud или LM Studio local) и image-connection (OpenAI с gpt-image / Gemini / ComfyUI local).
3. Применить бандл к текущему чату.
4. Сгенерировать обычный ответ персонажа (через основной ST-чат).
5. Ожидание: Stage1 стартует автоматически, в «Генерация» появляется построенный промпт в нижней панели, статус setStatus('Промпт готов — открой «Генерация»').
6. Жмём «Отправить в image» → картинка сохраняется в галерею, на посте чата появляется якорь 🖼️(1).

- [ ] **Step 3: Сценарий B — manual Stage1+Stage2**

Бандл с обоими manual. Жмём «Построить промпт» для поста #6 → нижняя панель заполнена → «Отправить в image» → якорь на посте #6.

- [ ] **Step 4: Сценарий C — очередь**

Stage2=auto-after. Жмём «В очередь» на постах #20, #22, #24. Видим «В очереди: 3» ↓ 2 ↓ 1 ↓ 0. Чекed что post е#24 has anchor.Interrupt: запускаем новую очередь из 3 задач, жмём «Остановить» во время первой — abort уходит и в fetch и в запущенную upstream ComfyUI `/interrupt` если comfyui-профиль активен.

- [ ] **Step 4.5: Сценарий D-pre — подгрузка списка моделей (Task 7.5)**

1. На карточке text-connection ввести endpoint `http://127.0.0.1:1234/v1`, apiKey -- любой. Жму «🔄 Обновить список» рядом с модельным select.
   - Ожидание: `<option>` заполняется тем, что LM Studio сейчас loaded (можно проверить, что в LM Studio→Server→Models показываются те же имена).
   - Загрузить в LM Studio ещё один `.gguf` через Server → Models → Add; в расширении снова жму refresh — должен появиться newly-loaded. Настройки→выгрузить другую .gguf — refresh без неё.
2. text-connection с OpenAI cloud endpoint+key. Жму «🔄 Обновить список» — fill с gpt-4o, gpt-4o-mini, оf还会有 dall-e-3**(image-connection в шаге 1 следующего сценария) и т.д. LL-дисклеймер `⚠️ не подходит к /images/generations` для чат-only — disabled selectable нельзя.
3. image-connection: endpoint+key OpenAI. Жму refresh — show только dall/gpt-image варианты selectable; остальные disabled-серым.
4. image-connection с Gemini endpoint+key. Жму refresh — варианты gemini-2.* с пометкой `⚠️ нет подтверждённой поддержки image-output` (disabled) для большинства; image-capable (gemini-2.0-flash-preview-image-generation) — selectable.
5. Fallback на input: выключить LM Studio server (или поменять endpoint на невалидный) — жму refresh → toastr.warning + select превращается в input для manual ввода. Можно ввести имя по памяти и сохранить.
6. После сохранения валидный пресет **persistится**; переключить на другую вкладку и вернуться — select должен показывать сохранённый `p.model` текущим (`selected`).

- [ ] **Step 5: Сценарий D — локальные LM Studio + ComfyUI**

1. text-connection: openai-like, endpoint `http://127.0.0.1:1234/v1`, apiKey dummy, model из LM Studio list.
2. image-connection: comfyui, endpoint `http://127.0.0.1:8188`, workflowJson — простой workflow (Load Checkpoint → CLIPTextEncode positive → KSampler → VAE Decode → SaveImage), скопировать из ComfyUI "Save (API Format)".
3. В workflowJson найти id ноды CLIPTextEncode-positive, ввести в textNodeId; outputNodeId — id SaveImage ноды.
4. Сценарий A повторить с этим бандлом. Картинка происходит локально, без облака. Проверить `/interrupt` на бутылочно-горлышко.

- [ ] **Step 6: Якорь и race-safe**

1. Сгенерировать картинку к посту #10, будто якорь появился.
2. Сгенерировать ещё одно сообщение в чат (т.е. дальше reply персонажа) — якорь должен остаться на посте #10 и не «уехать».
3. Отредактировать пост #10 (изменить mes) — hash change; если была pending Stage2 — после completion якорь не вешается (см. `pipeline.runStage2` check). Если была готовая запись — якорь остаётся, чтобы не потерять историю. (Опционально: в будущем — синхронизировать с `message.mes` change, но MVP — якорь остаётся до ручного удаления.)

- [ ] **Step 7: Логи и экспорт**

Export logs через профиль ST → подтвердить что нет critical errors.

---

## Task 26: Документация и финализация

- [ ] **Step 1: Обновить README (если есть)**

Если в `UR Image Studio/` нет README, создать краткий: что делает, как включить, ссылки на spec.

- [ ] **Step 2: Git tag**

Закоммитить (если пользователь явно просит), tag `v2-mvp`. Бранч — по умолчанию master как v1.

---

## Известные риски плана

- **Task 5 (ComfyUI provajder)** — самый рисковый, polling целевой в точном формате может отличаться между версиями ComfyUI. Реальная валидация в Task 25.4 — stamp on real instance.
- **Task 16 (post-anchor.js)** — ST может виртуализовать посты (scroll-virtualization); observer должен навешивать детекторы на каждый добавляемый post, а не single-shot на один render.
- **Task 22 (migration)** — миграция может оставить нерешённую references-profile связь; в этом случае созданный бандл остаётся без референсов — пользователю нужно создать manually. Не критично; в логе комментируется.
- **Task 13 (pipeline)** — `break` в `processQueue` для stage2=manual и `immediate !== false`: semantика — «очередь останавливается на готовом Stage1, ждёт ручной Stage2 для текущей задачи». Когда пользователь жмёт «Отправить в image» в редакторе → `runStage2` для текущего msgId; очередь возобновится по следующему `enqueue()` или кнопке «Продолжить очередь» (если добавим). MVP: просто статы unbidden → next enqueue (new task) продолжает. Документировать в README.

---

## Связанные документы

- Spec: `docs/superpowers/specs/2026-07-01-ur-image-studio-v2-design.md` (правда)
- V1 spec: `docs/superpowers/specs/2026-06-27-ur-image-studio-design.md` (пред.)
- V1 plan: `docs/superpowers/plans/2026-06-27-ur-image-studio.md` (пред.)