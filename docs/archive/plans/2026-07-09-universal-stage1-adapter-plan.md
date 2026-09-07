# Universal Stage 1 Adapter & Simplified UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать Stage 1 универсальным для любых text-LLM (любой JSON/inline-тег → `{style, prompt, aspectRatio, imageSize, quality}`) и упростить UI вкладки «Генерация», убрав захардкоженные «Тип кадра» и «Стиль» в пользу advanced-режима.

**Architecture:** Добавить чистый модуль `src/stage1-adapter.js`, который пытается распарсить ответ LLM в порядке: inline tag → structured draft → legacy `{style,prompt}` → smart extraction → adapter prompt fallback → plain text. `src/parser.js` перестраивается вокруг этого адаптера. UI скрывает «Тип кадра»/«Стиль» по умолчанию и показывает advanced-секцию под глобальным тогглом.

**Tech Stack:** ES modules, SillyTavern extension context, vanilla JS, existing test runner (Node.js + `node --test` или текущий runner проекта).

---

## File map

| File | Responsibility |
|---|---|
| `src/stage1-adapter.js` | **New.** Универсальная нормализация ответа LLM в инструкцию `{style, prompt, ...}`. |
| `src/parser.js` | **Modify.** Использовать `stage1-adapter.js`; оставить обратную совместимость; всегда возвращать `raw`. |
| `src/prompt-builder.js` | **Modify.** В raw-режиме явно требовать JSON `{style,prompt}` в system prompt tail. |
| `src/pipeline.js` | **Modify.** Передать template/rules в parser; сохранить `raw` в `state.lastInstruction`. |
| `src/core.js` | **Modify.** Добавить `advancedMode: false` в `defaultSettings`. |
| `index.js` | **Modify.** Убрать «Тип кадра»/«Стиль» из простого режима; добавить глобальный тоггл Advanced; показать сырой JSON. |
| `style.css` | **Modify.** Стили для advanced-секции и тоггла. |
| `tests/stage1-adapter.test.js` | **New.** Unit-тесты адаптера. |

---

## Task 1: Add `advancedMode` setting in `src/core.js`

**Files:**
- Modify: `src/core.js:58-83`

- [ ] **Step 1: Add `advancedMode: false` to `defaultSettings`**

```js
export const defaultSettings = Object.freeze({
    enabled: true,
    collapsed: true,
    stage1Mode: 'manual',
    stage2Mode: 'manual',
    historyRich: true,
    maxRetries: 0,
    retryDelay: 1000,
    generationTimeout: 120000,
    historyLimit: 20,
    galleryLimit: 0,
    galleryMode: 'anchor',
    copyToStGallery: false,
    windowGeometry: null,
    advancedMode: false,        // ← NEW
    apiSource: 'profile',
    profileId: '',
    customEndpoint: '',
    customModel: '',
});
```

- [ ] **Step 2: Verify the file loads without errors**

Run: `node -e "import('./src/core.js').then(m => console.log(m.defaultSettings.advancedMode))"`
Expected: `false`

- [ ] **Step 3: Commit**

```bash
git add src/core.js
git commit -m "feat(settings): add advancedMode default"
```

---

## Task 2: Improve raw system prompt in `src/prompt-builder.js`

**Files:**
- Modify: `src/prompt-builder.js:53,176-183`

- [ ] **Step 1: Add raw-mode JSON contract tail**

After line 53 (`JSON_ONLY_TAIL`), add:

```js
const RAW_JSON_CONTRACT = `\n\nВЕРНИ JSON-объект строго такой структуры:\n{\n  "style": "[полное описание визуального стиля]",\n  "prompt": "[полное описание изображения для image API]",\n  "aspectRatio": "9:16",\n  "imageSize": "2K"\n}\nЕсли стиль не важен — оставь "style" пустой строкой. aspectRatio и imageSize опциональны.`;
```

- [ ] **Step 2: Append contract only in raw mode**

Replace `buildRawSystemPrompt` (lines 176-183):

```js
function buildRawSystemPrompt(rawContent, activeCharacters = []) {
    let out = rawContent || DEFAULT_TEMPLATE;
    out = resolveSTMacros(out);
    out += renderCharactersBlock(activeCharacters);
    out += RAW_JSON_CONTRACT;
    out += JSON_ONLY_TAIL;
    return out;
}
```

- [ ] **Step 3: Run existing prompt-builder tests**

Run: `node --test tests/prompt-builder.test.js`
Expected: all pass (tests use `macroResolver=identity`; tail change should not break pure string assertions unless they assert exact output).

- [ ] **Step 4: Commit**

```bash
git add src/prompt-builder.js
git commit -m "feat(prompt-builder): add raw-mode JSON contract tail"
```

---

## Task 3: Create `src/stage1-adapter.js`

**Files:**
- Create: `src/stage1-adapter.js`

- [ ] **Step 1: Write the module with inline tag parser, heuristic extractor, and adapter prompt fallback**

```js
// @ts-check
/**
 * Universal Stage 1 adapter.
 * Converts any LLM response (inline tag, structured draft, legacy JSON,
 * arbitrary JSON, plain text) into a normalized instruction.
 */

import { parseInstructionJson, sanitizePrompt, warn } from './core.js';
import {
    normalizeDraft,
    validateDraft,
    applyRules,
    DEFAULT_RULES,
    KIND_PANELS,
    KIND_ILLUST,
    KIND_CINE,
} from './prompt-schema.js';
import { flattenToPrompt } from './prompt-flatter.js';
import { generatePromptText } from './text-api.js';

const STR = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const VALID_RATIOS = new Set(['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9']);
const VALID_SIZES = new Set(['1K','2K','4K']);
const VALID_QUALITIES = new Set(['low','medium','high']);

// ── Helpers ──
function pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) {
        if (obj[k] !== undefined) return obj[k];
    }
    return undefined;
}

function normalizeRatio(v) {
    const s = STR(v);
    if (VALID_RATIOS.has(s)) return s;
    // Common aliases
    if (s === '9/16') return '9:16';
    if (s === '16/9') return '16:9';
    if (s === '3/2') return '3:2';
    if (s === '2/3') return '2:3';
    if (s === '1/1') return '1:1';
    return null;
}

function normalizeSize(v) {
    const s = STR(v).toUpperCase();
    if (VALID_SIZES.has(s)) return s;
    if (/^\d+\s*x\s*\d+$/.test(STR(v))) {
        const [w, h] = STR(v).split('x').map(Number);
        const max = Math.max(w, h);
        if (max <= 1024) return '1K';
        if (max <= 2048) return '2K';
        return '4K';
    }
    return null;
}

function normalizeQuality(v) {
    const s = STR(v).toLowerCase();
    if (VALID_QUALITIES.has(s)) return s;
    return null;
}

function isStructuredDraft(d) {
    if (!d || typeof d !== 'object') return false;
    if (Array.isArray(d.characters) && d.characters.length > 0) return true;
    if (Array.isArray(d.panels) && d.panels.length > 0) return true;
    if (STR(d.camera) || STR(d.light) || STR(d.location)) return true;
    return false;
}

// ── Inline tag parsing ──
export function parseInlineImageTag(text) {
    if (!text || typeof text !== 'string') return null;

    // New format: <img data-iig-instruction='{...}' src="[IMG:GEN]">
    const imgMatch = text.match(/data-iig-instruction\s*=\s*(['"])/i);
    if (imgMatch) {
        const quote = imgMatch[1];
        const start = imgMatch.index + imgMatch[0].length;
        let end = -1;
        for (let i = start; i < text.length; i++) {
            if (text[i] === '\\') { i++; continue; }
            if (text[i] === quote) { end = i; break; }
        }
        if (end > start) {
            const payload = text.slice(start, end);
            const d = parseInstructionJson(payload);
            if (d) return d;
        }
    }

    // Legacy format: [IMG:GEN:{...}]
    const legacyMatch = text.match(/\[IMG:GEN:({[\s\S]*?})\]/);
    if (legacyMatch) {
        const d = parseInstructionJson(legacyMatch[1]);
        if (d) return d;
    }

    return null;
}

// ── Heuristic extraction from arbitrary JSON ──
export function extractSimpleFields(json) {
    if (!json || typeof json !== 'object') return null;

    const style = sanitizePrompt(STR(
        pick(json, ['style', 'art_style', 'artStyle', 'aesthetic', 'art_direction', 'artDirection', 'visual_style'])
    ));

    let prompt = '';
    const directPrompt = pick(json, ['prompt', 'description', 'scene_description', 'sceneDescription', 'image_prompt', 'imagePrompt', 'caption']);
    if (directPrompt) {
        prompt = STR(directPrompt);
    } else {
        const parts = [];
        const subject = pick(json, ['subject', 'subjects', 'character', 'characters', 'figure']);
        const setting = pick(json, ['setting', 'scene', 'location', 'place', 'environment', 'background']);
        const action = pick(json, ['action', 'actions', 'pose', 'poses', 'composition', 'moment']);
        const mood = pick(json, ['mood', 'atmosphere', 'tone']);
        const light = pick(json, ['light', 'lighting']);
        const camera = pick(json, ['camera', 'camera_angle', 'shot', 'framing']);

        if (subject) parts.push(`Subject: ${STR(subject)}`);
        if (action) parts.push(`Action: ${STR(action)}`);
        if (setting) parts.push(`Setting: ${STR(setting)}`);
        if (mood) parts.push(`Mood: ${STR(mood)}`);
        if (light) parts.push(`Lighting: ${STR(light)}`);
        if (camera) parts.push(`Camera: ${STR(camera)}`);

        prompt = parts.join('. ');
    }

    if (!prompt) return null;

    return {
        style,
        prompt: sanitizePrompt(prompt),
        aspectRatio: normalizeRatio(pick(json, ['aspectRatio', 'aspect_ratio', 'aspectRatio', 'ratio'])),
        imageSize: normalizeSize(pick(json, ['imageSize', 'image_size', 'size', 'resolution'])),
        quality: normalizeQuality(pick(json, ['quality', 'qualityPreset'])),
    };
}

// ── Adapter prompt fallback ──
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
- style — только визуальный стиль / art direction. Если нет — пустая строка.
- prompt — полное описание изображения: субъект, действие, окружение, свет, настроение.
- aspectRatio — одно из: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9. Если не указано — null.
- imageSize — одно из: 1K, 2K, 4K. Если не указано — null.
- quality — low, medium, high. Если не указано — null.
- Никакого markdown, никаких \`\`\`json блоков.`;

async function runAdapterPrompt(rawText, signal) {
    try {
        const user = `Нормализуй этот ответ:\n\n${rawText.slice(0, 8000)}`;
        const raw = await generatePromptText(ADAPTER_SYSTEM, user, () => {}, signal);
        const json = parseInstructionJson(raw);
        if (json && typeof json === 'object') {
            return {
                style: sanitizePrompt(STR(json.style)),
                prompt: sanitizePrompt(STR(json.prompt)),
                aspectRatio: normalizeRatio(json.aspectRatio),
                imageSize: normalizeSize(json.imageSize),
                quality: normalizeQuality(json.quality),
            };
        }
    } catch (e) {
        warn('Adapter prompt failed:', e.message);
    }
    return null;
}

// ── Normalize structured draft ──
function normalizeStructuredDraft(json, rules) {
    const kind = inferKind(json);
    const r = { ...DEFAULT_RULES, ...(rules || {}) };
    let draft = normalizeDraft(kind, json);
    draft = applyRules(r, draft);
    const v = validateDraft(kind, draft, r);
    if (!v.ok) warn('Stage1 draft validation issues:', v.errors.join(' | '));

    const styleString = sanitizePrompt(STR(draft.style));
    const prompt = flattenToPrompt(kind, draft, styleString, r);

    return {
        style: styleString,
        prompt,
        aspectRatio: draft.aspectRatio || null,
        imageSize: draft.imageSize || null,
        quality: null,
        draft,
        kind,
    };
}

function inferKind(d) {
    if (!d || typeof d !== 'object') return KIND_PANELS;
    if (Array.isArray(d.panels) && d.panels.length > 0) return KIND_PANELS;
    if (d.environment && typeof d.environment === 'object') return KIND_CINE;
    return KIND_ILLUST;
}

// ── Normalize legacy / extracted / inline tag ──
function normalizeSimple(obj, rawSource) {
    return {
        style: sanitizePrompt(STR(obj.style)),
        prompt: sanitizePrompt(STR(obj.prompt)),
        aspectRatio: normalizeRatio(obj.aspectRatio || obj.aspect_ratio),
        imageSize: normalizeSize(obj.imageSize || obj.image_size || obj.size),
        quality: normalizeQuality(obj.quality),
        draft: null,
        kind: null,
        raw: rawSource,
    };
}

// ── Main adapter entry point ──
export async function adaptStage1Response(rawText, template, rules, signal) {
    const text = String(rawText || '').trim();

    // 1. inline image tag
    const inline = parseInlineImageTag(text);
    if (inline) {
        return normalizeSimple(inline, text);
    }

    // 2. JSON extraction
    const json = parseInstructionJson(text);
    if (json && typeof json === 'object') {
        // 2a. structured draft
        if (isStructuredDraft(json)) {
            const result = normalizeStructuredDraft(json, rules);
            return { ...result, raw: json };
        }

        // 2b. legacy / simple
        if (json.style !== undefined || json.prompt !== undefined) {
            return normalizeSimple(json, json);
        }

        // 2c. smart extraction
        const extracted = extractSimpleFields(json);
        if (extracted?.prompt) {
            return normalizeSimple(extracted, json);
        }

        // 2d. adapter prompt fallback
        if (signal?.aborted !== true) {
            const adapted = await runAdapterPrompt(text, signal);
            if (adapted?.prompt) {
                return normalizeSimple(adapted, json);
            }
        }
    }

    // 3. plain text fallback
    return {
        style: '',
        prompt: sanitizePrompt(text),
        aspectRatio: null,
        imageSize: null,
        quality: null,
        draft: null,
        kind: null,
        raw: text,
    };
}
```

- [ ] **Step 2: Verify module loads**

Run: `node -e "import('./src/stage1-adapter.js').then(m => console.log(typeof m.adaptStage1Response))"`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add src/stage1-adapter.js
git commit -m "feat(stage1): add universal adapter module"
```

---

## Task 4: Rewrite `src/parser.js` to use the adapter

**Files:**
- Modify: `src/parser.js` (full file)

- [ ] **Step 1: Replace file contents**

```js
// @ts-check
/**
 * Stage 1 response parser.
 * v2: delegates to stage1-adapter.js for universal normalization.
 * Keeps legacy exports for backwards compatibility.
 */
import { parseInstructionJson, sanitizePrompt, warn } from './core.js';
import { normalizeDraft, validateDraft, applyRules, DEFAULT_RULES, KIND_PANELS, KIND_ILLUST, KIND_CINE } from './prompt-schema.js';
import { flattenToPrompt } from './prompt-flatter.js';
import { adaptStage1Response } from './stage1-adapter.js';

const STR = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

// Re-exported for existing consumers/tests.
export function isStructuredDraft(d) {
    if (!d || typeof d !== 'object') return false;
    if (Array.isArray(d.characters) && d.characters.length > 0) return true;
    if (Array.isArray(d.panels) && d.panels.length > 0) return true;
    if (STR(d.camera) || STR(d.light) || STR(d.location)) return true;
    return false;
}

export function inferKind(d) {
    if (!d || typeof d !== 'object') return KIND_PANELS;
    if (Array.isArray(d.panels) && d.panels.length > 0) return KIND_PANELS;
    if (d.environment && typeof d.environment === 'object') return KIND_CINE;
    return KIND_ILLUST;
}

/**
 * Backwards-compatible synchronous normalizer for structured/legacy JSON.
 * New code should prefer adaptStage1Response.
 */
export function normalizeInstruction(d, kind, rules) {
    if (!d) return null;

    if (isStructuredDraft(d)) {
        const k = kind && [KIND_PANELS, KIND_ILLUST, KIND_CINE].includes(kind) ? kind : inferKind(d);
        const r = { ...DEFAULT_RULES, ...(rules || {}) };
        const cleanStyle = sanitizePrompt(STR(d.style || ''));
        let draft = normalizeDraft(k, d);
        draft = applyRules(r, draft);
        const v = validateDraft(k, draft, r);
        if (!v.ok) warn('Stage1 draft validation issues:', v.errors.join(' | '));
        const styleString = cleanStyle || STR(d.style || '');
        const prompt = flattenToPrompt(k, draft, styleString, r);
        return {
            style: styleString,
            prompt,
            aspectRatio: draft.aspectRatio || d.aspect_ratio || d.aspectRatio || null,
            imageSize: draft.imageSize || d.image_size || d.imageSize || null,
            quality: d.quality || null,
            draft,
            kind: k,
            raw: d,
        };
    }

    return {
        style: sanitizePrompt(STR(d.style || '')),
        prompt: sanitizePrompt(STR(d.prompt || '')),
        aspectRatio: d.aspect_ratio || d.aspectRatio || null,
        imageSize: d.image_size || d.imageSize || null,
        quality: d.quality || null,
        draft: null,
        kind: kind || null,
        raw: d,
    };
}

/**
 * Universal async parser.
 * @param {string} text — raw LLM response
 * @param {object} [templateContent] — v2 template object
 * @param {object} [rules] — template rules
 * @param {AbortSignal} [signal]
 * @returns {Promise<object|null>}
 */
export async function parseInstructionFromText(text, templateContent, rules, signal) {
    const raw = String(text || '');
    const instr = await adaptStage1Response(raw, templateContent, rules, signal);
    if (!instr || !instr.prompt) {
        warn('Не удалось распарсить инструкцию из ответа');
        return null;
    }
    return instr;
}

// Legacy synchronous parser for inline tags in HTML (kept for callers that need sync).
export function parseInlineTagSync(text) {
    const raw = String(text || '');
    const attrMatch = raw.match(/data-iig-instruction\s*=\s*(['"])/i);
    if (attrMatch) {
        const quote = attrMatch[1];
        const start = attrMatch.index + attrMatch[0].length;
        let end = -1;
        for (let i = start; i < raw.length; i++) {
            if (raw[i] === '\\') { i++; continue; }
            if (raw[i] === quote) { end = i; break; }
        }
        if (end > start) {
            const d = parseInstructionJson(raw.slice(start, end));
            if (d) return normalizeInstruction(d, null, {});
        }
    }
    return null;
}
```

- [ ] **Step 2: Run parser tests**

Run: `node --test tests/parser.test.js`
Expected: all pass (may need to update if tests assert `draft: null` without `raw`; we added `raw` field).

- [ ] **Step 3: Fix any failing tests**

If tests fail due to missing `raw` field in expectations, update expected objects to include `raw: <input>`.

- [ ] **Step 4: Commit**

```bash
git add src/parser.js tests/parser.test.js
git commit -m "feat(parser): use universal stage1 adapter, always return raw"
```

---

## Task 5: Update `src/pipeline.js` to pass template/rules and save raw

**Files:**
- Modify: `src/pipeline.js:90-120`

- [ ] **Step 1: Replace runStage1 parser call**

In `runStage1`, replace lines 94-120 (the section that calls `parseInstructionFromText`):

```js
        const isV2 = templateContent && typeof templateContent === 'object'
            && templateContent.schemaVersion === 2;
        const kind = isV2 ? (templateContent.outputKind || 'manga-page') : 'manga-page';
        const rules = isV2 ? (templateContent.rules || {}) : {};
        const styleOverride = state.styleOverride || '';

        const system = buildSystemPrompt(
            templateContent, activeChars,
            { kindOverride: kind, styleOverride: styleOverride || undefined },
        );
        const user = buildUserPrompt(msg.mes);
        const raw = await generatePromptText(system, user, onStatus, useSignal);
        if (useSignal.aborted) throw new DOMException('Aborted', 'AbortError');
        const instr = await parseInstructionFromText(raw, templateContent, rules, useSignal);
        if (!instr) throw new Error('Не удалось распарсить промпт из ответа LLM');

        // Apply style override if any
        if (styleOverride) {
            const modelStyle = instr.style || '';
            instr.style = modelStyle ? `${styleOverride}, ${modelStyle}` : styleOverride;
            // Re-assemble prompt with override style
            if (instr.draft && instr.kind) {
                const r = { ...DEFAULT_RULES, ...rules };
                instr.prompt = flattenToPrompt(instr.kind, instr.draft, instr.style, r);
            }
        }

        state.lastInstruction = instr;
        log('Stage 1 готова:', {
            style: instr.style?.slice(0, 40),
            prompt: instr.prompt?.slice(0, 40),
            kind: instr.kind || kind,
            hasDraft: !!instr.draft,
            hasRaw: !!instr.raw,
        });
        return instr;
```

- [ ] **Step 2: Add missing imports**

At the top of `src/pipeline.js`, add:

```js
import { DEFAULT_RULES } from './prompt-schema.js';
import { flattenToPrompt } from './prompt-flatter.js';
```

- [ ] **Step 3: Run smoke test**

Run: `node --test tests/smoke.test.js`
Expected: pass

- [ ] **Step 4: Commit**

```bash
git add src/pipeline.js
git commit -m "feat(pipeline): use adapter, apply style override, keep raw"
```

---

## Task 6: Add unit tests for `src/stage1-adapter.js`

**Files:**
- Create: `tests/stage1-adapter.test.js`

- [ ] **Step 1: Write tests**

```js
// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseInlineImageTag, extractSimpleFields, adaptStage1Response } from '../src/stage1-adapter.js';

describe('stage1-adapter', () => {
    describe('parseInlineImageTag', () => {
        it('parses new-format img tag', () => {
            const text = `<img data-iig-instruction='{"style":"anime","prompt":"a girl","aspect_ratio":"9:16","image_size":"2K"}' src="[IMG:GEN]">`;
            const result = parseInlineImageTag(text);
            assert.equal(result.style, 'anime');
            assert.equal(result.prompt, 'a girl');
        });

        it('parses legacy [IMG:GEN:{...}] tag', () => {
            const text = `[IMG:GEN:{"style":"oil","prompt":"a castle"}]`;
            const result = parseInlineImageTag(text);
            assert.equal(result.style, 'oil');
            assert.equal(result.prompt, 'a castle');
        });

        it('returns null for plain text', () => {
            assert.equal(parseInlineImageTag('just text'), null);
        });
    });

    describe('extractSimpleFields', () => {
        it('extracts from subject/setting/action structure', () => {
            const json = {
                subject: { name: 'Angrod', description: 'elf prince' },
                setting: { location: 'fountain garden' },
                action: { scene_description: 'Angrod sits by the fountain' },
                technical_specifications: { art_style: 'Baroque oil painting' },
            };
            const result = extractSimpleFields(json);
            assert.equal(result.style, 'Baroque oil painting');
            assert.ok(result.prompt.includes('Angrod sits by the fountain'));
            assert.ok(result.prompt.includes('fountain garden'));
        });

        it('prefers direct prompt field', () => {
            const json = { prompt: 'direct prompt', description: 'ignored' };
            const result = extractSimpleFields(json);
            assert.equal(result.prompt, 'direct prompt');
        });

        it('returns null when no prompt-like field exists', () => {
            const result = extractSimpleFields({ foo: 'bar' });
            assert.equal(result, null);
        });
    });

    describe('adaptStage1Response', () => {
        it('handles legacy {style,prompt}', async () => {
            const text = '{"style":"anime","prompt":"a girl"}';
            const instr = await adaptStage1Response(text, null, {});
            assert.equal(instr.style, 'anime');
            assert.equal(instr.prompt, 'a girl');
            assert.ok(instr.raw);
        });

        it('handles arbitrary JSON via smart extraction', async () => {
            const text = JSON.stringify({
                subject: { name: 'Angrod' },
                setting: { location: 'garden' },
                action: { scene_description: 'Angrod smiles' },
                technical_specifications: { art_style: 'oil' },
            });
            const instr = await adaptStage1Response(text, null, {}, new AbortController().signal);
            assert.equal(instr.style, 'oil');
            assert.ok(instr.prompt.includes('Angrod smiles'));
        });

        it('falls back to plain text', async () => {
            const text = 'a beautiful landscape';
            const instr = await adaptStage1Response(text, null, {});
            assert.equal(instr.prompt, 'a beautiful landscape');
            assert.equal(instr.style, '');
        });
    });
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/stage1-adapter.test.js`
Expected: all pass

- [ ] **Step 3: Commit**

```bash
git add tests/stage1-adapter.test.js
git commit -m "test(stage1): add adapter unit tests"
```

---

## Task 7: Simplify UI in `index.js`

**Files:**
- Modify: `index.js` (specific lines depend on current UI code)

- [ ] **Step 1: Remove «Тип кадра» dropdown from simple mode**

Find the DOM element for output kind (search for `outputKind`, `Тип кадра`, `manga-page` in `index.js`). Remove or hide it in simple mode. Keep the element reference for advanced mode.

Example pattern:

```js
// Instead of always appending:
// generationBlock.appendChild(outputKindRow);

// Append only in advanced mode:
if (state.settings.advancedMode) {
    generationBlock.appendChild(outputKindRow);
}
```

- [ ] **Step 2: Remove «Стиль» field from simple mode**

Find the style row/textarea (search for `styleInput`, `Стиль`, `style-override`). Hide it unless `advancedMode` is on.

- [ ] **Step 3: Add global Advanced toggle**

Add a toggle checkbox near the top of the Generation tab (e.g., next to window controls or under Stage selectors):

```js
const advancedToggle = document.createElement('label');
advancedToggle.className = 'uris-advanced-toggle';
advancedToggle.innerHTML = `<input type="checkbox" ${state.settings.advancedMode ? 'checked' : ''}> Advanced`;
advancedToggle.querySelector('input').addEventListener('change', async (e) => {
    state.settings.advancedMode = e.target.checked;
    saveSettings();
    await renderGenerationTab(); // or rebuild relevant section
});
headerRow.appendChild(advancedToggle);
```

- [ ] **Step 4: Show raw JSON in advanced mode**

The raw JSON textarea should already exist (search for `rawJson`). Ensure it is visible only when `state.settings.advancedMode` is true. Bind its value to `state.lastInstruction?.raw`.

Add a "Пересобрать из JSON" button in advanced mode:

```js
const rebuildBtn = document.createElement('button');
rebuildBtn.textContent = 'Пересобрать промпт из JSON';
rebuildBtn.className = 'menu_button';
rebuildBtn.addEventListener('click', async () => {
    const raw = parseInstructionJson(rawJsonTextarea.value);
    if (!raw) return toastr.error('Невалидный JSON');
    const instr = normalizeInstruction(raw, null, {});
    if (instr) {
        state.lastInstruction = instr;
        updatePromptUI(instr);
    }
});
```

- [ ] **Step 5: Add Quality dropdown in advanced mode**

```js
const qualitySelect = document.createElement('select');
['auto','low','medium','high'].forEach(q => {
    const opt = document.createElement('option');
    opt.value = q;
    opt.textContent = q;
    qualitySelect.appendChild(opt);
});
qualitySelect.value = state.lastInstruction?.quality || 'auto';
qualitySelect.addEventListener('change', () => {
    if (state.lastInstruction) state.lastInstruction.quality = qualitySelect.value;
});
```

Show only in advanced mode.

- [ ] **Step 6: Verify UI renders**

Load the extension in SillyTavern. Open the Generation tab.
Expected: no «Тип кадра»/«Стиль» by default; Advanced toggle visible; toggling Advanced shows extra fields.

- [ ] **Step 7: Commit**

```bash
git add index.js
git commit -m "feat(ui): simplify generation tab, add advanced toggle"
```

---

## Task 8: Add CSS for advanced mode

**Files:**
- Modify: `style.css`

- [ ] **Step 1: Add styles**

```css
.uris-advanced-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    font-size: 0.9em;
    color: var(--uris-text-secondary, #aaa);
    cursor: pointer;
}

.uris-advanced-toggle input[type="checkbox"] {
    margin: 0;
}

.uris-advanced-section {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--uris-border, #444);
}

.uris-advanced-section label {
    display: block;
    margin-bottom: 4px;
    font-size: 0.85em;
    color: var(--uris-text-secondary, #aaa);
}

.uris-raw-json {
    width: 100%;
    min-height: 120px;
    font-family: monospace;
    font-size: 0.85em;
    background: var(--uris-bg-input, #1a1a1a);
    color: var(--uris-text, #eee);
    border: 1px solid var(--uris-border, #444);
    border-radius: 4px;
    padding: 8px;
    resize: vertical;
}
```

- [ ] **Step 2: Commit**

```bash
git add style.css
git commit -m "feat(ui): add advanced section styles"
```

---

## Task 9: Run full test suite

- [ ] **Step 1: Run all tests**

Run: `node --test tests/*.test.js`
Expected: all pass

- [ ] **Step 2: Manual integration check**

1. Create a raw template that asks for `subject/setting/action/technical_specifications` JSON.
2. Run Stage 1.
3. Verify that `style` and `prompt` are populated via smart extraction.
4. Verify raw JSON is visible in advanced mode.
5. Verify structured manga template still works as before.
6. Verify inline `<img data-iig-instruction='...' src="[IMG:GEN]">` parses correctly.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: address test/integration findings"
```

---

## Task 10: Update docs and changelog

- [ ] **Step 1: Add a note to the spec or README**

In `README.md` or a new `CHANGELOG.md` entry, document:
- Stage 1 now accepts arbitrary JSON responses.
- UI simplified; old output kind / style fields moved to advanced mode.
- New `advancedMode` setting.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document universal stage1 adapter and simplified UI"
```

---

## Self-review checklist

- [ ] Spec coverage: every section of `2026-07-09-universal-stage1-adapter-design.md` maps to at least one task.
- [ ] Placeholder scan: no TBD/TODO/fill-in-details steps.
- [ ] Type consistency: `adaptStage1Response` returns `{style,prompt,aspectRatio,imageSize,quality,draft,kind,raw}` everywhere.
- [ ] Backwards compatibility: old structured templates and raw templates still work.
- [ ] Test coverage: adapter has unit tests; parser/pipeline tests still pass.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-09-universal-stage1-adapter-plan.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach?
