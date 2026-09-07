# Stage 1 Prompt System — Rework Design (v3)

**Date:** 2026-07-11
**Status:** Design (awaiting review)
**Supersedes:** Stage 1 v2 structured/raw paths (`prompt-builder.js`, `prompt-schema.js`, `prompt-flatter.js`, `default-template.js`, `tab-templates.js`)

---

## 1. Problem

Stage 1 (text-LLM builds an image prompt) has accumulated complexity in six areas. The concept is sound — research and user examples confirm the structured-block approach is correct — but the implementation is tangled:

1. **Two parallel prompt models (raw / structured).** `buildSystemPrompt` branches into three paths by `typeof`/`mode`. Any logic change must be tracked across both. Raw is legacy; all built-in templates are structured.
2. **Template god-object (~15 nested fields).** One `content` object carries mode, outputKind, style config, rules, fieldInstructions, fewShot, defaults, rawSystemPrompt — consumed by 4 modules through string field names with no shared declaration.
3. **Triple coupling: schema ↔ fieldHints ↔ flatter ↔ validator.** Four modules (`describeSchema`, `renderFieldInstructions`, `validateDraft`, `flattenToPrompt`) are linked by string field names. Adding a field means touching all four, and nothing catches a mismatch.
4. **Style is the most fragile part.** `style.mode` (llm-pick/pinned/random) + runtime `styleOverride` resolves to 4 "effective modes". Style is handled in `renderStyleBlock` at build time, **then re-assembled post-hoc** in `pipeline.js:111-118` after parsing — a symptom of style not being cleanly modeled.
5. **Rules bag with kind-dependent applicability.** `minPanels`/`maxPanels` (manga only), `maxCharsCinematic` (cinematic only), `bannedWords` (all) — which applies to which kind is not modeled, just conditionally checked. Users editing a manga template see irrelevant fields.
6. **UI exposes the god-object as-is.** `tab-templates.js` edits `rules` as a JSON textarea; `fieldInstructions` is not editable at all. Configuring prompt behavior means hand-editing JSON.

**What works well and stays:** the two-stage pipeline architecture, `stage1-adapter.js` (universal parser), bundles as source-of-truth, provider consumption of `instruction.{style, prompt, aspectRatio, imageSize}`. Only the prompt *building* layer changes.

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Scope | Code architecture + UX together | UX is determined by the data model and vice versa; fixing only one leaves the other tangled |
| Backward compatibility | Clean break (schemaVersion 3) | Early-stage personal extension; no migration burden; raw path can be removed |
| Architecture | **Field Registry** — field as atomic unit | Unifies the 4 coupled consumers into thin functions over a single declaration; kills problems #1, #3, #5, #6 with one mechanism |
| Radicality | Full rework of prompt layer | Half-measures (Approach B) leave triple coupling intact |
| Style in model | Field with a special resolver | Resolve once pre-LLM; post-hoc surgery in pipeline disappears |
| Kind | Preset of fields + free configuration | 4 built-in presets (manga, cinematic, illustration, photo); user can override fields or create from scratch. `photo` replaces the former `selfie` + `instagram` — they differed only in wrapper boilerplate, not in field structure |
| Characters as sole subject source | One field, not two | No separate `subject` field — the `characters` array IS the subject. `flatten` renders each character name-first (reference-triggering invariant). Avoids asking the LLM to describe the same people twice (free text `subject` + structured `characters`), which duplicated every character in the final prompt |
| Custom fields | Supported | User can add fields beyond the built-in registry |
| Template editor UI | Two-level (Simple + Advanced) | Simple view shows what 90% of users need (name, kind, style catalog/mode, typed rules); Advanced (collapsed) reveals per-field hints, wrapper, few-shot, custom fields. Fixes v2's raw-JSON-textarea pain without over-correcting into a per-field control wall |
| ST macros | All editable text fields | `{{char}}`, `{{user}}`, `{{random::}}`, `{{pick::}}`, `{{roll}}`, custom — expanded via `ctx.substituteParams` in every user-editable template string |

---

## 3. Field Registry (Core)

### 3.1 The field declaration

A field is a self-contained declaration. Everything the four consumers currently do separately — by string name — becomes one definition:

```js
// registry/fields.js
defineField({
  name: 'camera',
  label: 'Камера',
  appliesTo: ['manga', 'illustration', 'cinematic', 'photo'],
  describe: 'Shot type, angle, focal length, framing, DOF',
  validate: (v) => (typeof v === 'string' && v.trim() ? null : 'empty'),
  flatten: (v, ctx) => `[CAMERA: ${v}]`,
  uiType: 'textarea',
});
```

Fields with structured sub-objects (panels, characters, environment) declare richer `flatten`/`validate`/`uiType`:

```js
defineField({
  name: 'panels',
  label: 'Панели',
  appliesTo: ['manga'],
  describe: 'each { type, shape, shot, angle, lightingColor, charsInFrame:[], actions:[], sfx }',
  validate: (v, rules) => validatePanelCount(v, rules),
  flatten: (v, ctx) => renderPanelsBlock(v, ctx),
  uiType: 'cards',
  rulesShape: ['minPanels', 'maxPanels', 'minCloseups', 'maxCharsPerPanel'],
});
```

### 3.2 Consumers become thin functions

| Current (4 modules, string coupling) | v3 |
|---|---|
| `describeSchema(kind)` in prompt-builder | `fieldsFor(kind).map(f => f.describe)` |
| `renderFieldInstructions(fi, kind)` | `fieldsFor(kind, template).map(f => template.hints[f.name] ?? f.describe)` |
| `validateDraft(draft, kind)` in prompt-schema | `fieldsFor(kind, template).map(f => f.validate(draft[f.name], rules))` |
| `flattenToPrompt(kind, draft)` in prompt-flatter | `orderedFields(template).map(f => f.flatten(draft[f.name], ctx)).join('\n')` |

`fieldsFor(kind, template)` = built-in fields where `appliesTo` includes the kind (or `'*'`) **and** the field is enabled in `template.fields`, plus any custom fields declared in the template. If `template.fields` is absent, the kind preset's field list is used.

### 3.3 Style as a field

```js
defineField({
  name: 'style',
  label: 'Стиль',
  appliesTo: ['*'],
  describe: 'Visual style (formula: show/light/grade or art-style descriptor)',
  resolve: (styleConfig, opts) => resolveStyle(styleConfig, opts),
  flatten: (v) => v,
  uiType: 'style-editor',
});
```

`resolve()` is called **once** during `buildSystemPrompt`. The result (`styleString` or the raw catalog for llm-pick) feeds both the system prompt (instructions to the LLM) and, after parsing, the final prompt via `flatten`. **Post-hoc re-assembly in pipeline is removed.**

### 3.4 Custom fields

A template may declare custom fields beyond the built-in registry:

```js
template.customFields = [
  {
    name: 'colorPalette',
    label: 'Палитра',
    describe: 'Dominant color scheme and grade',
    flatten: (v) => `Color palette: ${v}`,  // simple text flatten
    uiType: 'text',
  },
];
```

Custom fields get a default text flatten (`name: value`). They appear in the field list with the same enable/disable/order controls. They cannot have structured sub-objects (kept simple by design — if a structured custom field is needed later, it joins the built-in registry).

### 3.5 Built-in field registry

| Field | appliesTo | uiType | Notes |
|---|---|---|---|
| `style` | `*` | style-editor | Special resolver; see §5 |
| `camera` | all 4 | textarea | Shot, angle, focal, DOF |
| `light` | all 4 | textarea | One named key source + direction |
| `location` | manga, illustration | textarea | Place, time, weather |
| `mood` | all 4 | textarea | Single emotional sentence |
| `characters` | all 4 | cards | Structured array `{name, face, hair, clothing, action, gaze, emotion, traits}`. **The sole subject source** — `flatten` renders each character name-first (reference-triggering invariant). No separate `subject` field. The `describe` hint instructs the LLM to extract ALL traits from the character cards into these sub-fields (non-human traits as practical prosthetics; every character mid-action) |
| `panels` | manga | cards | `{type, shape, shot, angle, lightingColor, charsInFrame[], actions[], sfx}` |
| `speechBubbles` | manga | cards | `{target, text}` |
| `environment` | cinematic, photo | object | `{geoAnchor, props[], atmosphere, ground}` |

---

## 4. Template Model (v3)

```js
{
  schemaVersion: 3,
  name: 'Манга-страница',
  kind: 'manga',                    // preset name; used to seed defaults if fields/rules absent

  fields: null,                     // null → use kind preset's field list.
                                    // Array of field names → overrides preset.
                                    // e.g. ['style','camera','light','location','mood','characters','panels','speechBubbles']

  customFields: [],                 // user-defined fields (see §3.4)

  fieldHints: {                     // per-field hint overrides for LLM instruction
    camera: 'Always describe dynamic camera angles. Include frame-within-frame when motivated.',
    light: 'One named practical key source + direction. Chiaroscuro, rim lighting, god rays.',
    panels: 'For each panel: type, shape, shot, angle, lighting, chars in frame (max 2), actions/gaze. Add Russian SFX lettering.',
    characters: 'Extract ALL traits from character cards. Non-human traits as practical prosthetics. Every character mid-action. Name first (first name only). {name, face, hair, clothing, action+pose, gaze, emotion, traits}.',
    speechBubbles: '[1-2] speech bubbles pointing to [Character name] says "text 3-8 words". Russian.',
    mood: 'Single emotional sentence — internal state the image evokes.',
  },

  style: {
    mode: 'llm-pick',               // 'llm-pick' | 'pinned' | 'random'
    catalog: [                      // array of full style strings; lives HERE in the template
      'Chainsaw Man manga art style, raw expressive brushwork, high-contrast gritty ink splashes, ...',
      'Baroque oil painting on canvas aesthetic with contemporary manga character proportions, ...',
      // ... 12 total
    ],
    pinned: '',                     // used when mode='pinned'
  },

  rules: {                          // only kind-applicable rules shown in UI
    minPanels: 4,
    maxPanels: 5,
    minCloseups: 2,
    maxCharsPerPanel: 2,
    bannedWords: ['naked', 'nude', 'penis', ...],
    allowedIntimate: ['unbuttoned shirt', 'pressing bodies together', ...],
    bubbleLanguage: 'ru',
    promptLanguage: 'en',
  },

  wrapper: {                        // head/tail boilerplate around the flattened prompt
    head: 'Vertical manga page with an unpredictable, highly asymmetrical layout of [4 to 5] panels. ...',
    tail: 'Adult 18+ fictional characters',
  },

  flattenOrder: null,               // DEPRECATED — order is now fixed per kind (see §6.3). Field kept as null for forward-compat; ignored by flatten.

  fewShot: [],                      // [{ scene, result }] — scene is macro-expanded

  aspectRatioDefault: '9:16',
  imageSizeDefault: '2K',
}
```

**Removed (v2 → v3):** `mode` (always structured now), `rawSystemPrompt` (raw path deleted), `outputKind` (replaced by `kind`), `schemaVersion: 2` → `3`.

---

## 5. Style Resolution

### 5.1 Modes

| Mode | Set in | Behavior | ST macros |
|---|---|---|---|
| `llm-pick` | `template.style.mode` | LLM sees the **entire catalog** in the system prompt and picks one to fit the scene's mood. Catalog emitted raw. LLM fills the `style` field. | Catalog NOT expanded (intentional — bug #1 fix) |
| `pinned` | `template.style.mode` + `style.pinned` | One fixed style string from `style.pinned` goes to `instruction.style`. | Expanded after selection via `ctx.substituteParams` |
| `random` | `template.style.mode` | Random pick (seeded, deterministic) from `style.catalog`. Goes to `instruction.style`. | Expanded after selection |
| `override` | Runtime UI (Generate tab) | Temporary override; beats all template modes. Session-only. | Expanded |

Priority: `override` > `pinned` > `random` > `llm-pick`.

### 5.2 `{{random::}}` clarification

ST macro `{{random::a::b}}` (resolved by `ctx.substituteParams`) is a **different mechanism** from our `random` mode. Our catalog is a plain array of full style strings — no `{{random::}}` syntax needed. ST macros remain available in `pinned` strings, `fieldHints`, `wrapper.head/tail`, and `fewShot.scene` for users who want them, but they are not the primary style-selection mechanism.

### 5.3 One-time resolution

`resolveStyle()` runs once in `buildSystemPrompt`. The result propagates to `flatten` as `ctx.resolvedStyle`. How `flatten` uses it depends on mode:

- **llm-pick** → catalog block emitted into system prompt; `ctx.resolvedStyle=null` (no override). After parse, the LLM-chosen string from `draft.style` goes to `flatten` as-is. LLM is the source of truth.
- **pinned/random/override** → `styleString` resolved; "use EXACTLY this string in style field" emitted into system prompt; `ctx.resolvedStyle=<resolved string>`. During `flatten`, the `style` field **overwrites** `draft.style` with `ctx.resolvedStyle` — guaranteeing the resolved style wins even if the LLM disobeyed. This is deterministic flatten behavior (inside `STYLE.flatten`), not a pipeline post-hoc step.

**Why this is not "post-hoc surgery":** The v2 problem (`pipeline.js:111-118`) re-parsed, re-flattened, and re-assembled the entire instruction *after* the pipeline thought it was done — logic leaked into the orchestrator. In v3, the overwrite is a property of the `STYLE.flatten` function itself, driven by `ctx.resolvedStyle` computed once at build time. The pipeline stays linear: build → LLM → parse → flatten → done. `pipeline.js:111-118` is deleted.

---

## 6. Prompt Assembly

### 6.1 One path (raw deleted)

```
buildSystemPrompt(template, chars, opts)
  1. fields = resolveFields(template)               // kind preset ∪ template.fields ∪ customFields
  2. styleResult = STYLE.resolve(template.style, opts)  // ONE call; result in opts
  3. blocks = [
       head:      role instruction ("Ты — генератор промптов...")
       schema:    fields.map(f => `${f.name}: ${f.describe}`)
       style:     styleBlock(styleResult)
       rules:     renderRules(rules, fields)         // only applicable to kind
       hints:     fields.map(f => expandMacros(template.hints[f.name] ?? f.describe))
       fewShot:   renderFewShot(template.fewShot)     // scene macro-expanded
       characters: renderCharactersBlock(chars)       // literal {{char}}/{{user}} kept as markers
       tail:      JSON_ONLY contract
     ].filter(Boolean).join('')
```

### 6.2 Pipeline simplifies to linear

```
runStage1:
  template     = resolveActiveTemplate()
  styleResult  = STYLE.resolve(template.style, { override: styleOverride })  // ONE call
  system       = buildSystemPrompt(template, chars, { styleResult })         // uses styleResult for style block
  user         = buildUserPrompt(msg)                                        // macros expanded
  raw          = await generatePromptText(system, user)
  draft        = parseDraft(raw)                                             // stage1-adapter → draft object
  prompt       = flatten(template, draft, { resolvedStyle: styleResult.styleString })  // deterministic, ordered
  → instruction { style, prompt, aspectRatio, imageSize, draft, kind }
```

`styleResult` is computed once and threaded through both `buildSystemPrompt` (for the style instruction block) and `flatten` (for the pinned/random/override overwrite — see §5.3). This keeps a single resolution point while making the resolved style available at flatten time without re-running the resolver.

No re-assembly step. `state.lastInstruction` set once.

### 6.3 Flatter — deterministic, fixed order per kind

Research confirms token order affects generation via cross-attention weighting. This justifies **fixing** the order per kind (not exposing it to the user): the research says order matters, not that a user should tune it blind. Flatter assembles the final string in the kind's fixed order:

```
manga order:    [style, camera, light, location, mood, characters, panels, speechBubbles]
cinematic order:[style, camera, characters, environment, light, location, mood]
illustration:   [style, camera, light, location, mood, characters]
photo:          [style, camera, characters, environment, light, mood]
```

`flattenOrder` is **no longer a template field** (removed from the model in §4). The order lives in `registry/kinds.js` as a read-only constant per kind. Users who need a different composition create a custom template from scratch with their own `fields` list, but the within-kind ordering stays fixed.

Each field emits its block via `field.flatten(value, ctx)`. The `style` field's `flatten` is where the §5.3 overwrite happens: if `ctx.resolvedStyle` is non-null (pinned/random/override), it returns `ctx.resolvedStyle`, ignoring `draft.style`; if null (llm-pick), it returns `draft.style` (the LLM-chosen string). The `characters` field guarantees each name goes first within its block (reference image triggering invariant) — same as v2 `charBlock`.

`wrapper.head` prepended, `wrapper.tail` appended (both macro-expanded). Apostrophe guard applied to the full body (JSON-safety for single-quote style wrappers).

---

## 7. Kind Presets (4 built-in templates)

Each preset is a pre-filled template. Users start from a preset and customize freely. `selfie` and `instagram` from the user's prompt examples are merged into a single `photo` kind — they shared identical fields (`style, camera, subject→characters, environment, light`) and differed only in wrapper boilerplate. `photo` carries both wrapper variants as a `wrapper.preset` select ('selfie' | 'instagram' | 'portrait'), applied at flatten time.

| Kind | Fields | Style catalog | wrapper.head | wrapper.tail |
|---|---|---|---|---|
| `manga` | style, camera, light, location, mood, characters, panels, speechBubbles | 12 manga art styles | "Vertical manga page, asymmetrical layout of [4-5] panels..." | "Adult 18+ fictional characters" |
| `cinematic` | style, camera, characters, environment, light, location, mood | 6 TV-show style formulas | "frozen production still captured on 35mm film — NOT CGI" | "natural skin texture, visible pores... film grain" |
| `illustration` | style, camera, light, location, mood, characters | 6 art styles (subset of manga) | — | — |
| `photo` | style, camera, characters, environment, light, mood | 5 phone-light formulas | wrapper.preset-select: 'selfie'→"phone selfie, front camera feel — not studio render" / 'instagram'→"social post aesthetic" | wrapper.preset-select: 'selfie'→"phone JPEG compression texture" / 'instagram'→(none) |

**Style catalogs per kind** (from user's prompt examples):
- manga → 12 styles (existing `STYLE_CATALOG_MANGA`)
- cinematic → 6 show-style formulas (existing `CINEMATIC_TEMPLATE_V2.style.catalog`)
- illustration → first 6 of manga catalog (existing `ILLUSTRATION_TEMPLATE_V2`)
- photo → 5 phone-light formulas (merged from user examples #4 + #5: home/bathroom/bedroom/outdoor-day/outdoor-night/together/cafe — union of the two former catalogs)

---

## 8. ST Macro Support

**Requirement:** every user-editable text field in a template supports SillyTavern macros.

| Field | Macro expansion | Mechanism |
|---|---|---|
| `fieldHints.*` | ✅ **NEW** (was not expanded in v2) | `expandMacros(hint)` during build |
| `style.pinned` | ✅ (after selection) | `resolveStyle` post-pick |
| `style.catalog` (elements) | ⚠️ pinned/random: expanded after pick. llm-pick: NOT expanded (intentional) | `resolveStyle` mode-dependent |
| `wrapper.head` | ✅ **NEW** | `expandMacros(head)` during flatten |
| `wrapper.tail` | ✅ **NEW** | `expandMacros(tail)` during flatten |
| `fewShot[*].scene` | ✅ **NEW** | `expandMacros(scene)` during build |
| `rules.*` (bannedWords etc.) | ❌ no (text filters, not prompt content) | — |
| User prompt (message) | ✅ (already) | `buildUserPrompt` |
| Characters block | ⚠️ literal `{{char}}`/`{{user}}` kept as role markers (intentional, unchanged) | `renderCharactersBlock` |

`expandMacros(text)` wraps `ctx.substituteParams` with a manual `{{char}}`/`{{user}}` fallback (same as existing `resolveSTMacros`). Kept as a named, injectable function for testability.

**Macro syntax (ST canon — separator is `::`, not `|`):**

Source: [SillyTavern Macros docs](https://docs.sillytavern.app/usage/core-concepts/macros). The recommended separator for macro arguments is `::` (double colon). A single `:` is legacy. The pipe `|` is **not** a macro separator — it is the STScript command separator, and macros containing `|` in arguments were broken until ST PR #5644 (issue #5618).

| Macro | Meaning | Example |
|---|---|---|
| `{{random::a::b::c}}` | Random selection (re-rolls each evaluation) | `{{random::warm::cool::neutral}}` |
| `{{pick::a::b::c}}` | Stable random selection (consistent per chat and position; reroll via `/reroll-pick`) | `{{pick::grain::clean::smooth}}` |
| `{{roll::1d20}}` | Dice roll using droll syntax | `{{roll::2d6+3}}` |
| `{{char}}` / `{{user}}` | Character / user name (case-insensitive) | literal — kept as marker in chars block |

> **Note:** earlier code and UI hints used `{{random::a|b}}` with a pipe `|` separator — this is **invalid** ST syntax. The v3 catalog is a plain JS array (no macro syntax), so this only matters in `style.pinned`, `fieldHints`, `wrapper`, and `fewShot.scene` — where users write macros by hand. The UI hint text (`tab-templates.js`) and tests (`style-resolver.test.js` fakeMacros) must be corrected to use `::`.

---

## 9. UI: Template Editor (two-level: Simple + Advanced)

The v2 editor exposed `rules` as a raw JSON textarea — the main UX pain. v3 fixes that, but must not over-correct into a wall of per-field controls. The editor is **two-level**: a Simple view (what 90% of users need) shown by default, and an Advanced section (per-field hints, custom fields, few-shot) collapsed behind a toggle.

### 9.1 "Шаблоны" tab — Simple view (default)

```
┌─ Шаблоны ──────────────────────────────────────────────────────┐
│ [+ Новый]  [Импорт]                                             │
│                                                                 │
│ ┌─ Манга-страница (активен) ───────────── [Копия] [Удалить] ─┐ │
│ │ Название: [Манга-страница___________________________]       │ │
│ │ Тип:       [manga ▼]      Соотношение: [9:16 ▼]   [2K ▼]   │ │
│ │                                                             │ │
│ │ ── Стиль ─────────────────────────────────────────────────  │ │
│ │ Режим: (●) LLM выбирает  ( ) Закреплён  ( ) Случайный       │ │
│ │ Каталог стилей (по одному в строке):                        │ │
│ │ ┌────────────────────────────────────────────────────────┐  │ │
│ │ │ Chainsaw Man manga art style, raw expressive...        │  │ │
│ │ │ Baroque oil painting on canvas aesthetic...             │  │ │
│ │ │ ... (12 строк)                                          │  │ │
│ │ └────────────────────────────────────────────────────────┘  │ │
│ │ Закреплённый стиль (для режима «Закреплён»):                │ │
│ │ [_______________________________________________________]   │ │
│ │                                                             │ │
│ │ ── Правила ───────────────────────────────────────────────  │ │
│ │ Панелей: [4] – [5]    Мин. крупных планов: [2]             │ │
│ │ Макс. персонажей в панели: [2]                              │ │
│ │ Запрещённые слова (через запятую):                          │ │
│ │ [naked, nude, penis, ...]                                   │ │
│ │ Разрешённые интимные дескрипторы (через запятую):           │ │
│ │ [unbuttoned shirt, ...]                                     │ │
│ │ Язык реплик: [Русский ▼]   Язык промпта: [English ▼]       │ │
│ │                                                             │ │
│ │ ▸ Дополнительно (подсказки полей, обёртка, few-shot)        │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 9.2 Advanced section (collapsed by default)

Expanding «Дополнительно» reveals:

**Per-field hints** — a list of `{field, hint}` textareas, one per field applicable to the kind. Each shows the field label and an editable hint textarea (macro-expanded — noted in UI). Unlike v2 where `fieldInstructions` was not editable, here it is. No order number, no toggle, no drag — the field's presence in the prompt is determined by the kind preset (fixed).

**Wrapper** — `wrapper.head` and `wrapper.tail` textareas. For `photo` kind, a `wrapper.preset` select ('selfie' | 'instagram' | 'portrait') instead of free text.

**Few-shot** — list of `{scene, result}` pairs; add/edit/delete. Scene is macro-expanded.

**Custom fields** — **[+ поле]** button opens a modal (name + label + hint). Custom fields appear in the per-field hints list and in the draft editor. They use the default text flatten (`name: value`). Structured custom fields are not supported (by design — if needed, join the built-in registry).

**What is NOT in the UI:**
- ❌ Field enable/disable toggles (fields are determined by kind preset).
- ❌ Field reordering / drag (order is fixed per kind, §6.3).
- ❌ `subject` field (removed — `characters` is the sole subject source).

### 9.3 Behavior

- All inputs are typed controls (number steppers, comma-list inputs, dropdowns) — **no raw JSON textarea** (the v2 pain point).
- Rules shown are kind-applicable only (manga → panel/closeup/char-per-panel + shared; cinematic → maxCharsCinematic + shared; illustration/photo → shared only).
- **Autosave** via debounced persist to localforage (same pattern as v2).
- Macro syntax hint under catalog/pinned/hint fields: `{{char}}, {{user}}, {{random::a::b}}, {{pick::key::a::b}}`.

### 9.4 "Генерация" tab — draft editor simplification

The structured draft editor (currently in Advanced) becomes more direct:
- Each draft field = its own input, only fields of the active kind shown.
- `characters` = cards (name, face, hair, clothing, action, gaze, emotion, traits) — the sole subject source.
- Live preview of the flattened final prompt (recomputed via `flatten` on input, debounced).
- Style override control stays (runtime override → goes through `resolveStyle`).

---

## 10. Module Architecture

### 10.1 New / changed files

| File | Status | Responsibility |
|---|---|---|
| `src/registry/fields.js` | **NEW** | Built-in field declarations (`defineField` registry) |
| `src/registry/kinds.js` | **NEW** | Kind presets (4 built-in templates: manga, cinematic, illustration, photo — each with pre-filled fields/catalog/wrapper) |
| `src/registry/resolve.js` | **NEW** | `resolveFields(template)` → ordered field list; `fieldsFor(kind, template)` |
| `src/prompt-builder.js` | **REWRITE** | `buildSystemPrompt` — single path over registry; `buildUserPrompt` (unchanged logic) |
| `src/prompt-schema.js` | **REWRITE** | `normalizeDraft` / `validateDraft` / `applyRules` — thin functions over registry |
| `src/prompt-flatter.js` | **REWRITE** | `flatten(template, draft)` — iterate `orderedFields`, call `field.flatten`; wrapper head/tail |
| `src/default-template.js` | **REWRITE** | Remove raw path + `DEFAULT_RAW_TEMPLATE`; export built-in v3 templates via `registry/kinds.js` |
| `src/style-resolver.js` | **MINOR** | Unchanged logic; wired into `STYLE.resolve()` in registry |
| `src/pipeline.js` | **SIMPLIFY** | Remove post-hoc re-assembly (`:111-118`); linear flow |
| `src/ui/tab-templates.js` | **REWRITE** | List + detail panel editor |
| `src/ui/tab-generate.js` | **MODIFY** | Draft editor driven by registry fields; live flatten preview |
| `src/prompt-templates.js` | **MODIFY** | Schema version 3 storage; remove v1→v2 migration |

### 10.2 Unchanged files

- `src/stage1-adapter.js` — universal parser stays; normalizes to draft object instead of `{style, prompt}`.
- `src/providers/*` — consume `instruction.{style, prompt, aspectRatio, imageSize}` unchanged.
- `src/image-api.js`, `src/text-api.js` — unchanged.
- `src/bundles.js`, `src/storage.js`, `src/connections.js` — unchanged.
- `src/events.js` — unchanged (triggers pipeline).

### 10.3 Data flow

```
bundle.templatesIds[0] → template (localforage)
template.kind → kind preset (registry/kinds.js) → default fields, catalog, wrapper
template.fields/customFields → overrides preset
registry/resolve.js → ordered field list
buildSystemPrompt(fields, styleResult, rules, hints, fewShot, chars) → system prompt
text-LLM → raw response
stage1-adapter → draft object (fields filled)
flatten(orderedFields, draft, styleResult) → final prompt string
→ instruction { style, prompt, aspectRatio, imageSize, draft, kind }
→ stage 2 (providers)
```

---

## 11. Error Handling

- **Style resolution failure** (empty pinned, empty catalog for random): emit warning block in system prompt ("СТИЛЬ: был задан, но пустой — выбери стиль сам"); `styleString=''`. Same as v2 behavior, preserved.
- **Field validation** (after parse): `validateDraft` returns `{ok, errors}`. If critical (no characters, panel count out of range), surface in UI as a warning banner; do not block generation (user can still proceed and edit). Same philosophy as v2.
- **Banned words**: `applyRules` strips them from all free-text fields. Same as v2.
- **Apostrophe guard**: applied to full flattened body. Same as v2.
- **Missing template**: fall back to default manga preset (same as v2 `defaultV2Content`).
- **Custom field with no flatten**: default text flatten (`name: value`); never crashes.

---

## 12. Testing

### 12.1 Pure modules (unit tests)

- `registry/fields.js`: each built-in field — `describe`, `validate`, `flatten` with sample values.
- `registry/resolve.js`: `resolveFields` for each kind; `fieldsFor` with overrides and custom fields; ordering.
- `registry/kinds.js`: each preset has valid shape, non-empty catalog, applicable fields only.
- `prompt-builder.js`: `buildSystemPrompt` for each kind — assert block order, style mode behavior (llm-pick emits raw catalog; pinned emits resolved string; random emits resolved string), macro expansion in hints/wrapper/fewShot.
- `prompt-schema.js`: `normalizeDraft` / `validateDraft` / `applyRules` per kind.
- `prompt-flatter.js`: `flatten` per kind — assert deterministic output, field order, wrapper head/tail, apostrophe guard, name-first in characters block.
- `style-resolver.js`: unchanged — existing tests still pass.

### 12.2 Integration

- `pipeline.runStage1`: end-to-end with a mock text-LLM returning a valid draft — assert no post-hoc re-assembly, single style resolution.
- Stage1-adapter → draft → flatten → instruction: round-trip for each kind.

### 12.3 Migration check

- schemaVersion 3 templates load correctly; v2 templates (if any linger) are flagged as incompatible (clean break — no auto-migration, user recreates).

---

## 13. Research Basis

This design is grounded in three sources:

1. **User's prompt examples** (`Примеры промптов для визуала.txt`) — toggle presets (manga, AI Netflix cinematic, selfie post, instagram, illustration) each with structured DESC blocks: CAMERA (~15 words), SUBJECT (~70-80 words), ENVIRONMENT (~50 words), LIGHT (~35-50 words). Style as a formula with genre tables. Name-first invariant for reference triggering. Non-human traits as practical prosthetics. The selfie and instagram presets map to a single `photo` kind (identical fields, differing wrapper only); the SUBJECT block maps to the `characters` field (not a separate `subject` field — see §3.5 rationale).

2. **Industry best practices** — all sources converge on the same skeleton: Subject → Environment → Camera → Lighting → Style → Parameters. Structured blocks beat freeform prose for reuse and refinement.

3. **Cross-attention research** ([Prompt-to-Prompt, ICLR 2023](https://prompt-to-prompt.github.io); [DAAM/attention saliency, arXiv:2403.04014](https://arxiv.org/html/2403.04014v1)) — token order affects generation via cross-attention weighting. Justifies deterministic, ordered flattening.

The Field Registry makes this skeleton explicit and maintainable: each slot (camera, light, characters, environment, style) is a first-class entity with its own describe/validate/flatten, rather than a string name scattered across four modules.
