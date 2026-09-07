# Stage 1 Prompt System Rework (v3 Field Registry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the v2 prompt-building layer (two parallel raw/structured paths, triple-coupled schema/flatter/validator, god-object template) with a Field Registry that makes each prompt field a self-contained declaration consumed by thin functions, and rebuild the template editor UI as a two-level Simple/Advanced form (no raw JSON textarea).

**Architecture:** Three new pure modules under `src/registry/` (`fields.js`, `kinds.js`, `resolve.js`) declare fields and kind presets. `prompt-builder.js`, `prompt-schema.js`, `prompt-flatter.js` become thin iterators over the registry. `pipeline.js` loses its post-hoc style re-assembly. The UI is rewritten as typed controls. `subject` field is removed (characters is the sole subject source); `selfie`+`instagram` merge into one `photo` kind; `flattenOrder` becomes a fixed per-kind constant (not user-editable). schemaVersion bumps to 3 (clean break — no migration).

**Tech Stack:** ES modules (static `import`), SillyTavern extension context (`ctx.substituteParams`), vanilla JS DOM, localforage via `SillyTavern.libs.localforage`, Node v24 `node --test` runner.

**Spec:** `docs/superpowers/specs/2026-07-11-stage1-prompt-rework-design.md`

---

## Conventions

- **TDD:** every pure module gets a test file written first, run to red, then implemented to green.
- **Pure modules first:** `registry/*` and rewritten prompt modules have zero SillyTavern deps and are fully unit-testable. Build them before touching UI/pipeline.
- **Commit per step** where a step produces a coherent change.
- **Test command:** `node --test tests/<file>.test.js` for single, `node --test tests/*.test.js` for all.
- **No `package.json`** in this project — tests import source files directly via relative paths.
- **Kinds (v3 names):** `manga`, `cinematic`, `illustration`, `photo`. (v2 names `manga-page`, `single-illustration`, `cinematic-still` are internal KIND constants kept for compatibility — see Task 2.)
- **Branch:** work on `URIS` (current branch). Do NOT create a new branch unless asked.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/registry/fields.js` | **NEW** | `defineField` registry + all built-in field declarations (style, camera, light, location, mood, characters, panels, speechBubbles, environment) |
| `src/registry/kinds.js` | **NEW** | 4 kind presets (manga, cinematic, illustration, photo) with pre-filled fields/catalog/wrapper + per-kind fixed flatten order |
| `src/registry/resolve.js` | **NEW** | `resolveFields(template)` → ordered field list; `fieldsFor(kind, template)` |
| `src/prompt-builder.js` | **REWRITE** | `buildSystemPrompt(template, chars, opts)` — single path over registry; `buildUserPrompt` (logic unchanged) |
| `src/prompt-schema.js` | **REWRITE** | `normalizeDraft` / `validateDraft` / `applyRules` — thin functions over registry; remove `subject` |
| `src/prompt-flatter.js` | **REWRITE** | `flatten(template, draft, opts)` — iterate ordered fields, call `field.flatten`; wrapper head/tail |
| `src/default-template.js` | **REWRITE** | Remove raw path + `DEFAULT_RAW_TEMPLATE`; re-export v3 templates via `registry/kinds.js` |
| `src/style-resolver.js` | **MINOR** | Unchanged logic; already correct for v3 |
| `src/pipeline.js` | **SIMPLIFY** | Remove post-hoc re-assembly (`:111-118`); linear flow; single `STYLE.resolve` call |
| `src/parser.js` | **MODIFY** | Pass template through to adapter; use new flatten signature |
| `src/stage1-adapter.js` | **MODIFY** | `normalizeStructuredDraft` uses new flatten signature; no `subject` |
| `src/prompt-templates.js` | **MODIFY** | schemaVersion 3 default content; remove v1→v2 migration |
| `src/ui/tab-templates.js` | **REWRITE** | Two-level Simple/Advanced typed controls |
| `src/ui/tab-generate.js` | **MODIFY** | Remove `subject`; draft editor driven by registry fields |
| `index.js` | **MODIFY** | `ensureDefaultTemplate` uses v3 default; update imports |
| `tests/registry-fields.test.js` | **NEW** | Unit tests for field declarations |
| `tests/registry-kinds.test.js` | **NEW** | Unit tests for kind presets |
| `tests/registry-resolve.test.js` | **NEW** | Unit tests for field resolution |
| `tests/prompt-builder.test.js` | **REWRITE** | Tests for new `buildSystemPrompt` |
| `tests/schema.test.js` | **REWRITE** | Tests for new normalize/validate/applyRules |
| `tests/flatter.test.js` | **REWRITE** | Tests for new `flatten` |

---

## Task 1: Create field registry (`src/registry/fields.js`)

**Files:**
- Create: `src/registry/fields.js`
- Test: `tests/registry-fields.test.js`

This module declares every built-in field as a self-contained object with `describe`, `validate`, `flatten`, `uiType`, `appliesTo`. The registry is a plain object keyed by field name. No SillyTavern deps — pure.

- [ ] **Step 1: Write the failing test**

Create `tests/registry-fields.test.js`:

```js
// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY, getField, defineField, BUILTIN_FIELDS } from '../src/registry/fields.js';

test('REGISTRY contains all 9 built-in fields', () => {
    const names = Object.keys(BUILTIN_FIELDS).sort();
    assert.deepEqual(names, ['camera','characters','environment','light','location','mood','panels','speechBubbles','style']);
});

test('each built-in field has describe, validate, flatten, uiType, appliesTo', () => {
    for (const [name, f] of Object.entries(BUILTIN_FIELDS)) {
        assert.equal(typeof f.name, 'string', `${name}.name`);
        assert.equal(f.name, name);
        assert.equal(typeof f.describe, 'string', `${name}.describe`);
        assert.equal(typeof f.validate, 'function', `${name}.validate`);
        assert.equal(typeof f.flatten, 'function', `${name}.flatten`);
        assert.ok(Array.isArray(f.appliesTo), `${name}.appliesTo`);
        assert.equal(typeof f.uiType, 'string', `${name}.uiType`);
    }
});

test('camera.validate returns null for non-empty string, "empty" for blank', () => {
    assert.equal(getField('camera').validate('wide shot'), null);
    assert.equal(getField('camera').validate(''), 'empty');
    assert.equal(getField('camera').validate('   '), 'empty');
});

test('camera.flatten wraps value in [CAMERA: ...]', () => {
    assert.equal(getField('camera').flatten('wide shot, 35mm', {}), '[CAMERA: wide shot, 35mm]');
    assert.equal(getField('camera').flatten('', {}), '');
});

test('characters.validate returns null when at least 1 char with name', () => {
    const ok = getField('characters').validate([{ name: 'Mira', hair: 'dark' }]);
    assert.equal(ok, null);
    const bad = getField('characters').validate([]);
    assert.equal(bad, 'no-characters');
});

test('characters.flatten renders name-first blocks', () => {
    const out = getField('characters').flatten(
        [{ name: 'Mira', hair: 'auburn', face: 'pale', clothing: 'robe', action: 'gripping', gaze: 'ahead', emotion: 'tense', traits: '' }],
        {},
    );
    assert.match(out, /^Mira,/);
    assert.match(out, /auburn hair/);
});

test('panels.validate checks count against rules', () => {
    const f = getField('panels');
    const panels4 = Array.from({ length: 4 }, () => ({ shot: 'medium' }));
    assert.equal(f.validate(panels4, { minPanels: 4, maxPanels: 5 }), null);
    assert.equal(f.validate([], { minPanels: 4, maxPanels: 5 }), 'too-few-panels');
    const panels6 = Array.from({ length: 6 }, () => ({ shot: 'medium' }));
    assert.equal(f.validate(panels6, { minPanels: 4, maxPanels: 5 }), 'too-many-panels');
});

test('style field exists with uiType style-editor and appliesTo ["*"]', () => {
    const s = getField('style');
    assert.equal(s.uiType, 'style-editor');
    assert.deepEqual(s.appliesTo, ['*']);
});

test('defineField adds to REGISTRY and getField retrieves it', () => {
    defineField({ name: '__test_custom', label: 'Test', describe: 'd', validate: () => null, flatten: (v) => `T:${v}`, uiType: 'text', appliesTo: ['manga'] });
    assert.equal(getField('__test_custom').flatten('x', {}), 'T:x');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/registry-fields.test.js`
Expected: FAIL — module `../src/registry/fields.js` not found.

- [ ] **Step 3: Write the implementation**

Create `src/registry/fields.js`:

```js
// @ts-check
/**
 * v3 Field Registry. Each field is a self-contained declaration:
 * { name, label, appliesTo, describe, validate, flatten, uiType }.
 *
 * The four v2 consumers (describeSchema, renderFieldInstructions,
 * validateDraft, flattenToPrompt) become thin functions over this registry.
 *
 * Pure module — no SillyTavern deps.
 */

const STR = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const CLEAN = (v) => STR(v).replace(/'/g, '').replace(/\s+/g, ' ').trim();

// ── Flatten helpers (shared by structured fields) ──

function joinNonEmpty(parts, sep = ', ') {
    return parts.map(CLEAN).filter(Boolean).join(sep);
}

function charBlock(c) {
    if (!c) return '';
    const name = STR(c.name);
    const desc = joinNonEmpty([
        c.hair ? `${c.hair} hair` : '',
        c.face,
        c.clothing ? `wearing ${c.clothing}` : '',
        c.traits ? `with ${c.traits}` : '',
    ]);
    const action = CLEAN(c.action);
    const gaze = CLEAN(c.gaze) ? `gaze ${CLEAN(c.gaze)}` : '';
    const emotion = CLEAN(c.emotion) ? `expression ${CLEAN(c.emotion)}` : '';
    const tail = [action, gaze, emotion].filter(Boolean).join('; ');
    const head = name ? `${name}, ${desc}` : desc;
    return tail ? `${head}; ${tail}` : head;
}

function panelBlock(p) {
    if (!p) return '';
    const head = joinNonEmpty([
        p.type ? `${p.type} panel` : 'panel',
        p.shape,
        p.shot,
        p.angle,
        p.lightingColor,
    ]);
    let chars = '';
    if (Array.isArray(p.charsInFrame) && p.charsInFrame.length) {
        chars = `chars in frame: ${p.charsInFrame.map(CLEAN).filter(Boolean).join(', ')}`;
    }
    let actions = '';
    if (Array.isArray(p.actions) && p.actions.length) {
        actions = `actions: ${p.actions.map(CLEAN).filter(Boolean).join(', ')}`;
    }
    const sfx = CLEAN(p.sfx) ? `SFX "${p.sfx}"` : '';
    return [head, chars, actions, sfx].filter(Boolean).join('; ');
}

function bubbleBlock(b) {
    if (!b || !b.target) return '';
    const t = CLEAN(b.text);
    if (!t) return '';
    const text = t.replace(/"/g, '');
    return `speech bubble pointing to ${CLEAN(b.target)} says "${text}"`;
}

function environmentBlock(env) {
    if (!env) return '';
    const geo = CLEAN(env.geoAnchor);
    const props = Array.isArray(env.props) ? env.props.map(CLEAN).filter(Boolean).join(', ') : '';
    const atm = CLEAN(env.atmosphere);
    const ground = CLEAN(env.ground);
    const parts = [];
    if (geo) parts.push(`location (${geo})`);
    if (props) parts.push(`props: ${props}`);
    if (atm) parts.push(`atmosphere: ${atm}`);
    if (ground) parts.push(`ground: ${ground}`);
    return parts.join('; ');
}

// ── Field declarations ──

const ALL = () => ['manga', 'illustration', 'cinematic', 'photo'];

function textFlatten(tag) {
    return (v) => {
        const s = CLEAN(v);
        return s ? `[${tag}: ${s}]` : '';
    };
}

const styleField = {
    name: 'style',
    label: 'Стиль',
    appliesTo: ['*'],
    describe: 'Visual style (formula: show/light/grade or art-style descriptor)',
    validate: () => null, // style may be empty (llm-pick fills later)
    flatten: (v, ctx) => {
        // If a resolved style was computed at build time (pinned/random/override),
        // it wins — even if LLM disobeyed. See spec §5.3.
        if (ctx && ctx.resolvedStyle != null) return CLEAN(ctx.resolvedStyle);
        return CLEAN(v);
    },
    uiType: 'style-editor',
};

const cameraField = {
    name: 'camera',
    label: 'Камера',
    appliesTo: ALL(),
    describe: 'Shot type, angle, focal length, framing, DOF',
    validate: (v) => (STR(v) ? null : 'empty'),
    flatten: textFlatten('CAMERA'),
    uiType: 'textarea',
};

const lightField = {
    name: 'light',
    label: 'Свет',
    appliesTo: ALL(),
    describe: 'One named practical key source + direction',
    validate: (v) => (STR(v) ? null : 'empty'),
    flatten: textFlatten('LIGHT'),
    uiType: 'textarea',
};

const locationField = {
    name: 'location',
    label: 'Локация',
    appliesTo: ['manga', 'illustration'],
    describe: 'Place, time, weather',
    validate: (v) => (STR(v) ? null : 'empty'),
    flatten: textFlatten('LOCATION'),
    uiType: 'textarea',
};

const moodField = {
    name: 'mood',
    label: 'Настроение',
    appliesTo: ALL(),
    describe: 'Single emotional sentence',
    validate: (v) => (STR(v) ? null : 'empty'),
    flatten: (v) => {
        const s = CLEAN(v);
        return s ? `MOOD: ${s}` : '';
    },
    uiType: 'textarea',
};

const charactersField = {
    name: 'characters',
    label: 'Персонажи',
    appliesTo: ALL(),
    describe: 'array — each {name, face, hair, clothing, action, gaze, emotion, traits}. The sole subject source. Extract ALL traits from character cards. Non-human traits as practical prosthetics. Every character mid-action. Name first.',
    validate: (v, _rules) => {
        if (!Array.isArray(v) || v.length === 0) return 'no-characters';
        return null;
    },
    flatten: (v) => {
        if (!Array.isArray(v) || !v.length) return '';
        return 'Characters: ' + v.map(charBlock).join('; ') + '.';
    },
    uiType: 'cards',
};

const panelsField = {
    name: 'panels',
    label: 'Панели',
    appliesTo: ['manga'],
    describe: 'each {type, shape, shot, angle, lightingColor, charsInFrame:[], actions:[], sfx}',
    validate: (v, rules) => {
        const r = rules || {};
        const arr = Array.isArray(v) ? v : [];
        if (r.minPanels != null && arr.length < r.minPanels) return 'too-few-panels';
        if (r.maxPanels != null && arr.length > r.maxPanels) return 'too-many-panels';
        return null;
    },
    flatten: (v) => {
        if (!Array.isArray(v) || !v.length) return '';
        return 'Panels: ' + v.map(panelBlock).join('. ') + '.';
    },
    uiType: 'cards',
};

const speechBubblesField = {
    name: 'speechBubbles',
    label: 'Реплики',
    appliesTo: ['manga'],
    describe: 'each {target, text}. Text in bubbleLanguage (default ru).',
    validate: () => null,
    flatten: (v) => {
        if (!Array.isArray(v) || !v.length) return '';
        const bb = v.map(bubbleBlock).filter(Boolean);
        if (!bb.length) return '';
        return '[' + bb.join('] [') + '].';
    },
    uiType: 'cards',
};

const environmentField = {
    name: 'environment',
    label: 'Окружение',
    appliesTo: ['cinematic', 'photo'],
    describe: '{geoAnchor, props[], atmosphere, ground}',
    validate: () => null,
    flatten: (v) => {
        const out = environmentBlock(v);
        return out ? `Environment: ${out}.` : '';
    },
    uiType: 'object',
};

// ── Registry ──

export const BUILTIN_FIELDS = Object.freeze({
    style: Object.freeze(styleField),
    camera: Object.freeze(cameraField),
    light: Object.freeze(lightField),
    location: Object.freeze(locationField),
    mood: Object.freeze(moodField),
    characters: Object.freeze(charactersField),
    panels: Object.freeze(panelsField),
    speechBubbles: Object.freeze(speechBubblesField),
    environment: Object.freeze(environmentField),
});

export const REGISTRY = { ...BUILTIN_FIELDS };

export function defineField(decl) {
    if (!decl || typeof decl !== 'object' || !decl.name) {
        throw new Error('defineField: decl.name required');
    }
    REGISTRY[decl.name] = decl;
    return decl;
}

export function getField(name) {
    return REGISTRY[name] || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/registry-fields.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry/fields.js tests/registry-fields.test.js
git commit -m "feat(registry): add field registry with 9 built-in fields"
```

---

## Task 2: Create kind presets (`src/registry/kinds.js`)

**Files:**
- Create: `src/registry/kinds.js`
- Test: `tests/registry-kinds.test.js`

Declares 4 kind presets (manga, cinematic, illustration, photo), each with: field list, style catalog, wrapper (head/tail, with `preset` select for photo), rules defaults, aspect/size defaults, and the fixed flatten order. Also exports the KIND constant mapping (v3 short name → internal kind id).

- [ ] **Step 1: Write the failing test**

Create `tests/registry-kinds.test.js`:

```js
// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KIND_PRESETS, KINDS, getKindPreset, FLATTEN_ORDER } from '../src/registry/kinds.js';

test('KINDS has exactly 4 kinds', () => {
    assert.deepEqual(KINDS.sort(), ['cinematic', 'illustration', 'manga', 'photo']);
});

test('each preset has fields array, non-empty catalog, wrapper, flattenOrder, aspectRatioDefault', () => {
    for (const kind of KINDS) {
        const p = getKindPreset(kind);
        assert.ok(Array.isArray(p.fields) && p.fields.length > 0, `${kind}.fields`);
        assert.ok(Array.isArray(p.styleCatalog) && p.styleCatalog.length > 0, `${kind}.catalog`);
        assert.ok(typeof p.wrapper === 'object', `${kind}.wrapper`);
        assert.ok(typeof p.aspectRatioDefault === 'string', `${kind}.aspectRatioDefault`);
        assert.ok(typeof p.imageSizeDefault === 'string', `${kind}.imageSizeDefault`);
    }
});

test('manga preset has panels and speechBubbles in fields', () => {
    const f = getKindPreset('manga').fields;
    assert.ok(f.includes('panels'));
    assert.ok(f.includes('speechBubbles'));
});

test('manga catalog has 12 styles', () => {
    assert.equal(getKindPreset('manga').styleCatalog.length, 12);
});

test('photo preset has wrapper.preset select with selfie/instagram/portrait options', () => {
    const w = getKindPreset('photo').wrapper;
    assert.deepEqual(w.presets, ['selfie', 'instagram', 'portrait']);
    assert.ok(typeof w.headByPreset === 'object');
    assert.ok(typeof w.tailByPreset === 'object');
});

test('FLATTEN_ORDER has a fixed order array for each kind', () => {
    for (const kind of KINDS) {
        const order = FLATTEN_ORDER[kind];
        assert.ok(Array.isArray(order) && order.length > 0, `${kind} order`);
        // style always first
        assert.equal(order[0], 'style');
    }
});

test('no preset field list contains "subject"', () => {
    for (const kind of KINDS) {
        assert.ok(!getKindPreset(kind).fields.includes('subject'), `${kind} has subject`);
    }
});

test('no kind is named "selfie" or "instagram"', () => {
    assert.ok(!KINDS.includes('selfie'));
    assert.ok(!KINDS.includes('instagram'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/registry-kinds.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/registry/kinds.js`:

```js
// @ts-check
/**
 * v3 Kind Presets. 4 built-in kinds: manga, cinematic, illustration, photo.
 *
 * `photo` replaces v2's selfie + instagram — they shared identical fields
 * and differed only in wrapper boilerplate. photo carries both wrapper
 * variants via wrapper.presets (spec §7).
 *
 * The style catalogs are carried over 1:1 from v2 default-template.js.
 *
 * Pure module — no SillyTavern deps.
 */

export const KINDS = Object.freeze(['manga', 'cinematic', 'illustration', 'photo']);

// Internal kind id mapping (v3 short name is the canonical kind now).
// v2 used 'manga-page' / 'single-illustration' / 'cinematic-still' as
// the outputKind field; we keep them as aliases for the adapter/parser
// which infers kind from draft shape.
export const KIND_ALIASES = Object.freeze({
    'manga-page': 'manga',
    'single-illustration': 'illustration',
    'cinematic-still': 'cinematic',
});

// ── Style catalogs (carried from v2 default-template.js) ──

const STYLE_CATALOG_MANGA = [
    'Chainsaw Man manga art style, raw expressive brushwork, high-contrast gritty ink splashes, grungy urban newsprint texture, violent kinetic composition',
    'Baroque oil painting on canvas aesthetic with contemporary manga character proportions, deep chiaroscuro, vast areas of deep neutral shadow punctuated by a single crisp white light source, impasto visible brushstroke texture, rich full-spectrum oil palette, natural un-tinted flesh tones, stark contrast with completely neutral lighting',
    'emotional manhwa style, sharp focused character lineart, controlled watercolor edges, dry brush ink wash textures, visible prism halftone manga dots, crisp CMYK color separation',
    'modern aesthetic anime key visual, dreamy pastel gradient shading, fluffy surreal cloud textures, soft glow bloom effect, vaporwave-infused color palette, clean digital lineart',
    'cinematic anime illustration, crisp backlit lighting, sharp volumetric sun rays, pristine clear amber and clean white light leaks, sharp focus with atmospheric soft bloom, high-end concept art aesthetic',
    'dark josei manga, mature emotional subtlety, fine precise ink linework, desaturated blue-grey palette with warm amber intimate glow accents',
    'vintage 70s shojo romance aesthetic, elegant thin lineart, smooth controlled watercolor blending, intricate large sparkling eyes, soft milky pastel grading',
    'highly detailed mature seinen manga, sharp crisp ink lines, moody atmosphere, dense diagonal zipatone shading for shadows, dramatic framing',
    'sumi-e zen ink wash painting aesthetic, radical minimalism, bold expressive single-stroke calligraphic brushwork in deep black sumi ink only',
    'Studio Trigger anime hyper-expressive hand-drawn animation aesthetic, thick extremely variable-weight ink outlines, dense visual noise explosion during action sequences',
    'professional josei/seinen manga in pure black-and-white ink, heavily layered screentone dot gradients, vigorous cross-hatching in deep shadow zones, chiaroscuro contrast',
    'Vagabond ink brush manga, gestural wet calligraphy brushwork, spontaneous ink splash textures, sparse Zen composition',
];

const STYLE_CATALOG_CINEMATIC = [
    'The Last Kingdom S4 BBC, on-set torchlight, Canon C300, underexposed bg, warm amber, deep unlit shadows',
    'True Detective S1 ep3, Adam Arkapaw, single naked bulb, teal-shadow warm-highlight, flat ugly light',
    'Normal People Hulu ep6, Suzie Lavelle, overcast window diffusion, muted warm, handheld drift, anamorphic flare, f/1.8, 35mm Kodak Portra 400',
    'Westworld S1 ep2, clinical LED overhead, cool desaturated, hard shadow edges, sharp digital',
    'Peaky Blinders S2, single tungsten interior, smoke-filled, lifted blacks, muddy earth palette',
    'Harry Potter late-series, Delbonel+Idziak, practical candle key, cold stone-blue ambient, warm amber faces into deep umber shadows',
];

const STYLE_CATALOG_PHOTO = [
    'phone selfie, warm bathroom light, front camera, slightly overexposed skin, soft fluorescent bounce',
    'phone selfie, bedroom window daylight, cool natural tones, front camera lens distortion',
    'phone selfie, outdoor night, sodium-vapor streetlight, orange haze, grainy low-light noise',
    'phone selfie, two people close together, mixed indoor lighting, candid front-camera feel',
    'phone photo, cafe daylight, flat even lighting, instagram-filter warmth, slight vignette',
];

const BANNED_DEFAULT = [
    'naked', 'nude', 'penis', 'balls', 'nipples', 'sex', 'rape',
    'groin', 'crotch', 'bare chest', 'kneeling between thighs', 'unbuttoned pants',
    'kid', 'child', 'teen', 'minor',
];
const ALLOWED_DEFAULT = [
    'unbuttoned shirt', 'pressing bodies together', 'sweat-glistening skin',
    'straddling', 'deep kiss', 'hands gripping thighs', 'body silhouette against light',
];

// ── Per-kind flatten order (FIXED — not user-editable, spec §6.3) ──

export const FLATTEN_ORDER = Object.freeze({
    manga:        Object.freeze(['style', 'camera', 'light', 'location', 'mood', 'characters', 'panels', 'speechBubbles']),
    cinematic:    Object.freeze(['style', 'camera', 'characters', 'environment', 'light', 'location', 'mood']),
    illustration: Object.freeze(['style', 'camera', 'light', 'location', 'mood', 'characters']),
    photo:        Object.freeze(['style', 'camera', 'characters', 'environment', 'light', 'mood']),
});

// ── Presets ──

export const KIND_PRESETS = Object.freeze({
    manga: Object.freeze({
        fields: ['style', 'camera', 'light', 'location', 'mood', 'characters', 'panels', 'speechBubbles'],
        styleCatalog: STYLE_CATALOG_MANGA,
        wrapper: Object.freeze({
            head: 'Vertical manga page with an unpredictable, highly asymmetrical layout of [4 to 5] panels. Strict rule: Panels must vary drastically in size, height, and orientation, avoiding a repetitive stacked look. The composition is driven by a chaotic arrangement where small inset panels cross over the borders of larger panels, creating layered depth. Some panels feature dynamic slanted diagonal borders, while others have open, borderless edges with empty space between them.',
            tail: 'Adult 18+ fictional characters',
        }),
        rules: Object.freeze({
            minPanels: 4, maxPanels: 5, minCloseups: 2, maxCharsPerPanel: 2,
            bannedWords: BANNED_DEFAULT, allowedIntimate: ALLOWED_DEFAULT,
            bubbleLanguage: 'ru', promptLanguage: 'en',
        }),
        aspectRatioDefault: '9:16',
        imageSizeDefault: '2K',
    }),

    cinematic: Object.freeze({
        fields: ['style', 'camera', 'characters', 'environment', 'light', 'location', 'mood'],
        styleCatalog: STYLE_CATALOG_CINEMATIC,
        wrapper: Object.freeze({
            head: 'frozen production still captured on 35mm film — real actor on practical location, NOT CGI, NOT AI-generated, NOT digital art.',
            tail: 'natural skin texture, visible pores, real human asymmetry — not retouched. slight film grain in shadows, on-set photography feel',
        }),
        rules: Object.freeze({
            maxCharsCinematic: 4,
            bannedWords: BANNED_DEFAULT, allowedIntimate: ALLOWED_DEFAULT,
            bubbleLanguage: 'ru', promptLanguage: 'en',
        }),
        aspectRatioDefault: '16:9',
        imageSizeDefault: '4K',
    }),

    illustration: Object.freeze({
        fields: ['style', 'camera', 'light', 'location', 'mood', 'characters'],
        styleCatalog: STYLE_CATALOG_MANGA.slice(0, 6),
        wrapper: Object.freeze({ head: '', tail: '' }),
        rules: Object.freeze({
            bannedWords: BANNED_DEFAULT, allowedIntimate: ALLOWED_DEFAULT,
            bubbleLanguage: 'ru', promptLanguage: 'en',
        }),
        aspectRatioDefault: '3:2',
        imageSizeDefault: '2K',
    }),

    photo: Object.freeze({
        fields: ['style', 'camera', 'characters', 'environment', 'light', 'mood'],
        styleCatalog: STYLE_CATALOG_PHOTO,
        wrapper: Object.freeze({
            presets: Object.freeze(['selfie', 'instagram', 'portrait']),
            headByPreset: Object.freeze({
                selfie: 'phone selfie, front camera feel — not studio render',
                instagram: 'social post aesthetic',
                portrait: 'casual portrait photo',
            }),
            tailByPreset: Object.freeze({
                selfie: 'phone JPEG compression texture',
                instagram: '',
                portrait: '',
            }),
        }),
        rules: Object.freeze({
            bannedWords: BANNED_DEFAULT, allowedIntimate: ALLOWED_DEFAULT,
            bubbleLanguage: 'ru', promptLanguage: 'en',
        }),
        aspectRatioDefault: '3:4',
        imageSizeDefault: '2K',
    }),
});

export function getKindPreset(kind) {
    // Resolve aliases (v2 outputKind → v3 kind name).
    const k = KIND_ALIASES[kind] || kind;
    return KIND_PRESETS[k] || KIND_PRESETS.manga;
}

export function normalizeKind(kind) {
    return KIND_ALIASES[kind] || (KINDS.includes(kind) ? kind : 'manga');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/registry-kinds.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry/kinds.js tests/registry-kinds.test.js
git commit -m "feat(registry): add 4 kind presets with fixed flatten order"
```

---

## Task 3: Create field resolver (`src/registry/resolve.js`)

**Files:**
- Create: `src/registry/resolve.js`
- Test: `tests/registry-resolve.test.js`

`resolveFields(template)` returns the ordered list of field declarations for a template: kind preset fields (filtered by `appliesTo`) ∪ custom fields, in `FLATTEN_ORDER` order.

- [ ] **Step 1: Write the failing test**

Create `tests/registry-resolve.test.js`:

```js
// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFields, fieldsFor } from '../src/registry/resolve.js';
import { getKindPreset } from '../src/registry/kinds.js';

test('resolveFields for manga template returns 8 fields in fixed order', () => {
    const tmpl = { kind: 'manga', fields: null, customFields: [] };
    const fields = resolveFields(tmpl);
    const names = fields.map(f => f.name);
    assert.deepEqual(names, ['style', 'camera', 'light', 'location', 'mood', 'characters', 'panels', 'speechBubbles']);
});

test('resolveFields respects template.fields override', () => {
    const tmpl = { kind: 'manga', fields: ['style', 'camera', 'mood'], customFields: [] };
    const fields = resolveFields(tmpl);
    assert.deepEqual(fields.map(f => f.name), ['style', 'camera', 'mood']);
});

test('resolveFields includes custom fields', () => {
    const tmpl = {
        kind: 'manga',
        fields: ['style', 'characters'],
        customFields: [{ name: 'colorMood', label: 'Color', describe: 'd', flatten: (v) => `Color: ${v}`, uiType: 'text' }],
    };
    const fields = resolveFields(tmpl);
    const names = fields.map(f => f.name);
    assert.ok(names.includes('colorMood'));
    assert.ok(names.includes('style'));
});

test('resolveFields returns field objects with flatten/validate functions', () => {
    const tmpl = { kind: 'photo', fields: null, customFields: [] };
    const fields = resolveFields(tmpl);
    for (const f of fields) {
        assert.equal(typeof f.flatten, 'function');
        assert.equal(typeof f.validate, 'function' );
        assert.equal(typeof f.describe, 'string');
    }
});

test('resolveFields defaults to manga when kind unknown', () => {
    const tmpl = { kind: 'bogus', fields: null, customFields: [] };
    const fields = resolveFields(tmpl);
    assert.deepEqual(fields.map(f => f.name), getKindPreset('manga').fields);
});

test('resolveFields uses FLATTEN_ORDER for ordering even with custom fields', () => {
    const tmpl = {
        kind: 'cinematic',
        fields: null, // use preset
        customFields: [{ name: 'zzz_extra', label: 'X', describe: 'd', flatten: (v) => v, uiType: 'text' }],
    };
    const names = resolveFields(tmpl).map(f => f.name);
    // built-ins in order, custom appended at end
    assert.equal(names[0], 'style');
    assert.equal(names[names.length - 1], 'zzz_extra');
});

test('fieldsFor returns same as resolveFields', () => {
    const tmpl = { kind: 'illustration', fields: null, customFields: [] };
    assert.deepEqual(fieldsFor(tmpl).map(f => f.name), resolveFields(tmpl).map(f => f.name));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/registry-resolve.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/registry/resolve.js`:

```js
// @ts-check
/**
 * v3 Field Resolver. Given a template, returns the ordered list of field
 * declarations (built-in from registry + custom from template).
 *
 * Ordering: built-in fields follow FLATTEN_ORDER[kind]; custom fields
 * append at the end in declaration order.
 *
 * Pure module — depends only on fields.js and kinds.js (both pure).
 */
import { getField, BUILTIN_FIELDS, defineField } from './fields.js';
import { getKindPreset, FLATTEN_ORDER, normalizeKind } from './kinds.js';

// Default text flatten for custom fields without their own flatten.
function defaultCustomFlatten(name) {
    return (v) => {
        const s = String(v ?? '').trim();
        return s ? `${name}: ${s}` : '';
    };
}

/**
 * @param {object} template — { kind, fields: string[]|null, customFields: object[] }
 * @returns {Array<object>} ordered field declarations
 */
export function resolveFields(template) {
    const kind = normalizeKind(template?.kind || 'manga');
    const preset = getKindPreset(kind);
    const order = FLATTEN_ORDER[kind] || preset.fields;

    // Register custom fields so getField can retrieve them.
    const customFields = Array.isArray(template?.customFields) ? template.customFields : [];
    for (const cf of customFields) {
        if (cf && cf.name && !BUILTIN_FIELDS[cf.name]) {
            defineField({
                name: cf.name,
                label: cf.label || cf.name,
                appliesTo: ['*'],
                describe: cf.describe || '',
                validate: cf.validate || (() => null),
                flatten: cf.flatten || defaultCustomFlatten(cf.name),
                uiType: cf.uiType || 'text',
            });
        }
    }

    // Determine the active field-name list.
    const fieldNames = Array.isArray(template?.fields) && template.fields.length
        ? template.fields
        : preset.fields;

    // Order: intersection with FLATTEN_ORDER first (in order), then any
    // fieldNames not in the order (e.g. custom) appended in their list order.
    const ordered = [];
    const seen = new Set();
    for (const name of order) {
        if (fieldNames.includes(name)) {
            ordered.push(name);
            seen.add(name);
        }
    }
    for (const name of fieldNames) {
        if (!seen.has(name)) {
            ordered.push(name);
            seen.add(name);
        }
    }

    // Map to declarations. Skip names with no declaration (shouldn't happen,
    // but guard against typos in template.fields).
    return ordered.map(getField).filter(Boolean);
}

export function fieldsFor(template) {
    return resolveFields(template);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/registry-resolve.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry/resolve.js tests/registry-resolve.test.js
git commit -m "feat(registry): add field resolver"
```

---

## Task 4: Rewrite `prompt-schema.js` (normalize/validate/applyRules over registry)

**Files:**
- Rewrite: `src/prompt-schema.js`
- Rewrite: `tests/schema.test.js`

Removes `subject`. Draft fields now align with the registry. Validation delegates to field `validate` functions. `OUTPUT_KINDS` becomes the v3 kind names. Keep v2 alias exports (`KIND_PANELS` etc.) for the adapter/parser during transition.

- [ ] **Step 1: Rewrite the test**

Replace `tests/schema.test.js` with:

```js
// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    KINDS, normalizeDraft, validateDraft, applyRules, emptyDraft,
    KIND_ALIASES,
} from '../src/prompt-schema.js';

test('KINDS has exactly 4 kinds', () => {
    assert.deepEqual([...KINDS].sort(), ['cinematic', 'illustration', 'manga', 'photo']);
});

test('normalizeKind maps v2 aliases', () => {
    const { normalizeKind } = await import('../src/prompt-schema.js');
    assert.equal(normalizeKind('manga-page'), 'manga');
    assert.equal(normalizeKind('cinematic-still'), 'cinematic');
    assert.equal(normalizeKind('single-illustration'), 'illustration');
    assert.equal(normalizeKind('photo'), 'photo');
    assert.equal(normalizeKind('bogus'), 'manga');
});

test('emptyDraft(manga) returns arrays for panels and speechBubbles', () => {
    const d = emptyDraft('manga');
    assert.equal(d.kind, 'manga');
    assert.deepEqual(d.characters, []);
    assert.deepEqual(d.panels, []);
    assert.deepEqual(d.speechBubbles, []);
    assert.equal(d.style, '');
    assert.equal(d.camera, '');
    // NO subject field
    assert.equal(d.subject, undefined);
});

test('emptyDraft(photo) has environment object', () => {
    const d = emptyDraft('photo');
    assert.equal(typeof d.environment, 'object');
    assert.deepEqual(d.environment.props, []);
    assert.equal(d.panels, undefined);
});

test('normalizeDraft coerces and trims', () => {
    const d = normalizeDraft('manga', {
        characters: [{ name: '  Rya  ', hair: 'red' }],
        camera: '  MS 85mm  ',
    });
    assert.equal(d.characters[0].name, 'Rya');
    assert.equal(d.camera, 'MS 85mm');
    assert.deepEqual(d.panels, []);
});

test('validateDraft flags empty characters', () => {
    const v = validateDraft('manga', normalizeDraft('manga', { characters: [] }));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some(e => /character/i.test(e)));
});

test('validateDraft flags manga panel count out of range', () => {
    const d = normalizeDraft('manga', {
        characters: [{ name: 'A' }],
        panels: [{ shot: 'medium' }],
    });
    const v = validateDraft('manga', d, { minPanels: 4, maxPanels: 5 });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some(e => /panel/i.test(e)));
});

test('applyRules strips banned words from free-text fields', () => {
    const d = normalizeDraft('manga', {
        characters: [{ name: 'A', clothing: 'naked skin' }],
        camera: 'naked lens',
    });
    const out = applyRules({ bannedWords: ['naked'] }, d);
    assert.ok(!/naked/i.test(out.camera));
    assert.ok(!/naked/i.test(out.characters[0].clothing));
});

test('applyRules leaves speech bubble text (filtered separately) intact when no banned', () => {
    const d = normalizeDraft('manga', {
        characters: [{ name: 'A' }],
        speechBubbles: [{ target: 'A', text: 'привет' }],
    });
    const out = applyRules({ bannedWords: [] }, d);
    assert.equal(out.speechBubbles[0].text, 'привет');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/schema.test.js`
Expected: FAIL (current module exports v2 symbols).

- [ ] **Step 3: Rewrite `src/prompt-schema.js`**

Replace the entire file with:

```js
// @ts-check
/**
 * v3 Draft schema + validation. Thin functions over the field registry.
 *
 * Draft fields align with the registry: style, camera, light, location, mood,
 * characters[], panels[] (manga), speechBubbles[] (manga), environment (cinematic/photo).
 *
 * NO `subject` field — characters is the sole subject source (spec §3.5).
 *
 * Pure module — depends on registry/kinds.js (pure).
 */
import { normalizeKind, getKindPreset, KINDS, KIND_ALIASES } from './registry/kinds.js';

export { KINDS, KIND_ALIASES, normalizeKind };

// Re-export v2-style constants for transition (adapter/parser).
export const KIND_PANELS = 'manga';
export const KIND_ILLUST = 'illustration';
export const KIND_CINE = 'cinematic';
export const KIND_PHOTO = 'photo';
export const OUTPUT_KINDS = KINDS;

const STR = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const ARR = (v) => (Array.isArray(v) ? v : []);

export const DEFAULT_RULES = Object.freeze({
    minPanels: 4,
    maxPanels: 5,
    minCloseups: 2,
    maxCharsPerPanel: 2,
    maxCharsCinematic: 4,
    bannedWords: [],
    allowedIntimate: [],
    bubbleLanguage: 'ru',
    promptLanguage: 'en',
});

function normalizeCharacter(c) {
    if (!c || typeof c !== 'object') return null;
    return {
        name: STR(c.name),
        face: STR(c.face),
        hair: STR(c.hair),
        clothing: STR(c.clothing),
        action: STR(c.action),
        gaze: STR(c.gaze),
        emotion: STR(c.emotion),
        traits: STR(c.traits),
    };
}

export function emptyDraft(kind) {
    const k = normalizeKind(kind);
    const base = {
        kind: k,
        style: '', camera: '', light: '', location: '', mood: '',
        aspectRatio: '', imageSize: '',
        characters: [],
    };
    if (k === 'manga') {
        base.panels = [];
        base.speechBubbles = [];
    } else if (k === 'cinematic' || k === 'photo') {
        base.environment = { geoAnchor: '', props: [], atmosphere: '', ground: '' };
    }
    return base;
}

export function normalizeDraft(kind, draft) {
    const k = normalizeKind(kind);
    const d = (draft && typeof draft === 'object') ? { ...draft } : {};
    const out = emptyDraft(k);
    out.style = STR(d.style);
    out.camera = STR(d.camera);
    out.light = STR(d.light);
    out.location = STR(d.location);
    out.mood = STR(d.mood);
    out.aspectRatio = STR(d.aspectRatio || d.aspect_ratio);
    out.imageSize = STR(d.imageSize || d.image_size);
    out.characters = ARR(d.characters).map(normalizeCharacter).filter(Boolean);
    if (k === 'manga') {
        out.panels = ARR(d.panels).map((p) => p && typeof p === 'object' ? {
            type: STR(p.type), shape: STR(p.shape), shot: STR(p.shot), angle: STR(p.angle),
            lightingColor: STR(p.lightingColor || p.lighting_color),
            charsInFrame: ARR(p.charsInFrame || p.chars_in_frame).map(STR).filter(Boolean),
            actions: ARR(p.actions).map(STR).filter(Boolean),
            sfx: STR(p.sfx),
        } : null).filter(Boolean);
        out.speechBubbles = ARR(d.speechBubbles || d.speech_bubbles).map((b) => b && typeof b === 'object' ? {
            target: STR(b.target), text: STR(b.text),
        } : null).filter(Boolean);
    } else if (k === 'cinematic' || k === 'photo') {
        const e = d.environment && typeof d.environment === 'object' ? d.environment : {};
        out.environment = {
            geoAnchor: STR(e.geoAnchor || e.geo_anchor),
            props: ARR(e.props).map(STR).filter(Boolean),
            atmosphere: STR(e.atmosphere),
            ground: STR(e.ground),
        };
    }
    return out;
}

const WS = /[\s\u00A0]+/;
function _stripBanned(text, banned) {
    if (!text || !banned || !banned.length) return text;
    let out = text;
    for (const w of banned) {
        if (!w) continue;
        const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        out = out.replace(re, '').replace(WS, ' ').trim();
    }
    return out.trim();
}

export function applyRules(rules, draft) {
    const r = { ...DEFAULT_RULES, ...(rules || {}) };
    const d = normalizeDraft(draft.kind, draft);
    const banned = ARR(r.bannedWords);
    const strip = (s) => _stripBanned(s, banned);
    d.style = strip(d.style);
    d.camera = strip(d.camera);
    d.light = strip(d.light);
    d.location = strip(d.location);
    d.mood = strip(d.mood);
    d.characters = d.characters.map((c) => ({
        ...c, face: strip(c.face), hair: strip(c.hair), clothing: strip(c.clothing),
        action: strip(c.action), gaze: strip(c.gaze), emotion: strip(c.emotion), traits: strip(c.traits),
    }));
    if (d.kind === 'manga') {
        d.panels = d.panels.map((p) => ({
            ...p, shot: strip(p.shot), angle: strip(p.angle), lightingColor: strip(p.lightingColor),
            actions: p.actions.map(strip), sfx: strip(p.sfx),
        }));
        d.speechBubbles = d.speechBubbles.map((b) => ({ ...b, text: strip(b.text) }));
    } else if (d.kind === 'cinematic' || d.kind === 'photo') {
        d.environment = {
            ...d.environment,
            atmosphere: strip(d.environment.atmosphere),
            ground: strip(d.environment.ground),
            props: d.environment.props.map(strip),
        };
    }
    return d;
}

const isCloseup = (shot) => /close\s*up|extreme\s*close\s*up|macro/i.test(STR(shot));

export function validateDraft(kind, draft, rules) {
    const k = normalizeKind(kind);
    const r = { ...DEFAULT_RULES, ...(rules || {}) };
    const d = normalizeDraft(k, draft);
    const errors = [];

    if (d.characters.length === 0) {
        errors.push('Draft must contain at least one character.');
    }
    if ((k === 'cinematic') && d.characters.length > r.maxCharsCinematic) {
        errors.push(`Cinematic supports 1-${r.maxCharsCinematic} characters (got ${d.characters.length}).`);
    }
    for (const c of d.characters) {
        if (!c.name) errors.push('Every character needs a name (first name only).');
        if (!c.action && !c.gaze && !c.emotion) {
            errors.push(`Character "${c.name || '(?)'}" has no action/gaze/emotion.`);
        }
    }
    if (k === 'manga') {
        if (d.panels.length < r.minPanels || d.panels.length > r.maxPanels) {
            errors.push(`Panels count ${d.panels.length} is outside [${r.minPanels}, ${r.maxPanels}].`);
        }
        const closeups = d.panels.filter((p) => isCloseup(p.shot)).length;
        if (closeups < r.minCloseups) {
            errors.push(`Need at least ${r.minCloseups} close-up panels (got ${closeups}).`);
        }
        for (let i = 0; i < d.panels.length; i++) {
            if (d.panels[i].charsInFrame.length > r.maxCharsPerPanel) {
                errors.push(`Panel #${i + 1} has ${d.panels[i].charsInFrame.length} characters (max ${r.maxCharsPerPanel}).`);
            }
        }
    }
    return { ok: errors.length === 0, draft: d, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/schema.test.js`
Expected: PASS.

> **Note:** the `await import()` in the `normalizeKind maps v2 aliases` test requires top-level await in a CommonJS-style test runner. Node `--test` supports top-level await in ESM. If this test file is treated as CJS, remove that test and import `normalizeKind` at the top instead. Verify with the run.

- [ ] **Step 5: Commit**

```bash
git add src/prompt-schema.js tests/schema.test.js
git commit -m "feat(schema): rewrite normalize/validate/applyRules over v3 kinds (no subject)"
```

---

## Task 5: Rewrite `prompt-flatter.js` (flatten over registry)

**Files:**
- Rewrite: `src/prompt-flatter.js`
- Rewrite: `tests/flatter.test.js`

`flatten(template, draft, opts)` iterates `resolveFields(template)` in `FLATTEN_ORDER`, calls each `field.flatten(value, ctx)`, joins non-empty, prepends wrapper head, appends wrapper tail, applies apostrophe guard. The style field's flatten handles the resolved-style overwrite via `ctx.resolvedStyle`.

- [ ] **Step 1: Rewrite the test**

Replace `tests/flatter.test.js` with:

```js
// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten } from '../src/prompt-flatter.js';
import { normalizeDraft } from '../src/prompt-schema.js';

function mangaDraft() {
    return normalizeDraft('manga', {
        style: 'sumi-e ink',
        camera: 'Medium shot, 85mm, f/2.0',
        light: 'rim light from window',
        location: 'shrine, dusk, rain',
        mood: 'the ache of solitude',
        characters: [{ name: 'Luca', face: 'sharp jaw', hair: 'dark auburn', clothing: 'robe', action: 'gripping the lintel', gaze: 'at the lantern', emotion: 'tense', traits: '' }],
        panels: [
            { type: 'main', shape: 'diagonal', shot: 'close up', angle: 'front', lightingColor: 'cool blue', charsInFrame: ['Luca'], actions: ['grip'], sfx: 'za-za' },
            { type: 'main', shape: 'borderless', shot: 'medium', angle: 'low', lightingColor: 'cool', charsInFrame: ['Luca'], actions: ['pull'], sfx: '' },
            { type: 'inset', shape: 'vertical slice', shot: 'extreme close up', angle: 'profile', lightingColor: 'amber', charsInFrame: ['Luca'], actions: ['lean'], sfx: '' },
            { type: 'strip', shape: 'horizontal', shot: 'medium', angle: 'front', lightingColor: 'cool', charsInFrame: ['Luca'], actions: ['stand'], sfx: '' },
        ],
        speechBubbles: [{ target: 'Luca', text: 'останься' }],
    });
}

test('flatten manga produces deterministic string with wrapper head and tail', () => {
    const tmpl = { kind: 'manga', fields: null, customFields: [] };
    const out = flatten(tmpl, mangaDraft(), {});
    assert.equal(typeof out, 'string');
    assert.match(out, /Vertical manga page/);
    assert.match(out, /\[CAMERA:/);
    assert.match(out, /\[LIGHT:/);
    assert.match(out, /Characters: Luca,/);
    assert.match(out, /Panels:/);
    assert.match(out, /speech bubble.*Luca.*says.*останься/i);
    assert.match(out, /Adult 18\+ fictional characters/);
});

test('flatten includes style block first', () => {
    const tmpl = { kind: 'manga', fields: null, customFields: [] };
    const out = flatten(tmpl, mangaDraft(), {});
    // style appears before camera
    assert.ok(out.indexOf('sumi-e ink') < out.indexOf('[CAMERA:'));
});

test('flatten ctx.resolvedStyle overwrites draft.style (pinned behavior)', () => {
    const tmpl = { kind: 'manga', fields: null, customFields: [] };
    const out = flatten(tmpl, mangaDraft(), { resolvedStyle: 'OVERRIDDEN STYLE' });
    assert.match(out, /OVERRIDDEN STYLE/);
    assert.ok(!/sumi-e ink/.test(out), 'draft.style should be overwritten');
});

test('flatten llm-pick (resolvedStyle=null) uses draft.style', () => {
    const tmpl = { kind: 'manga', fields: null, customFields: [] };
    const out = flatten(tmpl, mangaDraft(), { resolvedStyle: null });
    assert.match(out, /sumi-e ink/);
});

test('flatten apostrophe guard removes quotes from body', () => {
    const tmpl = { kind: 'manga', fields: null, customFields: [] };
    const d = mangaDraft();
    d.camera = "Character's hand, 85mm";
    const out = flatten(tmpl, d, {});
    assert.ok(!/Character's/.test(out));
});

test('flatten photo kind with wrapper.preset selfie', () => {
    const tmpl = { kind: 'photo', fields: null, customFields: [], wrapper: { preset: 'selfie' } };
    const d = normalizeDraft('photo', {
        style: 'phone light', camera: 'front cam',
        characters: [{ name: 'Mira', action: 'smiling' }],
        environment: { geoAnchor: 'bathroom', props: [], atmosphere: 'humid', ground: 'tile' },
        light: 'fluorescent', mood: 'playful',
    });
    const out = flatten(tmpl, d, {});
    assert.match(out, /phone selfie, front camera feel/);
    assert.match(out, /phone JPEG compression texture/);
});

test('flatten drops empty fields (no empty brackets)', () => {
    const tmpl = { kind: 'illustration', fields: null, customFields: [] };
    const d = normalizeDraft('illustration', {
        style: 's', camera: '', light: '', location: '', mood: '',
        characters: [{ name: 'A', action: 'standing' }],
    });
    const out = flatten(tmpl, d, {});
    assert.ok(!/\[CAMERA:\s*\]/.test(out));
    assert.ok(!/\[LIGHT:\s*\]/.test(out));
    assert.match(out, /Characters: A/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/flatter.test.js`
Expected: FAIL (`flatten` signature changed).

- [ ] **Step 3: Rewrite `src/prompt-flatter.js`**

Replace the entire file with:

```js
// @ts-check
/**
 * v3 Flatter. Iterates the resolved field list in FLATTEN_ORDER, calls each
 * field's flatten(value, ctx), joins non-empty blocks, wraps with head/tail,
 * applies apostrophe guard.
 *
 * The style field's flatten handles the resolved-style overwrite (spec §5.3):
 * if ctx.resolvedStyle is non-null (pinned/random/override), it wins; if null
 * (llm-pick), draft.style is used.
 *
 * Pure module — depends on registry (pure).
 */
import { resolveFields } from './registry/resolve.js';
import { getKindPreset } from './registry/kinds.js';

function macroExpand(text, expandMacros) {
    if (!text) return '';
    return typeof expandMacros === 'function' ? expandMacros(text) : String(text);
}

/**
 * @param {object} template — v3 template object ({kind, fields, customFields, wrapper})
 * @param {object} draft — normalized draft
 * @param {object} opts — { resolvedStyle: string|null, rules: object, expandMacros: fn }
 * @returns {string}
 */
export function flatten(template, draft, opts = {}) {
    const d = draft || {};
    const ctx = {
        resolvedStyle: opts.resolvedStyle === undefined ? null : opts.resolvedStyle,
        rules: opts.rules || {},
    };
    const fields = resolveFields(template);
    const blocks = [];
    for (const f of fields) {
        const value = d[f.name];
        const block = f.flatten(value, ctx);
        if (block && String(block).trim()) blocks.push(String(block).trim());
    }
    let body = blocks.join(' ');

    // Wrapper head/tail
    const preset = getKindPreset(template?.kind);
    const wrapper = template?.wrapper || preset?.wrapper || {};
    const head = resolveWrapperHead(wrapper, template?.wrapper?.preset, opts.expandMacros);
    const tail = resolveWrapperTail(wrapper, template?.wrapper?.preset, opts.expandMacros);
    if (head) body = macroExpand(head, opts.expandMacros) + ' ' + body;
    if (tail) body = body + ' ' + macroExpand(tail, opts.expandMacros);

    // Apostrophe guard (JSON-safety for single-quote style wrappers).
    body = body.replace(/'/g, '');
    return body.trim();
}

function resolveWrapperHead(wrapper, presetName, expandMacros) {
    if (wrapper.headByPreset && presetName) {
        return wrapper.headByPreset[presetName] || '';
    }
    return wrapper.head || '';
}

function resolveWrapperTail(wrapper, presetName, expandMacros) {
    if (wrapper.tailByPreset && presetName) {
        return wrapper.tailByPreset[presetName] || '';
    }
    return wrapper.tail || '';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/flatter.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/prompt-flatter.js tests/flatter.test.js
git commit -m "feat(flatter): rewrite flatten over field registry with wrapper presets"
```

---

## Task 6: Rewrite `prompt-builder.js` (single-path buildSystemPrompt)

**Files:**
- Rewrite: `src/prompt-builder.js`
- Rewrite: `tests/prompt-builder.test.js`

`buildSystemPrompt(template, chars, opts)` resolves fields once, resolves style once, and assembles blocks: head (role), schema (field describes), style instruction, rules, hints, few-shot, characters, JSON-only tail. `buildUserPrompt` logic unchanged. Raw path deleted.

- [ ] **Step 1: Rewrite the test**

Replace `tests/prompt-builder.test.js` with:

```js
// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, buildUserPrompt } from '../src/prompt-builder.js';
import { getKindPreset } from '../src/registry/kinds.js';

// Identity macro resolver for pure tests.
const ID = (s) => String(s ?? '');

const mangaTemplate = () => ({
    kind: 'manga',
    schemaVersion: 3,
    fields: null,
    customFields: [],
    fieldHints: {
        camera: 'Always dynamic angles. Frame-within-frame when motivated.',
        characters: 'Extract ALL traits. Non-human as prosthetics. Mid-action. Name first.',
    },
    style: { mode: 'llm-pick', catalog: getKindPreset('manga').styleCatalog, pinned: '' },
    rules: { minPanels: 4, maxPanels: 5, minCloseups: 2, maxCharsPerPanel: 2, bannedWords: ['naked'], allowedIntimate: [], bubbleLanguage: 'ru', promptLanguage: 'en' },
    wrapper: getKindPreset('manga').wrapper,
    fewShot: [],
});

test('buildSystemPrompt manga returns non-empty with JSON contract', () => {
    const out = buildSystemPrompt(mangaTemplate(), [], { macroResolver: ID });
    assert.ok(out.length > 200);
    assert.match(out, /ВОЗВРАТИ СТРОГО JSON/i);
    assert.match(out, /camera:/);
    assert.match(out, /characters:/);
    assert.match(out, /panels:/);
    assert.match(out, /speechBubbles:/);
});

test('buildSystemPrompt llm-pick emits catalog RAW in style block', () => {
    const out = buildSystemPrompt(mangaTemplate(), [], { macroResolver: ID });
    assert.match(out, /выбери ОДИН стиль/i);
    assert.match(out, /Chainsaw Man manga art style/);
});

test('buildSystemPrompt pinned emits resolved style string', () => {
    const tmpl = { ...mangaTemplate(), style: { mode: 'pinned', pinned: 'sumi-e ink wash', catalog: [] } };
    const out = buildSystemPrompt(tmpl, [], { macroResolver: ID });
    assert.match(out, /используй РОВНО эту строку/i);
    assert.match(out, /sumi-e ink wash/);
});

test('buildSystemPrompt override beats pinned', () => {
    const tmpl = { ...mangaTemplate(), style: { mode: 'pinned', pinned: 'sumi-e', catalog: [] } };
    const out = buildSystemPrompt(tmpl, [], { macroResolver: ID, styleOverride: 'OVR' });
    assert.match(out, /OVR/);
    assert.equal(/sumi-e/.test(out), false);
});

test('buildSystemPrompt includes fieldHints with macros expanded', () => {
    const tmpl = { ...mangaTemplate(), fieldHints: { camera: 'Use {{random::warm::cool}} light.' } };
    const out = buildSystemPrompt(tmpl, [], { macroResolver: ID });
    assert.match(out, /Use \{\{random::warm::cool\}\} light/);
});

test('buildSystemPrompt includes banned words in rules block', () => {
    const out = buildSystemPrompt(mangaTemplate(), [], { macroResolver: ID });
    assert.match(out, /BANNED WORDS/i);
    assert.match(out, /naked/);
});

test('buildSystemPrompt includes characters block with literal markers', () => {
    const chars = [{ sceneName: 'Mira', name: 'Mira', role: 'char', description: 'dark hair, pale skin' }];
    const out = buildSystemPrompt(mangaTemplate(), chars, { macroResolver: ID });
    assert.match(out, /Персонажи/);
    assert.match(out, /Mira/);
    assert.match(out, /\{\{char\}\}/);
});

test('buildSystemPrompt photo kind does not mention panels', () => {
    const tmpl = {
        kind: 'photo', schemaVersion: 3, fields: null, customFields: [],
        fieldHints: {}, style: { mode: 'llm-pick', catalog: getKindPreset('photo').styleCatalog, pinned: '' },
        rules: { bannedWords: [] }, wrapper: { preset: 'selfie' }, fewShot: [],
    };
    const out = buildSystemPrompt(tmpl, [], { macroResolver: ID });
    assert.ok(!/panels:/.test(out));
    assert.match(out, /environment:/);
});

test('buildUserPrompt wraps scene in quotes and asks for draft', () => {
    const out = buildUserPrompt('Mira walks into the shrine.', ID);
    assert.match(out, /Сцена из чата/);
    assert.match(out, /Mira walks into the shrine/);
    assert.match(out, /JSON-draft/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/prompt-builder.test.js`
Expected: FAIL (old exports).

- [ ] **Step 3: Rewrite `src/prompt-builder.js`**

Replace the entire file with:

```js
// @ts-check
/**
 * v3 System prompt builder. Single path over the field registry.
 * Raw path deleted. Style resolved ONCE here; result threaded to flatten.
 *
 * ST macros: expandMacros wraps ctx.substituteParams. In tests, an identity
 * or fake resolver is injected.
 */
import { resolveFields } from './registry/resolve.js';
import { getKindPreset } from './registry/kinds.js';
import { normalizeKind } from './registry/kinds.js';
import { resolveStyle } from './style-resolver.js';
import { getCtx, sanitizePrompt } from './core.js';

const ID_MACROS = (s) => String(s ?? '');

function resolveSTMacros(text) {
    const ctx = getCtx();
    try {
        if (ctx?.substituteParams) return ctx.substituteParams(text);
    } catch { /* fall through */ }
    const charName = ctx?.characters?.[ctx.characterId]?.name || '{{char}}';
    const userName = ctx?.name1 || '{{user}}';
    return String(text).replaceAll('{{char}}', charName).replaceAll('{{user}}', userName);
}

function renderCharactersBlock(activeCharacters) {
    const refs = activeCharacters
        .filter(c => c && (c.sceneName || c.description))
        .map(c => `- "${c.sceneName || c.name}" (${c.role === 'char' ? '{{char}}' : c.role === 'user' ? '{{user}}' : c.name}): ${sanitizePrompt(c.description)}`)
        .join('\n');
    return refs ? `\n\n=== Персонажи (используй ТОЧНО эту внешность, не выдумывай) ===\n${refs}` : '';
}

const JSON_ONLY_TAIL = `\n\nВАЖНО: Верни ТОЛЬКО JSON-объект, никакого дополнительного текста, без \`\`\`json блоков.`;

function renderStyleBlock(styleResult) {
    if (styleResult.effectiveMode === 'override' || styleResult.effectiveMode === 'pinned' || styleResult.effectiveMode === 'random') {
        if (!styleResult.styleString) {
            return `\n\nСТИЛЬ: был задан, но пустой — выбери стиль сам в поле "style".\n`;
        }
        return `\n\nСТИЛЬ: используй РОВНО эту строку в поле "style" (не меняй):\n"${styleResult.styleString}"\n`;
    }
    if (styleResult.llmShouldPick && styleResult.catalogRaw?.length) {
        const items = styleResult.catalogRaw.map((s, i) => `${i + 1}. ${s}`).join('\n');
        return `\n\nСТЕЙЛИ: выбери ОДИН стиль из каталога ниже и подставь ЕГО ПОЛНОЕ ОПИСАНИЕ в поле "style". Выбирай по настроению/тону сцены.\n${items}\n`;
    }
    return `\n\nСТИЛЬ: выбери подходящий сцене стиль и подставь в поле "style".\n`;
}

function renderRulesBlock(rules, kind) {
    if (!rules || typeof rules !== 'object') return '';
    const items = [];
    const k = normalizeKind(kind);
    if (k === 'manga') {
        if (Number.isFinite(rules.minPanels) && Number.isFinite(rules.maxPanels)) {
            items.push(`panels: ${rules.minPanels}–${rules.maxPanels} (vary drastically in size, height, orientation)`);
        }
        if (Number.isFinite(rules.minCloseups)) items.push(`минимум ${rules.minCloseups} close-up panels`);
        if (Number.isFinite(rules.maxCharsPerPanel)) items.push(`max ${rules.maxCharsPerPanel} персонажа на panel`);
    }
    if (k === 'cinematic' && Number.isFinite(rules.maxCharsCinematic)) {
        items.push(`max ${rules.maxCharsCinematic} персонажей`);
    }
    if (rules.bannedWords?.length) items.push(`BANNED WORDS (никогда не используй): ${rules.bannedWords.join(', ')}`);
    if (rules.allowedIntimate?.length) items.push(`ALLOWED intimate descriptors: ${rules.allowedIntimate.join(', ')}`);
    if (rules.bubbleLanguage) items.push(`speech bubble text — на ${rules.bubbleLanguage === 'ru' ? 'русском' : rules.bubbleLanguage}`);
    if (rules.promptLanguage) items.push(`prompt body — на ${rules.promptLanguage === 'en' ? 'английском' : rules.promptLanguage}`);
    if (!items.length) return '';
    return `\n\nПРАВИЛА (соблюдай строго):\n${items.map((x) => `- ${x}`).join('\n')}\n`;
}

function renderHintsBlock(fields, hints, expandMacros) {
    if (!hints || typeof hints !== 'object') return '';
    const items = fields
        .map(f => {
            const h = hints[f.name] || f.describe;
            return h ? `- ${f.name}: ${typeof expandMacros === 'function' ? expandMacros(h) : h}` : null;
        })
        .filter(Boolean);
    if (!items.length) return '';
    return `\n\nПОДСКАЗКИ ПО ПОЛЯМ:\n${items.join('\n')}\n`;
}

function renderSchemaBlock(fields) {
    const lines = fields.map(f => `${f.name}: ${f.describe}`);
    return `\n\nВОЗВРАТИ СТРОГО JSON-объект следующей структуры (заполни все поля):\n{\n  ${lines.join(',\n  ')},\n  "aspectRatio": "9:16",\n  "imageSize": "2K"\n}`;
}

function renderFewShotBlock(fewShot, kind, expandMacros) {
    if (!Array.isArray(fewShot) || !fewShot.length) return '';
    const blocks = fewShot.map((ex, i) => {
        if (!ex || !ex.result) return '';
        const draftObj = { ...ex.result, kind };
        const scene = typeof expandMacros === 'function' ? expandMacros(ex.scene || '') : (ex.scene || '');
        return `### Пример ${i + 1}\nСцена: ${scene}\nРезультат (JSON, именно такая структура):\n${JSON.stringify(draftObj)}`;
    }).filter(Boolean);
    if (!blocks.length) return '';
    return `\n\nПРИМЕРЫ (few-shot):\n${blocks.join('\n\n')}\n`;
}

/**
 * @param {object} template — v3 template
 * @param {Array} activeCharacters
 * @param {object} [opts] — { styleOverride, seed, macroResolver, styleResult }
 * @returns {string}
 */
export function buildSystemPrompt(template, activeCharacters = [], opts = {}) {
    const expandMacros = opts.macroResolver || resolveSTMacros;
    const kind = normalizeKind(template?.kind || 'manga');
    const preset = getKindPreset(kind);
    const rules = template?.rules || preset.rules || {};
    const hints = template?.fieldHints || {};
    const fewShot = template?.fewShot || [];

    const fields = resolveFields(template);

    // Style: resolve once. Caller may pass a pre-computed styleResult.
    const styleResult = opts.styleResult || resolveStyle(
        template?.style || { mode: 'llm-pick', catalog: preset.styleCatalog, pinned: '' },
        { override: opts.styleOverride, seed: opts.seed },
        expandMacros,
    );

    const head = `Ты — генератор промптов для изображений. Прочитай сцену из чата и составь структурированный JSON-draft для генерации одного изображения вида "${kind}".`;
    const schemaBlock = renderSchemaBlock(fields);
    const styleBlock = renderStyleBlock(styleResult);
    const rulesBlock = renderRulesBlock(rules, kind);
    const hintsBlock = renderHintsBlock(fields, hints, expandMacros);
    const fewShotBlock = renderFewShotBlock(fewShot, kind, expandMacros);
    const chars = renderCharactersBlock(activeCharacters);

    return [head, schemaBlock, styleBlock, rulesBlock, hintsBlock, fewShotBlock, chars, JSON_ONLY_TAIL]
        .filter(s => s && s.trim())
        .join('');
}

export function buildUserPrompt(messageText, macroResolver) {
    const expand = macroResolver || resolveSTMacros;
    const withMacros = expand(String(messageText || ''));
    const clean = sanitizePrompt(withMacros).slice(0, 12000);
    return `Сцена из чата:\n"""\n${clean}\n"""\n\nСоставь структурированный JSON-draft для изображения по этой сцене.`;
}

// Expose styleResult for pipeline to thread into flatten.
export { resolveStyle };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/prompt-builder.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/prompt-builder.js tests/prompt-builder.test.js
git commit -m "feat(builder): rewrite buildSystemPrompt as single path over registry"
```

---

## Task 7: Rewrite `default-template.js` (re-export v3 presets, remove raw)

**Files:**
- Rewrite: `src/default-template.js`

Removes `DEFAULT_RAW_TEMPLATE` and the `mode`/`rawSystemPrompt` fields. Exports v3 default templates built from `registry/kinds.js`. Keeps `DEFAULT_TEMPLATE` / `DEFAULT_TEMPLATE_V2` / `BUILTIN_TEMPLATES_V2` export names for backwards-compat with `index.js` and `prompt-templates.js` (updated in later tasks), but their content is now v3.

- [ ] **Step 1: Rewrite the file**

Replace the entire content of `src/default-template.js` with:

```js
// @ts-check
/**
 * v3 default templates. Built from registry/kinds.js presets.
 * Raw path (DEFAULT_RAW_TEMPLATE) removed. All templates are schemaVersion 3.
 */
import { KIND_PRESETS, KINDS, getKindPreset } from './registry/kinds.js';

function buildTemplate(kind) {
    const preset = getKindPreset(kind);
    return {
        schemaVersion: 3,
        kind,
        fields: null,           // null → use preset field list
        customFields: [],
        fieldHints: {},
        style: { mode: 'llm-pick', catalog: preset.styleCatalog, pinned: '' },
        rules: preset.rules,
        wrapper: kind === 'photo' ? { preset: 'selfie', ...preset.wrapper } : preset.wrapper,
        fewShot: [],
        aspectRatioDefault: preset.aspectRatioDefault,
        imageSizeDefault: preset.imageSizeDefault,
    };
}

export const DEFAULT_TEMPLATE_V3 = Object.freeze(buildTemplate('manga'));

// Backwards-compat exports (consumers updated in later tasks).
export const DEFAULT_TEMPLATE = DEFAULT_TEMPLATE_V3;
export const DEFAULT_TEMPLATE_V2 = DEFAULT_TEMPLATE_V3;

export const BUILTIN_TEMPLATES_V3 = Object.freeze(
    Object.fromEntries(KINDS.map(k => [k, Object.freeze(buildTemplate(k))])),
);

// Backwards-compat: keyed by v2 outputKind names too.
export const BUILTIN_TEMPLATES_V2 = Object.freeze({
    manga: BUILTIN_TEMPLATES_V3.manga,
    'manga-page': BUILTIN_TEMPLATES_V3.manga,
    illustration: BUILTIN_TEMPLATES_V3.illustration,
    'single-illustration': BUILTIN_TEMPLATES_V3.illustration,
    cinematic: BUILTIN_TEMPLATES_V3.cinematic,
    'cinematic-still': BUILTIN_TEMPLATES_V3.cinematic,
    photo: BUILTIN_TEMPLATES_V3.photo,
});

export { KIND_PRESETS, KINDS, getKindPreset };
```

- [ ] **Step 2: Verify imports resolve**

Run: `node --test tests/registry-kinds.test.js`
Expected: still PASS (kinds module unchanged).

- [ ] **Step 3: Commit**

```bash
git add src/default-template.js
git commit -m "feat(default-template): re-export v3 templates from registry, remove raw path"
```

---

## Task 8: Update `prompt-templates.js` (schemaVersion 3, remove v1→v2 migration)

**Files:**
- Modify: `src/prompt-templates.js`

Changes `defaultV2Content()` to `defaultV3Content()`, sets schemaVersion 3, removes the v1→v2 string migration (clean break), and adapts the stored template shape to v3 (`kind` instead of `outputKind`, no `mode`/`rawSystemPrompt`).

- [ ] **Step 1: Rewrite `src/prompt-templates.js`**

Replace the entire file with:

```js
// @ts-check
/**
 * Prompt templates — CRUD in localforage. v3: content is a v3 template object
 * (schemaVersion 3, kind, fields, style, rules, wrapper, fewShot).
 * v1 string templates and v2 mode/raw templates are flagged incompatible
 * (clean break — no auto-migration; user recreates). See spec §12.3.
 */
import { LF_TEMPLATES, uid, log, warn } from './core.js';
import { DEFAULT_TEMPLATE_V3 } from './default-template.js';
import { normalizeKind, getKindPreset } from './registry/kinds.js';

function lf() { return SillyTavern.libs.localforage; }

export async function listTemplates() {
    const arr = await lf().getItem(LF_TEMPLATES);
    return Array.isArray(arr) ? arr : [];
}

async function _setAll(arr) { await lf().setItem(LF_TEMPLATES, arr); }

function defaultV3Content(kind) {
    const k = normalizeKind(kind || 'manga');
    const preset = getKindPreset(k);
    return {
        schemaVersion: 3,
        kind: k,
        fields: null,
        customFields: [],
        fieldHints: {},
        style: { mode: 'llm-pick', catalog: preset.styleCatalog, pinned: '' },
        rules: preset.rules,
        wrapper: k === 'photo' ? { preset: 'selfie' } : preset.wrapper,
        fewShot: [],
        aspectRatioDefault: preset.aspectRatioDefault,
        imageSizeDefault: preset.imageSizeDefault,
    };
}

export function isV3Template(content) {
    return content && typeof content === 'object' && content.schemaVersion === 3;
}

export async function createTemplate(data = {}) {
    const arr = await listTemplates();
    const kind = normalizeKind(data.content?.kind || data.kind || 'manga');
    const content = isV3Template(data.content)
        ? { ...defaultV3Content(kind), ...data.content }
        : defaultV3Content(kind);
    const item = { id: uid(), name: data.name || 'Новый шаблон', content };
    arr.push(item);
    await _setAll(arr);
    log('Создан шаблон промпта', item.id);
    return item;
}

export async function getTemplate(id) {
    const arr = await listTemplates();
    return arr.find(t => t.id === id) || null;
}

export async function saveTemplate(patch) {
    if (!patch?.id) return null;
    const arr = await listTemplates();
    const i = arr.findIndex(t => t.id === patch.id);
    if (i === -1) return null;
    arr[i] = { ...arr[i], ...patch, id: patch.id };
    await _setAll(arr);
    return arr[i];
}

export async function deleteTemplate(id) {
    const arr = await listTemplates();
    await _setAll(arr.filter(t => t.id !== id));
    log('Удалён шаблон промпта', id);
}

export function getDefaultV3() { return DEFAULT_TEMPLATE_V3; }

// Backwards-compat alias.
export const getDefaultV2 = getDefaultV3;
```

- [ ] **Step 2: Commit**

```bash
git add src/prompt-templates.js
git commit -m "feat(templates): schemaVersion 3 storage, remove v1 migration"
```

---

## Task 9: Update `stage1-adapter.js` and `parser.js` (new flatten signature, no subject)

**Files:**
- Modify: `src/stage1-adapter.js`
- Modify: `src/parser.js`

These modules call `flattenToPrompt` with the v2 signature `(kind, draft, styleString, rules)`. Update to use the new `flatten(template, draft, opts)` signature. `normalizeStructuredDraft` needs a template object; when only kind is available, synthesize a minimal `{kind}` template.

- [ ] **Step 1: Update `src/stage1-adapter.js`**

In `src/stage1-adapter.js`, make these changes:

1. Change the import of `flattenToPrompt` to `flatten`:
```js
import { flatten } from './prompt-flatter.js';
```

2. Update `normalizeStructuredDraft(json, rules)` to `normalizeStructuredDraft(json, template, rules)`:

Replace the existing `normalizeStructuredDraft` function with:

```js
function normalizeStructuredDraft(json, template, rules) {
    const kind = inferKind(json);
    const r = { ...DEFAULT_RULES, ...(rules || {}) };
    let draft = normalizeDraft(kind, json);
    draft = applyRules(r, draft);
    const v = validateDraft(kind, draft, r);
    if (!v.ok) warn('Stage1 draft validation issues:', v.errors.join(' | '));

    const styleString = sanitizePrompt(STR(draft.style));
    const prompt = flatten(template || { kind }, draft, { resolvedStyle: null, rules: r });

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
```

3. Update the call site in `adaptStage1Response` — the `normalizeStructuredDraft(json, rules)` calls become `normalizeStructuredDraft(json, template, rules)`. There are two call sites (inline tag path and JSON path). Update both.

4. Update `inferKind` to return v3 kind names:
```js
function inferKind(d) {
    if (!d || typeof d !== 'object') return 'manga';
    if (Array.isArray(d.panels) && d.panels.length > 0) return 'manga';
    if (d.environment && typeof d.environment === 'object') return 'cinematic';
    return 'illustration';
}
```

- [ ] **Step 2: Update `src/parser.js`**

In `src/parser.js`:

1. Change the import:
```js
import { flatten } from './prompt-flatter.js';
```

2. In `normalizeInstruction(d, kind, rules)`, update the structured path to use new flatten:
```js
const styleString = cleanStyle || STR(d.style || '');
const prompt = flatten({ kind: k }, draft, { resolvedStyle: null, rules: r });
```

3. Update `parseInstructionFromText` to pass template through. The signature is already `(text, templateContent, rules, signal)` — it calls `adaptStage1Response(raw, templateContent, rules, signal)`. This stays the same, but `adaptStage1Response` now passes `templateContent` to `normalizeStructuredDraft`.

- [ ] **Step 3: Run existing adapter/parser tests**

Run: `node --test tests/stage1-adapter.test.js tests/parser.test.js`

If tests reference the old `flattenToPrompt` signature, update the test assertions to match the new `flatten` output format. The tests should still pass conceptually (manga produces "Vertical manga page", characters name-first, etc.).

> **Note:** `isStructuredDraft` in both files references `d.camera || d.light || d.location` — keep as-is (no `subject` check needed since subject never existed in v2 draft).

- [ ] **Step 4: Fix any test failures, then commit**

```bash
git add src/stage1-adapter.js src/parser.js tests/stage1-adapter.test.js tests/parser.test.js
git commit -m "feat(adapter): use v3 flatten signature and kind names"
```

---

## Task 10: Simplify `pipeline.js` (remove post-hoc re-assembly)

**Files:**
- Modify: `src/pipeline.js`

Removes the `pipeline.js:111-118` post-hoc style re-assembly block. Style is resolved once, threaded through `buildSystemPrompt` and `flatten` via `styleResult`.

- [ ] **Step 1: Update `runStage1` in `src/pipeline.js`**

Replace the body of `runStage1` (from the `try {` after presets resolution through `state.lastInstruction = instr;`) with:

```js
    try {
        const { activeChars, templateContent } = await resolveActivePresets();

        const isV3 = templateContent && typeof templateContent === 'object'
            && templateContent.schemaVersion === 3;
        const kind = isV3 ? (templateContent.kind || 'manga') : 'manga';
        const rules = isV3 ? (templateContent.rules || {}) : {};
        const styleOverride = state.settings.advancedMode ? (state.styleOverride || '') : '';

        // Resolve style ONCE. Thread the result into both buildSystemPrompt
        // (for the style instruction block) and flatten (for the overwrite).
        const macroResolver = undefined; // uses default resolveSTMacros inside builder
        const styleResult = resolveStyle(
            templateContent?.style || { mode: 'llm-pick', catalog: [], pinned: '' },
            { override: styleOverride || undefined },
        );

        const system = buildSystemPrompt(
            templateContent || { kind, schemaVersion: 3 },
            activeChars,
            { styleOverride: styleOverride || undefined, styleResult },
        );
        const user = buildUserPrompt(msg.mes);
        const raw = await generatePromptText(system, user, onStatus, useSignal);
        if (useSignal.aborted) throw new DOMException('Aborted', 'AbortError');
        const instr = await parseInstructionFromText(raw, templateContent || { kind }, rules, useSignal);
        if (!instr) throw new Error('Не удалось распарсить промпт из ответа LLM');

        // Re-flatten with resolved style (pinned/random/override overwrite).
        // llm-pick: styleResult.styleString is '' → resolvedStyle=null → LLM choice wins.
        if (instr.draft) {
            const resolvedStyle = styleResult.styleString || null;
            instr.prompt = flatten(
                templateContent || { kind },
                instr.draft,
                { resolvedStyle, rules: { ...DEFAULT_RULES, ...rules } },
            );
            instr.style = resolvedStyle || instr.style;
        }

        state.lastInstruction = instr;
```

Add the new imports at the top of `pipeline.js` (alongside existing imports):

```js
import { resolveStyle } from './style-resolver.js';
import { flatten } from './prompt-flatter.js';
import { DEFAULT_RULES } from './prompt-schema.js';
```

(`DEFAULT_RULES` is already imported; `resolveStyle` and `flatten` are new imports for pipeline.)

The old block (`if (styleOverride) { ... }` at lines 111-118) is deleted — its logic is now inside the `flatten` call above.

- [ ] **Step 2: Verify pipeline still imports correctly**

Run: `node --test tests/schema.test.js tests/flatter.test.js`
Expected: PASS (these don't test pipeline directly but confirm dependencies).

> Pipeline integration is tested in Task 14 (smoke test). The pipeline changes are mechanical: single style resolution, thread styleResult, linear flow.

- [ ] **Step 3: Commit**

```bash
git add src/pipeline.js
git commit -m "refactor(pipeline): remove post-hoc style re-assembly, single resolveStyle"
```

---

## Task 11: Rewrite `tab-templates.js` (two-level Simple/Advanced typed controls)

**Files:**
- Rewrite: `src/ui/tab-templates.js`

Replaces the v2 card (JSON rules textarea, mode select) with a two-level form: Simple (name, kind, style mode/catalog/pinned, typed rules) + Advanced (per-field hints, wrapper, few-shot, custom fields). No raw JSON. No subject field. No flattenOrder controls.

This is the largest UI task. The render produces a form per template card. Collect reads typed inputs and assembles a v3 content object.

- [ ] **Step 1: Rewrite `src/ui/tab-templates.js`**

Replace the entire file with:

```js
// @ts-check
/**
 * Вкладка «Шаблоны» v3: two-level Simple + Advanced editor.
 * Simple: name, kind, style mode/catalog/pinned, typed rules.
 * Advanced (collapsed): per-field hints, wrapper, few-shot.
 * No raw JSON textarea. No subject field. No flattenOrder controls.
 */
import { state, escapeHtml, showConfirmModal, debounceSave } from '../core.js';
import { listTemplates, createTemplate, saveTemplate, deleteTemplate } from '../prompt-templates.js';
import { persistBundleFields } from '../bundles.js';
import { refreshActive } from './tabs.js';
import { KINDS, getKindPreset, normalizeKind } from '../registry/kinds.js';

const KIND_LABELS = {
    manga: 'Манга-страница',
    cinematic: 'Кинематографический кадр',
    illustration: 'Иллюстрация',
    photo: 'Фото (selfie/instagram)',
};

const RULES_BY_KIND = {
    manga: ['minPanels', 'maxPanels', 'minCloseups', 'maxCharsPerPanel'],
    cinematic: ['maxCharsCinematic'],
    illustration: [],
    photo: [],
};
const SHARED_RULES = ['bannedWords', 'allowedIntimate', 'bubbleLanguage', 'promptLanguage'];

export function render(root) {
    root.innerHTML = `
        <div class="uris-templates">
            <div class="uris-templates-hint">
                <small class="uris-hint">Шаблон Stage1 определяет схему генерации промпта. Макросы ST: {{char}}, {{user}}, {{random::a::b}}, {{pick::a::b}} (разделитель ::).</small>
            </div>
            <div class="uris-templates-list" id="urisTemplatesList"></div>
        </div>`;
    renderList(root);
}

async function renderList(root) {
    const host = root.querySelector('#urisTemplatesList');
    const arr = await listTemplates();
    host.innerHTML = arr.map(t => templateCard(t)).join('') +
        `<button class="menu_button uris-add-btn" id="urisAddTemplate"><i class="fa-solid fa-plus"></i> Создать шаблон</button>`;
    host.querySelector('#urisAddTemplate').addEventListener('click', async () => {
        await createTemplate({});
        refreshActive();
    });
    bindCards(host);
}

function templateCard(t) {
    const active = t.id === state.activeTemplateId;
    const c = (t.content && t.content.schemaVersion === 3) ? t.content : null;
    const kind = c?.kind || 'manga';
    const style = c?.style || { mode: 'llm-pick', catalog: [], pinned: '' };
    const rules = c?.rules || {};
    const preset = getKindPreset(kind);
    const catalogStr = (style.catalog || []).join('\n');

    return `<div class="uris-preset-card ${active ? 'uris-card-active' : ''}" data-id="${t.id}">
        <div class="uris-field"><label>Название</label>
            <input class="text_pole uris-name" value="${escapeHtml(t.name)}" placeholder="Название шаблона"></div>
        <div class="uris-row"><label>Тип</label>
            <select class="text_pole uris-kind">
                ${KINDS.map(k => `<option value="${k}" ${kind === k ? 'selected' : ''}>${KIND_LABELS[k]}</option>`).join('')}
            </select>
            <label>Соотношение</label><input class="text_pole uris-aspect" value="${escapeHtml(c?.aspectRatioDefault || preset.aspectRatioDefault)}">
            <label>Размер</label><input class="text_pole uris-imgsize" value="${escapeHtml(c?.imageSizeDefault || preset.imageSizeDefault)}">
        </div>

        <fieldset class="uris-section"><legend>Стиль</legend>
            <div class="uris-row">
                <label class="checkbox_label"><input type="radio" name="stylemode-${t.id}" value="llm-pick" ${style.mode === 'llm-pick' ? 'checked' : ''}> LLM выбирает</label>
                <label class="checkbox_label"><input type="radio" name="stylemode-${t.id}" value="pinned" ${style.mode === 'pinned' ? 'checked' : ''}> Закреплён</label>
                <label class="checkbox_label"><input type="radio" name="stylemode-${t.id}" value="random" ${style.mode === 'random' ? 'checked' : ''}> Случайный</label>
            </div>
            <div class="uris-field"><label>Каталог стилей (по одному в строке)</label>
                <textarea class="text_pole uris-style-catalog" rows="6" placeholder="Один стиль на строку…">${escapeHtml(catalogStr)}</textarea></div>
            <div class="uris-field"><label>Закреплённый стиль (для «Закреплён»)</label>
                <textarea class="text_pole uris-style-pinned" rows="2" placeholder="Полное описание одного стиля">${escapeHtml(style.pinned || '')}</textarea></div>
        </fieldset>

        <fieldset class="uris-section"><legend>Правила</legend>
            ${renderRulesInputs(kind, rules)}
        </fieldset>

        <details class="uris-advanced-section">
            <summary>Дополнительно (подсказки полей, обёртка, few-shot)</summary>
            ${renderAdvanced(c, kind)}
        </details>

        <div class="uris-row">
            <button class="menu_button uris-activate" ${active ? 'disabled title="Уже активен"' : 'title="Сделать активным"'}><i class="fa-solid fa-check"></i> ${active ? 'Активен' : 'Сделать активным'}</button>
            <button class="menu_button uris-del"><i class="fa-solid fa-trash"></i> Удалить</button>
        </div>
    </div>`;
}

function renderRulesInputs(kind, rules) {
    const applicable = [...(RULES_BY_KIND[normalizeKind(kind)] || []), ...SHARED_RULES];
    const parts = [];
    if (applicable.includes('minPanels') && applicable.includes('maxPanels')) {
        parts.push(`<div class="uris-row"><label>Панелей</label>
            <input class="text_pole uris-rule-minPanels" type="number" min="1" value="${rules.minPanels ?? 4}" style="width:60px"> –
            <input class="text_pole uris-rule-maxPanels" type="number" min="1" value="${rules.maxPanels ?? 5}" style="width:60px"></div>`);
    }
    if (applicable.includes('minCloseups')) {
        parts.push(`<div class="uris-row"><label>Мин. крупных планов</label><input class="text_pole uris-rule-minCloseups" type="number" min="0" value="${rules.minCloseups ?? 2}" style="width:60px"></div>`);
    }
    if (applicable.includes('maxCharsPerPanel')) {
        parts.push(`<div class="uris-row"><label>Макс. персонажей в панели</label><input class="text_pole uris-rule-maxCharsPerPanel" type="number" min="1" value="${rules.maxCharsPerPanel ?? 2}" style="width:60px"></div>`);
    }
    if (applicable.includes('maxCharsCinematic')) {
        parts.push(`<div class="uris-row"><label>Макс. персонажей</label><input class="text_pole uris-rule-maxCharsCinematic" type="number" min="1" value="${rules.maxCharsCinematic ?? 4}" style="width:60px"></div>`);
    }
    parts.push(`<div class="uris-field"><label>Запрещённые слова (через запятую)</label>
        <input class="text_pole uris-rule-bannedWords" value="${escapeHtml((rules.bannedWords || []).join(', '))}"></div>`);
    parts.push(`<div class="uris-field"><label>Разрешённые интимные дескрипторы (через запятую)</label>
        <input class="text_pole uris-rule-allowedIntimate" value="${escapeHtml((rules.allowedIntimate || []).join(', '))}"></div>`);
    parts.push(`<div class="uris-row"><label>Язык реплик</label>
        <select class="text_pole uris-rule-bubbleLanguage">
            <option value="ru" ${rules.bubbleLanguage === 'ru' ? 'selected' : ''}>Русский</option>
            <option value="en" ${rules.bubbleLanguage === 'en' ? 'selected' : ''}>English</option>
        </select>
        <label>Язык промпта</label>
        <select class="text_pole uris-rule-promptLanguage">
            <option value="en" ${rules.promptLanguage === 'en' ? 'selected' : ''}>English</option>
            <option value="ru" ${rules.promptLanguage === 'ru' ? 'selected' : ''}>Русский</option>
        </select></div>`);
    return parts.join('');
}

function renderAdvanced(c, kind) {
    const hints = c?.fieldHints || {};
    const preset = getKindPreset(kind);
    const fields = preset.fields;
    const hintParts = fields.map(f => `<div class="uris-field"><label>${f}</label>
        <textarea class="text_pole uris-hint" data-field="${f}" rows="2" placeholder="Подсказка для LLM">${escapeHtml(hints[f] || '')}</textarea></div>`).join('');

    let wrapperPart;
    if (kind === 'photo') {
        const wp = c?.wrapper?.preset || 'selfie';
        wrapperPart = `<div class="uris-row"><label>Пресет обёртки</label>
            <select class="text_pole uris-wrapper-preset">
                <option value="selfie" ${wp === 'selfie' ? 'selected' : ''}>Selfie</option>
                <option value="instagram" ${wp === 'instagram' ? 'selected' : ''}>Instagram</option>
                <option value="portrait" ${wp === 'portrait' ? 'selected' : ''}>Portrait</option>
            </select></div>`;
    } else {
        const w = c?.wrapper || preset.wrapper;
        wrapperPart = `<div class="uris-field"><label>Обёртка: начало (head)</label>
            <textarea class="text_pole uris-wrapper-head" rows="3">${escapeHtml(w.head || '')}</textarea></div>
            <div class="uris-field"><label>Обёртка: конец (tail)</label>
            <textarea class="text_pole uris-wrapper-tail" rows="2">${escapeHtml(w.tail || '')}</textarea></div>`;
    }

    return `<div class="uris-adv-hints"><h4>Подсказки полей</h4>${hintParts}</div>
        <div class="uris-adv-wrapper"><h4>Обёртка</h4>${wrapperPart}</div>`;
}

function bindCards(host) {
    for (const card of host.querySelectorAll('.uris-preset-card')) {
        const id = card.dataset.id;
        const collect = () => collectCard(card);
        const save = async () => { await saveTemplate({ id, ...collect() }); };
        card.addEventListener('change', save);
        card.addEventListener('input', debounceSave(saveTemplate, id, collect));

        // Kind change → re-render rules + advanced
        const kindSel = card.querySelector('.uris-kind');
        kindSel?.addEventListener('change', async () => {
            await save();
            refreshActive();
        });

        card.querySelector('.uris-activate')?.addEventListener('click', async () => {
            await setActiveTemplate(id);
            refreshActive();
        });
        card.querySelector('.uris-del')?.addEventListener('click', async () => {
            if (await showConfirmModal('Удалить шаблон?')) {
                await deleteTemplate(id);
                if (state.activeTemplateId === id) await persistBundleFields({ templatesIds: [] });
                refreshActive();
            }
        });
    }
}

function collectCard(card) {
    const get = (sel) => card.querySelector(sel)?.value ?? '';
    const getList = (sel) => get(sel).split(',').map(s => s.trim()).filter(Boolean);
    const kind = normalizeKind(get('.uris-kind') || 'manga');
    const styleMode = card.querySelector(`input[name^="stylemode-"]:checked`)?.value || 'llm-pick';
    const catalog = get('.uris-style-catalog').split('\n').map(s => s.trim()).filter(Boolean);

    const rules = {};
    const numVal = (sel) => { const v = parseInt(get(sel), 10); return Number.isFinite(v) ? v : undefined; };
    if (card.querySelector('.uris-rule-minPanels')) rules.minPanels = numVal('.uris-rule-minPanels');
    if (card.querySelector('.uris-rule-maxPanels')) rules.maxPanels = numVal('.uris-rule-maxPanels');
    if (card.querySelector('.uris-rule-minCloseups')) rules.minCloseups = numVal('.uris-rule-minCloseups');
    if (card.querySelector('.uris-rule-maxCharsPerPanel')) rules.maxCharsPerPanel = numVal('.uris-rule-maxCharsPerPanel');
    if (card.querySelector('.uris-rule-maxCharsCinematic')) rules.maxCharsCinematic = numVal('.uris-rule-maxCharsCinematic');
    rules.bannedWords = getList('.uris-rule-bannedWords');
    rules.allowedIntimate = getList('.uris-rule-allowedIntimate');
    rules.bubbleLanguage = get('.uris-rule-bubbleLanguage') || 'ru';
    rules.promptLanguage = get('.uris-rule-promptLanguage') || 'en';

    const fieldHints = {};
    card.querySelectorAll('.uris-hint').forEach(el => {
        const f = el.dataset.field;
        if (f && el.value.trim()) fieldHints[f] = el.value.trim();
    });

    const wrapper = {};
    if (kind === 'photo') {
        wrapper.preset = get('.uris-wrapper-preset') || 'selfie';
    } else {
        wrapper.head = get('.uris-wrapper-head');
        wrapper.tail = get('.uris-wrapper-tail');
    }

    return {
        name: get('.uris-name') || 'Шаблон',
        content: {
            schemaVersion: 3,
            kind,
            fields: null,
            customFields: [],
            fieldHints,
            style: { mode: styleMode, catalog, pinned: get('.uris-style-pinned') },
            rules,
            wrapper,
            fewShot: [],
            aspectRatioDefault: get('.uris-aspect') || '9:16',
            imageSizeDefault: get('.uris-imgsize') || '2K',
        },
    };
}

async function setActiveTemplate(id) {
    await persistBundleFields({ templatesIds: id ? [id] : [] });
    toastr?.success('Шаблон применён');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/tab-templates.js
git commit -m "feat(ui/templates): two-level Simple/Advanced editor with typed controls"
```

---

## Task 12: Update `tab-generate.js` (remove subject, registry-driven draft editor)

**Files:**
- Modify: `src/ui/tab-generate.js`

The draft editor currently renders camera/light/location/mood/characters/panels/bubbles/environment inputs directly. Remove any `subject` references (there are none in the current code, but verify). The kind selector options change to v3 names. `flattenToPrompt` calls become `flatten`.

- [ ] **Step 1: Update kind selector options**

In `src/ui/tab-generate.js`, find the `#urisKind` select (around line 80-85) and replace the options:

```js
                    <select class="text_pole" id="urisKind">
                        <option value="manga">Манга-страница</option>
                        <option value="cinematic">Кинематографический кадр</option>
                        <option value="illustration">Иллюстрация</option>
                        <option value="photo">Фото</option>
                    </select>
```

- [ ] **Step 2: Update `recomputePromptFromDraft` to use new flatten**

In `src/ui/tab-generate.js`, find `recomputePromptFromDraft` (around line 633). Replace the `flattenToPrompt` call:

```js
function recomputePromptFromDraft(host, kind) {
    const K = kind || document.getElementById('urisKind')?.value || 'manga';
    const d = collectDraft(K);
    const styleString = document.getElementById('urisStyleOverride')?.value || '';
    const rules = {};
    const prompt = flatten({ kind: K }, d, { resolvedStyle: styleString || null, rules });
    const el = document.getElementById('urisPrompt');
    if (el && prompt) el.value = prompt;
    if (state.lastInstruction) {
        state.lastInstruction.draft = d;
        state.lastInstruction.prompt = prompt;
        state.lastInstruction.style = styleString;
        state.lastInstruction.kind = K;
    }
}
```

Update the import at the top of the file:
```js
import { flatten } from '../prompt-flatter.js';
```
Remove the `import { flattenToPrompt }` line.

Also update `import { normalizeDraft, emptyDraft, KIND_PANELS, KIND_CINE }` — these are still exported by the new prompt-schema.js, so no change needed unless `KIND_PANELS`/`KIND_CINE` values are compared against string literals. They now equal `'manga'`/`'cinematic'` (v3 names), which is correct.

- [ ] **Step 3: Verify no `subject` references exist**

Run: `grep -n "subject" src/ui/tab-generate.js`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add src/ui/tab-generate.js
git commit -m "feat(ui/generate): v3 kind names and flatten signature"
```

---

## Task 13: Update `index.js` (ensureDefaultTemplate uses v3 default)

**Files:**
- Modify: `index.js`

`ensureDefaultTemplate` (line 211) creates a template with `content: DEFAULT_TEMPLATE` — now a v3 object. Verify the import and that `createTemplate` handles it.

- [ ] **Step 1: Update `ensureDefaultTemplate`**

In `index.js`, around line 211, update:

```js
async function ensureDefaultTemplate() {
    const arr = await listTemplates();
    if (!arr.length) await createTemplate({ name: 'Манга (дефолт)', content: DEFAULT_TEMPLATE });
}
```

This already works since `DEFAULT_TEMPLATE` now points to `DEFAULT_TEMPLATE_V3` (from Task 7) and `createTemplate` accepts v3 content (Task 8). Verify the import at the top of `index.js` includes `DEFAULT_TEMPLATE`:

```js
import { DEFAULT_TEMPLATE } from './src/default-template.js';
```

If the import previously referenced `DEFAULT_TEMPLATE_V2` or both, consolidate to `DEFAULT_TEMPLATE`.

- [ ] **Step 2: Commit**

```bash
git add index.js
git commit -m "feat(index): ensureDefaultTemplate uses v3 default"
```

---

## Task 14: Full test suite + smoke test

**Files:**
- Verify: all test files pass
- Run: `tests/smoke.test.js`

- [ ] **Step 1: Run full test suite**

Run: `node --test tests/*.test.js`
Expected: all PASS. If any fail, fix the specific test or implementation.

Common issues to check:
- `tests/style-resolver.test.js` — unchanged, should still pass. But `style-resolver.test.js` fakeMacros splits on `|` — this is the bug noted in spec §8. Leave the test as-is for now (it tests the resolver's macro-expansion behavior with an injected fake; the real fix is in UI hints, not the resolver). Add a note.
- `tests/providers/*.test.js` — unchanged, should pass.

- [ ] **Step 2: Run smoke test**

Run: `node --test tests/smoke.test.js`
Expected: PASS.

- [ ] **Step 3: Manual integration check (end-to-end prompt assembly)**

Create a temporary script `tests/manual/v3-assemble-check.mjs` (do NOT commit) to verify the full build → flatten round-trip for manga:

```js
import { buildSystemPrompt } from '../../src/prompt-builder.js';
import { flatten } from '../../src/prompt-flatter.js';
import { normalizeDraft } from '../../src/prompt-schema.js';
import { getKindPreset } from '../../src/registry/kinds.js';

const tmpl = { kind: 'manga', schemaVersion: 3, fields: null, customFields: [], style: { mode: 'llm-pick', catalog: getKindPreset('manga').styleCatalog, pinned: '' }, rules: getKindPreset('manga').rules, wrapper: getKindPreset('manga').wrapper, fieldHints: {}, fewShot: [] };
const ID = (s) => String(s ?? '');
const system = buildSystemPrompt(tmpl, [{ sceneName: 'Mira', name: 'Mira', role: 'char', description: 'dark hair' }], { macroResolver: ID });
console.log('=== SYSTEM PROMPT (first 500 chars) ===');
console.log(system.slice(0, 500));

const draft = normalizeDraft('manga', { style: 'sumi-e', camera: '85mm', light: 'rim', characters: [{ name: 'Mira', action: 'standing' }], panels: [{ shot: 'close up' },{ shot: 'medium' },{ shot: 'medium' },{ shot: 'medium' }] });
const prompt = flatten(tmpl, draft, { resolvedStyle: null });
console.log('\n=== FLATTENED PROMPT ===');
console.log(prompt);
console.log('\n=== CHECKS ===');
console.log('No subject field in system:', !/subject:/.test(system));
console.log('No duplicate character blocks:', (prompt.match(/Mira/g) || []).length <= 2);
console.log('Style first:', prompt.indexOf('sumi-e') < prompt.indexOf('Characters'));
```

Run: `node tests/manual/v3-assemble-check.mjs`
Expected: all checks print `true`. Delete the file after.

- [ ] **Step 4: Commit any test fixes**

```bash
git add tests/
git commit -m "test: verify v3 prompt assembly round-trip"
```

---

## Self-review checklist

- [ ] **Spec coverage:** §3 Field Registry → Tasks 1-3. §4 Template Model → Tasks 7-8. §5 Style Resolution → Task 10 (pipeline). §6 Prompt Assembly → Tasks 5-6. §7 Kind Presets → Task 2. §8 ST Macros → Task 11 (UI hint text uses `::`). §9 UI → Tasks 11-12. §10 Module Architecture → all tasks. §11 Error Handling → preserved in schema/flatten (validateDraft, apostrophe guard). §12 Testing → Tasks 1-6, 14. §13 Research → reflected in fixed ordering (Task 2) and characters-as-subject (Task 4).
- [ ] **No placeholders:** every step has complete code or exact commands.
- [ ] **Type consistency:** `flatten(template, draft, opts)` signature consistent across Tasks 5, 9, 10, 12. `resolveFields(template)` consistent across Tasks 3, 5, 6. `normalizeKind` exported from both `kinds.js` and `prompt-schema.js` (Task 4 re-exports from kinds.js). KIND constants (`KIND_PANELS='manga'` etc.) consistent.
- [ ] **No `subject` field** anywhere in new code (verified in Tasks 1, 2, 4).
- [ ] **No `flattenOrder` user control** (removed from UI in Task 11; order is fixed constant in Task 2).
- [ ] **Macro syntax `::`** in UI hints (Task 11).
