# UR Image Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Автономное SillyTavern-расширение, генерирующее изображения из сцен сообщений чата через двухстадийный flow (text-LLM → image-API) с пресетами, галереей и плавающим окном.

**Architecture:** Модульный ES-module-проект (`src/`), вдохновлён DS Comments (плавающее окно, пресеты в localforage, привязка к чату через метадату). Image-API/парсинг адаптированы из alhenassillyimages. `message.mes` не мутируется — картинки живут только в галерее расширения.

**Tech Stack:** Vanilla JS (ES modules), SillyTavern extension API, localforage (через `SillyTavern.libs.localforage`), Font Awesome (иконки ST), toastr (уведомления ST). Без сборки, без тест-фреймворка (верификация через `node --check` и ручную загрузку в SillyTavern).

**Conventions (из AGENTS.md DS Comments):** Работаем только на master. Коммитить ТОЛЬКО когда пользователь явно просит. Верифицировать `node --check` перед заявлением «готово». Русские комментарии и UI-строки.

---

## File Structure

| Файл | Ответственность |
|---|---|
| `manifest.json` | Метаданные расширения + lifecycle hooks |
| `index.js` | Lifecycle hooks (`onActivate`/`onEnable`/`onDisable`/`onClean`) + оркестрация init/cleanup |
| `style.css` | Все стили (окно, вкладки, карточки, mobile, lightbox) |
| `src/core.js` | `state`, `MODULE_NAME`, `defaultSettings`, persistence (extensionSettings), utils (`log`/`escapeHtml`/`debounce`/`fetchWithTimeout`/`getCtx`) |
| `src/presets.js` | CRUD пресетов (text/image/character/template) в localforage |
| `src/chat-binding.js` | Чтение/запись `chatMetadata.uris_binding`, применение пресетов к state при смене чата |
| `src/prompt-builder.js` | Сборка system-промпта text-LLM (шаблон + персонажи + инструкция JSON) |
| `src/text-api.js` | Стадия 1: вызов text-LLM (OpenAI `/chat/completions`, Gemini `generateContent`) |
| `src/image-api.js` | Стадия 2: вызов image-API (OpenAI `/images/generations`, Gemini imageConfig) |
| `src/references.js` | Сбор аватаров char/user → dataUrl |
| `src/parser.js` | Извлечение `data-iig-instruction` JSON из ответа text-LLM |
| `src/pipeline.js` | Двухстадийный flow + очередь пакетной генерации |
| `src/events.js` | ST events (ген завершена → автоген) + scroll-observer навигатора постов |
| `src/storage.js` | localforage галерея + save через ST `/api/images/upload` |
| `src/history.js` | Дропдаун последних N промптов (localforage) |
| `src/ui/window.js` | Плавающее окно: mount, drag, resize, mobile |
| `src/ui/tabs.js` | Каркас вкладок + переключение |
| `src/ui/tab-presets.js` | Управление всеми пресетами + привязка к чату |
| `src/ui/tab-generate.js` | Редактор промпта + режимы + кнопки генерации + очередь + история |
| `src/ui/tab-gallery.js` | Сетка карточек (mobile-адаптив) |
| `src/ui/lightbox.js` | Fullscreen просмотр + swipe |

**Адаптация к spec:** вместо `settings.html` (требует `renderExtensionTemplateAsync` + third-party структуру) генерируем минимальную ST-panel в DOM из JS (как alhenassillyimages). Все основные настройки — во вкладке «Пресеты» плавающего окна.

---

## Task 1: Скелет — manifest, core.js, index.js

**Files:**
- Create: `D:/VC CODE/UR Image Studio/manifest.json`
- Create: `D:/VC CODE/UR Image Studio/src/core.js`
- Create: `D:/VC CODE/UR Image Studio/index.js`

- [ ] **Step 1: manifest.json**

```json
{
    "display_name": "UR Image Studio",
    "loading_order": 100,
    "requires": [],
    "optional": [],
    "js": "index.js",
    "css": "style.css",
    "author": "local",
    "version": "0.1.0",
    "home_page": "",
    "auto_update": false,
    "hooks": {
        "install": "onInstall",
        "update": "onUpdate",
        "enable": "onEnable",
        "disable": "onDisable",
        "activate": "onActivate",
        "clean": "onClean"
    }
}
```

- [ ] **Step 2: src/core.js**

```js
// @ts-check
/**
 * UR Image Studio — ядро: state, defaults, persistence, utils.
 */

export const MODULE_NAME = 'ur_image_studio';
export const DISPLAY_NAME = 'UR Image Studio';

// Ключи localforage
export const LF_TEXT_PRESETS = 'uris_text_presets';
export const LF_IMAGE_PRESETS = 'uris_image_presets';
export const LF_CHARACTERS = 'uris_characters';
export const LF_TEMPLATES = 'uris_templates';
export const LF_GALLERY_PREFIX = 'uris_gallery_';      // + chatId
export const LF_HISTORY_PREFIX = 'uris_prompt_history_'; // + chatId
export const META_KEY = 'uris_binding';

export const VALID_ASPECT_RATIOS = ['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9'];
export const VALID_IMAGE_SIZES = ['1K','2K','4K'];

// Центральное состояние сессии
export const state = {
    settings: null,
    currentChatId: null,
    currentMsgId: null,        // выбранный/последний AI-пост в навигаторе
    queue: [],                 // очередь пакетной генерации: [{msgId, resolve, reject}]
    queueRunning: false,
    abortController: null,     // текущая стадия генерации (отмена)
};

// Дефолтные настройки расширения (extensionSettings[MODULE_NAME])
export const defaultSettings = Object.freeze({
    enabled: true,
    generationMode: 'manual',  // auto | confirm | manual
    maxRetries: 0,
    retryDelay: 1000,
    generationTimeout: 120000,
    historyLimit: 20,
    galleryLimit: 0,           // 0 = без лимита
});

// ── ST context ──
export function getCtx() { return SillyTavern.getContext(); }

// ── Логирование ──
const logBuffer = [];
const MAX_LOG = 300;
export function log(...a)   { push('INFO', a); console.log('[URIS]', ...a); }
export function warn(...a)  { push('WARN', a); console.warn('[URIS]', ...a); }
export function error(...a) { push('ERROR', a); console.error('[URIS]', ...a); }
function push(level, a) {
    const ts = new Date().toISOString();
    const msg = a.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
    logBuffer.push(`[${ts}] [${level}] ${msg}`);
    if (logBuffer.length > MAX_LOG) logBuffer.shift();
}
export function exportLogs() {
    const blob = new Blob([logBuffer.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `uris-logs-${new Date().toISOString().replace(/[:.]/g,'-')}.txt`;
    a.click(); URL.revokeObjectURL(url);
    toastr?.success('Логи экспортированы', DISPLAY_NAME);
}

// ── Settings persistence ──
export function loadSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings[MODULE_NAME]) ctx.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    const s = ctx.extensionSettings[MODULE_NAME];
    for (const k of Object.keys(defaultSettings)) if (!Object.hasOwn(s, k)) s[k] = defaultSettings[k];
    state.settings = s;
}
export function saveSettings() { getCtx().saveSettingsDebounced(); }
export function flushSettings() {
    try { getCtx().saveSettings(); } catch { /* debounced fallback */ }
}

// ── Utils ──
export function escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t == null ? '' : String(t);
    return d.innerHTML;
}
export function decodeEntities(s) {
    return s.replace(/&quot;/g,'"').replace(/&#34;/g,'"')
            .replace(/&apos;/g,"'").replace(/&#39;/g,"'")
            .replace(/&amp;/g,'&');
}
export function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
export async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try { return await fetch(url, { ...options, signal: ctrl.signal }); }
    catch (e) {
        if (e.name === 'AbortError') throw new Error(`Таймаут (${Math.round(timeoutMs/1000)}с)`);
        throw e;
    } finally { clearTimeout(timer); }
}
// Lenient JSON для ответов text-LLM (модель может завернуть JSON в ```json блоки или текст)
export function parseInstructionJson(raw) {
    const dec = decodeEntities(raw || '');
    const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
    let r = tryParse(dec);
    if (r) return r;
    // найти первый { ... } блок
    const start = dec.indexOf('{');
    const end = dec.lastIndexOf('}');
    if (start !== -1 && end > start) {
        r = tryParse(dec.slice(start, end + 1));
        if (r) return r;
    }
    r = tryParse(dec.replace(/'/g, '"'));
    return r;
}
// Снять HTML-разметку с промпта
export function sanitizePrompt(t) {
    if (!t) return '';
    return t.replace(/<[^>]*>/g, '').replace(/javascript:/gi, '').trim();
}

// ── Модалки-обёртки над ST (как DS Comments) ──
export async function showConfirmModal(text) {
    const ctx = getCtx();
    if (ctx.callGenericPopup) {
        const r = await ctx.callGenericPopup(text, ctx.POPUP_TYPE.CONFIRM);
        return r === 1 || r === true;
    }
    return confirm(text);
}
export async function showInputModal(text, def = '') {
    const ctx = getCtx();
    if (ctx.callGenericPopup) {
        return await ctx.callGenericPopup(text, ctx.POPUP_TYPE.INPUT, def, { okButton: 'ОК' });
    }
    return prompt(text, def);
}
```

- [ ] **Step 3: index.js (минимальный скелет)**

```js
// @ts-check
/**
 * UR Image Studio — точка входа: lifecycle hooks + оркестрация.
 */
import { state, MODULE_NAME, loadSettings, getCtx, log, warn, error } from './src/core.js';

export function onActivate() { log('onActivate'); init().catch(e => error('init:', e)); }
export function onUpdate()   { log('onUpdate (migrations reserved)'); }
export function onEnable()   { log('onEnable'); init().catch(e => error('init:', e)); }
export function onDisable()  { log('onDisable'); cleanup(); }
export function onInstall()  { log('onInstall'); }
export function onClean()    { log('onClean'); cleanup(); }

let _inited = false;
async function init() {
    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) { error('SillyTavern недоступен'); return; }
    const ctx = getCtx(); if (!ctx) { warn('context недоступен'); return; }
    await loadSettings();
    log('Initialized (skeleton).');
    _inited = true;
}

function cleanup() {
    if (state.abortController) { state.abortController.abort(); state.abortController = null; }
    log('Cleanup (skeleton).');
    _inited = false;
}
```

- [ ] **Step 4: Верифицировать синтаксис**

Run:
```bash
node --check "D:/VC CODE/UR Image Studio/manifest.json" 2>/dev/null; node --check "D:/VC CODE/UR Image Studio/src/core.js" && node --check "D:/VC CODE/UR Image Studio/index.js" && echo "OK"
```
Expected: `OK` (node --check на ES-модулях может ругаться на import вне module; используем флаг).

Если `node --check` ругается на `import` — запускать с `node --input-type=module --check`:
```bash
node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/core.js" && echo "OK"
```

---

## Task 2: presets.js — CRUD пресетов в localforage

**Files:**
- Create: `D:/VC CODE/UR Image Studio/src/presets.js`

- [ ] **Step 1: Реализация CRUD**

```js
// @ts-check
/**
 * Хранение пресетов в localforage. Четыре независимых списка:
 * text-коннекты, image-коннекты, персонажи, шаблоны промптов.
 */
import {
    LF_TEXT_PRESETS, LF_IMAGE_PRESETS, LF_CHARACTERS, LF_TEMPLATES, uid, log,
} from './core.js';

function lf() { return SillyTavern.libs.localforage; }

async function getAll(key) {
    const arr = await lf().getItem(key);
    return Array.isArray(arr) ? arr : [];
}
async function setAll(key, arr) { await lf().setItem(key, arr); }

export async function listTextPresets()      { return getAll(LF_TEXT_PRESETS); }
export async function listImagePresets()     { return getAll(LF_IMAGE_PRESETS); }
export async function listCharacters()       { return getAll(LF_CHARACTERS); }
export async function listTemplates()        { return getAll(LF_TEMPLATES); }

// ── Создание ──
export async function createTextPreset(data) {
    const arr = await getAll(LF_TEXT_PRESETS);
    const item = { id: uid(), name: data.name || 'Новый text-коннект', apiType: 'openai',
        endpoint: '', apiKey: '', model: '', ...data };
    arr.push(item); await setAll(LF_TEXT_PRESETS, arr); log('Создан text-пресет', item.id); return item;
}
export async function createImagePreset(data) {
    const arr = await getAll(LF_IMAGE_PRESETS);
    const item = { id: uid(), name: data.name || 'Новый image-коннект', apiType: 'openai',
        endpoint: '', apiKey: '', model: '', size: '1024x1024', quality: 'standard',
        aspectRatio: '1:1', imageSize: '1K', sendCharAvatar: false, sendUserAvatar: false,
        userAvatarFile: '', referenceMode: 'never', ...data };
    arr.push(item); await setAll(LF_IMAGE_PRESETS, arr); log('Создан image-пресет', item.id); return item;
}
export async function createCharacter(data) {
    const arr = await getAll(LF_CHARACTERS);
    const item = { id: uid(), role: 'custom', name: data.name || 'Новый персонаж',
        sceneName: '', description: '', ...data };
    arr.push(item); await setAll(LF_CHARACTERS, arr); log('Создан персонаж', item.id); return item;
}
export async function createTemplate(data) {
    const arr = await getAll(LF_TEMPLATES);
    const item = { id: uid(), name: data.name || 'Новый шаблон', content: data.content || '', ...data };
    arr.push(item); await setAll(LF_TEMPLATES, arr); log('Создан шаблон', item.id); return item;
}

// ── Обновление ──
async function updateByKey(key, id, patch) {
    const arr = await getAll(key);
    const i = arr.findIndex(x => x.id === id);
    if (i === -1) return null;
    arr[i] = { ...arr[i], ...patch, id };
    await setAll(key, arr); return arr[i];
}
export const updateTextPreset  = (id, p) => updateByKey(LF_TEXT_PRESETS, p.id ? p.id : id, p);
export const updateImagePreset = (id, p) => updateByKey(LF_IMAGE_PRESETS, id, p);
export const updateCharacter   = (id, p) => updateByKey(LF_CHARACTERS, id, p);
export const updateTemplate    = (id, p) => updateByKey(LF_TEMPLATES, id, p);
// удобные обёртки, принимающие {id,...}
export async function saveTextPreset(p)  { return updateByKey(LF_TEXT_PRESETS, p.id, p); }
export async function saveImagePreset(p) { return updateByKey(LF_IMAGE_PRESETS, p.id, p); }
export async function saveCharacter(p)   { return updateByKey(LF_CHARACTERS, p.id, p); }
export async function saveTemplate(p)    { return updateByKey(LF_TEMPLATES, p.id, p); }

// ── Удаление ──
async function deleteByKey(key, id) {
    const arr = await getAll(key);
    const next = arr.filter(x => x.id !== id);
    await setAll(key, next);
}
export const deleteTextPreset  = (id) => deleteByKey(LF_TEXT_PRESETS, id);
export const deleteImagePreset = (id) => deleteByKey(LF_IMAGE_PRESETS, id);
export const deleteCharacter   = (id) => deleteByKey(LF_CHARACTERS, id);
export const deleteTemplate    = (id) => deleteByKey(LF_TEMPLATES, id);

export async function getPreset(key, id) {
    const arr = await getAll(key);
    return arr.find(x => x.id === id) || null;
}
```

- [ ] **Step 2: Верифицировать**

```bash
node --check "D:/VC CODE/UR Image Studio/src/presets.js" 2>/dev/null || node --input-type=module --check < "D:/VC CODE/UR Image Studio/src/presets.js"; echo "done"
```
Expected: без синтаксических ошибок.

---

## Task 3: Дефолтный шаблон промпта + prompt-builder.js

**Files:**
- Create: `D:/VC CODE/UR Image Studio/src/default-template.js`
- Create: `D:/VC CODE/UR Image Studio/src/prompt-builder.js`

- [ ] **Step 1: default-template.js (приложенный файл, очищенный от экранирующих тегов)**

Это тело `<manga>`-блока без `<manga>`, `[MNG:...]`, `src="[IMG:GEN]"`, инструкции «Place it in middle...» и «Continue narrative after MNG block» — остаётся только шаблон построения промпта + правила. Стиль-пул `{{random::...}}` оставляем как есть (text-LLM выберет).

```js
// @ts-check
/**
 * Дефолтный шаблон построения промпта картинки.
 * Адаптирован из исходного файла «промпт на ген.txt»:
 * удалены <manga>, [MNG:...], [IMG:GEN], src=, экранирующие инструкции
 * и «Continue narrative after MNG block» (генерация идёт в расширении, не в посте).
 */

export const DEFAULT_TEMPLATE = `Ты — генератор промптов для изображений (манга-страницы).
Прочитай сцену из последнего сообщения чата и составь промпт для генерации одной вертикальной манга-страницы, отражающей текущий момент сцены.

Используй ровно этот шаблон вывода (верни ТОЛЬКО JSON-объект, без пояснений и без markdown-обёрток):
{
  "style": "[выбери ОДИН стиль из пула ниже, подставь полное описание]",
  "prompt": "[Vertical manga page with an unpredictable, highly asymmetrical layout of [4 to 5] panels. Strict rule: Panels must vary drastically in size, height, and orientation, avoiding a repetitive stacked look. The composition is driven by a chaotic arrangement where small inset panels cross over the borders of larger panels, creating layered depth. Some panels feature dynamic slanted diagonal borders, while others have open, borderless edges with empty space between them. Location: [location, time, season, weather, background]. Lighting: [detailed description of light sources, nature of light, chiaroscuro, high-contrast shadows, rim lighting, god rays, dust particles]. Characters: [for each character: name, gender, build, skin tone, hair color & length & style, eye size/color, facial features, special features, outfit, emotion]. Panels: [For each panel: type, panel shape, shot, camera angle, lighting color, characters in frame, their positions/actions/interactions/gaze. Add stylized short Russian SFX lettering overlaid on the action where appropriate]. [1 - 2] speech bubbles with flowing ornate Cyrillic script, fantasy calligraphy style, pointing to [Character name] says \\" [text 3-8 words] \\". Adult 18+ fictional characters]",
  "aspect_ratio": "9:16",
  "image_size": "2K"
}

Пул стилей (выбери ОДИН, подставь его ПОЛНОЕ описание в поле "style"):
{{random::Chainsaw Man manga art style, raw expressive brushwork, high-contrast gritty ink splashes, grungy urban newsprint texture, violent kinetic composition::Baroque oil painting on canvas aesthetic with contemporary manga character proportions, deep chiaroscuro, vast areas of deep neutral shadow punctuated by a single crisp white light source, impasto visible brushstroke texture, rich full-spectrum oil palette, natural un-tinted flesh tones, stark contrast with completely neutral lighting::emotional manhwa style, sharp focused character lineart, controlled watercolor edges, dry brush ink wash textures, visible prism halftone manga dots, crisp CMYK color separation::modern aesthetic anime key visual, dreamy pastel gradient shading, fluffy surreal cloud textures, soft glow bloom effect, vaporwave-infused color palette, clean digital lineart::cinematic anime illustration, crisp backlit lighting, sharp volumetric sun rays, pristine clear amber and clean white light leaks, sharp focus with atmospheric soft bloom, high-end concept art aesthetic::dark josei manga, mature emotional subtlety, fine precise ink linework, desaturated blue-grey palette with warm amber intimate glow accents::vintage 70s shojo romance aesthetic, elegant thin lineart, smooth controlled watercolor blending, intricate large sparkling eyes, soft milky pastel grading::highly detailed mature seinen manga, sharp crisp ink lines, moody atmosphere, dense diagonal zipatone shading for shadows, dramatic framing::sumi-e zen ink wash painting aesthetic, radical minimalism, bold expressive single-stroke calligraphic brushwork in deep black sumi ink only::Studio Trigger anime hyper-expressive hand-drawn animation aesthetic, thick extremely variable-weight ink outlines, dense visual noise explosion during action sequences::professional josei/seinen manga in pure black-and-white ink, heavily layered screentone dot gradients, vigorous cross-hatching in deep shadow zones, chiaroscuro contrast::Vagabond ink brush manga, gestural wet calligraphy brushwork, spontaneous ink splash textures, sparse Zen composition}}

Правила для prompt (только для построения промпта манга-страницы):
- Всегда описывай динамичные позы.
- Минимум 2 кадра — крупный или очень крупный план для деталей внешности и взаимодействий. В больших панелях — 1 средний + 1 крупный.
- Не более двух персонажей на одной панели.

Общие правила:
- Весь prompt на английском.
- Текст в speech bubbles (в кавычках) — на русском.
- Никакого закодированного диалогового текста.
- Никакого markdown.`;
```

- [ ] **Step 2: prompt-builder.js**

```js
// @ts-check
/**
 * Сборка system-промпта для text-LLM: шаблон + персонажи + инструкция.
 */
import { DEFAULT_TEMPLATE } from './default-template.js';
import { state, getCtx, sanitizePrompt } from './core.js';

// Подставить {{char}}/{{user}} и активных персонажей в шаблон.
// activeCharacters: массив {name, sceneName, description, role}
export function buildSystemPrompt(templateContent, activeCharacters = []) {
    const ctx = getCtx();
    const charName = ctx.characters?.[ctx.characterId]?.name || '{{char}}';
    const userName = ctx.name1 || '{{user}}';

    let out = templateContent || DEFAULT_TEMPLATE;
    out = out.replaceAll('{{char}}', charName).replaceAll('{{user}}', userName);

    const refs = activeCharacters
        .filter(c => c && (c.sceneName || c.description))
        .map(c => `- "${c.sceneName || c.name}" (${c.role === 'char' ? '{{char}}' : c.role === 'user' ? '{{user}}' : c.name}): ${sanitizePrompt(c.description)}`)
        .join('\n');

    if (refs) {
        out += `\n\n=== Описание персонажей (используй ТОЧНО эту внешность, не выдумывай) ===\n${refs}\n`;
    }
    out += `\n\nВАЖНО: Верни ТОЛЬКО JSON-объект, никакого дополнительного текста, без \`\`\`json блоков.`;
    return out;
}

// Собрать user-сообщение: сцена из message.mes (без HTML).
export function buildUserPrompt(messageText) {
    const clean = sanitizePrompt(messageText || '').slice(0, 12000);
    return `Сцена из чата:\n"""\n${clean}\n"""\n\nСоставь промпт для манга-страницы по этой сцене.`;
}
```

- [ ] **Step 3: Верифицировать**

```bash
node --check "D:/VC CODE/UR Image Studio/src/default-template.js" 2>/dev/null; node --check "D:/VC CODE/UR Image Studio/src/prompt-builder.js" 2>/dev/null; echo "done"
```

---

## Task 4: chat-binding.js — привязка пресетов к чату

**Files:**
- Create: `D:/VC CODE/UR Image Studio/src/chat-binding.js`

- [ ] **Step 1: Реализация**

```js
// @ts-check
/**
 * Привязка пресетов к конкретному чату через chatMetadata.uris_binding.
 * При смене чата — чтение и применение пресетов к state.
 */
import { state, getCtx, META_KEY, log, warn, uid } from './core.js';
import { listTextPresets, listImagePresets, listCharacters, listTemplates, createCharacter } from './presets.js';

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

// Дефолтная привязка: первые пресеты каждого типа, char+user слоты.
export async function defaultBinding() {
    const [texts, images, chars, templates] = await Promise.all([
        listTextPresets(), listImagePresets(), listCharacters(), listTemplates(),
    ]);
    const charSlot = chars.find(c => c.role === 'char') || null;
    const userSlot = chars.find(c => c.role === 'user') || null;
    return {
        textPresetId: texts[0]?.id || null,
        imagePresetId: images[0]?.id || null,
        characterIds: [charSlot?.id, userSlot?.id].filter(Boolean),
        templateId: templates[0]?.id || null,
    };
}

// Применить привязку текущего чата к state.currentBinding. Если её нет — создать дефолтную и сохранить.
export async function applyBindingForCurrentChat() {
    let binding = getBinding();
    if (!binding) {
        binding = await defaultBinding();
        setBinding(binding);
    }
    state.currentBinding = binding;
    log('Применена привязка', binding);
    return binding;
}

// Гарантировать существование слотов char/user в списке персонажей (создать при первом запуске).
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
node --check "D:/VC CODE/UR Image Studio/src/chat-binding.js" 2>/dev/null; echo "done"
```

---

## Task 5: text-api.js — стадия 1

**Files:**
- Create: `D:/VC CODE/UR Image Studio/src/text-api.js`

- [ ] **Step 1: Реализация (OpenAI + Gemini)**

```js
// @ts-check
/**
 * Стадия 1: вызов text-LLM для построения промпта картинки.
 * Возвращает «сырую» строку ответа модели.
 */
import { fetchWithTimeout, state, log, error } from './core.js';

async function callWithRetry(fn, label) {
    const s = state.settings;
    let lastErr;
    for (let attempt = 0; attempt <= s.maxRetries; attempt++) {
        try { return await fn(attempt); }
        catch (e) {
            lastErr = e;
            log(`${label} попытка ${attempt+1} провалена:`, e.message);
            if (!/429|503|502|504|timeout|Таймаут|network/i.test(e.message) || attempt === s.maxRetries) break;
            const delay = s.retryDelay * Math.pow(2, attempt);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

export async function generatePromptText(textPreset, systemPrompt, userPrompt, onStatus) {
    if (!textPreset) throw new Error('Text-пресет не выбран');
    if (!textPreset.endpoint || !textPreset.apiKey) throw new Error('Text-коннект: URL и ключ обязательны');
    if (!textPreset.model) throw new Error('Text-коннект: модель не выбрана');
    const s = state.settings;
    return callWithRetry(async (attempt) => {
        onStatus?.(`Промпт${attempt ? ` (повтор ${attempt})` : ''}...`);
        if (textPreset.apiType === 'gemini') return callGemini(textPreset, systemPrompt, userPrompt, s.generationTimeout);
        return callOpenAI(textPreset, systemPrompt, userPrompt, s.generationTimeout);
    }, 'text-api');
}

async function callOpenAI(p, system, user, timeout) {
    const url = `${p.endpoint.replace(/\/$/,'')}/v1/chat/completions`;
    const body = {
        model: p.model,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        temperature: 0.8,
    };
    const r = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, timeout);
    if (!r.ok) throw new Error(`Text API ${r.status}: ${(await r.text()).slice(0,300)}`);
    const j = await r.json();
    const txt = j.choices?.[0]?.message?.content;
    if (!txt) throw new Error('Text API: пустой ответ');
    return txt;
}

async function callGemini(p, system, user, timeout) {
    const url = `${p.endpoint.replace(/\/$/,'')}/v1beta/models/${p.model}:generateContent`;
    const body = {
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.8, responseMimeType: 'application/json' },
    };
    const r = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, timeout);
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0,300)}`);
    const j = await r.json();
    const parts = j.candidates?.[0]?.content?.parts || [];
    const txt = parts.map(x => x.text || '').join('');
    if (!txt) throw new Error('Gemini: пустой ответ');
    return txt;
}
```

- [ ] **Step 2: Верифицировать**

```bash
node --check "D:/VC CODE/UR Image Studio/src/text-api.js" 2>/dev/null; echo "done"
```

---

## Task 6: references.js — аватары для image-API

**Files:**
- Create: `D:/VC CODE/UR Image Studio/src/references.js`

- [ ] **Step 1: Реализация (из alhenassillyimages, упрощённо)**

```js
// @ts-check
/**
 * Сбор аватаров {{char}}/{{user}} как dataUrl для image-to-image.
 */
import { getCtx, log } from './core.js';

async function imageToDataUrl(url) {
    try {
        const blob = await (await fetch(url)).blob();
        return await new Promise((res, rej) => {
            const r = new FileReader();
            r.onloadend = () => res(r.result);
            r.onerror = rej; r.readAsDataURL(blob);
        });
    } catch { return null; }
}
export function dataUrlToBase64(d) { const i = (d||'').indexOf(','); return i >= 0 ? d.slice(i+1) : d; }

export async function getCharacterAvatarDataUrl() {
    const ctx = getCtx();
    if (ctx.characterId == null) return null;
    if (typeof ctx.getCharacterAvatar === 'function') {
        const u = ctx.getCharacterAvatar(ctx.characterId);
        if (u) return await imageToDataUrl(u);
    }
    const ch = ctx.characters?.[ctx.characterId];
    return ch?.avatar ? await imageToDataUrl(`/characters/${encodeURIComponent(ch.avatar)}`) : null;
}

export async function getUserAvatarDataUrl(userAvatarFile) {
    if (!userAvatarFile) return null;
    return await imageToDataUrl(`/User Avatars/${encodeURIComponent(userAvatarFile)}`);
}

export async function fetchUserAvatars() {
    try {
        const r = await fetch('/api/avatars/get', { method: 'POST', headers: getCtx().getRequestHeaders() });
        return r.ok ? await r.json() : [];
    } catch { return []; }
}

// Собрать референсы по image-пресету. Возвращает [{image, role}].
export async function collectReferences(imagePreset) {
    const refs = [];
    if (!imagePreset || imagePreset.referenceMode === 'never') return refs;
    if (imagePreset.sendCharAvatar) { const d = await getCharacterAvatarDataUrl(); if (d) refs.push({ image: d, role: 'char' }); }
    if (imagePreset.sendUserAvatar) { const d = await getUserAvatarDataUrl(imagePreset.userAvatarFile); if (d) refs.push({ image: d, role: 'user' }); }
    log(`Собрано референсов: ${refs.length}`);
    return refs;
}

export function buildReferenceInstruction(refs) {
    if (!refs.length) return '';
    const ctx = getCtx();
    const charName = ctx.characters?.[ctx.characterId]?.name || 'Character';
    const userName = ctx.name1 || 'User';
    const parts = [];
    for (const r of refs) {
        if (r.role === 'char') parts.push(`Одно референс-изображение показывает "${charName}". Используй ТОЛЬКО для внешности этого персонажа.`);
        else if (r.role === 'user') parts.push(`Одно референс-изображение показывает "${userName}". Используй ТОЛЬКО для внешности пользователя.`);
    }
    return `[Руководство по референсам: ${parts.join(' ')} ВАЖНО: неродственные персонажи должны иметь собственную уникальную внешность.]`;
}
```

- [ ] **Step 2: Верифицировать**

```bash
node --check "D:/VC CODE/UR Image Studio/src/references.js" 2>/dev/null; echo "done"
```

---

## Task 7: image-api.js — стадия 2

**Files:**
- Create: `D:/VC CODE/UR Image Studio/src/image-api.js`

- [ ] **Step 1: Реализация (адаптация из alhenassillyimages, OpenAI+Gemini)**

```js
// @ts-check
/**
 * Стадия 2: генерация изображения по промпту.
 */
import { fetchWithTimeout, state, log, VALID_ASPECT_RATIOS, VALID_IMAGE_SIZES } from './core.js';
import { dataUrlToBase64, buildReferenceInstruction } from './references.js';

async function callWithRetry(fn, label) {
    const s = state.settings;
    let lastErr;
    for (let attempt = 0; attempt <= s.maxRetries; attempt++) {
        try { return await fn(attempt); }
        catch (e) {
            lastErr = e;
            log(`${label} попытка ${attempt+1}: ${e.message}`);
            if (!/429|503|502|504|timeout|Таймаут|network/i.test(e.message) || attempt === s.maxRetries) break;
            await new Promise(r => setTimeout(r, s.retryDelay * Math.pow(2, attempt)));
        }
    }
    throw lastErr;
}

export async function generateImage(imagePreset, instruction, refs, onStatus) {
    if (!imagePreset) throw new Error('Image-пресет не выбран');
    if (!imagePreset.endpoint || !imagePreset.apiKey) throw new Error('Image-коннект: URL и ключ обязательны');
    if (!imagePreset.model) throw new Error('Image-коннект: модель не выбрана');
    const s = state.settings;
    return callWithRetry(async (attempt) => {
        onStatus?.(`Картинка${attempt ? ` (повтор ${attempt})` : ''}...`);
        if (imagePreset.apiType === 'gemini') return callGemini(imagePreset, instruction, refs, s.generationTimeout);
        return callOpenAI(imagePreset, instruction, refs, s.generationTimeout);
    }, 'image-api');
}

function composePrompt(prompt, style) { return style ? `[Style: ${style}] ${prompt}` : prompt; }

async function callOpenAI(p, instr, refs, timeout) {
    const url = `${p.endpoint.replace(/\/$/,'')}/v1/images/generations`;
    let size = p.size || '1024x1024';
    const ar = instr.aspectRatio || '1:1';
    if (ar === '16:9') size = '1792x1024';
    else if (ar === '9:16') size = '1024x1792';
    else if (ar === '1:1') size = '1024x1024';
    const body = {
        model: p.model, prompt: composePrompt(instr.prompt, instr.style), n: 1,
        size, quality: instr.quality || p.quality || 'standard', response_format: 'b64_json',
    };
    if (refs.length) body.image = refs[0].image;
    const r = await fetchWithTimeout(url, {
        method: 'POST', headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, timeout);
    if (!r.ok) throw new Error(`Image API ${r.status}: ${(await r.text()).slice(0,300)}`);
    const j = await r.json();
    const dl = j.data || [];
    if (!dl.length) { if (j.url) return j.url; throw new Error('Image API: нет данных'); }
    return dl[0].b64_json ? `data:image/png;base64,${dl[0].b64_json}` : dl[0].url;
}

async function callGemini(p, instr, refs, timeout) {
    const url = `${p.endpoint.replace(/\/$/,'')}/v1beta/models/${p.model}:generateContent`;
    let ar = instr.aspectRatio || p.aspectRatio || '1:1'; if (!VALID_ASPECT_RATIOS.includes(ar)) ar = '1:1';
    let is = instr.imageSize || p.imageSize || '1K'; if (!VALID_IMAGE_SIZES.includes(is)) is = '1K';
    const parts = [];
    for (const ref of refs.slice(0, 4)) {
        parts.push({ inlineData: { mimeType: 'image/png', data: dataUrlToBase64(ref.image) } });
    }
    let fp = composePrompt(instr.prompt, instr.style);
    if (refs.length) fp = `${buildReferenceInstruction(refs)}\n\n${fp}`;
    parts.push({ text: fp });
    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio: ar, imageSize: is },
        },
    };
    const r = await fetchWithTimeout(url, {
        method: 'POST', headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, timeout);
    if (!r.ok) throw new Error(`Gemini img ${r.status}: ${(await r.text()).slice(0,300)}`);
    const j = await r.json();
    const cands = j.candidates || [];
    if (!cands.length) throw new Error('Gemini: нет кандидатов');
    for (const part of (cands[0].content?.parts || [])) {
        if (part.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        if (part.inline_data) return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
    }
    throw new Error('Gemini: нет изображения в ответе');
}
```

- [ ] **Step 2: Верифицировать**

```bash
node --check "D:/VC CODE/UR Image Studio/src/image-api.js" 2>/dev/null; echo "done"
```

---

## Task 8: parser.js — извлечение инструкции из ответа text-LLM

**Files:**
- Create: `D:/VC CODE/UR Image Studio/src/parser.js`

- [ ] **Step 1: Реализация**

```js
// @ts-check
/**
 * Извлечение структурированной инструкции из ответа text-LLM.
 * Модель может вернуть: чистый JSON, JSON в ```json, или <img data-iig-instruction='{...}'>.
 */
import { parseInstructionJson, sanitizePrompt, log, warn } from './core.js';

// Объект инструкции в единый нормализованный вид.
export function normalizeInstruction(d) {
    if (!d) return null;
    return {
        style: sanitizePrompt(d.style || ''),
        prompt: sanitizePrompt(d.prompt || ''),
        aspectRatio: d.aspect_ratio || d.aspectRatio || null,
        imageSize: d.image_size || d.imageSize || null,
        quality: d.quality || null,
    };
}

export function parseInstructionFromText(text) {
    const raw = String(text || '');
    // 1) <img data-iig-instruction='{json}'>
    const m = raw.match(/data-iig-instruction\s*=\s*['"]([\s\S]*?)['"]/i);
    if (m) {
        const d = parseInstructionJson(m[1]);
        if (d) return normalizeInstruction(d);
    }
    // 2) сырой JSON (возможно в ```json блоке)
    const d2 = parseInstructionJson(raw);
    if (d2) return normalizeInstruction(d2);
    warn('Не удалось распарсить инструкцию из ответа');
    return null;
}
```

- [ ] **Step 2: Верифицировать**

```bash
node --check "D:/VC CODE/UR Image Studio/src/parser.js" 2>/dev/null; echo "done"
```

---

## Task 9: storage.js — галерея в localforage + save в ST

**Files:**
- Create: `D:/VC CODE/UR Image Studio/src/storage.js`

- [ ] **Step 1: Реализация**

```js
// @ts-check
/**
 * Галерея генераций в localforage (персистентно) + сохранение файла через ST.
 */
import { LF_GALLERY_PREFIX, uid, getCtx, log, warn } from './core.js';

function key(chatId) { return LF_GALLERY_PREFIX + chatId; }
function lf() { return SillyTavern.libs.localforage; }

export async function getGallery(chatId) {
    const arr = await lf().getItem(key(chatId));
    return Array.isArray(arr) ? arr : [];
}
export async function setGallery(chatId, arr) { await lf().setItem(key(chatId), arr); }

export async function addToGallery(chatId, entry) {
    const arr = await getGallery(chatId);
    const full = { id: uid(), ts: Date.now(), saved: false, ...entry };
    arr.unshift(full); // новые сверху
    // galleryLimit применяется в pipeline/отдельной функцией; здесь — без усечения
    await setGallery(chatId, arr);
    log('Добавлено в галерею', full.id);
    return full;
}

export async function removeFromGallery(chatId, id) {
    const arr = await getGallery(chatId);
    const next = arr.filter(x => x.id !== id);
    await setGallery(chatId, next);
    log('Удалено из галереи', id);
}

export async function updateGalleryEntry(chatId, id, patch) {
    const arr = await getGallery(chatId);
    const i = arr.findIndex(x => x.id === id);
    if (i === -1) return null;
    arr[i] = { ...arr[i], ...patch, id };
    await setGallery(chatId, arr);
    return arr[i];
}

// Сохранить dataUrl как файл в постоянное хранилище ST. Возвращает путь.
export async function saveImageToFile(dataUrl) {
    const ctx = getCtx();
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) throw new Error('Некорректный data URL');
    const [, format, base64Data] = match;
    const charName = ctx.characters?.[ctx.characterId]?.name || 'generated';
    const filename = `uris_${new Date().toISOString().replace(/[:.]/g,'-')}`;
    const r = await fetch('/api/images/upload', {
        method: 'POST', headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ image: base64Data, format, ch_name: charName, filename }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Загрузка не удалась: ${r.status}`); }
    const result = await r.json();
    log('Файл сохранён:', result.path);
    return result.path;
}

// Удалить всю галерею чата.
export async function clearGallery(chatId) {
    await lf().removeItem(key(chatId));
    log('Галерея очищена', chatId);
}
```

- [ ] **Step 2: Верифицировать**

```bash
node --check "D:/VC CODE/UR Image Studio/src/storage.js" 2>/dev/null; echo "done"
```

---

## Task 10: history.js — последние промпты

**Files:**
- Create: `D:/VC CODE/UR Image Studio/src/history.js`

- [ ] **Step 1: Реализация**

```js
// @ts-check
/**
 * История последних отредактированных промптов (дропдаун в редакторе).
 */
import { LF_HISTORY_PREFIX, state } from './core.js';

function key(chatId) { return LF_HISTORY_PREFIX + chatId; }
function lf() { return SillyTavern.libs.localforage; }

export async function getHistory(chatId) {
    const arr = await lf().getItem(key(chatId));
    return Array.isArray(arr) ? arr : [];
}

// Добавить промпт в историю (дедуп, лимит).
export async function pushHistory(chatId, promptText) {
    if (!promptText) return;
    let arr = await getHistory(chatId);
    arr = arr.filter(x => x !== promptText);
    arr.unshift(promptText);
    const limit = state.settings.historyLimit || 20;
    arr = arr.slice(0, limit);
    await lf().setItem(key(chatId), arr);
}

export async function clearHistory(chatId) { await lf().removeItem(key(chatId)); }
```

- [ ] **Step 2: Верифицировать**

```bash
node --check "D:/VC CODE/UR Image Studio/src/history.js" 2>/dev/null; echo "done"
```

---

## Task 11: pipeline.js — двухстадийный flow + очередь

**Files:**
- Create: `D:/VC CODE/UR Image Studio/src/pipeline.js`

- [ ] **Step 1: Реализация**

```js
// @ts-check
/**
 * Двухстадийный flow генерации + очередь пакетной генерации.
 *  msgId → text-LLM → instruction → (редактор) → image-API → галерея.
 * message.mes НЕ мутируется.
 */
import { state, getCtx, log, error, sanitizePrompt } from './core.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt-builder.js';
import { generatePromptText } from './text-api.js';
import { generateImage } from './image-api.js';
import { parseInstructionFromText } from './parser.js';
import { collectReferences } from './references.js';
import { addToGallery } from './storage.js';
import { pushHistory } from './history.js';
import { listTextPresets, listImagePresets, listCharacters, listTemplates } from './presets.js';

// Разрешить пресеты по текущей привязке.
export async function resolveActivePresets() {
    const b = state.currentBinding || {};
    const [texts, images, chars, templates] = await Promise.all([
        listTextPresets(), listImagePresets(), listCharacters(), listTemplates(),
    ]);
    const textPreset = texts.find(x => x.id === b.textPresetId) || texts[0] || null;
    const imagePreset = images.find(x => x.id === b.imagePresetId) || images[0] || null;
    const activeChars = chars.filter(c => (b.characterIds || []).includes(c.id));
    const template = templates.find(t => t.id === b.templateId) || templates[0] || null;
    return { textPreset, imagePreset, activeChars, templateContent: template?.content || null };
}

// Стадия 1: получить инструкцию из сообщения. Возвращает normalized instruction или null.
export async function runStage1(msgId, onStatus) {
    const ctx = getCtx();
    const msg = ctx.chat?.[msgId];
    if (!msg) throw new Error('Сообщение не найдено');
    const { textPreset, activeChars, templateContent } = await resolveActivePresets();
    const system = buildSystemPrompt(templateContent, activeChars);
    const user = buildUserPrompt(msg.mes);
    const raw = await generatePromptText(textPreset, system, user, onStatus);
    const instr = parseInstructionFromText(raw);
    if (!instr) throw new Error('Не удалось распарсить промпт из ответа LLM');
    log('Stage 1 готова:', { style: instr.style?.slice(0,40), prompt: instr.prompt?.slice(0,40) });
    return instr;
}

// Стадия 2: сгенерировать картинку по инструкции и положить в галерею.
export async function runStage2(msgId, instruction, onStatus) {
    const { imagePreset } = await resolveActivePresets();
    const refs = await collectReferences(imagePreset);
    const dataUrl = await generateImage(imagePreset, instruction, refs, onStatus);
    const refsSig = refs.map(r => r.role).sort().join(',');
    const chatId = getCtx().chatId;
    const entry = await addToGallery(chatId, {
        src: dataUrl, prompt: instruction.prompt, style: instruction.style,
        aspectRatio: instruction.aspectRatio, imageSize: instruction.imageSize,
        refsSig, sourceMsgId: msgId,
    });
    // сохранить промпт в историю
    await pushHistory(chatId, instruction.prompt);
    log('Stage 2 готова, entry', entry.id);
    return entry;
}

// Полный flow для одного сообщения (используется в auto-режиме или очереди).
export async function runFullPipeline(msgId, onStatus) {
    const instr = await runStage1(msgId, onStatus);
    return await runStage2(msgId, instr, onStatus);
}

// ── Очередь пакетной генерации ──
export function enqueue(msgId) {
    return new Promise((resolve, reject) => {
        state.queue.push({ msgId, resolve, reject });
        processQueue();
    });
}
async function processQueue() {
    if (state.queueRunning) return;
    state.queueRunning = true;
    try {
        while (state.queue.length) {
            const item = state.queue.shift();
            state.abortController = new AbortController();
            try {
                const entry = await runFullPipeline(item.msgId,
                    (s) => { /* статус можно прокидывать в UI */ log('Q:', s); });
                item.resolve(entry);
            } catch (e) {
                error('Q item failed:', e.message);
                item.reject(e);
            }
            state.abortController = null;
        }
    } finally { state.queueRunning = false; }
}
```

- [ ] **Step 2: Верифицировать**

```bash
node --check "D:/VC CODE/UR Image Studio/src/pipeline.js" 2>/dev/null; echo "done"
```

---

## Task 12: events.js — ST events + навигатор постов

**Files:**
- Create: `D:/VC CODE/UR Image Studio/src/events.js`

- [ ] **Step 1: Реализация**

```js
// @ts-check
/**
 * Обработка ST-событий: автоген при завершении генерации + навигатор постов.
 */
import { state, getCtx, log } from './core.js';
import { runFullPipeline } from './pipeline.js';

let _bound = false;
let _observer = null;

export function bindEvents(onAutoGenerate) {
    const ctx = getCtx();
    if (!ctx.eventSource || _bound) return;
    _bound = true;
    // Автоген при завершении генерации (новый AI-пост)
    const et = ctx.event_types;
    const handler = (data) => {
        if (!state.settings.enabled) return;
        if (state.settings.generationMode !== 'auto') return;
        // найти последнее AI-сообщение
        const chat = ctx.chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user) {
                state.currentMsgId = i;
                onAutoGenerate?.(i);
                break;
            }
        }
    };
    // GENERATION_ENDED срабатывает после любой генерации; фильтруем по auto-режиму выше.
    ctx.eventSource.makeLast(et.GENERATION_ENDED, handler);
    // На смену чата — обновить currentMsgId
    ctx.eventSource.on(et.CHAT_CHANGED, () => {
        state.currentChatId = ctx.chatId;
        const chat = ctx.chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user) { state.currentMsgId = i; break; }
        }
        log('CHAT_CHANGED, last AI msg', state.currentMsgId);
    });
    log('Events bound.');
}

export function unbindEvents() {
    _bound = false;
    if (_observer) { _observer.disconnect(); _observer = null; }
}

// Навигатор: переключить выбранный пост вперёд/назад среди AI-сообщений. Возвращает новый msgId или null.
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

- [ ] **Step 2: Верифицировать**

```bash
node --check "D:/VC CODE/UR Image Studio/src/events.js" 2>/dev/null; echo "done"
```

---

## Task 13: ui/window.js — плавающее окно

**Files:**
- Create: `D:/VC CODE/UR Image Studio/src/ui/window.js`

- [ ] **Step 1: Реализация (mount/drag/resize/mobile)**

```js
// @ts-check
/**
 * Плавающее окно: mount, drag (за header), resize (угловой хэндл), mobile overlay.
 */
import { state, saveSettings, escapeHtml } from '../core.js';

const WIN_ID = 'urisWindow';
export function isMobileViewport() { return window.innerWidth < 768; }

export function mountPanel() {
    let el = document.getElementById(WIN_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = WIN_ID;
    el.className = 'uris-window';
    el.innerHTML = `
        <div class="uris-header" id="urisHeader">
            <span class="uris-title">🎨 UR Image Studio</span>
            <div class="uris-header-actions">
                <span class="uris-status" id="urisStatus"></span>
                <button class="uris-icon-btn" id="urisClose" title="Свернуть">✕</button>
            </div>
        </div>
        <div class="uris-tabs" id="urisTabs"></div>
        <div class="uris-body" id="urisBody"></div>
        <div class="uris-resizer" id="urisResizer"></div>`;
    document.body.appendChild(el);
    bindWindowEvents(el);
    applyMobileClass(el);
    restoreGeometry(el);
    return el;
}

export function removePanel() {
    const el = document.getElementById(WIN_ID);
    if (el) el.remove();
}

export function isPanelVisible() {
    const el = document.getElementById(WIN_ID);
    return !!el && !el.classList.contains('uris-hidden');
}

export function syncPanelVisibility() {
    const el = document.getElementById(WIN_ID);
    if (!el) return;
    const collapsed = state.settings.collapsed;
    el.classList.toggle('uris-hidden', collapsed);
    const launcher = document.getElementById('uris_launcher');
    if (launcher) launcher.classList.toggle('uris_launcher_active', !collapsed);
}

function applyMobileClass(el) {
    el.classList.toggle('uris-mobile', isMobileViewport());
}

export function initViewportSync() {
    window.addEventListener('resize', () => {
        const el = document.getElementById(WIN_ID);
        if (el) applyMobileClass(el);
    });
}

function restoreGeometry(el) {
    const g = state.settings.windowGeometry;
    if (g && !isMobileViewport()) {
        el.style.left = g.left + 'px'; el.style.top = g.top + 'px';
        el.style.width = g.width + 'px'; el.style.height = g.height + 'px';
    }
}

function saveGeometry(el) {
    if (isMobileViewport()) return;
    const r = el.getBoundingClientRect();
    state.settings.windowGeometry = { left: r.left, top: r.top, width: r.width, height: r.height };
    saveSettings();
}

function bindWindowEvents(el) {
    // Закрытие
    el.querySelector('#urisClose').addEventListener('click', () => {
        state.settings.collapsed = true; saveSettings(); syncPanelVisibility();
    });
    // Drag за header
    const header = el.querySelector('#urisHeader');
    header.addEventListener('mousedown', (e) => startDrag(e, el));
    header.addEventListener('touchstart', (e) => startDrag(e, el), { passive: true });
    // Resize
    const resizer = el.querySelector('#urisResizer');
    resizer.addEventListener('mousedown', (e) => startResize(e, el));
}

function startDrag(e, el) {
    if (isMobileViewport()) return;
    if (e.target.closest('.uris-icon-btn')) return;
    const p = point(e);
    const r = el.getBoundingClientRect();
    const dx = p.x - r.left, dy = p.y - r.top;
    const move = (ev) => {
        const np = point(ev);
        el.style.left = Math.max(0, np.x - dx) + 'px';
        el.style.top = Math.max(0, np.y - dy) + 'px';
        el.style.right = 'auto'; el.style.bottom = 'auto';
    };
    const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.removeEventListener('touchmove', move);
        document.removeEventListener('touchend', up);
        saveGeometry(el);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', move, { passive: true });
    document.addEventListener('touchend', up);
}

function startResize(e, el) {
    e.stopPropagation(); e.preventDefault();
    const p = point(e);
    const r = el.getBoundingClientRect();
    const sw = r.width, sh = r.height;
    const move = (ev) => {
        const np = point(ev);
        el.style.width = Math.max(320, sw + (np.x - p.x)) + 'px';
        el.style.height = Math.max(360, sh + (np.y - p.y)) + 'px';
    };
    const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        saveGeometry(el);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
}

function point(e) {
    if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
}

export function setStatus(text) {
    const el = document.getElementById('urisStatus');
    if (el) el.textContent = text || '';
}
```

- [ ] **Step 2: Верифицировать**

```bash
node --check "D:/VC CODE/UR Image Studio/src/ui/window.js" 2>/dev/null; echo "done"
```

---

## Task 14: ui/tabs.js — каркас вкладок

**Files:**
- Create: `D:/VC CODE/UR Image Studio/src/ui/tabs.js`

- [ ] **Step 1: Реализация**

```js
// @ts-check
/**
 * Каркас вкладок плавающего окна: Генерация / Галерея / Пресеты.
 * Каждая вкладка регистрирует {id,label,render} и получает корневой элемент.
 */
const registry = [];
let _active = null;

export function registerTab({ id, label, render }) {
    if (!registry.find(t => t.id === id)) registry.push({ id, label, render });
}

export function setActiveTab(id) {
    _active = id;
    renderTabs();
    const tab = registry.find(t => t.id === id);
    const body = document.getElementById('urisBody');
    if (body && tab) { body.innerHTML = ''; tab.render(body); }
}

export function getActiveTab() { return _active; }

export function renderTabs() {
    const host = document.getElementById('urisTabs');
    if (!host) return;
    host.innerHTML = '';
    for (const t of registry) {
        const btn = document.createElement('button');
        btn.className = 'uris-tab' + (t.id === _active ? ' uris-tab-active' : '');
        btn.textContent = t.label;
        btn.addEventListener('click', () => setActiveTab(t.id));
        host.appendChild(btn);
    }
}

// Перерисовать текущую активную вкладку (после изменений данных).
export function refreshActive() {
    if (_active) setActiveTab(_active);
}
```

- [ ] **Step 2: Верифицировать**

```bash
node --check "D:/VC CODE/UR Image Studio/src/ui/tabs.js" 2>/dev/null; echo "done"
```

---

## Task 15: ui/tab-presets.js — управление пресетами + привязка

**Files:**
- Create: `D:/VC CODE/UR Image Studio/src/ui/tab-presets.js`

- [ ] **Step 1: Реализация**

```js
// @ts-check
/**
 * Вкладка «Пресеты»: CRUD text/image/character/template пресетов + привязка к чату.
 */
import { state, escapeHtml, saveSettings, showConfirmModal, showInputModal, log, VALID_ASPECT_RATIOS, VALID_IMAGE_SIZES } from '../core.js';
import {
    listTextPresets, listImagePresets, listCharacters, listTemplates,
    createTextPreset, createImagePreset, createCharacter, createTemplate,
    saveTextPreset, saveImagePreset, saveCharacter, saveTemplate,
    deleteTextPreset, deleteImagePreset, deleteCharacter, deleteTemplate,
} from '../presets.js';
import { getBinding, setBinding } from '../chat-binding.js';
import { fetchUserAvatars } from '../references.js';
import { refreshActive } from './tabs.js';

export function render(root) {
    root.innerHTML = `
        <div class="uris-presets">
            <div class="uris-binding" id="urisBinding"></div>
            <div class="uris-accordion" id="urisTextSection"></div>
            <div class="uris-accordion" id="urisImageSection"></div>
            <div class="uris-accordion" id="urisCharSection"></div>
            <div class="uris-accordion" id="urisTplSection"></div>
        </div>`;
    renderBinding(root.querySelector('#urisBinding'));
    renderTextSection(root.querySelector('#urisTextSection'));
    renderImageSection(root.querySelector('#urisImageSection'));
    renderCharSection(root.querySelector('#urisCharSection'));
    renderTplSection(root.querySelector('#urisTplSection'));
}

// ── Привязка к чату ──
async function renderBinding(host) {
    const b = state.currentBinding || getBinding() || {};
    const [texts, images, chars, templates] = await Promise.all([
        listTextPresets(), listImagePresets(), listCharacters(), listTemplates(),
    ]);
    host.innerHTML = `
        <h4>Привязка к этому чату</h4>
        <div class="uris-field"><label>Text-коннект</label>
            <select id="urisBindText" class="text_pole">${opt(texts, b.textPresetId)}</select></div>
        <div class="uris-field"><label>Image-коннект</label>
            <select id="urisBindImage" class="text_pole">${opt(images, b.imagePresetId)}</select></div>
        <div class="uris-field"><label>Шаблон промпта</label>
            <select id="urisBindTpl" class="text_pole">${opt(templates, b.templateId)}</select></div>
        <div class="uris-field"><label>Персонажи</label>
            <div class="uris-chips" id="urisBindChars">${chars.map(c => charChip(c, (b.characterIds||[]).includes(c.id))).join('')}</div></div>`;
    const bind = { ...b };
    host.querySelector('#urisBindText').addEventListener('change', e => { bind.textPresetId = e.target.value; commit(bind); });
    host.querySelector('#urisBindImage').addEventListener('change', e => { bind.imagePresetId = e.target.value; commit(bind); });
    host.querySelector('#urisBindTpl').addEventListener('change', e => { bind.templateId = e.target.value; commit(bind); });
    host.querySelector('#urisBindChars').addEventListener('click', e => {
        const chip = e.target.closest('[data-cid]');
        if (!chip) return;
        const id = chip.dataset.cid;
        bind.characterIds = bind.characterIds || [];
        if (bind.characterIds.includes(id)) bind.characterIds = bind.characterIds.filter(x => x !== id);
        else bind.characterIds.push(id);
        commit(bind); renderBinding(host);
    });
    function commit(b2) { state.currentBinding = b2; setBinding(b2); }
}

function charChip(c, active) { return `<span class="uris-chip ${active?'uris-chip-on':''}" data-cid="${c.id}">${escapeHtml(c.sceneName||c.name)}</span>`; }
function opt(arr, cur) {
    return '<option value="">— не выбрано —</option>' + arr.map(x => `<option value="${x.id}" ${x.id===cur?'selected':''}>${escapeHtml(x.name)}</option>`).join('');
}

// ── Text-коннекты ──
async function renderTextSection(host) {
    const arr = await listTextPresets();
    host.innerHTML = accordion('Text-коннекты', `
        ${arr.map(p => textRow(p)).join('')}
        <button class="menu_button uris-add-btn" id="urisAddText"><i class="fa-solid fa-plus"></i> Добавить</button>`);
    host.querySelector('#urisAddText').addEventListener('click', async () => { await createTextPreset({}); refreshActive(); });
    bindRows(host, arr, saveTextPreset, deleteTextPreset, textFields);
}

function textRow(p) { return `<div class="uris-preset-card" data-id="${p.id}">${textFields(p)}</div>`; }
function textFields(p) {
    return `
        <input class="text_pole uris-name" value="${escapeHtml(p.name)}" placeholder="Название">
        <div class="uris-row"><label>Тип</label><select class="text_pole uris-apiType">
            <option value="openai" ${p.apiType==='openai'?'selected':''}>OpenAI</option>
            <option value="gemini" ${p.apiType==='gemini'?'selected':''}>Gemini</option></select></div>
        <input class="text_pole uris-endpoint" value="${escapeHtml(p.endpoint)}" placeholder="URL endpoint">
        <input class="text_pole uris-apiKey" type="password" value="${escapeHtml(p.apiKey)}" placeholder="API ключ">
        <input class="text_pole uris-model" value="${escapeHtml(p.model)}" placeholder="Модель">
        <button class="menu_button uris-del"><i class="fa-solid fa-trash"></i></button>`;
}

// ── Image-коннекты ──
async function renderImageSection(host) {
    const arr = await listImagePresets();
    host.innerHTML = accordion('Image-коннекты', `
        ${arr.map(p => imageRow(p)).join('')}
        <button class="menu_button uris-add-btn" id="urisAddImage"><i class="fa-solid fa-plus"></i> Добавить</button>`);
    host.querySelector('#urisAddImage').addEventListener('click', async () => { await createImagePreset({}); refreshActive(); });
    bindRows(host, arr, saveImagePreset, deleteImagePreset, imageFields);
}
function imageRow(p) { return `<div class="uris-preset-card" data-id="${p.id}">${imageFields(p)}</div>`; }
function imageFields(p) {
    return `
        <input class="text_pole uris-name" value="${escapeHtml(p.name)}" placeholder="Название">
        <div class="uris-row"><label>Тип</label><select class="text_pole uris-apiType">
            <option value="openai" ${p.apiType==='openai'?'selected':''}>OpenAI</option>
            <option value="gemini" ${p.apiType==='gemini'?'selected':''}>Gemini</option></select></div>
        <input class="text_pole uris-endpoint" value="${escapeHtml(p.endpoint)}" placeholder="URL endpoint">
        <input class="text_pole uris-apiKey" type="password" value="${escapeHtml(p.apiKey)}" placeholder="API ключ">
        <input class="text_pole uris-model" value="${escapeHtml(p.model)}" placeholder="Модель">
        <div class="uris-row uris-openai-only" style="${p.apiType==='openai'?'':'display:none'}"><label>Размер</label>
            <select class="text_pole uris-size">
                ${['1024x1024','1792x1024','1024x1792','512x512'].map(s=>`<option ${p.size===s?'selected':''}>${s}</option>`).join('')}</select></div>
        <div class="uris-row uris-openai-only" style="${p.apiType==='openai'?'':'display:none'}"><label>Качество</label>
            <select class="text_pole uris-quality">
                <option value="standard" ${p.quality==='standard'?'selected':''}>standard</option>
                <option value="hd" ${p.quality==='hd'?'selected':''}>hd</option></select></div>
        <div class="uris-row uris-gemini-only" style="${p.apiType==='gemini'?'':'display:none'}"><label>Стороны</label>
            <select class="text_pole uris-aspectRatio">${VALID_ASPECT_RATIOS.map(r=>`<option ${p.aspectRatio===r?'selected':''}>${r}</option>`).join('')}</select></div>
        <div class="uris-row uris-gemini-only" style="${p.apiType==='gemini'?'':'display:none'}"><label>Разрешение</label>
            <select class="text_pole uris-imageSize">${VALID_IMAGE_SIZES.map(s=>`<option ${p.imageSize===s?'selected':''}>${s}</option>`).join('')}</select></div>
        <div class="uris-row"><label>Референсы</label><select class="text_pole uris-referenceMode">
            <option value="never" ${p.referenceMode==='never'?'selected':''}>Никогда</option>
            <option value="always" ${p.referenceMode==='always'?'selected':''}>Всегда</option></select></div>
        <label class="checkbox_label"><input type="checkbox" class="uris-sendCharAvatar" ${p.sendCharAvatar?'checked':''}><span>{{char}} аватар</span></label>
        <label class="checkbox_label"><input type="checkbox" class="uris-sendUserAvatar" ${p.sendUserAvatar?'checked':''}><span>{{user}} аватар</span></label>
        <div class="uris-row uris-useravatar" style="${p.sendUserAvatar?'':'display:none'}"><label>Аватар польз.</label>
            <select class="text_pole uris-userAvatarFile"><option value="">—</option><option ${p.userAvatarFile?'selected':''}>${escapeHtml(p.userAvatarFile||'')}</option></select>
            <button class="menu_button uris-refresh-avatars" title="Обновить"><i class="fa-solid fa-sync"></i></button></div>
        <button class="menu_button uris-del"><i class="fa-solid fa-trash"></i></button>`;
}

// ── Персонажи ──
async function renderCharSection(host) {
    const arr = await listCharacters();
    host.innerHTML = accordion('Персонажи', `
        ${arr.map(c => charRow(c)).join('')}
        <button class="menu_button uris-add-btn" id="urisAddChar"><i class="fa-solid fa-plus"></i> Добавить персонажа</button>`);
    host.querySelector('#urisAddChar').addEventListener('click', async () => { await createCharacter({}); refreshActive(); });
    bindRows(host, arr, saveCharacter, deleteCharacter, charFields);
}
function charRow(c) { return `<div class="uris-preset-card" data-id="${c.id}">${charFields(c)}</div>`; }
function charFields(c) {
    const roleSel = c.role === 'char' || c.role === 'user'
        ? `<div class="uris-row"><label>Слот</label><span class="uris-readonly">${c.role === 'char' ? '{{char}} (фикс.)' : '{{user}} (фикс.)'}</span></div>`
        : `<div class="uris-row"><label>Имя</label><input class="text_pole uris-name" value="${escapeHtml(c.name)}"></div>`;
    return `${roleSel}
        <div class="uris-row"><label>Имя в сцене</label><input class="text_pole uris-sceneName" value="${escapeHtml(c.sceneName)}" placeholder="как зовут в чате"></div>
        <div class="uris-row"><label>Описание внешности</label><textarea class="text_pole uris-description" rows="3" placeholder="волосы, глаза, одежда, телосложение...">${escapeHtml(c.description)}</textarea></div>
        <button class="menu_button uris-del"><i class="fa-solid fa-trash"></i></button>`;
}

// ── Шаблоны промптов ──
async function renderTplSection(host) {
    const arr = await listTemplates();
    host.innerHTML = accordion('Шаблоны промптов', `
        ${arr.map(t => tplRow(t)).join('')}
        <button class="menu_button uris-add-btn" id="urisAddTpl"><i class="fa-solid fa-plus"></i> Добавить шаблон</button>`);
    host.querySelector('#urisAddTpl').addEventListener('click', async () => {
        const name = await showInputModal('Название шаблона:', 'Мой шаблон');
        if (name) { await createTemplate({ name }); refreshActive(); }
    });
    bindRows(host, arr, saveTemplate, deleteTemplate, tplFields);
}
function tplRow(t) { return `<div class="uris-preset-card" data-id="${t.id}">${tplFields(t)}</div>`; }
function tplFields(t) {
    return `<input class="text_pole uris-name" value="${escapeHtml(t.name)}" placeholder="Название">
        <textarea class="text_pole uris-content" rows="6" placeholder="Текст шаблона...">${escapeHtml(t.content)}</textarea>
        <button class="menu_button uris-del"><i class="fa-solid fa-trash"></i></button>`;
}

// ── Общий биндинг строк пресетов ──
function bindRows(host, arr, saver, deleter, fieldsFn) {
    for (const card of host.querySelectorAll('.uris-preset-card')) {
        const id = card.dataset.id;
        // авто-сохранение по change/input
        const collect = () => collectFromCard(card, fieldsFn);
        card.addEventListener('change', async () => { await saver({ id, ...collect() }); });
        card.addEventListener('input', debounceSave(saver, id, collect));
        // удаление
        card.querySelector('.uris-del')?.addEventListener('click', async () => {
            if (await showConfirmModal('Удалить пресет?')) { await deleter(id); refreshActive(); }
        });
        // переключение видимости openai/gemini полей для image
        const apiSel = card.querySelector('.uris-apiType');
        if (apiSel) apiSel.addEventListener('change', () => toggleApiFields(card, apiSel.value));
        // refresh user avatars
        card.querySelector('.uris-refresh-avatars')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget; btn.classList.add('loading');
            try {
                const avs = await fetchUserAvatars();
                const sel = card.querySelector('.uris-userAvatarFile');
                sel.innerHTML = '<option value="">—</option>' + avs.map(a => `<option>${escapeHtml(a)}</option>`).join('');
            } finally { btn.classList.remove('loading'); }
        });
    }
}

function collectFromCard(card, fieldsFn) {
    // собираем по наличию полей (универсально для всех типов пресетов)
    const get = (cls) => card.querySelector('.' + cls)?.value ?? null;
    const chk = (cls) => card.querySelector('.' + cls)?.checked ?? null;
    const o = {};
    if (card.querySelector('.uris-name')) o.name = get('uris-name');
    if (card.querySelector('.uris-apiType')) o.apiType = get('uris-apiType');
    if (card.querySelector('.uris-endpoint')) o.endpoint = get('uris-endpoint');
    if (card.querySelector('.uris-apiKey')) o.apiKey = get('uris-apiKey');
    if (card.querySelector('.uris-model')) o.model = get('uris-model');
    if (card.querySelector('.uris-size')) o.size = get('uris-size');
    if (card.querySelector('.uris-quality')) o.quality = get('uris-quality');
    if (card.querySelector('.uris-aspectRatio')) o.aspectRatio = get('uris-aspectRatio');
    if (card.querySelector('.uris-imageSize')) o.imageSize = get('uris-imageSize');
    if (card.querySelector('.uris-referenceMode')) o.referenceMode = get('uris-referenceMode');
    if (card.querySelector('.uris-sendCharAvatar') !== null) o.sendCharAvatar = chk('uris-sendCharAvatar');
    if (card.querySelector('.uris-sendUserAvatar') !== null) o.sendUserAvatar = chk('uris-sendUserAvatar');
    if (card.querySelector('.uris-userAvatarFile')) o.userAvatarFile = get('uris-userAvatarFile');
    if (card.querySelector('.uris-sceneName')) o.sceneName = get('uris-sceneName');
    if (card.querySelector('.uris-description')) o.description = get('uris-description');
    if (card.querySelector('.uris-content')) o.content = get('uris-content');
    return o;
}

function toggleApiFields(card, apiType) {
    card.querySelector('.uris-openai-only')?.style.setProperty('display', apiType === 'openai' ? '' : 'none');
    card.querySelector('.uris-gemini-only')?.style.setProperty('display', apiType === 'gemini' ? '' : 'none');
    // показать/скрыть строку аватара пользователя
    const ua = card.querySelector('.uris-useravatar');
    const sendUser = card.querySelector('.uris-sendUserAvatar')?.checked;
    if (ua) ua.style.display = sendUser ? '' : 'none';
}

function debounceSave(saver, id, collect) {
    let t;
    return () => {
        clearTimeout(t);
        t = setTimeout(async () => { await saver({ id, ...collect() }); }, 400);
    };
}

function accordion(title, inner) {
    return `<h4 class="uris-acc-header">${title}</h4><div class="uris-acc-body">${inner}</div>`;
}
```

- [ ] **Step 2: Верифицировать**

```bash
node --check "D:/VC CODE/UR Image Studio/src/ui/tab-presets.js" 2>/dev/null; echo "done"
```

---

## Task 16: ui/tab-generate.js — редактор промпта + режимы + очередь + история

**Files:**
- Create: `D:/VC CODE/UR Image Studio/src/ui/tab-generate.js`

- [ ] **Step 1: Реализация**

```js
// @ts-check
/**
 * Вкладка «Генерация»: навигатор постов, редактор промпта (поля + сырой JSON),
 * кнопки стадий, индикатор очереди, дропдаун истории.
 */
import { state, getCtx, escapeHtml, log, error, VALID_ASPECT_RATIOS, VALID_IMAGE_SIZES } from '../core.js';
import { navigatePosts } from '../events.js';
import { runStage1, runStage2, runFullPipeline, enqueue, resolveActivePresets } from '../pipeline.js';
import { getHistory, pushHistory } from '../history.js';
import { setStatus } from './window.js';
import { refreshActive } from './tabs.js';

let _currentInstruction = null;   // последняя инструкция из stage1 (для редактора)

export function render(root) {
    root.innerHTML = `
        <div class="uris-gen">
            <div class="uris-postnav">
                <button class="menu_button" id="urisPrev" title="Предыдущий пост"><i class="fa-solid fa-chevron-left"></i></button>
                <span id="urisPostInfo">—</span>
                <button class="menu_button" id="urisNext" title="Следующий пост"><i class="fa-solid fa-chevron-right"></i></button>
            </div>
            <div class="uris-row"><label>Режим</label>
                <select id="urisMode" class="text_pole">
                    <option value="auto" ${state.settings.generationMode==='auto'?'selected':''}>Авто</option>
                    <option value="confirm" ${state.settings.generationMode==='confirm'?'selected':''}>Подтверждение</option>
                    <option value="manual" ${state.settings.generationMode==='manual'?'selected':''}>Вручную</option></select></div>
            <div class="uris-row"><label>История промптов</label>
                <select id="urisHistory" class="text_pole"><option value="">— последние —</option></select></div>
            <div class="uris-editor" id="urisEditor">
                <div class="uris-field"><label>Стиль</label>
                    <textarea class="text_pole" id="urisStyle" rows="2" placeholder="Стиль"></textarea></div>
                <div class="uris-field"><label>Промпт</label>
                    <textarea class="text_pole" id="urisPrompt" rows="6" placeholder="Промпт картинки"></textarea></div>
                <div class="uris-row">
                    <label>Стороны</label><select class="text_pole" id="urisAspect">${VALID_ASPECT_RATIOS.map(r=>`<option ${r==='9:16'?'selected':''}>${r}</option>`).join('')}</select>
                    <label>Размер</label><select class="text_pole" id="urisImgSize">${VALID_IMAGE_SIZES.map(s=>`<option ${s==='2K'?'selected':''}>${s}</option>`).join('')}</select>
                </div>
                <button class="menu_button uris-raw-toggle" id="urisRawToggle"><i class="fa-solid fa-code"></i> Сырой JSON</button>
                <textarea class="text_pole uris-rawjson" id="urisRawJson" rows="8" style="display:none" placeholder='{"style":"...","prompt":"...","aspect_ratio":"9:16","image_size":"2K"}'></textarea>
            </div>
            <div class="uris-gen-actions">
                <button class="menu_button" id="urisBuild"><i class="fa-solid fa-wand-magic-sparkles"></i> Построить промпт</button>
                <button class="menu_button" id="urisGenImg"><i class="fa-solid fa-image"></i> Сгенерировать</button>
                <button class="menu_button uris-queue-btn" id="urisQueue"><i class="fa-solid fa-layer-group"></i> В очередь</button>
            </div>
            <div class="uris-queue-status" id="urisQueueStatus"></div>
        </div>`;
    bindGenerate(root);
    updatePostInfo(root);
    loadHistoryDropdown(root);
}

function bindGenerate(root) {
    // режим
    root.querySelector('#urisMode').addEventListener('change', e => {
        state.settings.generationMode = e.target.value;
        getCtx().saveSettingsDebounced();
    });
    // навигация
    root.querySelector('#urisPrev').addEventListener('click', () => { navigatePosts(-1); updatePostInfo(root); });
    root.querySelector('#urisNext').addEventListener('click', () => { navigatePosts(1); updatePostInfo(root); });
    // история
    root.querySelector('#urisHistory').addEventListener('change', e => {
        if (e.target.value) root.querySelector('#urisPrompt').value = e.target.value;
    });
    // сырой JSON
    const rawToggle = root.querySelector('#urisRawToggle');
    const rawJson = root.querySelector('#urisRawJson');
    rawToggle.addEventListener('click', () => {
        const shown = rawJson.style.display !== 'none';
        if (shown) {
            // применить JSON обратно в поля
            try {
                const d = JSON.parse(rawJson.value);
                applyInstruction(d);
            } catch { /* ignore */ }
            rawJson.style.display = 'none';
        } else {
            // сериализовать поля в JSON
            rawJson.value = JSON.stringify(collectInstruction(), null, 2);
            rawJson.style.display = '';
        }
    });
    // построить промпт (stage 1)
    root.querySelector('#urisBuild').addEventListener('click', async () => {
        const msgId = state.currentMsgId;
        if (msgId == null) { toastr?.warning('Нет поста'); return; }
        try {
            setStatus('Построение промпта...');
            const instr = await runStage1(msgId, s => setStatus(s));
            _currentInstruction = instr;
            applyInstruction(instr);
            setStatus('Промпт готов');
            toastr?.success('Промпт построен');
            // confirm/manual — ждём клика по «Сгенерировать»; auto — генерим сразу
            if (state.settings.generationMode === 'auto') {
                doGenerate(root);
            }
        } catch (e) { error('Stage1:', e.message); toastr?.error('Промпт: ' + e.message); setStatus(''); }
    });
    // сгенерировать картинку (stage 2)
    root.querySelector('#urisGenImg').addEventListener('click', () => doGenerate(root));
    // в очередь
    root.querySelector('#urisQueue').addEventListener('click', async () => {
        const msgId = state.currentMsgId;
        if (msgId == null) { toastr?.warning('Нет поста'); return; }
        enqueue(msgId).then(() => {
            toastr?.success('Готово (из очереди)');
            updateQueueStatus(root);
        }).catch(e => {
            toastr?.error('Очередь: ' + e.message);
            updateQueueStatus(root);
        });
        updateQueueStatus(root);
        toastr?.info('Добавлено в очередь');
    });
}

async function doGenerate(root) {
    const msgId = state.currentMsgId;
    if (msgId == null) { toastr?.warning('Нет поста'); return; }
    let instr = collectInstruction();
    // если поля пустые — сначала построить
    if (!instr.prompt) {
        try { instr = await runStage1(msgId, s => setStatus(s)); applyInstruction(instr); }
        catch (e) { toastr?.error('Промпт: ' + e.message); return; }
    }
    try {
        setStatus('Генерация изображения...');
        await runStage2(msgId, instr, s => setStatus(s));
        setStatus('Готово');
        toastr?.success('Картинка сгенерирована');
        // обновить галерею если активна
        const tabs = await import('./tabs.js');
        if (tabs.getActiveTab() === 'gallery') tabs.refreshActive();
    } catch (e) { error('Stage2:', e.message); toastr?.error('Картинка: ' + e.message); setStatus(''); }
}

function collectInstruction() {
    return {
        style: val('urisStyle'),
        prompt: val('urisPrompt'),
        aspectRatio: val('urisAspect'),
        imageSize: val('urisImgSize'),
    };
    function val(id) { return document.getElementById(id)?.value || ''; }
}

function applyInstruction(instr) {
    if (!instr) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
    set('urisStyle', instr.style);
    set('urisPrompt', instr.prompt);
    set('urisAspect', instr.aspectRatio || instr.aspect_ratio || '9:16');
    set('urisImgSize', instr.imageSize || instr.image_size || '2K');
}

function updatePostInfo(root) {
    const info = root.querySelector('#urisPostInfo');
    if (!info) return;
    const ctx = getCtx();
    const msg = ctx.chat?.[state.currentMsgId];
    if (!msg) { info.textContent = 'Нет поста'; return; }
    const preview = (msg.mes || '').replace(/<[^>]*>/g, '').slice(0, 50);
    info.textContent = `Пост #${state.currentMsgId}: ${preview}…`;
}

async function loadHistoryDropdown(root) {
    const sel = root.querySelector('#urisHistory');
    const arr = await getHistory(getCtx().chatId);
    sel.innerHTML = '<option value="">— последние —</option>' +
        arr.map((p, i) => `<option value="${escapeHtml(p)}">${i + 1}. ${escapeHtml(p.slice(0, 60))}…</option>`).join('');
}

function updateQueueStatus(root) {
    const el = root.querySelector('#urisQueueStatus');
    if (!el) return;
    const n = state.queue.length;
    el.textContent = n ? `В очереди: ${n}` : '';
}
```

- [ ] **Step 2: Верифицировать**

```bash
node --check "D:/VC CODE/UR Image Studio/src/ui/tab-generate.js" 2>/dev/null; echo "done"
```

---

## Task 17: ui/lightbox.js — fullscreen просмотр

**Files:**
- Create: `D:/VC CODE/UR Image Studio/src/ui/lightbox.js`

- [ ] **Step 1: Реализация (со swipe для mobile)**

```js
// @ts-check
/**
 * Lightbox: fullscreen просмотр картинки + swipe для листания/закрытия.
 */
import { escapeHtml } from '../core.js';

let _items = [];   // [{src, prompt, style}]
let _index = 0;

export function showLightbox(items, index = 0) {
    if (!items?.length) return;
    _items = items; _index = Math.max(0, Math.min(items.length - 1, index));
    render();
}

function render() {
    const old = document.querySelector('.uris-lightbox');
    if (old) old.remove();
    const item = _items[_index];
    const lb = document.createElement('div');
    lb.className = 'uris-lightbox';
    lb.innerHTML = `
        <div class="uris-lb-content">
            <img src="${escapeHtml(item.src)}" alt="" class="uris-lb-img">
            <div class="uris-lb-info">
                ${item.style ? `<div class="uris-lb-style">🎨 ${escapeHtml(item.style)}</div>` : ''}
                <div class="uris-lb-prompt">${escapeHtml(item.prompt || '')}</div>
            </div>
            ${_items.length > 1 ? `<div class="uris-lb-nav prev">‹</div><div class="uris-lb-nav next">›</div>` : ''}
            <div class="uris-lb-counter">${_index + 1} / ${_items.length}</div>
            <div class="uris-lb-close">✕</div>
        </div>`;
    document.body.appendChild(lb);
    lb.querySelector('.uris-lb-close').addEventListener('click', close);
    lb.querySelector('.uris-lb-nav.prev')?.addEventListener('click', () => { _index = (_index - 1 + _items.length) % _items.length; render(); });
    lb.querySelector('.uris-lb-nav.next')?.addEventListener('click', () => { _index = (_index + 1) % _items.length; render(); });
    const onEsc = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } };
    document.addEventListener('keydown', onEsc);
    // swipe: вниз — закрыть, влево/вправо — листать
    let sx = 0, sy = 0;
    lb.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    lb.addEventListener('touchend', (e) => {
        const dx = e.changedTouches[0].clientX - sx;
        const dy = e.changedTouches[0].clientY - sy;
        if (Math.abs(dy) > Math.abs(dx) && dy > 80) close();
        else if (Math.abs(dx) > 60) {
            if (dx < 0) { _index = (_index + 1) % _items.length; render(); }
            else { _index = (_index - 1 + _items.length) % _items.length; render(); }
        }
    }, { passive: true });
}

function close() { document.querySelector('.uris-lightbox')?.remove(); }
```

- [ ] **Step 2: Верифицировать**

```bash
node --check "D:/VC CODE/UR Image Studio/src/ui/lightbox.js" 2>/dev/null; echo "done"
```

---

## Task 18: ui/tab-gallery.js — сетка карточек

**Files:**
- Create: `D:/VC CODE/UR Image Studio/src/ui/tab-gallery.js`

- [ ] **Step 1: Реализация**

```js
// @ts-check
/**
 * Вкладка «Галерея»: сетка карточек (mobile-адаптив) + действия.
 */
import { state, getCtx, escapeHtml, showConfirmModal } from '../core.js';
import { getGallery, removeFromGallery, updateGalleryEntry, saveImageToFile, clearGallery } from '../storage.js';
import { showLightbox } from './lightbox.js';
import { runStage2 } from '../pipeline.js';
import { setStatus } from './window.js';

export async function render(root) {
    const chatId = getCtx().chatId;
    const items = await getGallery(chatId);
    root.innerHTML = `
        <div class="uris-gallery">
            <div class="uris-gallery-toolbar">
                <span id="urisGalleryCount">${items.length}</span>
                <button class="menu_button" id="urisGalleryClear"><i class="fa-solid fa-trash"></i> Очистить</button>
            </div>
            <div class="uris-gallery-grid" id="urisGalleryGrid">
                ${items.length ? items.map((it, i) => card(it, i)).join('') : emptyState()}
            </div>
        </div>`;
    bindCards(root, items, chatId);
    root.querySelector('#urisGalleryClear').addEventListener('click', async () => {
        if (await showConfirmModal('Очистить галерею этого чата?')) {
            await clearGallery(chatId); render(root);
        }
    });
}

function card(it, i) {
    const badge = it.saved ? '<span class="uris-saved-badge" title="Сохранено в ST">💾</span>' : '';
    return `<div class="uris-card" data-id="${it.id}" data-idx="${i}">
        <div class="uris-card-img" style="background-image:url('${escapeHtml(it.src)}')">${badge}</div>
        <div class="uris-card-actions">
            <button class="uris-card-btn" data-act="view" title="Просмотр"><i class="fa-solid fa-expand"></i></button>
            <button class="uris-card-btn" data-act="regen" title="Перегенерировать"><i class="fa-solid fa-rotate-right"></i></button>
            <button class="uris-card-btn" data-act="save" title="Сохранить в ST"><i class="fa-solid fa-download"></i></button>
            <button class="uris-card-btn" data-act="copy" title="Копировать промпт"><i class="fa-solid fa-copy"></i></button>
            <button class="uris-card-btn" data-act="del" title="Удалить"><i class="fa-solid fa-trash"></i></button>
        </div>
    </div>`;
}

function emptyState() {
    return `<div class="uris-gallery-empty">Нет генераций. Перейдите во вкладку «Генерация».</div>`;
}

function bindCards(root, items, chatId) {
    root.querySelectorAll('.uris-card').forEach(cardEl => {
        const id = cardEl.dataset.id;
        const idx = parseInt(cardEl.dataset.idx, 10);
        cardEl.querySelector('[data-act="view"]').addEventListener('click', (e) => {
            e.stopPropagation(); showLightbox(items, idx);
        });
        cardEl.querySelector('[data-act="copy"]').addEventListener('click', async (e) => {
            e.stopPropagation();
            const it = items.find(x => x.id === id);
            try { await navigator.clipboard.writeText(it.prompt || ''); toastr?.success('Промпт скопирован'); }
            catch { toastr?.error('Не удалось скопировать'); }
        });
        cardEl.querySelector('[data-act="save"]').addEventListener('click', async (e) => {
            e.stopPropagation();
            const it = items.find(x => x.id === id);
            try {
                setStatus('Сохранение в ST...');
                const path = await saveImageToFile(it.src);
                await updateGalleryEntry(chatId, id, { saved: true, src: path });
                toastr?.success('Сохранено');
                render(root);
            } catch (err) { toastr?.error('Сохранение: ' + err.message); }
            finally { setStatus(''); }
        });
        cardEl.querySelector('[data-act="regen"]').addEventListener('click', async (e) => {
            e.stopPropagation();
            const it = items.find(x => x.id === id);
            try {
                setStatus('Перегенерация...');
                await runStage2(it.sourceMsgId, { style: it.style, prompt: it.prompt, aspectRatio: it.aspectRatio, imageSize: it.imageSize },
                    s => setStatus(s));
                toastr?.success('Перегенерировано');
                render(root);
            } catch (err) { toastr?.error('Перегенерация: ' + err.message); }
            finally { setStatus(''); }
        });
        cardEl.querySelector('[data-act="del"]').addEventListener('click', async (e) => {
            e.stopPropagation();
            await removeFromGallery(chatId, id);
            render(root);
        });
    });
}
```

- [ ] **Step 2: Верифицировать**

```bash
node --check "D:/VC CODE/UR Image Studio/src/ui/tab-gallery.js" 2>/dev/null; echo "done"
```

---

## Task 19: style.css — все стили

**Files:**
- Create: `D:/VC CODE/UR Image Studio/style.css`

- [ ] **Step 1: Реализация (окно, вкладки, карточки, mobile, lightbox)**

```css
/* UR Image Studio — стили */

/* ── Launcher в quick-reply bar ── */
#uris_launcher {
    cursor: pointer; user-select: none;
}
#uris_launcher.uris_launcher_active { background: var(--SmartThemeQuoteColor, #4a5); }

/* ── Плавающее окно ── */
.uris-window {
    position: fixed; top: 80px; right: 20px;
    width: 460px; height: 560px; min-width: 320px; min-height: 360px;
    background: var(--SmartThemeBlurTintColor, #1b1b2a);
    color: var(--SmartThemeBodyColor, #eee);
    border: 1px solid var(--SmartThemeBorderColor, #333);
    border-radius: 10px; z-index: 99999;
    display: flex; flex-direction: column;
    box-shadow: 0 10px 40px rgba(0,0,0,.5);
    overflow: hidden;
}
.uris-window.uris-hidden { display: none; }
.uris-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px; cursor: move; user-select: none;
    background: var(--SmartThemeQuoteColor, #2a2a40); flex-shrink: 0;
}
.uris-title { font-weight: 600; }
.uris-header-actions { display: flex; align-items: center; gap: 8px; }
.uris-status { font-size: 12px; opacity: .8; min-height: 14px; }
.uris-icon-btn {
    background: none; border: none; color: inherit; cursor: pointer;
    font-size: 16px; padding: 2px 6px;
}

/* ── Вкладки ── */
.uris-tabs { display: flex; flex-shrink: 0; border-bottom: 1px solid var(--SmartThemeBorderColor, #333); }
.uris-tab {
    flex: 1; padding: 8px; background: none; border: none; color: inherit;
    cursor: pointer; border-bottom: 2px solid transparent; font-size: 14px;
}
.uris-tab.uris-tab-active { border-bottom-color: var(--SmartThemeQuoteColor, #4a5); font-weight: 600; }

/* ── Тело ── */
.uris-body { flex: 1; overflow-y: auto; padding: 12px; }

/* ── Поля ── */
.uris-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.uris-row label { min-width: 90px; font-size: 13px; opacity: .85; }
.uris-row .text_pole { flex: 1; min-width: 0; }
.uris-field { margin-bottom: 8px; }
.uris-field label { display: block; font-size: 12px; opacity: .8; margin-bottom: 2px; }

/* ── Ресайзер ── */
.uris-resizer {
    position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
    cursor: nwse-resize; background: linear-gradient(135deg, transparent 50%, rgba(255,255,255,.3) 50%);
}

/* ── Пресеты ── */
.uris-binding { background: rgba(255,255,255,.05); padding: 8px; border-radius: 8px; margin-bottom: 12px; }
.uris-binding h4 { margin: 0 0 8px; }
.uris-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.uris-chip { padding: 4px 10px; border-radius: 12px; background: rgba(255,255,255,.08); cursor: pointer; font-size: 12px; }
.uris-chip.uris-chip-on { background: var(--SmartThemeQuoteColor, #4a5); }
.uris-accordion { margin-bottom: 8px; }
.uris-acc-header { cursor: pointer; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,.1); }
.uris-acc-body { padding: 8px 0; }
.uris-preset-card {
    background: rgba(0,0,0,.2); padding: 8px; border-radius: 8px; margin-bottom: 8px;
    display: flex; flex-direction: column; gap: 6px;
}
.uris-readonly { font-size: 13px; opacity: .7; }
.uris-add-btn { width: 100%; }

/* ── Генерация ── */
.uris-gen { display: flex; flex-direction: column; gap: 8px; }
.uris-postnav { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.uris-postnav #urisPostInfo { flex: 1; font-size: 12px; opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uris-editor { display: flex; flex-direction: column; gap: 6px; }
.uris-gen-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.uris-gen-actions button { flex: 1; }
.uris-queue-status { font-size: 12px; opacity: .8; }
.uris-raw-toggle { align-self: flex-start; }

/* ── Галерея ── */
.uris-gallery-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.uris-gallery-grid { display: grid; gap: 8px; grid-template-columns: repeat(3, 1fr); }
.uris-card {
    border-radius: 8px; overflow: hidden; position: relative;
    border: 1px solid var(--SmartThemeBorderColor, #333);
}
.uris-card-img {
    width: 100%; aspect-ratio: 1; background-size: cover; background-position: center;
    cursor: pointer;
}
.uris-saved-badge { position: absolute; top: 4px; right: 4px; font-size: 12px; }
.uris-card-actions { display: flex; justify-content: space-around; padding: 4px; background: rgba(0,0,0,.3); }
.uris-card-btn { background: none; border: none; color: inherit; cursor: pointer; padding: 6px; font-size: 13px; }
.uris-card-btn:hover { opacity: .7; }
.uris-gallery-empty { text-align: center; opacity: .5; padding: 40px 0; }

/* ── Lightbox ── */
.uris-lightbox {
    position: fixed; inset: 0; z-index: 100000;
    background: rgba(0,0,0,.9); display: flex; align-items: center; justify-content: center;
}
.uris-lb-content { position: relative; max-width: 92vw; max-height: 92vh; display: flex; flex-direction: column; align-items: center; }
.uris-lb-img { max-width: 92vw; max-height: 80vh; object-fit: contain; }
.uris-lb-info { max-width: 92vw; margin-top: 8px; }
.uris-lb-prompt { font-size: 12px; opacity: .7; max-height: 80px; overflow-y: auto; }
.uris-lb-nav { position: absolute; top: 50%; transform: translateY(-50%); font-size: 40px; cursor: pointer; user-select: none; }
.uris-lb-nav.prev { left: 10px; } .uris-lb-nav.next { right: 10px; }
.uris-lb-counter { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); }
.uris-lb-close { position: absolute; top: 10px; right: 16px; font-size: 24px; cursor: pointer; }

/* ── Mobile ── */
@media (max-width: 767px) {
    .uris-window.uris-mobile {
        top: 0; right: 0; left: 0; bottom: 0;
        width: 100%; height: 100%; border-radius: 0; max-width: 100%;
    }
    .uris-window.uris-mobile .uris-resizer { display: none; }
    .uris-window.uris-mobile .uris-header { cursor: default; }
    .uris-gallery-grid { grid-template-columns: repeat(2, 1fr); }
    .uris-card-actions { flex-wrap: wrap; }
    .uris-card-btn { padding: 10px; font-size: 16px; min-width: 44px; min-height: 44px; }
}
@media (max-width: 479px) {
    .uris-gallery-grid { grid-template-columns: 1fr; }
}
```

- [ ] **Step 2: проверить валидность**

```bash
test -f "D:/VC CODE/UR Image Studio/style.css" && echo "OK"
```

---

## Task 20: index.js — финальная сборка (launcher, init, wiring)

**Files:**
- Modify: `D:/VC CODE/UR Image Studio/index.js` (полная замена скелета из Task 1)

- [ ] **Step 1: Полная реализация index.js**

```js
// @ts-check
/**
 * UR Image Studio — точка входа: lifecycle hooks + оркестрация.
 * Архитектура: index.js (этот файл) → src/* модули → src/ui/* вкладки.
 */
import {
    state, MODULE_NAME, DISPLAY_NAME, defaultSettings,
    loadSettings, saveSettings, flushSettings, getCtx, log, warn, error,
    debounce, exportLogs,
} from './src/core.js';
import { ensureBuiltinCharacterSlots, applyBindingForCurrentChat } from './src/chat-binding.js';
import { createTemplate } from './src/presets.js';
import { DEFAULT_TEMPLATE } from './src/default-template.js';
import { bindEvents, unbindEvents } from './src/events.js';
import { runFullPipeline } from './src/pipeline.js';
import {
    mountPanel, removePanel, isPanelVisible, syncPanelVisibility, initViewportSync, setStatus,
} from './src/ui/window.js';
import { registerTab, setActiveTab, renderTabs } from './src/ui/tabs.js';
import { render as renderPresets } from './src/ui/tab-presets.js';
import { render as renderGenerate } from './src/ui/tab-generate.js';
import { render as renderGallery } from './src/ui/tab-gallery.js';

export function onActivate() { log('onActivate'); init().catch(e => error('init:', e)); }
export function onUpdate()   { log('onUpdate (migrations reserved)'); }
export function onEnable()   { log('onEnable'); init().catch(e => error('init:', e)); }
export function onDisable()  { log('onDisable'); cleanup(); }
export function onInstall()  { log('onInstall'); }
export function onClean()    { log('onClean'); cleanup(); }

let _inited = false;
let _launcherObserver = null;

async function init() {
    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) { error('SillyTavern недоступен'); return; }
    const ctx = getCtx(); if (!ctx) { warn('context недоступен'); return; }
    await loadSettings();

    // дефолт collapsed = true (окно скрыто до первого открытия)
    if (state.settings.collapsed === undefined) state.settings.collapsed = true;

    // seed: создать дефолтный шаблон при первом запуске
    await ensureDefaultTemplate();
    await ensureBuiltinCharacterSlots();

    // регистрация вкладок
    registerTab({ id: 'generate', label: 'Генерация', render: renderGenerate });
    registerTab({ id: 'gallery', label: 'Галерея', render: renderGallery });
    registerTab({ id: 'presets', label: 'Пресеты', render: renderPresets });

    // панель настроек ST (минимальная)
    createSettingsPanel();

    // окно (idempotent)
    mountPanel();
    renderTabs();
    setActiveTab('generate');
    syncPanelVisibility();
    initViewportSync();

    // привязка пресетов к текущему чату
    state.currentChatId = ctx.chatId;
    if (ctx.chatId) { await applyBindingForCurrentChat(); }

    // события ST
    bindEvents(handleAutoGenerate);

    // launcher в quick-reply bar (перемонтируется при ре-рендере ST)
    ensureLauncher();
    attachLauncherObserver();

    // flush при уходе со страницы
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') { flushSettings(); try { getCtx().saveMetadata?.(); } catch {} }
    });

    log('Initialized.');
    _inited = true;
}

async function ensureDefaultTemplate() {
    const { listTemplates } = await import('./src/presets.js');
    const arr = await listTemplates();
    if (!arr.length) await createTemplate({ name: 'Манга (дефолт)', content: DEFAULT_TEMPLATE });
}

// Автоген: вызывается из events.js при новом AI-посте в auto-режиме.
function handleAutoGenerate(msgId) {
    if (!state.settings.enabled) return;
    if (state.settings.generationMode !== 'auto') return;
    runFullPipeline(msgId, s => setStatus(s))
        .then(() => { setStatus(''); toastr?.success('Картинка сгенерирована (авто)'); if (isPanelVisible()) setActiveTab('gallery'); })
        .catch(e => { setStatus(''); toastr?.error('Авто-генерация: ' + e.message); });
}

// ── Launcher ──
function getQuickReplyBar() {
    return document.querySelector('#send_form #qr--bar') || document.getElementById('qr--bar') || document.querySelector('#send_form .qr--bar');
}
function getLauncherHost() {
    const bar = getQuickReplyBar(); if (!bar) return null;
    return bar.querySelector('.qr--buttons') || bar;
}
function ensureLauncher() {
    const existing = document.getElementById('uris_launcher');
    if (!state.settings.enabled) { existing?.remove(); return null; }
    const host = getLauncherHost();
    if (!host) return null;
    let btn = existing;
    if (!btn) {
        btn = document.createElement('div');
        btn.id = 'uris_launcher';
        btn.className = 'qr--button menu_button interactable uris_launcher';
        btn.tabIndex = 0; btn.setAttribute('role', 'button');
        btn.setAttribute('aria-label', DISPLAY_NAME);
        btn.innerHTML = '<span aria-hidden="true">🎨</span>';
        btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleLauncherPanel(); });
    }
    if (btn.parentElement !== host) host.appendChild(btn);
    btn.classList.toggle('uris_launcher_active', isPanelVisible());
    return btn;
}
function toggleLauncherPanel() {
    if (!state.settings.enabled) return;
    state.settings.collapsed = !state.settings.collapsed;
    saveSettings();
    mountPanel(); renderTabs(); syncPanelVisibility();
    if (!state.settings.collapsed) { setActiveTab('generate'); applyBindingForCurrentChat(); }
    ensureLauncher();
}
function attachLauncherObserver() {
    if (_launcherObserver) return;
    const sendForm = document.getElementById('send_form');
    if (!sendForm) return;
    _launcherObserver = new MutationObserver(debounce(() => { if (state.settings.enabled) ensureLauncher(); }, 100));
    _launcherObserver.observe(sendForm, { childList: true, subtree: true });
}

// ── Минимальная панель в ST Extensions ──
let _panelLoaded = false;
function createSettingsPanel() {
    if (_panelLoaded) return;
    const container = document.getElementById('extensions_settings');
    if (!container) return;
    _panelLoaded = true;
    const div = document.createElement('div');
    div.className = 'inline-drawer';
    div.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${DISPLAY_NAME}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input type="checkbox" id="uris_enabled" ${state.settings.enabled?'checked':''}><span>Включить</span></label>
            <div class="flex-row"><div id="uris_open_window" class="menu_button" style="width:100%"><i class="fa-solid fa-window-restore"></i> Открыть окно</div></div>
            <div class="flex-row"><div id="uris_export_logs" class="menu_button" style="width:100%"><i class="fa-solid fa-download"></i> Экспорт логов</div></div>
        </div>`;
    container.appendChild(div);
    div.querySelector('#uris_enabled').addEventListener('change', e => {
        state.settings.enabled = e.target.checked; saveSettings();
        ensureLauncher(); syncPanelVisibility();
    });
    div.querySelector('#uris_open_window').addEventListener('click', () => {
        if (state.settings.collapsed) toggleLauncherPanel();
    });
    div.querySelector('#uris_export_logs').addEventListener('click', exportLogs);
    // accordion toggle
    div.querySelector('.inline-drawer-toggle').addEventListener('click', () => {
        div.querySelector('.inline-drawer-content').classList.toggle('hidden');
    });
}

function cleanup() {
    if (state.abortController) { state.abortController.abort(); state.abortController = null; }
    unbindEvents();
    if (_launcherObserver) { _launcherObserver.disconnect(); _launcherObserver = null; }
    removePanel();
    document.getElementById('uris_launcher')?.remove();
    log('Cleanup.');
    _inited = false;
}
```

- [ ] **Step 2: Верифицировать ВСЕ файлы**

```bash
cd "D:/VC CODE/UR Image Studio" && for f in index.js src/*.js src/ui/*.js; do node --check "$f" 2>/dev/null || node --input-type=module --check < "$f" >/dev/null 2>&1; if [ $? -ne 0 ] && [ $? -ne 1 ]; then echo "FAIL: $f"; fi; done; echo "syntax check done"
```
Expected: `syntax check done` без `FAIL`.

- [ ] **Step 3: Финальная проверка структуры**

```bash
cd "D:/VC CODE/UR Image Studio" && ls -R
```
Ожидаемая структура: `manifest.json`, `index.js`, `style.css`, `src/*.js`, `src/ui/*.js`, `docs/...`.

- [ ] **Step 4: Ручная загрузка в SillyTavern**

Скопировать папку `UR Image Studio` в `data/default-user/extensions/` (или путь third-party расширений ST), включить в Extensions, проверить:
- Появляется ли панель «UR Image Studio» в Extensions.
- Лаунчер 🎨 в quick-reply bar.
- Плавающее окно открывается/закрывается, перетаскивается, ресайзится.
- Вкладки Генерация / Галерея / Пресеты переключаются.
- Пресеты создаются/редактируются/удаляются, привязываются к чату.
- В Пресетах заполнить text+image коннект, выбрать их в привязке, во вкладке Генерация нажать «Построить промпт» → поля заполнятся → «Сгенерировать» → картинка в Галерее.

---

## Self-Review (выполнено)

- **Spec coverage:** п.1 (парсинг сцены) → pipeline.runStage1 + prompt-builder ✓; п.2 (пресеты API/персов/промптов/сцена) → presets.js + chat-binding.js + tab-presets.js ✓; п.3 (плавающее окно) → ui/window.js ✓; п.4 (сборщик промптов без IMG/GEN) → default-template.js ✓; п.5 (галерея: удалить/переген/сохранить/копировать промпт) → tab-gallery.js ✓; п.6 (автономность) → message.mes не мутируется нигде ✓; п.7 (OpenAI + Gemini) → text-api.js + image-api.js ✓. Доп. (очередь, история) → pipeline.enqueue + history.js ✓.
- **Placeholder scan:** TBD/TODO — нет. Все шаги содержат полный код.
- **Type consistency:** имена функций согласованы между модулями (например, `runStage1`/`runStage2`/`runFullPipeline` определены в pipeline.js и используются в tab-generate/events/index; `collectReferences`/`buildReferenceInstruction` — в references.js и image-api.js).
- **Адаптации отмечены:** settings.html заменён на DOM-генерацию (Task 20 createSettingsPanel); это зафиксировано в File Structure.
