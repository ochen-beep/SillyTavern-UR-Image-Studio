# Changelog

Notable changes to UR Image Studio. Versions follow `manifest.json` /
`package.json`. The 0.9.x line was never tagged; its detailed history lives
in the git log.

## [Unreleased]

### Fixed
- Queue row retry («Повторить») runs the same duplicate-run guard as the
  manual submit: a double click or a retry with the auto-retry copy queued
  can no longer pay twice for one image.
- Stop holds the automation slot: a parked payload no longer drains after
  the Stop button; a new real trigger works as before.
- A second browser tab no longer binds automation or the inline scanner —
  paid pipelines used to run once per tab; the done-fingerprint is re-read
  between the paid stages as well.
- The first automation after page load captures the chat config at trigger
  time, not after the cold pipeline import (no more wrong-chat config).
- Sharded stores: the unload flush counts failed shard sends and suppresses
  the manifest; a manifest naming a missing shard rebuilds from the scan
  instead of bricking the session readonly.
- file-store re-reads a corrupt document and parks its text in a `.corrupt`
  side file before repairing — a transient truncation no longer erases
  templates and presets silently.
- openai-images: a 5xx on the JSON leg stops the dialect chain — no paid
  img2img leg on an ambiguous outcome.
- References: a pool tile whose file vanished (e.g. ST's Data Maid cleanup)
  shows a «Файл потерян» badge; generation fails with a typed error naming
  the exact card.
- Secrets (query-string keys, Bearer headers, userinfo, extraBody key
  fields) are scrubbed at the log-buffer, netdump and backup boundaries.
- Transport failures name the endpoint they hit (method + origin/path, no
  query).

### Added
- Settings → «Ничьи файлы»: orphan sweep over URIS_Refs/URIS_Thumbs with a
  report list and a confirmed batch delete.
- `clean` lifecycle hook: extension removal wipes URIS-owned server data
  after an explicit confirmation. `auto_update` enabled.
- CI: GitHub Actions runs the suite on Node 22/24; this CHANGELOG.
- Ingest thumbnails: pool tiles and the picker decode a 512px webp instead
  of the full edge-1024 image; old records fall back automatically.

### Changed
- Imported references carrying an external image URL lose it (the URL used
  to ride every tile's `<img src>` and the generation-time fetch).
- A manual submit confirms when the same post already has a generation in
  flight outside the queue.
- README capped at 80 lines; honest limitations (Data Maid, auto-retry,
  two-tab merge) moved to USER_GUIDE.md.

## [0.9.8] — 2026-10-30

### Added
- Automation rework: CHARACTER/USER_MESSAGE_RENDERED triggers with a one-slot
  coalescing queue (latest-wins parking) and auto-fingerprint skip on
  unchanged content.
- Stage 1 history depth as a compact 0-100 number field; new base-mode
  scene instruction (art director mode).
- Context menus for pool tiles and generation panel previews; resizable
  folder sidebar.

### Fixed
- Security hardening: crop dialog validates its image source at the sink via
  URL parse; bracket-level sanitize, crypto ids, prototype-pollution guard.
- Refs: importing refreshes the folder sidebar immediately; drag no longer
  triggers native text selection.

### Performance
- Startup: lazy tab modules and handler-only imports.
- Content-visibility on gallery cards and pool tiles; refs grid event
  delegation, search debounce, measured tile dimensions.

### Refactor
- References UI split into mobile stack, folder sidebar, pool picker and a
  shared editor body; CSS split into component sheets; settings panel
  extracted from the entry point.
