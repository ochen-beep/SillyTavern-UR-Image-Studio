# Server Image Connections — Adapters and Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать три точных image API adapters, merged read-only discovery, durable model catalog, request journal, artifact persistence и idempotent `/generate`.

**Architecture:** Adapters владеют только wire contracts. Probe coordinator объединяет catalog routes. Generation service выбирает один persisted route, claims one request ID, durably marks dispatch, executes one adapter, persists provider result, then returns a normalized data URL.

**Tech Stack:** Node.js >=20 ESM, `node:test`, server foundation from plan 1, JSON/multipart provider APIs.

**Depends on:** `2026-07-27-server-image-connections-1-foundation.md`

---

## Files created by this plan

```text
server-plugin/src/
├── adapters/
│   ├── index.js
│   ├── common.js
│   ├── coordinator.js
│   ├── openai-images.js
│   ├── gemini-native.js
│   └── openrouter-images.js
├── storage/catalog-store.js
├── storage/journal-key-store.js
├── journal/states.js
├── journal/journal.js
├── journal/reconciliation.js
├── journal/retention.js
├── storage/artifact-store.js
├── services/probe.js
├── services/generation.js
└── services/request-status.js

tests/
├── server-openai-images.test.js
├── server-gemini-native.test.js
├── server-openrouter-images.test.js
├── server-probe-coordinator.test.js
├── server-catalog-store.test.js
├── server-journal.test.js
├── server-artifacts.test.js
├── server-generation.test.js
├── server-request-routes.test.js
└── server-plugin/
    ├── fake-safe-fetch.js
    ├── fixtures-openai.js
    ├── fixtures-gemini.js
    └── fixtures-openrouter.js
```

---

### Task 1: Implement OpenAI Images probe and exact endpoint builders

**Files:**
- Create: `server-plugin/src/adapters/common.js`
- Create: `server-plugin/src/adapters/openai-images.js`
- Create: `tests/server-openai-images.test.js`
- Create: `tests/server-plugin/fake-safe-fetch.js`
- Create: `tests/server-plugin/fixtures-openai.js`

- [ ] **Step 1: Write failing endpoint tests**

Expected builders:

```js
buildOpenAIBase('https://api.example.com')
// https://api.example.com/v1

buildOpenAIBase('https://api.example.com/v1')
// unchanged

buildOpenAIBase('https://api.example.com/custom/v1')
// unchanged
```

Models URL is `${base}/models`; generation `${base}/images/generations`; edits `${base}/images/edits`.

- [ ] **Step 2: Write failing probe tests**

Assert GET models with Bearer auth, no generation/edit calls, structured statuses for 401/unavailable/malformed, and routes shaped as:

```js
{
    id,
    modelId,
    label,
    apiFamily: 'openai-images',
    source: 'openai-models',
    confidence,
    capabilities,
    fetchedAt,
}
```

OpenAI `/models` without modality metadata may use conservative image-ID hints but must preserve manual entry and not claim references solely from an arbitrary model name.

- [ ] **Step 3: Run RED**

```bash
node --test tests/server-openai-images.test.js
```

- [ ] **Step 4: Implement probe-only adapter API**

```js
export const openAIImagesAdapter = {
    apiFamily: 'openai-images',
    async probe(context) {},
    async generate(context, route, request) {}, // throws NOT_IMPLEMENTED for now
};
```

Route IDs use stable hash of `apiFamily + source + modelId`, never array index.

- [ ] **Step 5: Run GREEN probe tests**

```bash
node --test tests/server-openai-images.test.js
```

- [ ] **Step 6: Commit**

```bash
git add server-plugin/src/adapters/common.js server-plugin/src/adapters/openai-images.js tests/server-openai-images.test.js tests/server-plugin/fake-safe-fetch.js tests/server-plugin/fixtures-openai.js
git commit -m "feat(server): probe OpenAI Images catalogs"
```

---

### Task 2: Implement OpenAI generation and edits

**Files:**
- Modify: `server-plugin/src/adapters/openai-images.js`
- Modify: `tests/server-openai-images.test.js`

- [ ] **Step 1: Add failing generation request tests**

Without refs assert JSON to `/images/generations`:

```js
{
    model,
    prompt,
    n: 1,
    size,
    quality,
    output_format: 'png',
}
```

Do not send `response_format` for GPT Image.

- [ ] **Step 2: Add failing edit tests**

With refs assert multipart `/images/edits` with repeated canonical `image` fields, `model`, `prompt`, `n`, valid size/quality, and no universal `input_fidelity`. Add model fixture where documented `input_fidelity` is allowed and one where it must be omitted.

- [ ] **Step 3: Add failing response tests**

Parse:

```text
data[0].b64_json
data[0].url
raw image bytes
top-level url as compatibility warning
```

Reject malformed success. Assert adapter calls safe request once and never Chat Completions.

- [ ] **Step 4: Run RED**

```bash
node --test tests/server-openai-images.test.js
```

- [ ] **Step 5: Implement minimal generate/edit serialization and parsing**

Return internal adapter result:

```js
{ kind: 'bytes' | 'base64' | 'url', value, mimeType, warnings: [] }
```

Adapter does not download URLs and does not write artifacts.

- [ ] **Step 6: Run GREEN and commit**

```bash
node --test tests/server-openai-images.test.js
git add server-plugin/src/adapters/openai-images.js tests/server-openai-images.test.js
git commit -m "feat(server): generate and edit through OpenAI Images"
```

---

### Task 3: Implement Gemini Native probe and auth negotiation

**Files:**
- Create: `server-plugin/src/adapters/gemini-native.js`
- Create: `tests/server-gemini-native.test.js`
- Create: `tests/server-plugin/fixtures-gemini.js`

- [ ] **Step 1: Write failing versioned URL tests**

Test bare origin probes `/v1/models` and `/v1beta/models`; supplied `/v1` or `/v1beta` is tried first and never duplicated; custom gateway subpath remains.

- [ ] **Step 2: Write failing auth tests**

Primary request uses `x-goog-api-key`. Query `?key=` is attempted only for the documented relay-compatible preset/host after header auth rejection. No generic Bearer header is guessed.

- [ ] **Step 3: Write failing catalog/pagination tests**

Parse `models[]`, strip only leading `models/` from model IDs for route display, preserve versioned base in route metadata, follow bounded `nextPageToken`, and return partial warning on later-page failure without losing previous pages.

- [ ] **Step 4: Run RED**

```bash
node --test tests/server-gemini-native.test.js
```

- [ ] **Step 5: Implement probe-only Gemini adapter**

Store concrete route metadata needed for generation:

```js
{
    geminiApiVersion: 'v1' | 'v1beta',
    authStrategy: 'x-goog-api-key' | 'query-key',
}
```

- [ ] **Step 6: Run GREEN and commit**

```bash
node --test tests/server-gemini-native.test.js
git add server-plugin/src/adapters/gemini-native.js tests/server-gemini-native.test.js tests/server-plugin/fixtures-gemini.js
git commit -m "feat(server): probe Gemini Native image models"
```

---

### Task 4: Implement Gemini generation and references

**Files:**
- Modify: `server-plugin/src/adapters/gemini-native.js`
- Modify: `tests/server-gemini-native.test.js`

- [ ] **Step 1: Write failing request tests**

Exact URL:

```text
{versionedBase}/models/{encodedModel}:generateContent
```

Body contains ordered inline image parts followed by text, `responseModalities: ['TEXT','IMAGE']`, and valid `imageConfig` fields. Preserve MIME and strip data URL prefix only.

- [ ] **Step 2: Write failing response tests**

Parse both:

```text
inlineData.mimeType/data
inline_data.mime_type/data
```

When no image exists, include redacted `finishReason` and `promptFeedback` in diagnostics without logging full text/reference payloads.

- [ ] **Step 3: Write failing one-request test for unknown references**

Unknown capability with explicit Gemini route sends one standard request. Upstream rejection is returned; no OpenAI/OpenRouter fallback.

- [ ] **Step 4: Run RED, implement, run GREEN**

```bash
node --test tests/server-gemini-native.test.js
```

- [ ] **Step 5: Commit**

```bash
git add server-plugin/src/adapters/gemini-native.js tests/server-gemini-native.test.js
git commit -m "feat(server): generate images through Gemini Native"
```

---

### Task 5: Implement OpenRouter dedicated image catalog

**Files:**
- Create: `server-plugin/src/adapters/openrouter-images.js`
- Create: `tests/server-openrouter-images.test.js`
- Create: `tests/server-plugin/fixtures-openrouter.js`

- [ ] **Step 1: Write failing exact URL tests**

Only official origin is supported in MVP:

```text
GET https://openrouter.ai/api/v1/images/models
GET https://openrouter.ai/api/v1/images/models/{author}/{slug}/endpoints
```

A custom endpoint selected as OpenRouter must normalize to its documented compatible `/api/v1` root or fail clearly; do not guess OpenAI `/v1/images`.

- [ ] **Step 2: Write failing capability tests**

Map enum/range/boolean descriptors conservatively. Per-endpoint metadata is authoritative; model-level metadata is coarse. Preserve multiple provider endpoints where they change capabilities, but route selection shown to client may use one default route plus internal endpoint metadata.

- [ ] **Step 3: Assert no Chat endpoint**

Fake fetch log must contain neither `/chat/completions` nor `/responses`.

- [ ] **Step 4: Run RED, implement probe, run GREEN**

```bash
node --test tests/server-openrouter-images.test.js
```

- [ ] **Step 5: Commit**

```bash
git add server-plugin/src/adapters/openrouter-images.js tests/server-openrouter-images.test.js tests/server-plugin/fixtures-openrouter.js
git commit -m "feat(server): discover OpenRouter image capabilities"
```

---

### Task 6: Implement OpenRouter generation

**Files:**
- Modify: `server-plugin/src/adapters/openrouter-images.js`
- Modify: `tests/server-openrouter-images.test.js`

- [ ] **Step 1: Write failing request tests**

POST exact `/api/v1/images`. Include only capability-advertised fields from:

```js
{
    model,
    prompt,
    n: 1,
    resolution,
    aspect_ratio,
    quality,
    input_references,
}
```

References are `image_url` data URLs. Streaming is false/omitted.

- [ ] **Step 2: Write failing response tests**

Parse buffered:

```js
{ data: [{ b64_json, media_type }] }
```

Reject missing `b64_json`. Assert no Chat fallback.

- [ ] **Step 3: Run RED, implement, run GREEN**

```bash
node --test tests/server-openrouter-images.test.js
```

- [ ] **Step 4: Commit**

```bash
git add server-plugin/src/adapters/openrouter-images.js tests/server-openrouter-images.test.js
git commit -m "feat(server): generate through OpenRouter Images"
```

---

### Task 7: Add catalog store and merged probe coordinator

**Files:**
- Create: `server-plugin/src/storage/catalog-store.js`
- Create: `server-plugin/src/adapters/index.js`
- Create: `server-plugin/src/adapters/coordinator.js`
- Create: `server-plugin/src/services/probe.js`
- Create: `tests/server-catalog-store.test.js`
- Create: `tests/server-probe-coordinator.test.js`

- [ ] **Step 1: Write failing catalog tests**

Test distinct route IDs by family/source/model, sanitized bounded remote metadata, stale label thresholds, successful replacement, and failed refresh preserving old catalog.

- [ ] **Step 2: Write failing coordinator tests**

Use fake adapters. Assert `Promise.allSettled` behavior, override invokes exactly one family, auto merges several, duplicate model IDs remain distinct, one failure becomes warning, all failures produce catalog error, and no `generate()` method is called.

- [ ] **Step 3: Write failing manual route tests**

Manual route requires explicit non-auto family and receives `source:'manual'`, `confidence:'manual'`, `references:'unknown'`.

- [ ] **Step 4: Run RED**

```bash
node --test tests/server-catalog-store.test.js tests/server-probe-coordinator.test.js
```

- [ ] **Step 5: Implement stores/coordinator/service**

Transient probe returns catalog only. Existing refresh writes only after at least one successful adapter result; otherwise stale catalog is retained.

- [ ] **Step 6: Run GREEN and commit**

```bash
node --test tests/server-catalog-store.test.js tests/server-probe-coordinator.test.js
git add server-plugin/src/storage/catalog-store.js server-plugin/src/adapters/index.js server-plugin/src/adapters/coordinator.js server-plugin/src/services/probe.js tests/server-catalog-store.test.js tests/server-probe-coordinator.test.js
git commit -m "feat(server): merge image model probes across API families"
```

---

### Task 8: Expose transient and stored probe routes

**Files:**
- Modify: `server-plugin/src/router.js`
- Modify: `server-plugin/src/services/connections.js`
- Modify: `tests/server-router.test.js`
- Modify: `tests/server-connections.test.js`

- [ ] **Step 1: Write failing route tests**

Register:

```text
POST /v1/connections/probe
POST /v1/connections/:connectionId/probe
```

Transient request includes endpoint/key/override, writes no metadata/secret/catalog, and returns `{ probeId, expiresAt, routes, warnings }`. `probeId` is a random opaque receipt stored only in a bounded in-memory per-user cache for 10 minutes; the cache stores a hash of normalized endpoint, chosen route DTO, and API-key digest, never the key. A process restart invalidates receipts and requires another read-only probe. Existing refresh uses stored key and preserves stale catalog on total failure.

- [ ] **Step 2: Write failing create validation test**

Connection create/update accepts `{ ..., apiKey, modelRoute, probeId }` only when the unexpired receipt matches the same normalized endpoint, API-key digest, and exact sanitized route; consume the receipt after a successful write. A structurally valid manual route with explicit non-auto family does not require a receipt. Reject expired/replayed/mismatched receipts and arbitrary route IDs. Register and test the exact CRUD routes and envelopes deferred by foundation:

```text
POST   /v1/connections
PUT    /v1/connections/:connectionId
DELETE /v1/connections/:connectionId
```

- [ ] **Step 3: Run RED, implement, run GREEN**

```bash
node --test tests/server-router.test.js tests/server-connections.test.js tests/server-probe-coordinator.test.js
```

- [ ] **Step 4: Commit**

```bash
git add server-plugin/src/router.js server-plugin/src/services/connections.js tests/server-router.test.js tests/server-connections.test.js
git commit -m "feat(server): expose connection probe, validated CRUD, and refresh APIs"
```

---

### Task 9: Implement request fingerprint and journal state machine

**Files:**
- Create: `server-plugin/src/journal/states.js`
- Create: `server-plugin/src/journal/journal.js`
- Create: `server-plugin/src/journal/reconciliation.js`
- Create: `server-plugin/src/storage/journal-key-store.js`
- Create: `tests/server-journal.test.js`

- [ ] **Step 1: Write failing fingerprint/key-lifecycle tests**

Create `server-plugin/src/storage/journal-key-store.js`. On first use under the per-user mutex, atomically generate 32 random bytes and store them at `<user plugin root>/journal.key` with POSIX mode `0600` (Windows relies on the data-root ACL). Subsequent service instances read the same key. The key is excluded from safe projections, connection export/import, logs, and backup payloads; there is no automatic rotation in MVP because rotation would invalidate durable fingerprints.

Fingerprint uses HMAC-SHA-256 with this per-user durable key, includes connection/route/settings and hashes reference bytes, but stored journal JSON contains no prompt text or data URLs. Reconstruct stores/services from disk and prove an identical immutable request produces the same fingerprint after restart; Alice and Bob produce different fingerprints for the same request.

- [ ] **Step 2: Write failing claim/conflict tests**

Same request ID + same fingerprint returns existing/joinable state. Different fingerprint returns `REQUEST_ID_CONFLICT`.

- [ ] **Step 3: Write failing transition tests**

Allowed states:

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

Reject illegal backwards transitions. `ready` requires artifact metadata. Per-request single-flight causes two concurrent callers to share one executor.

- [ ] **Step 4: Write failing startup reconciliation tests**

Orphan `claimed` → `not-dispatched`; orphan `dispatching` → `failed-ambiguous`; durable result may advance to ready.

- [ ] **Step 5: Run RED, implement, run GREEN**

```bash
node --test tests/server-journal.test.js
```

- [ ] **Step 6: Commit**

```bash
git add server-plugin/src/journal server-plugin/src/storage/journal-key-store.js tests/server-journal.test.js
git commit -m "feat(server): add durable generation request journal"
```

---

### Task 10: Add artifact materialization and retention

**Files:**
- Create: `server-plugin/src/storage/artifact-store.js`
- Create: `server-plugin/src/journal/retention.js`
- Create: `tests/server-artifacts.test.js`

- [ ] **Step 1: Write failing materialization tests**

Support adapter `bytes`, `base64`, and `url`. For URL, journal callback durably records the complete provider URL in protected per-user journal storage before download; only logs, diagnostics, and safe API projections redact the query string. Add a restart fixture that stops after URL persistence, reconstructs the service, downloads from the stored URL without adapter re-execution, and reaches `ready`. Validate size, MIME and magic bytes. Use controlled extensions only.

- [ ] **Step 2: Write failing ordering test**

Artifact file must exist before journal `ready` transition. Inject write failure and assert request never becomes ready.

- [ ] **Step 3: Write failing retention tests**

Maximum 200 rows, seven-day TTL, nonterminal rows retained, matching artifacts deleted, cleanup idempotent.

- [ ] **Step 4: Run RED, implement, run GREEN**

```bash
node --test tests/server-artifacts.test.js
```

- [ ] **Step 5: Commit**

```bash
git add server-plugin/src/storage/artifact-store.js server-plugin/src/journal/retention.js tests/server-artifacts.test.js
git commit -m "feat(server): persist and retain generation artifacts"
```

---

### Task 11A: Implement the journaled generation coordinator

This is one fresh-subagent dispatch. It ends after the service commit and must not edit `router.js` or `tests/server-request-routes.test.js`.

**Files:**
- Create: `server-plugin/src/services/generation.js`
- Create: `server-plugin/src/services/request-status.js`
- Create: `tests/server-generation.test.js`

- [ ] **Step 1: Write failing pre-dispatch validation tests**

Resolve connection/route/secret, reject unsupported/excess/invalid refs before `beforeDispatch`, and select exactly one adapter by persisted route family.

- [ ] **Step 2: Write failing paid retry tests**

For timeout, reset, 429, 5xx, malformed success: adapter dispatch count remains 1. URL download may retry separately without adapter re-execution.

- [ ] **Step 3: Write failing journal ordering tests**

Expected order:

```text
claim → validate → dispatching → adapter → result-received → artifact → ready
```

- [ ] **Step 4: Defer HTTP-route tests to Task 11B**

Do not edit `router.js` in Task 11A. Record the exact request-status service contract for Task 11B:

```js
executeGeneration(req, body)
getRequestStatus(req, requestId)
```

Both return safe domain DTOs; HTTP envelopes remain router-owned.

- [ ] **Step 5: Run RED**

```bash
node --test tests/server-generation.test.js
```

- [ ] **Step 6: Implement the services**

Safe request-state envelope never returns filesystem path, fingerprint, prompt, provider URL query, auth, or reference bytes. Data URL is materialized from stored artifact only when returning ready state.

- [ ] **Step 7: Run GREEN**

```bash
node --test tests/server-generation.test.js
```

- [ ] **Step 8: Run the Task 11A service gate**

```bash
node --test --test-concurrency=1 \
  tests/server-journal.test.js \
  tests/server-artifacts.test.js \
  tests/server-generation.test.js
```

Expected: all PASS.

- [ ] **Step 9: Commit service**

```bash
git add server-plugin/src/services/generation.js server-plugin/src/services/request-status.js tests/server-generation.test.js
git commit -m "feat(server): execute journaled image generations"
```

- [ ] **Step 10: Start Task 11B with a fresh subagent and write failing route tests**

Task 11B owns only `server-plugin/src/router.js` and `tests/server-request-routes.test.js`. Register `POST /v1/generate` and `GET /v1/requests/:requestId`. Assert concurrent duplicate POSTs share one paid call, stored `ready` returns the artifact-backed result, a different fingerprint conflicts, socket-response failure after `ready` is recoverable by GET, and ambiguous dispatch never resubmits.

Run RED:

```bash
node --test tests/server-request-routes.test.js
```

- [ ] **Step 11: Implement thin idempotent routes and run GREEN**

Routes call only the Task 11A service contracts and translate domain errors through the shared safe envelope. They do not resolve adapters, secrets, files, or provider URLs directly.

```bash
node --test tests/server-request-routes.test.js tests/server-generation.test.js
```

Expected: all PASS.

- [ ] **Step 12: Run the complete adapter/generation gate**

```bash
node --test --test-concurrency=1 \
  tests/server-openai-images.test.js \
  tests/server-gemini-native.test.js \
  tests/server-openrouter-images.test.js \
  tests/server-catalog-store.test.js \
  tests/server-probe-coordinator.test.js \
  tests/server-journal.test.js \
  tests/server-artifacts.test.js \
  tests/server-generation.test.js \
  tests/server-request-routes.test.js
```

Expected: all PASS.

- [ ] **Step 13: Commit Task 11B routes**

```bash
git add server-plugin/src/router.js tests/server-request-routes.test.js
git commit -m "feat(server): expose idempotent image generation API"
```
