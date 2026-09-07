# UR Image Studio: server-side image API connections

**Date:** 2026-07-27  
**Status:** Proposed  
**Scope:** API-key connections for OpenAI Images, Gemini Native, and OpenRouter Images

## 1. Summary

UR Image Studio will keep its existing prompt, scene, reference, queue, recovery, and gallery pipeline. Only the provider-facing connection and HTTP execution layer will change.

The normal user flow is:

1. Enter a name, API address, and API key.
2. Click **Connect and load models**.
3. Select an image model from one merged list.
4. Save the connection.
5. Generate through the existing Stage 2 workflow.

The user does not need to understand adapters, API families, request formats, CORS, multipart bodies, or the server plugin.

The first version supports three API families:

- OpenAI Images;
- Gemini Native image generation;
- OpenRouter Images.

These cover direct services and compatible API proxies such as LinkAPI that expose GPT Image and Gemini Image through standard upstream contracts.

The server plugin is mandatory for these three families. There is no browser fallback. Existing Agnes and Pollinations connections remain on their current legacy path and are outside this migration.

## 2. Goals

The implementation must:

- make `endpoint + API key + model` the normal user-facing setup;
- load GPT Image, Gemini Image, and OpenRouter image models through one button;
- support one endpoint exposing several API families, as LinkAPI does;
- select the correct request format for the selected model route;
- generate without references and edit/generate with references where supported;
- remove migrated API keys from browser storage only after confirmed server persistence;
- eliminate browser CORS/proxy decisions for the three new adapters;
- preserve Stage 1, Stage 2, drafts, queueing, recovery, and gallery behavior;
- preserve a provider result if the server receives it but the browser response is interrupted;
- return precise user-facing errors without automatically repeating paid requests;
- remain small enough to implement without becoming a universal provider framework.

## 3. Non-goals

The first version does not include:

- arbitrary custom HTTP profiles or a request-template DSL;
- dynamic adapters installed through the UI;
- user-supplied JavaScript;
- Replicate, fal.ai, Stability, BFL, Bedrock, Vertex AI, or Azure Foundry;
- generic asynchronous provider-job polling;
- OAuth, AWS SigV4, service-account, or cloud control-plane authentication;
- OpenAI Chat Completions as an inferred fallback for GPT or Gemini image requests;
- paid protocol probing or fallback during generation;
- a separate model-profile subsystem;
- migrating Agnes or Pollinations to the server path;
- browser fallback for OpenAI Images, Gemini Native, or OpenRouter Images;
- solving existing duplication of full reference data URLs in Stage 2 snapshots.

## 4. Design principles

1. **Simple UI, explicit internals.** Technical routing exists in backend data but is hidden from the normal form.
2. **One server source of truth.** The server owns metadata, selected route, catalog, and secret for migrated connections.
3. **Stable connection identity.** Migration preserves the existing connection ID so chat bindings do not need rewriting.
4. **One model, one chosen route.** API routing belongs to a catalog route, not to the connection as a whole.
5. **Read-only discovery.** Detection may issue catalog requests but never a paid image request.
6. **One paid submission.** A timeout or ambiguous response never triggers another adapter automatically.
7. **Durable request identity.** A client `requestId` identifies one paid submission and supports result recovery without resubmission.
8. **No silent reference loss.** Server-backed requests reject unsupported or excessive references before calling upstream.
9. **Preserve the working pipeline.** Prompt creation, logical reference resolution, queueing, and gallery finalization remain client-side.
10. **Conservative capabilities.** `unknown` is distinct from `supported` and `unsupported`.
11. **Only proven abstractions.** Three static adapters and one coordinator are sufficient.

## 5. User experience

### 5.1 Connection form

The normal form contains:

```text
Name
[ LinkAPI                              ]

API address
[ https://api.linkapi.ai               ]

API key
[ ------------------------------------ ]

[ Connect and load models ]
```

After a successful probe:

```text
Model
[ gemini-3.1-flash-image             v ]

Updated recently                         [ Refresh ]

[ Save ]
```

The normal UI does not show:

- adapter names;
- catalog paths;
- auth headers;
- request encodings;
- reference transport protocols;
- server journal states;
- CORS or proxy controls.

### 5.2 Advanced recovery control

A collapsed **Advanced settings** section contains one override:

```text
API mode
(*) Automatic
( ) OpenAI Images
( ) Gemini
( ) OpenRouter Images
```

Internal values:

```text
auto
openai-images
gemini-native
openrouter-images
```

The override is only a recovery mechanism for nonstandard proxies. Custom paths and payload mappings are not exposed.

### 5.3 Server availability

The server-backed form is disabled if the plugin is absent or incompatible. The UI shows:

```text
The UR Image Studio connection component is unavailable.
Check the server plugin installation in SillyTavern.
```

The UI does not save a server-backed connection that cannot later generate. Legacy Agnes and Pollinations cards continue using their existing behavior.

## 6. Architecture

```text
SillyTavern extension
    |
    | same-origin /api/plugins/ur-image-studio/v1/*
    v
UR Image Studio server plugin
    |
    +-- Connection service
    |     +-- per-user metadata
    |     +-- SillyTavern SecretManager
    |     +-- catalog cache
    |
    +-- Probe coordinator
    |     +-- OpenAI Images adapter
    |     +-- Gemini Native adapter
    |     +-- OpenRouter Images adapter
    |
    +-- Generation service
    |     +-- request journal
    |     +-- route resolution
    |     +-- capability validation
    |     +-- upstream request
    |     +-- result materialization
    |
    +-- Safe outbound HTTP client
          |
          v
    Provider or API proxy
```

### 6.1 Client responsibilities

The SillyTavern extension continues to own:

- Stage 1 prompt generation;
- templates and scene planning;
- logical reference selection and semantic roles;
- generation drafts and immutable Stage 2 snapshots;
- per-message serialization and queue UI;
- active connection IDs in chat metadata;
- client recovery records;
- gallery finalization and regeneration;
- user-visible progress and errors.

The client sends only the final prompt, image settings, and selected references. It does not send the whole chat or character objects to the plugin.

### 6.2 Server responsibilities

The server plugin owns:

- metadata for the three server-backed families;
- API key persistence and auth construction;
- endpoint normalization and destination validation;
- model discovery and catalog caching;
- API-family classification per model route;
- JSON and multipart request serialization;
- reference capability validation;
- timeout and abort propagation;
- response parsing and MIME validation;
- downloading temporary provider URLs;
- a bounded durable request/result journal;
- redacted diagnostics.

### 6.3 Client transition boundary

`src/image-api.js` remains the client transition point. For a server-owned connection it calls the plugin instead of the browser provider registry.

The final Stage 2 result remains:

```js
{ kind: 'dataUrl', value: 'data:image/png;base64,...' }
```

Legacy providers may still return `{kind: 'url'}`. Server-backed adapters materialize upstream URL/base64/binary results into a server artifact and then return a data URL to preserve the existing gallery contract.

## 7. Concrete SillyTavern integration and storage

### 7.1 Plugin mount and middleware

The server plugin declares:

```js
export const info = {
  id: 'ur-image-studio',
  name: 'UR Image Studio',
  description: 'Server execution for UR Image Studio image APIs'
};
```

SillyTavern mounts its router at:

```text
/api/plugins/ur-image-studio
```

The plugin registers all versioned routes below `/v1`. Existing SillyTavern middleware supplies authenticated `req.user`, CSRF protection, and login enforcement before plugin routes.

### 7.2 Per-user metadata directory

For each request, plugin state is under:

```text
<req.user.directories.root>/plugins/ur-image-studio/
```

Files:

```text
connections.json
requests.json
artifacts/<requestId>.<ext>
```

`connections.json` and `requests.json` are atomically replaced with `write-file-atomic`. Read-modify-write operations are serialized by an in-process mutex keyed by `req.user.directories.root` to prevent lost updates in the normal single-process SillyTavern deployment.

Cross-file operations use durable operation markers in `operations.json`. Each create, key rotation, and delete records its intent and old/new resource IDs before the first side effect, advances a commit phase after each durable step, and removes the marker only after completion. On plugin startup, reconciliation completes or compensates unfinished operations:

- uncommitted create: remove orphan new secret and provisional metadata;
- uncommitted key rotation: keep the old committed secret active and remove an unreferenced new secret, or finish metadata commit when it was already durably selected;
- delete: a tombstoned connection is hidden immediately, then secret, journal rows, and artifacts are removed idempotently until cleanup completes.

The connection metadata record is the authority for which secret ID is active. Reconciliation never deletes a secret still referenced by committed metadata.

On POSIX the directory uses mode `0700` and files use `0600`. On Windows security follows the ACL of the SillyTavern data root; the plugin does not claim encryption at rest.

### 7.3 Secret storage

The plugin imports SillyTavern's server-side `SecretManager` from `src/endpoints/secrets.js`, pinned to supported SillyTavern releases by integration tests.

One namespaced secret key is used:

```text
ur_image_studio.connection_api_secret
```

Each connection stores the `secretId` returned by:

```js
new SecretManager(req.user.directories)
  .writeSecret(secretKey, apiKey, connectionLabel)
```

Generation reads the exact value by secret ID on the server. The browser never calls `/api/secrets/find`, and `allowKeysExposure` remains `false`.

Secrets are plaintext in SillyTavern's per-user `secrets.json`, matching SillyTavern's existing secret-storage model. They are protected by server filesystem access, not application-level encryption.

## 8. Server API

All routes are under:

```text
/api/plugins/ur-image-studio/v1
```

### 8.1 Status

```http
GET /status
```

Response:

```js
{
  ok: true,
  apiVersion: 1,
  features: {
    connections: true,
    discovery: true,
    generation: true,
    requestRecovery: true
  },
  apiFamilies: [
    'openai-images',
    'gemini-native',
    'openrouter-images'
  ]
}
```

### 8.2 Transient connection probe

```http
POST /connections/probe
Content-Type: application/json
```

Request:

```js
{
  endpoint: 'https://api.linkapi.ai',
  apiKey: 'sk-...',
  apiFamilyOverride: 'auto'
}
```

This endpoint is read-only with respect to durable plugin state:

- it does not create a connection;
- it does not write a secret;
- it does not replace an existing catalog;
- it never calls a paid endpoint.

It returns a transient catalog:

```js
{
  ok: true,
  normalizedEndpoint: 'https://api.linkapi.ai',
  routes: [],
  warnings: []
}
```

The API key exists only for the request lifetime and is redacted from diagnostics. The client keeps its input value in form memory until **Save**; it is not persisted in localforage for a new connection.

### 8.3 Probe an existing connection

```http
POST /connections/{connectionId}/probe
```

The plugin uses the stored endpoint and secret. A successful result replaces the cached catalog atomically. A failed refresh preserves the previous catalog and returns it as stale where available.

### 8.4 Create connection

```http
POST /connections
Content-Type: application/json
```

Request:

```js
{
  id: 'client-generated-stable-id',
  name: 'LinkAPI',
  endpoint: 'https://api.linkapi.ai',
  apiKey: 'sk-...',
  modelRoute: {
    routeId: 'route-id',
    modelId: 'gemini-3.1-flash-image',
    apiFamily: 'gemini-native'
  },
  apiFamilyOverride: 'auto',
  timeoutMs: 300000
}
```

The server validates a catalog route against a fresh or recently returned probe result. A `source: 'manual'` route is the explicit exception: it is validated structurally, requires a non-`auto` API mode matching `modelRoute.apiFamily`, and is stored as part of the connection's catalog snapshot.

Create is atomic from the API perspective:

1. validate all metadata and destination rules;
2. write the new secret;
3. atomically write connection metadata and catalog snapshot;
4. return the safe projection;
5. if metadata write fails, delete the newly written secret before returning failure.

The caller-supplied ID must match the existing URIS ID format and must not collide with another server connection. This permits migration without changing chat bindings.

### 8.5 Update connection and rotate key

```http
PUT /connections/{connectionId}
```

Editable fields:

```js
{
  name: 'LinkAPI',
  endpoint: 'https://api.linkapi.ai',
  apiKey: 'optional-new-key',
  modelRoute: { routeId, modelId, apiFamily },
  apiFamilyOverride: 'auto',
  timeoutMs: 300000
}
```

When rotating a key, the plugin writes the new secret first, commits metadata with the new ID, verifies the safe projection, then deletes the old secret. On any pre-commit failure, the old connection and secret remain active.

### 8.6 Manual model route

If the API has no usable catalog, the advanced form may save:

```js
{
  modelRoute: {
    routeId: 'manual:<apiFamily>:<modelId-hash>',
    modelId: 'vendor-image-model',
    apiFamily: 'gemini-native',
    source: 'manual',
    confidence: 'manual',
    capabilities: {
      generate: 'supported',
      references: 'unknown',
      maxReferences: null
    }
  }
}
```

Manual model entry requires an explicit API mode. It is invalid while the mode remains `auto` because the server cannot choose a request contract safely.

### 8.7 List and delete connections

```http
GET /connections
DELETE /connections/{connectionId}
```

List returns safe projections only. Delete removes metadata, catalog, secret, journal entries, and artifacts owned solely by that connection. Chat bindings referring to the deleted stable ID resolve as missing.

### 8.8 Submit or resume generation

```http
POST /generate
Content-Type: application/json
```

Request:

```js
{
  requestId: 'client-uuid',
  connectionId: 'connection-id',
  prompt: '...',
  aspectRatio: '16:9',
  imageSize: '2K',
  quality: 'high',
  references: [{
    id: 'character-alice',
    role: 'character',
    name: 'Alice',
    dataUrl: 'data:image/webp;base64,...'
  }]
}
```

`requestId` is idempotent within the current SillyTavern user scope. Generation uses a per-user, per-request single-flight lock held from journal claim through final state, so concurrent calls cannot open two upstream requests.

Crash semantics are deliberately conservative:

- the first call creates `claimed` before any network work;
- immediately before writing any upstream request bytes, it durably changes state to `dispatching`;
- after `dispatching`, restart or transport ambiguity never causes automatic resubmission;
- only an in-process failure proven to occur before `dispatching` may return the entry to `not-dispatched`;
- providers with a documented idempotency key or request lookup may refine recovery later, but the MVP does not assume either.

Therefore:

- a repeated ID with identical fingerprint returns stored state or joins the active single-flight operation;
- a repeated ID with a different fingerprint returns `REQUEST_ID_CONFLICT`;
- a stored success never submits again;
- `dispatching` found after restart becomes `failed-ambiguous` unless a persisted provider result or documented provider request lookup proves completion.

Successful response:

```js
{
  requestId: 'client-uuid',
  state: 'ready',
  result: {
    kind: 'dataUrl',
    value: 'data:image/png;base64,...',
    mimeType: 'image/png'
  },
  diagnosticsId: 'trace-id'
}
```

Ambiguous response recovered from the journal:

```js
{
  requestId: 'client-uuid',
  state: 'failed-ambiguous',
  error: {
    code: 'UPSTREAM_RESULT_UNKNOWN',
    message: 'The provider may have accepted the request. It was not submitted again.'
  }
}
```

### 8.9 Query request state

```http
GET /requests/{requestId}
```

Returns the same safe state/result envelope as `/generate`, without submitting upstream work.

## 9. Connection, route, and catalog data

### 9.1 Server connection

```js
{
  schemaVersion: 1,
  id: 'stable-connection-id',
  name: 'LinkAPI',
  endpoint: 'https://api.linkapi.ai',
  modelRouteId: 'route-id',
  apiFamilyOverride: 'auto',
  secretId: 'opaque-secret-id',
  timeoutMs: 300000,
  createdAt: '...',
  updatedAt: '...'
}
```

The endpoint is normalized while preserving a necessary custom subpath. Query, fragment, and embedded credentials are rejected. Version-path handling is adapter-specific; no shared function blindly removes `/v1` or appends `/v1beta`.

### 9.2 Model route

A route is unique by API family, model ID, and catalog source:

```js
{
  id: 'stable-route-id',
  modelId: 'gemini-3.1-flash-image',
  label: 'gemini-3.1-flash-image',
  apiFamily: 'gemini-native',
  source: 'gemini-models',
  confidence: 'high',
  capabilities: {
    generate: 'supported',
    references: 'supported',
    maxReferences: 4,
    aspectRatios: ['1:1', '16:9', '9:16'],
    imageSizes: ['1K', '2K', '4K'],
    qualityValues: []
  },
  remoteMetadata: {},
  fetchedAt: '...'
}
```

Capability values are:

```text
supported
unsupported
unknown
```

Remote metadata is sanitized and size-limited.

### 9.3 Duplicate display IDs

The same model ID may have distinct routes. The UI may group routes when one preference is unambiguous, but selection persists the exact route ID.

Preference order:

1. explicit API-mode override;
2. specialized catalog metadata;
3. catalog source;
4. known image model family;
5. conservative adapter default.

For a LinkAPI-style endpoint:

- `gpt-image-*` prefers `openai-images`;
- `gemini-*-image*` prefers `gemini-native`;
- routes from OpenRouter's dedicated image catalog use `openrouter-images`.

A hostname rule may enable a documented LinkAPI catalog enrichment, but it is never the sole route decision.

## 10. Probe coordinator

The public use case is one `probeConnection()` operation. Internally:

```js
const adapters = [
  openAIImagesAdapter,
  geminiNativeAdapter,
  openRouterImagesAdapter
];
```

Conceptual interface:

```js
interface ImageAdapter {
  apiFamily: string;
  probe(context): Promise<ProbeResult>;
  generate(context, modelRoute, request): Promise<AdapterResult>;
}
```

The coordinator uses `Promise.allSettled()` semantics so one failed catalog does not hide another family.

It:

1. validates endpoint syntax and destination policy;
2. runs only the selected adapter when an override is set;
3. otherwise runs all applicable read-only probes;
4. merges routes without collapsing API families;
5. filters text-only models only when reliable metadata exists;
6. permits manual model entry when no catalog is available;
7. returns partial failures as warnings;
8. writes a catalog only through an existing-connection refresh or connection commit.

No probe calls generation, edit, Chat Completions, Responses, or another paid endpoint.

## 11. Adapter contracts

### 11.1 OpenAI Images

Operations:

```text
GET  {openaiBase}/models
POST {openaiBase}/images/generations
POST {openaiBase}/images/edits
```

For a bare origin, `openaiBase` defaults to `{origin}/v1`. If the supplied endpoint already ends in `/v1`, it remains unchanged. A custom path ending in `/v1` is preserved.

Authentication:

```http
Authorization: Bearer <secret>
```

Generation uses JSON. Editing uses multipart with repeated canonical `image` fields.

The adapter owns GPT Image parameter mapping:

- valid quality values;
- supported dimensions or `auto`;
- `output_format` for GPT Image instead of legacy `response_format`;
- omission of unsupported fields, including model-specific `input_fidelity`;
- reference limits known for implemented routes.

Accepted response variants:

- `data[0].b64_json`;
- `data[0].url`;
- raw image bytes;
- compatibility top-level URL, recorded as a diagnostic warning.

There is no Chat Completions fallback.

### 11.2 Gemini Native

Operations:

```text
GET  {geminiBase}/models
POST {geminiBase}/models/{model}:generateContent
```

`geminiBase` is a concrete versioned base discovered from one of:

```text
{origin}/v1
{origin}/v1beta
```

If the supplied endpoint already ends in `/v1` or `/v1beta`, that exact version is probed first and is never duplicated. A custom gateway subpath is preserved.

Auth strategies:

1. `x-goog-api-key` for native Google-compatible APIs;
2. query `key` for the documented LinkAPI native Gemini route when header auth is rejected;
3. no generic Bearer guess.

References use Gemini inline image parts. Semantic ordering is preserved and the existing role guide may be appended to prompt text.

The parser accepts camelCase and REST snake_case image parts and records finish reason and prompt feedback when no image is returned.

### 11.3 OpenRouter Images

Operations:

```text
GET  https://openrouter.ai/api/v1/images/models
GET  https://openrouter.ai/api/v1/images/models/{author}/{slug}/endpoints
POST https://openrouter.ai/api/v1/images
```

Authentication:

```http
Authorization: Bearer <secret>
```

The generate request uses the dedicated OpenRouter Images contract:

```js
{
  model: 'author/model',
  prompt: '...',
  n: 1,
  resolution: '2K',
  aspect_ratio: '16:9',
  quality: 'high',
  input_references: [{
    type: 'image_url',
    image_url: { url: 'data:image/webp;base64,...' }
  }]
}
```

Only parameters reported by model or endpoint capability descriptors are sent. Buffered image output is read from:

```js
{
  data: [{
    b64_json: '...',
    media_type: 'image/png'
  }]
}
```

Streaming exists upstream but is not used in this MVP. OpenRouter Chat Completions remains a separate valid API and is intentionally not used by this adapter.

## 12. Reference handling

Logical reference selection remains provider-independent.

The client continues to materialize and compress selected references before `/generate`. The server independently enforces:

- accepted MIME types;
- decoded size per image;
- total request size;
- maximum reference count;
- valid data URL encoding.

For server-backed routes:

- `supported`: send references;
- `unsupported`: reject before upstream submission;
- `unknown`: use the standard reference format for the explicitly selected route and make one request; return the upstream rejection without fallback.

Excess references are rejected rather than sliced. Legacy Agnes and Pollinations retain their existing reference policy until migrated separately.

Semantic roles and names remain in the canonical request. An adapter may add role guidance to prompt text but does not mutate the immutable Stage 2 snapshot.

## 13. Durable generation recovery

### 13.1 Client recovery record

Before calling `/generate`, Stage 2 creates or updates a client pending record containing:

```js
{
  kind: 'serverRequest',
  requestId: 'client-uuid',
  connectionId: 'connection-id',
  chatId: '...',
  sourceMsgId: 12,
  stage2Snapshot: {},
  status: 'submitted',
  createdAt: '...'
}
```

This occurs after persisting the immutable Stage 2 snapshot but before the HTTP call. It closes the current gap where `savePendingImage()` is called only after provider success.

On a ready result, the record is updated to `dataUrl` and existing `processPending()` finalizes the gallery entry. On reload, startup recovery queries `/requests/{requestId}` for every unresolved `serverRequest` record.

If the server returns `REQUEST_NOT_FOUND`, the client distinguishes it from server unavailability:

- unavailable/incompatible server: keep the pending record and retry status lookup later;
- confirmed `REQUEST_NOT_FOUND`: the request never reached durable server claim. The client does not submit automatically on startup. It marks the item `notSubmitted` and offers **Resume generation**; explicit user action resends the immutable snapshot with the same request ID;
- if that resend creates the journal entry, normal single-flight rules apply;
- the pending record is removed only when the user discards it or gallery finalization succeeds.

This avoids both a permanently stuck record and an invisible paid resubmission.

### 13.2 Server journal states

Each journal entry contains a request fingerprint and one of:

```text
claimed
not-dispatched
dispatching
upstream-accepted
result-received
ready
failed
failed-ambiguous
```

Semantics:

- `claimed`: the request ID and fingerprint are durably reserved under single-flight lock;
- `not-dispatched`: the server has proven no upstream request bytes were written and the same request may be explicitly resumed;
- `dispatching`: the server is about to write or may already have written upstream request bytes; automatic resubmission is forbidden;
- `upstream-accepted`: response headers or a documented provider request ID prove acceptance;
- `result-received`: provider URL or bytes have been persisted;
- `ready`: validated artifact exists;
- `failed`: provider clearly rejected before generation or returned a definitive failure;
- `failed-ambiguous`: dispatch may have occurred and completion is unknown.

The journal does not store API keys, raw auth headers, reference bytes, or full prompts. It stores a keyed request fingerprint, route identifiers, timestamps, safe status, provider request ID where available, and artifact path.

Artifacts are written before the journal transitions to `ready`. On startup, any orphaned `claimed` entry becomes `not-dispatched`; any orphaned `dispatching` entry becomes `failed-ambiguous` unless a durable provider result is already present.

### 13.3 Retention

Initial limits:

- journal: at most 200 entries per user;
- successful artifacts: 7 days unless already copied into the existing gallery path;
- failed entries: 7 days;
- cleanup runs at plugin startup and after bounded write intervals;
- an unresolved client pending record prevents early removal of its matching server entry when practical.

The journal is a recovery mechanism, not a permanent second gallery.

## 14. Generation safety

### 14.1 No paid fallback or retry

After route resolution the server submits through exactly one adapter. It does not automatically retry a paid generation after:

- timeout;
- connection reset after request submission;
- HTTP 429;
- HTTP 5xx;
- malformed success response.

The provider may already have completed the request.

Downloading a returned result URL is a separate non-generating operation and may use bounded retry with backoff. The provider URL is persisted in the journal before download begins.

### 14.2 Timeout and cancellation

Default generation timeout is 300 seconds per connection. Client abort is propagated where feasible. Abort means the caller stopped waiting; it does not imply the provider cancelled the paid operation. Journal state remains recoverable.

### 14.3 Response safety

The server enforces maximum response/download sizes, allowed image MIME types, magic-byte checks, bounded redirects, and download timeouts. Signed query values are redacted from logs.

## 15. Model catalog cache

The cache uses stale-while-refresh behavior:

- the last successful catalog displays immediately;
- **Refresh** performs a new probe;
- a failed refresh preserves the old catalog;
- stale state is nonblocking;
- generation does not force refresh.

Initial stale thresholds:

```text
OpenRouter image metadata: 6 hours
OpenAI/Gemini-compatible catalogs: 24 hours
```

They affect labeling only and do not trigger background network work.

The browser may hold safe connection projections in memory for rendering. They are not a durable source of truth. Export explicitly asks the server for portable metadata.

## 16. Migration and portability

### 16.1 Stable-ID automatic migration

Migration applies to existing OpenAI and Gemini image connections and preserves their exact IDs:

1. confirm plugin API compatibility;
2. read the old local metadata and localforage key;
3. probe using the old endpoint/key and explicit old family where appropriate;
4. call a server create/migration operation with the same validated ID;
5. server writes secret and metadata atomically;
6. client reads the safe projection back and confirms `hasApiKey: true`;
7. client confirms the same connection ID resolves through the unified facade;
8. only then remove the localforage key and old mirrored secret;
9. record migration completion.

No chat metadata rewriting is required.

If migration cannot classify a manually entered model, the user is asked to choose API mode before commit. Agnes and Pollinations remain untouched.

### 16.2 Client connection facade

`src/connections.js` becomes a temporary unified facade:

- server OpenAI/Gemini/OpenRouter projections come from the plugin;
- legacy Agnes/Pollinations records remain in localforage;
- `listImageConnections()` returns both;
- each record has `executionOwner: 'server' | 'legacy-browser'`;
- server records never expose a key through `resolveConnection()`.

### 16.3 Export and import

Export obtains portable templates from the server:

```js
{
  id: 'stable-id',
  name: 'LinkAPI',
  endpoint: 'https://api.linkapi.ai',
  selectedRoute: {
    modelId: 'gemini-3.1-flash-image',
    apiFamily: 'gemini-native',
    source: 'gemini-models', // or manual
    capabilities: {
      generate: 'supported',
      references: 'unknown',
      maxReferences: null
    }
  },
  apiFamilyOverride: 'auto',
  timeoutMs: 300000
}
```

It excludes secret IDs, API keys, remote catalog payloads, journal entries, and artifacts. Manual-route capability fields are exported because they are part of the user's portable configuration; remotely discovered capabilities are treated only as hints and must be refreshed after import.

Import collision policy:

- if the ID is unused, preserve it and create a keyless unsaved-to-provider connection template;
- if the same ID already exists with identical portable metadata, reuse the existing connection without modifying or deleting its current secret, and report `reusedExisting: true`;
- otherwise generate a new ID and return a deterministic old-to-new remap for imported chat bindings handled by the existing import flow.

A newly created imported connection has `hasApiKey: false` and cannot generate until a new key is saved. A reused existing connection retains its pre-existing key. After key entry, remote routes are re-probed; a manual route remains selectable exactly as exported.

## 17. Error model

Structured response:

```js
{
  error: {
    code: 'AUTH_FAILED',
    message: 'Safe summary',
    retryable: false,
    diagnosticsId: 'trace-id'
  }
}
```

Required codes:

```text
SERVER_COMPONENT_UNAVAILABLE
INVALID_ENDPOINT
DESTINATION_BLOCKED
AUTH_FAILED
CATALOG_UNAVAILABLE
CATALOG_UNSUPPORTED
CATALOG_MALFORMED
NO_IMAGE_MODELS
MODEL_ROUTE_MISSING
MODEL_NOT_FOUND
REQUEST_NOT_FOUND
REFERENCES_UNSUPPORTED
TOO_MANY_REFERENCES
INVALID_REFERENCE
REQUEST_ID_CONFLICT
UPSTREAM_TIMEOUT
UPSTREAM_HTTP_ERROR
UPSTREAM_RESPONSE_INVALID
UPSTREAM_RESULT_UNKNOWN
RESULT_DOWNLOAD_FAILED
REQUEST_ABORTED
```

The UI maps these to concise messages. Raw bounded upstream details remain in redacted diagnostics and are not shown by default.

## 18. Safe outbound HTTP policy

Because users configure endpoints, all probes and generation calls use one server-owned HTTP client.

Rules:

- cloud connections allow `https:` only;
- URL username/password and fragments are rejected;
- arbitrary query strings are rejected at connection storage; adapters add only documented query parameters;
- default allowed ports are 443 and an explicitly supplied HTTPS port;
- DNS resolution must reject loopback, link-local, private, multicast, unspecified, IPv4-mapped private IPv6, and cloud metadata destinations;
- each redirect is disabled by default; adapters may allow a bounded redirect only through revalidation;
- authorization is stripped on any cross-origin redirect;
- result-download redirects are independently revalidated;
- upstream URLs are derived only from stored endpoint plus adapter-owned paths;
- `/generate` never accepts an arbitrary upstream URL;
- request and response byte limits are enforced;
- API keys, auth headers, query keys, signed URL queries, prompts, and reference data are not logged by default;
- all storage and journal access is scoped by `req.user.directories.root`.

Local providers are outside this cloud policy and cannot weaken it.

## 19. Client generation integration

`generateImageRequest()`:

1. resolves the unified connection projection;
2. delegates server-owned connections to the plugin;
3. delegates only legacy Agnes/Pollinations to the current browser registry;
4. returns the existing `{kind, value}` contract.

For server connections it no longer reads a key, probes the SillyTavern CORS proxy, chooses direct/proxy transport, builds provider profiles, or serializes provider wire formats.

Stage 2 changes only enough to create the pre-request recovery record described in section 13. Existing prompt-driven reference resolution, FIFO behavior, chat config snapshots, and gallery metadata remain unchanged.

## 20. Delivery phases

Each phase is separately testable. The final MVP includes all phases, but implementation does not require a big-bang replacement.

### Phase 1: server foundation and durable journal

- plugin status;
- per-user metadata directory and mutex;
- SecretManager integration;
- safe outbound HTTP client;
- connection CRUD;
- request journal and `/requests/{id}`;
- client handshake and disabled state.

### Phase 2: explicit OpenAI Images

- model listing;
- generation and edits;
- references;
- exact GPT Image parameter mapping;
- response normalization;
- client pre-request recovery record.

This phase is the first releasable server-backed path.

### Phase 3: explicit Gemini Native

- `v1`/`v1beta` discovery;
- native generation;
- inline references;
- LinkAPI-compatible query-key auth fallback.

### Phase 4: merged discovery

- run adapters concurrently;
- merge route catalogs;
- persist route IDs;
- partial-failure warnings;
- manual route with explicit API mode;
- automatic mode as default.

### Phase 5: OpenRouter Images

- dedicated `/api/v1/images` contract;
- dedicated catalog and endpoint capabilities;
- references;
- buffered output.

### Phase 6: stable-ID migration

- transactional key migration for old OpenAI/Gemini records;
- Agnes/Pollinations remain legacy;
- remove browser key only after server read-back.

### Phase 7: retire obsolete browser paths

After migration verification:

- remove OpenAI/Gemini browser execution from active dispatch;
- remove their CORS proxy probing and browser multipart;
- remove Gemini model loading through generic OpenAI assumptions;
- retain only compatibility code still needed by migration tests.

## 21. Testing strategy

### 21.1 Connection and persistence

Verify:

- transient probe writes no metadata or secret;
- create commits metadata and secret together;
- failed metadata write removes a newly written secret;
- failed key rotation preserves the old secret;
- caller-supplied stable IDs and collisions;
- per-user isolation;
- atomic writes and serialized concurrent updates;
- missing/incompatible plugin disables the form.

### 21.2 Adapter contracts

For each applicable adapter:

- catalog success, unauthorized, malformed, and unavailable;
- generation without references;
- generation with one and four references;
- unsupported and excessive references rejected before upstream;
- base64, URL, and raw-binary results where applicable;
- exact error mapping;
- timeout and abort;
- secret and reference redaction.

### 21.3 OpenAI Images

Verify exact bare-origin, `/v1`, and custom-subpath URLs; generations and edits paths; repeated `image` fields; GPT Image sizes/quality; omission of unsupported fields; response variants; and absence of Chat fallback.

### 21.4 Gemini Native

Verify bare origin, `/v1`, `/v1beta`, trailing slash, and custom subpath; no duplicated version segments; pagination; header and LinkAPI query-key auth; multiple inline references; response modalities; camelCase/snake_case parts; and safety/no-image diagnostics.

### 21.5 OpenRouter Images

Verify exact `/api/v1/images/models`, per-model endpoint discovery, `/api/v1/images`, supported-parameter filtering, input references, buffered base64 response, and absence of Chat fallback.

### 21.6 Probe coordinator

Verify:

- several families may succeed for one endpoint;
- one failure does not hide another catalog;
- LinkAPI-style GPT and Gemini routes merge;
- duplicate model IDs produce distinct route IDs;
- an override runs only one family;
- no paid endpoint is probed;
- refresh failure preserves stale catalog;
- manual model requires explicit API mode.

### 21.7 Durable recovery

Verify:

- client stores `requestId` before `/generate`;
- journal claim exists before upstream dispatch state;
- same ID/fingerprint never submits twice, including concurrent calls;
- different fingerprint returns conflict;
- provider URL is journaled before download;
- server receives result, response socket breaks, browser reloads, result is recovered, upstream call count remains one;
- ambiguous disconnect remains `failed-ambiguous` and is not resubmitted;
- artifact is written before `ready`;
- TTL cleanup does not delete active recoverable entries prematurely.

### 21.8 Security

Verify blocked private/metadata destinations, IPv4-mapped IPv6, URL credentials/fragments/query, redirect revalidation, cross-origin auth stripping, oversized bodies, MIME spoofing, header injection, and absence of secrets/prompts/reference bytes in ordinary logs and exports.

### 21.9 Migration and pipeline regression

Verify stable-ID OpenAI/Gemini migration, key retention on every failed step, key deletion only after read-back, untouched Agnes/Pollinations, import collision remapping, and all existing Stage 1, queue, draft, pending, gallery, regeneration, and chat-binding invariants.

## 22. Acceptance criteria

The MVP is complete when:

1. A user creates a server-backed connection using only name, endpoint, and key.
2. Probe does not persist anything until the user saves.
3. **Connect and load models** returns a merged list for a LinkAPI-style endpoint.
4. GPT Image and Gemini Image from one connection retain distinct correct routes.
5. GPT Image generates and edits with references through OpenAI Images.
6. Gemini Image generates and accepts supported references through native inline parts.
7. OpenRouter uses its dedicated image catalog and `/api/v1/images` endpoint.
8. Invalid key and endpoint errors are understandable without diagnostics.
9. Refresh failure leaves a stale catalog usable.
10. One `requestId` causes at most one paid upstream submission.
11. A provider result survives interruption between server and browser.
12. Migrated keys are removed from browser storage only after confirmed server persistence.
13. No key or reference bytes appear in ordinary logs.
14. Missing server plugin prevents saving unusable server connections.
15. Existing Stage 1, queue, drafts, gallery, and regeneration remain intact.
16. Existing connection IDs and chat bindings survive migration.
17. Agnes and Pollinations continue to work as before.

## 23. Deferred follow-up work

Separate proposals may later cover:

- moving authenticated Pollinations and Agnes to the server;
- reducing duplicated reference data URLs in snapshots;
- permanent server artifacts instead of data URL responses;
- additional API families;
- async provider jobs;
- documented proxy presets;
- broader model-specific controls.

None is required for this three-adapter MVP.
