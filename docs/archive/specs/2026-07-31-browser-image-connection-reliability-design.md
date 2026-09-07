# Browser Image Connection Reliability Design

## Approved scope

Improve browser-owned image connections without changing execution ownership: a browser holds the API key only in localforage, discovers models through a safe GET fallback, dispatches one paid POST only, and stores only metadata plus native SillyTavern image paths.

## Goals and invariants

1. **Secret boundary.** A connection API key exists only in the password control while being edited and in localforage under `uris_api_key:<connectionId>`. It must not be put in `imageConnections`, `catalog`, route metadata, DOM attributes/datasets, chat configuration, gallery cards, exports, logs, or pending-request snapshots. Existing `stripSecrets` / metadata sanitizers remain the defense in depth.
2. **Blank input means retain.** An existing connection always renders an empty password input. When localforage confirms a key is present, render adjacent text such as `Ключ сохранён в браузере`; never reveal, prefill, or serialize the key. A new connection still requires a nonblank key.
3. **Model refresh fallback.** Catalog discovery is a safe GET. It tries direct browser fetch first and, only after a CORS/network failure (not a response, user abort, or timeout), uses the SillyTavern proxy. The same ephemeral key is sent only in request headers. The fallback must not persist the key, mutate route transport policy, or be used by paid generation.
4. **Atomic-looking save.** The UI save path treats metadata and local key update as one user operation. Capture the previous metadata and key state before changing either. If key storage fails after metadata write, restore the previous metadata (or delete a newly created connection), restore the old key where possible, surface the original error, retain the draft, and do not call `onSaved`.
5. **Canonical native paths.** A single canonicalizer accepts only one file beneath `user/images/UR%20Image%20Studio/`. It accepts native responses and gallery values with literal-space folder names, an optional leading slash, or percent encoding, and returns `user/images/UR%20Image%20Studio/<encodeURIComponent(filename)>`. It rejects empty names, directory separators (including encoded separators), dot segments, control characters, malformed encoding, query/fragment text, and any different folder. Gallery indexing, list results, and upload results use this canonicalizer.
6. **Per-connection timeout.** The connection form exposes timeout in seconds, default **120**, integer range **15–600**. Persist it as `timeoutMs` in browser-owned connection metadata (`seconds * 1000`) and normalize missing legacy values to `120000`. Discovery, all adapter POSTs, result downloads, and native ST uploads use this resolved value. User cancellation remains cancellation; timeout produces the existing timeout error.
7. **Never resend paid work.** Any generation POST gets exactly one delivery attempt. Direct-to-proxy fallback remains allowed only for catalog GETs. A timeout, CORS/network failure, or ambiguous result download/upload must leave the pending local record for review and must not retry/resume/replay the provider POST.

## Architecture

### Connection configuration and secrets

`src/ui/server-connection-form.js` owns display and collection of the connection form. It receives a non-secret `hasApiKey` projection obtained by `src/connections.js`/`src/connection-store.js`; it renders a blank password field and a presence label. `collectServerConnectionForm` omits that projection and records a validated integer `timeoutMs`.

`src/connection-store.js` is the localforage boundary. Change key writes/removals from best-effort swallowing to observable failures for the save transaction, add a non-secret `hasConnectionApiKey(id)` helper, and add an explicit rollback-capable save helper or primitives that preserve the old connection/key. The returned and persisted connection remains normalized through `src/image-connection-schema.js`, which owns timeout normalization and secret stripping. `src/connections.js` decorates listed/read connections with `hasApiKey` for rendering only; no persistence API accepts it.

### Catalog refresh

`src/catalog.js` accepts an injected/direct fetch and an optional safe `fetchCatalog` transport. `src/ui/server-connection-form.js` obtains the transient password text; when blank for an existing connection it reads the local key only for this operation. It passes the key to discovery but never copies it to the draft/catalog/connection. Add a catalog GET transport in `src/image-transport.js` (or a focused `catalogFetch` export) that may fall back to `proxiedFetch` only after a direct CORS/network `TypeError`; preserve `timeoutMs` and the abort signal. HTTP responses, timeouts, and explicit aborts are returned/thrown without fallback.

### Timeout propagation

`normalizeConnectionRecord` produces `timeoutMs`; `resolveConnection` returns it with the local key. `generateImageRequest` resolves `conn.timeoutMs` once, stores no secret in its pending snapshot, and passes the timeout to `invokeImageProvider` and `materializeImageResult`. The provider registry passes it to adapters; every adapter supplies it to `requestJson`/`requestMultipart`. `image-transport` forwards it to `fetchWithTimeout`; `downloadResult` receives it too. `native-image-storage` uses it for both download and `/api/images/upload` requests, so materialization cannot silently return to 120 seconds.

### Native path canonicalization

Put `canonicalizeNativeImagePath(value)` in `src/native-image-storage.js` (or an adjacent narrowly-scoped path module only if needed to avoid a cycle). Decode each path segment once, require exactly `user/images/UR Image Studio/<filename>`, reject unsafe decoded input, and encode the accepted filename once. `uploadPayload` canonicalizes the server-returned `payload.path`; `listNativeImages` builds canonical paths; `gallery-index.js` calls the same canonicalizer rather than relying on its permissive regex; `storage.js` recognizes canonicalizable native paths before materialization.

## Non-goals

- No server-owned generation, server secret manager, server plugin changes, or migration of existing secrets.
- No automatic retry, resume, reconciliation, or proxy fallback for provider POSTs.
- No secret export/import support and no API-key disclosure UI.
- No broad gallery data migration; malformed historical paths are rejected/marked unavailable through normal reconciliation.

## Relevant implementation and test files

| Area | Production files | Tests |
| --- | --- | --- |
| Form, key presence, refresh, transactional save | `src/ui/server-connection-form.js`, `src/ui/tab-api.js`, `src/connections.js`, `src/connection-store.js` | `tests/tab-api-server-connections.test.js`, `tests/connection-store.test.js` |
| Metadata normalization and secret boundary | `src/image-connection-schema.js`, `src/core.js` | `tests/image-connection-schema.test.js`, `tests/connection-store.test.js`, `tests/browser-runtime-boundaries.test.js` |
| GET fallback and no-resubmit transport | `src/catalog.js`, `src/image-transport.js`, `src/proxy.js` | `tests/catalog.test.js`, `tests/image-transport.test.js` |
| Timeout propagation and paid POST invariant | `src/image-api.js`, `src/image-provider-registry.js`, `src/providers/image-base.js`, `src/providers/image-openai.js`, `src/providers/image-gemini.js`, `src/providers/image-openrouter.js`, `src/providers/image-chat-completions.js` | `tests/image-api-server.test.js`, `tests/image-provider-adapters.test.js`, `tests/image-transport.test.js`, `tests/retry-policy.test.js` |
| Canonical native gallery paths | `src/native-image-storage.js`, `src/gallery-index.js`, `src/storage.js` | `tests/native-image-storage.test.js`, `tests/gallery-index.test.js` |

## Acceptance checks

- Existing saved-key connection renders a blank password field plus a presence label; rendered HTML, shared settings, catalog, gallery cards, pending requests, chat config, and exports contain no test key.
- Refresh with direct CORS failure makes one direct GET and one proxy GET; a direct HTTP error, abort, or timeout makes one direct GET only. The key appears only in the request headers.
- A key-storage failure restores the exact prior metadata/key state (or removes a newly created record), reports an error, and does not signal successful save.
- Each accepted equivalent path canonicalizes to `user/images/UR%20Image%20Studio/<encoded filename>`; traversal, alternate folders, encoded slash/backslash, malformed percent encoding, and query/fragment inputs throw before indexing.
- `15`, `120`, and `600` seconds persist as `15000`, `120000`, and `600000`; invalid form/schema values are rejected or normalize to the legacy default only when absent. The selected timeout reaches discovery, all provider transport calls, result download, and ST upload.
- A generation POST encountering CORS/network failure or timeout makes one provider POST and no proxy/replay request.
