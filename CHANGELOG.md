# Changelog

Notable changes to UR Image Studio. Versions follow `manifest.json` /
`package.json`. The 0.9.x line was never tagged; its detailed history lives
in the git log.

## [Unreleased]

### Planned
- Money-path guards from the 2026-10-30 audit: duplicate resubmit guard,
  secret redaction at log/backup boundaries, storage recovery paths.
  Tracked in docs/2026-10-31-roadmap-implementation-plan.md.

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
