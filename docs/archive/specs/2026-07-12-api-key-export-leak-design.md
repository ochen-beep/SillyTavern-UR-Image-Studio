# API Key Export Leak & Secret Bucket — Design

**Date:** 2026-07-12
**Status:** Design → Implementation
**Scope:** Security hardening (minimal) + UI cut

---

## 1. Problem

User concern: "API keys must not be saved into Connection Profiles in SillyTavern (likely happening via import/export); they must be stored safely per ST's recommendations inside the connection card."

Investigation against the code (verified) and the SillyTavern source on GitHub (`release` branch) corrects the premise and localizes the real issue:

1. **Keys are NOT in connection profiles.** `createConnection` / `saveConnection` (`src/connections.js:111-173`) intentionally omit `apiKey` from the connection object — it stores only an opaque `secretId`. Keys live separately in localforage (`LF_CONN_KEY_PREFIX + connId`, `LF_API_KEY`) and are mirrored into the ST server-side secret store (`secrets.json`) via raw REST.

2. **The real leak is the export function.** `collectUrisKeys()` (`src/data-port.js:26-29`) sweeps **every** localforage key with the `uris_` prefix — including `uris_custom_apikey` and `uris_conn_key_<id>` — and `exportUrisData()` writes those values as **plaintext** into the downloadable JSON backup. The "keys in profiles" perception is actually "keys in the backup file."

3. **Bucket collision with a reserved ST enum.** Per ST source (`public/scripts/secrets.js`), `api_key_custom` is `SECRET_KEYS.CUSTOM` — the bucket for ST's built-in "Custom (OpenAI-compatible)" chat-completion source. Reusing it for URIS image-connection keys violates the namespacing convention; the server accepts arbitrary bucket names with no validation (`src/endpoints/secrets.js` `/write` route).

4. **Latent ReferenceError.** `data-port.js:77-79` references `LF_CONNECTIONS`, but that constant is **not imported** (lines 11-15). Any call into `importUrisData` hits a `ReferenceError` before doing useful work.

**What the ST source confirms (best practice target):**
- Secrets stored via `/api/secrets/write` live in `secrets.json`, which is **excluded** from ST's automated settings backups (`backupUserSettings` copies only `settings.json`). This is the "safe storage per ST recommendations."
- `extensionSettings` / `settings.json` never contains secret values; the Connection Manager stores `secret-id` UUIDs only.
- ST has no public API for extensions to *register* new typed secrets (`SECRET_KEYS` is a closed enum). Writing to a namespaced bucket via REST is the accepted path for an extension needing N dynamic per-connection keys.
- Reading a secret value back via `/api/secrets/find` is gated behind `allowKeysExposure` in `config.yaml` (default off). This is the structural reason a localforage mirror is required for read-back — the current hybrid (localforage primary + secret store mirror) is correct and stays.

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Fix depth | **Minimal** | Source of the leak is the export; storage architecture is already structurally sound. Confirmed via research: localforage mirror is necessary (ST `allowKeysExposure` gate). |
| Secret exclusion from export | Filter in `collectUrisKeys` | Single chokepoint; both `exportUrisData` and the `replace`-mode wipe in `importUrisData` flow through it. Plus a defensive filter on the import input path. |
| Secret bucket | Namespaced `uris_conn_api_keys` | Stops colliding with `SECRET_KEYS.CUSTOM`; server accepts arbitrary keys. |
| Migration | Lazy, on next key write | Old `secretId` values point into `api_key_custom`; deletion is attempted against both old and new bucket names so cleanup works regardless of which store the secret lives in. Orphaned old secrets stay in `secrets.json` (excluded from ST backups; user can clean via ST UI). |
| localforage mirror | Keep as primary read-back | Required by ST's `allowKeysExposure` default; removing it would make key read-back unreliable. |
| UI cut | Remove all 4 export/import entry points | User task: cut `#urisExportHeader`/`#urisImportHeader`; second pair in settings panel calls the same code and is cut too for consistency. Code stays in `data-port.js` for future/programmatic use. |

---

## 3. Changes

### 3.1 `src/data-port.js` — exclude secrets from export/import

- **Import `LF_CONNECTIONS`** from `core.js` (fixes the latent `ReferenceError` at lines 77-79).
- **Add `isSecretLfKey(key)`** helper: returns `true` for `LF_API_KEY` and any key starting with `LF_CONN_KEY_PREFIX`.
- **`collectUrisKeys()`**: filter out secret-bearing keys via `isSecretLfKey`. This is the single chokepoint used by both `exportUrisData` and the `replace`-mode wipe.
- **`importUrisData()`**: add a defensive `isSecretLfKey` skip in the write loop (incoming legacy/hand-forged backups must not write secrets back). The connection-secret re-sync block (97-117) is already safe — with secrets absent, `getConnectionKey` returns `''` and stale `secretId`s are reset.

### 3.2 `src/core.js` — namespaced bucket constant

- Keep `ST_SECRET_KEY_CUSTOM = 'api_key_custom'` (legacy alias for cleanup).
- Add `ST_SECRET_KEY_URIS = 'uris_conn_api_keys'`.

### 3.3 `src/connections.js` — migrate bucket

- `_writeStSecret(value, label)` and `_deleteStSecret(secretId)` accept a `key` parameter (no longer hardcode `ST_SECRET_KEY_CUSTOM`).
- `setConnectionKey` writes to `ST_SECRET_KEY_URIS`. On rotation/delete of an existing `secretId`, attempt delete against **both** `ST_SECRET_KEY_CUSTOM` (old) and `ST_SECRET_KEY_URIS` (new) — best-effort, so secrets created before or after the migration are cleaned.
- `deleteConnection` likewise attempts delete against both bucket names.

### 3.4 `src/ui/window.js` — cut header buttons

- Remove `#urisExportHeader` / `#urisImportHeader` from the header HTML (lines 22-23).
- Remove their event bindings (lines 149-150).
- Remove the now-unused `runExport, runImport` import (line 6).

### 3.5 `index.js` — cut settings-panel buttons

- Remove `#uris_export_data` / `#uris_import_data` from the panel HTML (lines 314-315).
- Remove their event bindings (lines 338-339).
- Remove the now-unused `runExport, runImport` import (line 19).
- Adjust the hint: drop the "use Export" instruction (button is gone); keep the note that ST's folder backup does not cover localforage.

### 3.6 `src/data-port.js` header comment

Add a note that the export/import UI is cut ("на доработку, трай три"), the functions remain for programmatic/future use, and that secrets are now excluded from the export payload.

---

## 4. Testing

New `tests/data-port.test.js`:
- Mock `SillyTavern.libs.localforage` with a key set including `uris_custom_apikey`, `uris_conn_key_<id>`, `uris_connections`, `uris_image_params`.
- `exportUrisData()` result: `keys` does **not** contain `uris_custom_apikey` or any `uris_conn_key_*`; **does** contain `uris_connections`, `uris_image_params`.
- `importUrisData()` with an input that includes secret-bearing keys: those keys are skipped (not written), non-secret keys are written.
- Full suite (`npm test`) stays green.

---

## 5. Non-Goals

- No move of primary key storage to the secret store (blocked by ST's `allowKeysExposure` gate).
- No `apiKey` field added to connection objects.
- No orphaned-secret sweep of the old `api_key_custom` bucket (best-effort cleanup on touch only).
- No replacement export/import UI in this pass (explicitly deferred: "трай три").
