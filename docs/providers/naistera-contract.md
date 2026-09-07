# Naistera contract — `naistera`

Status: implemented (image generation). Video generation is intentionally out of scope; video models are filtered from the image catalog and a returned `media_kind: "video"` is rejected before Gallery materialization.

## Official sources

- `https://naistera.org` — landing; documents only "sync response or polling by job ID", models Nano Banana / NovelAI / Grok Pro / Grok Video, rolling-24h quotas.
- `https://naistera.org/prompt` — GET prompt constructor (token + `model`/`ratio`/`preset` query params, image/JSON/redirect result). **Not used by URIS** (see Legacy GET path below).
- Telegram bot — token issuance and the API shape description quoted by users.
- No public OpenAPI spec exists; field names below are the user-supplied contract plus tolerant fallbacks where the provider has not pinned a schema.

## Endpoints

| Purpose | Method | Path | Auth |
|---|---|---|---|
| Generation | POST | `/api/generate` | Bearer token |
| Job polling | GET | `/api/generate/jobs/{job_id}` | Bearer token (same) |
| Model catalog | GET | `/api/models` | Bearer token (token-scoped) |

Base URL: `https://naistera.org` (default). A trailing `/api` on a pasted endpoint is tolerated and stripped.

## Authentication

- Bearer token from the Telegram bot.
- **No prefix validation**: Naistera tokens have no documented shape (`sk_`/`pk_`-style matching would reject valid tokens). Only non-emptiness and absence of whitespace are checked locally.
- Missing token → `NAISTERA_TOKEN_REQUIRED` (`authCode: AUTH_REQUIRED`, `reauthRequired`).
- Upstream HTTP 401 → `AUTH_INVALID`; HTTP 403 → `AUTH_EXPIRED`; both set `reauthRequired`.
- Tokens never appear in netdump (Authorization headers redacted), diagnostics (metadata only), or persisted route data.

## Generation request

```json
{
  "prompt": "...",
  "model": "model-id",
  "aspect_ratio": "16:9",
  "preset": "digital",
  "reference_objects": [
    { "image": "data:image/png;base64,...", "description": "optional reference note" }
  ]
}
```

- `prompt` — built by the existing Stage 1 pipeline (character/persona descriptions are already folded in there; the adapter does not append anything).
- `aspect_ratio` — passed through directly from the connection draft (`1:1`, `16:9`, `9:16`, `3:2`, `2:3` known from the constructor page).
- `preset` — optional; only `digital`/`realism` are sent. Not a card control: supplied via the existing extra-body mechanism when needed.
- `reference_objects` — an array of `{ image: dataUrl, description? }` objects. The current Naistera implementation and the companion SillyImages extension use this shape; `reference_images` is not sent. Only sent to models whose catalog record declares reference support; `assertReferencePolicy()` rejects references for models without support **before** the paid POST, and the shared byte budget (`MAX_REFERENCE_BYTES_PER_IMAGE` / `MAX_REFERENCE_BYTES_TOTAL`) applies.
- No automatic retry, no model fallback, no second POST under any circumstance.

## Response

Synchronous completion (result in the POST response) and asynchronous (job_id) are both handled:

- POST response carrying an image → done, no polling.
- POST response carrying `job_id` → poll `GET /api/generate/jobs/{job_id}` with the same Bearer token at ~2.5 s intervals until:
  - an image is present (authoritative regardless of declared status), or
  - status is terminal-failed → `NAISTERA_JOB_FAILED` with the provider's error detail, or
  - the **connection's overall timeoutMs** elapses → `NAISTERA_JOB_TIMEOUT` (the deadline is global, not per-poll), or
  - the caller aborts → native `AbortError` propagates.
- Image result fields include `data_url` (the observed completed-job field), plus compatibility spellings (`image`, `image_url`, `url`, `result`, `outputs[]`, `images[]`, `data`).
- A job that fails after the user cancelled still completes provider-side; URIS never issues a second POST.

## Catalog

`GET /api/models` is token-scoped: a successful read proves the bearer token, so the probe reports the connection as verified (unlike Pollinations' public catalog, which leaves generation unverified).

- Reference support and media kind are read per-model; models declaring `media_kind: "video"` are filtered out of image routes.
- Video generation (`media_kind: "video"` in a generation response) is rejected — not part of this contract stage.

## Legacy GET path — rejected

The `https://naistera.org/prompt/{PROMPT}?token=...` GET constructor is intentionally not implemented: it puts the credential in the query string (violating the URIS secret policy) and is strictly weaker than the POST + polling contract.

## Known unknowns (verify with a real token before relying)

1. Exact `reference_objects` acceptance semantics for every model (the companion extension sends `{ image, description }` objects; the provider catalog is authoritative for support).
2. Exact job status enum values (`completed`/`failed`/… assumed).
3. Exact per-model reference-capacity field name in `/api/models`.
