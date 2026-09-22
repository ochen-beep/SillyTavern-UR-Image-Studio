# UR Image Studio

A [SillyTavern](https://docs.sillytavern.app/) extension that generates images from the current chat scene. A text LLM first distills the recent posts into an image prompt (Stage 1), then an image model renders it (Stage 2) — or skip Stage 1 and write the prompt yourself. The chat text is never modified: images land in the extension gallery, and inline previews can appear under the posts that requested them.

**English** · [Русский](USER_GUIDE.md) ЗАЛЕТАЙ :)

> This extension interacts with [SillyTavern](https://github.com/SillyTavern/SillyTavern) through its public extension and user-files APIs and contains no SillyTavern code.

## Features

- Two-stage pipeline: a scene-first image prompt built from the chat by a text LLM, then image generation — plus a manual mode where only your prompt is used.
- Image sources (browser-side connections): OpenAI Images (DALL·E / gpt-image), Gemini native, OpenRouter Images, image-capable Chat Completions gateways (both the OpenRouter-style `image_config` and the `new-api` `extra_body` dialect used by most relay gateways), Pollinations, Naistera.
- Stage 1 sources: a Connection Manager profile (routed through the ST server — no CORS hassle) or a custom OpenAI-compatible / Gemini endpoint.
- Reference images: a pool with folders and chat binding, batch upload, crop, per-generation send mode, and provider reference caps.
- Gallery: images are stored in SillyTavern's native gallery with a server-side metadata index; a full-screen viewer (PhotoSwipe) with crop, "send to references" and copy actions.
- Inline engine: `[[тип: описание]]` markers in posts become images — automatic mode with a queue cap, a manual camera button on every post, live pending/error shells, and the shared viewer for results.
- Studio scope: generate on the welcome screen with no chat open; the studio keeps its own config, reference binding and gallery provenance.
- Prompt templates (Stage 1 instructions) and parameter presets, stored server-side.
- External bridge (experimental): `globalThis.URIS` lets other extensions run URIS generations headlessly; all automatic jobs (inline + bridge) share one serialized lane, so only one paid request runs at a time.
- Completion notifications: short synthesized tones via Web Audio — no audio assets, nothing to upload.
- Storage: image metadata, templates, presets and the gallery index live in server-side user files, not in `settings.json`; the export/import dump strips API keys and secrets by design.
- Diagnostics: a rolling network dump (last 200 requests), a persistent event log, a browser-side error pool, and a one-click diagnostic export that never contains prompts, keys, or raw responses.
- A floating desktop window (drag, resize, wheel-scrollable tab bar) and a full-screen mobile layout.

## Requirements

- SillyTavern **1.19.0** — developed and tested against this version.
- A Stage 2 source: any supported image endpoint (each needs its own key/token; Pollinations requires an `sk_` access token).
- A Stage 1 source: a Connection Manager profile or a custom text endpoint.

## Installation

### From a git repository

> Repository URL: **https://github.com/ochen-beep/SillyTavern-UR-Image-Studio**

1. Open **Extensions → Manage Extensions** in SillyTavern.
2. Paste the repository URL into the *Install extension* field and press **Install**.
3. Reload SillyTavern and make sure **UR Image Studio** is enabled in the extensions list.

### Manual

1. Copy the release package contents (`manifest.json`, `index.js`, `style.css`, `src/`, `USER_GUIDE.md`) into a new folder under `data/<user-handle>/extensions/`.
2. Restart SillyTavern, then enable **UR Image Studio** in **Manage Extensions**.

### First-time setup

1. Click the floating launcher button to open the studio window.
2. On the **API** tab, add an image connection (pick the contract that matches your endpoint, fill in URL and key) and choose the Stage 1 source — a Connection Manager **profile** or a **custom** endpoint.
3. On the **Generate** tab, press the button: in the default mode Stage 1 builds the prompt from the chat, Stage 2 renders it, and the result appears in the **Gallery**.

## Usage

- The floating launcher button opens the studio window (position is remembered; on mobile the studio takes the full screen). Generation progress pulses right on the launcher.
- The launch mode dropdown on the Generate tab: **manual** uses only your prompt; **build prompt** runs Stage 1 and lets you edit the result before paying for Stage 2; **full pipeline** does both in one click.
- Aspect ratio ("Стороны"), size, quality, model, template and parameter presets are per-chat settings; the studio (welcome screen) keeps a separate set.
- Inline: write `[[img: ...]]` / `[[селфи: ...]]` in a post (or let the model write them) and the engine renders an image shell in place. The camera button in a post's menu generates an image for that post manually. Trigger profiles (type names, aliases, aspect ratio) are editable in settings.
- References: bind a folder to the chat and matched references are attached to generations automatically; the send mode (auto / always / never) is per connection.
- Gallery: the viewer opens from gallery cards and inline previews alike and offers crop (with a reference mode), "send to references", copy, and delete.
- Templates: Stage 1 instruction templates are editable on the Templates tab and stored server-side, so they survive reloads and follow your ST data directory.
- Export/import of browser-local data (without API keys and the gallery) and the diagnostic dump live in **Settings → Данные и диагностика**.

A detailed walkthrough — in Russian, with connections, inline markers and all the nuances — lives in [USER_GUIDE.md](USER_GUIDE.md).

## Compatibility notes

- Browser-side image requests need either a CORS-permissive endpoint or the SillyTavern CORS proxy. The connection's delivery setting is **auto** by default: direct first, proxy on a CORS block. See `docs/cors-proxy-setup.md`.
- Stopping a generation that is delivered through the ST proxy cancels only the wait: the provider keeps processing and may bill the request (the proxy does not forward cancellation).
- Chat Completions gateways ignore aspect ratio/size unless the correct dialect is selected: OpenRouter documents a top-level `image_config`, while new-api relays (most gateways) silently ignore it and only forward `extra_body.google.image_config`. Without the right dialect the gateway quietly returns its default format — URIS warns about dropped parameters and, after the image arrives, verifies that the actual pixels match the request.
- Stage 1 via a Connection Manager profile is the most robust option behind proxies and non-CORS endpoints; custom endpoints depend on the provider allowing direct browser calls. A custom-endpoint request is never re-sent automatically after an ambiguous failure: before the first request the extension probes the host's model list to pick the delivery path, and if a paid request still dies behind a possible CORS mask it surfaces a clear error and the next attempt goes through the ST proxy.

---

### Технические детали для тех кому интересно

#### Two-stage pipeline

Stage 1 (`src/text-api.js`) calls the text LLM with a template-built instruction plus the chat scene block and returns the image prompt; Stage 2 (`src/dispatch-plan.js` → `src/providers/*`) materializes it. Every generation runs as a draft (`src/generation-drafts.js`) with an epoch guard, so chat switches and cancellation cannot mix results between runs. Retries with backoff wrap both stages.

#### Image connections and contracts

A connection states its contract explicitly (`src/image-connection-schema.js`): `openai-images`, `gemini-native`, `openrouter-images`, `chat-completions` (with the optional `image_config` dialect), `pollinations-images`, `naistera`. A model name does not prove a protocol: the same model can want multipart on one gateway and JSON on another, so the edits protocol is stated per connection too. The probe (`Проверить`) records what the endpoint actually supports; capability facts (`src/capability-observer.js`) turn "model rejected the request" into human-readable constraints instead of generic errors. Secret fields are stripped from every export and dump.

#### Storage

Image metadata, templates, parameter presets, references and the studio config live in server-side user files (`uris_gallery.json`, `uris_studio.json`, …) behind the shared file-store machinery (`src/file-store.js`), which keeps `settings.json` small — ST re-uploads the whole settings object on every unrelated change. Actual image files live in SillyTavern's native gallery. Browser-local keys (API keys, browser-side stores) stay in localforage and never enter exports. On first load the studio copies any browser-side data into the server files.

#### Inline engine

`src/inline/` is split into a pure grammar (`[[тип: описание]]` markers, code-fence aware, ReDoS-safe), trigger profiles (per-type aspect, prefix/suffix, references policy), an event scanner, a runner (plans and caps paid jobs, auto mode only), and a render layer that reconciles DOM shells with job states across chat switches and cancellations. Automatic inline jobs and bridge calls share the autolane (`src/autolane.js`): one automatic paid request at a time; manual generations keep their own lane.

#### External bridge

`globalThis.URIS` (`src/bridge.js`) is a facade, not a public import surface: `generate / abort / getStatus / listConnections / on / off / ready / parseInline`. Bridge generations go through the same pipeline, recovery records, diagnostics and Stop button as manual ones. The Bridge tab hosts Stage 1 / Generation labs for testing consumer integrations.

#### Diagnostics

The network dump records the last 50 extension requests — metadata only (scrubbed URLs, statuses, timings, header names, body sizes; no prompts or bodies) — and is exported separately. The event log survives reloads and contains only metadata: timestamps, stages, generations, errors. The diagnostic export never includes scene text, prompts, API keys, or raw responses.

#### Development

```bash
npm test              # node --test across tests/!(server-*)*.test.js
npm run test:server   # server-line tests; expected red until the server plugin ships
```

The test runtime needs no jsdom: `tests/fake-dom.js` stubs the minimum DOM surface for the pure modules. A server-plugin variant (generation executed by a SillyTavern server plugin) was explored early on but abandoned — the CORS problem it targeted is solved cheaper by direct browser routes with an ST CORS-proxy fallback, so no server-side code ships with the extension. `docs/runbooks/2026-09-14-dev-deploy-workflow.md` describes the two-tree dev/deploy workflow.

#### Project structure

- `index.js` — entry point: lifecycle hooks + orchestration.
- `src/core.js` — state, settings, logging, fetch with timeout/retry.
- `src/pipeline*.js`, `src/dispatch-plan.js` — Stage 1/Stage 2 orchestration and provider dispatch.
- `src/providers/` — one adapter per image contract plus the text LLM adapters.
- `src/refs-library.js`, `src/gallery-index.js`, `src/param-presets.js`, `src/prompt-templates.js`, `src/studio-scope.js` — server-file stores and their domain logic.
- `src/file-store.js`, `src/store-migration.js` — shared user-files machinery and legacy migration.
- `src/inline/` — the inline engine (grammar, triggers, scanner, runner, render, store).
- `src/bridge.js`, `src/autolane.js` — external facade and the automatic-jobs lane.
- `src/ui/` — floating window, tabs (API, References, Generate, Gallery, Templates, Media, Bridge, Settings), viewer, launcher.
- `docs/` — changelog, provider contract notes, plans, runbooks.

#### Packaging

The user-facing package contains only: `manifest.json`, `index.js`, `style.css`, `src/`, `USER_GUIDE.md`.

**Exclude when exporting:** `docs/`, `tests/`, `node_modules/`, `package.json`, `README.md` (optional).
