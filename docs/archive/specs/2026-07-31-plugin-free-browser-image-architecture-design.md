# Plugin-Free Browser Image Architecture

## Status

Approved direction for implementation planning on 2026-07-31.

## Goal

Make UR Image Studio usable with one SillyTavern installation from multiple browsers, including Termux, without requiring the URIS server plugin. Persist shared non-secret state through SillyTavern, keep API keys local to each browser, generate into SillyTavern's native image gallery, and retain explicit provider/route behavior.

## Scope

This redesign covers image connections, model discovery, image generation, references, gallery persistence, exports, and migration from the current server-owned projection. Existing UI work remains in scope and should be preserved.

The URIS server plugin is no longer a required runtime dependency. Its code may remain in the repository temporarily for migration tests or optional legacy compatibility, but the normal client path must not require `/api/plugins/ur-image-studio/v1`.

## Persistence Model

### Shared SillyTavern extension settings

`extensionSettings[ur_image_studio]` is the source of truth for small JSON records shared by browsers using the same ST user:

- image connection metadata, excluding secrets;
- selected route and its versioned generation contract;
- bounded model catalog cache and discovery timestamps;
- prompt templates;
- image parameter presets;
- reference metadata and folders;
- gallery card metadata index;
- persistent UI preferences.

Only metadata belongs here. Do not store image bytes, data URLs, API keys, request controllers, or transient response bodies.

The user operates one browser at a time. Concurrent-write conflict resolution is explicitly out of scope.

### Chat metadata

`chatMetadata[uris_binding]` remains the source of truth for chat-scoped configuration and selected reference IDs. The existing schema-v4 contract is preserved.

### Native SillyTavern image storage

Generated and reference image bytes are uploaded through `/api/images/upload` into a dedicated ST-visible folder, for example `UR Image Studio`. The native gallery and `/api/images/list` are the file source of truth. URIS keeps a separate metadata index keyed by a stable card ID and image path.

The URIS gallery view joins native image files with its metadata index. Files added manually are valid gallery items with missing generation provenance. Deleted files are marked missing or pruned during reconciliation.

### Browser-local storage

localforage is retained only for browser-specific or transient data:

- API keys keyed by connection ID;
- drafts;
- prompt history and caches;
- pending request state;
- optional image thumbnail cache.

API keys are never written to extension settings, chat metadata, exports, or gallery metadata.

## Connection and Route Model

A connection contains endpoint and display/provider metadata. A selected catalog route is the authoritative generation choice. The adapter must never be selected again from a model-name regex after the route is saved.

A route uses a validated, versioned contract:

```js
{
  id,
  modelId,
  label,
  source,
  confidence,
  apiFamily,
  generationContract: 'openai-images' | 'gemini-native' | 'chat-completions' | 'openrouter-images',
  contractVersion: 1,
  capabilities: {
    generate: 'supported' | 'unsupported' | 'unknown',
    references: 'supported' | 'unsupported' | 'unknown',
    maxReferences: null,
    aspectRatios: null,
    imageSizes: null,
    qualityValues: null
  },
  transport: {
    bodyKind: 'json' | 'multipart',
    proxyEligible: true | false,
    directCors: 'required' | 'preferred'
  }
}
```

`generationContract` is a discriminated value interpreted by static adapter code. Catalog metadata may suggest a contract but must not provide executable URL templates, headers, JavaScript, or arbitrary request bodies.

Route identity is stable and route-scoped. Duplicate display model IDs from different sources or contracts remain distinct.

## Discovery

### Generic OpenAI-compatible endpoint

1. Normalize the user endpoint to its `/v1` base without duplicating version segments.
2. Perform one safe `GET /v1/models` request.
3. Retain the complete returned catalog, bounded to reasonable metadata size.
4. Classify likely image models for the default UI filter.
5. Preserve unknown models under `Show all` with unknown capabilities.
6. Let the user select a model and choose or confirm a generation contract.
7. Persist the selected route and contract.

Discovery never performs a paid generation.

### Gemini Native

Use Gemini's native model-list contract where available, preserve explicit `/v1` or `/v1beta` endpoint variants, and retain route metadata needed to form `generateContent` URLs.

### OpenRouter

OpenRouter is an explicit mode with its own catalog and generation adapter. It is not part of generic auto-detection and must not be probed against arbitrary user endpoints.

## Browser Transport

The transport is direct-first with SillyTavern proxy fallback only for JSON-compatible requests:

```text
direct fetch -> on browser CORS/network failure -> /proxy/:url
```

HTTP responses such as 400, 401, 429, and 500 are upstream results and must not trigger fallback. Abort and timeout are not CORS failures.

The built-in ST proxy does not support multipart bodies. OpenAI edits therefore require direct CORS. The UI must report this constraint rather than silently switching contracts or dropping references.

Each route exposes transport feasibility separately from provider capability:

- discoverable;
- generatable from this browser;
- references-generatable from this browser.

## Provider Adapters

The client owns static adapters and normalizes their output to one result shape:

```js
{ kind: 'dataUrl', value, mimeType?, revisedPrompt?, providerMetadata? }
```

Canonical input remains provider-neutral: prompt, aspect ratio, image size, quality, ordered references, connection metadata, and a request ID.

Adapters required:

- `openai-images`: JSON generations; multipart edits for references;
- `gemini-native`: `generateContent` with ordered `inlineData` parts;
- `chat-completions`: multimodal `messages[].content` and documented image response variants including `choices[0].message.images[]`;
- `openrouter-images`: OpenRouter-specific catalog, request, reference, and response rules.

Adapters select their wire format from the saved route contract. They do not retry a paid generation through another adapter or contract.

## Gallery Cards

Each successful generation uploads its image to the native ST image folder and writes a full metadata card into the shared gallery index:

```js
{
  id,
  imagePath,
  prompt,
  negativePrompt,
  connectionId,
  routeId,
  modelId,
  generationContract,
  aspectRatio,
  imageSize,
  quality,
  referenceIds,
  createdAt,
  status: 'ready' | 'missing'
}
```

The card is recoverable from another browser except for the API key. A card can be opened, inspected, regenerated after entering its connection key, or saved as a reference without duplicating image bytes.

## Requests and Recovery

Before a paid request, store a local pending record. Use states `notStarted`, `dispatchingUnknown`, `resultReceived`, and `ready`. Safe discovery and result downloads may retry. A paid generation POST must not be automatically retried after an ambiguous timeout or browser interruption. There is no promise of server journal recovery or at-most-once enforcement after browser loss.

## Export and Migration

Export includes shared extension settings, safe local data, chat metadata, connection metadata, route contracts, and gallery cards. It excludes API keys and transient request state.

Migration from current server projections preserves connection IDs, endpoint, model/route metadata, capabilities, reference policy, and contract data where available. Server secret IDs, journal state, artifacts, and plugin-only fields are discarded. Each browser must receive its API key manually.

## Preserved UI Work

Keep current cards, accordion state, connection form, model selector, folder editor and colors, mobile reference search, role tiles, save/preview layout, responsive fixes, generation drafts, reference selection, and schema-v4 chat configuration. Replace only the persistence and transport boundaries behind them.

## Explicitly Removed Guarantees

Without the plugin, URIS no longer guarantees:

- server-owned secrets;
- server-side SSRF/DNS policy;
- universal multipart proxying;
- durable request journal and cross-browser request recovery;
- server-enforced at-most-once paid submission;
- server-side download of CORS-restricted result URLs;
- conflict-free simultaneous settings writes.

These are documented limitations, not hidden fallback behavior.
